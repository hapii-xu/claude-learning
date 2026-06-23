import axios, { type AxiosResponse } from 'axios'
import { LRUCache } from 'lru-cache'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { queryHaiku } from 'src/services/api/claude.js'
import { AbortError } from 'src/utils/errors.js'
import { getWebFetchUserAgent } from 'src/utils/http.js'
import { logError } from 'src/utils/log.js'
import {
  isBinaryContentType,
  persistBinaryContent,
} from 'src/utils/mcpOutputStorage.js'
import { getSettings_DEPRECATED } from 'src/utils/settings/settings.js'
import { asSystemPrompt } from 'src/utils/systemPromptType.js'
import { isPreapprovedHost } from './preapproved.js'
import { makeSecondaryModelPrompt } from './prompt.js'

const DEFAULT_TAVILY_EXTRACT_URL = 'https://tavily.claude-code-best.win/extract'

// 用于出口代理封锁的自定义错误类
class EgressBlockedError extends Error {
  constructor(public readonly domain: string) {
    super(
      JSON.stringify({
        error_type: 'EGRESS_BLOCKED',
        domain,
        message: `对 ${domain} 的访问被网络出口代理封锁。`,
      }),
    )
    this.name = 'EgressBlockedError'
  }
}

// 用于缓存已获取 URL 内容的缓存
type CacheEntry = {
  bytes: number
  code: number
  codeText: string
  content: string
  contentType: string
  persistedPath?: string
  persistedSize?: number
}

// 缓存：15 分钟 TTL，50MB 大小上限
// LRUCache 自动处理过期和驱逐
const CACHE_TTL_MS = 15 * 60 * 1000 // 15 分钟
const MAX_CACHE_SIZE_BYTES = 50 * 1024 * 1024 // 50MB

const URL_CACHE = new LRUCache<string, CacheEntry>({
  maxSize: MAX_CACHE_SIZE_BYTES,
  ttl: CACHE_TTL_MS,
})

export function clearWebFetchCache(): void {
  URL_CACHE.clear()
}

function responseHeaderToString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value
  }
  if (Array.isArray(value)) {
    const parts = value
      .map(responseHeaderToString)
      .filter((part): part is string => part !== undefined)
    return parts.length > 0 ? parts.join(', ') : undefined
  }
  return undefined
}

function getResponseHeader(
  headers: AxiosResponse<unknown>['headers'],
  name: string,
): string | undefined {
  const headersWithGet = headers as { get?: (headerName: string) => unknown }
  if (typeof headersWithGet.get === 'function') {
    const value = responseHeaderToString(headersWithGet.get(name))
    if (value !== undefined) {
      return value
    }
  }

  return responseHeaderToString(headers[name.toLowerCase()])
}

// 懒加载单例 — 将 turndown → @mixmark-io/domino 的导入（约 1.4MB
// 常驻堆内存）延迟到首次 HTML 抓取，并在多次调用间复用同一实例
// （构造时会构建 15 个规则对象；.turndown() 本身无状态）。
// @types/turndown 仅提供 `export =`（没有 .d.mts），因此 TS 将导入
// 类型推断为类本身，而 Bun 用 { default } 包装 CJS — 因此需要此类型转换。
type TurndownCtor = typeof import('turndown')
let turndownServicePromise: Promise<InstanceType<TurndownCtor>> | undefined
function getTurndownService(): Promise<InstanceType<TurndownCtor>> {
  return (turndownServicePromise ??= import('turndown').then(m => {
    const Turndown = (m as unknown as { default: TurndownCtor }).default
    return new Turndown()
  }))
}

// PSR 曾要求将 URL 长度限制为 250 以降低数据渗出风险。然而，这对部分客户
// 的合法用例过于限制，例如 JWT 签名的 URL（如云服务签名 URL）可能长得
// 多。我们已经对每个域要求用户授权，这提供了主要的安全边界。此外，Claude
// Code 还有其他数据渗出通道，而此通道的风险相对较低，因此我移除了该
// 长度限制。-ab
const MAX_URL_LENGTH = 2000

// 根据 PSR：
// "实施资源消耗控制，因为为 Web Fetch 工具设置 CPU、内存和网络使用
// 限制可以防止单个请求或用户压垮系统。"
const MAX_HTTP_CONTENT_LENGTH = 10 * 1024 * 1024

// 主 HTTP 抓取请求的超时时间（60 秒）。
// 防止在缓慢/无响应的服务器上无限期挂起。
// 可通过 settings.webFetchHttpTimeoutMs 覆盖（在 /web-tools 面板中设置）。
const DEFAULT_FETCH_TIMEOUT_MS = 60_000

function getFetchTimeoutMs(): number {
  const settings = getSettings_DEPRECATED() as Record<string, unknown> & {
    webFetchHttpTimeoutMs?: number
  }
  return settings.webFetchHttpTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
}

// 限制同主机重定向跳数。否则恶意服务器可以返回重定向循环
//（/a → /b → /a …），而每请求超时（由 settings.webFetchHttpTimeoutMs 控制）
// 在每一跳都会重置，导致工具一直挂起直到用户中断。10 与常见客户端
// 默认值一致（axios=5、follow-redirects=21、Chrome=20）。
const MAX_REDIRECTS = 10

// 截断以避免消耗过多 token
export const MAX_MARKDOWN_LENGTH = 100_000

export function isPreapprovedUrl(url: string): boolean {
  try {
    const parsedUrl = new URL(url)
    return isPreapprovedHost(parsedUrl.hostname, parsedUrl.pathname)
  } catch {
    return false
  }
}

export function validateURL(url: string): boolean {
  if (url.length > MAX_URL_LENGTH) {
    return false
  }

  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  // 这里不需要检查协议，因为发请求时会把 http 升级为 https

  // 只要我们不打算支持指向 cookies 或内部域名的 URL，
  // 也应阻止带用户名/密码的 URL，尽管这种情况极其少见。
  if (parsed.username || parsed.password) {
    return false
  }

  // 初步过滤：通过检查主机名是否可公开解析，
  // 确保这不是一个特权性的公司内部 URL
  const hostname = parsed.hostname
  const parts = hostname.split('.')
  if (parts.length < 2) {
    return false
  }

  return true
}

/**
 * 检查一个重定向是否可以安全地跟随
 * 允许的重定向：
 * - 在主机名中添加或移除 "www."
 * - 保持 origin 不变但更改路径/查询参数
 * - 或上述两者兼有
 */
export function isPermittedRedirect(
  originalUrl: string,
  redirectUrl: string,
): boolean {
  try {
    const parsedOriginal = new URL(originalUrl)
    const parsedRedirect = new URL(redirectUrl)

    if (parsedRedirect.protocol !== parsedOriginal.protocol) {
      return false
    }

    if (parsedRedirect.port !== parsedOriginal.port) {
      return false
    }

    if (parsedRedirect.username || parsedRedirect.password) {
      return false
    }

    // 现在检查主机名条件
    // 1. 允许添加 www.：example.com -> www.example.com
    // 2. 允许移除 www.：www.example.com -> example.com
    // 3. 允许同主机（带或不带 www.）：路径可以变化
    const stripWww = (hostname: string) => hostname.replace(/^www\./, '')
    const originalHostWithoutWww = stripWww(parsedOriginal.hostname)
    const redirectHostWithoutWww = stripWww(parsedRedirect.hostname)
    return originalHostWithoutWww === redirectHostWithoutWww
  } catch (_error) {
    return false
  }
}

/**
 * 辅助函数：处理带自定义重定向逻辑的 URL 抓取
 * 如果重定向通过了 redirectChecker 函数的检查，则递归跟随
 *
 * 根据 PSR：
 * "不要自动跟随重定向，因为跟随重定向可能让攻击者利用可信域上的
 * 开放重定向漏洞，在用户不知情的情况下迫使其向恶意域发起请求"
 */
type RedirectInfo = {
  type: 'redirect'
  originalUrl: string
  redirectUrl: string
  statusCode: number
}

export async function getWithPermittedRedirects(
  url: string,
  signal: AbortSignal,
  redirectChecker: (originalUrl: string, redirectUrl: string) => boolean,
  depth = 0,
): Promise<AxiosResponse<ArrayBuffer> | RedirectInfo> {
  if (depth > MAX_REDIRECTS) {
    throw new Error(`重定向次数过多（超过 ${MAX_REDIRECTS}）`)
  }
  try {
    return await axios.get(url, {
      signal,
      timeout: getFetchTimeoutMs(),
      maxRedirects: 0,
      responseType: 'arraybuffer',
      maxContentLength: MAX_HTTP_CONTENT_LENGTH,
      headers: {
        Accept: 'text/markdown, text/html, */*',
        'User-Agent': getWebFetchUserAgent(),
      },
    })
  } catch (error) {
    if (
      axios.isAxiosError(error) &&
      error.response &&
      [301, 302, 307, 308].includes(error.response.status)
    ) {
      const redirectLocation = getResponseHeader(
        error.response.headers,
        'location',
      )
      if (!redirectLocation) {
        throw new Error('重定向缺少 Location 头')
      }

      // 相对 URL 以原始 URL 为基准解析
      const redirectUrl = new URL(redirectLocation, url).toString()

      if (redirectChecker(url, redirectUrl)) {
        // 递归跟随被允许的重定向
        return getWithPermittedRedirects(
          redirectUrl,
          signal,
          redirectChecker,
          depth + 1,
        )
      } else {
        // 将重定向信息返回给调用方
        return {
          type: 'redirect',
          originalUrl: url,
          redirectUrl,
          statusCode: error.response.status,
        }
      }
    }

    // 检测出口代理封锁：当出口被限制时，代理返回 403 并附带
    // X-Proxy-Error: blocked-by-allowlist
    if (
      axios.isAxiosError(error) &&
      error.response?.status === 403 &&
      getResponseHeader(error.response.headers, 'x-proxy-error') ===
        'blocked-by-allowlist'
    ) {
      const hostname = new URL(url).hostname
      throw new EgressBlockedError(hostname)
    }

    throw error
  }
}

function isRedirectInfo(
  response: AxiosResponse<ArrayBuffer> | RedirectInfo,
): response is RedirectInfo {
  return 'type' in response && response.type === 'redirect'
}

export type FetchedContent = {
  content: string
  bytes: number
  code: number
  codeText: string
  contentType: string
  persistedPath?: string
  persistedSize?: number
}

export async function getURLMarkdownContent(
  url: string,
  abortController: AbortController,
): Promise<FetchedContent | RedirectInfo> {
  if (!validateURL(url)) {
    throw new Error('Invalid URL')
  }

  // 检查缓存（LRUCache 会自动处理 TTL）
  const cachedEntry = URL_CACHE.get(url)
  if (cachedEntry) {
    return {
      bytes: cachedEntry.bytes,
      code: cachedEntry.code,
      codeText: cachedEntry.codeText,
      content: cachedEntry.content,
      contentType: cachedEntry.contentType,
      persistedPath: cachedEntry.persistedPath,
      persistedSize: cachedEntry.persistedSize,
    }
  }

  let parsedUrl: URL
  let upgradedUrl = url

  try {
    parsedUrl = new URL(url)

    // 如有需要，将 http 升级为 https
    if (parsedUrl.protocol === 'http:') {
      parsedUrl.protocol = 'https:'
      upgradedUrl = parsedUrl.toString()
    }

    const hostname = parsedUrl.hostname

    if (process.env.USER_TYPE === 'ant') {
      logEvent('tengu_web_fetch_host', {
        hostname:
          hostname as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
    }
  } catch (e) {
    logError(e)
  }

  const response = await getWithPermittedRedirects(
    upgradedUrl,
    abortController.signal,
    isPermittedRedirect,
  )

  // 检查是否收到了重定向响应
  if (isRedirectInfo(response)) {
    return response
  }

  const rawBuffer = Buffer.from(response.data)
  // 释放 axios 持有的 ArrayBuffer 副本；现在由 rawBuffer 拥有这些字节。
  // 这让 GC 可以在 Turndown 构建 DOM 树（可能为 HTML 大小的 3-5 倍）
  // 之前回收多达 MAX_HTTP_CONTENT_LENGTH（10MB）的内存。
  ;(response as { data: unknown }).data = null
  const contentType = getResponseHeader(response.headers, 'content-type') ?? ''

  // 二进制内容：将原始字节保存到磁盘，使用正确的扩展名，以便 Claude
  // 之后可以检查该文件。我们仍然会走到下方的 utf-8 解码 + Haiku 路径 —
  // 对于 PDF，解码后的字符串具有足够的 ASCII 结构（/Title、文本流），
  // Haiku 能够对其进行摘要，而保存的文件是补充而非替代。
  let persistedPath: string | undefined
  let persistedSize: number | undefined
  if (isBinaryContentType(contentType)) {
    const persistId = `webfetch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const result = await persistBinaryContent(rawBuffer, contentType, persistId)
    if (!('error' in result)) {
      persistedPath = result.filepath
      persistedSize = result.size
    }
  }

  const bytes = rawBuffer.length
  const htmlContent = rawBuffer.toString('utf-8')

  let markdownContent: string
  let contentBytes: number
  if (contentType.includes('text/html')) {
    markdownContent = (await getTurndownService()).turndown(htmlContent)
    contentBytes = Buffer.byteLength(markdownContent)
  } else {
    // 不是 HTML — 直接使用原始内容。解码后字符串的 UTF-8 字节
    // 长度等于 rawBuffer.length（对无效字节的 U+FFFD 替换影响可忽略不计，
    // 对缓存驱逐核算无意义），因此跳过 O(n) 的 Buffer.byteLength 扫描。
    markdownContent = htmlContent
    contentBytes = bytes
  }

  // 将抓取到的内容存入缓存。注意它是按原始 URL 存储的，
  // 而非升级后或重定向后的 URL。
  const entry: CacheEntry = {
    bytes,
    code: response.status,
    codeText: response.statusText,
    content: markdownContent,
    contentType,
    persistedPath,
    persistedSize,
  }
  // lru-cache 要求正整数；空响应时将其钳制为 1。
  URL_CACHE.set(url, entry, { size: Math.max(1, contentBytes) })
  return entry
}

/**
 * 通过 Tavily Extract API 获取 URL 内容，该 API 直接返回 Markdown。
 * 这会跳过 HTML→Markdown 转换（turndown）和辅助模型调用
 *（queryHaiku）— Tavily 已经提供干净的 Markdown。
 */
export async function fetchContentWithTavily(
  url: string,
  abortController: AbortController,
): Promise<FetchedContent | RedirectInfo> {
  if (!validateURL(url)) {
    throw new Error('Invalid URL')
  }

  // 检查缓存（LRUCache 会自动处理 TTL）
  const cachedEntry = URL_CACHE.get(url)
  if (cachedEntry) {
    return {
      bytes: cachedEntry.bytes,
      code: cachedEntry.code,
      codeText: cachedEntry.codeText,
      content: cachedEntry.content,
      contentType: cachedEntry.contentType,
      persistedPath: cachedEntry.persistedPath,
      persistedSize: cachedEntry.persistedSize,
    }
  }

  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    throw new Error('Invalid URL')
  }

  // 如有需要，将 http 升级为 https
  if (parsedUrl.protocol === 'http:') {
    parsedUrl.protocol = 'https:'
    url = parsedUrl.toString()
  }

  const abortSignal = abortController.signal

  const settings = getSettings_DEPRECATED() as Record<string, unknown> & {
    tavilyEndpointUrl?: string
  }
  const baseUrl = settings.tavilyEndpointUrl || DEFAULT_TAVILY_EXTRACT_URL
  // 从 Tavily 基础端点派生 extract URL
  const extractUrl = baseUrl.endsWith('/search')
    ? baseUrl.replace(/\/search$/, '/extract')
    : baseUrl.endsWith('/extract')
      ? baseUrl
      : `${baseUrl.replace(/\/$/, '')}/extract`

  const response = await axios.post<{ url: string; raw_content: string }>(
    extractUrl,
    {
      urls: [url],
    },
    {
      signal: abortSignal,
      timeout: getFetchTimeoutMs(),
      headers: { 'Content-Type': 'application/json' },
    },
  )

  if (abortSignal.aborted) {
    throw new AbortError()
  }

  const rawContent = response.data?.raw_content ?? ''
  // 如果 raw_content 是 JSON 字符串（extract 可能按 URL 返回
  // {url:..., raw_content:...}），则进行解包。
  let markdownContent = rawContent
  if (!markdownContent.trim()) {
    // 尝试从 results 数组中提取
    const resp = response.data as unknown as {
      results?: Array<{ raw_content?: string }>
    }
    const results = resp.results ?? []
    if (results.length > 0 && results[0].raw_content) {
      markdownContent = results[0].raw_content
    }
  }

  if (!markdownContent.trim()) {
    throw new Error(
      `Tavily Extract 对 ${url} 返回了空内容。该页面可能需要认证或 JavaScript 渲染。`,
    )
  }

  const contentBytes = Buffer.byteLength(markdownContent)

  const entry: CacheEntry = {
    bytes: contentBytes,
    code: 200,
    codeText: 'OK',
    content: markdownContent,
    contentType: 'text/markdown',
  }
  URL_CACHE.set(url, entry, { size: Math.max(1, contentBytes) })
  return entry
}

export async function applyPromptToMarkdown(
  prompt: string,
  markdownContent: string,
  signal: AbortSignal,
  isNonInteractiveSession: boolean,
  isPreapprovedDomain: boolean,
): Promise<string> {
  // 截断内容以避免辅助模型出现 "Prompt is too long" 错误
  const truncatedContent =
    markdownContent.length > MAX_MARKDOWN_LENGTH
      ? markdownContent.slice(0, MAX_MARKDOWN_LENGTH) +
        '\n\n[内容因长度被截断...]'
      : markdownContent

  const modelPrompt = makeSecondaryModelPrompt(
    truncatedContent,
    prompt,
    isPreapprovedDomain,
  )
  const assistantMessage = await queryHaiku({
    systemPrompt: asSystemPrompt([]),
    userPrompt: modelPrompt,
    signal,
    options: {
      querySource: 'web_fetch_apply',
      agents: [],
      isNonInteractiveSession,
      hasAppendSystemPrompt: false,
      mcpTools: [],
    },
  })

  // 我们需要把此异常向上抛出，让工具调用抛错，从而向服务器返回一个
  // is_error 的 tool_use block，并在 UI 中渲染一个红点。
  if (signal.aborted) {
    throw new AbortError()
  }

  const { content } = assistantMessage.message!
  if (content!.length > 0) {
    const contentBlock = content![0]
    if (
      contentBlock &&
      typeof contentBlock === 'object' &&
      'text' in contentBlock
    ) {
      return (contentBlock as { text: string }).text
    }
  }
  return '模型未返回响应'
}
