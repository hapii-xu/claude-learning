import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import memoize from 'lodash-es/memoize.js'
import { z } from 'zod/v4'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import {
  buildTool,
  findToolByName,
  type Tool,
  type ToolDef,
  type Tools,
} from 'src/Tool.js'
import { logForDebugging } from 'src/utils/debug.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { escapeRegExp } from 'src/utils/stringUtils.js'
import { isSearchExtraToolsEnabledOptimistic } from 'src/utils/searchExtraTools.js'
import {
  getPrompt,
  isDeferredTool,
  SEARCH_EXTRA_TOOLS_TOOL_NAME,
} from './prompt.js'
import {
  getToolIndex,
  searchTools,
} from 'src/services/searchExtraTools/toolIndex.js'
import type { SearchExtraToolsResult } from 'src/services/searchExtraTools/toolIndex.js'

const KEYWORD_WEIGHT = Number(
  process.env.SEARCH_EXTRA_TOOLS_WEIGHT_KEYWORD ?? '0.4',
)
const TFIDF_WEIGHT = Number(
  process.env.SEARCH_EXTRA_TOOLS_WEIGHT_TFIDF ?? '0.6',
)

export const inputSchema = lazySchema(() =>
  z.object({
    query: z
      .string()
      .describe(
        '用于查找延迟工具的查询。使用 "select:<tool_name>" 可直接选择，或使用关键词进行搜索。',
      ),
    max_results: z
      .number()
      .optional()
      .default(5)
      .describe('返回结果的最大数量（默认：5）'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export const outputSchema = lazySchema(() =>
  z.object({
    matches: z.array(z.string()),
    query: z.string(),
    total_deferred_tools: z.number(),
    pending_mcp_servers: z.array(z.string()).optional(),
    /** 已加载（核心工具）且可以直接调用的匹配项。 */
    already_loaded: z.array(z.string()).optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

// 追踪延迟工具名以检测缓存何时应被清除
let cachedDeferredToolNames: string | null = null

/**
 * 获取表示当前延迟工具集合的缓存键。
 */
function getDeferredToolsCacheKey(deferredTools: Tools): string {
  return deferredTools
    .map(t => t.name)
    .sort()
    .join(',')
}

/**
 * 获取工具描述，按工具名做 memoize 缓存。
 * 用于关键词搜索打分。
 */
const getToolDescriptionMemoized = memoize(
  async (toolName: string, tools: Tools): Promise<string> => {
    const tool = findToolByName(tools, toolName)
    if (!tool) {
      return ''
    }
    return tool.prompt({
      getToolPermissionContext: async () => ({
        mode: 'default' as const,
        additionalWorkingDirectories: new Map(),
        alwaysAllowRules: {},
        alwaysDenyRules: {},
        alwaysAskRules: {},
        isBypassPermissionsModeAvailable: false,
      }),
      tools,
      agents: [],
    })
  },
  (toolName: string) => toolName,
)

/**
 * 如果延迟工具集合已变化，则使描述缓存失效。
 */
function maybeInvalidateCache(deferredTools: Tools): void {
  const currentKey = getDeferredToolsCacheKey(deferredTools)
  if (cachedDeferredToolNames !== currentKey) {
    logForDebugging(
      `SearchExtraToolsTool: cache invalidated - deferred tools changed`,
    )
    getToolDescriptionMemoized.cache.clear?.()
    cachedDeferredToolNames = currentKey
  }
}

export function clearSearchExtraToolsDescriptionCache(): void {
  getToolDescriptionMemoized.cache.clear?.()
  cachedDeferredToolNames = null
}

/**
 * 构建搜索结果的输出结构。
 */
function buildSearchResult(
  matches: string[],
  query: string,
  totalDeferredTools: number,
  pendingMcpServers?: string[],
  alreadyLoaded?: string[],
): { data: Output } {
  return {
    data: {
      matches,
      query,
      total_deferred_tools: totalDeferredTools,
      ...(pendingMcpServers && pendingMcpServers.length > 0
        ? { pending_mcp_servers: pendingMcpServers }
        : {}),
      ...(alreadyLoaded && alreadyLoaded.length > 0
        ? { already_loaded: alreadyLoaded }
        : {}),
    },
  }
}

/**
 * 将工具名解析为可搜索的部分。
 * 同时处理 MCP 工具（mcp__server__action）和普通工具（CamelCase）。
 */
function parseToolName(name: string): {
  parts: string[]
  full: string
  isMcp: boolean
} {
  // 检查是否为 MCP tool
  if (name.startsWith('mcp__')) {
    const withoutPrefix = name.replace(/^mcp__/, '').toLowerCase()
    const parts = withoutPrefix.split('__').flatMap(p => p.split('_'))
    return {
      parts: parts.filter(Boolean),
      full: withoutPrefix.replace(/__/g, ' ').replace(/_/g, ' '),
      isMcp: true,
    }
  }

  // 普通 tool —— 按 CamelCase 与下划线拆分
  const parts = name
    .replace(/([a-z])([A-Z])/g, '$1 $2') // CamelCase 转为空格
    .replace(/_/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)

  return {
    parts,
    full: parts.join(' '),
    isMcp: false,
  }
}

/**
 * 为所有搜索术语预编译词边界正则。
 * 每次搜索只调用一次，而不是 tools×terms×2 次。
 */
function compileTermPatterns(terms: string[]): Map<string, RegExp> {
  const patterns = new Map<string, RegExp>()
  for (const term of terms) {
    if (!patterns.has(term)) {
      patterns.set(term, new RegExp(`\\b${escapeRegExp(term)}\\b`))
    }
  }
  return patterns
}

/**
 * 基于关键词搜索工具名与描述。
 * 同时处理 MCP 工具（mcp__server__action）和普通工具（CamelCase）。
 *
 * 模型通常的查询方式：
 * - 已知集成时使用服务器名（例如："slack"、"github"）
 * - 寻找功能时使用动词（例如："read"、"list"、"create"）
 * - 工具特定的术语（例如："notebook"、"shell"、"kill"）
 */
async function searchToolsWithKeywords(
  query: string,
  deferredTools: Tools,
  tools: Tools,
  maxResults: number,
): Promise<string[]> {
  const queryLower = query.toLowerCase().trim()

  // 快速路径：若查询精确匹配工具名，直接返回。
  // 处理模型使用裸工具名而非 select: 前缀的情况（见于
  // 子代理/压缩后）。先查延迟工具，再回退到完整工具集 ——
  // 选择已加载的工具是无害的 no-op，让模型无需重试即可继续。
  const exactMatch =
    deferredTools.find(t => t.name.toLowerCase() === queryLower) ??
    tools.find(t => t.name.toLowerCase() === queryLower)
  if (exactMatch) {
    return [exactMatch.name]
  }

  // 若查询看起来像 MCP tool 前缀（mcp__server），查找匹配的工具。
  // 处理模型使用 mcp__ 前缀按服务器名搜索的情况。
  if (queryLower.startsWith('mcp__') && queryLower.length > 5) {
    const prefixMatches = deferredTools
      .filter(t => t.name.toLowerCase().startsWith(queryLower))
      .slice(0, maxResults)
      .map(t => t.name)
    if (prefixMatches.length > 0) {
      return prefixMatches
    }
  }

  const queryTerms = queryLower.split(/\s+/).filter(term => term.length > 0)

  // 分为必需（+前缀）与可选术语
  const requiredTerms: string[] = []
  const optionalTerms: string[] = []
  for (const term of queryTerms) {
    if (term.startsWith('+') && term.length > 1) {
      requiredTerms.push(term.slice(1))
    } else {
      optionalTerms.push(term)
    }
  }

  const allScoringTerms =
    requiredTerms.length > 0 ? [...requiredTerms, ...optionalTerms] : queryTerms
  const termPatterns = compileTermPatterns(allScoringTerms)

  // 预先过滤出名称或描述中包含所有必需术语的工具
  let candidateTools = deferredTools
  if (requiredTerms.length > 0) {
    const matches = await Promise.all(
      deferredTools.map(async tool => {
        const parsed = parseToolName(tool.name)
        const description = await getToolDescriptionMemoized(tool.name, tools)
        const descNormalized = description.toLowerCase()
        const hintNormalized = tool.searchHint?.toLowerCase() ?? ''
        const matchesAll = requiredTerms.every(term => {
          const pattern = termPatterns.get(term)!
          return (
            parsed.parts.includes(term) ||
            parsed.parts.some(part => part.includes(term)) ||
            pattern.test(descNormalized) ||
            (hintNormalized && pattern.test(hintNormalized))
          )
        })
        return matchesAll ? tool : null
      }),
    )
    candidateTools = matches.filter((t): t is Tool => t !== null)
  }

  const scored = await Promise.all(
    candidateTools.map(async tool => {
      const parsed = parseToolName(tool.name)
      const description = await getToolDescriptionMemoized(tool.name, tools)
      const descNormalized = description.toLowerCase()
      const hintNormalized = tool.searchHint?.toLowerCase() ?? ''

      let score = 0
      for (const term of allScoringTerms) {
        const pattern = termPatterns.get(term)!

        // 精确部分匹配（MCP 服务器名、工具名部分的高权重）
        if (parsed.parts.includes(term)) {
          score += parsed.isMcp ? 12 : 10
        } else if (parsed.parts.some(part => part.includes(term))) {
          score += parsed.isMcp ? 6 : 5
        }

        // 全名回退（用于边缘情况）
        if (parsed.full.includes(term) && score === 0) {
          score += 3
        }

        // searchHint 匹配 —— 精选的能力短语，信号强度高于 prompt
        if (hintNormalized && pattern.test(hintNormalized)) {
          score += 4
        }

        // 描述匹配 —— 使用词边界避免误报
        if (pattern.test(descNormalized)) {
          score += 2
        }
      }

      return { name: tool.name, score }
    }),
  )

  return scored
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(item => item.name)
}

export const SearchExtraToolsTool = buildTool({
  isEnabled() {
    return isSearchExtraToolsEnabledOptimistic()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  name: SEARCH_EXTRA_TOOLS_TOOL_NAME,
  maxResultSizeChars: 100_000,
  async description() {
    return getPrompt()
  },
  async prompt() {
    return getPrompt()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  async call(input, { options: { tools }, getAppState }) {
    const { query, max_results = 5 } = input

    const deferredTools = tools.filter(isDeferredTool)
    maybeInvalidateCache(deferredTools)

    // 检查仍在连接中的 MCP 服务器
    function getPendingServerNames(): string[] | undefined {
      const appState = getAppState()
      const pending = appState.mcp.clients.filter(c => c.type === 'pending')
      return pending.length > 0 ? pending.map(s => s.name) : undefined
    }

    // 记录搜索结果的辅助函数
    function logSearchOutcome(
      matches: string[],
      queryType: 'select' | 'keyword',
    ): void {
      logEvent('tengu_search_extra_tools_outcome', {
        query:
          query as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        queryType:
          queryType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        matchCount: matches.length,
        totalDeferredTools: deferredTools.length,
        maxResults: max_results,
        hasMatches: matches.length > 0,
      })
    }

    // 检查 select: 前缀 —— 直接工具选择。
    // 支持逗号分隔的多选：`select:A,B,C`。
    // 若名称不在延迟集合中但在完整工具集中，仍返回它 ——
    // 该工具已加载，"选择"它是无害的 no-op，让模型无需重试即可继续。
    const selectMatch = query.match(/^select:(.+)$/i)
    if (selectMatch) {
      const requested = selectMatch[1]!
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)

      const found: string[] = []
      const alreadyLoaded: string[] = []
      const missing: string[] = []
      for (const toolName of requested) {
        const deferredMatch = findToolByName(deferredTools, toolName)
        const fullMatch = deferredMatch ?? findToolByName(tools, toolName)
        if (fullMatch) {
          if (!found.includes(fullMatch.name)) {
            found.push(fullMatch.name)
            if (!deferredMatch) {
              alreadyLoaded.push(fullMatch.name)
            }
          }
        } else {
          missing.push(toolName)
        }
      }

      if (found.length === 0) {
        logForDebugging(
          `SearchExtraToolsTool: select failed — none found: ${missing.join(', ')}`,
        )
        logSearchOutcome([], 'select')
        const pendingServers = getPendingServerNames()
        return buildSearchResult(
          [],
          query,
          deferredTools.length,
          pendingServers,
        )
      }

      if (missing.length > 0) {
        logForDebugging(
          `SearchExtraToolsTool: partial select — found: ${found.join(', ')}, missing: ${missing.join(', ')}`,
        )
      } else {
        logForDebugging(`SearchExtraToolsTool: selected ${found.join(', ')}`)
      }
      logSearchOutcome(found, 'select')
      return buildSearchResult(
        found,
        query,
        deferredTools.length,
        undefined,
        alreadyLoaded.length > 0 ? alreadyLoaded : undefined,
      )
    }

    // 检查 discover: 前缀 —— 纯发现搜索。
    // 返回工具信息（名称 + 描述 + schema）的文本，
    // 不会触发延迟工具加载。
    const discoverMatch = query.match(/^discover:(.+)$/i)
    if (discoverMatch) {
      const discoverQuery = discoverMatch[1]!.trim()
      const index = await getToolIndex(deferredTools)
      const tfIdfResults = searchTools(discoverQuery, index, max_results)
      const textResults = tfIdfResults.map(r => {
        let line = `**${r.name}** (score: ${r.score.toFixed(2)})\n${r.description}`
        if (r.inputSchema) {
          line += `\nSchema: ${JSON.stringify(r.inputSchema)}`
        }
        return line
      })
      const text =
        textResults.length > 0
          ? `找到 ${textResults.length} 个工具：\n${textResults.join('\n\n')}`
          : '未找到匹配的延迟工具'
      logSearchOutcome(
        tfIdfResults.map(r => r.name),
        'keyword',
      )
      return buildSearchResult(
        tfIdfResults.map(r => r.name),
        query,
        deferredTools.length,
      )
    }

    // 并行执行关键词搜索 + TF-IDF 搜索
    const deferredToolNames = new Set(deferredTools.map(t => t.name))
    const [keywordMatches, index] = await Promise.all([
      searchToolsWithKeywords(query, deferredTools, tools, max_results),
      getToolIndex(deferredTools),
    ])
    const tfIdfResults = searchTools(query, index, max_results)

    // 合并结果：关键词得分 * 0.4 + TF-IDF 得分 * 0.6
    const mergedScores = new Map<string, number>()
    // 添加关键词结果（得分与排名成反比）
    keywordMatches.forEach((name, rank) => {
      const score = (keywordMatches.length - rank) / keywordMatches.length
      mergedScores.set(
        name,
        (mergedScores.get(name) ?? 0) + score * KEYWORD_WEIGHT,
      )
    })
    // 添加 TF-IDF 结果
    tfIdfResults.forEach(result => {
      mergedScores.set(
        result.name,
        (mergedScores.get(result.name) ?? 0) + result.score * TFIDF_WEIGHT,
      )
    })

    // 按合并得分排序，取前 N 个
    const matches = [...mergedScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, max_results)
      .map(([name]) => name)

    // 识别匹配中已加载的核心工具
    const alreadyLoaded = matches.filter(name => !deferredToolNames.has(name))

    logForDebugging(
      `SearchExtraToolsTool: keyword search for "${query}", found ${matches.length} matches`,
    )

    logSearchOutcome(matches, 'keyword')

    // 搜索无匹配结果时包含待连接服务器信息
    if (matches.length === 0) {
      const pendingServers = getPendingServerNames()
      return buildSearchResult(
        matches,
        query,
        deferredTools.length,
        pendingServers,
      )
    }

    return buildSearchResult(
      matches,
      query,
      deferredTools.length,
      undefined,
      alreadyLoaded.length > 0 ? alreadyLoaded : undefined,
    )
  },
  renderToolUseMessage(input: Partial<{ query: string; max_results: number }>) {
    if (!input.query) return null
    return `"${input.query}"`
  },
  userFacingName() {
    return 'SearchExtraTools'
  },
  /**
   * 返回一个 tool_result，其文本输出引导模型使用 ExecuteExtraTool。
   * 不再使用 tool_reference 块 —— 对所有 provider 统一使用自建的工具搜索。
   */
  mapToolResultToToolResultBlockParam(
    content: Output,
    toolUseID: string,
    _context?: { mainLoopModel?: string },
  ): ToolResultBlockParam {
    if (content.matches.length === 0) {
      let text = '未找到匹配的延迟工具'
      if (
        content.pending_mcp_servers &&
        content.pending_mcp_servers.length > 0
      ) {
        text += `。部分 MCP 服务器仍在连接中：${content.pending_mcp_servers.join(', ')}。它们的工具很快就会可用 —— 请稍后再次搜索。`
      }
      return {
        type: 'tool_result',
        tool_use_id: toolUseID,
        content: text,
      }
    }

    // 将已加载的核心工具与真正延迟的工具分开
    const alreadyLoadedNames = content.already_loaded ?? []
    const deferredNames = content.matches.filter(
      n => !alreadyLoadedNames.includes(n),
    )

    // 如果所有结果都是已加载的核心工具，则无需发现
    if (deferredNames.length === 0 && alreadyLoadedNames.length > 0) {
      return {
        type: 'tool_result',
        tool_use_id: toolUseID,
        content: `未找到延迟工具。${alreadyLoadedNames.join(', ')} 已作为核心工具加载 —— 请直接调用，不要通过 ExecuteExtraTool 搜索或包装。SearchExtraTools 仅用于发现尚未出现在你工具列表中的工具。`,
      }
    }

    const parts: string[] = []

    // 核心工具：清晰的 "直接调用" 消息，不含 ExecuteExtraTool 提示
    if (alreadyLoadedNames.length > 0) {
      parts.push(
        `已作为核心工具加载：${alreadyLoadedNames.join(', ')}。请使用常规工具接口直接调用 —— 不要对它们使用 ExecuteExtraTool。`,
      )
    }

    // 延迟工具：引导使用 ExecuteExtraTool
    if (deferredNames.length > 0) {
      parts.push(
        `找到 ${deferredNames.length} 个延迟工具：${deferredNames.join(', ')}。` +
          `\n请使用 ExecuteExtraTool（{"tool_name": "<name>", "params": {...}}）来调用这些延迟工具中的任意一个。`,
      )
    }

    const text = parts.join('\n')

    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: text,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
