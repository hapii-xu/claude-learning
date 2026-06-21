import OpenAI from 'openai'
import { openaiAdapter } from 'src/services/providerUsage/adapters/openai.js'
import { updateProviderBuckets } from 'src/services/providerUsage/store.js'
import { getProxyFetchOptions } from 'src/utils/proxy.js'

/**
 * 环境变量：
 *
 * OPENAI_API_KEY：必填。OpenAI 兼容 endpoint 的 API key。
 * OPENAI_BASE_URL：推荐。endpoint 的 base URL（例如 http://localhost:11434/v1）。
 * OPENAI_ORG_ID：可选。Organization ID。
 * OPENAI_PROJECT_ID：可选。Project ID。
 */

let cachedClient: OpenAI | null = null

/**
 * 包装 fetch，使每个响应的 rate-limit header 都被送入 provider usage store。
 * 解析错误绝不能打断请求。
 *
 * 强转为 `typeof fetch` 是安全的：OpenAI SDK 只会以函数形式调用，
 * 不会调用 Bun/Node 的 `fetch` 类型所声明的静态 `preconnect` 方法。
 */
function wrapFetchForUsage(base: typeof fetch): typeof fetch {
  const wrapped = async (
    ...args: Parameters<typeof fetch>
  ): Promise<Response> => {
    const res = await base(...args)
    try {
      updateProviderBuckets('openai', openaiAdapter.parseHeaders(res.headers))
    } catch {
      // 忽略 —— 用量跟踪不能影响请求路径。
    }
    return res
  }
  return wrapped as unknown as typeof fetch
}

export function getOpenAIClient(options?: {
  maxRetries?: number
  fetchOverride?: typeof fetch
  source?: string
}): OpenAI {
  if (cachedClient) return cachedClient

  const apiKey = process.env.OPENAI_API_KEY || ''
  const baseURL = process.env.OPENAI_BASE_URL

  const baseFetch = options?.fetchOverride ?? (globalThis.fetch as typeof fetch)
  const wrappedFetch = wrapFetchForUsage(baseFetch)

  const client = new OpenAI({
    apiKey,
    ...(baseURL && { baseURL }),
    maxRetries: options?.maxRetries ?? 0,
    timeout: parseInt(process.env.API_TIMEOUT_MS || String(600 * 1000), 10),
    dangerouslyAllowBrowser: true,
    ...(process.env.OPENAI_ORG_ID && {
      organization: process.env.OPENAI_ORG_ID,
    }),
    ...(process.env.OPENAI_PROJECT_ID && {
      project: process.env.OPENAI_PROJECT_ID,
    }),
    fetchOptions: getProxyFetchOptions({ forAnthropicAPI: false }),
    fetch: wrappedFetch,
  })

  if (!options?.fetchOverride) {
    cachedClient = client
  }

  return client
}

/** 清空缓存的 client（在环境变量变化时有用）。 */
export function clearOpenAIClientCache(): void {
  cachedClient = null
}
