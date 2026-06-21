/**
 * XAA IdP 登录 — 通过标准 authorization_code + PKCE 流程从企业 IdP 获取
 * OIDC id_token，然后按 IdP issuer 缓存。
 *
 * 这是 XAA 价值主张中的"一次浏览器弹窗"：一次 IdP 登录 → N 次静默
 * MCP 服务器认证。id_token 缓存在 keychain 中，在过期前一直复用。
 */

import {
  exchangeAuthorization,
  startAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js'
import {
  type OAuthClientInformation,
  type OpenIdProviderDiscoveryMetadata,
  OpenIdProviderDiscoveryMetadataSchema,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import { randomBytes } from 'crypto'
import { createServer, type Server } from 'http'
import { parse } from 'url'
import xss from 'xss'
import { openBrowser } from '../../utils/browser.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { toError } from '../../utils/errors.js'
import { logMCPDebug } from '../../utils/log.js'
import { getPlatform } from '../../utils/platform.js'
import { getSecureStorage } from '../../utils/secureStorage/index.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { jsonParse } from '../../utils/slowOperations.js'
import { buildRedirectUri, findAvailablePort } from './oauthPort.js'

export function isXaaEnabled(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_XAA)
}

export type XaaIdpSettings = {
  issuer: string
  clientId: string
  callbackPort?: number
}

/**
 * settings.xaaIdp 的类型化访问器。该字段在 SettingsSchema 中受环境变量控制，
 * 因此不会出现在 SDK 类型/文档中 — 这意味着推断的 settings 类型在编译时
 * 没有该字段。这是唯一一处类型断言。
 */
export function getXaaIdpSettings(): XaaIdpSettings | undefined {
  return (getInitialSettings() as { xaaIdp?: XaaIdpSettings }).xaaIdp
}

const IDP_LOGIN_TIMEOUT_MS = 5 * 60 * 1000
const IDP_REQUEST_TIMEOUT_MS = 30000
const ID_TOKEN_EXPIRY_BUFFER_S = 60

export type IdpLoginOptions = {
  idpIssuer: string
  idpClientId: string
  /**
   * 可选的 IdP 客户端密钥，用于机密客户端。认证方法
   * （client_secret_post、client_secret_basic、none）根据 IdP
   * 元数据选择。公共客户端（仅 PKCE）请省略。
   */
  idpClientSecret?: string
  /**
   * 固定的回调端口。如果省略，则随机选择一个端口。
   * 当 IdP 客户端已预注册特定的 loopback 重定向 URI 时使用此选项
   * （RFC 8252 §7.3 规定 IdP 应该接受 http://localhost 的任意端口，
   * 但很多 IdP 并不遵守）。
   */
  callbackPort?: number
  /** 在打开浏览器之前（或代替打开浏览器）使用授权 URL 调用 */
  onAuthorizationUrl?: (url: string) => void
  /** 如果为 true，不自动打开浏览器 — 仅调用 onAuthorizationUrl */
  skipBrowserOpen?: boolean
  abortSignal?: AbortSignal
}

/**
 * 规范化 IdP issuer URL 作为缓存键：去除尾部斜杠，
 * 将主机名转为小写。来自配置和 OIDC 发现的 issuer 可能在
 * 外观上有所不同，但应该命中同一个缓存槽位。导出此函数以便 setup
 * 命令可以使用与 keychain 操作相同的规范化方式来比较 issuer。
 */
export function issuerKey(issuer: string): string {
  try {
    const u = new URL(issuer)
    u.pathname = u.pathname.replace(/\/+$/, '')
    u.host = u.host.toLowerCase()
    return u.toString()
  } catch {
    return issuer.replace(/\/+$/, '')
  }
}

/**
 * 从安全存储中读取指定 IdP issuer 的缓存 id_token。
 * 如果缺失或在 ID_TOKEN_EXPIRY_BUFFER_S 内即将过期则返回 undefined。
 */
export function getCachedIdpIdToken(idpIssuer: string): string | undefined {
  const storage = getSecureStorage()
  const data = storage.read()
  const entry = data?.mcpXaaIdp?.[issuerKey(idpIssuer)]
  if (!entry) return undefined
  const remainingMs = entry.expiresAt - Date.now()
  if (remainingMs <= ID_TOKEN_EXPIRY_BUFFER_S * 1000) return undefined
  return entry.idToken
}

function saveIdpIdToken(
  idpIssuer: string,
  idToken: string,
  expiresAt: number,
): void {
  const storage = getSecureStorage()
  const existing = storage.read() || {}
  storage.update({
    ...existing,
    mcpXaaIdp: {
      ...existing.mcpXaaIdp,
      [issuerKey(idpIssuer)]: { idToken, expiresAt },
    },
  })
}

/**
 * 将外部获取的 id_token 保存到 XAA 缓存 — 即
 * getCachedIdpIdToken/acquireIdpIdToken 读取的同一个槽位。用于一致性测试，
 * 其中 mock IdP 提供预签名的 token 但不提供 /authorize 端点。
 *
 * 解析 JWT 的 exp claim 确定缓存 TTL（与 acquireIdpIdToken 相同）。
 * 返回计算出的 expiresAt 以便调用方报告。
 */
export function saveIdpIdTokenFromJwt(
  idpIssuer: string,
  idToken: string,
): number {
  const expFromJwt = jwtExp(idToken)
  const expiresAt = expFromJwt ? expFromJwt * 1000 : Date.now() + 3600 * 1000
  saveIdpIdToken(idpIssuer, idToken, expiresAt)
  return expiresAt
}

export function clearIdpIdToken(idpIssuer: string): void {
  const storage = getSecureStorage()
  const existing = storage.read()
  const key = issuerKey(idpIssuer)
  if (!existing?.mcpXaaIdp?.[key]) return
  delete existing.mcpXaaIdp[key]
  storage.update(existing)
}

/**
 * 将 IdP 客户端密钥保存到安全存储，以 IdP issuer 为键。
 * 与 MCP 服务器 AS 密钥分开 — 不同的信任域。
 * 返回存储更新结果，以便调用方可以报告 keychain
 * 失败（keychain 锁定、`security` 非零退出）而不是
 * 静默丢弃密钥，导致后续因 invalid_client 而失败。
 */
export function saveIdpClientSecret(
  idpIssuer: string,
  clientSecret: string,
): { success: boolean; warning?: string } {
  const storage = getSecureStorage()
  const existing = storage.read() || {}
  return storage.update({
    ...existing,
    mcpXaaIdpConfig: {
      ...existing.mcpXaaIdpConfig,
      [issuerKey(idpIssuer)]: { clientSecret },
    },
  })
}

/**
 * 从安全存储中读取指定 issuer 的 IdP 客户端密钥。
 */
export function getIdpClientSecret(idpIssuer: string): string | undefined {
  const storage = getSecureStorage()
  const data = storage.read()
  return data?.mcpXaaIdpConfig?.[issuerKey(idpIssuer)]?.clientSecret
}

/**
 * 从安全存储中移除指定 issuer 的 IdP 客户端密钥。
 * 由 `claude mcp xaa clear` 命令使用。
 */
export function clearIdpClientSecret(idpIssuer: string): void {
  const storage = getSecureStorage()
  const existing = storage.read()
  const key = issuerKey(idpIssuer)
  if (!existing?.mcpXaaIdpConfig?.[key]) return
  delete existing.mcpXaaIdpConfig[key]
  storage.update(existing)
}

// OIDC Discovery §4.1 规定 `{issuer}/.well-known/openid-configuration` — 是路径
// 追加，不是替换。`new URL('/.well-known/...', issuer)` 带前导斜杠时
// 是 WHATWG 绝对路径引用，会丢弃 issuer 的 pathname，
// 从而破坏 Azure AD（`login.microsoftonline.com/{tenant}/v2.0`）、Okta 自定义
// 授权服务器和 Keycloak realm。尾部斜杠 base + 相对路径是
// 修复方案。导出此函数因为 auth.ts 也需要相同的发现逻辑。
export async function discoverOidc(
  idpIssuer: string,
): Promise<OpenIdProviderDiscoveryMetadata> {
  const base = idpIssuer.endsWith('/') ? idpIssuer : idpIssuer + '/'
  const url = new URL('.well-known/openid-configuration', base)
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(IDP_REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) {
    throw new Error(
      `XAA IdP: OIDC discovery failed: HTTP ${res.status} at ${url}`,
    )
  }
  // 强制门户和代理认证页面会返回 200 和 HTML。res.json()
  // 会抛出原始 SyntaxError，而 safeParse 可以提供更有用的错误信息。
  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new Error(
      `XAA IdP: OIDC discovery returned non-JSON at ${url} (captive portal or proxy?)`,
    )
  }
  const parsed = OpenIdProviderDiscoveryMetadataSchema.safeParse(body)
  if (!parsed.success) {
    throw new Error(`XAA IdP: invalid OIDC metadata: ${parsed.error.message}`)
  }
  if (new URL(parsed.data.token_endpoint).protocol !== 'https:') {
    throw new Error(
      `XAA IdP: refusing non-HTTPS token endpoint: ${parsed.data.token_endpoint}`,
    )
  }
  return parsed.data
}

/**
 * 在不验证签名的情况下从 JWT 中解码 exp claim。
 * 如果解析失败或 exp 不存在则返回 undefined。仅用于
 * 推导缓存 TTL。
 *
 * 为什么不进行签名/iss/aud/nonce 验证：根据 SEP-990，此 id_token
 * 是在 IdP 自身 token 端点进行 token 交换时的 RFC 8693 subject_token。
 * IdP 在那里会验证自己的 token。能够伪造一个骗过 IdP 的 token 的
 * 攻击者没有必要先骗我们；不能的攻击者给我们垃圾数据，
 * 会从 IdP 得到 401。--id-token 注入点同样是安全的：
 * 错误输入 → 后续被拒绝，不会提权。客户端验证只会增加代码量
 * 而不会增加安全性。
 */
function jwtExp(jwt: string): number | undefined {
  const parts = jwt.split('.')
  if (parts.length !== 3) return undefined
  try {
    const payload = jsonParse(
      Buffer.from(parts[1]!, 'base64url').toString('utf-8'),
    ) as { exp?: number }
    return typeof payload.exp === 'number' ? payload.exp : undefined
  } catch {
    return undefined
  }
}

/**
 * 等待本地回调服务器上的 OAuth 授权码。
 * 当 /callback 被命中且 state 匹配时返回 code。
 *
 * `onListening` 在 socket 实际绑定后触发 — 使用它来延迟
 * 打开浏览器，这样 EADDRINUSE 错误会在无关标签页弹出之前暴露出来。
 */
function waitForCallback(
  port: number,
  expectedState: string,
  abortSignal: AbortSignal | undefined,
  onListening: () => void,
): Promise<string> {
  let server: Server | null = null
  let timeoutId: NodeJS.Timeout | null = null
  let abortHandler: (() => void) | null = null
  const cleanup = () => {
    server?.removeAllListeners()
    // 防御性编程：removeAllListeners() 会移除 error 处理器，所以吞掉关闭时的任何迟到错误
    server?.on('error', () => {})
    server?.close()
    server = null
    if (timeoutId) {
      clearTimeout(timeoutId)
      timeoutId = null
    }
    if (abortSignal && abortHandler) {
      abortSignal.removeEventListener('abort', abortHandler)
      abortHandler = null
    }
  }
  return new Promise<string>((resolve, reject) => {
    let resolved = false
    const resolveOnce = (v: string) => {
      if (resolved) return
      resolved = true
      cleanup()
      resolve(v)
    }
    const rejectOnce = (e: Error) => {
      if (resolved) return
      resolved = true
      cleanup()
      reject(e)
    }

    if (abortSignal) {
      abortHandler = () => rejectOnce(new Error('XAA IdP: login cancelled'))
      if (abortSignal.aborted) {
        abortHandler()
        return
      }
      abortSignal.addEventListener('abort', abortHandler, { once: true })
    }

    server = createServer((req, res) => {
      const parsed = parse(req.url || '', true)
      if (parsed.pathname !== '/callback') {
        res.writeHead(404)
        res.end()
        return
      }
      const code = parsed.query.code as string | undefined
      const state = parsed.query.state as string | undefined
      const err = parsed.query.error as string | undefined

      if (err) {
        const desc = parsed.query.error_description as string | undefined
        const safeErr = xss(err)
        const safeDesc = desc ? xss(desc) : ''
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end(
          `<html><body><h3>IdP login failed</h3><p>${safeErr}</p><p>${safeDesc}</p></body></html>`,
        )
        rejectOnce(new Error(`XAA IdP: ${err}${desc ? ` — ${desc}` : ''}`))
        return
      }

      if (state !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end('<html><body><h3>State mismatch</h3></body></html>')
        rejectOnce(new Error('XAA IdP: state mismatch (possible CSRF)'))
        return
      }

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end('<html><body><h3>Missing code</h3></body></html>')
        rejectOnce(new Error('XAA IdP: callback missing code'))
        return
      }

      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(
        '<html><body><h3>IdP login complete — you can close this window.</h3></body></html>',
      )
      resolveOnce(code)
    })

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        const findCmd =
          getPlatform() === 'windows'
            ? `netstat -ano | findstr :${port}`
            : `lsof -ti:${port} -sTCP:LISTEN`
        rejectOnce(
          new Error(
            `XAA IdP: callback port ${port} is already in use. Run \`${findCmd}\` to find the holder.`,
          ),
        )
      } else {
        rejectOnce(new Error(`XAA IdP: callback server failed: ${err.message}`))
      }
    })

    server.listen(port, '127.0.0.1', () => {
      try {
        onListening()
      } catch (e) {
        rejectOnce(toError(e))
      }
    })
    server.unref()
    timeoutId = setTimeout(
      rej => rej(new Error('XAA IdP: login timed out')),
      IDP_LOGIN_TIMEOUT_MS,
      rejectOnce,
    )
    timeoutId.unref()
  })
}

/**
 * 从 IdP 获取 id_token：如果缓存有效则返回缓存，否则运行
 * 完整的 OIDC authorization_code + PKCE 流程（一次浏览器弹窗）。
 */
export async function acquireIdpIdToken(
  opts: IdpLoginOptions,
): Promise<string> {
  const { idpIssuer, idpClientId } = opts

  const cached = getCachedIdpIdToken(idpIssuer)
  if (cached) {
    logMCPDebug('xaa', `Using cached id_token for ${idpIssuer}`)
    return cached
  }

  logMCPDebug('xaa', `No cached id_token for ${idpIssuer}; starting OIDC login`)

  const metadata = await discoverOidc(idpIssuer)
  const port = opts.callbackPort ?? (await findAvailablePort())
  const redirectUri = buildRedirectUri(port)
  const state = randomBytes(32).toString('base64url')
  const clientInformation: OAuthClientInformation = {
    client_id: idpClientId,
    ...(opts.idpClientSecret ? { client_secret: opts.idpClientSecret } : {}),
  }

  const { authorizationUrl, codeVerifier } = await startAuthorization(
    idpIssuer,
    {
      metadata,
      clientInformation,
      redirectUrl: redirectUri,
      scope: 'openid',
      state,
    },
  )

  // 仅在 socket 实际绑定后才打开浏览器 — listen() 是
  // 异步的，在固定 callbackPort 路径上 EADDRINUSE 否则会在
  // 无关标签页已经弹出后才暴露。与 auth.ts 中将 sdkAuth
  // 包装在 server.listen 回调内的模式一致。
  const authorizationCode = await waitForCallback(
    port,
    state,
    opts.abortSignal,
    () => {
      if (opts.onAuthorizationUrl) {
        opts.onAuthorizationUrl(authorizationUrl.toString())
      }
      if (!opts.skipBrowserOpen) {
        logMCPDebug('xaa', `Opening browser to IdP authorization endpoint`)
        void openBrowser(authorizationUrl.toString())
      }
    },
  )

  const tokens = await exchangeAuthorization(idpIssuer, {
    metadata,
    clientInformation,
    authorizationCode,
    codeVerifier,
    redirectUri,
    fetchFn: (url, init) =>
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      fetch(url, {
        ...init,
        signal: AbortSignal.timeout(IDP_REQUEST_TIMEOUT_MS),
      }),
  })
  if (!tokens.id_token) {
    throw new Error(
      'XAA IdP: token response missing id_token (check scope=openid)',
    )
  }

  // 优先使用 id_token 自身的 exp claim；回退到 expires_in。
  // expires_in 是针对 access_token 的，可能与 id_token 的
  // 有效期不同。如果两者都不存在，默认 1 小时。
  const expFromJwt = jwtExp(tokens.id_token)
  const expiresAt = expFromJwt
    ? expFromJwt * 1000
    : Date.now() + (tokens.expires_in ?? 3600) * 1000

  saveIdpIdToken(idpIssuer, tokens.id_token, expiresAt)
  logMCPDebug(
    'xaa',
    `Cached id_token for ${idpIssuer} (expires ${new Date(expiresAt).toISOString()})`,
  )

  return tokens.id_token
}
