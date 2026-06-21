import OpenAI from 'openai'
import { getProxyFetchOptions } from 'src/utils/proxy.js'

/**
 * 环境变量：
 *
 * GROK_API_KEY（或 XAI_API_KEY）：必填。xAI Grok endpoint 的 API key。
 * GROK_BASE_URL：可选。默认为 https://api.x.ai/v1。
 */

const DEFAULT_BASE_URL = 'https://api.x.ai/v1'

let cachedClient: OpenAI | null = null

export function getGrokClient(options?: {
  maxRetries?: number
  fetchOverride?: typeof fetch
  source?: string
}): OpenAI {
  if (cachedClient) return cachedClient

  const apiKey = process.env.GROK_API_KEY || process.env.XAI_API_KEY || ''
  const baseURL = process.env.GROK_BASE_URL || DEFAULT_BASE_URL

  const client = new OpenAI({
    apiKey,
    baseURL,
    maxRetries: options?.maxRetries ?? 0,
    timeout: parseInt(process.env.API_TIMEOUT_MS || String(600 * 1000), 10),
    dangerouslyAllowBrowser: true,
    fetchOptions: getProxyFetchOptions({ forAnthropicAPI: false }),
    ...(options?.fetchOverride && { fetch: options.fetchOverride }),
  })

  if (!options?.fetchOverride) {
    cachedClient = client
  }

  return client
}

export function clearGrokClientCache(): void {
  cachedClient = null
}
