/**
 * 基于 Exa AI 的搜索适配器 — 使用 MCP 协议调用 Exa 的网络搜索 API。
 *
 * 移植自 kilocode 经过生产验证的实现（mcp-exa.ts + websearch.ts）。
 * 相较上一版本的主要改进：
 *   - 从 options 透传 numResults/livecrawl/type/contextMaxCharacters
 *   - 更简洁的 SSE 解析，与 kilocode 的做法一致
 *   - 从 Exa 响应中正确提取内容片段
 */

import axios from 'axios'
import { AbortError } from 'src/utils/errors.js'
import { getSettings_DEPRECATED } from 'src/utils/settings/settings.js'
import type { SearchResult, SearchOptions, WebSearchAdapter } from './types.js'

const DEFAULT_EXA_MCP_URL = 'https://mcp.exa.ai/mcp'
const FETCH_TIMEOUT_MS = 25_000

export class ExaSearchAdapter implements WebSearchAdapter {
  async search(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const { signal, onProgress, allowedDomains, blockedDomains } = options

    if (signal?.aborted) {
      throw new AbortError()
    }

    onProgress?.({ type: 'query_update', query })

    const abortController = new AbortController()
    if (signal) {
      signal.addEventListener('abort', () => abortController.abort(), {
        once: true,
      })
    }

    // 使用 options 派生搜索参数 — 与 kilocode websearch.ts 的默认值一致
    const numResults = options.numResults ?? 8
    const livecrawl = options.livecrawl ?? 'fallback'
    const searchType = options.searchType ?? 'auto'
    const contextMaxCharacters = options.contextMaxCharacters ?? 10000

    // 读取自定义端点 / API key 的设置
    const settings = getSettings_DEPRECATED() as Record<string, unknown> & {
      exaEndpointUrl?: string
      exaApiKey?: string
    }
    const exaUrl = settings.exaEndpointUrl || DEFAULT_EXA_MCP_URL
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    }
    if (settings.exaApiKey) {
      headers['Authorization'] = `Bearer ${settings.exaApiKey}`
    }

    let responseText: string
    try {
      const response = await axios.post(
        exaUrl,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'web_search_exa',
            arguments: {
              query,
              type: searchType,
              numResults,
              livecrawl,
              contextMaxCharacters,
            },
          },
        },
        {
          signal: abortController.signal,
          timeout: FETCH_TIMEOUT_MS,
          headers,
          responseType: 'text',
        },
      )
      responseText = response.data as string
    } catch (e) {
      if (axios.isCancel(e) || abortController.signal.aborted) {
        throw new AbortError()
      }
      throw e
    }

    if (abortController.signal.aborted) {
      throw new AbortError()
    }

    const searchText = this.parseSse(responseText)

    if (abortController.signal.aborted) {
      throw new AbortError()
    }

    // 从文本响应中解析 Exa 结果
    const results = this.parseResults(searchText)

    // 客户端域名过滤
    const filteredResults = results.filter(r => {
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
      resultCount: filteredResults.length,
      query,
    })

    return filteredResults
  }

  private parseSse(body: string): string | undefined {
    // SSE 格式：以 "data: " 开头、包含 JSON 的行
    // 与 kilocode mcp-exa.ts 的 parseSse 实现保持一致
    for (const line of body.split('\n')) {
      if (!line.startsWith('data: ')) continue
      const data = line.substring(6).trim()
      if (!data || data === '[DONE]' || data === 'null') continue

      try {
        const parsed = JSON.parse(data)
        const content = parsed?.result?.content
        if (Array.isArray(content) && content[0]?.text) {
          return content[0].text
        }
      } catch {
        // 继续处理下一行
      }
    }

    // 后备：尝试作为直接的 JSON 响应解析（非 SSE）
    try {
      const parsed = JSON.parse(body)
      const content = parsed?.result?.content
      if (Array.isArray(content) && content[0]?.text) {
        return content[0].text
      }
    } catch {
      // 不是 JSON
    }

    return undefined
  }

  private parseResults(text: string | undefined): SearchResult[] {
    if (!text) return []

    const results: SearchResult[] = []

    // Exa 返回结构化文本，包含 "Title:"、"URL:" 和 "Content:" 字段，
    // 条目之间以 "---" 分隔
    const blocks = text.split(/\n---\n/g)

    for (const block of blocks) {
      const titleMatch = block.match(/^Title:\s*(.+)$/m)
      const urlMatch = block.match(/^URL:\s*(https?:\/\/[^\s]+)$/m)
      const contentMatch = block.match(
        /^Content:\s*([\s\S]+?)(?=\n(?:Title:|URL:|---)|$)/m,
      )

      if (urlMatch) {
        results.push({
          title: titleMatch?.[1]?.trim() ?? urlMatch[1],
          url: urlMatch[1].trim(),
          snippet: contentMatch?.[1]?.trim().slice(0, 300),
        })
      }
    }

    // 后备：markdown 链接
    if (results.length === 0) {
      const markdownLinkRegex = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g
      let match: RegExpExecArray | null
      while ((match = markdownLinkRegex.exec(text)) !== null) {
        results.push({
          title: match[1].trim(),
          url: match[2].trim(),
        })
      }
    }

    // 后备：纯 URL
    if (results.length === 0) {
      const urlRegex = /^https?:\/\/[^\s<>"\]]+/gm
      let match: RegExpExecArray | null
      while ((match = urlRegex.exec(text)) !== null) {
        results.push({
          title: match[0],
          url: match[0],
        })
      }
    }

    return results
  }
}
