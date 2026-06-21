// biome-ignore-all assist/source/organizeImports: ANT 专属的 import 标记不可重排
import type {
  ToolResultBlockParam,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/index.mjs'
import type { CanUseToolFn } from './hooks/useCanUseTool.js'
import { FallbackTriggeredError } from './services/api/withRetry.js'
import {
  calculateTokenWarningState,
  estimateMaxTurnGrowth,
  getEffectiveContextWindowSize,
  isAutoCompactEnabled,
  type AutoCompactTrackingState,
} from './services/compact/autoCompact.js'
import { buildPostCompactMessages } from './services/compact/compact.js'
/* eslint-disable @typescript-eslint/no-require-imports */
const reactiveCompact = feature('REACTIVE_COMPACT')
  ? (require('./services/compact/reactiveCompact.js') as typeof import('./services/compact/reactiveCompact.js'))
  : null
const contextCollapse = feature('CONTEXT_COLLAPSE')
  ? (require('./services/contextCollapse/index.js') as typeof import('./services/contextCollapse/index.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  logEvent,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from 'src/services/analytics/index.js'
import { ImageSizeError } from './utils/imageValidation.js'
import { ImageResizeError } from './utils/imageResizer.js'
import { findToolByName, type ToolUseContext } from './Tool.js'
import { asSystemPrompt, type SystemPrompt } from './utils/systemPromptType.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  RequestStartEvent,
  StreamEvent,
  ToolUseSummaryMessage,
  UserMessage,
  TombstoneMessage,
} from './types/message.js'
import { logError } from './utils/log.js'
import {
  PROMPT_TOO_LONG_ERROR_MESSAGE,
  isPromptTooLongMessage,
} from './services/api/errors.js'
import { logAntError, logForDebugging } from './utils/debug.js'
import {
  createUserMessage,
  createUserInterruptionMessage,
  normalizeMessagesForAPI,
  createSystemMessage,
  createAssistantAPIErrorMessage,
  getMessagesAfterCompactBoundary,
  createToolUseSummaryMessage,
  createMicrocompactBoundaryMessage,
  stripSignatureBlocks,
} from './utils/messages.js'
import { generateToolUseSummary } from './services/toolUseSummary/toolUseSummaryGenerator.js'
import { prependUserContext, appendSystemContext } from './utils/api.js'
import {
  createAttachmentMessage,
  filterDuplicateMemoryAttachments,
  getAttachmentMessages,
  startRelevantMemoryPrefetch,
} from './utils/attachments.js'
/* eslint-disable @typescript-eslint/no-require-imports */
const skillPrefetch = feature('EXPERIMENTAL_SKILL_SEARCH')
  ? (require('./services/skillSearch/prefetch.js') as typeof import('./services/skillSearch/prefetch.js'))
  : null
const searchExtraToolsPrefetch = feature('EXPERIMENTAL_SEARCH_EXTRA_TOOLS')
  ? (require('./services/searchExtraTools/prefetch.js') as typeof import('./services/searchExtraTools/prefetch.js'))
  : null
const _jobClassifier = feature('TEMPLATES')
  ? (require('./jobs/classifier.js') as typeof import('./jobs/classifier.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  enqueue,
  remove as removeFromQueue,
  getCommandsByMaxPriority,
  isSlashCommand,
} from './utils/messageQueueManager.js'
import {
  type AutonomyTurnOutcome,
  claimConsumableQueuedAutonomyCommands,
  finalizeAutonomyCommandsForTurn,
} from './utils/autonomyQueueLifecycle.js'
import { notifyCommandLifecycle } from './utils/commandLifecycle.js'
import { headlessProfilerCheckpoint } from './utils/headlessProfiler.js'
import {
  getRuntimeMainLoopModel,
  renderModelName,
} from './utils/model/model.js'
import {
  doesMostRecentAssistantMessageExceed200k,
  finalContextTokensFromLastResponse,
  tokenCountWithEstimation,
} from './utils/tokens.js'
import { ESCALATED_MAX_TOKENS } from './utils/context.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from './services/analytics/growthbook.js'
import { SLEEP_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/SleepTool/prompt.js'
import { executePostSamplingHooks } from './utils/hooks/postSamplingHooks.js'
import { executeStopFailureHooks } from './utils/hooks.js'
import type { QuerySource } from './constants/querySource.js'
import type { QueuedCommand } from './types/textInputTypes.js'
import { createDumpPromptsFetch } from './services/api/dumpPrompts.js'
import { StreamingToolExecutor } from './services/tools/StreamingToolExecutor.js'
import { queryCheckpoint } from './utils/queryProfiler.js'
import { runTools } from './services/tools/toolOrchestration.js'
import { applyToolResultBudget } from './utils/toolResultStorage.js'
import { recordContentReplacement } from './utils/sessionStorage.js'
import { handleStopHooks } from './query/stopHooks.js'
import { buildQueryConfig } from './query/config.js'
import { productionDeps, type QueryDeps } from './query/deps.js'
import type { Terminal, Continue } from './query/transitions.js'
import { feature } from 'bun:bundle'
import {
  getCurrentTurnTokenBudget,
  getTurnOutputTokens,
  incrementBudgetContinuationCount,
  getSessionId,
} from './bootstrap/state.js'
import { createBudgetTracker, checkTokenBudget } from './query/tokenBudget.js'
import { count } from './utils/array.js'
import {
  createTrace,
  endTrace,
  flushLangfuse,
  isLangfuseEnabled,
} from './services/langfuse/index.js'
import { getAPIProvider } from './utils/model/providers.js'
import {
  createCacheWarningMessage,
  getCacheThreshold,
  isCacheWarningEnabled,
  shouldShowCacheWarning,
} from './utils/cacheWarning.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const snipModule = feature('HISTORY_SNIP')
  ? (require('./services/compact/snipCompact.js') as typeof import('./services/compact/snipCompact.js'))
  : null
const taskSummaryModule = feature('BG_SESSIONS')
  ? (require('./utils/taskSummary.js') as typeof import('./utils/taskSummary.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

function* yieldMissingToolResultBlocks(
  assistantMessages: AssistantMessage[],
  errorMessage: string,
) {
  for (const assistantMessage of assistantMessages) {
    // 从该 assistant 消息中提取所有 tool_use 块
    const toolUseBlocks = (
      Array.isArray(assistantMessage.message?.content)
        ? assistantMessage.message.content
        : []
    ).filter(
      (content: { type: string }) => content.type === 'tool_use',
    ) as ToolUseBlock[]

    // 为每个 tool_use 生成一条中断消息
    for (const toolUse of toolUseBlocks) {
      yield createUserMessage({
        content: [
          {
            type: 'tool_result',
            content: errorMessage,
            is_error: true,
            tool_use_id: toolUse.id,
          },
        ],
        toolUseResult: errorMessage,
        sourceToolAssistantUUID: assistantMessage.uuid,
      })
    }
  }
}

/**
 * thinking 的规则冗长且讲究，需要一位巫师花上大量时间深思冥想才能
 * 领会其中的奥妙。
 *
 * 规则如下：
 * 1. 包含 thinking 或 redacted_thinking 块的消息必须属于 max_thinking_length > 0 的查询
 * 2. thinking 块不能是一个块中的最后一条消息
 * 3. thinking 块必须在整个 assistant 轨迹期间被保留（单轮，或若该轮包含
 *    tool_use 块，则还包括其随后的 tool_result 以及下一个 assistant 消息）
 *
 * 好好留意这些规则，年轻的巫师。因为它们就是 thinking 的规则，
 * 而 thinking 的规则就是这个宇宙的规则。若你不遵守，
 * 必将受到惩罚 —— 整整一天的调试和抓狂。
 */
const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3

/**
 * 这是不是一个 max_output_tokens 错误消息？如果是，流式循环应当
 * 对 SDK 调用方扣留它，直到我们知道恢复循环能否继续。提前 yield
 * 会让中间态错误泄漏给 SDK 调用方（例如 cowork/desktop），它们一遇到
 * 任何 `error` 字段就终止会话 —— 恢复循环仍在跑，但没人监听了。
 *
 * 对应 reactiveCompact.isWithheldPromptTooLong。
 */
function isWithheldMaxOutputTokens(
  msg: Message | StreamEvent | undefined,
): msg is AssistantMessage {
  return msg?.type === 'assistant' && msg.apiError === 'max_output_tokens'
}

function getAutonomyTurnOutcome(params: {
  terminal?: Terminal
  thrownError?: unknown
}): AutonomyTurnOutcome {
  if (params.thrownError !== undefined) {
    return { type: 'failed', error: params.thrownError }
  }

  const terminal = params.terminal
  const reason = terminal?.reason
  switch (reason) {
    case 'completed':
      return { type: 'completed' }
    case undefined:
    case 'aborted_streaming':
    case 'aborted_tools':
      return { type: 'cancelled' }
    case 'model_error':
      return { type: 'failed', error: terminal.error }
    default:
      return {
        type: 'failed',
        message: `query ended without successful completion: ${reason}`,
      }
  }
}

export type QueryParams = {
  messages: Message[]
  systemPrompt: SystemPrompt
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
  canUseTool: CanUseToolFn
  toolUseContext: ToolUseContext
  fallbackModel?: string
  querySource: QuerySource
  maxOutputTokensOverride?: number
  maxTurns?: number
  skipCacheWrite?: boolean
  // API task_budget（output_config.task_budget，beta task-budgets-2026-03-13）。
  // 与 tokenBudget +500k 自动续写特性不同。`total` 是整个 agent 轮次的
  // 预算；`remaining` 每次迭代根据累计 API 用量计算。见 claude.ts 的
  // configureTaskBudgetParams。
  taskBudget?: { total: number }
  deps?: QueryDeps
}

// -- 查询循环状态

// 跨循环迭代携带的可变状态
type State = {
  messages: Message[]
  toolUseContext: ToolUseContext
  autoCompactTracking: AutoCompactTrackingState | undefined
  maxOutputTokensRecoveryCount: number
  hasAttemptedReactiveCompact: boolean
  maxOutputTokensOverride: number | undefined
  pendingToolUseSummary: Promise<ToolUseSummaryMessage | null> | undefined
  stopHookActive: boolean | undefined
  turnCount: number
  // 上一次迭代为什么继续。首次迭代为 undefined。
  // 让测试可以断言恢复路径已触发，而不必检查消息内容。
  transition: Continue | undefined
}

/**
 * 底层 API 查询循环（async generator）—— 核心执行引擎。
 *
 * 工作方式：
 *   调用方（QueryEngine / print.ts）通过 for-await 消费这个 generator，
 *   每次 yield 返回一个事件（流式 token、工具调用、消息完成等），
 *   直到整个对话轮次结束，返回 Terminal 对象描述终止原因。
 *
 * 内部循环（queryLoop）的核心逻辑：
 *   1. 构建 system prompt + messages 列表
 *   2. 调用 Anthropic API（services/api/claude.ts）获取流式响应
 *   3. 逐 chunk yield 流式事件给调用方（UI 实时渲染）
 *   4. 响应完成后，检查是否有工具调用（tool_use block）
 *   5. 若有工具调用 → 执行工具 → 将工具结果追加到 messages → 继续循环（回到步骤 2）
 *   6. 若无工具调用 → 本轮结束，返回 Terminal
 *
 * 还负责：
 *   - 自动压缩（auto compact）：当上下文接近窗口限制时自动压缩历史
 *   - Langfuse 链路追踪（创建/结束 trace）
 *   - 命令队列生命周期管理
 *   - JSC Performance 内存清理（防止长时间会话内存泄漏）
 */
export async function* query(
  params: QueryParams,
): AsyncGenerator<
  | StreamEvent
  | RequestStartEvent
  | Message
  | TombstoneMessage
  | ToolUseSummaryMessage,
  Terminal
> {
  const consumedCommandUuids: string[] = []
  const consumedAutonomyCommands: QueuedCommand[] = []

  // 为本次查询轮次创建 Langfuse trace（未配置则为 no-op）。
  // 作为子 agent 调用时，langfuseTrace 已由 runAgent() 设置 ——
  // 复用它而不是创建独立的 trace。
  const ownsTrace = !params.toolUseContext.langfuseTrace
  logForDebugging(
    `[Hapii] Query.query 启动 messages=${params.messages.length} tools=${params.toolUseContext.options.tools.length} source=${params.querySource}`,
    { level: 'info' },
  )
  logForDebugging(
    `[query] ownsTrace=${ownsTrace} incoming langfuseTrace=${params.toolUseContext.langfuseTrace ? 'present' : 'null/undefined'} isLangfuseEnabled=${isLangfuseEnabled()}`,
  )
  const langfuseTrace =
    params.toolUseContext.langfuseTrace ??
    (isLangfuseEnabled()
      ? createTrace({
          sessionId: getSessionId(),
          model: params.toolUseContext.options.mainLoopModel,
          provider: getAPIProvider(),
          input: params.messages,
          querySource: params.querySource,
        })
      : null)

  // 将 trace 挂到 toolUseContext，让工具执行可以记录 observations
  const paramsWithTrace: QueryParams = langfuseTrace
    ? {
        ...params,
        toolUseContext: { ...params.toolUseContext, langfuseTrace },
      }
    : params

  let terminal: Terminal | undefined
  let didThrow = false
  let thrownError: unknown
  try {
    terminal = yield* queryLoop(
      paramsWithTrace,
      consumedCommandUuids,
      consumedAutonomyCommands,
    )
  } catch (error) {
    didThrow = true
    thrownError = error
    throw error
  } finally {
    await finalizeAutonomyCommandsForTurn({
      commands: consumedAutonomyCommands,
      outcome: getAutonomyTurnOutcome({
        terminal,
        ...(didThrow ? { thrownError } : {}),
      }),
      priority: 'later',
    })
      .then(nextCommands => {
        for (const command of nextCommands) {
          enqueue(command)
        }
      })
      .catch(logError)

    // 只有我们创建了 trace 才结束它 —— 子 agent 拥有自己的 trace
    if (ownsTrace) {
      const isAborted =
        terminal?.reason === 'aborted_streaming' ||
        terminal?.reason === 'aborted_tools'
      endTrace(langfuseTrace, undefined, isAborted ? 'interrupted' : undefined)
      // flush processor 以释放 span 数据（包括以
      // langfuse.observation.input 存储的序列化对话历史）。没有这一步，
      // SpanImpl 对象会保留数百 KB 的 JSON 直到 processor 的批次定时器
      // 触发（默认 10s）。
      await flushLangfuse()
    }

    // 斩断闭包链：toolUseContext 捕获的 langfuseTrace 持有
    // SpanImpl → otperformance（那个 571MB 的 Performance 对象）。
    // 在 endTrace 之后把它们置 null，GC 才能回收 span 树。
    if (paramsWithTrace !== params) {
      paramsWithTrace.toolUseContext.langfuseTrace = null
      paramsWithTrace.toolUseContext.langfuseRootTrace = null
      paramsWithTrace.toolUseContext.langfuseBatchSpan = null
    }

    // 清理 JSC 原生的 Performance 缓冲。OTel（otperformance）引用
    // globalThis.performance，后者把 marks/measures/resource timings
    // 存在一个永不收缩的 C++ Vector 中。长时间运行的会话即便在
    // span 已 flush 且置 null 之后，仍会累积数百 MB 的死容量。
    const gPerf = globalThis.performance
    if (gPerf && typeof gPerf.clearMarks === 'function') {
      try {
        gPerf.clearMarks()
        gPerf.clearMeasures?.()
        gPerf.clearResourceTimings?.()
      } catch {
        // 非关键 —— 某些环境可能不支持所有方法
      }
    }
  }

  // 只有 queryLoop 正常返回才会到达这里。throw 时（错误通过 yield*
  // 传播）和 .return() 时（Return 完成同时关闭两个 generator）都
  // 会跳过。这样在轮次失败时给出和 print.ts 的 drainCommandQueue
  // 相同的非对称 started-without-completed 信号。
  for (const uuid of consumedCommandUuids) {
    notifyCommandLifecycle(uuid, 'completed')
  }
  return terminal!
}

/**
 * query() 的内部循环实现 —— 实际执行 API 调用和工具执行。
 *
 * 使用可变 state 对象管理跨迭代状态（messages、toolUseContext 等），
 * 每次迭代结束时通过 `state = { ... }` 整体更新，避免 9 个独立赋值。
 *
 * 每次迭代的步骤：
 *   1. 预处理 messages（规范化、注入附件、memory 等）
 *   2. 调用 API，yield 流式事件
 *   3. 处理工具调用（runTools）→ 结果追加到 messages
 *   4. 判断终止条件（无工具调用 / 达到 maxTurns / 被中断）
 *   5. 若未终止 → 继续下一次迭代
 */
async function* queryLoop(
  params: QueryParams,
  consumedCommandUuids: string[],
  consumedAutonomyCommands: QueuedCommand[],
): AsyncGenerator<
  | StreamEvent
  | RequestStartEvent
  | Message
  | TombstoneMessage
  | ToolUseSummaryMessage,
  Terminal
> {
  logForDebugging(
    `[Hapii] Query.queryLoop 开始 initMsgs=${params.messages.length} maxTurns=${params.maxTurns ?? '∞'}`,
    { level: 'info' },
  )
  logForDebugging(
    `[query] queryLoop 开始, 初始消息数=${params.messages.length}, maxTurns=${params.maxTurns ?? '无限制'}`,
    { level: 'info' },
  )
  // 不可变 params —— 查询循环中绝不重新赋值。
  const {
    systemPrompt,
    userContext,
    systemContext,
    canUseTool,
    fallbackModel,
    querySource,
    maxTurns,
    skipCacheWrite,
  } = params
  const deps = params.deps ?? productionDeps()

  // 跨迭代的可变状态。循环体在每次迭代开头解构它，这样读取时只用
  // 裸名（`messages`、`toolUseContext`）。继续点写入 `state = { ... }`
  // 而不是 9 个单独的赋值。
  let state: State = {
    messages: params.messages,
    toolUseContext: params.toolUseContext,
    maxOutputTokensOverride: params.maxOutputTokensOverride,
    autoCompactTracking: undefined,
    stopHookActive: undefined,
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
    turnCount: 1,
    pendingToolUseSummary: undefined,
    transition: undefined,
  }
  const budgetTracker = feature('TOKEN_BUDGET') ? createBudgetTracker() : null

  // task_budget.remaining 跨压缩边界的追踪。首次 compact 触发之前为
  // undefined —— 上下文未压缩时服务端能看到完整历史并自行处理从
  // {total} 的倒计时（见 api/api/sampling/prompt/renderer.py:292）。
  // compact 之后服务端只看到摘要，会低估消耗；remaining 告诉它被
  // 压缩掉的那个 pre-compact 最终窗口。可跨多次压缩累计：每次减去
  // 该 compact 触发点处的最终上下文。保留在循环局部（不放 State），
  // 以免影响 7 个继续点。
  let taskBudgetRemaining: number | undefined

  // 在入口处一次性快照不可变的 env/statsig/session 状态。具体包含
  // 什么、为什么 feature() 门控被刻意排除，见 QueryConfig。
  const config = buildQueryConfig()

  // 每个用户轮次触发一次 —— prompt 在循环迭代之间是不变的，因此
  // 每次迭代都触发会让 sideQuery 重复问 N 次相同的问题。
  // 消费点轮询 settledAt（永不阻塞）。`using` 在所有 generator 退出
  // 路径上都会 dispose —— 见 MemoryPrefetch 的 dispose/telemetry 语义。
  using pendingMemoryPrefetch = startRelevantMemoryPrefetch(
    state.messages,
    state.toolUseContext,
  )

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // 每次迭代开头解构 state。只有 toolUseContext 会在迭代中被重新
    // 赋值（queryTracking、messages 更新）；其余字段在继续点之间
    // 只读。
    let { toolUseContext } = state
    const {
      messages,
      autoCompactTracking,
      maxOutputTokensRecoveryCount,
      hasAttemptedReactiveCompact,
      maxOutputTokensOverride,
      pendingToolUseSummary,
      stopHookActive,
      turnCount,
    } = state

    logForDebugging(
      `[Hapii] Query.queryLoop 第${turnCount}轮 messages=${messages.length}`,
      { level: 'info' },
    )
    logForDebugging(
      `[query] === 第${turnCount}轮循环 ===, 消息数=${messages.length}`,
      { level: 'info' },
    )

    // 技能发现预取 —— 按迭代执行（用 findWritePivot 守卫，非写入
    // 迭代会提前返回）。发现在模型流式输出和工具执行期间并行跑；
    // 工具完成后与 memory 预取消费一起 await。取代了原先
    // getAttachmentMessages 内阻塞式的 assistant_turn 路径
    //（生产环境 97% 的调用一无所获）。Turn-0 的用户输入发现仍
    // 在 userInputAttachments 中阻塞 —— 那是唯一一个没有先前工作
    // 可以隐藏在下面的信号。
    const pendingSkillPrefetch = skillPrefetch?.startSkillDiscoveryPrefetch(
      null,
      messages,
      toolUseContext,
    )
    const pendingToolPrefetch =
      searchExtraToolsPrefetch?.startSearchExtraToolsPrefetch(
        toolUseContext.options.tools ?? [],
        messages,
      )

    yield { type: 'stream_request_start' }

    queryCheckpoint('query_fn_entry')

    // 为 headless 延迟追踪记录查询开始（子 agent 跳过）
    if (!toolUseContext.agentId) {
      headlessProfilerCheckpoint('query_started')
    }

    // 初始化或递增查询链追踪
    const queryTracking = toolUseContext.queryTracking
      ? {
          chainId: toolUseContext.queryTracking.chainId,
          depth: toolUseContext.queryTracking.depth + 1,
        }
      : {
          chainId: deps.uuid(),
          depth: 0,
        }

    const queryChainIdForAnalytics =
      queryTracking.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS

    toolUseContext = {
      ...toolUseContext,
      queryTracking,
    }

    logForDebugging(
      `[Hapii] Query.queryLoop 第${turnCount + 1}轮开始 — 历史裁边前 messages=${messages.length}`,
      { level: 'info' },
    )
    let messagesForQuery = getMessagesAfterCompactBoundary(messages)
    logForDebugging(
      `[Hapii] Query.getMessagesAfterCompactBoundary 裁边后 messagesForQuery=${messagesForQuery.length}（原 ${messages.length}）`,
      { level: 'info' },
    )

    // 释放前序轮次的 toolUseResult 负载。此时 UI 已渲染完那些结果，
    // 下一次 API 调用只需要 message.message.content（tool_result 块），
    // 不再需要原始输出对象。这样可以避免 compact 触发前长会话中
    // 无限增长的内存 —— 否则一次 400KB 文件的 FileRead 会永远留在
    // mutableMessages 中。
    for (const msg of messagesForQuery) {
      if (
        msg.type === 'user' &&
        'toolUseResult' in msg &&
        msg.toolUseResult !== undefined
      ) {
        delete (msg as Message & { toolUseResult?: unknown }).toolUseResult
      }
    }

    let tracking = autoCompactTracking

    // 对聚合工具结果大小强制执行按消息的预算。在 microcompact 之前
    // 执行 —— 缓存 MC 完全靠 tool_use_id 操作（从不查看内容），
    // 因此内容替换对它不可见，两者可以干净地组合。contentReplacementState
    // 为 undefined 时（特性关闭）为 no-op。只对会在 resume 时读回
    // 记录的 querySource 持久化：agentId 路由到 sidechain 文件
    //（AgentTool resume）或会话文件（/resume）。临时 runForkedAgent
    // 调用方（agent_summary 等）不持久化。
    const persistReplacements =
      querySource.startsWith('agent:') ||
      querySource.startsWith('repl_main_thread')
    messagesForQuery = await applyToolResultBudget(
      messagesForQuery,
      toolUseContext.contentReplacementState,
      persistReplacements
        ? records =>
            void recordContentReplacement(
              records,
              toolUseContext.agentId,
            ).catch(logError)
        : undefined,
      new Set(
        toolUseContext.options.tools
          .filter(t => !Number.isFinite(t.maxResultSizeChars))
          .map(t => t.name),
      ),
    )

    // 在 microcompact 之前应用 snip（两者可能都跑 —— 不互斥）。
    // snipTokensFreed 传给 autocompact，让其阈值检查反映 snip 移除
    // 的量；tokenCountWithEstimation 本身看不到（它从受保护尾部的
    // assistant 读取 usage，而该部分在 snip 中保持不变）。
    let snipTokensFreed = 0
    if (feature('HISTORY_SNIP')) {
      queryCheckpoint('query_snip_start')
      const snipResult = snipModule!.snipCompactIfNeeded(messagesForQuery)
      messagesForQuery = snipResult.messages
      snipTokensFreed = snipResult.tokensFreed
      if (snipResult.boundaryMessage) {
        yield snipResult.boundaryMessage
      }
      queryCheckpoint('query_snip_end')
    }

    // 在 autocompact 之前应用 microcompact
    queryCheckpoint('query_microcompact_start')
    const microcompactResult = await deps.microcompact(
      messagesForQuery,
      toolUseContext,
      querySource,
    )
    messagesForQuery = microcompactResult.messages
    // 对于内容被替换为清理消息的工具结果，释放
    // contentReplacementState.replacements 中的原始字符串。
    if (microcompactResult.clearedToolUseIds?.length) {
      const replacements = toolUseContext?.contentReplacementState?.replacements
      if (replacements) {
        for (const id of microcompactResult.clearedToolUseIds) {
          replacements.delete(id)
        }
      }
    }
    // 对于缓存的 microcompact（缓存编辑），边界消息延迟到 API 响应
    // 之后才发出，这样就能使用真实的 cache_deleted_input_tokens。
    // 用 feature() 门控，让该字符串从外部构建中消失。
    const pendingCacheEdits = feature('CACHED_MICROCOMPACT')
      ? microcompactResult.compactionInfo?.pendingCacheEdits
      : undefined
    queryCheckpoint('query_microcompact_end')

    // 投影折叠后的上下文视图，并可能提交更多折叠。在 autocompact
    // 之前执行 —— 这样如果折叠已让我们低于 autocompact 阈值，
    // autocompact 就成了 no-op，我们保留细粒度上下文而不是单一摘要。
    //
    // 不 yield 任何东西 —— 折叠视图是对 REPL 完整历史的读取时
    // 投影。摘要消息住在 collapse 存储里，不在 REPL 数组中。这正是
    // 折叠能跨轮次持久的原因：projectView() 每次入口都重放提交
    // 日志。轮次内，视图通过继续点（query.ts:1192）的 state.messages
    // 向前流转，下一次 projectView() 成 no-op，因为归档的消息已经
    // 从它的输入中消失。
    if (feature('CONTEXT_COLLAPSE') && contextCollapse) {
      const collapseResult = await contextCollapse.applyCollapsesIfNeeded(
        messagesForQuery,
        toolUseContext,
        querySource,
      )
      messagesForQuery = collapseResult.messages
    }

    const fullSystemPrompt = asSystemPrompt(
      appendSystemContext(systemPrompt, systemContext),
    )

    queryCheckpoint('query_autocompact_start')
    const { compactionResult, consecutiveFailures } = await deps.autocompact(
      messagesForQuery,
      toolUseContext,
      {
        systemPrompt,
        userContext,
        systemContext,
        toolUseContext,
        forkContextMessages: messagesForQuery,
      },
      querySource,
      tracking,
      snipTokensFreed,
    )
    queryCheckpoint('query_autocompact_end')

    if (compactionResult) {
      const {
        preCompactTokenCount,
        postCompactTokenCount,
        truePostCompactTokenCount,
        compactionUsage,
      } = compactionResult

      logEvent('tengu_auto_compact_succeeded', {
        originalMessageCount: messages.length,
        compactedMessageCount:
          compactionResult.summaryMessages.length +
          compactionResult.attachments.length +
          compactionResult.hookResults.length,
        preCompactTokenCount,
        postCompactTokenCount,
        truePostCompactTokenCount,
        compactionInputTokens: compactionUsage?.input_tokens,
        compactionOutputTokens: compactionUsage?.output_tokens,
        compactionCacheReadTokens:
          compactionUsage?.cache_read_input_tokens ?? 0,
        compactionCacheCreationTokens:
          compactionUsage?.cache_creation_input_tokens ?? 0,
        compactionTotalTokens: compactionUsage
          ? compactionUsage.input_tokens +
            (compactionUsage.cache_creation_input_tokens ?? 0) +
            (compactionUsage.cache_read_input_tokens ?? 0) +
            compactionUsage.output_tokens
          : 0,

        queryChainId: queryChainIdForAnalytics,
        queryDepth: queryTracking.depth,
      })

      // task_budget：在下面 messagesForQuery 被替换为 postCompactMessages
      // 之前，捕获压缩前的最终上下文窗口。iterations[-1] 是权威的
      // 最终窗口（在服务端工具循环之后）；见 #304930。
      if (params.taskBudget) {
        const preCompactContext =
          finalContextTokensFromLastResponse(messagesForQuery)
        taskBudgetRemaining = Math.max(
          0,
          (taskBudgetRemaining ?? params.taskBudget.total) - preCompactContext,
        )
      }

      // 每次压缩都重置，使 turnCounter/turnId 反映最近的压缩。
      // recompactionInfo（autoCompact.ts:190）在调用之前已经为
      // turnsSincePreviousCompact/previousCompactTurnId 捕获了旧值，
      // 因此这次重置不会丢失这些信息。
      tracking = {
        compacted: true,
        turnId: deps.uuid(),
        turnCounter: 0,
        consecutiveFailures: 0,
      }

      const postCompactMessages = buildPostCompactMessages(compactionResult)

      for (const message of postCompactMessages) {
        yield message
      }

      // 用压缩后的消息继续当前的 query 调用
      messagesForQuery = postCompactMessages
    } else if (consecutiveFailures !== undefined) {
      // Autocompact 失败 —— 传播失败计数，让熔断器在下次迭代时停止重试。
      tracking = {
        ...(tracking ?? { compacted: false, turnId: '', turnCounter: 0 }),
        consecutiveFailures,
      }
    }

    //TODO: 设置阶段不需要设置 toolUseContext.messages，因为它在这里被更新
    toolUseContext = {
      ...toolUseContext,
      messages: messagesForQuery,
    }

    const assistantMessages: AssistantMessage[] = []
    const toolResults: (UserMessage | AttachmentMessage)[] = []
    // @see https://docs.claude.com/en/docs/build-with-claude/tool-use
    // 注意：stop_reason === 'tool_use' 不可靠 —— 并不总是被正确设置。
    // 在流式过程中只要有 tool_use 块到达就置位 —— 这是唯一的循环
    // 退出信号。若流结束后仍为 false，我们就完成了（modulo stop-hook 重试）。
    const toolUseBlocks: ToolUseBlock[] = []
    let needsFollowUp = false

    queryCheckpoint('query_setup_start')
    const useStreamingToolExecution = config.gates.streamingToolExecution
    let streamingToolExecutor = useStreamingToolExecution
      ? new StreamingToolExecutor(
          toolUseContext.options.tools,
          canUseTool,
          toolUseContext,
        )
      : null

    const appState = toolUseContext.getAppState()
    const permissionMode = appState.toolPermissionContext.mode
    let currentModel = getRuntimeMainLoopModel({
      permissionMode,
      mainLoopModel: toolUseContext.options.mainLoopModel,
      exceeds200kTokens:
        permissionMode === 'plan' &&
        doesMostRecentAssistantMessageExceed200k(messagesForQuery),
    })

    queryCheckpoint('query_setup_end')

    // 每个 query 会话只创建一次 fetch 包装器，避免内存保留。
    // 每次调用 createDumpPromptsFetch 都会创建一个捕获请求体的闭包。
    // 只创建一次意味着只保留最新的请求体（约 700KB），而不是会话中
    // 所有请求体（长会话约 500MB）。
    // 注意：agentId 在 query() 调用中实质上是常量 —— 只在查询之间
    // 变化（例如 /clear 命令或会话恢复）。
    const dumpPromptsFetch = config.gates.isAnt
      ? createDumpPromptsFetch(toolUseContext.agentId ?? config.sessionId)
      : undefined

    // 如果已经撞到硬阻塞上限则阻塞（仅在 auto-compact 关闭时生效）。
    // 这保留了空间，让用户仍可手动运行 /compact。
    // 如果刚刚发生过压缩则跳过此检查 —— 压缩结果已经验证在阈值之下，
    // 而 tokenCountWithEstimation 会从保留的消息中读取陈旧的
    // input_tokens，反映的是压缩前的上下文大小。snip 同样有
    // 陈旧性问题：减去 snipTokensFreed（否则在 snip 已让我们低于
    // autocompact 阈值、但陈旧用量仍高于阻塞限制的窗口中会错误
    // 阻塞 —— 在本 PR 之前该窗口不存在，因为 autocompact 总是
    // 基于陈旧计数触发）。
    // compact/session_memory 查询也跳过 —— 它们是继承完整对话的
    // fork agent，若在此阻塞会死锁（compact agent 需要运行才能
    // 降低 token 数）。
    // reactive compact 启用且允许自动压缩时也跳过 —— preempt 的
    // 合成错误会在 API 调用之前返回，因此 reactive compact 永远
    // 看不到可以响应的 prompt-too-long。扩展为 walrus 让 RC 在
    // 主动压缩失败时作为兜底。
    //
    // context-collapse 同样跳过：它的 recoverFromOverflow 在真实
    // API 413 时排空已分阶段的 collapse，然后落到 reactiveCompact。
    // 此处合成 preempt 会在 API 调用之前返回，饿死两条恢复路径。
    // isAutoCompactEnabled() 合取保留用户显式的 "no automatic anything"
    // 配置 —— 如果他们设置了 DISABLE_AUTO_COMPACT，就得到 preempt。
    let collapseOwnsIt = false
    if (feature('CONTEXT_COLLAPSE')) {
      collapseOwnsIt =
        (contextCollapse?.isContextCollapseEnabled() ?? false) &&
        isAutoCompactEnabled()
    }
    // 每轮一次上提 media-recovery 门控。扣留（流循环内部）与恢复
    //（之后）必须一致；CACHED_MAY_BE_STALE 可能在 5-30s 的流期间
    // 翻转，若扣留了却不恢复就会吃掉消息。PTL 不上提，因为它的
    // 扣留是未门控的 —— 它早于该实验，已经是对照组基线。
    const mediaRecoveryEnabled =
      reactiveCompact?.isReactiveCompactEnabled() ?? false
    if (
      !compactionResult &&
      querySource !== 'compact' &&
      querySource !== 'session_memory' &&
      !(
        reactiveCompact?.isReactiveCompactEnabled() && isAutoCompactEnabled()
      ) &&
      !collapseOwnsIt
    ) {
      const { isAtBlockingLimit } = calculateTokenWarningState(
        tokenCountWithEstimation(messagesForQuery) - snipTokensFreed,
        toolUseContext.options.mainLoopModel,
      )
      if (isAtBlockingLimit) {
        yield createAssistantAPIErrorMessage({
          content: PROMPT_TOO_LONG_ERROR_MESSAGE,
          error: 'invalid_request',
        })
        logForDebugging('[query] 循环终止: blocking_limit', { level: 'warn' })
        return { reason: 'blocking_limit' }
      }
    }

    // 预测式 autocompact：估算本轮的增长是否会超过上下文窗口。
    // 直接用 effectiveContextWindow（不带 autocompact 缓冲）以避免
    // 与 getAutoCompactThreshold（已经减去了缓冲）重复预留。
    if (!compactionResult && isAutoCompactEnabled()) {
      const model = toolUseContext.options.mainLoopModel
      const currentTokens =
        tokenCountWithEstimation(messagesForQuery) - snipTokensFreed
      const estimatedGrowth = estimateMaxTurnGrowth(model)
      const predictiveThreshold =
        getEffectiveContextWindowSize(model) - estimatedGrowth
      if (currentTokens > predictiveThreshold) {
        const predictiveResult = await deps.autocompact(
          messagesForQuery,
          toolUseContext,
          {
            systemPrompt,
            userContext,
            systemContext,
            toolUseContext,
            forkContextMessages: messagesForQuery,
          },
          querySource,
          tracking,
          snipTokensFreed,
        )
        if (predictiveResult.compactionResult) {
          messagesForQuery = buildPostCompactMessages(
            predictiveResult.compactionResult,
          )
          snipTokensFreed = 0
          tracking = tracking
            ? {
                ...tracking,
                compacted: true,
                consecutiveFailures: predictiveResult.consecutiveFailures ?? 0,
              }
            : tracking
        }
      }
    }

    let attemptWithFallback = true

    logForDebugging(
      `[query] 准备调用 API, model=${currentModel}, 消息数=${messagesForQuery.length}`,
      { level: 'info' },
    )
    queryCheckpoint('query_api_loop_start')
    try {
      while (attemptWithFallback) {
        attemptWithFallback = false
        try {
          let streamingFallbackOccured = false
          queryCheckpoint('query_api_streaming_start')
          for await (const message of deps.callModel({
            messages: prependUserContext(messagesForQuery, userContext),
            systemPrompt: fullSystemPrompt,
            thinkingConfig: toolUseContext.options.thinkingConfig,
            tools: toolUseContext.options.tools,
            signal: toolUseContext.abortController.signal,
            options: {
              async getToolPermissionContext() {
                const appState = toolUseContext.getAppState()
                return appState.toolPermissionContext
              },
              model: currentModel,
              ...(config.gates.fastModeEnabled && {
                fastMode: appState.fastMode,
              }),
              toolChoice: undefined,
              isNonInteractiveSession:
                toolUseContext.options.isNonInteractiveSession,
              fallbackModel,
              onStreamingFallback: () => {
                streamingFallbackOccured = true
              },
              querySource,
              agents: toolUseContext.options.agentDefinitions.activeAgents,
              allowedAgentTypes:
                toolUseContext.options.agentDefinitions.allowedAgentTypes,
              hasAppendSystemPrompt:
                !!toolUseContext.options.appendSystemPrompt,
              maxOutputTokensOverride,
              fetchOverride: dumpPromptsFetch,
              mcpTools: appState.mcp.tools,
              hasPendingMcpServers: appState.mcp.clients.some(
                c => c.type === 'pending',
              ),
              queryTracking,
              effortValue: appState.effortValue,
              advisorModel: appState.advisorModel,
              skipCacheWrite,
              agentId: toolUseContext.agentId,
              addNotification: toolUseContext.addNotification,
              ...(params.taskBudget && {
                taskBudget: {
                  total: params.taskBudget.total,
                  ...(taskBudgetRemaining !== undefined && {
                    remaining: taskBudgetRemaining,
                  }),
                },
              }),
              langfuseTrace: toolUseContext.langfuseTrace,
            },
          })) {
            // 我们不会使用第一次尝试的 tool_calls
            // 可以用……但那样就得合并 id 不同的 assistant 消息，
            // 并把完整的 tool_results 翻倍
            if (streamingFallbackOccured) {
              // 为孤儿消息 yield tombstone，让它们从 UI 和 transcript 中被移除。
              // 这些部分消息（尤其是 thinking 块）签名无效，
              // 会导致 "thinking blocks cannot be modified" API 错误。
              for (const msg of assistantMessages) {
                yield { type: 'tombstone' as const, message: msg }
              }
              logEvent('tengu_orphaned_messages_tombstoned', {
                orphanedMessageCount: assistantMessages.length,
                queryChainId: queryChainIdForAnalytics,
                queryDepth: queryTracking.depth,
              })

              assistantMessages.length = 0
              toolResults.length = 0
              toolUseBlocks.length = 0
              needsFollowUp = false

              // 丢弃失败流式尝试的待处理结果，创建新的 executor。
              // 防止带旧 tool_use_id 的孤儿 tool_results 在 fallback
              // 响应到来后仍被 yield。
              if (streamingToolExecutor) {
                streamingToolExecutor.discard()
                streamingToolExecutor = new StreamingToolExecutor(
                  toolUseContext.options.tools,
                  canUseTool,
                  toolUseContext,
                )
              }
            }
            // 在 yield 之前对克隆消息回填 tool_use 输入，让 SDK 流
            // 输出和 transcript 序列化看到 legacy/derived 字段。
            // 原始 `message` 保持不变，供下面 assistantMessages.push
            // 使用 —— 它会回流到 API，修改它会破坏 prompt 缓存
            //（字节不匹配）。
            let yieldMessage: typeof message = message
            if (message.type === 'assistant') {
              const assistantMsg = message as AssistantMessage
              const contentArr = Array.isArray(assistantMsg.message?.content)
                ? (assistantMsg.message.content as unknown as Array<{
                    type: string
                    input?: unknown
                    name?: string
                    [key: string]: unknown
                  }>)
                : []
              let clonedContent: typeof contentArr | undefined
              for (let i = 0; i < contentArr.length; i++) {
                const block = contentArr[i]!
                if (
                  block.type === 'tool_use' &&
                  typeof block.input === 'object' &&
                  block.input !== null
                ) {
                  const tool = findToolByName(
                    toolUseContext.options.tools,
                    block.name as string,
                  )
                  if (tool?.backfillObservableInput) {
                    const originalInput = block.input as Record<string, unknown>
                    const inputCopy = { ...originalInput }
                    tool.backfillObservableInput(inputCopy)
                    // 仅当 backfill 新增字段时才 yield 克隆；若只是
                    // 覆盖已有字段（例如文件工具展开 file_path）则跳过。
                    // 覆盖会改变序列化的 transcript 并破坏 resume 时的
                    // VCR 固件哈希，而 SDK 流也用不到 —— hooks 会通过
                    // toolExecution.ts 单独拿到展开后的路径。
                    const addedFields = Object.keys(inputCopy).some(
                      k => !(k in originalInput),
                    )
                    if (addedFields) {
                      clonedContent ??= [...contentArr]
                      clonedContent[i] = { ...block, input: inputCopy }
                    }
                  }
                }
              }
              if (clonedContent) {
                yieldMessage = {
                  ...message,
                  message: {
                    ...(assistantMsg.message ?? {}),
                    content: clonedContent,
                  },
                } as typeof message
              }
            }
            // 扣留可恢复的错误（prompt-too-long、max-output-tokens），
            // 直到我们知道恢复（collapse 排空 / reactive compact /
            // 截断重试）能否成功。仍 push 到 assistantMessages，以便
            // 下面的恢复检查能找到它们。任一子系统的扣留都足够 ——
            // 它们相互独立，关闭一个不会破坏另一个的恢复路径。
            //
            // feature() 只能在 if/三元条件中使用（bun:bundle 的
            // tree-shaking 约束），因此 collapse 检查是嵌套的而非
            // 组合的。
            let withheld = false
            if (feature('CONTEXT_COLLAPSE')) {
              if (
                contextCollapse?.isWithheldPromptTooLong(
                  message as Message,
                  isPromptTooLongMessage as (msg: Message) => boolean,
                  querySource,
                )
              ) {
                withheld = true
              }
            }
            if (reactiveCompact?.isWithheldPromptTooLong(message as Message)) {
              withheld = true
            }
            if (
              mediaRecoveryEnabled &&
              reactiveCompact?.isWithheldMediaSizeError(message as Message)
            ) {
              withheld = true
            }
            if (isWithheldMaxOutputTokens(message)) {
              withheld = true
            }
            if (!withheld) {
              yield yieldMessage
            }
            if (message.type === 'assistant') {
              const assistantMessage = message as AssistantMessage
              assistantMessages.push(assistantMessage)

              const msgToolUseBlocks = (
                Array.isArray(assistantMessage.message?.content)
                  ? assistantMessage.message.content
                  : []
              ).filter(
                (content: { type: string }) => content.type === 'tool_use',
              ) as ToolUseBlock[]
              if (msgToolUseBlocks.length > 0) {
                toolUseBlocks.push(...msgToolUseBlocks)
                needsFollowUp = true
              }

              if (
                streamingToolExecutor &&
                !toolUseContext.abortController.signal.aborted
              ) {
                for (const toolBlock of msgToolUseBlocks) {
                  streamingToolExecutor.addTool(toolBlock, assistantMessage)
                }
              }
            }

            if (
              streamingToolExecutor &&
              !toolUseContext.abortController.signal.aborted
            ) {
              for (const result of streamingToolExecutor.getCompletedResults()) {
                if (result.message) {
                  yield result.message
                  toolResults.push(
                    ...normalizeMessagesForAPI(
                      [result.message],
                      toolUseContext.options.tools,
                    ).filter(_ => _.type === 'user'),
                  )
                }
              }
            }
          }
          queryCheckpoint('query_api_streaming_end')
          logForDebugging(
            `[query] API 响应完成, 工具调用块数=${toolUseBlocks.length}, needsFollowUp=${needsFollowUp}, assistant消息数=${assistantMessages.length}`,
            { level: 'info' },
          )

          // 使用 API 返回的真实删除 token 数（而非客户端估算）来
          // yield 延迟的 microcompact 边界消息。整个块由 feature() 门控，
          // 让被排除的字符串从外部构建中消失。
          if (feature('CACHED_MICROCOMPACT') && pendingCacheEdits) {
            const lastAssistant = assistantMessages.at(-1)
            // API 字段在请求间是累计/粘性的，因此减去本次请求之前
            // 捕获的基线以得到增量。
            const usage = lastAssistant?.message.usage
            const cumulativeDeleted = usage
              ? ((usage as unknown as Record<string, number>)
                  .cache_deleted_input_tokens ?? 0)
              : 0
            const deletedTokens = Math.max(
              0,
              cumulativeDeleted - pendingCacheEdits.baselineCacheDeletedTokens,
            )
            if (deletedTokens > 0) {
              yield createMicrocompactBoundaryMessage(
                pendingCacheEdits.trigger,
                0,
                deletedTokens,
                pendingCacheEdits.deletedToolIds,
                [],
              )
            }
          }
        } catch (innerError) {
          if (innerError instanceof FallbackTriggeredError && fallbackModel) {
            // Fallback 已触发 —— 切换模型并重试
            currentModel = fallbackModel
            attemptWithFallback = true

            // 清空 assistant 消息，因为我们要重试整个请求
            yield* yieldMissingToolResultBlocks(
              assistantMessages,
              'Model fallback triggered',
            )
            assistantMessages.length = 0
            toolResults.length = 0
            toolUseBlocks.length = 0
            needsFollowUp = false

            // 丢弃失败尝试的待处理结果，创建新的 executor。
            // 防止带旧 tool_use_id 的孤儿 tool_results 泄漏到重试中。
            if (streamingToolExecutor) {
              streamingToolExecutor.discard()
              streamingToolExecutor = new StreamingToolExecutor(
                toolUseContext.options.tools,
                canUseTool,
                toolUseContext,
              )
            }

            // 用新模型更新 tool use context
            toolUseContext.options.mainLoopModel = fallbackModel

            // Thinking 签名与模型绑定：把受保护的 thinking 块
            //（例如 capybara）回放给未受保护的 fallback（例如 opus）会 400。
            // 重试前剥离，让 fallback 模型拿到干净的历史。
            if (process.env.USER_TYPE === 'ant') {
              messagesForQuery = stripSignatureBlocks(messagesForQuery)
            }

            // 记录 fallback 事件
            logEvent('tengu_model_fallback_triggered', {
              original_model:
                innerError.originalModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              fallback_model:
                fallbackModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              entrypoint:
                'cli' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              queryChainId: queryChainIdForAnalytics,
              queryDepth: queryTracking.depth,
            })

            // yield 关于 fallback 的系统消息 —— 用 'warning' 级别，
            // 让用户不需要 verbose 模式也能看到通知
            yield createSystemMessage(
              `Switched to ${renderModelName(innerError.fallbackModel)} due to high demand for ${renderModelName(innerError.originalModel)}`,
              'warning',
            )

            continue
          }
          throw innerError
        }
      }
    } catch (error) {
      logError(error)
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      logEvent('tengu_query_error', {
        assistantMessages: assistantMessages.length,
        toolUses: assistantMessages.flatMap(_ =>
          (Array.isArray(_.message?.content)
            ? (_.message.content as Array<{ type: string }>)
            : []
          ).filter(content => content.type === 'tool_use'),
        ).length,

        queryChainId: queryChainIdForAnalytics,
        queryDepth: queryTracking.depth,
      })

      // 用友好的用户消息处理图片尺寸/调整错误
      if (
        error instanceof ImageSizeError ||
        error instanceof ImageResizeError
      ) {
        yield createAssistantAPIErrorMessage({
          content: error.message,
        })
        return { reason: 'image_error' }
      }

      // 通常 queryModelWithStreaming 不应该抛错，而是把错误作为合成
      // assistant 消息 yield。但如果因为 bug 抛了，我们可能处在
      // 已经发出 tool_use 块但会在发出 tool_result 之前停止的状态。
      yield* yieldMissingToolResultBlocks(assistantMessages, errorMessage)

      // 抛出真实错误，而不是误导性的 "[Request interrupted by user]"
      // —— 这条路径是模型/运行时失败，不是用户操作。SDK 消费者过去
      // 会看到幻影中断（例如 Node 18 缺少 Array.prototype.with()），
      // 掩盖了真正的原因。
      yield createAssistantAPIErrorMessage({
        content: errorMessage,
      })

      // 为了帮助追查 bug，高调记录
      logAntError('Query error', error)
      logForDebugging('[query] 循环终止: model_error', { level: 'error' })
      return { reason: 'model_error', error }
    }

    // 检测缓存命中率并在需要时 yield 警告消息
    // 必须在 executePostSamplingHooks 之前执行，确保警告消息在工具结果之前显示
    if (
      assistantMessages.length > 0 &&
      !toolUseContext.options.isNonInteractiveSession
    ) {
      const lastAssistant = assistantMessages.at(-1)
      const usage = lastAssistant?.message?.usage as
        | {
            input_tokens: number
            cache_creation_input_tokens: number
            cache_read_input_tokens: number
          }
        | undefined
      if (usage && isCacheWarningEnabled()) {
        const warningInfo = shouldShowCacheWarning(
          usage,
          querySource,
          getCacheThreshold(),
        )
        if (warningInfo) {
          yield createCacheWarningMessage(warningInfo)
        }
      }
    }

    // 在模型响应完成之后执行 post-sampling hooks
    if (assistantMessages.length > 0) {
      void executePostSamplingHooks(
        messagesForQuery.concat(assistantMessages),
        systemPrompt,
        userContext,
        systemContext,
        toolUseContext,
        querySource,
      )
    }

    // 我们必须先处理流式中断，比任何其它事都早。
    // 使用 streamingToolExecutor 时，必须消费 getRemainingResults()，
    // 以便 executor 为排队/进行中的工具生成合成 tool_result 块。
    // 否则 tool_use 块会缺少匹配的 tool_result 块。
    if (toolUseContext.abortController.signal.aborted) {
      if (streamingToolExecutor) {
        // 消费剩余结果 —— executor 为中断的工具生成合成 tool_result，
        // 因为它在 executeTool() 中检查 abort 信号
        for await (const update of streamingToolExecutor.getRemainingResults()) {
          if (update.message) {
            yield update.message
          }
        }
      } else {
        yield* yieldMissingToolResultBlocks(
          assistantMessages,
          'Interrupted by user',
        )
      }
      // chicago MCP：中断时自动取消隐藏 + 释放锁。与 stopHooks.ts 中
      // 自然轮次结束路径相同的清理。仅主线程 —— 子 agent 释放主线程
      // 锁的原因见 stopHooks.ts。
      if (feature('CHICAGO_MCP') && !toolUseContext.agentId) {
        try {
          const { cleanupComputerUseAfterTurn } = await import(
            './utils/computerUse/cleanup.js'
          )
          await cleanupComputerUseAfterTurn(toolUseContext)
        } catch {
          // 失败静默处理 —— 这是 dogfooding 清理，不是关键路径
        }
      }

      // 对 submit 中断跳过中断消息 —— 后续排队的用户消息已提供足够上下文。
      if (toolUseContext.abortController.signal.reason !== 'interrupt') {
        yield createUserInterruptionMessage({
          toolUse: false,
        })
      }
      logForDebugging(
        '[query] 循环终止: aborted_streaming（流式响应中被中断）',
        { level: 'warn' },
      )
      return { reason: 'aborted_streaming' }
    }

    // yield 上一轮的工具使用摘要 —— haiku（约 1s）在模型流式输出
    //（5-30s）期间解析完成
    if (pendingToolUseSummary) {
      const summary = await pendingToolUseSummary
      if (summary) {
        yield summary
      }
    }

    if (!needsFollowUp) {
      const lastMessage = assistantMessages.at(-1)

      // Prompt-too-long 恢复：流式循环扣留了错误（见上方的
      // withheldByCollapse / withheldByReactive）。先尝试 collapse 排空
      //（便宜，保留细粒度上下文），再尝试 reactive compact（完整摘要）。
      // 每个阶段单次尝试 —— 若重试仍 413，由下一阶段处理或错误冒泡。
      const isWithheld413 =
        lastMessage?.type === 'assistant' &&
        lastMessage.isApiErrorMessage &&
        isPromptTooLongMessage(lastMessage)
      // 媒体尺寸拒绝（图片/PDF/多图）可通过 reactive compact 的
      // strip-retry 恢复。与 PTL 不同，媒体错误跳过 collapse 排空 ——
      // collapse 不剥离图片。mediaRecoveryEnabled 是流循环之前上提的
      // 门控（与扣留检查的值相同 —— 两者必须一致，否则扣留的消息会
      // 丢失）。若超大媒体位于保留尾部，压缩后的轮次会再次媒体报错；
      // hasAttemptedReactiveCompact 防止螺旋，错误冒泡。
      const isWithheldMedia =
        mediaRecoveryEnabled &&
        reactiveCompact?.isWithheldMediaSizeError(lastMessage as Message)
      if (isWithheld413) {
        logForDebugging(
          `[Hapii] Query PTL恢复 — 收到 413/prompt_too_long，开始尝试 collapse_drain_retry，上次 transition=${state.transition?.reason ?? 'none'}`,
          { level: 'warn' },
        )
        // 首先：排空所有已分阶段的 context-collapse。门控条件是上一次
        // transition 不是 collapse_drain_retry —— 若已排空且重试仍 413，
        // 落到 reactive compact。
        if (
          feature('CONTEXT_COLLAPSE') &&
          contextCollapse &&
          state.transition?.reason !== 'collapse_drain_retry'
        ) {
          const drained = contextCollapse.recoverFromOverflow(
            messagesForQuery,
            querySource,
          )
          if (drained.committed > 0) {
            const next: State = {
              messages: drained.messages,
              toolUseContext,
              autoCompactTracking: tracking,
              maxOutputTokensRecoveryCount,
              hasAttemptedReactiveCompact,
              maxOutputTokensOverride: undefined,
              pendingToolUseSummary: undefined,
              stopHookActive: undefined,
              turnCount,
              transition: {
                reason: 'collapse_drain_retry',
                committed: drained.committed,
              },
            }
            state = next
            continue
          }
        }
      }
      if ((isWithheld413 || isWithheldMedia) && reactiveCompact) {
        logForDebugging(
          `[Hapii] Query PTL恢复 — 进入 reactive_compact_retry 阶段 isWithheld413=${isWithheld413} isWithheldMedia=${isWithheldMedia} hasAttempted=${hasAttemptedReactiveCompact}`,
          { level: 'warn' },
        )
        const compacted = await reactiveCompact.tryReactiveCompact({
          hasAttempted: hasAttemptedReactiveCompact,
          querySource,
          aborted: toolUseContext.abortController.signal.aborted,
          messages: messagesForQuery,
          cacheSafeParams: {
            systemPrompt,
            userContext,
            systemContext,
            toolUseContext,
            forkContextMessages: messagesForQuery,
          },
        })

        if (compacted) {
          // task_budget：与上面的主动路径相同的延续语义。
          // 这里 messagesForQuery 仍持有压缩前的数组（那次 413 失败
          // 尝试的输入）。
          if (params.taskBudget) {
            const preCompactContext =
              finalContextTokensFromLastResponse(messagesForQuery)
            taskBudgetRemaining = Math.max(
              0,
              (taskBudgetRemaining ?? params.taskBudget.total) -
                preCompactContext,
            )
          }

          const postCompactMessages = buildPostCompactMessages(compacted)
          for (const msg of postCompactMessages) {
            yield msg
          }
          const next: State = {
            messages: postCompactMessages,
            toolUseContext,
            autoCompactTracking: undefined,
            maxOutputTokensRecoveryCount,
            hasAttemptedReactiveCompact: true,
            maxOutputTokensOverride: undefined,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            transition: { reason: 'reactive_compact_retry' },
          }
          state = next
          continue
        }

        // 无恢复 —— 暴露扣留的错误并退出。不要落到 stop hooks：
        // 模型从未产生有效响应，hooks 无有意义的东西可评估。在
        // prompt-too-long 上跑 stop hooks 会造成死亡螺旋：
        // 错误 → hook 阻塞 → 重试 → 错误 → …（hook 每轮注入更多 token）。
        yield lastMessage!
        void executeStopFailureHooks(lastMessage!, toolUseContext)
        logForDebugging(
          `[query] 循环终止: ${isWithheldMedia ? 'image_error' : 'prompt_too_long'}`,
          { level: 'error' },
        )
        return { reason: isWithheldMedia ? 'image_error' : 'prompt_too_long' }
      } else if (feature('CONTEXT_COLLAPSE') && isWithheld413) {
        // reactiveCompact 被编译掉，但 contextCollapse 扣留了且无法
        // 恢复（分阶段队列空/陈旧）。暴露错误。同样提前返回的理由 ——
        // 不要落到 stop hooks。
        yield lastMessage
        void executeStopFailureHooks(lastMessage, toolUseContext)
        logForDebugging(
          '[query] 循环终止: prompt_too_long（上下文折叠也无法恢复）',
          { level: 'error' },
        )
        return { reason: 'prompt_too_long' }
      }

      // 检查 max_output_tokens 并注入恢复消息。错误已在上方流中
      // 扣留；仅在恢复耗尽时才暴露。
      if (isWithheldMaxOutputTokens(lastMessage)) {
        // 升级重试：如果我们用的是 8k 默认上限并撞到限制，就以 64k
        // 重试同一请求 —— 没有元消息，没有多轮周旋。每轮触发一次
        //（由 override 检查保护），然后若 64k 也撞顶就落到多轮恢复。
        // 3P 默认：false（未在 Bedrock/Vertex 上验证）
        const capEnabled = getFeatureValue_CACHED_MAY_BE_STALE(
          'tengu_otk_slot_v1',
          false,
        )
        if (
          capEnabled &&
          maxOutputTokensOverride === undefined &&
          !process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
        ) {
          logEvent('tengu_max_tokens_escalate', {
            escalatedTo: ESCALATED_MAX_TOKENS,
          })
          logForDebugging(
            `[Hapii] Query max_output_tokens_escalate — 8k→${ESCALATED_MAX_TOKENS}，重试本轮`,
            { level: 'warn' },
          )
          const next: State = {
            messages: messagesForQuery,
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount,
            hasAttemptedReactiveCompact,
            maxOutputTokensOverride: ESCALATED_MAX_TOKENS,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            transition: { reason: 'max_output_tokens_escalate' },
          }
          state = next
          continue
        }

        if (maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
          logForDebugging(
            `[Hapii] Query max_output_tokens_recovery — 第${maxOutputTokensRecoveryCount + 1}次注入续写 prompt（上限 ${MAX_OUTPUT_TOKENS_RECOVERY_LIMIT}）`,
            { level: 'warn' },
          )
          const recoveryMessage = createUserMessage({
            content:
              `Output token limit hit. Resume directly — no apology, no recap of what you were doing. ` +
              `Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.`,
            isMeta: true,
          })

          const next: State = {
            messages: [
              ...messagesForQuery,
              ...assistantMessages,
              recoveryMessage,
            ],
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount: maxOutputTokensRecoveryCount + 1,
            hasAttemptedReactiveCompact,
            maxOutputTokensOverride: undefined,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            transition: {
              reason: 'max_output_tokens_recovery',
              attempt: maxOutputTokensRecoveryCount + 1,
            },
          }
          state = next
          continue
        }

        // 恢复耗尽 —— 现在暴露扣留的错误。
        yield lastMessage
      }

      // 当最后一条消息是 API 错误（限流、prompt-too-long、鉴权失败等）
      // 时跳过 stop hooks。模型从未产生真正的响应 —— 让 hooks 评估它
      // 会造成死亡螺旋：错误 → hook 阻塞 → 重试 → 错误 → …
      if (lastMessage?.isApiErrorMessage) {
        void executeStopFailureHooks(lastMessage, toolUseContext)
        return {
          reason: 'model_error',
          error: lastMessage.error ?? lastMessage.apiError ?? 'api_error',
        }
      }

      logForDebugging(
        `[Hapii] Query.handleStopHooks 调用 — assistantMsgs=${assistantMessages.length} querySource=${querySource} stopHookActive=${state.stopHookActive}`,
        { level: 'info' },
      )
      const stopHookResult = yield* handleStopHooks(
        messagesForQuery,
        assistantMessages,
        systemPrompt,
        userContext,
        systemContext,
        toolUseContext,
        querySource,
        stopHookActive,
      )

      if (stopHookResult.preventContinuation) {
        logForDebugging('[query] 循环终止: stop_hook_prevented', {
          level: 'info',
        })
        return { reason: 'stop_hook_prevented' }
      }

      if (stopHookResult.blockingErrors.length > 0) {
        const next: State = {
          messages: [
            ...messagesForQuery,
            ...assistantMessages,
            ...stopHookResult.blockingErrors,
          ],
          toolUseContext,
          autoCompactTracking: tracking,
          maxOutputTokensRecoveryCount: 0,
          // 保留 reactive compact 守卫 —— 若 compact 已运行且无法从
          // prompt-too-long 恢复，在 stop-hook 阻塞错误后重试会产生相同
          // 结果。在此重置为 false 曾导致死循环：compact → 仍然过长 →
          // 错误 → stop hook 阻塞 → compact → … 烧掉数千次 API 调用。
          hasAttemptedReactiveCompact,
          maxOutputTokensOverride: undefined,
          pendingToolUseSummary: undefined,
          stopHookActive: true,
          turnCount,
          transition: { reason: 'stop_hook_blocking' },
        }
        state = next
        continue
      }

      if (feature('TOKEN_BUDGET')) {
        const decision = checkTokenBudget(
          budgetTracker!,
          toolUseContext.agentId,
          getCurrentTurnTokenBudget(),
          getTurnOutputTokens(),
        )

        if (decision.action === 'continue') {
          incrementBudgetContinuationCount()
          logForDebugging(
            `Token budget continuation #${decision.continuationCount}: ${decision.pct}% (${decision.turnTokens.toLocaleString()} / ${decision.budget.toLocaleString()})`,
          )
          state = {
            messages: [
              ...messagesForQuery,
              ...assistantMessages,
              createUserMessage({
                content: decision.nudgeMessage,
                isMeta: true,
              }),
            ],
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount: 0,
            hasAttemptedReactiveCompact: false,
            maxOutputTokensOverride: undefined,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            transition: { reason: 'token_budget_continuation' },
          }
          continue
        }

        if (decision.completionEvent) {
          if (decision.completionEvent.diminishingReturns) {
            logForDebugging(
              `Token budget early stop: diminishing returns at ${decision.completionEvent.pct}%`,
            )
          }
          logEvent('tengu_token_budget_completed', {
            ...decision.completionEvent,
            queryChainId: queryChainIdForAnalytics,
            queryDepth: queryTracking.depth,
          })
        }
      }

      logForDebugging('[Hapii] Query.queryLoop 终止 reason=completed', {
        level: 'info',
      })
      logForDebugging('[query] 循环终止: completed（正常完成，无工具调用）', {
        level: 'info',
      })
      return { reason: 'completed' }
    }

    let shouldPreventContinuation = false
    let updatedToolUseContext = toolUseContext

    queryCheckpoint('query_tool_execution_start')

    if (streamingToolExecutor) {
      logEvent('tengu_streaming_tool_execution_used', {
        tool_count: toolUseBlocks.length,
        queryChainId: queryChainIdForAnalytics,
        queryDepth: queryTracking.depth,
      })
    } else {
      logEvent('tengu_streaming_tool_execution_not_used', {
        tool_count: toolUseBlocks.length,
        queryChainId: queryChainIdForAnalytics,
        queryDepth: queryTracking.depth,
      })
    }

    logForDebugging(
      `[query] 开始执行工具, 工具列表=[${toolUseBlocks.map(b => b.name).join(', ')}]`,
      { level: 'info' },
    )
    const toolUpdates = streamingToolExecutor
      ? streamingToolExecutor.getRemainingResults()
      : runTools(toolUseBlocks, assistantMessages, canUseTool, toolUseContext)

    for await (const update of toolUpdates) {
      if (update.message) {
        yield update.message

        if (
          update.message.type === 'attachment' &&
          update.message.attachment!.type === 'hook_stopped_continuation'
        ) {
          shouldPreventContinuation = true
        }

        toolResults.push(
          ...normalizeMessagesForAPI(
            [update.message],
            toolUseContext.options.tools,
          ).filter(_ => _.type === 'user'),
        )
      }
      if (update.newContext) {
        updatedToolUseContext = {
          ...update.newContext,
          queryTracking,
        }
      }
    }
    queryCheckpoint('query_tool_execution_end')
    logForDebugging(`[query] 工具执行完成, 结果消息数=${toolResults.length}`, {
      level: 'info',
    })

    // 在工具批次完成之后生成工具使用摘要 —— 传递给下一次递归调用
    let nextPendingToolUseSummary:
      | Promise<ToolUseSummaryMessage | null>
      | undefined
    if (
      config.gates.emitToolUseSummaries &&
      toolUseBlocks.length > 0 &&
      !toolUseContext.abortController.signal.aborted &&
      !toolUseContext.agentId // 子 agent 不在移动端 UI 中展示 —— 跳过 Haiku 调用
    ) {
      // 提取最后一条 assistant 文本块作为上下文
      const lastAssistantMessage = assistantMessages.at(-1)
      let lastAssistantText: string | undefined
      if (lastAssistantMessage) {
        const textBlocks = (
          Array.isArray(lastAssistantMessage.message?.content)
            ? (lastAssistantMessage.message.content as Array<{
                type: string
                text?: string
              }>)
            : []
        ).filter(block => block.type === 'text')
        if (textBlocks.length > 0) {
          const lastTextBlock = textBlocks.at(-1)
          if (lastTextBlock && 'text' in lastTextBlock) {
            lastAssistantText = lastTextBlock.text
          }
        }
      }

      // 收集工具信息以生成摘要
      const toolUseIds = toolUseBlocks.map(block => block.id)
      const toolInfoForSummary = toolUseBlocks.map(block => {
        // 找到对应的工具结果
        const toolResult = toolResults.find(
          result =>
            result.type === 'user' &&
            Array.isArray(result.message.content) &&
            result.message.content.some(
              content =>
                content.type === 'tool_result' &&
                content.tool_use_id === block.id,
            ),
        )
        const resultContent =
          toolResult?.type === 'user' &&
          Array.isArray(toolResult.message.content)
            ? toolResult.message.content.find(
                (c): c is ToolResultBlockParam =>
                  c.type === 'tool_result' && c.tool_use_id === block.id,
              )
            : undefined
        return {
          name: block.name,
          input: block.input,
          output:
            resultContent && 'content' in resultContent
              ? resultContent.content
              : null,
        }
      })

      // 启动摘要生成而不阻塞下一次 API 调用
      nextPendingToolUseSummary = generateToolUseSummary({
        tools: toolInfoForSummary,
        signal: toolUseContext.abortController.signal,
        isNonInteractiveSession: toolUseContext.options.isNonInteractiveSession,
        lastAssistantText,
      })
        .then(summary => {
          if (summary) {
            return createToolUseSummaryMessage(summary, toolUseIds)
          }
          return null
        })
        .catch(() => null)
    }

    // 我们在工具调用期间被中断
    if (toolUseContext.abortController.signal.aborted) {
      // chicago MCP：工具调用中途被中断时自动取消隐藏 + 释放锁。
      // 这是 CU 最常见的 Ctrl+C 路径（例如慢截图）。仅主线程 ——
      // 子 agent 的原因见 stopHooks.ts。
      if (feature('CHICAGO_MCP') && !toolUseContext.agentId) {
        try {
          const { cleanupComputerUseAfterTurn } = await import(
            './utils/computerUse/cleanup.js'
          )
          await cleanupComputerUseAfterTurn(toolUseContext)
        } catch {
          // 失败静默处理 —— 这是 dogfooding 清理，不是关键路径
        }
      }
      // 对 submit 中断跳过中断消息 —— 后续排队的用户消息已提供足够上下文。
      if (toolUseContext.abortController.signal.reason !== 'interrupt') {
        yield createUserInterruptionMessage({
          toolUse: true,
        })
      }
      // 中断返回前检查 maxTurns
      const nextTurnCountOnAbort = turnCount + 1
      if (maxTurns && nextTurnCountOnAbort > maxTurns) {
        yield createAttachmentMessage({
          type: 'max_turns_reached',
          maxTurns,
          turnCount: nextTurnCountOnAbort,
        })
      }
      logForDebugging('[query] 循环终止: aborted_tools（工具执行中被中断）', {
        level: 'warn',
      })
      return { reason: 'aborted_tools' }
    }

    // 若 hook 表示阻止继续，在此停止
    if (shouldPreventContinuation) {
      logForDebugging('[query] 循环终止: hook_stopped（hook 阻止继续）', {
        level: 'info',
      })
      return { reason: 'hook_stopped' }
    }

    if (tracking?.compacted) {
      tracking.turnCounter++
      logEvent('tengu_post_autocompact_turn', {
        turnId:
          tracking.turnId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        turnCounter: tracking.turnCounter,

        queryChainId: queryChainIdForAnalytics,
        queryDepth: queryTracking.depth,
      })
    }

    // 注意：必须在工具调用完成之后再做这件事，因为 API 会报错
    // 如果我们交错 tool_result 消息和普通 user 消息。

    // 埋点：在追加附件之前追踪消息数量
    logEvent('tengu_query_before_attachments', {
      messagesForQueryCount: messagesForQuery.length,
      assistantMessagesCount: assistantMessages.length,
      toolResultsCount: toolResults.length,
      queryChainId: queryChainIdForAnalytics,
      queryDepth: queryTracking.depth,
    })

    // 在处理附件之前获取排队命令的快照。这些将作为附件发送，
    // 让 Claude 在当前轮次内响应它们。
    //
    // 排空待处理通知。LocalShellTask 完成是 'next'（当 MONITOR_TOOL 打开时），
    // 不经 Sleep 直接排空。其他任务类型（agent/workflow/framework）仍默认
    // 为 'later' —— 由 Sleep flush 覆盖。若所有任务类型都迁移到 'next'，
    // 此分支可移除。
    //
    // Slash 命令被排除在轮次内排空之外 —— 它们必须在轮次结束后
    //（通过 useQueueProcessor）走 processSlashCommand 流程，而不是作为
    // 文本发给模型。Bash 模式命令已被 getQueuedCommandAttachments 的
    // INLINE_NOTIFICATION_MODES 排除。
    //
    // Agent 作用域：队列是进程全局单例，由协调器和所有进程内子 agent
    // 共享。每个循环只排空发给自己的内容 —— 主线程排空
    // agentId===undefined，子 agent 排空自己的 agentId。用户 prompt
    //（mode:'prompt'）仍只发给主线程；子 agent 看不到 prompt 流。
    // eslint-disable-next-line custom-rules/require-tool-match-name -- ToolUseBlock.name has no aliases
    const sleepRan = toolUseBlocks.some(b => b.name === SLEEP_TOOL_NAME)
    const isMainThread =
      querySource.startsWith('repl_main_thread') || querySource === 'sdk'
    const currentAgentId = toolUseContext.agentId
    const queuedCommandsSnapshot = getCommandsByMaxPriority(
      sleepRan ? 'later' : 'next',
    ).filter(cmd => {
      if (isSlashCommand(cmd)) return false
      if (isMainThread) return cmd.agentId === undefined
      // 子 agent 只排空发给自己的 task-notification —— 绝不排空用户
      // prompt，即便有人给 prompt 加上了 agentId。
      return cmd.mode === 'task-notification' && cmd.agentId === currentAgentId
    })
    const queuedAutonomyClaim = await claimConsumableQueuedAutonomyCommands(
      queuedCommandsSnapshot,
    )
    if (queuedAutonomyClaim.staleCommands.length > 0) {
      removeFromQueue(queuedAutonomyClaim.staleCommands)
    }

    const claimedConsumedCommands = queuedAutonomyClaim.claimedCommands.filter(
      cmd => cmd.mode === 'prompt' || cmd.mode === 'task-notification',
    )
    if (claimedConsumedCommands.length > 0) {
      consumedAutonomyCommands.push(...claimedConsumedCommands)
      for (const cmd of claimedConsumedCommands) {
        if (cmd.uuid) {
          consumedCommandUuids.push(cmd.uuid)
          notifyCommandLifecycle(cmd.uuid, 'started')
        }
      }
      removeFromQueue(claimedConsumedCommands)
    }

    for await (const attachment of getAttachmentMessages(
      null,
      updatedToolUseContext,
      null,
      queuedAutonomyClaim.attachmentCommands,
      messagesForQuery.concat(assistantMessages, toolResults),
      querySource,
    )) {
      yield attachment
      toolResults.push(attachment)
    }

    // memory 预取消费：仅在已 settle 且之前迭代未消费时进行。
    // 若尚未 settle，跳过（零等待）下次迭代重试 —— 预取在轮次结束前
    // 有多少次循环迭代就有多少次机会。readFileState（跨迭代累计）
    // 过滤掉模型已经 Read/Wrote/Edited 的记忆 —— 包括早期迭代中的，
    // 这一点是 per-iteration 的 toolUseBlocks 数组会漏掉的。
    if (
      pendingMemoryPrefetch &&
      pendingMemoryPrefetch.settledAt !== null &&
      pendingMemoryPrefetch.consumedOnIteration === -1
    ) {
      const memoryAttachments = filterDuplicateMemoryAttachments(
        await pendingMemoryPrefetch.promise,
        toolUseContext.readFileState,
      )
      for (const memAttachment of memoryAttachments) {
        const msg = createAttachmentMessage(memAttachment)
        yield msg
        toolResults.push(msg)
      }
      pendingMemoryPrefetch.consumedOnIteration = turnCount - 1
    }

    // 注入预取的技能发现。collectSkillDiscoveryPrefetch 发出
    // hidden_by_main_turn —— 当预取在此点之前解析完成时为 true
    //（在 AKI@250ms / Haiku@573ms 相对于 2-30s 轮次时长下应 >98%）。
    if (skillPrefetch && pendingSkillPrefetch) {
      const skillAttachments =
        await skillPrefetch.collectSkillDiscoveryPrefetch(pendingSkillPrefetch)
      for (const att of skillAttachments) {
        const msg = createAttachmentMessage(att)
        yield msg
        toolResults.push(msg)
      }
    }

    // 注入预取的工具发现。
    if (searchExtraToolsPrefetch && pendingToolPrefetch) {
      const toolAttachments =
        await searchExtraToolsPrefetch.collectSearchExtraToolsPrefetch(
          pendingToolPrefetch,
        )
      for (const att of toolAttachments) {
        const msg = createAttachmentMessage(att)
        yield msg
        toolResults.push(msg)
      }
    }

    // 仅移除真正作为附件消费的命令。Prompt 和 task-notification 命令
    // 在上面被转换为附件。
    const claimedCommandSet = new Set(claimedConsumedCommands)
    const consumedCommands = queuedAutonomyClaim.attachmentCommands.filter(
      cmd =>
        (cmd.mode === 'prompt' || cmd.mode === 'task-notification') &&
        !claimedCommandSet.has(cmd),
    )
    if (consumedCommands.length > 0) {
      for (const cmd of consumedCommands) {
        if (cmd.uuid) {
          consumedCommandUuids.push(cmd.uuid)
          notifyCommandLifecycle(cmd.uuid, 'started')
        }
      }
      removeFromQueue(consumedCommands)
    }

    // 埋点：在文件变更附件追加之后追踪其数量
    const fileChangeAttachmentCount = count(
      toolResults,
      tr =>
        tr.type === 'attachment' && tr.attachment.type === 'edited_text_file',
    )

    logEvent('tengu_query_after_attachments', {
      totalToolResultsCount: toolResults.length,
      fileChangeAttachmentCount,
      queryChainId: queryChainIdForAnalytics,
      queryDepth: queryTracking.depth,
    })

    // 轮次间刷新工具，让新连接的 MCP server 可用
    if (updatedToolUseContext.options.refreshTools) {
      const refreshedTools = updatedToolUseContext.options.refreshTools()
      if (refreshedTools !== updatedToolUseContext.options.tools) {
        updatedToolUseContext = {
          ...updatedToolUseContext,
          options: {
            ...updatedToolUseContext.options,
            tools: refreshedTools,
          },
        }
      }
    }

    const toolUseContextWithQueryTracking = {
      ...updatedToolUseContext,
      queryTracking,
    }

    // 每次拿到工具结果并准备递归时，就是一轮
    const nextTurnCount = turnCount + 1

    // `claude ps` 的周期性任务摘要 —— 在轮次中途触发，让长时间运行的
    // agent 仍能刷新自己在做什么。仅以 !agentId 门控，让每个顶层对话
    //（REPL、SDK、HFI、remote）都生成摘要；子 agent/fork 不生成。
    if (feature('BG_SESSIONS')) {
      if (
        !toolUseContext.agentId &&
        taskSummaryModule!.shouldGenerateTaskSummary()
      ) {
        taskSummaryModule!.maybeGenerateTaskSummary({
          systemPrompt,
          userContext,
          systemContext,
          toolUseContext,
          forkContextMessages: messagesForQuery.concat(
            assistantMessages,
            toolResults,
          ),
        })
      }
    }

    // 检查是否达到最大轮次限制
    if (maxTurns && nextTurnCount > maxTurns) {
      yield createAttachmentMessage({
        type: 'max_turns_reached',
        maxTurns,
        turnCount: nextTurnCount,
      })
      logForDebugging(`[query] 循环终止: max_turns=${nextTurnCount}`, {
        level: 'warn',
      })
      return { reason: 'max_turns', turnCount: nextTurnCount }
    }

    queryCheckpoint('query_recursive_call')
    logForDebugging(
      `[Hapii] Query next_turn 继续 — 第${nextTurnCount}轮完成，追加 assistantMsgs=${assistantMessages.length} toolResults=${toolResults.length}，新 messages=${messagesForQuery.length + assistantMessages.length + toolResults.length}`,
      { level: 'info' },
    )
    const next: State = {
      messages: messagesForQuery.concat(assistantMessages, toolResults),
      toolUseContext: toolUseContextWithQueryTracking,
      autoCompactTracking: tracking,
      turnCount: nextTurnCount,
      maxOutputTokensRecoveryCount: 0,
      hasAttemptedReactiveCompact: false,
      pendingToolUseSummary: nextPendingToolUseSummary,
      maxOutputTokensOverride: undefined,
      stopHookActive,
      transition: { reason: 'next_turn' },
    }
    state = next
  } // while (true)
}
