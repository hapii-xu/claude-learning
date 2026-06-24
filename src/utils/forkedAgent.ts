/**
 * 带使用量跟踪的 forked agent 查询循环辅助工具。
 *
 * 此工具确保 forked agent：
 * 1. 与父 agent 共享完全相同的缓存关键参数，以保证 prompt 缓存命中
 * 2. 跨整个查询循环跟踪完整的使用量指标
 * 3. 完成时通过 tengu_fork_agent_query 事件记录指标
 * 4. 隔离可变状态，防止干扰主 agent 循环
 */

import type { UUID } from 'crypto'
import { randomUUID } from 'crypto'
import type { PromptCommand } from '../commands.js'
import type { QuerySource } from '../constants/querySource.js'
import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import { query } from '../query.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import { accumulateUsage, updateUsage } from '../services/api/claude.js'
import { EMPTY_USAGE, type NonNullableUsage } from '@ant/model-provider'
import type {
  BetaRawMessageDeltaEvent,
  BetaRawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.js'
import type { ToolUseContext } from '../Tool.js'
import type { AgentDefinition } from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import type { AgentId } from '../types/ids.js'
import type { Message, StreamEvent } from '../types/message.js'
import { createChildAbortController } from './abortController.js'
import { logForDebugging } from './debug.js'
import { cloneFileStateCache } from './fileStateCache.js'
import type { REPLHookContext } from './hooks/postSamplingHooks.js'
import {
  createUserMessage,
  extractTextContent,
  getLastAssistantMessage,
} from './messages.js'
import { createDenialTrackingState } from './permissions/denialTracking.js'
import { parseToolListFromCLI } from './permissions/permissionSetup.js'
import { recordSidechainTranscript } from './sessionStorage.js'
import type { SystemPrompt } from './systemPromptType.js'
import {
  type ContentReplacementState,
  cloneContentReplacementState,
} from './toolResultStorage.js'
import { createAgentId } from './uuid.js'

/**
 * fork 与父 API 请求之间必须完全相同的参数，以共享父 agent 的 prompt 缓存。
 * Anthropic API 缓存键由以下内容组成：
 * system prompt、tools、model、messages（前缀）和 thinking config。
 *
 * CacheSafeParams 携带前五项。Thinking config 从继承的
 * toolUseContext.options.thinkingConfig 派生 — 但若 fork 设置了 maxOutputTokens
 * 可能会无意中修改（会在 claude.ts 中截断 budget_tokens，但仅限于
 * 不使用自适应思维的旧模型）。
 * 参见 ForkedAgentParams 上的 maxOutputTokens 文档。
 */
export type CacheSafeParams = {
  /** System prompt - 缓存命中时必须与父 agent 匹配 */
  systemPrompt: SystemPrompt
  /** 用户上下文 - 前置于消息，影响缓存 */
  userContext: { [k: string]: string }
  /** 系统上下文 - 追加到 system prompt，影响缓存 */
  systemContext: { [k: string]: string }
  /** 包含 tools、model 和其他选项的工具使用上下文 */
  toolUseContext: ToolUseContext
  /** 用于 prompt 缓存共享的父上下文消息 */
  forkContextMessages: Message[]
}

// 每轮结束后由 handleStopHooks 写入的槽，使轮后 fork
// （promptSuggestion、postTurnSummary、/btw）可共享主循环的
// prompt 缓存，无需每个调用方传递参数。
let lastCacheSafeParams: CacheSafeParams | null = null

export function saveCacheSafeParams(params: CacheSafeParams | null): void {
  lastCacheSafeParams = params
}

export function getLastCacheSafeParams(): CacheSafeParams | null {
  return lastCacheSafeParams
}

export type ForkedAgentParams = {
  /** 启动 forked 查询循环的消息 */
  promptMessages: Message[]
  /** 必须与父查询匹配的缓存安全参数 */
  cacheSafeParams: CacheSafeParams
  /** forked agent 的权限检查函数 */
  canUseTool: CanUseToolFn
  /** 用于跟踪的来源标识符 */
  querySource: QuerySource
  /** 分析标签（如 'session_memory'、'supervisor'） */
  forkLabel: string
  /** subagent 上下文的可选覆盖（如来自设置阶段的 readFileState） */
  overrides?: SubagentContextOverrides
  /**
   * 可选的输出 token 上限。注意：设置此项会同时改变 max_tokens
   * 和 budget_tokens（通过 claude.ts 中的截断）。若 fork 使用 cacheSafeParams
   * 共享父 agent 的 prompt 缓存，不同的 budget_tokens 会使缓存失效
   * — thinking config 是缓存键的一部分。仅在不需要缓存共享时设置（如压缩摘要）。
   */
  maxOutputTokens?: number
  /** 可选的轮次（API 往返）上限 */
  maxTurns?: number
  /** 每条消息到达时的可选回调（用于流式 UI） */
  onMessage?: (message: Message) => void
  /** 跳过旁链转录记录（如用于推测等临时工作） */
  skipTranscript?: boolean
  /** 跳过最后一条消息的新 prompt 缓存条目写入。
   *  用于不会再读取此前缀的即发即忘 fork。 */
  skipCacheWrite?: boolean
}

export type ForkedAgentResult = {
  /** 查询循环期间产出的所有消息 */
  messages: Message[]
  /** 循环中所有 API 调用的累计使用量 */
  totalUsage: NonNullableUsage
}

/**
 * 从 REPLHookContext 创建 CacheSafeParams。
 * 在从采样后钩子上下文 fork 时使用此辅助函数。
 *
 * 若要覆盖特定字段（如带克隆文件状态的 toolUseContext），
 * 展开结果后覆盖：`{ ...createCacheSafeParams(context), toolUseContext: clonedContext }`
 *
 * @param context - 采样后钩子的 REPLHookContext
 */
export function createCacheSafeParams(
  context: REPLHookContext,
): CacheSafeParams {
  return {
    systemPrompt: context.systemPrompt,
    userContext: context.userContext,
    systemContext: context.systemContext,
    toolUseContext: context.toolUseContext,
    forkContextMessages: context.messages,
  }
}

/**
 * 创建一个将允许工具添加到权限上下文的修改版 getAppState。
 * 供 forked skill/command 执行时授予工具权限。
 */
export function createGetAppStateWithAllowedTools(
  baseGetAppState: ToolUseContext['getAppState'],
  allowedTools: string[],
): ToolUseContext['getAppState'] {
  if (allowedTools.length === 0) return baseGetAppState
  return () => {
    const appState = baseGetAppState()
    return {
      ...appState,
      toolPermissionContext: {
        ...appState.toolPermissionContext,
        alwaysAllowRules: {
          ...appState.toolPermissionContext.alwaysAllowRules,
          command: [
            ...new Set([
              ...(appState.toolPermissionContext.alwaysAllowRules.command ||
                []),
              ...allowedTools,
            ]),
          ],
        },
      },
    }
  }
}

/**
 * 准备 forked command 上下文的结果。
 */
export type PreparedForkedContext = {
  /** 替换了参数的 skill 内容 */
  skillContent: string
  /** 带允许工具的修改版 getAppState */
  modifiedGetAppState: ToolUseContext['getAppState']
  /** 要使用的通用 agent */
  baseAgent: AgentDefinition
  /** 初始 prompt 消息 */
  promptMessages: Message[]
}

/**
 * 准备执行 forked command/skill 的上下文。
 * 处理 SkillTool 和斜杠命令都需要的通用设置。
 */
export async function prepareForkedCommandContext(
  command: PromptCommand,
  args: string,
  context: ToolUseContext,
): Promise<PreparedForkedContext> {
  // Get skill content with $ARGUMENTS replaced
  const skillPrompt = await command.getPromptForCommand(args, context)
  const skillContent = skillPrompt
    .map(block => (block.type === 'text' ? block.text : ''))
    .join('\n')

  // 解析并准备允许的工具
  const allowedTools = parseToolListFromCLI(command.allowedTools ?? [])

  // 创建带允许工具的修改版上下文
  const modifiedGetAppState = createGetAppStateWithAllowedTools(
    context.getAppState,
    allowedTools,
  )

  // 若指定了 command.agent 则使用，否则使用 'general-purpose'
  const agentTypeName = command.agent ?? 'general-purpose'
  const agents = context.options.agentDefinitions.activeAgents
  const baseAgent =
    agents.find(a => a.agentType === agentTypeName) ??
    agents.find(a => a.agentType === 'general-purpose') ??
    agents[0]

  if (!baseAgent) {
    throw new Error('No agent available for forked execution')
  }

  // 准备 prompt 消息
  const promptMessages = [createUserMessage({ content: skillContent })]

  return {
    skillContent,
    modifiedGetAppState,
    baseAgent,
    promptMessages,
  }
}

/**
 * 从 agent 消息中提取结果文本。
 */
export function extractResultText(
  agentMessages: Message[],
  defaultText = 'Execution completed',
): string {
  const lastAssistantMessage = getLastAssistantMessage(agentMessages)
  if (!lastAssistantMessage) return defaultText

  const textContent = extractTextContent(
    Array.isArray(lastAssistantMessage.message.content)
      ? lastAssistantMessage.message.content
      : [],
    '\n',
  )

  return textContent || defaultText
}

/**
 * 创建 subagent 上下文的选项。
 *
 * 默认情况下，所有可变状态均隔离以防止干扰父 agent。
 * 使用这些选项可以：
 * - 覆盖特定字段（如自定义 options、agentId、messages）
 * - 显式选择共享特定回调（用于交互式 subagent）
 */
export type SubagentContextOverrides = {
  /** 覆盖 options 对象（如自定义 tools、model） */
  options?: ToolUseContext['options']
  /** 覆盖 agentId（用于有自己 ID 的 subagent） */
  agentId?: AgentId
  /** 覆盖 agentType（用于特定类型的 subagent） */
  agentType?: string
  /** 覆盖 messages 数组 */
  messages?: Message[]
  /** 覆盖 readFileState（如用全新缓存替代克隆） */
  readFileState?: ToolUseContext['readFileState']
  /** 覆盖 abortController */
  abortController?: AbortController
  /** 覆盖 getAppState 函数 */
  getAppState?: ToolUseContext['getAppState']

  /**
   * 显式选择共享父 agent 的 setAppState 回调。
   * 用于需要更新共享状态的交互式 subagent。
   * @default false（隔离的空操作）
   */
  shareSetAppState?: boolean
  /**
   * 显式选择共享父 agent 的 setResponseLength 回调。
   * 用于贡献父 agent 响应指标的 subagent。
   * @default false（隔离的空操作）
   */
  shareSetResponseLength?: boolean
  /**
   * 显式选择共享父 agent 的 abortController。
   * 用于应随父 agent 一起中止的交互式 subagent。
   * 注意：仅在未提供 abortController 覆盖时适用。
   * @default false（新控制器链接到父 agent）
   */
  shareAbortController?: boolean
  /** 每轮用户消息都需重新注入的关键系统提醒 */
  criticalSystemReminder_EXPERIMENTAL?: string
  /** 为 true 时，即使钩子自动批准也必须始终调用 canUseTool。
   *  供推测用于覆盖文件路径重写。 */
  requireCanUseTool?: boolean
  /** 覆盖替换状态 — 由 resumeAgentBackground 用于传递
   * 从恢复的旁链重建的状态，以便相同结果被重新替换（prompt 缓存稳定性）。 */
  contentReplacementState?: ContentReplacementState
}

/**
 * 为 subagent 创建隔离的 ToolUseContext。
 *
 * 默认情况下，所有可变状态均隔离以防止干扰：
 * - readFileState：从父 agent 克隆
 * - abortController：新控制器链接到父 agent（父 agent 中止会传播）
 * - getAppState：包装以设置 shouldAvoidPermissionPrompts
 * - 所有变更回调（setAppState 等）：空操作
 * - 全新集合：nestedMemoryAttachmentTriggers、toolDecisions
 *
 * 调用方可以：
 * - 通过 overrides 参数覆盖特定字段
 * - 显式选择共享特定回调（shareSetAppState 等）
 *
 * @param parentContext - 用于创建 subagent 上下文的父 ToolUseContext
 * @param overrides - 可选的覆盖和共享选项
 *
 * @example
 * // 完全隔离（用于会话内存等后台 agent）
 * const ctx = createSubagentContext(parentContext)
 *
 * @example
 * // 自定义 options 和 agentId（用于 AgentTool 异步 agent）
 * const ctx = createSubagentContext(parentContext, {
 *   options: customOptions,
 *   agentId: newAgentId,
 *   messages: initialMessages,
 * })
 *
 * @example
 * // 共享部分状态的交互式 subagent
 * const ctx = createSubagentContext(parentContext, {
 *   options: customOptions,
 *   agentId: newAgentId,
 *   shareSetAppState: true,
 *   shareSetResponseLength: true,
 *   shareAbortController: true,
 * })
 */
export function createSubagentContext(
  parentContext: ToolUseContext,
  overrides?: SubagentContextOverrides,
): ToolUseContext {
  // 确定 abortController：显式覆盖 > 共享父 agent 的 > 新子控制器
  const abortController =
    overrides?.abortController ??
    (overrides?.shareAbortController
      ? parentContext.abortController
      : createChildAbortController(parentContext.abortController))

  // 确定 getAppState - 包装以设置 shouldAvoidPermissionPrompts，除非共享 abortController
  //（若共享 abortController，则为可以显示 UI 的交互式 agent）
  const getAppState: ToolUseContext['getAppState'] = overrides?.getAppState
    ? overrides.getAppState
    : overrides?.shareAbortController
      ? parentContext.getAppState
      : () => {
          const state = parentContext.getAppState()
          if (state.toolPermissionContext.shouldAvoidPermissionPrompts) {
            return state
          }
          return {
            ...state,
            toolPermissionContext: {
              ...state.toolPermissionContext,
              shouldAvoidPermissionPrompts: true,
            },
          }
        }

  return {
    // 单独保留父 agent 的 Langfuse 追踪，以便 auto_mode 等嵌套旁查询
    // 能附加到主 agent 追踪而非 subagent 自身的追踪。
    langfuseRootTrace: parentContext.langfuseTrace,
    // 可变状态 - 默认克隆以保持隔离
    // 若提供了 overrides.readFileState 则克隆它，否则从父 agent 克隆
    readFileState: cloneFileStateCache(
      overrides?.readFileState ?? parentContext.readFileState,
    ),
    nestedMemoryAttachmentTriggers: new Set<string>(),
    loadedNestedMemoryPaths: new Set<string>(),
    dynamicSkillDirTriggers: new Set<string>(),
    // 每个 subagent：跟踪由发现机制呈现的 skill，用于 was_discovered 遥测（SkillTool.ts:116）
    discoveredSkillNames: new Set<string>(),
    toolDecisions: undefined,
    // 预算决策：覆盖 > 克隆父 agent > undefined（功能关闭）。
    //
    // 默认克隆（非全新）：缓存共享 fork 处理包含父 agent tool_use_ids 的父消息。
    // 全新状态会将其视为未见过，并做出不同的替换决策 → 线前缀不同 →
    // 缓存未命中。克隆会做出相同的决策 → 缓存命中。对于非 fork subagent，
    // 父 UUID 永远不匹配 — 克隆是无害的空操作。
    //
    // 覆盖：AgentTool 恢复（从旁链记录重建）
    // 和 inProcessRunner（每个 teammate 持久循环状态）。
    contentReplacementState:
      overrides?.contentReplacementState ??
      (parentContext.contentReplacementState
        ? cloneContentReplacementState(parentContext.contentReplacementState)
        : undefined),

    // AbortController
    abortController,

    // AppState 访问
    getAppState,
    setAppState: overrides?.shareSetAppState
      ? parentContext.setAppState
      : () => {},
    // 任务注册/终止必须始终到达根 store，即使 setAppState 是空操作
    // — 否则异步 agent 的后台 bash 任务不会被注册也不会被终止（PPID=1 僵尸进程）。
    setAppStateForTasks:
      parentContext.setAppStateForTasks ?? parentContext.setAppState,
    // setAppState 为空操作的异步 subagent 需要本地拒绝跟踪，
    // 以便拒绝计数器能跨重试实际累积。
    localDenialTracking: overrides?.shareSetAppState
      ? parentContext.localDenialTracking
      : createDenialTrackingState(),

    // 变更回调 - 默认为空操作
    setInProgressToolUseIDs: () => {},
    setResponseLength: overrides?.shareSetResponseLength
      ? parentContext.setResponseLength
      : () => {},
    pushApiMetricsEntry: overrides?.shareSetResponseLength
      ? parentContext.pushApiMetricsEntry
      : undefined,
    updateFileHistoryState: () => {},
    // Attribution 是有作用域且功能性的（prev => next）— 即使 setAppState 被存根也可安全共享。
    // 并发调用通过 React 的状态队列组合。
    updateAttributionState: parentContext.updateAttributionState,

    // UI 回调 - subagent 为 undefined（无法控制父 agent 的 UI）
    addNotification: undefined,
    setToolJSX: undefined,
    setStreamMode: undefined,
    setSDKStatus: undefined,
    openMessageSelector: undefined,

    // 可从父 agent 覆盖或复制的字段
    options: overrides?.options ?? parentContext.options,
    messages: overrides?.messages ?? parentContext.messages,
    // 为 subagent 生成新的 agentId（每个 subagent 应有自己的 ID）
    agentId: overrides?.agentId ?? createAgentId(),
    agentType: overrides?.agentType,

    // 为 subagent 创建新的查询跟踪链，深度加一
    queryTracking: {
      chainId: randomUUID(),
      depth: (parentContext.queryTracking?.depth ?? -1) + 1,
    },
    fileReadingLimits: parentContext.fileReadingLimits,
    userModified: parentContext.userModified,
    criticalSystemReminder_EXPERIMENTAL:
      overrides?.criticalSystemReminder_EXPERIMENTAL,
    requireCanUseTool: overrides?.requireCanUseTool,
  }
}

/**
 * 运行 forked agent 查询循环并跟踪缓存命中指标。
 *
 * 此函数：
 * 1. 使用与父 agent 完全相同的缓存安全参数以启用 prompt 缓存
 * 2. 跨所有查询迭代累计使用量
 * 3. 完成时记录带完整使用量的 tengu_fork_agent_query
 *
 * @example
 * ```typescript
 * const result = await runForkedAgent({
 *   promptMessages: [createUserMessage({ content: userPrompt })],
 *   cacheSafeParams: {
 *     systemPrompt,
 *     userContext,
 *     systemContext,
 *     toolUseContext: clonedToolUseContext,
 *     forkContextMessages: messages,
 *   },
 *   canUseTool,
 *   querySource: 'session_memory',
 *   forkLabel: 'session_memory',
 * })
 * ```
 */

type StreamEventMessage = StreamEvent & {
  type: 'stream_event'
  event: BetaRawMessageStreamEvent
}

function isMessageDeltaStreamEvent(
  message: Message | StreamEvent,
): message is StreamEventMessage & { event: BetaRawMessageDeltaEvent } {
  return (
    message.type === 'stream_event' &&
    typeof (message as StreamEventMessage).event === 'object' &&
    (message as StreamEventMessage).event !== null &&
    'type' in (message as StreamEventMessage).event &&
    (message as StreamEventMessage).event.type === 'message_delta'
  )
}

export async function runForkedAgent({
  promptMessages,
  cacheSafeParams,
  canUseTool,
  querySource,
  forkLabel,
  overrides,
  maxOutputTokens,
  maxTurns,
  onMessage,
  skipTranscript,
  skipCacheWrite,
}: ForkedAgentParams): Promise<ForkedAgentResult> {
  const startTime = Date.now()
  const outputMessages: Message[] = []
  let totalUsage: NonNullableUsage = { ...EMPTY_USAGE }

  const {
    systemPrompt,
    userContext,
    systemContext,
    toolUseContext,
    forkContextMessages,
  } = cacheSafeParams

  // 创建隔离上下文以防止修改父 agent 状态
  const isolatedToolUseContext = createSubagentContext(
    toolUseContext,
    overrides,
  )

  // 不要在这里调用 filterIncompleteToolCalls — 它会丢弃部分工具批次上的整个 assistant，
  // 使配对的结果成为孤儿（API 400）。悬空的 tool_uses 由 claude.ts 中的
  // ensureToolResultPairing 在下游修复，与主线程相同 — 相同的修复后前缀保持缓存命中。
  const initialMessages: Message[] = [...forkContextMessages, ...promptMessages]

  // 生成 agent ID 并为转录记录初始消息
  // 设置 skipTranscript 时，跳过 agent ID 创建和所有转录 I/O
  const agentId = skipTranscript ? undefined : createAgentId(forkLabel)
  let lastRecordedUuid: UUID | null = null
  if (agentId) {
    await recordSidechainTranscript(initialMessages, agentId).catch(err =>
      logForDebugging(
        `Forked agent [${forkLabel}] failed to record initial transcript: ${err}`,
      ),
    )
    // 跟踪最后记录的消息 UUID 以保证父链连续性
    lastRecordedUuid =
      initialMessages.length > 0
        ? initialMessages[initialMessages.length - 1]!.uuid
        : null
  }

  // 使用隔离上下文运行查询循环（保留缓存安全参数）
  try {
    for await (const message of query({
      messages: initialMessages,
      systemPrompt,
      userContext,
      systemContext,
      canUseTool,
      toolUseContext: isolatedToolUseContext,
      querySource,
      maxOutputTokensOverride: maxOutputTokens,
      maxTurns,
      skipCacheWrite,
    })) {
      // 从 message_delta 流事件中提取实际使用量（每次 API 调用的最终使用量）
      if (message.type === 'stream_event') {
        if (isMessageDeltaStreamEvent(message)) {
          const turnUsage = updateUsage({ ...EMPTY_USAGE }, message.event.usage)
          totalUsage = accumulateUsage(totalUsage, turnUsage)
        }
        continue
      }
      if (message.type === 'stream_request_start') {
        continue
      }

      logForDebugging(
        `Forked agent [${forkLabel}] received message: type=${message.type}`,
      )

      outputMessages.push(message as Message)
      onMessage?.(message as Message)

      // 记录可记录消息类型的转录（与 runAgent.ts 相同的模式）
      const msg = message as Message
      if (
        agentId &&
        (msg.type === 'assistant' ||
          msg.type === 'user' ||
          msg.type === 'progress')
      ) {
        await recordSidechainTranscript([msg], agentId, lastRecordedUuid).catch(
          err =>
            logForDebugging(
              `Forked agent [${forkLabel}] failed to record transcript: ${err}`,
            ),
        )
        if (msg.type !== 'progress') {
          lastRecordedUuid = msg.uuid
        }
      }
    }
  } finally {
    // 释放克隆的文件状态缓存内存（与 runAgent.ts 相同的模式）
    isolatedToolUseContext.readFileState.clear()
    // 释放克隆的 fork 上下文消息
    initialMessages.length = 0
  }

  logForDebugging(
    `Forked agent [${forkLabel}] finished: ${outputMessages.length} messages, types=[${outputMessages.map(m => m.type).join(', ')}], totalUsage: input=${totalUsage.input_tokens} output=${totalUsage.output_tokens} cacheRead=${totalUsage.cache_read_input_tokens} cacheCreate=${totalUsage.cache_creation_input_tokens}`,
  )

  const durationMs = Date.now() - startTime

  // 记录带完整 NonNullableUsage 的 fork 查询指标
  logForkAgentQueryEvent({
    forkLabel,
    querySource,
    durationMs,
    messageCount: outputMessages.length,
    totalUsage,
    queryTracking: toolUseContext.queryTracking,
  })

  return {
    messages: outputMessages,
    totalUsage,
  }
}

/**
 * 记录带完整 NonNullableUsage 字段的 tengu_fork_agent_query 事件。
 */
function logForkAgentQueryEvent({
  forkLabel,
  querySource,
  durationMs,
  messageCount,
  totalUsage,
  queryTracking,
}: {
  forkLabel: string
  querySource: QuerySource
  durationMs: number
  messageCount: number
  totalUsage: NonNullableUsage
  queryTracking?: { chainId: string; depth: number }
}): void {
  // 计算缓存命中率
  const totalInputTokens =
    totalUsage.input_tokens +
    totalUsage.cache_creation_input_tokens +
    totalUsage.cache_read_input_tokens
  const cacheHitRate =
    totalInputTokens > 0
      ? totalUsage.cache_read_input_tokens / totalInputTokens
      : 0

  logEvent('tengu_fork_agent_query', {
    // 元数据
    forkLabel:
      forkLabel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    querySource:
      querySource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    durationMs,
    messageCount,

    // NonNullableUsage 字段
    inputTokens: totalUsage.input_tokens,
    outputTokens: totalUsage.output_tokens,
    cacheReadInputTokens: totalUsage.cache_read_input_tokens,
    cacheCreationInputTokens: totalUsage.cache_creation_input_tokens,
    serviceTier:
      totalUsage.service_tier as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    cacheCreationEphemeral1hTokens:
      totalUsage.cache_creation.ephemeral_1h_input_tokens,
    cacheCreationEphemeral5mTokens:
      totalUsage.cache_creation.ephemeral_5m_input_tokens,

    // 派生指标
    cacheHitRate,

    // 查询跟踪
    ...(queryTracking
      ? {
          queryChainId:
            queryTracking.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          queryDepth: queryTracking.depth,
        }
      : {}),
  })
}
