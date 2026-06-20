import type { TaskStateBase } from '../../Task.js'
import type { AgentToolResult } from '@claude-code-best/builtin-tools/tools/AgentTool/agentToolUtils.js'
import type { AgentDefinition } from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import type { Message, MessageOrigin } from '../../types/message.js'
import type { PermissionMode } from '../../utils/permissions/PermissionMode.js'
import type { AgentProgress } from '../LocalAgentTask/LocalAgentTask.js'

/**
 * 存储在任务状态中的 teammate 身份。
 * 形状与 TeammateContext（运行时）相同，但以普通数据形式存储。
 * TeammateContext 用于 AsyncLocalStorage，而此结构用于 AppState 持久化。
 */
export type TeammateIdentity = {
  agentId: string // 例如 "researcher@my-team"
  agentName: string // 例如 "researcher"
  teamName: string
  color?: string
  planModeRequired: boolean
  parentSessionId: string // Leader 的 session ID
}

export type PendingTeammateUserMessage = {
  message: string
  autonomyRunId?: string
  autonomyRootDir?: string
  origin?: MessageOrigin
}

export type InProcessTeammateTaskState = TaskStateBase & {
  type: 'in_process_teammate'

  // 身份作为子对象存储（形状与 TeammateContext 保持一致）
  // 以普通数据形式存储在 AppState 中，而不是对 AsyncLocalStorage 的引用
  identity: TeammateIdentity

  // 执行相关
  prompt: string
  // 可选：为该 teammate 指定模型覆盖
  model?: string
  // 可选：仅在 teammate 使用特定 agent 定义时设置
  // 许多 teammate 作为通用 agent 运行，没有预定义的定义
  selectedAgent?: AgentDefinition
  abortController?: AbortController // 仅运行时使用，不会序列化到磁盘 —— 会终止整个 teammate
  currentWorkAbortController?: AbortController // 仅运行时使用 —— 只中断当前一轮，不会终止 teammate
  unregisterCleanup?: () => void // 仅运行时使用

  // plan mode 审批跟踪（planModeRequired 放在 identity 中）
  awaitingPlanApproval: boolean

  // 该 teammate 的权限模式（查看时通过 Shift+Tab 独立切换）
  permissionMode: PermissionMode

  // 状态
  error?: string
  result?: AgentToolResult // 复用已有类型，因为 teammate 通过 runAgent() 运行
  progress?: AgentProgress

  // 用于 zoomed view 的对话历史（不是 mailbox 消息）
  // mailbox 消息单独存储在 teamContext.inProcessMailboxes 中
  messages?: Message[]

  // 当前正在执行的工具调用 ID（用于对话记录视图中的动画）
  inProgressToolUseIDs?: Set<string>

  // 当查看 teammate 对话记录时需要投递的用户消息队列
  pendingUserMessages: PendingTeammateUserMessage[]

  // UI：随机的 spinner 动词（在多次重渲染之间保持稳定，多组件共享）
  spinnerVerb?: string
  pastTenseVerb?: string

  // 生命周期
  isIdle: boolean
  shutdownRequested: boolean

  // teammate 变为 idle 时用于通知的回调（仅运行时使用）
  // Leader 通过它实现高效等待，无需轮询
  onIdleCallbacks?: Array<() => void>

  // 进度跟踪（用于计算通知中的增量）
  lastReportedToolCount: number
  lastReportedTokenCount: number
}

export function isInProcessTeammateTask(
  task: unknown,
): task is InProcessTeammateTaskState {
  return (
    typeof task === 'object' &&
    task !== null &&
    'type' in task &&
    task.type === 'in_process_teammate'
  )
}

/**
 * task.messages（AppState UI 镜像）中保留的消息数量上限。
 *
 * task.messages 仅为 zoomed 对话记录对话框而存在，后者只需要最近的上下文。
 * 完整对话保存在本地的 allMessages 数组（inProcessRunner）以及
 * agent 对话记录路径下的磁盘文件中。
 *
 * BQ 分析（第 9 轮，2026-03-20）显示：500+ 轮会话下每个 agent 大约占用
 * 20MB RSS；在 swarm 突发场景下每个并发 agent 大约 125MB。Whale 会话
 * 9a990de8 在 2 分钟内启动了 292 个 agent，峰值达到 36.8GB。
 * 主要开销正是这个数组 —— 它为每条消息保存了第二份完整副本。
 */
export const TEAMMATE_MESSAGES_UI_CAP = 50

/**
 * 向消息数组追加一项，通过丢弃最旧的条目将结果截断到
 * TEAMMATE_MESSAGES_UI_CAP 条。总是返回一个新数组（AppState 不可变性）。
 */
export function appendCappedMessage<T>(
  prev: readonly T[] | undefined,
  item: T,
): T[] {
  if (prev === undefined || prev.length === 0) {
    return [item]
  }
  if (prev.length >= TEAMMATE_MESSAGES_UI_CAP) {
    const next = prev.slice(-(TEAMMATE_MESSAGES_UI_CAP - 1))
    next.push(item)
    return next
  }
  return [...prev, item]
}
