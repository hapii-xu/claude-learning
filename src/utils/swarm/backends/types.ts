import type { AgentColorName } from '@claude-code-best/builtin-tools/tools/AgentTool/agentColorManager.js'
import type { CustomAgentDefinition } from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import type { ToolUseContext } from '../../../Tool.js'

/**
 * 可用于 teammate 执行的 backend 类型。
 * - 'tmux'：使用 tmux 进行 pane 管理（可在 tmux 内或独立运行）
 * - 'iterm2'：通过 it2 CLI 使用 iTerm2 原生分割 pane
 * - 'windows-terminal'：通过 wt.exe 使用 Windows Terminal 的 pane/标签页
 * - 'in-process'：在同一 Node.js 进程中运行 teammate，具有隔离的上下文
 */
export type BackendType = 'tmux' | 'iterm2' | 'windows-terminal' | 'in-process'

/**
 * BackendType 的子集，仅包含基于 pane 的 backend。
 * 用于专门处理终端 pane 的消息和类型。
 */
export type PaneBackendType = 'tmux' | 'iterm2' | 'windows-terminal'

/**
 * backend 管理的 pane 的不透明标识符。
 * 对于 tmux，这是 tmux pane ID（例如 "%1"）。
 * 对于 iTerm2，这是 it2 返回的 session ID。
 * 对于 Windows Terminal，这是映射到生成的 shell PID 的内部 ID。
 */
export type PaneId = string

/**
 * 创建新 teammate pane 的结果。
 */
export type CreatePaneResult = {
  /** 新创建的 pane 的 ID */
  paneId: PaneId
  /** 是否是第一个 teammate pane（影响布局策略） */
  isFirstTeammate: boolean
}

/**
 * pane 管理 backend 的接口。
 * 抽象了创建和管理终端 pane 的操作，
 * 用于 swarm 模式下的 teammate 可视化。
 */
export type PaneBackend = {
  /** 此 backend 的类型标识符 */
  readonly type: BackendType

  /** 此 backend 的可读显示名称 */
  readonly displayName: string

  /** 此 backend 是否支持隐藏和显示 pane */
  readonly supportsHideShow: boolean

  /**
   * 检查此 backend 在系统上是否可用。
   * 对于 tmux：检查 tmux 命令是否存在。
   * 对于 iTerm2：检查 it2 CLI 是否已安装并配置。
   */
  isAvailable(): Promise<boolean>

  /**
   * 检查当前是否在此 backend 的环境中运行。
   * 对于 tmux：检查是否在 tmux 会话中。
   * 对于 iTerm2：检查是否在 iTerm2 中运行。
   */
  isRunningInside(): Promise<boolean>

  /**
   * 在 swarm 视图中为 teammate 创建新 pane。
   * backend 处理布局策略（有/无 leader pane）。
   *
   * @param name - teammate 的显示名称
   * @param color - 用于 pane 边框/标题的颜色
   * @returns pane ID 以及是否是第一个 teammate
   */
  createTeammatePaneInSwarmView(
    name: string,
    color: AgentColorName,
  ): Promise<CreatePaneResult>

  /**
   * 在支持时为 teammate 创建独立的终端窗口/标签页。
   * 保留旧版 `use_splitpane: false` 行为。
   */
  createTeammateWindowInSwarmView?(
    name: string,
    color: AgentColorName,
  ): Promise<CreatePaneResult & { windowName: string }>

  /**
   * 在指定 pane 中发送命令执行。
   *
   * @param paneId - 要发送命令的 pane
   * @param command - 要执行的命令字符串
   * @param useExternalSession - 如果为 true，使用外部会话 socket（tmux 特有）
   */
  sendCommandToPane(
    paneId: PaneId,
    command: string,
    useExternalSession?: boolean,
  ): Promise<void>

  /**
   * 设置 pane 的边框颜色。
   *
   * @param paneId - 要设置样式的 pane
   * @param color - 应用于边框的颜色
   * @param useExternalSession - 如果为 true，使用外部会话 socket（tmux 特有）
   */
  setPaneBorderColor(
    paneId: PaneId,
    color: AgentColorName,
    useExternalSession?: boolean,
  ): Promise<void>

  /**
   * 设置 pane 的标题（显示在 pane 边框/头部）。
   *
   * @param paneId - 要设置标题的 pane
   * @param name - 要显示的标题
   * @param color - 标题文字的颜色
   * @param useExternalSession - 如果为 true，使用外部会话 socket（tmux 特有）
   */
  setPaneTitle(
    paneId: PaneId,
    name: string,
    color: AgentColorName,
    useExternalSession?: boolean,
  ): Promise<void>

  /**
   * 启用 pane 边框状态显示（在边框中显示标题）。
   *
   * @param windowTarget - 要启用状态的窗口（可选）
   * @param useExternalSession - 如果为 true，使用外部会话 socket（tmux 特有）
   */
  enablePaneBorderStatus(
    windowTarget?: string,
    useExternalSession?: boolean,
  ): Promise<void>

  /**
   * 重新平衡 pane 以达到所需布局。
   *
   * @param windowTarget - 包含 pane 的窗口
   * @param hasLeader - 是否有 leader pane（影响布局策略）
   */
  rebalancePanes(windowTarget: string, hasLeader: boolean): Promise<void>

  /**
   * 关闭/终止指定 pane。
   *
   * @param paneId - 要终止的 pane
   * @param useExternalSession - 如果为 true，使用外部会话 socket（tmux 特有）
   * @returns 成功终止返回 true，否则返回 false
   */
  killPane(paneId: PaneId, useExternalSession?: boolean): Promise<boolean>

  /**
   * 通过将 pane 移出到隐藏窗口来隐藏 pane。
   * pane 继续运行但在主布局中不可见。
   *
   * @param paneId - 要隐藏的 pane
   * @param useExternalSession - 如果为 true，使用外部会话 socket（tmux 特有）
   * @returns 成功隐藏返回 true，否则返回 false
   */
  hidePane(paneId: PaneId, useExternalSession?: boolean): Promise<boolean>

  /**
   * 通过将之前隐藏的 pane 重新加入主窗口来显示。
   *
   * @param paneId - 要显示的 pane
   * @param targetWindowOrPane - 要加入的窗口或 pane
   * @param useExternalSession - 如果为 true，使用外部会话 socket（tmux 特有）
   * @returns 成功显示返回 true，否则返回 false
   */
  showPane(
    paneId: PaneId,
    targetWindowOrPane: string,
    useExternalSession?: boolean,
  ): Promise<boolean>
}

/**
 * backend 检测的结果。
 */
export type BackendDetectionResult = {
  /** 应该使用的 backend */
  backend: PaneBackend
  /** 是否在 backend 的原生环境中运行 */
  isNative: boolean
  /** 如果检测到 iTerm2 但未安装 it2，则为 true */
  needsIt2Setup?: boolean
}

// =============================================================================
// 进程内 Teammate 类型
// =============================================================================

/**
 * teammate 的身份字段。
 * 这是与 TeammateContext（Task #4）共享的子集，以避免循环依赖。
 * lifecycle-specialist 定义完整的 TeammateContext，包含额外字段。
 */
export type TeammateIdentity = {
  /** Agent 名称（例如 "researcher"、"tester"） */
  name: string
  /** 此 teammate 所属的团队名称 */
  teamName: string
  /** 用于 UI 区分的颜色 */
  color?: AgentColorName
  /** 实现前是否需要 plan mode 审批 */
  planModeRequired?: boolean
}

/**
 * 生成 teammate 的配置（任意执行模式）。
 */
export type TeammateSpawnConfig = TeammateIdentity & {
  /** 发送给 teammate 的初始 prompt */
  prompt: string
  /** teammate 的工作目录 */
  cwd: string
  /** 用于此 teammate 的模型 */
  model?: string
  /** 基于进程的 teammate 的可选自定义 agent 类型。 */
  agentType?: string
  /** 进程内 teammate 的可选已解析自定义 agent 定义。 */
  agentDefinition?: CustomAgentDefinition
  /** 任务的简短描述，用于 prompt 显示。 */
  description?: string
  /** 此 teammate 的系统 prompt（从 workflow 配置中解析） */
  systemPrompt?: string
  /** 如何应用系统 prompt：'replace' 替换或 'append' 追加到默认值 */
  systemPromptMode?: 'default' | 'replace' | 'append'
  /** 可选的 git worktree 路径 */
  worktreePath?: string
  /** false 保留旧版为支持 pane 的 backend 生成独立窗口的行为。 */
  useSplitPane?: boolean
  /** 父会话 ID（用于上下文关联） */
  parentSessionId: string
  /** 生成此 teammate 的 API 调用的 request_id。 */
  invokingRequestId?: string
  /** 授予此 teammate 的工具权限 */
  permissions?: string[]
  /** 此 teammate 是否可以显示未列出工具的权限提示。
   * 当为 false（默认值）时，未列出的工具会被自动拒绝。 */
  allowPermissionPrompts?: boolean
}

/**
 * 生成 teammate 的结果。
 */
export type TeammateSpawnResult = {
  /** 生成是否成功 */
  success: boolean
  /** 唯一 agent ID（格式：agentName@teamName） */
  agentId: string
  /** 生成失败时的错误消息 */
  error?: string

  /**
   * 用于生命周期管理的 Abort controller（仅限进程内）。
   * leader 使用此 controller 取消/终止 teammate。
   * 对于基于 pane 的 teammate，使用 kill() 方法。
   */
  abortController?: AbortController

  /**
   * AppState.tasks 中的 Task ID（仅限进程内）。
   * 用于 UI 渲染和进度跟踪。
   * agentId 是逻辑标识符；taskId 用于 AppState 索引。
   */
  taskId?: string

  /** Pane ID（仅限基于 pane 的） */
  paneId?: PaneId
  /** 用于生成 teammate 的 Backend。 */
  backendType?: BackendType
  /** 分配的显示颜色。 */
  color?: AgentColorName
  /** pane 是否在用户当前的 tmux 会话内生成。 */
  insideTmux?: boolean
  /** backend 创建独立窗口时的窗口/标签页名称。 */
  windowName?: string
  /** backend 是否使用了分割 pane。 */
  isSplitPane?: boolean
}

/**
 * 发送给 teammate 的消息。
 */
export type TeammateMessage = {
  /** 消息内容 */
  text: string
  /** 发送者 agent ID */
  from: string
  /** 发送者显示颜色 */
  color?: string
  /** 消息时间戳（ISO 字符串） */
  timestamp?: string
  /** 5-10 词的摘要，在 UI 中作为预览显示 */
  summary?: string
}

/**
 * teammate 执行 backend 的通用接口。
 * 抽象了基于 pane 的（tmux/iTerm2）和进程内执行之间的差异。
 *
 * PaneBackend 处理底层 pane 操作；TeammateExecutor 处理
 * 在所有 backend 中通用的高层 teammate 生命周期操作。
 */
export type TeammateExecutor = {
  /** Backend 类型标识符 */
  readonly type: BackendType

  /** 在需要 AppState/工具上下文的生命周期操作之前提供。 */
  setContext?(context: ToolUseContext): void

  /** 检查此执行器在系统上是否可用 */
  isAvailable(): Promise<boolean>

  /** 使用给定配置生成新 teammate */
  spawn(config: TeammateSpawnConfig): Promise<TeammateSpawnResult>

  /** 向 teammate 发送消息 */
  sendMessage(agentId: string, message: TeammateMessage): Promise<void>

  /** 终止 teammate（优雅关闭请求） */
  terminate(agentId: string, reason?: string): Promise<boolean>

  /** 强制终止 teammate（立即终止） */
  kill(agentId: string): Promise<boolean>

  /** 检查 teammate 是否仍然活跃 */
  isActive(agentId: string): Promise<boolean>
}

// =============================================================================
// 类型守卫
// =============================================================================

/**
 * 类型守卫，检查 backend 类型是否使用终端 pane。
 */
export function isPaneBackend(
  type: BackendType,
): type is 'tmux' | 'iterm2' | 'windows-terminal' {
  return type === 'tmux' || type === 'iterm2' || type === 'windows-terminal'
}
