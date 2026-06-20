// LocalShellTask 状态的纯类型 + 类型守卫。
// 从 LocalShellTask.tsx 中抽取出来，这样非 React 的消费者
// （stopTask.ts 经由 print.ts）就不会把 React/ink 拉进模块图中。

import type { TaskStateBase } from '../../Task.js'
import type { AgentId } from '../../types/ids.js'
import type { ShellCommand } from '../../utils/ShellCommand.js'

export type BashTaskKind = 'bash' | 'monitor'

export type LocalShellTaskState = TaskStateBase & {
  type: 'local_bash' // 保留为 'local_bash' 以便与已持久化的会话状态保持向后兼容
  command: string
  result?: {
    code: number
    interrupted: boolean
  }
  completionStatusSentInAttachment: boolean
  shellCommand: ShellCommand | null
  unregisterCleanup?: () => void
  cleanupTimeoutId?: NodeJS.Timeout
  // 跟踪上次上报的数据，用于计算增量（来自 TaskOutput 的总行数）
  lastReportedTotalLines: number
  // 任务是否已被后台化（false = 前台运行中，true = 已后台化）
  isBackgrounded: boolean
  // spawn 此任务的 agent。用于在 agent 退出时清理孤立的 bash 任务
  // （见 killShellTasksForAgent）。undefined = 主线程。
  agentId?: AgentId
  // UI 展示变体。'monitor' → 展示描述而不是命令，对话框标题为
  // 'Monitor details'，状态栏 pill 也有所区别。
  kind?: BashTaskKind
}

export function isLocalShellTask(task: unknown): task is LocalShellTaskState {
  return (
    typeof task === 'object' &&
    task !== null &&
    'type' in task &&
    task.type === 'local_bash'
  )
}
