import type { Notification } from 'src/context/notifications.js'
import type { TodoList } from 'src/utils/todo/types.js'
import type { BridgePermissionCallbacks } from '../bridge/bridgePermissionCallbacks.js'
import type { Command } from '../commands.js'
import type { ChannelPermissionCallbacks } from '../services/mcp/channelPermissions.js'
import type { ElicitationRequestEvent } from '../services/mcp/elicitationHandler.js'
import type {
  MCPServerConnection,
  ServerResource,
} from '../services/mcp/types.js'
import { shouldEnablePromptSuggestion } from '../services/PromptSuggestion/promptSuggestion.js'
import {
  getEmptyToolPermissionContext,
  type Tool,
  type ToolPermissionContext,
} from '../Tool.js'
import type { TaskState } from '../tasks/types.js'
import type { AgentColorName } from '@claude-code-best/builtin-tools/tools/AgentTool/agentColorManager.js'
import type { AgentDefinitionsResult } from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import type { AllowedPrompt } from '@claude-code-best/builtin-tools/tools/ExitPlanModeTool/ExitPlanModeV2Tool.js'
import type { AgentId } from '../types/ids.js'
import type { Message, UserMessage } from '../types/message.js'
import type { LoadedPlugin, PluginError } from '../types/plugin.js'
import type { DeepImmutable } from '../types/utils.js'
import {
  type AttributionState,
  createEmptyAttributionState,
} from '../utils/commitAttribution.js'
import type { EffortValue } from '../utils/effort.js'
import type { FileHistoryState } from '../utils/fileHistory.js'
import type { REPLHookContext } from '../utils/hooks/postSamplingHooks.js'
import type { SessionHooksState } from '../utils/hooks/sessionHooks.js'
import type { ModelSetting } from '../utils/model/model.js'
import type { DenialTrackingState } from '../utils/permissions/denialTracking.js'
import type { PermissionMode } from '../utils/permissions/PermissionMode.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import type { SettingsJson } from '../utils/settings/types.js'
import { shouldEnableThinkingByDefault } from '../utils/thinking.js'
import type { PipeIpcState } from '../utils/pipeTransport.js'
import { logForDebugging } from '../utils/debug.js'
import type { Store } from './store.js'

export type CompletionBoundary =
  | { type: 'complete'; completedAt: number; outputTokens: number }
  | { type: 'bash'; command: string; completedAt: number }
  | { type: 'edit'; toolName: string; filePath: string; completedAt: number }
  | {
      type: 'denied_tool'
      toolName: string
      detail: string
      completedAt: number
    }

export type SpeculationResult = {
  messages: Message[]
  boundary: CompletionBoundary | null
  timeSavedMs: number
}

export type SpeculationState =
  | { status: 'idle' }
  | {
      status: 'active'
      id: string
      abort: () => void
      startTime: number
      messagesRef: { current: Message[] } // 可变引用 - 避免每条消息都进行数组展开
      writtenPathsRef: { current: Set<string> } // 可变引用 - 已写入覆盖层的相对路径
      boundary: CompletionBoundary | null
      suggestionLength: number
      toolUseCount: number
      isPipelined: boolean
      contextRef: { current: REPLHookContext }
      pipelinedSuggestion?: {
        text: string
        promptId: 'user_intent' | 'stated_intent'
        generationRequestId: string | null
      } | null
    }

export const IDLE_SPECULATION_STATE: SpeculationState = { status: 'idle' }

export type FooterItem =
  | 'tasks'
  | 'tmux'
  | 'bagel'
  | 'teams'
  | 'bridge'
  | 'companion'
  | 'bg_agent'

export type AppState = DeepImmutable<{
  settings: SettingsJson
  verbose: boolean
  mainLoopModel: ModelSetting
  mainLoopModelForSession: ModelSetting
  statusLineText: string | undefined
  expandedView: 'none' | 'tasks' | 'teammates'
  isBriefOnly: boolean
  // 可选 - 仅当 ENABLE_AGENT_SWARMS 为 true 时存在（用于死代码消除）
  showTeammateMessagePreview?: boolean
  selectedIPAgentIndex: number
  // 底部 BackgroundAgentSelector 的选择索引。
  // -1 = 主视图，0..N-1 = useBackgroundAgentTasks() 的索引。
  selectedBgAgentIndex: number
  // CoordinatorTaskPanel 选择：-1 = 药丸，0 = 主视图，1..N = 代理行。
  // 放在 AppState（而非局部状态）以便面板可直接读取，无需通过
  // PromptInput → PromptInputFooter 逐层传递 props。
  coordinatorTaskIndex: number
  viewSelectionMode: 'none' | 'selecting-agent' | 'viewing-agent'
  // 哪个底部药丸获得焦点（提示框下方的方向键导航）。
  // 放在 AppState 中，以便在 PromptInput 外部渲染的药丸组件
  // （REPL.tsx 中的 CompanionSprite）可以读取自身的焦点状态。
  footerSelection: FooterItem | null
  toolPermissionContext: ToolPermissionContext
  spinnerTip?: string
  // 来自 --agent CLI 标志或设置的代理名称（用于徽标显示）
  agent: string | undefined
  // 助手模式完全启用（设置 + GrowthBook 门控 + 信任）。
  // 单一真实来源 - 在 main.tsx 中选项变更前计算一次，
  // 消费者读取此值而非重新调用 isAssistantMode()。
  kairosEnabled: boolean
  // --remote 模式的远程会话 URL（显示在底部指示器中）
  remoteSessionUrl: string | undefined
  // 远程会话 WebSocket 状态（`claude assistant` 查看器）。
  // 'connected' 表示实时事件流已打开；'reconnecting' = 临时 WS 断开，
  // 正在退避重试；'disconnected' = 永久关闭或重试用尽。
  remoteConnectionStatus:
    | 'connecting'
    | 'connected'
    | 'reconnecting'
    | 'disconnected'
  // `claude assistant`：远程守护进程子进程中运行的后台任务（Agent 调用、
  // 队友、工作流）数量。通过 WS 上的 system/task_started 和
  // system/task_notification 事件源驱动。本地 AppState.tasks 在查看器
  // 模式下始终为空 - 任务存在于不同进程中。
  remoteBackgroundTaskCount: number
  // 常驻桥接：期望状态（由 /config 或底部切换控制）
  replBridgeEnabled: boolean
  // 常驻桥接：通过 /remote-control 命令激活时为 true，由配置驱动时为 false
  replBridgeExplicit: boolean
  // 仅出站模式：向 CCR 转发事件但拒绝入站提示/控制
  replBridgeOutboundOnly: boolean
  // 常驻桥接：环境已注册 + 会话已创建（= "就绪"）
  replBridgeConnected: boolean
  // 常驻桥接：入站 WebSocket 已打开（= "已连接" - 用户在 claude.ai 上）
  replBridgeSessionActive: boolean
  // 常驻桥接：轮询循环处于错误退避中（= "重新连接中"）
  replBridgeReconnecting: boolean
  // 常驻桥接：就绪状态的连接 URL（?bridge=envId）
  replBridgeConnectUrl: string | undefined
  // 常驻桥接：claude.ai 上的会话 URL（连接时设置）
  replBridgeSessionUrl: string | undefined
  // 常驻桥接：调试用 ID（--verbose 时在对话框中显示）
  replBridgeEnvironmentId: string | undefined
  replBridgeSessionId: string | undefined
  // 常驻桥接：连接失败时的错误消息（显示在 BridgeDialog 中）
  replBridgeError: string | undefined
  // 常驻桥接：通过 `/remote-control <name>` 设置的会话名称（用作会话标题）
  replBridgeInitialName: string | undefined
  // 常驻桥接：首次远程对话框待处理（由 /remote-control 命令设置）
  showRemoteCallout: boolean
  // 管道 IPC 状态 - 当 feature('PIPE_IPC') 启用时在运行时添加。
  pipeIpc?: PipeIpcState
}> & {
  // 统一任务状态 - 从 DeepImmutable 中排除，因为 TaskState 包含函数类型
  tasks: { [taskId: string]: TaskState }
  // 名称 → AgentId 注册表，由 Agent 工具在提供 `name` 时填充。
  // 冲突时后者胜出。SendMessage 使用此注册表按名称路由。
  agentNameRegistry: Map<string, AgentId>
  // 已前台化的任务 ID - 其消息显示在主视图中
  foregroundedTaskId?: string
  // 正在查看其转录的进程内队友的任务 ID（undefined = 领导者的视图）
  viewingAgentTaskId?: string
  // 来自 buddy_react API 的最新伴侣反应（src/buddy/companionReact.ts）
  companionReaction?: string
  // 上次 /buddy 抚摸的时间戳 - CompanionSprite 在最近时渲染爱心
  companionPetAt?: number
  // TODO (ashwin): 查看是否可以使用 utility-types 的 DeepReadonly
  mcp: {
    clients: MCPServerConnection[]
    tools: Tool[]
    commands: Command[]
    resources: Record<string, ServerResource[]>
    /**
     * 由 /reload-plugins 递增以触发 MCP 效果重新运行并获取新启用的
     * 插件 MCP 服务器。效果将此值作为依赖读取；值本身不被消费。
     */
    pluginReconnectKey: number
  }
  plugins: {
    enabled: LoadedPlugin[]
    disabled: LoadedPlugin[]
    commands: Command[]
    /**
     * 插件系统在加载和初始化期间收集的错误。
     * 参见 {@link PluginError} 类型文档以获取有关错误结构、
     * 上下文字段和显示格式的完整详细信息。
     */
    errors: PluginError[]
    // 后台插件/marketplace 安装的安装状态
    installationStatus: {
      marketplaces: Array<{
        name: string
        status: 'pending' | 'installing' | 'installed' | 'failed'
        error?: string
      }>
      plugins: Array<{
        id: string
        name: string
        status: 'pending' | 'installing' | 'installed' | 'failed'
        error?: string
      }>
    }
    /**
     * 当磁盘上的插件状态已变更（后台协调、/plugin 菜单安装、
     * 外部设置编辑）且活动组件已过时时设置为 true。在交互模式下，
     * 用户运行 /reload-plugins 来消费。在无头模式下，
     * refreshPluginState() 通过 refreshActivePlugins() 自动消费。
     */
    needsRefresh: boolean
  }
  agentDefinitions: AgentDefinitionsResult
  fileHistory: FileHistoryState
  attribution: AttributionState
  todos: { [agentId: string]: TodoList }
  remoteAgentTaskSuggestions: { summary: string; task: string }[]
  notifications: {
    current: Notification | null
    queue: Notification[]
  }
  elicitation: {
    queue: ElicitationRequestEvent[]
  }
  thinkingEnabled: boolean | undefined
  promptSuggestionEnabled: boolean
  sessionHooks: SessionHooksState
  tungstenActiveSession?: {
    sessionName: string
    socketName: string
    target: string // tmux 目标（例如 "session:window.pane"）
  }
  tungstenLastCapturedTime?: number // 为模型捕获帧的时间戳
  tungstenLastCommand?: {
    command: string // 要显示的命令字符串（例如 "Enter"、"echo hello"）
    timestamp: number // 命令发送时间
  }
  // 粘性 tmux 面板可见性 - 镜像 globalConfig.tungstenPanelVisible 以实现响应式。
  tungstenPanelVisible?: boolean
  // 回合结束时的临时自动隐藏 - 与 tungstenPanelVisible 分开，
  // 这样药丸保留在底部（用户可以重新打开），但面板内容在空闲时
  // 不占用屏幕空间。在下次 Tmux 工具使用或用户切换时清除。不持久化。
  tungstenPanelAutoHidden?: boolean
  // WebBrowser 工具（代号 bagel）：底部可见的药丸
  bagelActive?: boolean
  // WebBrowser 工具：药丸标签中显示的当前页面 URL
  bagelUrl?: string
  // WebBrowser 工具：粘性面板可见性切换
  bagelPanelVisible?: boolean
  // chicago MCP 会话状态。类型内联（而非从 @ant/computer-use-mcp/types 导入）
  // 以便外部类型检查通过而无需解析 ant 作用域依赖。形状在结构上
  // 匹配 `AppGrant`/`CuGrantFlags` - wrapper.tsx 通过结构兼容性赋值。
  // 仅当 feature('CHICAGO_MCP') 激活时填充。
  computerUseMcpState?: {
    // 会话作用域的应用允许列表。跨恢复不持久化。
    allowedApps?: readonly {
      bundleId: string
      displayName: string
      grantedAt: number
    }[]
    // 剪贴板/系统键授权标志（与允许列表正交）。
    grantFlags?: {
      clipboardRead: boolean
      clipboardWrite: boolean
      systemKeyCombos: boolean
    }
    // 仅尺寸（非 blob）用于压缩后的 scaleCoord。完整的 `ScreenshotResult`
    // （包括 base64）在 wrapper.tsx 中是进程本地的。
    lastScreenshotDims?: {
      width: number
      height: number
      displayWidth: number
      displayHeight: number
      displayId?: number
      originX?: number
      originY?: number
    }
    // 由 onAppsHidden 累积，在回合结束时清除并取消隐藏。
    hiddenDuringTurn?: ReadonlySet<string>
    // CU 目标显示器。由包的 `autoTargetDisplay` 解析器通过
    // `onResolvedDisplayUpdated` 回写。跨恢复持久化，
    // 以便点击保持在模型上次看到的显示器上。
    selectedDisplayId?: number
    // 当模型通过 `switch_display` 显式选择显示器时为 true。
    // 使 `handleScreenshot` 跳过解析器追踪链并直接使用
    // `selectedDisplayId`。在解析器回写时清除（固定的显示器
    // 已拔出 → Swift 回退到主显示器）以及 `switch_display("auto")` 时。
    displayPinnedByModel?: boolean
    // 显示器上次自动解析时针对的排序逗号连接的 bundle-ID 集合。
    // `handleScreenshot` 仅在允许集自上次以来已更改时才重新解析 -
    // 防止解析器在每次截屏时切换。
    displayResolvedForApps?: string
  }
  // REPL 工具 VM 上下文 - 在 REPL 调用之间持久化以实现状态共享
  replContext?: {
    vmContext: import('vm').Context
    registeredTools: Map<
      string,
      {
        name: string
        description: string
        schema: Record<string, unknown>
        handler: (args: Record<string, unknown>) => Promise<unknown>
      }
    >
    console: {
      log: (...args: unknown[]) => void
      error: (...args: unknown[]) => void
      warn: (...args: unknown[]) => void
      info: (...args: unknown[]) => void
      debug: (...args: unknown[]) => void
      getStdout: () => string
      getStderr: () => string
      clear: () => void
    }
  }
  teamContext?: {
    teamName: string
    teamFilePath: string
    leadAgentId: string
    // 集群成员的自我标识（在 tmux 面板中的独立进程）
    // 注意：这与 toolUseContext.agentId 不同，后者用于进程内子代理
    selfAgentId?: string // 集群成员自己的 ID（领导者与 leadAgentId 相同）
    selfAgentName?: string // 集群成员的名称（领导者为 'team-lead'）
    isLeader?: boolean // 如果此集群成员是团队领导者则为 true
    selfAgentColor?: string // 分配给 UI 的颜色（由动态加入的会话使用）
    teammates: {
      [teammateId: string]: {
        name: string
        agentType?: string
        color?: string
        tmuxSessionName: string
        tmuxPaneId: string
        cwd: string
        worktreePath?: string
        spawnedAt: number
      }
    }
  }
  // 非集群会话的独立代理上下文，带自定义名称/颜色
  standaloneAgentContext?: {
    name: string
    color?: AgentColorName
  }
  inbox: {
    messages: Array<{
      id: string
      from: string
      text: string
      timestamp: string
      status: 'pending' | 'processing' | 'processed'
      color?: string
      summary?: string
    }>
  }
  // Worker 沙箱权限请求（领导者侧）- 用于网络访问批准
  workerSandboxPermissions: {
    queue: Array<{
      requestId: string
      workerId: string
      workerName: string
      workerColor?: string
      host: string
      createdAt: number
    }>
    selectedIndex: number
  }
  // Worker 侧待处理的权限请求（等待领导者批准时显示）
  pendingWorkerRequest: {
    toolName: string
    toolUseId: string
    description: string
  } | null
  // Worker 侧待处理的沙箱权限请求
  pendingSandboxRequest: {
    requestId: string
    host: string
  } | null
  promptSuggestion: {
    text: string | null
    promptId: 'user_intent' | 'stated_intent' | null
    shownAt: number
    acceptedAt: number
    generationRequestId: string | null
  }
  speculation: SpeculationState
  speculationSessionTimeSavedMs: number
  skillImprovement: {
    suggestion: {
      skillName: string
      updates: { section: string; change: string; reason: string }[]
    } | null
  }
  // 认证版本 - 在登录/注销时递增以触发重新获取依赖认证的数据
  authVersion: number
  // 要处理的初始消息（来自 CLI 参数或计划模式退出）
  // 设置后，REPL 将处理消息并触发查询
  initialMessage: {
    message: UserMessage
    clearContext?: boolean
    mode?: PermissionMode
    // 来自计划模式的会话作用域权限规则（例如 "运行测试"、"安装依赖"）
    allowedPrompts?: AllowedPrompt[]
  } | null
  // 待处理的计划验证状态（退出计划模式时设置）
  // 由 VerifyPlanExecution 工具用于触发后台验证
  pendingPlanVerification?: {
    plan: string
    verificationStarted: boolean
    verificationCompleted: boolean
  }
  // 分类器模式（YOLO、无头等）的拒绝跟踪 - 超过限制时回退到提示
  denialTracking?: DenialTrackingState
  // 活动覆盖层（选择对话框等）用于 Escape 键协调
  activeOverlays: ReadonlySet<string>
  // 快速模式
  fastMode?: boolean
  // 服务器端顾问工具的顾问模型（undefined = 禁用）
  advisorModel?: string
  // 努力值
  effortValue?: EffortValue
  // 在 launchUltraplan 中分离流启动之前同步设置。
  // 防止在 teleportToRemote 设置 ultraplanSessionUrl 之前的
  // ~5 秒窗口内重复启动。一旦 URL 设置或失败，launchDetached 会清除。
  ultraplanLaunching?: boolean
  // 活动的 ultraplan CCR 会话 URL。在 RemoteAgentTask 运行时设置；
  // truthy 禁用关键字触发 + rainbow。当轮询到达终态时清除。
  ultraplanSessionUrl?: string
  // 已批准的 ultraplan 等待用户选择（在此处实现 vs 新会话）。
  // 由 RemoteAgentTask 轮询在批准时设置；由 UltraplanChoiceDialog 清除。
  ultraplanPendingChoice?: { plan: string; sessionId: string; taskId: string }
  // 启动前权限对话框。由 /ultraplan（斜杠或关键字）设置；
  // 由 UltraplanLaunchDialog 在选择时清除。
  ultraplanLaunchPending?: { blurb: string }
  // 远程测试工具侧：通过 set_permission_mode control_request 设置，
  // 由 onChangeAppState 推送到 CCR external_metadata.is_ultraplan_mode。
  isUltraplanMode?: boolean
  // 常驻桥接：双向权限检查的权限回调
  replBridgePermissionCallbacks?: BridgePermissionCallbacks
  // 渠道权限回调 - 通过 Telegram/iMessage 等的权限提示。
  // 通过 interactiveHandler.ts 中的 claim() 与本地 UI + 桥接 +
  // 钩子 + 分类器竞争。在 useManageMCPConnections 中构造一次。
  channelPermissionCallbacks?: ChannelPermissionCallbacks
}

export type AppStateStore = Store<AppState>

export function getDefaultAppState(): AppState {
  logForDebugging(
    '[Hapii] AppStateStore.getDefaultAppState 开始构建默认 AppState',
    { level: 'info' },
  )
  // 为使用 plan_mode_required 生成的队友确定初始权限模式
  // 使用延迟 require 以避免与 teammate.ts 的循环依赖
  /* eslint-disable @typescript-eslint/no-require-imports */
  const teammateUtils =
    require('../utils/teammate.js') as typeof import('../utils/teammate.js')
  /* eslint-enable @typescript-eslint/no-require-imports */
  const initialMode: PermissionMode =
    teammateUtils.isTeammate() && teammateUtils.isPlanModeRequired()
      ? 'plan'
      : 'default'
  logForDebugging(
    `[Hapii] AppStateStore.getDefaultAppState initialMode=${initialMode}`,
    { level: 'info' },
  )

  return {
    settings: getInitialSettings(),
    tasks: {},
    agentNameRegistry: new Map(),
    verbose: false,
    mainLoopModel: null, // 别名，全名（与 --model 或环境变量一起使用），或 null（默认）
    mainLoopModelForSession: null,
    statusLineText: undefined,
    expandedView: 'none',
    isBriefOnly: false,
    showTeammateMessagePreview: false,
    selectedIPAgentIndex: -1,
    selectedBgAgentIndex: -1,
    coordinatorTaskIndex: -1,
    viewSelectionMode: 'none',
    footerSelection: null,
    kairosEnabled: false,
    remoteSessionUrl: undefined,
    remoteConnectionStatus: 'connecting',
    remoteBackgroundTaskCount: 0,
    replBridgeEnabled: false,
    replBridgeExplicit: false,
    replBridgeOutboundOnly: false,
    replBridgeConnected: false,
    replBridgeSessionActive: false,
    replBridgeReconnecting: false,
    replBridgeConnectUrl: undefined,
    replBridgeSessionUrl: undefined,
    replBridgeEnvironmentId: undefined,
    replBridgeSessionId: undefined,
    replBridgeError: undefined,
    replBridgeInitialName: undefined,
    showRemoteCallout: false,
    toolPermissionContext: {
      ...getEmptyToolPermissionContext(),
      mode: initialMode,
    },
    agent: undefined,
    agentDefinitions: { activeAgents: [], allAgents: [] },
    fileHistory: {
      snapshots: [],
      trackedFiles: new Set(),
      snapshotSequence: 0,
    },
    attribution: createEmptyAttributionState(),
    mcp: {
      clients: [],
      tools: [],
      commands: [],
      resources: {},
      pluginReconnectKey: 0,
    },
    plugins: {
      enabled: [],
      disabled: [],
      commands: [],
      errors: [],
      installationStatus: {
        marketplaces: [],
        plugins: [],
      },
      needsRefresh: false,
    },
    todos: {},
    remoteAgentTaskSuggestions: [],
    notifications: {
      current: null,
      queue: [],
    },
    elicitation: {
      queue: [],
    },
    thinkingEnabled: shouldEnableThinkingByDefault(),
    promptSuggestionEnabled: shouldEnablePromptSuggestion(),
    sessionHooks: new Map(),
    inbox: {
      messages: [],
    },
    workerSandboxPermissions: {
      queue: [],
      selectedIndex: 0,
    },
    pendingWorkerRequest: null,
    pendingSandboxRequest: null,
    promptSuggestion: {
      text: null,
      promptId: null,
      shownAt: 0,
      acceptedAt: 0,
      generationRequestId: null,
    },
    speculation: IDLE_SPECULATION_STATE,
    speculationSessionTimeSavedMs: 0,
    skillImprovement: {
      suggestion: null,
    },
    authVersion: 0,
    initialMessage: null,
    effortValue: undefined,
    activeOverlays: new Set<string>(),
    fastMode: false,
  }
}
