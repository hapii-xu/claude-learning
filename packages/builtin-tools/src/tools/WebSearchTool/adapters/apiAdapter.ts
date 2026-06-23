/**
 * 基于 API 的搜索适配器 — 通过辅助 API 调用委托给 Anthropic 服务端的
 * web_search_20250305 工具。
 */

import type {
  BetaContentBlock,
  BetaWebSearchTool20250305,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import { queryModelWithStreaming } from 'src/services/api/claude.js'
import {
  createTrace,
  endTrace,
  isLangfuseEnabled,
} from 'src/services/langfuse/index.js'
import { getSessionId } from 'src/bootstrap/state.js'
import { getAPIProvider } from 'src/utils/model/providers.js'
import { createUserMessage } from 'src/utils/messages.js'
import { getMainLoopModel, getSmallFastModel } from 'src/utils/model/model.js'
import { jsonParse } from 'src/utils/slowOperations.js'
import { asSystemPrompt } from 'src/utils/systemPromptType.js'
import type { SearchResult, SearchOptions, WebSearchAdapter } from './types.js'

function makeToolSchema(input: {
  allowedDomains?: string[]
  blockedDomains?: string[]
}): BetaWebSearchTool20250305 {
  return {
    type: 'web_search_20250305',
    name: 'web_search',
    allowed_domains: input.allowedDomains,
    blocked_domains: input.blockedDomains,
    max_uses: 8,
  }
}

export class ApiSearchAdapter implements WebSearchAdapter {
  async search(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const { signal, onProgress, allowedDomains, blockedDomains } = options

    const userMessage = createUserMessage({
      content: '为以下查询执行网络搜索：' + query,
    })
    const toolSchema = makeToolSchema({ allowedDomains, blockedDomains })

    const useHaiku = getFeatureValue_CACHED_MAY_BE_STALE(
      'tengu_plum_vx3',
      false,
    )
    const model = useHaiku ? getSmallFastModel() : getMainLoopModel()
    const langfuseTrace = isLangfuseEnabled()
      ? createTrace({
          sessionId: getSessionId(),
          model,
          provider: getAPIProvider(),
          name: 'web-search-tool',
        })
      : null

    const queryStream = queryModelWithStreaming({
      messages: [userMessage],
      systemPrompt: asSystemPrompt(['你是一个用于执行网络搜索工具调用的助手']),
      thinkingConfig: useHaiku
        ? { type: 'disabled' as const }
        : { type: 'enabled' as const, budgetTokens: 10000 },
      tools: [],
      signal: signal ?? new AbortController().signal,
      options: {
        getToolPermissionContext: async () => ({
          mode: 'default' as const,
          additionalWorkingDirectories: new Map(),
          alwaysAllowRules: {},
          alwaysDenyRules: {},
          alwaysAskRules: {},
          isBypassPermissionsModeAvailable: false,
        }),
        model,
        toolChoice: useHaiku
          ? { type: 'tool' as const, name: 'web_search' }
          : undefined,
        isNonInteractiveSession: false,
        hasAppendSystemPrompt: false,
        extraToolSchemas: [toolSchema],
        querySource: 'web_search_tool' as const,
        agents: [],
        mcpTools: [],
        agentId: undefined,
        effortValue: undefined,
        langfuseTrace,
      },
    })

    const allContentBlocks: BetaContentBlock[] = []
    let currentToolUseId: string | null = null
    let currentToolUseJson = ''
    const toolUseQueries = new Map<string, string>()
    let progressCounter = 0

    for await (const event of queryStream) {
      if (event.type === 'assistant') {
        const msg = event as { message: { content: BetaContentBlock[] } }
        allContentBlocks.push(...msg.message.content)
        continue
      }

      if (event.type === 'stream_event') {
        const streamEvt = event as {
          event?: {
            type: string
            content_block?: {
              type: string
              id?: string
              tool_use_id?: string
              content?: unknown
              [key: string]: unknown
            }
            delta?: {
              type: string
              partial_json?: string
              [key: string]: unknown
            }
            [key: string]: unknown
          }
        }

        if (streamEvt.event?.type === 'content_block_start') {
          const contentBlock = streamEvt.event.content_block
          if (contentBlock && contentBlock.type === 'server_tool_use') {
            currentToolUseId = contentBlock.id as string
            currentToolUseJson = ''
            continue
          }
        }

        if (
          currentToolUseId &&
          streamEvt.event?.type === 'content_block_delta'
        ) {
          const delta = streamEvt.event.delta
          if (delta?.type === 'input_json_delta' && delta.partial_json) {
            currentToolUseJson += delta.partial_json
            try {
              const queryMatch = currentToolUseJson.match(
                /"query"\s*:\s*"((?:[^"\\]|\\.)*)"/,
              )
              if (queryMatch && queryMatch[1]) {
                const parsedQuery = jsonParse('"' + queryMatch[1] + '"')
                if (
                  !toolUseQueries.has(currentToolUseId) ||
                  toolUseQueries.get(currentToolUseId) !== parsedQuery
                ) {
                  toolUseQueries.set(currentToolUseId, parsedQuery)
                  progressCounter++
                  onProgress?.({
                    type: 'query_update',
                    query: parsedQuery,
                  })
                }
              }
            } catch {
              // 忽略部分 JSON 的解析错误
            }
          }
        }

        if (streamEvt.event?.type === 'content_block_start') {
          const contentBlock = streamEvt.event.content_block
          if (contentBlock && contentBlock.type === 'web_search_tool_result') {
            const toolUseId = contentBlock.tool_use_id as string
            const actualQuery = toolUseQueries.get(toolUseId) || query
            const content = contentBlock.content
            progressCounter++
            onProgress?.({
              type: 'search_results_received',
              resultCount: Array.isArray(content) ? content.length : 0,
              query: actualQuery,
            })
          }
        }
      }
    }

    endTrace(langfuseTrace)

    // 从内容块中提取 SearchResult[]
    return extractSearchResults(allContentBlocks)
  }
}

function extractSearchResults(blocks: BetaContentBlock[]): SearchResult[] {
  const results: SearchResult[] = []

  for (const block of blocks) {
    if (
      block.type === 'web_search_tool_result' &&
      Array.isArray(block.content)
    ) {
      for (const r of block.content as Array<{
        title: string
        url: string
        page_age?: string
        type?: string
      }>) {
        results.push({
          title: r.title,
          url: r.url,
        })
      }
    }
  }

  return results
}
