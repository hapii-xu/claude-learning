import axios from 'axios'
import { z } from 'zod/v4'
import { getSecret } from 'src/services/localVault/store.js'
import { buildTool, type ToolDef } from 'src/Tool.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { getWebFetchUserAgent } from 'src/utils/http.js'
import { isValidKey } from 'src/utils/localValidate.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { getRuleByContentsForToolName } from 'src/utils/permissions/permissions.js'
import { jsonStringify } from 'src/utils/slowOperations.js'
import {
  REQUEST_TIMEOUT_MS,
  RESPONSE_BODY_CAP_BYTES,
  VAULT_HTTP_FETCH_TOOL_NAME,
} from './constants.js'
import { DESCRIPTION, PROMPT } from './prompt.js'
import {
  buildDerivedSecretForms,
  scrubAllSecretForms,
  scrubAxiosError,
  scrubResponseHeaders,
  truncateToBytes,
} from './scrub.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

// ── Schemas ──────────────────────────────────────────────────────────────────

const inputSchema = lazySchema(() =>
  z.strictObject({
    url: z
      .string()
      .describe('目标 URL。必须是 https://。其他协议会被拒绝。'),
    method: z
      .enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
      .default('GET')
      .describe('HTTP 方法'),
    vault_auth_key: z
      .string()
      .min(1)
      .max(128)
      .describe(
        'vault key 的名称（不是密钥值本身）。需要按 key 单独授权。',
      ),
    auth_scheme: z
      .enum(['bearer', 'basic', 'header_x_api_key', 'custom'])
      .default('bearer')
      .describe(
        "密钥注入方式：bearer = 'Authorization: Bearer X'；" +
          "basic = 'Authorization: Basic base64(X)'；header_x_api_key = 'X-Api-Key: X'；" +
          'custom = 使用 auth_header_name 并填入原始密钥值。',
      ),
    // H5 修复：强制约束 HTTP header 名称的字符集。没有这条正则，
    // 模型给出的值如果包含 CR/LF，就可能通过 axios 的 header[name]=secret 赋值注入额外的 header。
    auth_header_name: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/)
      .optional()
      .describe(
        '当 auth_scheme=custom 时，用作密钥值的 HTTP header 名称。必须匹配 [A-Za-z0-9_-]{1,64}。',
      ),
    body: z
      .string()
      .max(RESPONSE_BODY_CAP_BYTES)
      .optional()
      .describe('请求体'),
    body_content_type: z
      .string()
      .max(128)
      .optional()
      .describe(
        '请求体的 Content-Type。默认为 application/json。',
      ),
    reason: z
      .string()
      .min(1)
      .max(500)
      .describe(
        '说明你为什么需要这次请求。会出现在用户权限提示和审计日志中。',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    status: z.number().optional(),
    statusText: z.string().optional(),
    responseHeaders: z.record(z.string(), z.string()).optional(),
    body: z.string().optional(),
    error: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

// ── Helpers ──────────────────────────────────────────────────────────────────

function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}

/** 对 key 名称做哈希用于审计日志（避免直接记录 key 的原始名称，因为它可能是
 * 'github-personal-prod' 这类半敏感字符串）。 */
function hashKey(key: string): string {
  // 简易 fnv-1a，输出 8 位十六进制。不是加密用途，只是为了在
  // analytics 事件 payload 中混淆 key 名称。
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

// ── Tool ─────────────────────────────────────────────────────────────────────

export const VaultHttpFetchTool = buildTool({
  name: VAULT_HTTP_FETCH_TOOL_NAME,
  searchHint: 'authenticated HTTPS request using a vault-stored secret',
  // 响应大小上限与 axios maxContentLength 一致；超过的体积会由 toolResultStorage
  // 落盘为文件引用。
  maxResultSizeChars: RESPONSE_BODY_CAP_BYTES,
  // Vault 工具不是并发安全的 —— 多个并行 fetch 同时竞争同一份 vault keychain 访问时，
  // 在异常文件系统下可能产生不一致的 passphrase 解锁结果。
  isConcurrencySafe() {
    return false
  },
  // 有副作用（网络），但不修改本地状态。
  isReadOnly() {
    return false
  },
  toAutoClassifierInput(input) {
    const method = input.method ?? 'GET'
    const url = input.url ?? ''
    return `${method} ${url}`
  },
  // 不可绕过：requiresUserInteraction()=true 配合 checkPermissions 返回 'ask'
  //（当没有按 key 的 allow 规则时），即使 mode=bypassPermissions 也会走到用户提示。
  requiresUserInteraction() {
    return true
  },
  userFacingName: () => 'Vault HTTP',
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  async checkPermissions(input, context) {
    // 尽早校验 vault key 名称的格式 —— 给出清晰的错误。
    if (!isValidKey(input.vault_auth_key)) {
      return {
        behavior: 'deny',
        message: `无效的 vault_auth_key '${input.vault_auth_key}'`,
        decisionReason: { type: 'other', reason: 'invalid_key' },
      }
    }
    // 在权限校验阶段就强制 HTTPS，这样被拒绝的协议永远不会进入 call()。
    if (!isHttps(input.url)) {
      return {
        behavior: 'deny',
        message: `仅允许 https:// URL（收到：${input.url}）`,
        decisionReason: { type: 'other', reason: 'non_https_url' },
      }
    }
    // auth_scheme=custom 必须提供 auth_header_name。
    if (input.auth_scheme === 'custom' && !input.auth_header_name) {
      return {
        behavior: 'deny',
        message: 'auth_scheme=custom 需要提供 auth_header_name',
        decisionReason: { type: 'other', reason: 'missing_required_field' },
      }
    }

    const appState = context.getAppState()
    const permissionContext = appState.toolPermissionContext
    // C1 修复：ACL ruleContent 把 vault_auth_key 和目标 host 绑定在一起。
    // 针对 `github-token` 的持久 allow 不能再被用来把该密钥发到其他 origin ——
    // 模型必须为每个新 host 重新申请。格式：`<key>@<host>`。host 从 URL 解析
    // 得到并统一小写化；空 host 的情况不可达（上面的 HTTPS 校验已经接受该 URL）。
    //
    // M2 修复（codecov-100 审计 #5）：`URL` 的 `host` 属性在存在端口时会
    // 带上端口后缀（如 `api.example.com:8080`），并把 IPv6 字面量包在方括号里
    //（如 `[::1]:8080`）。两者在 rule content 中都原样保留。有两点值得记录：
    //
    //   1. 端口属于权限范围的一部分。针对 `mykey@api.example.com:8080` 的
    //      allow 规则并不同时允许 `api.example.com:8443` —— 按 RFC 6454 同源
    //      规则它们是不同的 origin，我们刻意与之保持一致，这样模型就无法从
    //      一个被授权的 admin 端口偷偷切到另一个端口而不重新申请。
    //
    //   2. IPv6 方括号往返。`new URL('https://[::1]:8080/').host` 返回
    //      `[::1]:8080`（带方括号）。src/utils/settings/permissionValidation.ts
    //      中的 `permissionRule` 校验器配置为接受方括号 *内部* 的 `[A-Fa-f0-9:]+`，
    //      并允许其后跟 `:port`，所以规则可以原样往返。如果将来校验正则被收紧，
    //      需要更新此代码路径，在拼装规则前去掉方括号。
    const targetHost = new URL(input.url).host.toLowerCase()
    const ruleContent = `${input.vault_auth_key}@${targetHost}`
    // 同时提供一条通配规则，允许某个 key 访问任意 host —— 仅在用户明确授权时
    // 使用，例如通过提示 UI 的 "any host" 选项（尚未接线）。格式：`<key>@*`。
    const wildcardRuleContent = `${input.vault_auth_key}@*`

    const denyMap = getRuleByContentsForToolName(
      permissionContext,
      VAULT_HTTP_FETCH_TOOL_NAME,
      'deny',
    )
    const denyRule =
      denyMap.get(ruleContent) ?? denyMap.get(wildcardRuleContent)
    if (denyRule) {
      return {
        behavior: 'deny',
        message: `被规则拒绝：VaultHttpFetch(${denyRule.ruleValue.ruleContent ?? ruleContent})`,
        decisionReason: { type: 'rule', rule: denyRule },
      }
    }

    const allowMap = getRuleByContentsForToolName(
      permissionContext,
      VAULT_HTTP_FETCH_TOOL_NAME,
      'allow',
    )
    const allowRule =
      allowMap.get(ruleContent) ?? allowMap.get(wildcardRuleContent)
    if (allowRule) {
      return {
        behavior: 'allow',
        updatedInput: input,
        decisionReason: { type: 'rule', rule: allowRule },
      }
    }

    // 没有匹配规则 -> ask。结合上面的 requiresUserInteraction()=true，
    // bypassPermissions 模式也会走到这里。
    return {
      behavior: 'ask',
      message: `允许 VaultHttpFetch 使用 key '${input.vault_auth_key}' 对 ${input.method ?? 'GET'} ${input.url}（host：${targetHost}）发起请求？原因：${input.reason}`,
      decisionReason: {
        type: 'other',
        reason: 'no_persistent_allow_for_key_host_pair',
      },
    }
  },
  async call(input: Input, _context) {
    // 防御性：运行时再次强制 HTTPS（checkPermissions 同样会强制）。
    if (!isHttps(input.url)) {
      return { data: { error: '仅允许 https:// URL' } }
    }

    // 取回密钥。仅保留在内存中；绝不会赋值给任何输出字段。
    let secret: string | null
    try {
      secret = await getSecret(input.vault_auth_key)
    } catch (e) {
      void e
      // H7 修复：使用 AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      // 模式（沿用 src/bridge/bridgeMain.ts 中的 fork 约定）来证明该字符串字段是安全的。
      // hash 字段本身不是字符串。
      logEvent('vault_http_fetch_lookup_failed', {
        key_hash: hashKey(
          input.vault_auth_key,
        ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      return { data: { error: 'Vault 解锁失败' } }
    }
    if (!secret) {
      return {
        data: {
          error: `未找到 vault key '${input.vault_auth_key}'`,
        },
      }
    }

    // 构造密钥所有可能泄漏的形式，以便 scrub 能全部捕获。
    const forms = buildDerivedSecretForms(secret)

    // 构造请求头。
    const headers: Record<string, string> = {
      'User-Agent': getWebFetchUserAgent(),
    }
    // L3 修复：schema 的 `.default('bearer')` 在字段为 undefined 时已注入 bearer，
    // 所以原先的 `?? 'bearer'` 兜底是死代码。
    // L5 修复：通过在 default 中赋值给 `never` 实现穷尽性 switch。
    const scheme = input.auth_scheme
    switch (scheme) {
      case 'bearer':
        headers['Authorization'] = `Bearer ${secret}`
        break
      case 'basic':
        headers['Authorization'] =
          `Basic ${Buffer.from(secret, 'utf8').toString('base64')}`
        break
      case 'header_x_api_key':
        headers['X-Api-Key'] = secret
        break
      case 'custom':
        // M3 修复：显式守卫而非 `as string`。生产环境由 checkPermissions 保证，
        // 但这条守卫可以在权限管线将来变化时让类型系统保持诚实。
        if (!input.auth_header_name) {
          return {
            data: { error: 'auth_scheme=custom 需要提供 auth_header_name' },
          }
        }
        headers[input.auth_header_name] = secret
        break
      default: {
        // L5 修复：穷尽性守卫 —— 新增 auth_scheme 而不更新此 switch 会变成编译期错误。
        const _exhaustive: never = scheme
        void _exhaustive
        return { data: { error: '未知的 auth_scheme' } }
      }
    }
    if (input.body !== undefined) {
      headers['Content-Type'] = input.body_content_type ?? 'application/json'
    }

    // 审计日志：记录动作 + key 哈希 + 原因。绝不记录密钥值。
    // M1 修复：对 reason_first_80 做 scrub（模型给出的自由文本可能含类密钥串）。
    // H7 修复：使用项目内的 per-field
    // AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS 证明模式，
    // 而不是 `as never` 的整体对象类型转换。
    logEvent('vault_http_fetch', {
      key_hash: hashKey(
        input.vault_auth_key,
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      method:
        scheme as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      url_safe: scrubAllSecretForms(
        input.url,
        forms,
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      reason_first_80: scrubAllSecretForms(
        truncateToBytes(input.reason, 80),
        forms,
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })

    try {
      const resp = await axios.request({
        url: input.url,
        method: input.method,
        headers,
        data: input.body,
        timeout: REQUEST_TIMEOUT_MS,
        maxContentLength: RESPONSE_BODY_CAP_BYTES,
        // 不跟随重定向：30x 跳到不同 origin 会重新发送 Authorization，
        // 除非我们剥离它 —— 而剥离很脆弱。索性拒绝跟随。
        maxRedirects: 0,
        // 4xx/5xx 不抛错；这些响应的 body 仍然需要 scrub。
        validateStatus: () => true,
        // 避免 axios 尝试 transform / parse JSON；我们要先对原始 body 做 scrub。
        transformResponse: [(data: unknown) => data],
        responseType: 'text',
      })

      // 当 Content-Type 为二进制时 body 可能是 Buffer；安全地强转。
      const rawBody =
        typeof resp.data === 'string'
          ? resp.data
          : resp.data == null
            ? ''
            : String(resp.data)

      return {
        data: {
          status: resp.status,
          statusText: resp.statusText,
          responseHeaders: scrubResponseHeaders(resp.headers, forms),
          body: scrubAllSecretForms(rawBody, forms),
        },
      }
    } catch (e) {
      return { data: { error: scrubAxiosError(e, forms) } }
    }
  },
  renderToolUseMessage,
  renderToolResultMessage,
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: jsonStringify(output),
      is_error: output.error !== undefined,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
