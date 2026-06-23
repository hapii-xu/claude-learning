/**
 * 基于 Bing 的搜索适配器 — 抓取 Bing 搜索页面，并通过对原始 HTML
 * 的正则模式匹配来提取搜索结果。
 */

import axios from 'axios'
import he from 'he'
import { AbortError } from 'src/utils/errors.js'
import type { SearchResult, SearchOptions, WebSearchAdapter } from './types.js'

const FETCH_TIMEOUT_MS = 30_000

/**
 * 类浏览器请求头，用于规避 Bing 的反爬虫 JS 渲染响应。
 * 这些请求头模拟 macOS 上的 Microsoft Edge，以获取完整的 HTML 搜索结果。
 */
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  'Sec-Ch-Ua':
    '"Microsoft Edge";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
} as const

export class BingSearchAdapter implements WebSearchAdapter {
  async search(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const { signal, onProgress, allowedDomains, blockedDomains } = options

    if (signal?.aborted) {
      throw new AbortError()
    }

    onProgress?.({ type: 'query_update', query })

    const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setmkt=en-US`

    const abortController = new AbortController()
    if (signal) {
      signal.addEventListener('abort', () => abortController.abort(), {
        once: true,
      })
    }

    let html: string
    try {
      const response = await axios.get(url, {
        signal: abortController.signal,
        timeout: FETCH_TIMEOUT_MS,
        responseType: 'text',
        headers: BROWSER_HEADERS,
      })
      html = response.data
    } catch (e) {
      if (axios.isCancel(e) || abortController.signal.aborted) {
        throw new AbortError()
      }
      throw e
    }

    if (abortController.signal.aborted) {
      throw new AbortError()
    }

    const rawResults = extractBingResults(html)

    // 客户端域名过滤
    const results = rawResults.filter(r => {
      if (!r.url) return false
      try {
        const hostname = new URL(r.url).hostname
        if (
          allowedDomains?.length &&
          !allowedDomains.some(
            d => hostname === d || hostname.endsWith('.' + d),
          )
        ) {
          return false
        }
        if (
          blockedDomains?.length &&
          blockedDomains.some(d => hostname === d || hostname.endsWith('.' + d))
        ) {
          return false
        }
      } catch {
        return false
      }
      return true
    })

    onProgress?.({
      type: 'search_results_received',
      resultCount: results.length,
      query,
    })

    return results
  }
}

/**
 * 从 Bing HTML 中提取自然搜索结果。
 * Bing 的结果位于 <ol id="b_results"> 中的 <li class="b_algo"> 块内。
 */
export function extractBingResults(html: string): SearchResult[] {
  const results: SearchResult[] = []

  const algoBlockRegex = /<li\s+class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi
  let blockMatch: RegExpExecArray | null

  while ((blockMatch = algoBlockRegex.exec(html)) !== null) {
    const block = blockMatch[1]

    // 从 <h2><a href="...">...</a></h2> 中提取主要链接
    const h2LinkRegex =
      /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i
    const linkMatch = h2LinkRegex.exec(block)
    if (!linkMatch) continue

    const rawUrl = decodeHtmlEntities(linkMatch[1])
    const titleHtml = linkMatch[2]

    // 解析 Bing 重定向 URL（bing.com/ck/a?...&u=a1aHR0cHM6Ly9...）
    // 或跳过 Bing 内部/相对链接
    const url = resolveBingUrl(rawUrl)
    if (!url) continue

    const title = decodeHtmlEntities(titleHtml.replace(/<[^>]+>/g, '').trim())

    // 提取摘要：依次尝试 b_lineclamp → b_caption <p> → b_caption 后备
    const snippet = extractSnippet(block)

    results.push({ title, url, snippet })
  }

  return results
}

function extractSnippet(block: string): string | undefined {
  // 1. 尝试 <p class="b_lineclamp...">
  const lineclampRegex = /<p[^>]*class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i
  let match = lineclampRegex.exec(block)
  if (match) {
    return decodeHtmlEntities(match[1].replace(/<[^>]+>/g, '').trim())
  }

  // 2. 尝试 b_caption 内的 <p>
  const captionPRegex =
    /<div[^>]*class="b_caption[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i
  match = captionPRegex.exec(block)
  if (match) {
    return decodeHtmlEntities(match[1].replace(/<[^>]+>/g, '').trim())
  }

  // 3. 后备：b_caption <div> 内的任意文本
  const fallbackRegex =
    /<div[^>]*class="b_caption[^"]*"[^>]*>([\s\S]*?)<\/div>/i
  const fallbackMatch = fallbackRegex.exec(block)
  if (fallbackMatch) {
    const text = fallbackMatch[1].replace(/<[^>]+>/g, '').trim()
    if (text) return decodeHtmlEntities(text)
  }

  return undefined
}

export const decodeHtmlEntities = he.decode

/**
 * 将 Bing 重定向 URL 解析为实际的目标 URL。
 * Bing 使用形如 https://www.bing.com/ck/a?...&u=a1aHR0cHM6Ly9leGFtcGxlLmNvbQ... 的 URL，
 * 其中 `u` 查询参数是以 a1（https）或 a0（http）为前缀的 base64 编码 URL。
 * 对于应被跳过的 Bing 内部或相对链接，返回 `undefined`。
 */
export function resolveBingUrl(rawUrl: string): string | undefined {
  // 跳过相对/锚点链接
  if (rawUrl.startsWith('/') || rawUrl.startsWith('#')) return undefined

  // 尝试从 Bing 重定向 URL 中提取 `u` 参数
  const uMatch = rawUrl.match(/[?&]u=([a-zA-Z0-9+/_=-]+)/)
  if (uMatch) {
    const encoded = uMatch[1]
    if (encoded.length >= 3) {
      const prefix = encoded.slice(0, 2)
      const b64 = encoded.slice(2)
      try {
        // Base64url 解码（按需填充）
        const padded = b64.replace(/-/g, '+').replace(/_/g, '/')
        const decoded = Buffer.from(padded, 'base64').toString('utf-8')
        if (decoded.startsWith('http')) return decoded
      } catch {
        // 穿过 — 不是合法的 base64 重定向
      }
    }
  }

  // 直接的外部 URL（非 Bing 内部页面）
  if (!rawUrl.includes('bing.com')) return rawUrl

  return undefined
}
