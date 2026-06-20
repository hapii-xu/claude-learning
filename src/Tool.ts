import type {
  ToolResultBlockParam,
  ToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
export type { ToolResultBlockParam }
import type {
  ElicitRequestURLParams,
  ElicitResult,
} from '@modelcontextprotocol/sdk/types.js'
import type { UUID } from 'crypto'
import type { z } from 'zod/v4'
import type { Command } from './commands.js'
import type { CanUseToolFn } from './hooks/useCanUseTool.js'
import type { ThinkingConfig } from './utils/thinking.js'

export type ToolInputJSONSchema = {
  [x: string]: unknown
  type: 'object'
  properties?: {
    [x: string]: unknown
  }
}

import type { Notification } from './context/notifications.js'
import type {
  MCPServerConnection,
  ServerResource,
} from './services/mcp/types.js'
import type {
  AgentDefinition,
  AgentDefinitionsResult,
} from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  ProgressMessage,
  SystemLocalCommandMessage,
  SystemMessage,
  UserMessage,
} from './types/message.js'
// 从集中位置导入权限类型，以打破导入循环
// 从集中位置导入 PermissionResult，以打破导入循环
import type {
  AdditionalWorkingDirectory,
  PermissionMode,
  PermissionResult,
} from './types/permissions.js'
// 从集中位置导入工具进度类型，以打破导入循环
import type {
  AgentToolProgress,
  BashProgress,
  MCPProgress,
  REPLToolProgress,
  SkillToolProgress,
  TaskOutputProgress,
  ToolProgressData,
  WebSearchProgress,
} from './types/tools.js'
import type { FileStateCache } from './utils/fileStateCache.js'
import type { DenialTrackingState } from './utils/permissions/denialTracking.js'
import type { SystemPrompt } from './utils/systemPromptType.js'
import type { ContentReplacementState } from './utils/toolResultStorage.js'

// 重新导出进度类型，以保持向后兼容
export type {
  AgentToolProgress,
  BashProgress,
  MCPProgress,
  REPLToolProgress,
  SkillToolProgress,
  TaskOutputProgress,
  WebSearchProgress,
}

import type { SpinnerMode } from './components/Spinner.js'
import type { QuerySource } from './constants/querySource.js'
import type { SDKStatus } from './entrypoints/agentSdkTypes.js'
import type { AppState } from './state/AppState.js'
import type { LangfuseSpan } from './services/langfuse/index.js'
import type {
  HookProgress,
  PromptRequest,
  PromptResponse,
} from './types/hooks.js'
import type { AgentId } from './types/ids.js'
import type { DeepImmutable } from './types/utils.js'
import type { AttributionState } from './utils/commitAttribution.js'
import type { FileHistoryState } from './utils/fileHistory.js'
import type { Theme, ThemeName } from './utils/theme.js'

export type QueryChainTracking = {
  chainId: string
  depth: number
}

export type ValidationResult =
  | { result: true }
  | {
      result: false
      message: string
      errorCode: number
    }

export type SetToolJSXFn = (
  args: {
    jsx: React.ReactNode | null
    shouldHidePromptInput: boolean
    shouldContinueAnimation?: true
    showSpinner?: boolean
    isLocalJSXCommand?: boolean
    isImmediate?: boolean
    /** 设置为 true 以清除本地 JSX 命令（例如，从其 onDone 回调中清除） */
    clearLocalJSX?: boolean
  } | null,
) => void

// 从集中位置导入工具权限类型，以打破导入循环
import type { ToolPermissionRulesBySource } from './types/permissions.js'

// 重新导出，以保持向后兼容
export type { ToolPermissionRulesBySource }

// 对导入的类型应用 DeepImmutable
export type ToolPermissionContext = DeepImmutable<{
  mode: PermissionMode
  additionalWorkingDirectories: Map<string, AdditionalWorkingDirectory>
  alwaysAllowRules: ToolPermissionRulesBySource
  alwaysDenyRules: ToolPermissionRulesBySource
  alwaysAskRules: ToolPermissionRulesBySource
  isBypassPermissionsModeAvailable: boolean
  isAutoModeAvailable?: boolean
  strippedDangerousRules?: ToolPermissionRulesBySource
  /** 当为 true 时，权限提示会被自动拒绝（例如，无法显示 UI 的后台代理） */
  shouldAvoidPermissionPrompts?: boolean
  /** 当为 true 时，在显示权限对话框之前会等待自动化检查（分类器、hooks）完成（coordinator workers） */
  awaitAutomatedChecksBeforeDialog?: boolean
  /** 存储模型发起的计划模式进入前的权限模式，以便在退出时恢复 */
  prePlanMode?: PermissionMode
}>

export const getEmptyToolPermissionContext: () => ToolPermissionContext =
  () => ({
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: true,
  })

export type CompactProgressEvent =
  | {
      type: 'hooks_start'
      hookType: 'pre_compact' | 'post_compact' | 'session_start'
    }
  | { type: 'compact_start' }
  | { type: 'compact_end' }

export type ToolUseContext = {
  options: {
    commands: Command[]
    debug: boolean
    mainLoopModel: string
    tools: Tools
    verbose: boolean
    thinkingConfig: ThinkingConfig
    mcpClients: MCPServerConnection[]
    mcpResources: Record<string, ServerResource[]>
    isNonInteractiveSession: boolean
    agentDefinitions: AgentDefinitionsResult
    maxBudgetUsd?: number
    /** 替换默认系统提示词的自定义系统提示词 */
    customSystemPrompt?: string
    /** 追加在主系统提示词之后的附加系统提示词 */
    appendSystemPrompt?: string
    /** 覆盖 querySource 以进行分析跟踪 */
    querySource?: QuerySource
    /** 可选回调，用于获取最新工具列表（例如，在 MCP 服务器在查询过程中连接后） */
    refreshTools?: () => Tools
    /**
     * @internal 仅限测试的逃生舱。在生产环境中必须保持为 undefined。
     *
     * 允许非打包的单元测试工具 exercising 后台分叉斜杠命令路径，
     * 该路径在生产助手模式中由 `feature('KAIROS')` 门控。
     * 仍然需要 `AppState.kairosEnabled`。此字段仅由受信应用程序代码
     * 在进程内构造；没有外部表面（MCP、插件、斜杠命令、网络）
     * 写入 `ToolUseContext.options`。在测试之外设置此值会绕过
     * KAIROS 功能标志；`processSlashCommand` 在 `NODE_ENV=test`
     * 之外拒绝此标志。
     */
    allowBackgroundForkedSlashCommands?: boolean
  }
  abortController: AbortController
  readFileState: FileStateCache
  getAppState(): AppState
  setAppState(f: (prev: AppState) => AppState): void
  /**
   * 始终共享的 setAppState，用于会话范围的基础设施（后台任务、会话 hooks）。
   * 与 setAppState 不同（后者对异步代理是 no-op，参见 createSubagentContext），
   * 这始终到达根存储，以便任何嵌套深度的代理都可以注册/清理
   * 比单个轮次更长存活的基础设施。仅由 createSubagentContext 设置；
   * 主线程上下文回退到 setAppState。
   */
  setAppStateForTasks?: (f: (prev: AppState) => AppState) => void
  /**
   * 可选的 URL elicitations 处理器，由工具调用错误（-32042）触发。
   * 在 print/SDK 模式下，这委托给 structuredIO.handleElicitation。
   * 在 REPL 模式下，这是 undefined，使用基于队列的 UI 路径。
   */
  handleElicitation?: (
    serverName: string,
    params: ElicitRequestURLParams,
    signal: AbortSignal,
  ) => Promise<ElicitResult>
  setToolJSX?: SetToolJSXFn
  addNotification?: (notif: Notification) => void
  /** 将仅 UI 的系统消息追加到 REPL 消息列表。在 normalizeMessagesForAPI 边界处被剥离
   *  — Exclude<> 使其成为类型强制的。 */
  appendSystemMessage?: (
    msg: Exclude<SystemMessage, SystemLocalCommandMessage>,
  ) => void
  /** 发送操作系统级别的通知（iTerm2、Kitty、Ghostty、bell 等） */
  sendOSNotification?: (opts: {
    message: string
    notificationType: string
  }) => void
  nestedMemoryAttachmentTriggers?: Set<string>
  /**
   * 本会话中已作为嵌套内存附件注入的 CLAUDE.md 路径。
   * 为 memoryFilesToAttachments 去重 — readFileState 是一个 LRU，
   * 在繁忙会话中会驱逐条目，所以仅靠其 .has() 检查可能会
   * 重新注入同一个 CLAUDE.md 数十次。
   */
  loadedNestedMemoryPaths?: Set<string>
  dynamicSkillDirTriggers?: Set<string>
  /** 本会话中通过 skill_discovery 显示的 skill 名称。仅用于遥测（提供 was_discovered）。 */
  discoveredSkillNames?: Set<string>
  userModified?: boolean
  setInProgressToolUseIDs: (f: (prev: Set<string>) => Set<string>) => void
  /** 仅在交互式（REPL）上下文中连接；SDK/QueryEngine 不设置此项。 */
  setHasInterruptibleToolInProgress?: (v: boolean) => void
  setResponseLength: (f: (prev: number) => number) => void
  /** 仅限 Ant：推送新的 API 指标条目以进行 OTPS 跟踪。
   *  当新的 API 请求开始时由子代理流调用。 */
  pushApiMetricsEntry?: (ttftMs: number) => void
  setStreamMode?: (mode: SpinnerMode) => void
  onCompactProgress?: (event: CompactProgressEvent) => void
  setSDKStatus?: (status: SDKStatus) => void
  openMessageSelector?: () => void
  updateFileHistoryState: (
    updater: (prev: FileHistoryState) => FileHistoryState,
  ) => void
  updateAttributionState: (
    updater: (prev: AttributionState) => AttributionState,
  ) => void
  setConversationId?: (id: UUID) => void
  agentId?: AgentId // 仅为子代理设置；使用 getSessionId() 获取会话 ID。hooks 使用此项区分子代理调用。
  agentType?: string // 子代理类型名称。对于主线程的 --agent 类型，hooks 回退到 getMainThreadAgentType()。
  /** 当为 true 时，即使 hooks 自动批准，也必须始终调用 canUseTool。
   *  由推测用于覆盖文件路径重写。 */
  requireCanUseTool?: boolean
  messages: Message[]
  fileReadingLimits?: {
    maxTokens?: number
    maxSizeBytes?: number
  }
  globLimits?: {
    maxResults?: number
  }
  toolDecisions?: Map<
    string,
    {
      source: string
      decision: 'accept' | 'reject'
      timestamp: number
    }
  >
  queryTracking?: QueryChainTracking
  /** 交互式提示请求的回调工厂。
   * 返回绑定到给定源名称的提示回调。
   * 仅在交互式（REPL）上下文中可用。 */
  requestPrompt?: (
    sourceName: string,
    toolInputSummary?: string | null,
  ) => (request: PromptRequest) => Promise<PromptResponse>
  toolUseId?: string
  criticalSystemReminder_EXPERIMENTAL?: string
  /** 此查询轮次的 Langfuse 根追踪 span。传递到工具执行以实现可观察性。 */
  langfuseTrace?: LangfuseSpan | null
  /** 外部/主代理追踪的 Langfuse 根追踪 span。当子代理需要将观察结果嵌套在父代理追踪下时使用。 */
  langfuseRootTrace?: LangfuseSpan | null
  /** 包装并发工具组的 Langfuse 批处理 span。设置后，工具观察结果将嵌套在其下。 */
  langfuseBatchSpan?: LangfuseSpan | null
  /** 当为 true 时，即使对于子代理也保留消息上的 toolUseResult。
   * 用于其文字记录可由用户查看的进程内队友。 */
  preserveToolUseResults?: boolean
  /** 异步子代理的本地拒绝跟踪状态，其 setAppState 是 no-op。
   * 没有这个，拒绝计数器永远不会累积，回退到提示的阈值
   * 永远不会达到。可变 — 权限代码会原地更新它。 */
  localDenialTracking?: DenialTrackingState
  /**
   * 工具结果预算的每个对话线程内容替换状态。
   * 存在时，query.ts 应用聚合工具结果预算。
   * 主线程：REPL 配置一次（永不重置 — 过时的 UUID 键是无害的）。
   * 子代理：createSubagentContext 默认克隆父级的状态
   * （缓存共享分叉需要相同的决策），或 resumeAgentBackground
   * 线程从侧链记录重建一个。
   */
  contentReplacementState?: ContentReplacementState
  /**
   * 父级在轮次开始时冻结的渲染系统提示字节。
   * 由分叉子代理用于共享父级的提示缓存 — 在分叉生成时
   * 重新调用 getSystemPrompt() 可能会分歧（GrowthBook 冷→热）
   * 并破坏缓存。参见 forkSubagent.ts。
   */
  renderedSystemPrompt?: SystemPrompt
}

// 从集中位置重新导出 ToolProgressData
export type { ToolProgressData }

export type Progress = ToolProgressData | HookProgress

export type ToolProgress<P extends ToolProgressData> = {
  toolUseID: string
  data: P
}

export function filterToolProgressMessages(
  progressMessagesForMessage: ProgressMessage[],
): ProgressMessage<ToolProgressData>[] {
  return progressMessagesForMessage.filter(
    (msg): msg is ProgressMessage<ToolProgressData> =>
      (msg.data as { type?: string })?.type !== 'hook_progress',
  )
}

export type ToolResult<T> = {
  data: T
  newMessages?: (
    | UserMessage
    | AssistantMessage
    | AttachmentMessage
    | SystemMessage
  )[]
  // contextModifier is only honored for tools that aren't concurrency safe.
  contextModifier?: (context: ToolUseContext) => ToolUseContext
  /** MCP protocol metadata (structuredContent, _meta) to pass through to SDK consumers */
  mcpMeta?: {
    _meta?: Record<string, unknown>
    structuredContent?: Record<string, unknown>
  }
}

export type ToolCallProgress<P extends ToolProgressData = ToolProgressData> = (
  progress: ToolProgress<P>,
) => void

// 输出带字符串键的对象的任意 schema 类型
export type AnyObject = z.ZodType<{ [key: string]: unknown }>

/**
 * 检查工具是否与给定名称（主名称或别名）匹配。
 */
export function toolMatchesName(
  tool: { name: string; aliases?: string[] },
  name: string,
): boolean {
  return tool.name === name || (tool.aliases?.includes(name) ?? false)
}

/**
 * 从工具列表中按名称或别名查找工具。
 */
export function findToolByName(tools: Tools, name: string): Tool | undefined {
  return tools.find(t => toolMatchesName(t, name))
}

export type Tool<
  Input extends AnyObject = AnyObject,
  Output = unknown,
  P extends ToolProgressData = ToolProgressData,
> = {
  /**
   * 工具重命名时用于向后兼容的可选别名。
   * 除了主名称外，工具还可以通过其中任何名称进行查找。
   */
  aliases?: string[]
  /**
   * SearchExtraTools 用于关键字匹配的单行能力短语。
   * 帮助模型在工具被延迟时通过关键字搜索找到此工具。
   * 3-10 个词，无尾随句号。
   * 优先使用工具名称中尚未存在的术语（例如，NotebookEdit 用 'jupyter'）。
   */
  searchHint?: string
  call(
    args: z.infer<Input>,
    context: ToolUseContext,
    canUseTool: CanUseToolFn,
    parentMessage: AssistantMessage,
    onProgress?: ToolCallProgress<P>,
  ): Promise<ToolResult<Output>>
  description(
    input: z.infer<Input>,
    options: {
      isNonInteractiveSession: boolean
      toolPermissionContext: ToolPermissionContext
      tools: Tools
    },
  ): Promise<string>
  readonly inputSchema: Input
  // 用于 MCP 工具的类型，可以直接以 JSON Schema 格式指定输入 schema
  // 而不是从 Zod schema 转换
  readonly inputJSONSchema?: ToolInputJSONSchema
  // 可选，因为 TungstenTool 未定义此项。TODO: 使其成为必需的。
  // 当我们这样做时，我们也可以使其更具类型安全性。
  outputSchema?: z.ZodType<unknown>
  inputsEquivalent?(a: z.infer<Input>, b: z.infer<Input>): boolean
  isConcurrencySafe(input: z.infer<Input>): boolean
  isEnabled(): boolean
  isReadOnly(input: z.infer<Input>): boolean
  /** 默认为 false。仅当工具执行不可逆操作（删除、覆盖、发送）时设置。 */
  isDestructive?(input: z.infer<Input>): boolean
  /**
   * 当用户在此工具运行时提交新消息时应发生什么。
   *
   * - `'cancel'` — 停止工具并丢弃其结果
   * - `'block'`  — 继续运行；新消息等待
   *
   * 未实现时默认为 `'block'`。
   */
  interruptBehavior?(): 'cancel' | 'block'
  /**
   * 返回关于此工具使用是否应折叠为 UI 中紧凑显示的搜索或读取操作的信息。
   * 示例包括文件搜索（Grep、Glob）、文件读取（Read）以及 bash 命令如 find、
   * grep、wc 等。
   *
   * 返回指示操作是否为搜索或读取操作的对象：
   * - `isSearch: true` 用于搜索操作（grep、find、glob 模式）
   * - `isRead: true` 用于读取操作（cat、head、tail、文件读取）
   * - `isList: true` 用于目录列表操作（ls、tree、du）
   * - 如果操作不应被折叠，所有值都可以为 false
   */
  isSearchOrReadCommand?(input: z.infer<Input>): {
    isSearch: boolean
    isRead: boolean
    isList?: boolean
  }
  isOpenWorld?(input: z.infer<Input>): boolean
  requiresUserInteraction?(): boolean
  isMcp?: boolean
  isLsp?: boolean
  /**
   * 当为 true 时，此工具被延迟（发送时带 defer_loading: true）并需要
   * 在调用之前使用 SearchExtraTools。
   */
  readonly shouldDefer?: boolean
  /**
   * 当为 true 时，此工具永不被延迟 — 即使启用 SearchExtraTools，
   * 其完整 schema 也会出现在初始提示中。对于 MCP 工具，通过
   * `_meta['anthropic/alwaysLoad']` 设置。用于模型必须在第 1 轮
   * 就看到而无需 SearchExtraTools 往返的工具。
   */
  readonly alwaysLoad?: boolean
  /**
   * 对于 MCP 工具：从 MCP 服务器接收的服务器和工具名称（未规范化）。
   * 无论 `name` 是否有前缀（mcp__server__tool）或无前缀
   * （CLAUDE_AGENT_SDK_MCP_NO_PREFIX 模式），都存在于所有 MCP 工具上。
   */
  mcpInfo?: { serverName: string; toolName: string }
  readonly name: string
  /**
   * 工具结果在持久化到磁盘之前的最大字符大小。
   * 超过时，结果保存到文件，Claude 接收带有文件路径的预览
   * 而不是完整内容。
   *
   * 设置为 Infinity 用于其输出永不应被持久化的工具（例如 Read，
   * 其中持久化会创建 Read→文件→Read 循环，并且工具已经
   * 通过其自身的限制进行自绑定）。
   */
  maxResultSizeChars: number
  /**
   * 当为 true 时，为此工具启用严格模式，使 API 更严格地
   * 遵循工具指令和参数 schema。
   * 仅在启用 tengu_tool_pear 时应用。
   */
  readonly strict?: boolean

  /**
   * 在观察者（SDK 流、文字记录、canUseTool、PreToolUse/PostToolUse hooks）
   * 看到之前，在 tool_use 输入的副本上调用。就地修改以添加遗留/派生字段。
   * 必须是幂等的。原始的 API 绑定输入永远不会被修改（保留提示缓存）。
   * 当 hook/权限返回新的 updatedInput 时不会重新应用 — 那些拥有自己的形状。
   */
  backfillObservableInput?(input: Record<string, unknown>): void

  /**
   * 确定在当前上下文中是否允许使用此输入运行此工具。
   * 它告知模型工具使用失败的原因，不直接显示任何 UI。
   * @param input
   * @param context
   */
  validateInput?(
    input: z.infer<Input>,
    context: ToolUseContext,
  ): Promise<ValidationResult>

  /**
   * 确定是否询问用户权限。仅在 validateInput() 通过后调用。
   * 通用权限逻辑在 permissions.ts 中。此方法包含工具特定逻辑。
   * @param input
   * @param context
   */
  checkPermissions(
    input: z.infer<Input>,
    context: ToolUseContext,
  ): Promise<PermissionResult>

  // 可选方法，用于在文件路径上操作的工具
  getPath?(input: z.infer<Input>): string

  /**
   * 为 hook `if` 条件（权限规则模式如 "Bash(git *)" 中的 "git *"）
   * 准备匹配器。每个 hook 输入对调用一次；任何昂贵的解析都在这里发生。
   * 返回一个闭包，每个 hook 模式调用一次。如果未实现，
   * 则仅工具名称级别的匹配有效。
   */
  preparePermissionMatcher?(
    input: z.infer<Input>,
  ): Promise<(pattern: string) => boolean>

  prompt(options: {
    getToolPermissionContext: () => Promise<ToolPermissionContext>
    tools: Tools
    agents: AgentDefinition[]
    allowedAgentTypes?: string[]
  }): Promise<string>
  userFacingName(input: Partial<z.infer<Input>> | undefined): string
  userFacingNameBackgroundColor?(
    input: Partial<z.infer<Input>> | undefined,
  ): keyof Theme | undefined
  /**
   * 透明包装器（例如 REPL）将所有渲染委托给其进度处理器，
   * 该处理器为每个内部工具调用发出原生外观的块。
   * 包装器本身不显示任何内容。
   */
  isTransparentWrapper?(): boolean
  /**
   * 返回此工具使用的简短字符串摘要，用于紧凑视图显示。
   * @param input 工具输入
   * @returns 简短字符串摘要，或 null 表示不显示
   */
  getToolUseSummary?(input: Partial<z.infer<Input>> | undefined): string | null
  /**
   * 返回用于 spinner 显示的人类可读的现在时活动描述。
   * 示例："Reading src/foo.ts"、"Running bun test"、"Searching for pattern"
   * @param input 工具输入
   * @returns 活动描述字符串，或 null 回退到工具名称
   */
  getActivityDescription?(
    input: Partial<z.infer<Input>> | undefined,
  ): string | null
  /**
   * 返回此工具使用的紧凑表示，用于 auto-mode 安全分类器。
   * 示例：Bash 的 `ls -la`、Edit 的 `/tmp/x: new content`。
   * 返回 '' 以在分类器文字记录中跳过此工具（例如，没有安全相关性的工具）。
   * 当调用方 JSON 包装值时，可以返回对象以避免双重编码。
   */
  toAutoClassifierInput(input: z.infer<Input>): unknown
  mapToolResultToToolResultBlockParam(
    content: Output,
    toolUseID: string,
  ): ToolResultBlockParam
  /**
   * 可选。省略时，工具结果不渲染任何内容（与返回 null 相同）。
   * 对于其结果在其他地方显示的工具省略此项（例如，TodoWrite
   * 更新待办面板，而不是文字记录）。
   */
  renderToolResultMessage?(
    content: Output,
    progressMessagesForMessage: ProgressMessage<P>[],
    options: {
      style?: 'condensed'
      theme: ThemeName
      tools: Tools
      verbose: boolean
      isTranscriptMode?: boolean
      isBriefOnly?: boolean
      /** 原始 tool_use 输入，当可用时。用于引用请求内容的紧凑结果
       * 摘要（例如 "Sent to #foo"）。 */
      input?: unknown
    },
  ): React.ReactNode
  /**
   * renderToolResultMessage 在文字记录模式（verbose=true, isTranscriptMode=true）
   * 下显示内容的扁平化文本。用于文字记录搜索索引：索引计算此字符串中的
   * 出现次数，高亮覆盖层扫描实际屏幕缓冲区。为使计数 ≡ 高亮，
   * 这必须返回最终可见的文本 — 而不是来自 mapToolResultToToolResultBlockParam
   * 的面向模型的序列化（后者添加 system-reminders、持久化输出包装器）。
   *
   * Chrome 可以跳过（计数不足是可以的）。"Found 3 files in 12ms"
   * 不值得索引。幻象文本不可以 — 这里声称但不渲染的文本是计数≠高亮 bug。
   *
   * 可选：省略 → transcriptSearch.ts 中的字段名启发式。
   * 漂移由 test/utils/transcriptSearch.renderFidelity.test.tsx 捕获，
   * 该测试渲染示例输出并标记已索引但未渲染（幻象）或已渲染但未索引
   * （计数不足警告）的文本。
   */
  extractSearchText?(out: Output): string
  /**
   * 渲染工具使用消息。注意 `input` 是 partial 的，因为我们尽快渲染消息，
   * 可能在工具参数完全流入之前。
   */
  renderToolUseMessage(
    input: Partial<z.infer<Input>>,
    options: { theme: ThemeName; verbose: boolean; commands?: Command[] },
  ): React.ReactNode
  /**
   * 当此输出的非详细渲染被截断时返回 true
   * （即，单击展开将显示更多内容）。在全屏中控制点击展开
   * — 只有详细模式实际显示更多内容的消息才有悬停/点击提示。
   * 未设置表示永不截断。
   */
  isResultTruncated?(output: Output): boolean
  /**
   * 渲染可选标签以显示在工具使用消息之后。
   * 用于额外元数据，如超时、模型、恢复 ID 等。
   * 返回 null 表示不显示任何内容。
   */
  renderToolUseTag?(input: Partial<z.infer<Input>>): React.ReactNode
  /**
   * 可选。省略时，工具运行时不显示进度 UI。
   */
  renderToolUseProgressMessage?(
    progressMessagesForMessage: ProgressMessage<P>[],
    options: {
      tools: Tools
      verbose: boolean
      terminalSize?: { columns: number; rows: number }
      inProgressToolCallCount?: number
      isTranscriptMode?: boolean
    },
  ): React.ReactNode
  renderToolUseQueuedMessage?(): React.ReactNode
  /**
   * 可选。省略时，回退到 <FallbackToolUseRejectedMessage />。
   * 仅为需要自定义拒绝 UI 的工具定义此项（例如，显示被拒绝差异的文件编辑）。
   */
  renderToolUseRejectedMessage?(
    input: z.infer<Input>,
    options: {
      columns: number
      messages: Message[]
      style?: 'condensed'
      theme: ThemeName
      tools: Tools
      verbose: boolean
      progressMessagesForMessage: ProgressMessage<P>[]
      isTranscriptMode?: boolean
    },
  ): React.ReactNode
  /**
   * 可选。省略时，回退到 <FallbackToolUseErrorMessage />。
   * 仅为需要自定义错误 UI 的工具定义此项（例如，显示"文件未找到"
   * 而不是原始错误的搜索工具）。
   */
  renderToolUseErrorMessage?(
    result: ToolResultBlockParam['content'],
    options: {
      progressMessagesForMessage: ProgressMessage<P>[]
      tools: Tools
      verbose: boolean
      isTranscriptMode?: boolean
    },
  ): React.ReactNode

  /**
   * 将此工具的多个并行实例渲染为一组。
   * @returns 要渲染的 React 节点，或 null 回退到单独渲染
   */
  /**
   * 将多个工具使用渲染为一组（仅非详细模式）。
   * 在详细模式中，单独的工具使用在其原始位置渲染。
   * @returns 要渲染的 React 节点，或 null 回退到单独渲染
   */
  renderGroupedToolUse?(
    toolUses: Array<{
      param: ToolUseBlockParam
      isResolved: boolean
      isError: boolean
      isInProgress: boolean
      progressMessages: ProgressMessage<P>[]
      result?: {
        param: ToolResultBlockParam
        output: unknown
      }
    }>,
    options: {
      shouldAnimate: boolean
      tools: Tools
    },
  ): React.ReactNode | null
}

/**
 * 工具集合。使用此类型代替 `Tool[]` 以便更容易跟踪工具集
 * 在代码库中的组装、传递和过滤位置。
 */
export type Tools = readonly Tool[]

/**
 * `buildTool` 提供默认值的方法。`ToolDef` 可以省略这些；
 * 生成的 `Tool` 始终拥有它们。
 */
type DefaultableToolKeys =
  | 'isEnabled'
  | 'isConcurrencySafe'
  | 'isReadOnly'
  | 'isDestructive'
  | 'checkPermissions'
  | 'toAutoClassifierInput'
  | 'userFacingName'

/**
 * `buildTool` 接受的工具定义。与 `Tool` 形状相同，但可默认方法是可选的
 * — `buildTool` 填充它们，使调用者始终看到完整的 `Tool`。
 */
export type ToolDef<
  Input extends AnyObject = AnyObject,
  Output = unknown,
  P extends ToolProgressData = ToolProgressData,
> = Omit<Tool<Input, Output, P>, DefaultableToolKeys> &
  Partial<Pick<Tool<Input, Output, P>, DefaultableToolKeys>>

/**
 * 类型级展开，镜像 `{ ...TOOL_DEFAULTS, ...def }`。对于每个可默认键：
 * 如果 D 提供它（必需的），D 的类型获胜；如果 D 省略它或将其设为可选
 * （从约束中的 Partial<> 继承），则默认值填充。所有其他键来自 D 原文
 * — 保留元数、可选存在和字面类型，与 `satisfies Tool` 完全一致。
 */
type BuiltTool<D> = Omit<D, DefaultableToolKeys> & {
  [K in DefaultableToolKeys]-?: K extends keyof D
    ? undefined extends D[K]
      ? ToolDefaults[K]
      : D[K]
    : ToolDefaults[K]
}

/**
 * 从部分定义构建完整的 `Tool`，为常见存根方法填充安全默认值。
 * 所有工具导出都应通过此函数，以便默认值集中在一个地方，
 * 调用者永远不需要 `?.() ?? default`。
 *
 * 默认值（在重要情况下采用安全失败策略）：
 * - `isEnabled` → `true`
 * - `isConcurrencySafe` → `false`（假设不安全）
 * - `isReadOnly` → `false`（假设有写入）
 * - `isDestructive` → `false`
 * - `checkPermissions` → `{ behavior: 'allow', updatedInput }`（委托给通用权限系统）
 * - `toAutoClassifierInput` → `''`（跳过分类器 — 安全相关工具必须覆盖）
 * - `userFacingName` → `name`
 */
const TOOL_DEFAULTS = {
  isEnabled: () => true,
  isConcurrencySafe: (_input?: unknown) => false,
  isReadOnly: (_input?: unknown) => false,
  isDestructive: (_input?: unknown) => false,
  checkPermissions: (
    input: { [key: string]: unknown },
    _ctx?: ToolUseContext,
  ): Promise<PermissionResult> =>
    Promise.resolve({ behavior: 'allow', updatedInput: input }),
  toAutoClassifierInput: (_input?: unknown) => '',
  userFacingName: (_input?: unknown) => '',
}

// 默认值类型是 TOOL_DEFAULTS 的实际形状（可选参数，使 0 参数
// 和全参数调用点都能通过类型检查 — 存根的元数各不相同，
// 测试依赖于此），而不是接口的严格签名。
type ToolDefaults = typeof TOOL_DEFAULTS

// D 从调用点推断具体对象字面量类型。约束为方法参数提供
// 上下文类型；约束位置中的 `any` 是结构性的，永远不会泄漏到
// 返回类型中。BuiltTool<D> 在类型级别镜像运行时 `{...TOOL_DEFAULTS, ...def}`。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyToolDef = ToolDef<any, any, any>

export function buildTool<D extends AnyToolDef>(def: D): BuiltTool<D> {
  // 运行时展开很直接；`as` 桥接了结构性 any 约束和精确的
  // BuiltTool<D> 返回类型之间的差距。类型语义由所有 60+ 个工具
  // 的 0 错误类型检查证明。
  return {
    ...TOOL_DEFAULTS,
    userFacingName: () => def.name,
    ...def,
  } as BuiltTool<D>
}
