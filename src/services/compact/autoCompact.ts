import { feature } from 'bun:bundle'
import { markPostCompaction } from 'src/bootstrap/state.js'
import { getSdkBetas } from '../../bootstrap/state.js'
import type { QuerySource } from '../../constants/querySource.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { getGlobalConfig } from '../../utils/config.js'
import { getContextWindowForModel } from '../../utils/context.js'
import { logForDebugging } from '../../utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { hasExactErrorMessage } from '../../utils/errors.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { logError } from '../../utils/log.js'
import { tokenCountWithEstimation } from '../../utils/tokens.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import { getMaxOutputTokensForModel } from '../api/claude.js'
import { notifyCompaction } from '../api/promptCacheBreakDetection.js'
import { setLastSummarizedMessageId } from '../SessionMemory/sessionMemoryUtils.js'
import {
  type CompactionResult,
  compactConversation,
  ERROR_MESSAGE_USER_ABORT,
  type RecompactionInfo,
} from './compact.js'
import { runPostCompactCleanup } from './postCompactCleanup.js'
import { trySessionMemoryCompaction } from './sessionMemoryCompact.js'

// 为压缩过程中的输出预留这么多 token
// 基于 compact 摘要输出的 p99.99 为 17,387 token。
const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000

// 返回上下文窗口大小减去该模型的最大输出 token 数
export function getEffectiveContextWindowSize(model: string): number {
  const reservedTokensForSummary = Math.min(
    getMaxOutputTokensForModel(model),
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  )
  let contextWindow = getContextWindowForModel(model, getSdkBetas())

  const autoCompactWindow = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  if (autoCompactWindow) {
    const parsed = parseInt(autoCompactWindow, 10)
    if (!isNaN(parsed) && parsed > 0) {
      contextWindow = Math.min(contextWindow, parsed)
    }
  }

  return contextWindow - reservedTokensForSummary
}

export type AutoCompactTrackingState = {
  compacted: boolean
  turnCounter: number
  // 每一轮的唯一 ID
  turnId: string
  // 连续自动压缩失败次数。成功后重置。
  // 作为熔断器使用，在上下文不可恢复地超过限制（如 prompt_too_long）时
  // 停止重试。
  consecutiveFailures?: number
}

export const AUTOCOMPACT_BUFFER_TOKENS = 13_000
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000
export const ERROR_THRESHOLD_BUFFER_TOKENS = 20_000
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000

// 对每一轮工具结果增长的保守估计。
// 典型工具结果（文件读取、grep、bash）平均约 5-10K token；
// 偶尔的大体积读取可能飙升至 20K+。
const TOOL_RESULT_GROWTH_ESTIMATE = 15_000

/**
 * 根据上下文感知的 autocompact 缓冲区。更大的上下文窗口需要更多余量，
 * 因为单轮对话可能产生成比例更多的 token（更长的模型输出 + 更大的工具结果）。
 */
export function getAutocompactBufferTokens(model: string): number {
  const effectiveWindow = getEffectiveContextWindowSize(model)
  if (effectiveWindow >= 800_000) return 50_000
  if (effectiveWindow >= 400_000) return 30_000
  return AUTOCOMPACT_BUFFER_TOKENS
}

/**
 * 估算单轮对话可能产生的最大 token 增长。
 * 用于在 API 调用前进行预测性的 autocompact 检查。
 */
export function estimateMaxTurnGrowth(model: string): number {
  const maxOutput = Math.min(
    getMaxOutputTokensForModel(model),
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  )
  return maxOutput + TOOL_RESULT_GROWTH_ESTIMATE
}

// 连续失败达到此次数后停止尝试 autocompact。
// BQ 2026-03-10：1,279 个会话出现了 50+ 次连续失败（单会话最多 3,272 次），
// 全球每天浪费约 25 万次 API 调用。
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3

export function getAutoCompactThreshold(model: string): number {
  const effectiveContextWindow = getEffectiveContextWindowSize(model)

  const autocompactThreshold =
    effectiveContextWindow - getAutocompactBufferTokens(model)

  // 用于更方便地测试 autocompact 的覆盖配置
  const envPercent = process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
  if (envPercent) {
    const parsed = parseFloat(envPercent)
    if (!isNaN(parsed) && parsed > 0 && parsed <= 100) {
      const percentageThreshold = Math.floor(
        effectiveContextWindow * (parsed / 100),
      )
      return Math.min(percentageThreshold, autocompactThreshold)
    }
  }

  return autocompactThreshold
}

export function calculateTokenWarningState(
  tokenUsage: number,
  model: string,
): {
  percentLeft: number
  isAboveWarningThreshold: boolean
  isAboveErrorThreshold: boolean
  isAboveAutoCompactThreshold: boolean
  isAtBlockingLimit: boolean
} {
  const autoCompactThreshold = getAutoCompactThreshold(model)
  const threshold = isAutoCompactEnabled()
    ? autoCompactThreshold
    : getEffectiveContextWindowSize(model)

  const percentLeft = Math.max(
    0,
    Math.round(((threshold - tokenUsage) / threshold) * 100),
  )

  const warningThreshold = threshold - WARNING_THRESHOLD_BUFFER_TOKENS
  const errorThreshold = threshold - ERROR_THRESHOLD_BUFFER_TOKENS

  const isAboveWarningThreshold = tokenUsage >= warningThreshold
  const isAboveErrorThreshold = tokenUsage >= errorThreshold

  const isAboveAutoCompactThreshold =
    isAutoCompactEnabled() && tokenUsage >= autoCompactThreshold

  const actualContextWindow = getEffectiveContextWindowSize(model)
  const defaultBlockingLimit =
    actualContextWindow - MANUAL_COMPACT_BUFFER_TOKENS

  // 允许通过环境变量覆盖以便测试
  const blockingLimitOverride = process.env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE
  const parsedOverride = blockingLimitOverride
    ? parseInt(blockingLimitOverride, 10)
    : NaN
  const blockingLimit =
    !isNaN(parsedOverride) && parsedOverride > 0
      ? parsedOverride
      : defaultBlockingLimit

  const isAtBlockingLimit = tokenUsage >= blockingLimit

  logForDebugging(
    `[Hapii] AutoCompact.calculateTokenWarningState tokens=${tokenUsage} percentLeft=${percentLeft}% warn=${isAboveWarningThreshold} error=${isAboveErrorThreshold} compact=${isAboveAutoCompactThreshold} blocking=${isAtBlockingLimit}`,
    { level: 'info' },
  )
  return {
    percentLeft,
    isAboveWarningThreshold,
    isAboveErrorThreshold,
    isAboveAutoCompactThreshold,
    isAtBlockingLimit,
  }
}

export function isAutoCompactEnabled(): boolean {
  if (isEnvTruthy(process.env.DISABLE_COMPACT)) {
    return false
  }
  // 允许仅禁用 auto-compact（手动 /compact 仍然可用）
  if (isEnvTruthy(process.env.DISABLE_AUTO_COMPACT)) {
    return false
  }
  // 检查用户是否在设置中禁用了 auto-compact
  const userConfig = getGlobalConfig()
  return userConfig.autoCompactEnabled
}

export async function shouldAutoCompact(
  messages: Message[],
  model: string,
  querySource?: QuerySource,
  // Snip 会删除消息，但保留下来的 assistant 消息的 usage 仍然反映
  // snip 之前的上下文，因此 tokenCountWithEstimation 看不到这部分节省。
  // 这里减去 snip 已经计算出的粗略差值。
  snipTokensFreed = 0,
): Promise<boolean> {
  // 递归保护。session_memory 和 compact 是分叉的 agent，
  // 触发会造成死锁。
  if (querySource === 'session_memory' || querySource === 'compact') {
    return false
  }
  // marble_origami 是 ctx-agent —— 如果它的上下文爆炸并触发了
  // autocompact，runPostCompactCleanup 会调用 resetContextCollapse()，
  // 这会破坏主线程已提交的日志（跨分叉共享的模块级状态）。
  // 放在 feature() 内部，以便该字符串在外部构建中被死代码消除
  // （它位于 excluded-strings.txt 中）。
  if (feature('CONTEXT_COLLAPSE')) {
    if (querySource === 'marble_origami') {
      return false
    }
  }

  if (!isAutoCompactEnabled()) {
    return false
  }

  // 仅响应式模式：抑制主动 autocompact，让响应式压缩去处理
  // API 的 prompt-too-long 错误。feature() 包装可让该 flag 字符串
  // 不出现在外部构建中（REACTIVE_COMPACT 仅限 ant 使用）。
  // 注意：这里返回 false 也意味着 autoCompactIfNeeded 在查询循环中
  // 永远不会走到 trySessionMemoryCompaction —— /compact 调用点
  // 仍然会先尝试 session memory。如果 reactive-only 正式发布，需要重新审视。
  if (feature('REACTIVE_COMPACT')) {
    if (getFeatureValue_CACHED_MAY_BE_STALE('tengu_cobalt_raccoon', false)) {
      return false
    }
  }

  // Context-collapse 模式：同样的抑制。开启时，collapse 就是上下文管理
  // 系统——90% commit / 95% blocking-spawn 流程负责余量问题。autocompact
  // 在 effective-13k（约为有效容量的 93%）触发时，正好位于 collapse 的
  // commit-start（90%）和 blocking（95%）之间，因此会与 collapse 竞争并
  // 通常获胜，把 collapse 即将保存的细粒度上下文全部抹掉。在此处门控
  // （而不是在 isAutoCompactEnabled() 中）可以保留 reactiveCompact 作为
  // 413 的兜底（它直接查询 isAutoCompactEnabled），并使 sessionMemory
  // 和手动 /compact 继续可用。
  //
  // 查询的是 isContextCollapseEnabled（而不是原始的 gate），以便
  // CLAUDE_CONTEXT_COLLAPSE 环境变量覆盖在这里也被尊重。块内使用
  // require() 是为了打破初始化期的循环依赖（本文件导出的
  // getEffectiveContextWindowSize 被 collapse 的 index 导入）。
  if (feature('CONTEXT_COLLAPSE')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { isContextCollapseEnabled } =
      require('../contextCollapse/index.js') as typeof import('../contextCollapse/index.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    if (isContextCollapseEnabled()) {
      return false
    }
  }

  const tokenCount = tokenCountWithEstimation(messages) - snipTokensFreed
  const threshold = getAutoCompactThreshold(model)
  const effectiveWindow = getEffectiveContextWindowSize(model)

  logForDebugging(
    `autocompact: tokens=${tokenCount} threshold=${threshold} effectiveWindow=${effectiveWindow}${snipTokensFreed > 0 ? ` snipFreed=${snipTokensFreed}` : ''}`,
  )
  logForDebugging(
    `[Hapii] AutoCompact.shouldAutoCompact tokens=${tokenCount} threshold=${threshold} effectiveWindow=${effectiveWindow} msgCount=${messages.length}`,
    { level: 'info' },
  )

  const { isAboveAutoCompactThreshold } = calculateTokenWarningState(
    tokenCount,
    model,
  )

  return isAboveAutoCompactThreshold
}

export async function autoCompactIfNeeded(
  messages: Message[],
  toolUseContext: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  querySource?: QuerySource,
  tracking?: AutoCompactTrackingState,
  snipTokensFreed?: number,
): Promise<{
  wasCompacted: boolean
  compactionResult?: CompactionResult
  consecutiveFailures?: number
}> {
  if (isEnvTruthy(process.env.DISABLE_COMPACT)) {
    return { wasCompacted: false }
  }

  // 熔断器：连续失败 N 次后停止重试。
  // 没有这个保护，上下文不可恢复地超过限制的会话会在每一轮
  // 都向 API 发起注定失败的压缩尝试。
  if (
    tracking?.consecutiveFailures !== undefined &&
    tracking.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
  ) {
    return { wasCompacted: false }
  }

  const model = toolUseContext.options.mainLoopModel
  const shouldCompact = await shouldAutoCompact(
    messages,
    model,
    querySource,
    snipTokensFreed,
  )

  if (!shouldCompact) {
    return { wasCompacted: false }
  }

  logForDebugging(`[AutoCompact] 上下文接近限制, 开始压缩...`, {
    level: 'info',
  })

  const recompactionInfo: RecompactionInfo = {
    isRecompactionInChain: tracking?.compacted === true,
    turnsSincePreviousCompact: tracking?.turnCounter ?? -1,
    previousCompactTurnId: tracking?.turnId,
    autoCompactThreshold: getAutoCompactThreshold(model),
    querySource,
  }

  // 实验：先尝试 session memory 压缩
  const sessionMemoryResult = await trySessionMemoryCompaction(
    messages,
    toolUseContext.agentId,
    recompactionInfo.autoCompactThreshold,
  )
  if (sessionMemoryResult) {
    // 重置 lastSummarizedMessageId，因为 session memory 压缩会裁剪消息，
    // REPL 替换消息后旧消息的 UUID 将不再存在
    setLastSummarizedMessageId(undefined)
    runPostCompactCleanup(querySource)
    // 重置缓存读取基线，避免压缩后的下降被误判为缓存打破。
    // compactConversation 内部会做这件事，SM-compact 不会。
    // BQ 2026-03-01：缺少这一步使 20% 的 tengu_prompt_cache_break 事件
    // 成为误报（systemPromptChanged=true，timeSinceLastAssistantMsg=-1）。
    if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
      notifyCompaction(querySource ?? 'compact', toolUseContext.agentId)
    }
    markPostCompaction()
    return {
      wasCompacted: true,
      compactionResult: sessionMemoryResult,
    }
  }

  try {
    const compactionResult = await compactConversation(
      messages,
      toolUseContext,
      cacheSafeParams,
      true, // 为 autocompact 抑制用户提问
      undefined, // autocompact 无自定义指令
      true, // isAutoCompact
      recompactionInfo,
    )

    logForDebugging(
      `[AutoCompact] 压缩完成, 压缩前消息数=${messages.length}, 压缩后消息数=${compactionResult.summaryMessages.length + compactionResult.attachments.length}`,
      { level: 'info' },
    )

    // 重置 lastSummarizedMessageId，因为旧版压缩会替换所有消息，
    // 旧消息的 UUID 将不再存在于新的消息数组中
    setLastSummarizedMessageId(undefined)
    runPostCompactCleanup(querySource)

    return {
      wasCompacted: true,
      compactionResult,
      // 成功时重置失败计数
      consecutiveFailures: 0,
    }
  } catch (error) {
    if (!hasExactErrorMessage(error, ERROR_MESSAGE_USER_ABORT)) {
      logError(error)
    }
    logForDebugging(
      `[AutoCompact] 压缩失败: ${error instanceof Error ? error.message : String(error)}`,
      { level: 'error' },
    )
    // 为熔断器递增连续失败计数。
    // 调用方通过 autoCompactTracking 传递该值，使下一轮查询循环
    // 可以跳过徒劳的重试。
    const prevFailures = tracking?.consecutiveFailures ?? 0
    const nextFailures = prevFailures + 1
    if (nextFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
      logForDebugging(
        `autocompact: circuit breaker tripped after ${nextFailures} consecutive failures — skipping future attempts this session`,
        { level: 'warn' },
      )
    }
    return { wasCompacted: false, consecutiveFailures: nextFailures }
  }
}
