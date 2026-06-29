import { feature } from 'bun:bundle'
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { QuerySource } from '../../constants/querySource.js'
import type { ToolUseContext } from '../../Tool.js'
import { FILE_EDIT_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/GrepTool/prompt.js'
import { WEB_FETCH_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/WebFetchTool/prompt.js'
import { WEB_SEARCH_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/WebSearchTool/prompt.js'
import type { Message } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import { SHELL_TOOL_NAMES } from '../../utils/shell/shellToolUtils.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import { notifyCacheDeletion } from '../api/promptCacheBreakDetection.js'
import { roughTokenCountEstimation } from '../tokenEstimation.js'
import {
  clearCompactWarningSuppression,
  suppressCompactWarning,
} from './compactWarningState.js'
import {
  getTimeBasedMCConfig,
  type TimeBasedMCConfig,
} from './timeBasedMCConfig.js'

// 从 utils/toolResultStorage.ts 内联 — 导入该文件会引入
// sessionStorage → utils/messages → services/api/errors，通过
// promptCacheBreakDetection 完成回到此文件的循环依赖链。
// 通过与 source-of-truth 断言相等的测试来检测漂移。
export const TIME_BASED_MC_CLEARED_MESSAGE = '[旧工具结果内容已清除]'

const IMAGE_MAX_TOKEN_SIZE = 2000

// 仅压缩这些工具的结果
const COMPACTABLE_TOOLS = new Set<string>([
  FILE_READ_TOOL_NAME,
  ...SHELL_TOOL_NAMES,
  GREP_TOOL_NAME,
  GLOB_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
])

// --- 缓存微压缩状态（仅限 ant 内部，由 feature('CACHED_MICROCOMPACT') 控制） ---

// 延迟初始化缓存 MC 模块和状态，避免在外部构建中导入。
// 导入和状态放在 feature() 检查内，以便死代码消除。
let cachedMCModule: typeof import('./cachedMicrocompact.js') | null = null
let cachedMCState: import('./cachedMicrocompact.js').CachedMCState | null = null
let pendingCacheEdits:
  | import('./cachedMicrocompact.js').CacheEditsBlock
  | null = null

async function getCachedMCModule(): Promise<
  typeof import('./cachedMicrocompact.js')
> {
  if (!cachedMCModule) {
    cachedMCModule = await import('./cachedMicrocompact.js')
  }
  return cachedMCModule
}

function ensureCachedMCState(): import('./cachedMicrocompact.js').CachedMCState {
  if (!cachedMCState && cachedMCModule) {
    cachedMCState = cachedMCModule.createCachedMCState()
  }
  if (!cachedMCState) {
    throw new Error('cachedMCState 未初始化 — 必须先调用 getCachedMCModule()')
  }
  return cachedMCState
}

/**
 * 获取要包含在下一个 API 请求中的新待处理缓存编辑。
 * 如果没有新的待处理编辑则返回 null。
 * 清除待处理状态（调用者必须在插入后固定它们）。
 */
export function consumePendingCacheEdits():
  | import('./cachedMicrocompact.js').CacheEditsBlock
  | null {
  const edits = pendingCacheEdits
  pendingCacheEdits = null
  return edits
}

/**
 * 获取所有之前固定的缓存编辑，必须在原始位置重新发送以实现缓存命中。
 */
export function getPinnedCacheEdits(): import('./cachedMicrocompact.js').PinnedCacheEdits[] {
  if (!cachedMCState) {
    return []
  }
  return cachedMCState.pinnedEdits
}

/**
 * 将新的 cache_edits 块固定到特定用户消息位置。
 * 在插入新编辑后调用，以便在后续调用中重新发送。
 */
export function pinCacheEdits(
  userMessageIndex: number,
  block: import('./cachedMicrocompact.js').CacheEditsBlock,
): void {
  if (cachedMCState) {
    cachedMCState.pinnedEdits.push({ userMessageIndex, block })
  }
}

/**
 * 将所有已注册的工具标记为已发送到 API。
 * 在成功的 API 响应后调用。
 */
export function markToolsSentToAPIState(): void {
  if (cachedMCState && cachedMCModule) {
    cachedMCModule.markToolsSentToAPI(cachedMCState)
  }
}

export function resetMicrocompactState(): void {
  if (cachedMCState && cachedMCModule) {
    cachedMCModule.resetCachedMCState(cachedMCState)
  }
  pendingCacheEdits = null
}

// 计算工具结果 token 数的辅助函数
function calculateToolResultTokens(block: ToolResultBlockParam): number {
  if (!block.content) {
    return 0
  }

  if (typeof block.content === 'string') {
    return roughTokenCountEstimation(block.content)
  }

  // TextBlockParam | ImageBlockParam | DocumentBlockParam 数组
  return block.content.reduce((sum, item) => {
    if (item.type === 'text') {
      return sum + roughTokenCountEstimation(item.text)
    } else if (item.type === 'image' || item.type === 'document') {
      // 图片/文档无论格式如何，大约都是 2000 tokens
      return sum + IMAGE_MAX_TOKEN_SIZE
    }
    return sum
  }, 0)
}

/**
 * 通过提取文本内容估算消息的 token 数。
 * 用于在没有准确 API 计数时进行粗略 token 估算。
 * 估算值乘以 4/3 以保守估计，因为我们是在近似。
 */
export function estimateMessageTokens(messages: Message[]): number {
  let totalTokens = 0

  for (const message of messages) {
    if (message.type !== 'user' && message.type !== 'assistant') {
      continue
    }

    if (!Array.isArray(message.message!.content)) {
      continue
    }

    for (const block of message.message!.content) {
      if (block.type === 'text') {
        totalTokens += roughTokenCountEstimation(block.text)
      } else if (block.type === 'tool_result') {
        totalTokens += calculateToolResultTokens(block)
      } else if (block.type === 'image' || block.type === 'document') {
        totalTokens += IMAGE_MAX_TOKEN_SIZE
      } else if (block.type === 'thinking') {
        // 与 roughTokenCountEstimationForBlock 一致：只计算 thinking
        // 文本，不计算 JSON 包装或签名（签名是元数据，
        // 不是模型 token 化的内容）。
        totalTokens += roughTokenCountEstimation(block.thinking)
      } else if (block.type === 'redacted_thinking') {
        totalTokens += roughTokenCountEstimation(block.data)
      } else if (block.type === 'tool_use') {
        // 与 roughTokenCountEstimationForBlock 一致：计算 name + input，
        // 不计算 JSON 包装或 id 字段。
        totalTokens += roughTokenCountEstimation(
          block.name + jsonStringify(block.input ?? {}),
        )
      } else {
        // server_tool_use、web_search_tool_result 等
        totalTokens += roughTokenCountEstimation(jsonStringify(block))
      }
    }
  }

  // 估算值乘以 4/3 以保守估计，因为我们是在近似
  return Math.ceil(totalTokens * (4 / 3))
}

export type PendingCacheEdits = {
  trigger: 'auto'
  deletedToolIds: string[]
  // 上一次 API 响应中累积的 cache_deleted_input_tokens 基线值，
  // 用于计算每次操作的增量（API 值是累积/粘性的）
  baselineCacheDeletedTokens: number
}

export type MicrocompactResult = {
  messages: Message[]
  compactionInfo?: {
    pendingCacheEdits?: PendingCacheEdits
  }
  // 内容被替换为清除消息的工具使用 ID。
  // 调用者应从 contentReplacementState.replacements 中移除这些，
  // 以从内存中释放原始字符串。
  clearedToolUseIds?: string[]
}

/**
 * 遍历消息并按遇到顺序收集工具名在 COMPACTABLE_TOOLS 中的
 * tool_use ID。两种微压缩路径共用此函数。
 */
function collectCompactableToolIds(messages: Message[]): string[] {
  const ids: string[] = []
  for (const message of messages) {
    if (
      message.type === 'assistant' &&
      Array.isArray(message.message!.content)
    ) {
      for (const block of message.message!.content) {
        if (block.type === 'tool_use' && COMPACTABLE_TOOLS.has(block.name)) {
          ids.push(block.id)
        }
      }
    }
  }
  return ids
}

// 使用前缀匹配，因为 promptCategory.ts 在非默认输出样式激活时
// 会将 querySource 设为 'repl_main_thread:outputStyle:<style>'。
// 裸 'repl_main_thread' 仅用于默认样式。
// query.ts:350/1451 使用相同的 startsWith 模式；之前缓存 MC 的
// `=== 'repl_main_thread'` 检查是一个潜在 bug — 使用非默认输出样式
// 的用户被静默排除在缓存 MC 之外。
function isMainThreadSource(querySource: QuerySource | undefined): boolean {
  return !querySource || querySource.startsWith('repl_main_thread')
}

export async function microcompactMessages(
  messages: Message[],
  toolUseContext?: ToolUseContext,
  querySource?: QuerySource,
): Promise<MicrocompactResult> {
  // 在新的微压缩尝试开始时清除抑制标志
  clearCompactWarningSuppression()

  // 基于时间的触发器首先运行并短路。如果距上一条 assistant 消息的间隔
  // 超过阈值，服务器缓存已过期，整个前缀无论如何都会被重写 — 因此在
  // 请求前立即清除旧工具结果内容，缩小重写量。
  // 当此触发器触发时跳过缓存 MC（缓存编辑）：编辑假设缓存是热的，
  // 而我们刚确认它是冷的。
  const timeBasedResult = maybeTimeBasedMicrocompact(messages, querySource)
  if (timeBasedResult) {
    return timeBasedResult
  }

  // 仅为主线程运行缓存 MC，防止分叉代理（session_memory、
  // prompt_suggestion 等）在全局 cachedMCState 中注册其 tool_results，
  // 否则会导致主线程尝试删除自己对话中不存在的工具。
  if (feature('CACHED_MICROCOMPACT')) {
    const mod = await getCachedMCModule()
    const model = toolUseContext?.options.mainLoopModel ?? getMainLoopModel()
    if (
      mod.isCachedMicrocompactEnabled() &&
      mod.isModelSupportedForCacheEditing(model) &&
      isMainThreadSource(querySource)
    ) {
      return await cachedMicrocompactPath(messages, querySource)
    }
  }

  // 旧版微压缩路径已移除 — tengu_cache_plum_violet 始终为 true。
  // 对于缓存微压缩不可用的上下文（外部构建、非 ant 用户、
  // 不支持的模型、子代理），此处不执行压缩；
  // 自动压缩负责处理上下文压力。
  return { messages }
}

/**
 * 缓存微压缩路径 — 使用缓存编辑 API 移除工具结果，
 * 而不使缓存前缀失效。
 *
 * 与普通微压缩的关键区别：
 * - 不修改本地消息内容（cache_reference 和 cache_edits 在 API 层添加）
 * - 使用 GrowthBook 配置中基于计数的触发/保留阈值
 * - 优先于普通微压缩（无磁盘持久化）
 * - 跟踪工具结果并为 API 层排队缓存编辑
 */
async function cachedMicrocompactPath(
  messages: Message[],
  querySource: QuerySource | undefined,
): Promise<MicrocompactResult> {
  const mod = await getCachedMCModule()
  const state = ensureCachedMCState()
  const config = mod.getCachedMCConfig()

  const compactableToolIds = new Set(collectCompactableToolIds(messages))
  // 第二遍：按用户消息分组注册工具结果
  for (const message of messages) {
    if (message.type === 'user' && Array.isArray(message.message!.content)) {
      const groupIds: string[] = []
      for (const block of message.message!.content) {
        if (
          block.type === 'tool_result' &&
          compactableToolIds.has(block.tool_use_id) &&
          !state.registeredTools.has(block.tool_use_id)
        ) {
          mod.registerToolResult(state, block.tool_use_id)
          groupIds.push(block.tool_use_id)
        }
      }
      mod.registerToolMessage(state, groupIds)
    }
  }

  const toolsToDelete = mod.getToolResultsToDelete(state)

  if (toolsToDelete.length > 0) {
    // 为 API 层创建并排队 cache_edits 块
    const cacheEdits = mod.createCacheEditsBlock(state, toolsToDelete)
    if (cacheEdits) {
      pendingCacheEdits = cacheEdits
    }

    logForDebugging(
      `缓存 MC 删除 ${toolsToDelete.length} 个工具: ${toolsToDelete.join(', ')}`,
    )

    // 记录事件
    logEvent('tengu_cached_microcompact', {
      toolsDeleted: toolsToDelete.length,
      deletedToolIds: toolsToDelete.join(
        ',',
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      activeToolCount: state.toolOrder.length - state.deletedRefs.size,
      triggerType:
        'auto' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      threshold: config.triggerThreshold,
      keepRecent: config.keepRecent,
    })

    // 成功压缩后抑制警告
    suppressCompactWarning()

    // 通知缓存中断检测，缓存读取将合理下降
    if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
      // 传入实际的 querySource — isMainThreadSource 现在使用前缀匹配，
      // 因此输出样式变体也会进入此处，getTrackingKey 基于完整 source
      // 字符串作为键，而非 'repl_main_thread' 前缀。
      notifyCacheDeletion(querySource ?? 'repl_main_thread')
    }

    // 消息原样返回 — cache_reference 和 cache_edits 在 API 层添加。
    // 边界消息延迟到 API 响应后，以便使用 API 返回的实际
    // cache_deleted_input_tokens 而非客户端估算值。
    // 捕获上一条 assistant 消息中累积的 cache_deleted_input_tokens 基线，
    // 以便在 API 调用后计算每次操作的增量。
    const lastAsst = messages.findLast(m => m.type === 'assistant')
    const baseline =
      lastAsst?.type === 'assistant'
        ? ((
            lastAsst.message!.usage as unknown as Record<
              string,
              number | undefined
            >
          )?.cache_deleted_input_tokens ?? 0)
        : 0

    return {
      messages,
      compactionInfo: {
        pendingCacheEdits: {
          trigger: 'auto',
          deletedToolIds: toolsToDelete,
          baselineCacheDeletedTokens: baseline,
        },
      },
    }
  }

  // 无需压缩，消息原样返回
  return { messages }
}

/**
 * 基于时间的微压缩：当距上一条主循环 assistant 消息的间隔超过
 * 配置的阈值时，清除除最近 N 个可压缩工具结果之外的所有内容。
 *
 * 当触发器未触发时返回 null（已禁用、错误的 source、间隔低于阈值、
 * 无可清除内容）— 调用者继续执行其他路径。
 *
 * 与缓存 MC 不同，此方法直接修改消息内容。缓存是冷的，
 * 因此没有需要通过 cache_edits 保留的缓存前缀。
 */
/**
 * 检查此请求是否应触发基于时间的触发器。
 *
 * 触发时返回测量的间隔（距上一条 assistant 消息的分钟数），
 * 未触发时返回 null（已禁用、错误 source、低于阈值、
 * 无先前 assistant 消息、时间戳无法解析）。
 *
 * 提取此函数以便其他预请求路径（如 snip 强制应用）可以查询
 * 相同的谓词，而不耦合到工具结果清除操作。
 */
export function evaluateTimeBasedTrigger(
  messages: Message[],
  querySource: QuerySource | undefined,
): { gapMinutes: number; config: TimeBasedMCConfig } | null {
  const config = getTimeBasedMCConfig()
  // 需要显式的主线程 querySource。isMainThreadSource 将 undefined
  // 视为主线程（为了缓存 MC 向后兼容），但多个调用者
  // （/context、/compact、analyzeContext）调用 microcompactMessages 时
  // 不传 source，仅用于分析目的 — 它们不应触发。
  if (!config.enabled || !querySource || !isMainThreadSource(querySource)) {
    return null
  }
  const lastAssistant = messages.findLast(m => m.type === 'assistant')
  if (!lastAssistant) {
    return null
  }
  const gapMinutes =
    (Date.now() -
      new Date(lastAssistant.timestamp as string | number).getTime()) /
    60_000
  if (!Number.isFinite(gapMinutes) || gapMinutes < config.gapThresholdMinutes) {
    return null
  }
  return { gapMinutes, config }
}

function maybeTimeBasedMicrocompact(
  messages: Message[],
  querySource: QuerySource | undefined,
): MicrocompactResult | null {
  const trigger = evaluateTimeBasedTrigger(messages, querySource)
  if (!trigger) {
    return null
  }
  const { gapMinutes, config } = trigger

  const compactableIds = collectCompactableToolIds(messages)

  // 下限为 1：slice(-0) 返回完整数组（矛盾地保留了所有内容），
  // 清除所有结果会让模型失去零工作上下文。两种退化都不合理 —
  // 始终至少保留最后一个。
  const keepRecent = Math.max(1, config.keepRecent)
  const keepSet = new Set(compactableIds.slice(-keepRecent))
  const clearSet = new Set(compactableIds.filter(id => !keepSet.has(id)))

  if (clearSet.size === 0) {
    return null
  }

  let tokensSaved = 0
  const result: Message[] = messages.map(message => {
    if (message.type !== 'user' || !Array.isArray(message.message!.content)) {
      return message
    }
    let touched = false
    const newContent = message.message!.content.map(block => {
      if (
        block.type === 'tool_result' &&
        clearSet.has(block.tool_use_id) &&
        block.content !== TIME_BASED_MC_CLEARED_MESSAGE
      ) {
        tokensSaved += calculateToolResultTokens(block)
        touched = true
        return { ...block, content: TIME_BASED_MC_CLEARED_MESSAGE }
      }
      return block
    })
    if (!touched) return message
    return {
      ...message,
      message: { ...message.message, content: newContent },
    }
  })

  if (tokensSaved === 0) {
    return null
  }

  logEvent('tengu_time_based_microcompact', {
    gapMinutes: Math.round(gapMinutes),
    gapThresholdMinutes: config.gapThresholdMinutes,
    toolsCleared: clearSet.size,
    toolsKept: keepSet.size,
    keepRecent: config.keepRecent,
    tokensSaved,
  })

  logForDebugging(
    `[基于时间的 MC] 间隔 ${Math.round(gapMinutes)}min > ${config.gapThresholdMinutes}min, 清除了 ${clearSet.size} 个工具结果 (~${tokensSaved} tokens), 保留了最后 ${keepSet.size} 个`,
  )

  suppressCompactWarning()
  // 缓存 MC 状态（模块级）保存先前轮次注册的工具 ID。
  // 我们刚清除了部分工具的内容，并通过更改提示内容使服务器缓存失效。
  // 如果缓存 MC 在下一轮使用过期状态运行，它会尝试 cache_edit
  // 服务器端已不存在的工具。重置它。
  resetMicrocompactState()
  // 我们刚更改了提示内容 — 下一次响应的缓存读取会很低，
  // 但这是我们造成的，不是缓存中断。告诉检测器预期下降。
  // 使用 notifyCacheDeletion（而非 notifyCompaction），因为它已在此导入，
  // 且实现了相同的误报抑制 — 向导入添加第二个符号会被循环依赖检查标记。
  // 传入实际的 querySource：getTrackingKey 返回完整 source 字符串
  // （如 'repl_main_thread:outputStyle:custom'），而不仅是前缀。
  if (feature('PROMPT_CACHE_BREAK_DETECTION') && querySource) {
    notifyCacheDeletion(querySource)
  }

  return { messages: result, clearedToolUseIds: [...clearSet] }
}
