/**
 * 跨应用访问（XAA）/ 企业托管授权（SEP-990）
 *
 * 通过链接以下步骤获取 MCP 访问令牌，无需浏览器同意页面：
 *   1. 在 IdP 处进行 RFC 8693 令牌交换：id_token → ID-JAG
 *   2. 在 AS 处进行 RFC 7523 JWT Bearer 授权：ID-JAG → access_token
 *
 * 规范参考：
 *   - ID-JAG（IETF 草案）：https://datatracker.ietf.org/doc/draft-ietf-oauth-identity-assertion-authz-grant/
 *   - MCP ext-auth（SEP-990）：https://github.com/modelcontextprotocol/ext-auth
 *   - RFC 8693（令牌交换）、RFC 7523（JWT Bearer）、RFC 9728（PRM）
 *
 * 参考实现：~/code/mcp/conformance/examples/clients/typescript/everything-client.ts:375-522
 *
 * 结构：四个 Layer-2 操作（与 TS SDK PR #1593 的 Layer-2 形状对齐，
 * 以便未来 SDK 替换是机械性的）+ 一个 Layer-3 编排器组合它们。
 */

import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
} from '@modelcontextprotocol/sdk/client/auth.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'
import { logMCPDebug } from '../../utils/log.js'
import { jsonStringify } from '../../utils/slowOperations.js'

const XAA_REQUEST_TIMEOUT_MS = 30000

const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange'
const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer'
const ID_JAG_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id-jag'
const ID_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id_token'

/**
 * 创建一个 fetch 包装器，强制执行 XAA 请求超时，并可选地
 * 组合调用方提供的 abort 信号。使用 AbortSignal.any 确保
 * 用户的取消（例如在认证菜单中按 Esc）能够真正中止正在进行的请求，
 * 而不是被超时信号覆盖。
 */
function makeXaaFetch(abortSignal?: AbortSignal): FetchLike {
  return (url, init) => {
    const timeout = AbortSignal.timeout(XAA_REQUEST_TIMEOUT_MS)
    const signal = abortSignal
      ? // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
        AbortSignal.any([timeout, abortSignal])
      : timeout
    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    return fetch(url, { ...init, signal })
  }
}

const defaultFetch = makeXaaFetch()

/**
 * RFC 8414 §3.3 / RFC 9728 §3.3 标识符比较。通过 URL 往返
 * 以应用 RFC 3986 §6.2.2 基于语法的规范化（小写化 scheme+host，
 * 移除默认端口），然后去除尾部斜杠。
 */
function normalizeUrl(url: string): string {
  try {
    return new URL(url).href.replace(/\/$/, '')
  } catch {
    return url.replace(/\/$/, '')
  }
}

/**
 * 当 IdP 令牌交换步骤失败时，由 requestJwtAuthorizationGrant 抛出。
 * 携带 `shouldClearIdToken` 以便调用者可以根据 OAuth 错误语义（而非子串匹配）
 * 决定是否删除缓存的 id_token：
 *   - 4xx / invalid_grant / invalid_token → id_token 有问题，清除它
 *   - 5xx → IdP 宕机，id_token 可能仍然有效，保留它
 *   - 200 但响应体结构无效 → 协议违规，清除它
 */
export class XaaTokenExchangeError extends Error {
  readonly shouldClearIdToken: boolean
  constructor(message: string, shouldClearIdToken: boolean) {
    super(message)
    this.name = 'XaaTokenExchangeError'
    this.shouldClearIdToken = shouldClearIdToken
  }
}

// 匹配已知承载令牌的键的引号值，无论嵌套深度如何。
// 适用于已解析再字符串化的 body 和来自 !res.ok 路径的原始 text() 错误体 ——
// 行为不当的 AS 在 4xx 错误信封中回显请求的 subject_token/assertion/client_secret
// 不能泄漏到调试日志中。
const SENSITIVE_TOKEN_RE =
  /"(access_token|refresh_token|id_token|assertion|subject_token|client_secret)"\s*:\s*"[^"]*"/g

function redactTokens(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : jsonStringify(raw)
  return s.replace(SENSITIVE_TOKEN_RE, (_, k) => `"${k}":"[REDACTED]"`)
}

// ─── Zod Schema ────────────────────────────────────────────────────────────

const TokenExchangeResponseSchema = lazySchema(() =>
  z.object({
    access_token: z.string().optional(),
    issued_token_type: z.string().optional(),
    // z.coerce 容忍将 expires_in 作为字符串发送的 IdP（在 PHP 后端
    // IdP 中很常见）—— 技术上不符合 JSON 规范但广泛存在。
    expires_in: z.coerce.number().optional(),
    scope: z.string().optional(),
  }),
)

const JwtBearerResponseSchema = lazySchema(() =>
  z.object({
    access_token: z.string().min(1),
    // 许多 AS 省略 token_type，因为 Bearer 是唯一被使用的值
    //（RFC 6750）。不要因为缺少标签而拒绝有效的 access_token。
    token_type: z.string().default('Bearer'),
    expires_in: z.coerce.number().optional(),
    scope: z.string().optional(),
    refresh_token: z.string().optional(),
  }),
)

// ─── Layer 2：发现 ──────────────────────────────────────────────────────────

export type ProtectedResourceMetadata = {
  resource: string
  authorization_servers: string[]
}

/**
 * 通过 SDK 进行 RFC 9728 PRM 发现，以及 RFC 9728 §3.3 资源不匹配
 * 验证（混淆保护 —— TODO：上游到 SDK）。
 */
export async function discoverProtectedResource(
  serverUrl: string,
  opts?: { fetchFn?: FetchLike },
): Promise<ProtectedResourceMetadata> {
  let prm
  try {
    prm = await discoverOAuthProtectedResourceMetadata(
      serverUrl,
      undefined,
      opts?.fetchFn ?? defaultFetch,
    )
  } catch (e) {
    throw new Error(
      `XAA: PRM discovery failed: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
  if (!prm.resource || !prm.authorization_servers?.[0]) {
    throw new Error(
      'XAA: PRM discovery failed: PRM missing resource or authorization_servers',
    )
  }
  if (normalizeUrl(prm.resource) !== normalizeUrl(serverUrl)) {
    throw new Error(
      `XAA: PRM discovery failed: PRM resource mismatch: expected ${serverUrl}, got ${prm.resource}`,
    )
  }
  return {
    resource: prm.resource,
    authorization_servers: prm.authorization_servers,
  }
}

export type AuthorizationServerMetadata = {
  issuer: string
  token_endpoint: string
  grant_types_supported?: string[]
  token_endpoint_auth_methods_supported?: string[]
}

/**
 * 通过 SDK 进行 AS 元数据发现（RFC 8414 + OIDC 回退），以及 RFC 8414
 * §3.3 发行者不匹配验证（混淆保护 —— TODO：上游到 SDK）。
 */
export async function discoverAuthorizationServer(
  asUrl: string,
  opts?: { fetchFn?: FetchLike },
): Promise<AuthorizationServerMetadata> {
  const meta = await discoverAuthorizationServerMetadata(asUrl, {
    fetchFn: opts?.fetchFn ?? defaultFetch,
  })
  if (!meta?.issuer || !meta.token_endpoint) {
    throw new Error(
      `XAA: AS metadata discovery failed: no valid metadata at ${asUrl}`,
    )
  }
  if (normalizeUrl(meta.issuer) !== normalizeUrl(asUrl)) {
    throw new Error(
      `XAA: AS metadata discovery failed: issuer mismatch: expected ${asUrl}, got ${meta.issuer}`,
    )
  }
  // RFC 8414 §3.3 / RFC 9728 §3 要求 HTTPS。一个 PRM 宣传的 http:// AS
  // 如果自洽地报告 http:// 发行者，将通过上面的不匹配检查，
  // 然后我们会通过明文 POST id_token + client_secret。
  if (new URL(meta.token_endpoint).protocol !== 'https:') {
    throw new Error(
      `XAA: refusing non-HTTPS token endpoint: ${meta.token_endpoint}`,
    )
  }
  return {
    issuer: meta.issuer,
    token_endpoint: meta.token_endpoint,
    grant_types_supported: meta.grant_types_supported,
    token_endpoint_auth_methods_supported:
      meta.token_endpoint_auth_methods_supported,
  }
}

// ─── Layer 2：交换 ──────────────────────────────────────────────────────────

export type JwtAuthGrantResult = {
  /** ID-JAG（身份断言授权授予） */
  jwtAuthGrant: string
  expiresIn?: number
  scope?: string
}

/**
 * 在 IdP 处进行 RFC 8693 令牌交换：id_token → ID-JAG。
 * 验证 `issued_token_type` 为 `urn:ietf:params:oauth:token-type:id-jag`。
 *
 * `clientSecret` 是可选的 —— 如果存在则通过 `client_secret_post` 发送。
 * 某些 IdP 将客户端注册为机密的，即使它们宣传
 * `token_endpoint_auth_method: "none"`。
 *
 * TODO(xaa-ga)：从 IdP OIDC 元数据中查询 `token_endpoint_auth_methods_supported`
 * 并支持 `client_secret_basic`，镜像 `performCrossAppAccess` 中 AS 端的
 * 选择。目前所有主要 IdP 都接受 POST。
 */
export async function requestJwtAuthorizationGrant(opts: {
  tokenEndpoint: string
  audience: string
  resource: string
  idToken: string
  clientId: string
  clientSecret?: string
  scope?: string
  fetchFn?: FetchLike
}): Promise<JwtAuthGrantResult> {
  const fetchFn = opts.fetchFn ?? defaultFetch
  const params = new URLSearchParams({
    grant_type: TOKEN_EXCHANGE_GRANT,
    requested_token_type: ID_JAG_TOKEN_TYPE,
    audience: opts.audience,
    resource: opts.resource,
    subject_token: opts.idToken,
    subject_token_type: ID_TOKEN_TYPE,
    client_id: opts.clientId,
  })
  if (opts.clientSecret) {
    params.set('client_secret', opts.clientSecret)
  }
  if (opts.scope) {
    params.set('scope', opts.scope)
  }

  const res = await fetchFn(opts.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  })
  if (!res.ok) {
    const body = redactTokens(await res.text()).slice(0, 200)
    // 4xx → id_token 被拒绝（invalid_grant 等），清除缓存。
    // 5xx → IdP 故障，id_token 可能仍然有效，保留它。
    const shouldClear = res.status < 500
    throw new XaaTokenExchangeError(
      `XAA: token exchange failed: HTTP ${res.status}: ${body}`,
      shouldClear,
    )
  }
  let rawExchange: unknown
  try {
    rawExchange = await res.json()
  } catch {
    // 临时网络状况（强制门户、代理）—— 不要清除 id_token。
    throw new XaaTokenExchangeError(
      `XAA: token exchange returned non-JSON (captive portal?) at ${opts.tokenEndpoint}`,
      false,
    )
  }
  const exchangeParsed = TokenExchangeResponseSchema().safeParse(rawExchange)
  if (!exchangeParsed.success) {
    throw new XaaTokenExchangeError(
      `XAA: token exchange response did not match expected shape: ${redactTokens(rawExchange)}`,
      true,
    )
  }
  const result = exchangeParsed.data
  if (!result.access_token) {
    throw new XaaTokenExchangeError(
      `XAA: token exchange response missing access_token: ${redactTokens(result)}`,
      true,
    )
  }
  if (result.issued_token_type !== ID_JAG_TOKEN_TYPE) {
    throw new XaaTokenExchangeError(
      `XAA: token exchange returned unexpected issued_token_type: ${result.issued_token_type}`,
      true,
    )
  }
  return {
    jwtAuthGrant: result.access_token,
    expiresIn: result.expires_in,
    scope: result.scope,
  }
}

export type XaaTokenResult = {
  access_token: string
  token_type: string
  expires_in?: number
  scope?: string
  refresh_token?: string
}

export type XaaResult = XaaTokenResult & {
  /**
   * 通过 PRM 发现的 AS 发行者 URL。调用者必须将其持久化为
   * `discoveryState.authorizationServerUrl`，以便刷新（auth.ts _doRefresh）
   * 和撤销（revokeServerTokens）能够定位令牌/撤销
   * 端点 —— 在典型的 XAA 设置中，MCP URL 不是 AS URL。
   */
  authorizationServerUrl: string
}

/**
 * 在 AS 处进行 RFC 7523 JWT Bearer 授权：ID-JAG → access_token。
 *
 * `authMethod` 默认为 `client_secret_basic`（Base64 头部，而非 body
 * 参数）—— SEP-990 一致性测试要求这样。只有当 AS 明确要求时才设置
 * `client_secret_post`。
 */
export async function exchangeJwtAuthGrant(opts: {
  tokenEndpoint: string
  assertion: string
  clientId: string
  clientSecret: string
  authMethod?: 'client_secret_basic' | 'client_secret_post'
  scope?: string
  fetchFn?: FetchLike
}): Promise<XaaTokenResult> {
  const fetchFn = opts.fetchFn ?? defaultFetch
  const authMethod = opts.authMethod ?? 'client_secret_basic'

  const params = new URLSearchParams({
    grant_type: JWT_BEARER_GRANT,
    assertion: opts.assertion,
  })
  if (opts.scope) {
    params.set('scope', opts.scope)
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  }
  if (authMethod === 'client_secret_basic') {
    const basicAuth = Buffer.from(
      `${encodeURIComponent(opts.clientId)}:${encodeURIComponent(opts.clientSecret)}`,
    ).toString('base64')
    headers.Authorization = `Basic ${basicAuth}`
  } else {
    params.set('client_id', opts.clientId)
    params.set('client_secret', opts.clientSecret)
  }

  const res = await fetchFn(opts.tokenEndpoint, {
    method: 'POST',
    headers,
    body: params,
  })
  if (!res.ok) {
    const body = redactTokens(await res.text()).slice(0, 200)
    throw new Error(`XAA: jwt-bearer grant failed: HTTP ${res.status}: ${body}`)
  }
  let rawTokens: unknown
  try {
    rawTokens = await res.json()
  } catch {
    throw new Error(
      `XAA: jwt-bearer grant returned non-JSON (captive portal?) at ${opts.tokenEndpoint}`,
    )
  }
  const tokensParsed = JwtBearerResponseSchema().safeParse(rawTokens)
  if (!tokensParsed.success) {
    throw new Error(
      `XAA: jwt-bearer response did not match expected shape: ${redactTokens(rawTokens)}`,
    )
  }
  return tokensParsed.data
}

// ─── Layer 3：编排器 ────────────────────────────────────────────────────────

/**
 * 运行完整 XAA 编排器所需的配置。
 * 镜像一致性测试上下文形状（参见 ClientConformanceContextSchema）。
 */
export type XaaConfig = {
  /** 在 MCP 服务器的授权服务器上注册的客户端 ID */
  clientId: string
  /** MCP 服务器授权服务器的客户端密钥 */
  clientSecret: string
  /** 在 IdP 注册的客户端 ID（用于令牌交换请求） */
  idpClientId: string
  /** 可选的 IdP 客户端密钥（client_secret_post）—— 某些 IdP 要求提供 */
  idpClientSecret?: string
  /** 用户在 IdP 登录时获得的 OIDC id_token */
  idpIdToken: string
  /** IdP 令牌端点（发送 RFC 8693 令牌交换的目标地址） */
  idpTokenEndpoint: string
}

/**
 * 完整 XAA 流程：PRM → AS 元数据 → 令牌交换 → jwt-bearer → access_token。
 * 四个 Layer-2 操作的简单组合。由 performMCPXaaAuth、
 * ClaudeAuthProvider.xaaRefresh 和 try-xaa*.ts 调试脚本使用。
 *
 * @param serverUrl MCP 服务器 URL（例如 `https://mcp.example.com/mcp`）
 * @param config IdP + AS 凭据
 * @param serverName 用于调试日志的服务器名称
 */
export async function performCrossAppAccess(
  serverUrl: string,
  config: XaaConfig,
  serverName = 'xaa',
  abortSignal?: AbortSignal,
): Promise<XaaResult> {
  const fetchFn = makeXaaFetch(abortSignal)

  logMCPDebug(serverName, `XAA: discovering PRM for ${serverUrl}`)
  const prm = await discoverProtectedResource(serverUrl, { fetchFn })
  logMCPDebug(
    serverName,
    `XAA: discovered resource=${prm.resource} ASes=[${prm.authorization_servers.join(', ')}]`,
  )

  // 按顺序尝试每个宣传的 AS。grant_types_supported 在 RFC 8414 §2 中是可选的
  // —— 只有当 AS 明确宣传了一个不包含 jwt-bearer 的列表时才跳过。
  // 如果缺失，让令牌端点自行决定。
  let asMeta: AuthorizationServerMetadata | undefined
  const asErrors: string[] = []
  for (const asUrl of prm.authorization_servers) {
    let candidate: AuthorizationServerMetadata
    try {
      candidate = await discoverAuthorizationServer(asUrl, { fetchFn })
    } catch (e) {
      if (abortSignal?.aborted) throw e
      asErrors.push(`${asUrl}: ${e instanceof Error ? e.message : String(e)}`)
      continue
    }
    if (
      candidate.grant_types_supported &&
      !candidate.grant_types_supported.includes(JWT_BEARER_GRANT)
    ) {
      asErrors.push(
        `${asUrl}: does not advertise jwt-bearer grant (supported: ${candidate.grant_types_supported.join(', ')})`,
      )
      continue
    }
    asMeta = candidate
    break
  }
  if (!asMeta) {
    throw new Error(
      `XAA: no authorization server supports jwt-bearer. Tried: ${asErrors.join('; ')}`,
    )
  }
  // 根据 AS 宣传的内容选择认证方法。我们处理
  // client_secret_basic 和 client_secret_post；如果 AS 只支持 post，
  // 遵从它，否则默认为 basic（SEP-990 一致性期望）。
  const authMethods = asMeta.token_endpoint_auth_methods_supported
  const authMethod: 'client_secret_basic' | 'client_secret_post' =
    authMethods &&
    !authMethods.includes('client_secret_basic') &&
    authMethods.includes('client_secret_post')
      ? 'client_secret_post'
      : 'client_secret_basic'
  logMCPDebug(
    serverName,
    `XAA: AS issuer=${asMeta.issuer} token_endpoint=${asMeta.token_endpoint} auth_method=${authMethod}`,
  )

  logMCPDebug(serverName, `XAA: exchanging id_token for ID-JAG at IdP`)
  const jag = await requestJwtAuthorizationGrant({
    tokenEndpoint: config.idpTokenEndpoint,
    audience: asMeta.issuer,
    resource: prm.resource,
    idToken: config.idpIdToken,
    clientId: config.idpClientId,
    clientSecret: config.idpClientSecret,
    fetchFn,
  })
  logMCPDebug(serverName, `XAA: ID-JAG obtained`)

  logMCPDebug(serverName, `XAA: exchanging ID-JAG for access_token at AS`)
  const tokens = await exchangeJwtAuthGrant({
    tokenEndpoint: asMeta.token_endpoint,
    assertion: jag.jwtAuthGrant,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    authMethod,
    fetchFn,
  })
  logMCPDebug(serverName, `XAA: access_token obtained`)

  return { ...tokens, authorizationServerUrl: asMeta.issuer }
}
