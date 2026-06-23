// 用于将原始 SDK 事件流式传输至浏览器调试面板的调试接收端
type UsageSink = (
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  },
  model: string,
) => void
let _usageSink: UsageSink | null = null
export function setUsageSink(sink: UsageSink | null): void {
  _usageSink = sink
}

import { feature } from 'bun:bundle'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { randomUUID } from 'crypto'
import last from 'lodash-es/last.js'
import {
  getSessionId,
  isSessionPersistenceDisabled,
} from 'src/bootstrap/state.js'
import type {
  PermissionMode,
  SDKCompactBoundaryMessage,
  SDKMessage,
  SDKPermissionDenial,
  SDKStatus,
  SDKUserMessageReplay,
} from 'src/entrypoints/agentSdkTypes.js'
import type { BetaMessageDeltaUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { accumulateUsage, updateUsage } from 'src/services/api/claude.js'
import type { NonNullableUsage } from '@ant/model-provider'
import { EMPTY_USAGE } from '@ant/model-provider'
import stripAnsi from 'strip-ansi'
import type { Command } from './commands.js'
import { getSlashCommandToolSkills } from './commands.js'
import {
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
} from './constants/xml.js'
import {
  getModelUsage,
  getTotalAPIDuration,
  getTotalCost,
} from './cost-tracker.js'
import type { CanUseToolFn } from './hooks/useCanUseTool.js'
import { loadMemoryPrompt } from './memdir/memdir.js'
import { hasAutoMemPathOverride } from './memdir/paths.js'
import { query } from './query.js'
import { categorizeRetryableAPIError } from './services/api/errors.js'
import type { MCPServerConnection } from './services/mcp/types.js'
import type { AppState } from './state/AppState.js'
import { type Tools, type ToolUseContext, toolMatchesName } from './Tool.js'
import type { AgentDefinition } from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/SyntheticOutputTool/SyntheticOutputTool.js'
import type { APIError } from '@anthropic-ai/sdk'
import type { Message, SystemCompactBoundaryMessage } from './types/message.js'
import type { OrphanedPermission } from './types/textInputTypes.js'
import { createAbortController } from './utils/abortController.js'
import type { AttributionState } from './utils/commitAttribution.js'
import { getGlobalConfig } from './utils/config.js'
import { getCwd } from './utils/cwd.js'
import { isBareMode, isEnvTruthy } from './utils/envUtils.js'
import { getFastModeState } from './utils/fastMode.js'
import {
  type FileHistoryState,
  fileHistoryEnabled,
  fileHistoryMakeSnapshot,
} from './utils/fileHistory.js'
import {
  cloneFileStateCache,
  type FileStateCache,
} from './utils/fileStateCache.js'
import { headlessProfilerCheckpoint } from './utils/headlessProfiler.js'
import { registerStructuredOutputEnforcement } from './utils/hooks/hookHelpers.js'
import { logForDebugging } from './utils/debug.js'
import { getInMemoryErrors } from './utils/log.js'
import { countToolCalls, SYNTHETIC_MESSAGES } from './utils/messages.js'
import {
  getMainLoopModel,
  parseUserSpecifiedModel,
} from './utils/model/model.js'
import { loadAllPluginsCacheOnly } from './utils/plugins/pluginLoader.js'
import {
  type ProcessUserInputContext,
  processUserInput,
} from './utils/processUserInput/processUserInput.js'
import { fetchSystemPromptParts } from './utils/queryContext.js'
import { setCwd } from './utils/Shell.js'
import {
  flushSessionStorage,
  recordTranscript,
} from './utils/sessionStorage.js'
import { asSystemPrompt } from './utils/systemPromptType.js'
import { resolveThemeSetting } from './utils/systemTheme.js'
import {
  shouldEnableThinkingByDefault,
  type ThinkingConfig,
} from './utils/thinking.js'

// 懒加载：MessageSelector.tsx 引入 React/ink；仅在查询时做消息过滤才需要
/* eslint-disable @typescript-eslint/no-require-imports */
const messageSelector = ():
  | typeof import('src/components/MessageSelector.js')
  | null => {
  try {
    return require('src/components/MessageSelector.js')
  } catch {
    return null
  }
}

import {
  localCommandOutputToSDKAssistantMessage,
  toSDKCompactMetadata,
} from './utils/messages/mappers.js'
import {
  buildSystemInitMessage,
  sdkCompatToolName,
} from './utils/messages/systemInit.js'
import {
  getScratchpadDir,
  isScratchpadEnabled,
} from './utils/permissions/filesystem.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  handleOrphanedPermission,
  isResultSuccessful,
  normalizeMessage,
} from './utils/queryHelpers.js'

// 死代码消除：协调器模式的条件导入
/* eslint-disable @typescript-eslint/no-require-imports */
const getCoordinatorUserContext: (
  mcpClients: ReadonlyArray<{ name: string }>,
  scratchpadDir?: string,
) => { [k: string]: string } = feature('COORDINATOR_MODE')
  ? require('./coordinator/coordinatorMode.js').getCoordinatorUserContext
  : () => ({})
/* eslint-enable @typescript-eslint/no-require-imports */

// 死代码消除：snip 压缩的条件导入
/* eslint-disable @typescript-eslint/no-require-imports */
const snipModule = feature('HISTORY_SNIP')
  ? (require('./services/compact/snipCompact.js') as typeof import('./services/compact/snipCompact.js'))
  : null
const snipProjection = feature('HISTORY_SNIP')
  ? (require('./services/compact/snipProjection.js') as typeof import('./services/compact/snipProjection.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

export type QueryEngineConfig = {
  cwd: string
  tools: Tools
  commands: Command[]
  mcpClients: MCPServerConnection[]
  agents: AgentDefinition[]
  canUseTool: CanUseToolFn
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
  initialMessages?: Message[]
  readFileCache: FileStateCache
  customSystemPrompt?: string
  appendSystemPrompt?: string
  userSpecifiedModel?: string
  fallbackModel?: string
  thinkingConfig?: ThinkingConfig
  maxTurns?: number
  maxBudgetUsd?: number
  taskBudget?: { total: number }
  jsonSchema?: Record<string, unknown>
  verbose?: boolean
  replayUserMessages?: boolean
  /** 处理由 MCP 工具 -32042 错误触发的 URL 询问。 */
  handleElicitation?: ToolUseContext['handleElicitation']
  includePartialMessages?: boolean
  setSDKStatus?: (status: SDKStatus) => void
  abortController?: AbortController
  orphanedPermission?: OrphanedPermission
  /**
   * Snip 边界处理器：接收每个 yield 出来的系统消息以及当前 mutableMessages
   * 存储。若该消息不是 snip 边界则返回 undefined；否则返回重放后的 snip
   * 结果。由 ask() 在启用 HISTORY_SNIP 时注入，使 feature 门控的字符串
   * 保留在被门控的模块内（保证 QueryEngine 不含被排除的字符串，即便
   * feature() 在 bun test 下返回 false 仍可测试）。仅 SDK 使用：REPL
   * 保留完整历史用于 UI 回滚并按需通过 projectSnippedView 投影；
   * QueryEngine 在此截断以限制长时会话的内存占用（无 UI 需要保留）。
   */
  snipReplay?: (
    yieldedSystemMsg: Message,
    store: Message[],
  ) => { messages: Message[]; executed: boolean } | undefined
}

/**
 * QueryEngine 拥有对话的查询生命周期和会话状态。
 * 它将 ask() 中的核心逻辑抽取为独立类，可同时被 headless/SDK 路径
 * 以及（未来阶段）REPL 使用。
 *
 * 每个对话对应一个 QueryEngine。每次 submitMessage() 调用都会在
 * 同一会话内开启一轮新对话。状态（消息、文件缓存、用量等）跨轮次持久化。
 */
/**
 * 高层对话调度器 —— 封装 query() 并管理会话级别的状态。
 *
 * 与 query() 的关系：
 *   query() 是"单次轮次"的底层执行器（调用 API + 执行工具 → 返回消息）；
 *   QueryEngine 在 query() 之上，负责：
 *   - 维护完整的对话历史（mutableMessages）
 *   - 处理用户输入（submitMessage）
 *   - 上下文压缩（compact）
 *   - 文件历史快照（file history snapshot，用于 undo/diff）
 *   - token 用量累计（totalUsage）
 *   - 会话持久化（transcript 写入）
 *   - 权限拒绝记录（permissionDenials）
 *
 * 使用方式：
 *   REPL 组件持有 QueryEngine 实例，每次用户输入调用 engine.submitMessage()，
 *   通过 for-await 消费返回的 SDKMessage 流来更新 UI。
 */
export class QueryEngine {
  private config: QueryEngineConfig
  private mutableMessages: Message[]
  private abortController: AbortController
  private permissionDenials: SDKPermissionDenial[]
  private totalUsage: NonNullableUsage
  private hasHandledOrphanedPermission = false
  private readFileState: FileStateCache
  // 按轮次作用域的技能发现追踪（为 tengu_skill_tool_invocation 的
  // was_discovered 提供数据）。需在 submitMessage 内两次
  // processUserInputContext 重建之间持久化，但在每次 submitMessage
  // 开头清空，避免 SDK 模式下多轮次堆积导致无界增长。
  private discoveredSkillNames = new Set<string>()
  private loadedNestedMemoryPaths = new Set<string>()

  constructor(config: QueryEngineConfig) {
    logForDebugging(
      `-------------- constructor 开始 -----------
[Hapii] QueryEngine.constructor 参数:
  cwd=${config.cwd}
  toolsCount=${config.tools.length}
  commandsCount=${config.commands.length}
  mcpClientsCount=${config.mcpClients.length}
  agentsCount=${config.agents.length}
  initialMsgCount=${config.initialMessages?.length ?? 0}
  hasCustomSystemPrompt=${config.customSystemPrompt !== undefined}
  hasAppendSystemPrompt=${config.appendSystemPrompt !== undefined}
  userSpecifiedModel=${config.userSpecifiedModel ?? 'default'}
  hasFallbackModel=${config.fallbackModel !== undefined}
  hasJsonSchema=${config.jsonSchema !== undefined}
  maxTurns=${config.maxTurns ?? 'unlimited'}
  maxBudgetUsd=${config.maxBudgetUsd ?? 'unlimited'}
  hasTaskBudget=${config.taskBudget !== undefined}
  verbose=${config.verbose ?? false}
  replayUserMessages=${config.replayUserMessages ?? false}
  includePartialMessages=${config.includePartialMessages ?? false}
  hasAbortController=${config.abortController !== undefined}
  hasOrphanedPermission=${config.orphanedPermission !== undefined}`,
      { level: 'info' },
    )
    this.config = config
    this.mutableMessages = config.initialMessages ?? []
    this.abortController = config.abortController ?? createAbortController()
    this.permissionDenials = []
    this.readFileState = config.readFileCache
    this.totalUsage = EMPTY_USAGE
    logForDebugging(
      `-------------- constructor 结束 ---------
[Hapii] QueryEngine.constructor 初始化完成: mutableMsgCount=${this.mutableMessages.length}`,
      { level: 'info' },
    )
  }

  /**
   * 提交用户消息并启动一轮完整的 Agent 执行循环。
   *
   * 流程：
   *   1. 处理用户输入（可能是文本 prompt，也可能是 slash 命令）
   *   2. 获取系统 prompt（fetchSystemPromptParts）
   *   3. 调用 query() 执行 API 请求 + 工具调用循环
   *   4. 将每步产生的消息 yield 给调用方（REPL 用来更新 UI）
   *   5. 轮次结束后：记录 transcript、累计 token、生成文件历史快照
   *
   * 支持的功能：
   *   - 自定义 system prompt / 追加 system prompt
   *   - 自定义模型 / fallback 模型
   *   - 最大轮次限制（maxTurns）
   *   - 预算限制（maxBudgetUsd / taskBudget）
   *   - JSON schema 结构化输出
   *   - Agent 定义列表（用于 sub-agent 派发）
   */
  async *submitMessage(
    prompt: string | ContentBlockParam[],
    options?: { uuid?: string; isMeta?: boolean },
  ): AsyncGenerator<SDKMessage, void, unknown> {
    const {
      cwd,
      commands,
      tools,
      mcpClients,
      verbose = false,
      thinkingConfig,
      maxTurns,
      maxBudgetUsd,
      taskBudget,
      canUseTool,
      customSystemPrompt,
      appendSystemPrompt,
      userSpecifiedModel,
      fallbackModel,
      jsonSchema,
      getAppState,
      setAppState,
      replayUserMessages = false,
      includePartialMessages = false,
      agents = [],
      setSDKStatus,
      orphanedPermission,
    } = this.config

    this.discoveredSkillNames.clear()
    this.permissionDenials = []
    setCwd(cwd)
    const persistSession = !isSessionPersistenceDisabled()
    const startTime = Date.now()
    logForDebugging(
      `-------------- submitMessage 开始 -----------
[Hapii] QueryEngine.submitMessage 参数:
  promptLen=${typeof prompt === 'string' ? prompt.length : prompt.length}
  promptType=${typeof prompt === 'string' ? 'string' : 'ContentBlockParam[]'}
  msgCount=${this.mutableMessages.length}
  uuid=${options?.uuid ?? 'none'}
  isMeta=${options?.isMeta ?? false}
  cwd=${cwd}
  persistSession=${persistSession}
  model=${userSpecifiedModel ?? 'default'}
  maxTurns=${maxTurns ?? 'unlimited'}
  maxBudgetUsd=${maxBudgetUsd ?? 'unlimited'}
  toolsCount=${tools.length}
  commandsCount=${commands.length}
  mcpClientsCount=${mcpClients.length}
  agentsCount=${agents.length}`,
      { level: 'info' },
    )

    // 包装 canUseTool 以追踪权限拒绝
    const wrappedCanUseTool: CanUseToolFn = async (
      tool,
      input,
      toolUseContext,
      assistantMessage,
      toolUseID,
      forceDecision,
    ) => {
      const result = await canUseTool(
        tool,
        input,
        toolUseContext,
        assistantMessage,
        toolUseID,
        forceDecision,
      )

      // 追踪拒绝情况以供 SDK 报告
      if (result.behavior !== 'allow') {
        this.permissionDenials.push({
          type: 'permission_denial',
          tool_name: sdkCompatToolName(tool.name),
          tool_use_id: toolUseID,
          tool_input: input,
        })
      }

      return result
    }

    const initialAppState = getAppState()
    const initialMainLoopModel = userSpecifiedModel
      ? parseUserSpecifiedModel(userSpecifiedModel)
      : getMainLoopModel()

    const initialThinkingConfig: ThinkingConfig = thinkingConfig
      ? thinkingConfig
      : shouldEnableThinkingByDefault() !== false
        ? { type: 'adaptive' }
        : { type: 'disabled' }

    logForDebugging(
      `[Hapii] submitMessage.phase[初始状态]:
  initialMainLoopModel=${initialMainLoopModel}
  thinkingConfig=${JSON.stringify(initialThinkingConfig)}
  canUseTool=wrapped`,
      { level: 'info' },
    )

    headlessProfilerCheckpoint('before_getSystemPrompt')
    // 统一收窄一次，让 TS 在下方的条件分支中持续追踪类型。
    const customPrompt =
      typeof customSystemPrompt === 'string' ? customSystemPrompt : undefined
    const {
      defaultSystemPrompt,
      userContext: baseUserContext,
      systemContext,
    } = await fetchSystemPromptParts({
      tools,
      mainLoopModel: initialMainLoopModel,
      additionalWorkingDirectories: Array.from(
        initialAppState.toolPermissionContext.additionalWorkingDirectories.keys(),
      ),
      mcpClients,
      customSystemPrompt: customPrompt,
    })
    headlessProfilerCheckpoint('after_getSystemPrompt')
    logForDebugging(
      `[Hapii] submitMessage.phase[系统提示构建完成]:
  defaultSystemPromptParts=${defaultSystemPrompt.length}
  systemContextLen=${systemContext.length}
  userContextKeys=${Object.keys(baseUserContext).length}
  hasCustomPrompt=${customPrompt !== undefined}
  hasCoordinatorContext=${feature('COORDINATOR_MODE') ? true : false}`,
      { level: 'info' },
    )
    const userContext = {
      ...baseUserContext,
      ...getCoordinatorUserContext(
        mcpClients,
        isScratchpadEnabled() ? getScratchpadDir() : undefined,
      ),
    }

    // 当 SDK 调用方提供自定义系统 prompt 并且设置了
    // CLAUDE_COWORK_MEMORY_PATH_OVERRIDE 时，注入记忆机制的 prompt。
    // 该环境变量是显式的 opt-in 信号 —— 调用方已经接好了记忆目录，
    // 需要让 Claude 知道如何使用它（调用哪些 Write/Edit 工具、
    // MEMORY.md 文件名、加载语义等）。
    // 调用方可以通过 appendSystemPrompt 叠加自己的策略文本。
    const memoryMechanicsPrompt =
      customPrompt !== undefined && hasAutoMemPathOverride()
        ? await loadMemoryPrompt()
        : null

    const systemPrompt = asSystemPrompt([
      ...(customPrompt !== undefined ? [customPrompt] : defaultSystemPrompt),
      ...(memoryMechanicsPrompt ? [memoryMechanicsPrompt] : []),
      ...(appendSystemPrompt ? [appendSystemPrompt] : []),
    ])

    // 为结构化输出强制执行注册 function hook
    const hasStructuredOutputTool = tools.some(t =>
      toolMatchesName(t, SYNTHETIC_OUTPUT_TOOL_NAME),
    )
    if (jsonSchema && hasStructuredOutputTool) {
      registerStructuredOutputEnforcement(setAppState, getSessionId())
    }

    logForDebugging(
      `[Hapii] submitMessage.phase[系统提示组装完成]:
  hasMemoryMechanicsPrompt=${memoryMechanicsPrompt !== null}
  hasStructuredOutputTool=${hasStructuredOutputTool}
  jsonSchema=${jsonSchema !== undefined}
  registeredEnforcement=${jsonSchema !== undefined && hasStructuredOutputTool}`,
      { level: 'info' },
    )

    let processUserInputContext: ProcessUserInputContext = {
      messages: this.mutableMessages,
      // 会修改消息数组的 slash 命令（例如 /force-snip）会调用
      // setMessages(fn)。在交互模式下写回 AppState；在 print 模式下
      // 写回 mutableMessages，让查询循环的后续部分（:389 的 push、
      // :392 的快照）能看到结果。下面的第二个 processUserInputContext
      //（slash 命令处理之后）保持 no-op —— 在那之后没有其他地方调用
      // setMessages。
      setMessages: fn => {
        this.mutableMessages = fn(this.mutableMessages)
      },
      onChangeAPIKey: () => {},
      handleElicitation: this.config.handleElicitation,
      options: {
        commands,
        debug: false, // 我们使用 stdout，不希望被覆盖
        tools,
        verbose,
        mainLoopModel: initialMainLoopModel,
        thinkingConfig: initialThinkingConfig,
        mcpClients,
        mcpResources: {},
        ideInstallationStatus: null,
        isNonInteractiveSession: true,
        customSystemPrompt,
        appendSystemPrompt,
        agentDefinitions: { activeAgents: agents, allAgents: [] },
        theme: resolveThemeSetting(getGlobalConfig().theme),
        maxBudgetUsd,
      },
      getAppState,
      setAppState,
      abortController: this.abortController,
      readFileState: this.readFileState,
      nestedMemoryAttachmentTriggers: new Set<string>(),
      loadedNestedMemoryPaths: this.loadedNestedMemoryPaths,
      dynamicSkillDirTriggers: new Set<string>(),
      discoveredSkillNames: this.discoveredSkillNames,
      setInProgressToolUseIDs: () => {},
      setResponseLength: () => {},
      updateFileHistoryState: (
        updater: (prev: FileHistoryState) => FileHistoryState,
      ) => {
        setAppState(prev => {
          const updated = updater(prev.fileHistory)
          if (updated === prev.fileHistory) return prev
          return { ...prev, fileHistory: updated }
        })
      },
      updateAttributionState: (
        updater: (prev: AttributionState) => AttributionState,
      ) => {
        setAppState(prev => {
          const updated = updater(prev.attribution)
          if (updated === prev.attribution) return prev
          return { ...prev, attribution: updated }
        })
      },
      setSDKStatus,
    }

    // 处理孤立的权限请求（每个 engine 生命周期只处理一次）
    if (orphanedPermission && !this.hasHandledOrphanedPermission) {
      this.hasHandledOrphanedPermission = true
      for await (const message of handleOrphanedPermission(
        orphanedPermission,
        tools,
        this.mutableMessages,
        processUserInputContext,
      )) {
        yield message
      }
    }

    const {
      messages: messagesFromUserInput,
      shouldQuery,
      allowedTools,
      model: modelFromUserInput,
      resultText,
    } = await processUserInput({
      input: prompt,
      mode: 'prompt',
      setToolJSX: () => {},
      context: {
        ...processUserInputContext,
        messages: this.mutableMessages,
      },
      messages: this.mutableMessages,
      uuid: options?.uuid,
      isMeta: options?.isMeta,
      querySource: 'sdk',
    })
    logForDebugging(
      `[Hapii] submitMessage.phase[processUserInput完成]:
  shouldQuery=${shouldQuery}
  messagesFromUserInput=${messagesFromUserInput.length}
  model=${modelFromUserInput ?? 'unchanged'}
  allowedTools=${allowedTools?.length ?? 0}
  hasResultText=${resultText !== undefined && resultText !== null}
  resultTextLen=${resultText?.length ?? 0}`,
      { level: 'info' },
    )

    // 推入新消息，包括用户输入和任何附件
    this.mutableMessages.push(...messagesFromUserInput)

    // 更新参数以反映处理 /slash 命令后的变更
    const messages = [...this.mutableMessages]

    // 在进入 query 循环之前把用户消息持久化到 transcript。
    // 下面的 for-await 只在 ask() yield 出 assistant/user/compact_boundary
    // 消息时才调用 recordTranscript —— 而 API 响应之前不会发生。
    // 如果进程在此之前被杀（例如 cowork 中用户点 Stop），transcript
    // 只剩下队列操作条目；getLastSessionLog 会把这些过滤掉返回 null，
    // 导致 --resume 失败并报 "No conversation found"。现在写入可以
    // 让 transcript 从用户消息被接受的那一刻起就能恢复，即便 API
    // 从未响应。
    //
    // --bare / SIMPLE：fire-and-forget。脚本化调用不会在中途被杀后
    // --resume。await 在 SSD 上约 4ms，磁盘竞争时约 30ms ——
    // 是模块求值之后最大的可控关键路径开销。Transcript 仍会写入
    //（供事后调试），只是不阻塞。
    if (persistSession && messagesFromUserInput.length > 0) {
      const transcriptPromise = recordTranscript(messages)
      if (isBareMode()) {
        void transcriptPromise
      } else {
        await transcriptPromise
        if (
          isEnvTruthy(process.env.CLAUDE_CODE_EAGER_FLUSH) ||
          isEnvTruthy(process.env.CLAUDE_CODE_IS_COWORK)
        ) {
          await flushSessionStorage()
        }
      }
    }

    logForDebugging(
      `[Hapii] submitMessage.phase[用户消息持久化]:
  persistSession=${persistSession}
  isBareMode=${isBareMode()}
  messagesLen=${messages.length}`,
      { level: 'info' },
    )

    // 过滤出在 transcript 之后需要确认的消息
    const _selector = messageSelector()
    const replayableMessages = messagesFromUserInput.filter(
      msg =>
        (msg.type === 'user' &&
          !msg.isMeta && // 跳过合成的 caveat 消息
          !msg.toolUseResult && // 跳过工具结果（它们会从 query 中被确认）
          (_selector?.selectableUserMessagesFilter(msg) ?? true)) || // 跳过非用户撰写的消息（任务通知等）
        (msg.type === 'system' && msg.subtype === 'compact_boundary'), // 总是确认 compact 边界
    )
    const messagesToAck = replayUserMessages ? replayableMessages : []

    logForDebugging(
      `[Hapii] submitMessage.phase[消息确认准备]:
  replayableMsgCount=${replayableMessages.length}
  messagesToAckCount=${messagesToAck.length}
  replayUserMessages=${replayUserMessages}`,
      { level: 'info' },
    )

    // 根据用户输入处理结果更新 ToolPermissionContext（按需）
    setAppState(prev => ({
      ...prev,
      toolPermissionContext: {
        ...prev.toolPermissionContext,
        alwaysAllowRules: {
          ...prev.toolPermissionContext.alwaysAllowRules,
          command: allowedTools,
        },
      },
    }))

    const mainLoopModel = modelFromUserInput ?? initialMainLoopModel

    // 处理完 prompt 后重建，以拿到更新后的 messages 和
    // model（来自 slash 命令）。
    processUserInputContext = {
      messages,
      setMessages: () => {},
      onChangeAPIKey: () => {},
      handleElicitation: this.config.handleElicitation,
      options: {
        commands,
        debug: false,
        tools,
        verbose,
        mainLoopModel,
        thinkingConfig: initialThinkingConfig,
        mcpClients,
        mcpResources: {},
        ideInstallationStatus: null,
        isNonInteractiveSession: true,
        customSystemPrompt,
        appendSystemPrompt,
        theme: resolveThemeSetting(getGlobalConfig().theme),
        agentDefinitions: { activeAgents: agents, allAgents: [] },
        maxBudgetUsd,
      },
      getAppState,
      setAppState,
      abortController: this.abortController,
      readFileState: this.readFileState,
      nestedMemoryAttachmentTriggers: new Set<string>(),
      loadedNestedMemoryPaths: this.loadedNestedMemoryPaths,
      dynamicSkillDirTriggers: new Set<string>(),
      discoveredSkillNames: this.discoveredSkillNames,
      setInProgressToolUseIDs: () => {},
      setResponseLength: () => {},
      updateFileHistoryState: processUserInputContext.updateFileHistoryState,
      updateAttributionState: processUserInputContext.updateAttributionState,
      setSDKStatus,
    }

    headlessProfilerCheckpoint('before_skills_plugins')
    // 仅走缓存：headless/SDK/CCR 启动不能阻塞在引用追踪的插件网络请求上。
    // CCR 通过 CLAUDE_CODE_SYNC_PLUGIN_INSTALL (headlessPluginInstall) 或
    // CLAUDE_CODE_PLUGIN_SEED_DIR 在此之前填充缓存；需要新源的 SDK
    // 调用方可调用 /reload-plugins。
    const [skills, { enabled: enabledPlugins }] = await Promise.all([
      getSlashCommandToolSkills(getCwd()),
      loadAllPluginsCacheOnly(),
    ])
    headlessProfilerCheckpoint('after_skills_plugins')
    logForDebugging(
      `[Hapii] submitMessage.phase[技能/插件加载完成]:
  skillsCount=${skills.length}
  enabledPluginsCount=${enabledPlugins.length}`,
      { level: 'info' },
    )

    yield buildSystemInitMessage({
      tools,
      mcpClients,
      model: mainLoopModel,
      permissionMode: initialAppState.toolPermissionContext
        .mode as PermissionMode, // TODO: 避免强制类型转换
      commands,
      agents,
      skills,
      plugins: enabledPlugins,
      fastMode: initialAppState.fastMode,
    })

    // 记录 yield 系统消息的时间点，用于 headless 延迟追踪
    headlessProfilerCheckpoint('system_message_yielded')
    logForDebugging(
      `[Hapii] submitMessage.phase[系统初始化消息已yield]: shouldQuery=${shouldQuery}`,
      { level: 'info' },
    )

    if (!shouldQuery) {
      logForDebugging(
        `[Hapii] submitMessage.phase[slash命令结果路径]: shouldQuery=false, 返回本地命令结果 耗时=${Date.now() - startTime}ms`,
        { level: 'info' },
      )
      // 返回本地 slash 命令的结果。
      // 对命令输出使用 messagesFromUserInput（不是 replayableMessages），
      // 因为 selectableUserMessagesFilter 会过滤掉 local-command-stdout 标签。
      for (const msg of messagesFromUserInput) {
        if (
          msg.type === 'user' &&
          typeof msg.message!.content === 'string' &&
          (msg.message!.content.includes(`<${LOCAL_COMMAND_STDOUT_TAG}>`) ||
            msg.message!.content.includes(`<${LOCAL_COMMAND_STDERR_TAG}>`) ||
            msg.isCompactSummary)
        ) {
          yield {
            type: 'user',
            message: {
              ...msg.message,
              content: stripAnsi(msg.message!.content),
            },
            session_id: getSessionId(),
            parent_tool_use_id: null,
            uuid: msg.uuid,
            timestamp: msg.timestamp,
            isReplay: !msg.isCompactSummary,
            isSynthetic: msg.isMeta || msg.isVisibleInTranscriptOnly,
          } as unknown as SDKUserMessageReplay
        }

        // 本地命令输出 —— 以合成 assistant 消息 yield，让 RC 把它
        // 渲染为 assistant 风格的文本，而不是用户气泡。作为 assistant
        // 发出（不是专用的 SDKLocalCommandOutputMessage 系统子类型），
        // 这样移动端客户端 + session-ingress 可以解析它。
        if (
          msg.type === 'system' &&
          msg.subtype === 'local_command' &&
          typeof msg.content === 'string' &&
          (msg.content.includes(`<${LOCAL_COMMAND_STDOUT_TAG}>`) ||
            msg.content.includes(`<${LOCAL_COMMAND_STDERR_TAG}>`))
        ) {
          yield localCommandOutputToSDKAssistantMessage(msg.content, msg.uuid)
        }

        if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
          const compactMsg = msg as SystemCompactBoundaryMessage
          yield {
            type: 'system',
            subtype: 'compact_boundary' as const,
            session_id: getSessionId(),
            uuid: msg.uuid,
            compact_metadata: toSDKCompactMetadata(compactMsg.compactMetadata),
          } as unknown as SDKCompactBoundaryMessage
        }
      }

      if (persistSession) {
        await recordTranscript(messages)
        if (
          isEnvTruthy(process.env.CLAUDE_CODE_EAGER_FLUSH) ||
          isEnvTruthy(process.env.CLAUDE_CODE_IS_COWORK)
        ) {
          await flushSessionStorage()
        }
      }

      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: Date.now() - startTime,
        duration_api_ms: getTotalAPIDuration(),
        num_turns: messages.length - 1,
        result: resultText ?? '',
        stop_reason: null,
        session_id: getSessionId(),
        total_cost_usd: getTotalCost(),
        usage: this.totalUsage,
        modelUsage: getModelUsage(),
        permission_denials: this.permissionDenials,
        fast_mode_state: getFastModeState(
          mainLoopModel,
          initialAppState.fastMode,
        ),
        uuid: randomUUID(),
      }
      return
    }

    if (fileHistoryEnabled() && persistSession) {
      const _sel = messageSelector()
      const _filter =
        _sel?.selectableUserMessagesFilter ?? ((_msg: unknown) => true)
      messagesFromUserInput.filter(_filter).forEach(message => {
        void fileHistoryMakeSnapshot(
          (updater: (prev: FileHistoryState) => FileHistoryState) => {
            setAppState(prev => ({
              ...prev,
              fileHistory: updater(prev.fileHistory),
            }))
          },
          message.uuid,
        )
      })
    }

    // 追踪当前消息的用量（每次 message_start 时重置）
    let currentMessageUsage: NonNullableUsage = EMPTY_USAGE
    let turnCount = 1
    let hasAcknowledgedInitialMessages = false
    // 追踪来自 StructuredOutput 工具调用的结构化输出
    let structuredOutputFromTool: unknown
    // 追踪 assistant 消息中最近的 stop_reason
    let lastStopReason: string | null = null
    // 基于引用的水位线，让 error_during_execution 的 errors[] 按轮次
    // 作用域化。基于长度的索引在 100 条环形缓冲区 shift() 时会失效 ——
    // 索引会漂移。如果该条目被轮转出去，lastIndexOf 返回 -1，
    // 我们就把所有内容都包含进来（安全的兜底）。
    const errorLogWatermark = getInMemoryErrors().at(-1)
    // 在 query 之前快照计数，用于基于增量的重试限制
    const initialStructuredOutputCalls = jsonSchema
      ? countToolCalls(this.mutableMessages, SYNTHETIC_OUTPUT_TOOL_NAME)
      : 0

    logForDebugging(
      `[Hapii] submitMessage.phase[进入query循环准备]:
  fileHistoryEnabled=${fileHistoryEnabled()}
  messagesCount=${messages.length}
  initialStructuredOutputCalls=${initialStructuredOutputCalls}
  mainLoopModel=${mainLoopModel}`,
      { level: 'info' },
    )
    logForDebugging(
      `[Hapii] submitMessage.phase[开始执行query()循环]: 消息数=${messages.length}`,
      { level: 'info' },
    )
    for await (const message of query({
      messages,
      systemPrompt,
      userContext,
      systemContext,
      canUseTool: wrappedCanUseTool,
      toolUseContext: processUserInputContext,
      fallbackModel,
      querySource: 'sdk',
      maxTurns,
      taskBudget,
    })) {
      // 记录 assistant、user 和 compact 边界消息
      if (
        message.type === 'assistant' ||
        message.type === 'user' ||
        (message.type === 'system' && message.subtype === 'compact_boundary')
      ) {
        // 在写入 compact 边界之前，把直到 preservedSegment 尾部的
        // 仅内存消息 flush 到磁盘。附件和 progress 现在都内联记录
        //（见下面各自的 switch 分支），但这次 flush 对 preservedSegment
        // 的尾部遍历仍然关键。如果 SDK 子进程在此之前重启
        //（claude-desktop 在轮次之间被杀），tailUuid 会指向一个
        // 从未写入的消息 → applyPreservedSegmentRelinks 的
        // tail→head 遍历失败 → 直接返回不裁剪 → 恢复时加载完整的
        // 压缩前历史。
        if (
          persistSession &&
          message.type === 'system' &&
          message.subtype === 'compact_boundary'
        ) {
          const compactMsg = message as SystemCompactBoundaryMessage
          const tailUuid =
            compactMsg.compactMetadata?.preservedSegment?.tailUuid
          if (tailUuid) {
            const tailIdx = this.mutableMessages.findLastIndex(
              m => m.uuid === tailUuid,
            )
            if (tailIdx !== -1) {
              await recordTranscript(this.mutableMessages.slice(0, tailIdx + 1))
            }
          }
        }
        messages.push(message as Message)
        if (persistSession) {
          // 对 assistant 消息采用 fire-and-forget。claude.ts 每个内容块
          // yield 一个 assistant 消息，然后在 message_delta 时改写
          // 最后一个消息的 message.usage/stop_reason —— 依赖写入队列
          // 100ms 的 lazy jsonStringify。在此处 await 会阻塞 ask()
          // 的 generator，导致 message_delta 必须等所有块消费完才能
          // 执行；drain 定时器（从块 1 开始）会先到期。交互式 CC 不受
          // 影响，因为 useLogMessages.ts 是 fire-and-forget。
          // enqueueWrite 保持顺序，因此这里 fire-and-forget 是安全的。
          if (message.type === 'assistant') {
            void recordTranscript(messages)
          } else {
            await recordTranscript(messages)
          }
        }

        // 在首次 transcript 记录后确认初始用户消息
        if (!hasAcknowledgedInitialMessages && messagesToAck.length > 0) {
          hasAcknowledgedInitialMessages = true
          for (const msgToAck of messagesToAck) {
            if (msgToAck.type === 'user') {
              yield {
                type: 'user',
                message: msgToAck.message,
                session_id: getSessionId(),
                parent_tool_use_id: null,
                uuid: msgToAck.uuid,
                timestamp: msgToAck.timestamp,
                isReplay: true,
              } as unknown as SDKUserMessageReplay
            }
          }
        }
      }

      if (message.type === 'user') {
        turnCount++
        logForDebugging(
          `[Hapii] submitMessage.queryLoop 用户消息(turn)到达: turnCount=${turnCount}`,
          { level: 'debug' },
        )
      }

      switch (message.type) {
        case 'tombstone':
          // Tombstone 消息是用于删除消息的控制信号，跳过它们
          break
        case 'assistant': {
          // 捕获 stop_reason（若已设置，合成消息的情况）。对于流式响应，
          // 在 content_block_stop 时为 null；真正的值通过 message_delta
          // 到达（见下方处理）。
          const msg = message as Message
          const stopReason = msg.message?.stop_reason as
            | string
            | null
            | undefined
          if (stopReason != null) {
            lastStopReason = stopReason
          }
          logForDebugging(
            `[Hapii] submitMessage.queryLoop assistant消息: stopReason=${stopReason ?? 'null'} contentBlocks=${msg.message?.content?.length ?? 0}`,
            { level: 'debug' },
          )
          this.mutableMessages.push(msg)
          yield* normalizeMessage(msg)
          break
        }
        case 'progress': {
          const msg = message as Message
          this.mutableMessages.push(msg)
          // 内联记录，这样下一次 ask() 调用里的去重循环就会把它当作
          // 已记录。没有这一步，延迟的 progress 会和 mutableMessages
          // 中已记录的 tool_results 交错，导致去重遍历把
          // startingParentUuid 冻结在错误的消息上 —— 让链分叉，
          // 在 resume 时把对话变成孤儿。
          if (persistSession) {
            messages.push(msg)
            void recordTranscript(messages)
          }
          yield* normalizeMessage(msg)
          break
        }
        case 'user': {
          const msg = message as Message
          this.mutableMessages.push(msg)
          yield* normalizeMessage(msg)
          break
        }
        case 'stream_event': {
          const event = (
            message as unknown as { event: Record<string, unknown> }
          ).event
          if (event.type === 'message_start') {
            // 为新消息重置当前消息用量
            currentMessageUsage = EMPTY_USAGE
            const eventMessage = event.message as {
              usage: BetaMessageDeltaUsage
            }
            currentMessageUsage = updateUsage(
              currentMessageUsage,
              eventMessage.usage,
            )
            logForDebugging(
              `[Hapii] submitMessage.queryLoop message_start: inputTokens=${eventMessage.usage?.input_tokens ?? 0} cacheRead=${eventMessage.usage?.cache_read_input_tokens ?? 0} cacheCreate=${eventMessage.usage?.cache_creation_input_tokens ?? 0}`,
              { level: 'debug' },
            )
          }
          if (event.type === 'message_delta') {
            currentMessageUsage = updateUsage(
              currentMessageUsage,
              event.usage as BetaMessageDeltaUsage,
            )
            // 从 message_delta 捕获 stop_reason。assistant 消息在
            // content_block_stop 时 yield，stop_reason=null；真正的值
            // 只在这里到达（见 claude.ts 的 message_delta 处理器）。
            // 没有这一步，result.stop_reason 永远是 null。
            const delta = event.delta as { stop_reason?: string | null }
            if (delta.stop_reason != null) {
              lastStopReason = delta.stop_reason
            }
            logForDebugging(
              `[Hapii] submitMessage.queryLoop message_delta: stopReason=${delta.stop_reason ?? 'null'} outputTokens=${(event.usage as BetaMessageDeltaUsage)?.output_tokens ?? 0}`,
              { level: 'debug' },
            )
          }
          if (event.type === 'message_stop') {
            // 将当前消息用量累计到总量
            this.totalUsage = accumulateUsage(
              this.totalUsage,
              currentMessageUsage,
            )
            logForDebugging(
              `[Hapii] submitMessage.queryLoop message_stop: 累计用量 input=${this.totalUsage.input_tokens} output=${this.totalUsage.output_tokens}`,
              { level: 'debug' },
            )
            // 推送累计用量到调试面板 sink
            try {
              _usageSink?.(this.totalUsage, mainLoopModel)
            } catch {}
          }

          if (includePartialMessages) {
            yield {
              type: 'stream_event' as const,
              event,
              session_id: getSessionId(),
              parent_tool_use_id: null,
              uuid: randomUUID(),
            }
          }

          break
        }
        case 'attachment': {
          const msg = message as Message
          this.mutableMessages.push(msg)
          // 内联记录（原因同上面的 progress）。
          if (persistSession) {
            messages.push(msg)
            void recordTranscript(messages)
          }

          const attachment = msg.attachment as {
            type: string
            data?: unknown
            turnCount?: number
            maxTurns?: number
            prompt?: string
            source_uuid?: string
            [key: string]: unknown
          }

          logForDebugging(
            `[Hapii] submitMessage.queryLoop attachment: type=${attachment.type}`,
            { level: 'debug' },
          )

          // 从 StructuredOutput 工具调用中提取结构化输出
          if (attachment.type === 'structured_output') {
            structuredOutputFromTool = attachment.data
          }
          // 处理 query.ts 发来的达到最大轮次的信号
          else if (attachment.type === 'max_turns_reached') {
            logForDebugging(
              `[Hapii] submitMessage.queryLoop max_turns_reached: turnCount=${attachment.turnCount} maxTurns=${attachment.maxTurns}`,
              { level: 'warn' },
            )
            if (persistSession) {
              if (
                isEnvTruthy(process.env.CLAUDE_CODE_EAGER_FLUSH) ||
                isEnvTruthy(process.env.CLAUDE_CODE_IS_COWORK)
              ) {
                await flushSessionStorage()
              }
            }
            yield {
              type: 'result',
              subtype: 'error_max_turns',
              duration_ms: Date.now() - startTime,
              duration_api_ms: getTotalAPIDuration(),
              is_error: true,
              num_turns: attachment.turnCount as number,
              stop_reason: lastStopReason,
              session_id: getSessionId(),
              total_cost_usd: getTotalCost(),
              usage: this.totalUsage,
              modelUsage: getModelUsage(),
              permission_denials: this.permissionDenials,
              fast_mode_state: getFastModeState(
                mainLoopModel,
                initialAppState.fastMode,
              ),
              uuid: randomUUID(),
              errors: [
                `Reached maximum number of turns (${attachment.maxTurns})`,
              ],
            }
            return
          }
          // 将 queued_command 附件作为 SDK 用户消息重放 yield 出去
          else if (replayUserMessages && attachment.type === 'queued_command') {
            yield {
              type: 'user',
              message: {
                role: 'user' as const,
                content: attachment.prompt,
              },
              session_id: getSessionId(),
              parent_tool_use_id: null,
              uuid: attachment.source_uuid || msg.uuid,
              timestamp: msg.timestamp,
              isReplay: true,
            } as unknown as SDKUserMessageReplay
          }
          break
        }
        case 'stream_request_start':
          // 不 yield 流式请求开始消息
          break
        case 'system': {
          const msg = message as Message
          // Snip 边界：在我们的存储上重放，移除僵尸消息和过期标记。
          // yield 出来的边界是信号，不是要 push 的数据 —— 重放会产生
          // 自己的等价边界。没有这一步，标记会持续存在并在每轮重新
          // 触发，mutableMessages 永不收缩（在长 SDK 会话中是内存
          // 泄漏）。子类型判断放在注入的回调里，这样 feature 门控的
          // 字符串就不会出现在本文件中（excluded-strings 检查）。
          const snipResult = this.config.snipReplay?.(msg, this.mutableMessages)
          if (snipResult !== undefined) {
            if (snipResult.executed) {
              this.mutableMessages.length = 0
              this.mutableMessages.push(...snipResult.messages)
            }
            break
          }
          this.mutableMessages.push(msg)
          // 向 SDK yield compact 边界消息
          if (msg.subtype === 'compact_boundary' && msg.compactMetadata) {
            logForDebugging(
              `[Hapii] submitMessage.queryLoop compact_boundary: 压缩前消息数 mutableMsgCount=${this.mutableMessages.length}`,
              { level: 'info' },
            )
            const compactMsg = msg as SystemCompactBoundaryMessage
            // 释放压缩前的消息以便 GC。边界刚刚被 push，所以它是
            // 最后一个元素。query.ts 内部已经使用
            // getMessagesAfterCompactBoundary()，后续只需要边界之后
            // 的消息。
            const mutableBoundaryIdx = this.mutableMessages.length - 1
            if (mutableBoundaryIdx > 0) {
              this.mutableMessages.splice(0, mutableBoundaryIdx)
            }
            const localBoundaryIdx = messages.length - 1
            if (localBoundaryIdx > 0) {
              messages.splice(0, localBoundaryIdx)
            }

            yield {
              type: 'system',
              subtype: 'compact_boundary' as const,
              session_id: getSessionId(),
              uuid: msg.uuid,
              compact_metadata: toSDKCompactMetadata(
                compactMsg.compactMetadata,
              ),
            }
          }
          if (msg.subtype === 'api_error') {
            const apiErrorMsg = msg as Message & {
              retryAttempt: number
              maxRetries: number
              retryInMs: number
              error: APIError
            }
            logForDebugging(
              `[Hapii] submitMessage.queryLoop api_error: status=${apiErrorMsg.error.status ?? 'unknown'} attempt=${apiErrorMsg.retryAttempt}/${apiErrorMsg.maxRetries} retryInMs=${apiErrorMsg.retryInMs}`,
              { level: 'warn' },
            )
            yield {
              type: 'system',
              subtype: 'api_retry' as const,
              attempt: apiErrorMsg.retryAttempt,
              max_retries: apiErrorMsg.maxRetries,
              retry_delay_ms: apiErrorMsg.retryInMs,
              error_status: apiErrorMsg.error.status ?? null,
              error: categorizeRetryableAPIError(apiErrorMsg.error),
              session_id: getSessionId(),
              uuid: msg.uuid,
            }
          }
          // 在 headless 模式下不 yield 其他系统消息
          break
        }
        case 'tool_use_summary': {
          const msg = message as Message & {
            summary: unknown
            precedingToolUseIds: unknown
          }
          // 向 SDK yield 工具使用摘要消息
          yield {
            type: 'tool_use_summary' as const,
            summary: msg.summary,
            preceding_tool_use_ids: msg.precedingToolUseIds,
            session_id: getSessionId(),
            uuid: msg.uuid,
          }
          break
        }
      }

      // 检查是否超出 USD 预算
      if (maxBudgetUsd !== undefined && getTotalCost() >= maxBudgetUsd) {
        logForDebugging(
          `[Hapii] submitMessage.queryLoop 超出预算!: cost=$${getTotalCost()} maxBudget=$${maxBudgetUsd} turns=${turnCount}`,
          { level: 'warn' },
        )
        if (persistSession) {
          if (
            isEnvTruthy(process.env.CLAUDE_CODE_EAGER_FLUSH) ||
            isEnvTruthy(process.env.CLAUDE_CODE_IS_COWORK)
          ) {
            await flushSessionStorage()
          }
        }
        yield {
          type: 'result',
          subtype: 'error_max_budget_usd',
          duration_ms: Date.now() - startTime,
          duration_api_ms: getTotalAPIDuration(),
          is_error: true,
          num_turns: turnCount,
          stop_reason: lastStopReason,
          session_id: getSessionId(),
          total_cost_usd: getTotalCost(),
          usage: this.totalUsage,
          modelUsage: getModelUsage(),
          permission_denials: this.permissionDenials,
          fast_mode_state: getFastModeState(
            mainLoopModel,
            initialAppState.fastMode,
          ),
          uuid: randomUUID(),
          errors: [
            `Reached maximum budget ($${maxBudgetUsd}). Increase the limit with --max-budget-usd or start a new session.`,
          ],
        }
        return
      }

      // 检查是否超出结构化输出重试上限（仅针对 user 消息）
      if (message.type === 'user' && jsonSchema) {
        const currentCalls = countToolCalls(
          this.mutableMessages,
          SYNTHETIC_OUTPUT_TOOL_NAME,
        )
        const callsThisQuery = currentCalls - initialStructuredOutputCalls
        const maxRetries = parseInt(
          process.env.MAX_STRUCTURED_OUTPUT_RETRIES || '5',
          10,
        )
        if (callsThisQuery >= maxRetries) {
          logForDebugging(
            `[Hapii] submitMessage.queryLoop 结构化输出重试上限!: callsThisQuery=${callsThisQuery} maxRetries=${maxRetries} turns=${turnCount}`,
            { level: 'warn' },
          )
          if (persistSession) {
            if (
              isEnvTruthy(process.env.CLAUDE_CODE_EAGER_FLUSH) ||
              isEnvTruthy(process.env.CLAUDE_CODE_IS_COWORK)
            ) {
              await flushSessionStorage()
            }
          }
          yield {
            type: 'result',
            subtype: 'error_max_structured_output_retries',
            duration_ms: Date.now() - startTime,
            duration_api_ms: getTotalAPIDuration(),
            is_error: true,
            num_turns: turnCount,
            stop_reason: lastStopReason,
            session_id: getSessionId(),
            total_cost_usd: getTotalCost(),
            usage: this.totalUsage,
            modelUsage: getModelUsage(),
            permission_denials: this.permissionDenials,
            fast_mode_state: getFastModeState(
              mainLoopModel,
              initialAppState.fastMode,
            ),
            uuid: randomUUID(),
            errors: [
              `Failed to provide valid structured output after ${maxRetries} attempts`,
            ],
          }
          return
        }
      }
    }

    logForDebugging(
      `[Hapii] submitMessage.phase[query()循环完成]:
  总耗时=${Date.now() - startTime}ms
  totalAPIDuration=${getTotalAPIDuration()}ms
  累计token: input=${this.totalUsage.input_tokens}, output=${this.totalUsage.output_tokens}
  totalCost=$${getTotalCost()}
  turnCount=${turnCount}
  lastStopReason=${lastStopReason}
  mutableMsgCount=${this.mutableMessages.length}
  messagesCount=${messages.length}`,
      { level: 'info' },
    )

    // Stop hooks 在 assistant 响应之后 yield progress/attachment 消息
    //（通过 query.ts 中的 yield* handleStopHooks）。因为 #23537 将
    // 它们内联 push 到 `messages`，last(messages) 可能是 progress/
    // attachment 而不是 assistant —— 这会让下面的 textResult 提取
    // 返回 ''，-p 模式输出空行。允许列表限定为 assistant|user：
    // isResultSuccessful 两者都能处理（全是 tool_result 块的 user 是
    // 合法的成功终止状态）。
    const result = messages.findLast(
      m => m.type === 'assistant' || m.type === 'user',
    )
    logForDebugging(
      `[Hapii] submitMessage.phase[结果提取]: resultType=${result?.type ?? 'undefined'} lastStopReason=${lastStopReason}`,
      { level: 'info' },
    )
    // 为 error_during_execution 诊断捕获信息 —— isResultSuccessful
    // 是类型谓词（message is Message），所以在 false 分支里
    // `result` 会被收窄为 never，这些访问无法通过类型检查。
    const edeResultType = result?.type ?? 'undefined'
    const edeLastContentType =
      result?.type === 'assistant'
        ? (last(
            result.message!
              .content as import('@anthropic-ai/sdk/resources/beta/messages/messages.js').BetaContentBlock[],
          )?.type ?? 'none')
        : 'n/a'

    // 在 yield result 之前 flush 缓冲的 transcript 写入。
    // 桌面应用在收到 result 消息后会立即杀死 CLI 进程，任何未 flush
    // 的写入都会丢失。
    if (persistSession) {
      if (
        isEnvTruthy(process.env.CLAUDE_CODE_EAGER_FLUSH) ||
        isEnvTruthy(process.env.CLAUDE_CODE_IS_COWORK)
      ) {
        await flushSessionStorage()
      }
    }

    if (!isResultSuccessful(result, lastStopReason)) {
      logForDebugging(
        `[Hapii] submitMessage.phase[执行错误!]: resultType=${edeResultType} lastContentType=${edeLastContentType} stopReason=${lastStopReason} turns=${turnCount}`,
        { level: 'error' },
      )
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        duration_ms: Date.now() - startTime,
        duration_api_ms: getTotalAPIDuration(),
        is_error: true,
        num_turns: turnCount,
        stop_reason: lastStopReason,
        session_id: getSessionId(),
        total_cost_usd: getTotalCost(),
        usage: this.totalUsage,
        modelUsage: getModelUsage(),
        permission_denials: this.permissionDenials,
        fast_mode_state: getFastModeState(
          mainLoopModel,
          initialAppState.fastMode,
        ),
        uuid: randomUUID(),
        // 诊断前缀：这些就是 isResultSuccessful() 检查的内容 —— 如果
        // result 的类型不是带 text/thinking 的 assistant 或带
        // tool_result 的 user，并且 stop_reason 不是 end_turn，就是触
        // 发本次错误的原因。errors[] 通过水位线按轮次作用域；此前它
        // 会 dump 整个进程的 logError 缓冲（ripgrep 超时、ENOENT 等）。
        errors: (() => {
          const all = getInMemoryErrors()
          const start = errorLogWatermark
            ? all.lastIndexOf(errorLogWatermark) + 1
            : 0
          return [
            `[ede_diagnostic] result_type=${edeResultType} last_content_type=${edeLastContentType} stop_reason=${lastStopReason}`,
            ...all.slice(start).map(_ => _.error),
          ]
        })(),
      }
      return
    }

    // 根据消息类型提取文本结果
    let textResult = ''
    let isApiError = false

    if (result.type === 'assistant') {
      const lastContent = last(
        result.message!
          .content as import('@anthropic-ai/sdk/resources/beta/messages/messages.js').BetaContentBlock[],
      )
      if (
        lastContent?.type === 'text' &&
        !SYNTHETIC_MESSAGES.has(lastContent.text)
      ) {
        textResult = lastContent.text
      }
      isApiError = Boolean(result.isApiErrorMessage)
    }

    logForDebugging(
      `-------------- submitMessage 结束 ---------
[Hapii] QueryEngine.submitMessage 完成:
  耗时=${Date.now() - startTime}ms
  apiDuration=${getTotalAPIDuration()}ms
  turns=${turnCount}
  finalMsgCount=${this.mutableMessages.length}
  totalCost=$${getTotalCost()}
  totalUsage: input=${this.totalUsage.input_tokens} output=${this.totalUsage.output_tokens}
  stopReason=${lastStopReason}
  isApiError=${isApiError}
  textResultLen=${textResult.length}
  hasStructuredOutput=${structuredOutputFromTool !== undefined}`,
      { level: 'info' },
    )
    yield {
      type: 'result',
      subtype: 'success',
      is_error: isApiError,
      duration_ms: Date.now() - startTime,
      duration_api_ms: getTotalAPIDuration(),
      num_turns: turnCount,
      result: textResult,
      stop_reason: lastStopReason,
      session_id: getSessionId(),
      total_cost_usd: getTotalCost(),
      usage: this.totalUsage,
      modelUsage: getModelUsage(),
      permission_denials: this.permissionDenials,
      structured_output: structuredOutputFromTool,
      fast_mode_state: getFastModeState(
        mainLoopModel,
        initialAppState.fastMode,
      ),
      uuid: randomUUID(),
    }
  }

  interrupt(): void {
    logForDebugging(
      `-------------- interrupt 开始 -----------
[Hapii] QueryEngine.interrupt: 中止当前查询 signal.aborted=${this.abortController.signal.aborted}`,
      { level: 'info' },
    )
    this.abortController.abort()
    logForDebugging(
      `-------------- interrupt 结束 ---------
[Hapii] QueryEngine.interrupt: 已完成 signal.aborted=${this.abortController.signal.aborted}`,
      { level: 'info' },
    )
  }

  /** 重置 abort controller，让下次 submitMessage() 调用可以拿到
   *  全新的、未被 abort 的信号。必须在 interrupt() 之后调用。 */
  resetAbortController(): void {
    logForDebugging(
      `-------------- resetAbortController 开始 -----------
[Hapii] QueryEngine.resetAbortController: 旧signal.aborted=${this.abortController.signal.aborted}`,
      { level: 'info' },
    )
    this.abortController = createAbortController()
    logForDebugging(
      `-------------- resetAbortController 结束 ---------
[Hapii] QueryEngine.resetAbortController: 新signal.aborted=${this.abortController.signal.aborted}`,
      { level: 'info' },
    )
  }

  /** 对外暴露当前的 abort 信号，供外部消费者（如 ACP bridge）使用。 */
  getAbortSignal(): AbortSignal {
    logForDebugging(
      `[Hapii] QueryEngine.getAbortSignal: signal.aborted=${this.abortController.signal.aborted}`,
      { level: 'verbose' },
    )
    return this.abortController.signal
  }

  getMessages(): readonly Message[] {
    logForDebugging(
      `[Hapii] QueryEngine.getMessages: msgCount=${this.mutableMessages.length}`,
      { level: 'verbose' },
    )
    return this.mutableMessages
  }

  getReadFileState(): FileStateCache {
    logForDebugging(`[Hapii] QueryEngine.getReadFileState: 返回文件状态缓存`, {
      level: 'verbose',
    })
    return this.readFileState
  }

  getSessionId(): string {
    const sid = getSessionId()
    logForDebugging(`[Hapii] QueryEngine.getSessionId: sessionId=${sid}`, {
      level: 'verbose',
    })
    return sid
  }

  setModel(model: string): void {
    logForDebugging(
      `-------------- setModel 开始 -----------
[Hapii] QueryEngine.setModel: oldModel=${this.config.userSpecifiedModel ?? 'default'} newModel=${model}`,
      { level: 'info' },
    )
    this.config.userSpecifiedModel = model
    logForDebugging(`-------------- setModel 结束 ---------`, { level: 'info' })
  }
}

/**
 * 一次性查询便捷函数 —— 发送单个 prompt 并返回响应，不进入交互模式。
 * 假设 claude 以非交互方式使用 —— 不会向用户请求权限或进一步输入。
 *
 * 适用于：-p / --print 管道模式、SDK 调用、脚本自动化。
 * 内部创建一个临时 QueryEngine 实例，执行一次 submitMessage() 后销毁。
 *
 * QueryEngine 的一次性使用便捷封装。
 */
export async function* ask({
  commands,
  prompt,
  promptUuid,
  isMeta,
  cwd,
  tools,
  mcpClients,
  verbose = false,
  thinkingConfig,
  maxTurns,
  maxBudgetUsd,
  taskBudget,
  canUseTool,
  mutableMessages = [],
  getReadFileCache,
  setReadFileCache,
  customSystemPrompt,
  appendSystemPrompt,
  userSpecifiedModel,
  fallbackModel,
  jsonSchema,
  getAppState,
  setAppState,
  abortController,
  replayUserMessages = false,
  includePartialMessages = false,
  handleElicitation,
  agents = [],
  setSDKStatus,
  orphanedPermission,
}: {
  commands: Command[]
  prompt: string | Array<ContentBlockParam>
  promptUuid?: string
  isMeta?: boolean
  cwd: string
  tools: Tools
  verbose?: boolean
  mcpClients: MCPServerConnection[]
  thinkingConfig?: ThinkingConfig
  maxTurns?: number
  maxBudgetUsd?: number
  taskBudget?: { total: number }
  canUseTool: CanUseToolFn
  mutableMessages?: Message[]
  customSystemPrompt?: string
  appendSystemPrompt?: string
  userSpecifiedModel?: string
  fallbackModel?: string
  jsonSchema?: Record<string, unknown>
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
  getReadFileCache: () => FileStateCache
  setReadFileCache: (cache: FileStateCache) => void
  abortController?: AbortController
  replayUserMessages?: boolean
  includePartialMessages?: boolean
  handleElicitation?: ToolUseContext['handleElicitation']
  agents?: AgentDefinition[]
  setSDKStatus?: (status: SDKStatus) => void
  orphanedPermission?: OrphanedPermission
}): AsyncGenerator<SDKMessage, void, unknown> {
  logForDebugging(
    `-------------- ask 开始 -----------
[Hapii] QueryEngine.ask 参数:
  promptLen=${typeof prompt === 'string' ? prompt.length : prompt.length}
  promptType=${typeof prompt === 'string' ? 'string' : 'ContentBlockParam[]'}
  cwd=${cwd}
  toolsCount=${tools.length}
  commandsCount=${commands.length}
  mcpClientsCount=${mcpClients.length}
  agentsCount=${agents.length}
  mutableMsgCount=${mutableMessages.length}
  userSpecifiedModel=${userSpecifiedModel ?? 'default'}
  hasFallbackModel=${fallbackModel !== undefined}
  maxTurns=${maxTurns ?? 'unlimited'}
  maxBudgetUsd=${maxBudgetUsd ?? 'unlimited'}
  hasJsonSchema=${jsonSchema !== undefined}
  replayUserMessages=${replayUserMessages}
  includePartialMessages=${includePartialMessages}
  hasAbortController=${abortController !== undefined}
  hasOrphanedPermission=${orphanedPermission !== undefined}`,
    { level: 'info' },
  )
  const engine = new QueryEngine({
    cwd,
    tools,
    commands,
    mcpClients,
    agents: agents ?? [],
    canUseTool,
    getAppState,
    setAppState,
    initialMessages: mutableMessages,
    readFileCache: cloneFileStateCache(getReadFileCache()),
    customSystemPrompt,
    appendSystemPrompt,
    userSpecifiedModel,
    fallbackModel,
    thinkingConfig,
    maxTurns,
    maxBudgetUsd,
    taskBudget,
    jsonSchema,
    verbose,
    handleElicitation,
    replayUserMessages,
    includePartialMessages,
    setSDKStatus,
    abortController,
    orphanedPermission,
    ...(feature('HISTORY_SNIP')
      ? {
          snipReplay: (yielded: Message, store: Message[]) => {
            if (!snipProjection!.isSnipBoundaryMessage(yielded))
              return undefined
            return snipModule!.snipCompactIfNeeded(store, { force: true })
          },
        }
      : {}),
  })

  logForDebugging(
    `[Hapii] ask.phase[引擎创建完成]: 开始 submitMessage mutableMsgCount=${mutableMessages.length}`,
    { level: 'info' },
  )
  try {
    yield* engine.submitMessage(prompt, {
      uuid: promptUuid,
      isMeta,
    })
  } finally {
    setReadFileCache(engine.getReadFileState())
    logForDebugging(
      `-------------- ask 结束 ---------
[Hapii] QueryEngine.ask 完成: 文件状态缓存已回写`,
      { level: 'info' },
    )
  }
}
