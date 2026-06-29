/**
 * 工具搜索工具函数，用于动态发现延迟加载的工具。
 *
 * 启用后，延迟工具（所有非核心工具）将以
 * defer_loading: true 方式发送，并通过 SearchExtraToolsTool 发现，而非在启动时全量加载。
 * 核心工具定义在 CORE_TOOLS（src/constants/tools.ts）中。
 */

import memoize from 'lodash-es/memoize.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import type { Tool } from '../Tool.js'
import {
  type ToolPermissionContext,
  type Tools,
  toolMatchesName,
} from '../Tool.js'
import type { AgentDefinition } from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import {
  formatDeferredToolLine,
  isDeferredTool,
  SEARCH_EXTRA_TOOLS_TOOL_NAME,
} from '@claude-code-best/builtin-tools/tools/SearchExtraToolsTool/prompt.js'
import type { Message } from '../types/message.js'
import {
  countToolDefinitionTokens,
  TOOL_TOKEN_COUNT_OVERHEAD,
} from './analyzeContext.js'
import { count } from './array.js'
import { getMergedBetas } from './betas.js'
import { getContextWindowForModel } from './context.js'
import { logForDebugging } from './debug.js'
import { isEnvDefinedFalsy, isEnvTruthy } from './envUtils.js'
import { jsonStringify } from './slowOperations.js'
import { zodToJsonSchema } from './zodToJsonSchema.js'

/**
 * 自动启用工具搜索的上下文窗口百分比默认值。
 * 当 MCP 工具描述超过该百分比（以 token 计）时，启用工具搜索。
 * 可通过 ENABLE_SEARCH_EXTRA_TOOLS=auto:N（N 为 0-100）覆盖。
 */
const DEFAULT_AUTO_SEARCH_EXTRA_TOOLS_PERCENTAGE = 10 // 10%

/**
 * 解析 ENABLE_SEARCH_EXTRA_TOOLS 环境变量中的 auto:N 语法。
 * 返回限制在 0-100 之间的百分比，若非 auto:N 格式或非数字则返回 null。
 */
function parseAutoPercentage(value: string): number | null {
  if (!value.startsWith('auto:')) return null

  const percentStr = value.slice(5)
  const percent = parseInt(percentStr, 10)

  if (isNaN(percent)) {
    logForDebugging(
      `Invalid ENABLE_SEARCH_EXTRA_TOOLS value "${value}": expected auto:N where N is a number.`,
    )
    return null
  }

  // 限制在有效范围内
  return Math.max(0, Math.min(100, percent))
}

/**
 * 检查 ENABLE_SEARCH_EXTRA_TOOLS 是否设置为自动模式（auto 或 auto:N）。
 */
function isAutoSearchExtraToolsMode(value: string | undefined): boolean {
  if (!value) return false
  return value === 'auto' || value.startsWith('auto:')
}

/**
 * 从环境变量获取自动启用百分比，未设置则返回默认值。
 */
function getAutoSearchExtraToolsPercentage(): number {
  const value = process.env.ENABLE_SEARCH_EXTRA_TOOLS
  if (!value) return DEFAULT_AUTO_SEARCH_EXTRA_TOOLS_PERCENTAGE

  if (value === 'auto') return DEFAULT_AUTO_SEARCH_EXTRA_TOOLS_PERCENTAGE

  const parsed = parseAutoPercentage(value)
  if (parsed !== null) return parsed

  return DEFAULT_AUTO_SEARCH_EXTRA_TOOLS_PERCENTAGE
}

/**
 * MCP 工具定义（名称 + 描述 + 输入 schema）的每 token 近似字符数。
 * 在 token 计数 API 不可用时作为回退使用。
 */
const CHARS_PER_TOKEN = 2.5

/**
 * 获取指定模型自动启用工具搜索的 token 阈值。
 */
function getAutoSearchExtraToolsTokenThreshold(model: string): number {
  const betas = getMergedBetas(model)
  const contextWindow = getContextWindowForModel(model, betas)
  const percentage = getAutoSearchExtraToolsPercentage() / 100
  return Math.floor(contextWindow * percentage)
}

/**
 * 获取指定模型自动启用工具搜索的字符阈值。
 * 在 token 计数 API 不可用时作为回退使用。
 */
export function getAutoSearchExtraToolsCharThreshold(model: string): number {
  return Math.floor(
    getAutoSearchExtraToolsTokenThreshold(model) * CHARS_PER_TOKEN,
  )
}

/**
 * 通过 token 计数 API 获取所有延迟工具的总 token 数。
 * 以延迟工具名称为 key 进行 memoize 缓存——MCP 服务器连接/断开时缓存失效。
 * API 不可用时返回 null（调用方应回退至字符启发式方法）。
 */
const getDeferredToolTokenCount = memoize(
  async (
    tools: Tools,
    getToolPermissionContext: () => Promise<ToolPermissionContext>,
    agents: AgentDefinition[],
    model: string,
  ): Promise<number | null> => {
    const deferredTools = tools.filter(t => isDeferredTool(t))
    if (deferredTools.length === 0) return 0

    try {
      const total = await countToolDefinitionTokens(
        deferredTools,
        getToolPermissionContext,
        { activeAgents: agents, allAgents: agents },
        model,
      )
      if (total === 0) return null // API 不可用
      return Math.max(0, total - TOOL_TOKEN_COUNT_OVERHEAD)
    } catch {
      return null // 回退至字符启发式方法
    }
  },
  (tools: Tools) =>
    tools
      .filter(t => isDeferredTool(t))
      .map(t => t.name)
      .join(','),
)

/**
 * 工具搜索模式。决定延迟工具（所有非核心工具）的呈现方式：
 *   - 'tst'：工具搜索工具模式——延迟工具通过 SearchExtraToolsTool 发现（始终启用） ------  Tool Search Tool(工具搜索工具)
 *   - 'tst-auto'：自动模式——仅当工具超过阈值时才延迟加载
 *   - 'standard'：禁用工具搜索——所有工具直接内联暴露 ------ 完全关闭工具搜索。所有工具(核心 + 非核心 + MCP)全部以完整 schema 内联发给模型。没有 SearchExtraTools 那套东西,模型一开始就看到所有工具。
 */
export type SearchExtraToolsMode = 'tst' | 'tst-auto' | 'standard'

/**
 * 根据 ENABLE_SEARCH_EXTRA_TOOLS 确定工具搜索模式。
 *
 *   ENABLE_SEARCH_EXTRA_TOOLS    模式
 *   auto / auto:1-99      tst-auto
 *   true / auto:0         tst
 *   false / auto:100      standard  
 *   （未设置）             tst（默认：始终延迟非核心工具）
 * 
  ┌──────────┬────────────────────┬──────────────────────────────────────┬───────────────────────────────────────────────────────────┐
  │   模式   │        名称        │          非核心工具怎么处理          │                     触发它的环境变量                      │
  ├──────────┼────────────────────┼──────────────────────────────────────┼───────────────────────────────────────────────────────────┤
  │ tst      │ 工具搜索模式 (默认) │ 全部延迟,只发核心 + SearchExtraTools   │ true、auto:0、不设置                                      │
  ├──────────┼────────────────────┼──────────────────────────────────────┼───────────────────────────────────────────────────────────┤
  │ tst-auto │ 自动阈值模式        │ 按 token 量动态决定,超过阈值才延迟      │ auto、auto:1~`auto:99`                                    │
  ├──────────┼────────────────────┼──────────────────────────────────────┼───────────────────────────────────────────────────────────┤
  │ standard │ 标准模式           │ 全部内联, 禁用搜索, 工具全量发            │ false、auto:100、CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 │
  └──────────┴────────────────────┴──────────────────────────────────────┴───────────────────────────────────────────────────────────┘
 */
export function getSearchExtraToolsMode(): SearchExtraToolsMode {
  // CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS 仍作为工具搜索的全局开关，
  // 即使我们不再发送 beta 头部。
  // 设置该标志的用户明确选择退出工具搜索。
  if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS)) {
    return 'standard'
  }

  const value = process.env.ENABLE_SEARCH_EXTRA_TOOLS

  // 处理 auto:N 语法——先检查边界情况
  const autoPercent = value ? parseAutoPercentage(value) : null
  if (autoPercent === 0) return 'tst' // auto:0 = 始终启用
  if (autoPercent === 100) return 'standard'
  if (isAutoSearchExtraToolsMode(value)) {
    return 'tst-auto' // auto 或 auto:1-99
  }

  if (isEnvTruthy(value)) return 'tst'
  if (isEnvDefinedFalsy(process.env.ENABLE_SEARCH_EXTRA_TOOLS))
    return 'standard'
  return 'tst' // default: always defer non-core tools
}

/**
 * 检查工具搜索是否*可能*被启用（乐观检查）。
 *
 * 若工具搜索有潜在可能被启用则返回 true，不检查阈值等动态因素。适用于：
 * - 将 SearchExtraToolsTool 纳入基础工具集（以便在需要时可用）
 * - 检查 SearchExtraToolsTool 是否应将自身报告为已启用
 *
 * 仅当工具搜索被明确禁用（standard 模式）时返回 false。
 *
 * 如需包含阈值的最终确定性检查，请使用 isSearchExtraToolsEnabled()。
 */
let loggedOptimistic = false

export function isSearchExtraToolsEnabledOptimistic(): boolean {
  const mode = getSearchExtraToolsMode()
  if (mode === 'standard') {
    if (!loggedOptimistic) {
      loggedOptimistic = true
      logForDebugging(
        `[SearchExtraTools:optimistic] mode=${mode}, ENABLE_SEARCH_EXTRA_TOOLS=${process.env.ENABLE_SEARCH_EXTRA_TOOLS}, result=false`,
      )
    }
    return false
  }

  // 所有提供商使用统一的自建工具搜索（TF-IDF + 关键词）。
  // 无 first-party / tool_reference / defer_loading 之分。
  // 用户仍可通过 ENABLE_SEARCH_EXTRA_TOOLS=false 禁用。

  if (!loggedOptimistic) {
    loggedOptimistic = true
    logForDebugging(
      `[SearchExtraTools:optimistic] mode=${mode}, ENABLE_SEARCH_EXTRA_TOOLS=${process.env.ENABLE_SEARCH_EXTRA_TOOLS}, result=true`,
    )
  }
  return true
}

/**
 * 检查 SearchExtraToolsTool 是否在提供的工具列表中可用。
 * 若 SearchExtraToolsTool 不可用（例如通过 disallowedTools 被禁止），
 * 则工具搜索无法正常运行，应将其禁用。
 *
 * @param tools 包含 'name' 属性的工具数组
 * @returns 若 SearchExtraToolsTool 在工具列表中则返回 true，否则返回 false
 */
export function isSearchExtraToolsToolAvailable(
  tools: readonly { name: string }[],
): boolean {
  return tools.some(tool => toolMatchesName(tool, SEARCH_EXTRA_TOOLS_TOOL_NAME))
}

/**
 * 计算所有延迟工具描述的总字符数。
 * 包含名称、描述文本和输入 schema，与实际发送给 API 的内容保持一致。
 */
async function calculateDeferredToolDescriptionChars(
  tools: Tools,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  agents: AgentDefinition[],
): Promise<number> {
  const deferredTools = tools.filter(t => isDeferredTool(t))
  if (deferredTools.length === 0) return 0

  const sizes = await Promise.all(
    deferredTools.map(async tool => {
      const description = await tool.prompt({
        getToolPermissionContext,
        tools,
        agents,
      })
      const inputSchema = tool.inputJSONSchema
        ? jsonStringify(tool.inputJSONSchema)
        : tool.inputSchema
          ? jsonStringify(zodToJsonSchema(tool.inputSchema))
          : ''
      return tool.name.length + description.length + inputSchema.length
    }),
  )

  return sizes.reduce((total, size) => total + size, 0)
}

/**
 * 检查工具搜索（带 tool_reference 的 MCP 工具延迟加载）是否对当前请求启用。
 *
 * 这是最终的确定性检查，涵盖：
 * - MCP 模式（Tst、TstAuto、McpCli、Standard）
 * - 模型兼容性（haiku 不支持 tool_reference）
 * - SearchExtraToolsTool 可用性（必须在工具列表中）
 * - TstAuto 模式下的阈值检查
 *
 * 在所有上下文均可用的实际 API 调用时使用。
 *
 * @param model 当前使用的模型（保留以兼容 API）
 * @param tools 可用工具数组（含 MCP 工具）
 * @param getToolPermissionContext 获取工具权限上下文的函数
 * @param agents Agent 定义数组
 * @param source 调用方的可选标识符（用于调试）
 * @returns 若当前请求应启用工具搜索则返回 true
 */
export async function isSearchExtraToolsEnabled(
  model: string,
  tools: Tools,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  agents: AgentDefinition[],
  source?: string,
): Promise<boolean> {
  const mcpToolCount = count(tools, t => t.isMcp)

  // 记录模式决策事件的辅助函数
  function logModeDecision(
    enabled: boolean,
    mode: SearchExtraToolsMode,
    reason: string,
    extraProps?: Record<string, number>,
  ): void {
    logEvent('tengu_search_extra_tools_mode_decision', {
      enabled,
      mode: mode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      reason:
        reason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      // 记录实际被检查的模型，而非会话的主模型。
      // 这对于调试子 agent 工具搜索决策非常重要，
      // 因为子 agent 模型（如 haiku）可能与会话模型（如 opus）不同。
      checkedModel:
        model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      mcpToolCount,
      userType: (process.env.USER_TYPE ??
        'external') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...extraProps,
    })
  }

  // 工具搜索对所有提供商和模型统一启用。
  // 所有提供商均通过 SearchExtraToolsTool + ExecuteExtraTool 使用自建 TF-IDF + 关键词搜索。

  // 检查 SearchExtraToolsTool 是否可用（遵循 disallowedTools 设置）
  if (!isSearchExtraToolsToolAvailable(tools)) {
    logForDebugging(
      `Tool search disabled: SearchExtraToolsTool is not available (may have been disallowed via disallowedTools).`,
    )
    logModeDecision(false, 'standard', 'mcp_search_unavailable')
    return false
  }

  const mode = getSearchExtraToolsMode()

  switch (mode) {
    case 'tst':
      logModeDecision(true, mode, 'tst_enabled')
      return true

    case 'tst-auto': {
      const { enabled, debugDescription, metrics } = await checkAutoThreshold(
        tools,
        getToolPermissionContext,
        agents,
        model,
      )

      if (enabled) {
        logForDebugging(
          `Auto tool search enabled: ${debugDescription}` +
            (source ? ` [source: ${source}]` : ''),
        )
        logModeDecision(true, mode, 'auto_above_threshold', metrics)
        return true
      }

      logForDebugging(
        `Auto tool search disabled: ${debugDescription}` +
          (source ? ` [source: ${source}]` : ''),
      )
      logModeDecision(false, mode, 'auto_below_threshold', metrics)
      return false
    }

    case 'standard':
      logModeDecision(false, mode, 'standard_mode')
      return false
  }
}

/**
 * 检查对象是否为 tool_reference 块。
 * tool_reference 是 SDK 类型中未包含的 beta 功能，因此需要运行时检查。
 */
export function isToolReferenceBlock(obj: unknown): boolean {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'type' in obj &&
    (obj as { type: unknown }).type === 'tool_reference'
  )
}

/**
 * 带 tool_name 的 tool_reference 块类型守卫。
 */
function isToolReferenceWithName(
  obj: unknown,
): obj is { type: 'tool_reference'; tool_name: string } {
  return (
    isToolReferenceBlock(obj) &&
    'tool_name' in (obj as object) &&
    typeof (obj as { tool_name: unknown }).tool_name === 'string'
  )
}

/**
 * 表示包含数组内容的 tool_result 块的类型。
 * 用于从 SearchExtraToolsTool 结果中提取 tool_reference 块。
 */
type ToolResultBlock = {
  type: 'tool_result'
  content: unknown[]
}

/**
 * 表示包含字符串内容的 tool_result 块的类型。
 * 用于从 SearchExtraToolsTool 文本输出中提取工具名称。
 */
type ToolResultBlockWithStringContent = {
  type: 'tool_result'
  content: string
}

/**
 * 包含数组内容的 tool_result 块类型守卫。
 */
function isToolResultBlockWithContent(obj: unknown): obj is ToolResultBlock {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'type' in obj &&
    (obj as { type: unknown }).type === 'tool_result' &&
    'content' in obj &&
    Array.isArray((obj as { content: unknown }).content)
  )
}

/**
 * 包含字符串内容的 tool_result 块类型守卫。
 */
function isToolResultBlockWithStringContent(
  obj: unknown,
): obj is ToolResultBlockWithStringContent {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'type' in obj &&
    (obj as { type: unknown }).type === 'tool_result' &&
    'content' in obj &&
    typeof (obj as { content: unknown }).content === 'string'
  )
}

/**
 * 从 SearchExtraToolsTool 文本输出中提取工具名称的正则表达式。
 * 匹配格式："Found N deferred tool(s): ToolA, mcp.server.ToolB."
 * 使用多行模式 + 行尾锚点，防止工具名中的点号（如 mcp__s__t）破坏解析。
 */
const DISCOVERED_TOOLS_PATTERN = /^Found \d+ deferred tool\(s\): (.+)\.$/m

/**
 * 从 SearchExtraToolsTool 文本输出中提取工具名称。
 * 格式："Found N deferred tool(s): ToolA, ToolB.\n..."
 */
function extractToolNamesFromText(text: string): string[] {
  const match = DISCOVERED_TOOLS_PATTERN.exec(text)
  if (!match?.[1]) return []
  return match[1]
    .split(',')
    .map(name => name.trim())
    .filter(Boolean)
}

/**
 * 从消息历史中的 SearchExtraToolsTool 结果提取工具名称。
 *
 * 支持两种格式：
 * 1. 旧版 tool_reference 块（向后兼容旧会话）
 * 2. 统一自建工具搜索的文本输出
 *
 * 发现的工具名称用于在后续 API 请求中包含延迟工具，
 * 以便模型可以直接调用它们。
 *
 * 压缩操作会将发现集快照保存到边界标记的
 * compactMetadata.preCompactDiscoveredTools 中。
 *
 * @param messages 可能包含 tool_result 块的消息数组
 * @returns 已发现的工具名称集合
 */
export function extractDiscoveredToolNames(messages: Message[]): Set<string> {
  const discoveredTools = new Set<string>()
  let carriedFromBoundary = 0

  for (const msg of messages) {
    // 压缩边界携带压缩前的已发现集合。直接内联类型检查，
    // 而非使用 isCompactBoundaryMessage——utils/messages.ts 从本文件导入，
    // 反向导入会造成循环依赖。
    if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
      const carried = (msg as any).compactMetadata?.preCompactDiscoveredTools as
        | string[]
        | undefined
      if (carried) {
        for (const name of carried) discoveredTools.add(name)
        carriedFromBoundary += carried.length
      }
      continue
    }

    // deferred-tools-delta 附件声明模型应视为可用的工具。
    // 包含其 addedNames，以便 claude.ts 中的过滤器
    // 在 API 请求中保留对应的工具 schema。
    if (
      msg.type === 'attachment' &&
      (msg as any).attachment?.type === 'deferred_tools_delta'
    ) {
      const added: string[] = (msg as any).attachment.addedNames ?? []
      for (const name of added) discoveredTools.add(name)
      continue
    }

    // 只有用户消息包含 tool_result 块（对 tool_use 的响应）
    if (msg.type !== 'user') continue

    const content = msg.message?.content
    if (!Array.isArray(content)) continue

    for (const block of content) {
      // 旧版：来自旧会话的 tool_reference 块（向后兼容）
      if (isToolResultBlockWithContent(block)) {
        for (const item of block.content) {
          if (isToolReferenceWithName(item)) {
            discoveredTools.add(item.tool_name)
          }
        }
      }

      // 统一自建搜索：来自 SearchExtraToolsTool 的文本输出
      if (isToolResultBlockWithStringContent(block)) {
        const names = extractToolNamesFromText(block.content)
        for (const name of names) {
          discoveredTools.add(name)
        }
      }
    }
  }

  if (discoveredTools.size > 0) {
    logForDebugging(
      `Dynamic tool loading: found ${discoveredTools.size} discovered tools in message history` +
        (carriedFromBoundary > 0
          ? ` (${carriedFromBoundary} carried from compact boundary)`
          : ''),
    )
  }

  return discoveredTools
}

export type DeferredToolsDelta = {
  addedNames: string[]
  /** addedNames 对应的渲染行；扫描时从名称重建。 */
  addedLines: string[]
  removedNames: string[]
}

/**
 * tengu_deferred_tools_pool_change 事件的调用点鉴别器。
 * 扫描从多个具有不同预期先验语义的调用点运行（inc-4747）：
 *   - attachments_main：主线程 getAttachments → prior=0 在 fire-2+ 时为 BUG
 *   - attachments_subagent：子 agent getAttachments → prior=0 为预期行为
 *     （全新会话，initialMessages 中无 DTD）
 *   - compact_full：compact.ts 传入 [] → prior=0 为预期行为
 *   - compact_partial：compact.ts 传入 messagesToKeep → 取决于保留了什么
 *   - reactive_compact：reactiveCompact.ts 传入 preservedMessages → 同上
 * 若无此字段，96% 的 prior=0 统计将被预期桶主导，
 * 真正的主线程跨轮次 bug（如有）在 BQ 中将不可见。
 */
export type DeferredToolsDeltaScanContext = {
  callSite:
    | 'attachments_main'
    | 'attachments_subagent'
    | 'compact_full'
    | 'compact_partial'
    | 'reactive_compact'
  querySource?: string
}

/**
 * true → 通过持久化 delta 附件声明延迟工具。
 * false → claude.ts 保持其每次调用的 <available-deferred-tools>
 * 头部前缀（附件不会触发）。
 */
export function isDeferredToolsDeltaEnabled(): boolean {
  return (
    process.env.USER_TYPE === 'ant' ||
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_glacier_2xr', false)
  )
}

/**
 * 将当前延迟工具池与本次会话中已声明的工具集进行差异比对
 * （通过扫描先前的 deferred_tools_delta 附件重建）。若无变化则返回 null。
 *
 * 若某个名称已被声明但此后不再延迟——但仍在基础工具池中——
 * 则不会将其报告为已移除。因为它现在是直接加载的，
 * 告知模型"不再可用"是错误的。
 */
export function getDeferredToolsDelta(
  tools: Tools,
  messages: Message[],
  scanContext?: DeferredToolsDeltaScanContext,
): DeferredToolsDelta | null {
  const announced = new Set<string>()
  let attachmentCount = 0
  let dtdCount = 0
  const attachmentTypesSeen = new Set<string>()
  for (const msg of messages) {
    if (msg.type !== 'attachment') continue
    attachmentCount++
    attachmentTypesSeen.add(msg.attachment!.type)
    if (msg.attachment!.type !== 'deferred_tools_delta') continue
    dtdCount++
    for (const n of msg.attachment!.addedNames) announced.add(n)
    for (const n of msg.attachment!.removedNames) announced.delete(n)
  }

  const deferred: Tool[] = tools.filter(isDeferredTool)
  const deferredNames = new Set(deferred.map(t => t.name))
  const poolNames = new Set(tools.map(t => t.name))

  const added = deferred.filter(t => !announced.has(t.name))
  const removed: string[] = []
  for (const n of announced) {
    if (deferredNames.has(n)) continue
    if (!poolNames.has(n)) removed.push(n)
    // else: undeferred — silent
  }

  if (added.length === 0 && removed.length === 0) return null

  // inc-4747 扫描无结果 bug 的诊断信息。第一轮字段
  // （来自 #23167 的 messagesLength/attachmentCount/dtdCount）显示 45.6% 的
  // 事件有附件但无 DTD，但这些数字存在混淆：
  // 子 agent 首次触发和压缩路径扫描的 prior=0 为预期行为，
  // 主导了统计数据。callSite/querySource/attachmentTypesSeen 对
  // 桶进行了拆分，以便在 BQ 中隔离真正的主线程跨轮次故障。
  logEvent('tengu_deferred_tools_pool_change', {
    addedCount: added.length,
    removedCount: removed.length,
    priorAnnouncedCount: announced.size,
    messagesLength: messages.length,
    attachmentCount,
    dtdCount,
    callSite: (scanContext?.callSite ??
      'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    querySource: (scanContext?.querySource ??
      'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    attachmentTypesSeen: [...attachmentTypesSeen]
      .sort()
      .join(',') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })

  return {
    addedNames: added.map(t => t.name).sort(),
    addedLines: added.map(formatDeferredToolLine).sort(),
    removedNames: removed.sort(),
  }
}

/**
 * 检查延迟工具是否超过启用 TST 的自动阈值。
 * 优先尝试精确 token 计数；不可用时回退至基于字符的启发式方法。
 */
async function checkAutoThreshold(
  tools: Tools,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  agents: AgentDefinition[],
  model: string,
): Promise<{
  enabled: boolean
  debugDescription: string
  metrics: Record<string, number>
}> {
  // 优先尝试精确 token 计数（已缓存，每次工具集变更只调用一次 API）
  const deferredToolTokens = await getDeferredToolTokenCount(
    tools,
    getToolPermissionContext,
    agents,
    model,
  )

  if (deferredToolTokens !== null) {
    const threshold = getAutoSearchExtraToolsTokenThreshold(model)
    return {
      enabled: deferredToolTokens >= threshold,
      debugDescription:
        `${deferredToolTokens} tokens (threshold: ${threshold}, ` +
        `${getAutoSearchExtraToolsPercentage()}% of context)`,
      metrics: { deferredToolTokens, threshold },
    }
  }

  // 回退：token API 不可用时使用基于字符的启发式方法
  const deferredToolDescriptionChars =
    await calculateDeferredToolDescriptionChars(
      tools,
      getToolPermissionContext,
      agents,
    )
  const charThreshold = getAutoSearchExtraToolsCharThreshold(model)
  return {
    enabled: deferredToolDescriptionChars >= charThreshold,
    debugDescription:
      `${deferredToolDescriptionChars} chars (threshold: ${charThreshold}, ` +
      `${getAutoSearchExtraToolsPercentage()}% of context) (char fallback)`,
    metrics: { deferredToolDescriptionChars, charThreshold },
  }
}
