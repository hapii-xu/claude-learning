// 所有具体任务状态类型的联合
// 供需要处理任意任务类型的组件使用

import type { DreamTaskState } from './DreamTask/DreamTask.js'
import type { InProcessTeammateTaskState } from './InProcessTeammateTask/types.js'
import type { LocalAgentTaskState } from './LocalAgentTask/LocalAgentTask.js'
import type { LocalShellTaskState } from './LocalShellTask/guards.js'
import type { LocalWorkflowTaskState } from './LocalWorkflowTask/LocalWorkflowTask.js'
import type { MonitorMcpTaskState } from './MonitorMcpTask/MonitorMcpTask.js'
import type { RemoteAgentTaskState } from './RemoteAgentTask/RemoteAgentTask.js'

export type TaskState =
  | LocalShellTaskState
  | LocalAgentTaskState
  | RemoteAgentTaskState
  | InProcessTeammateTaskState
  | LocalWorkflowTaskState
  | MonitorMcpTaskState
  | DreamTaskState

// 可能出现在后台任务指示器中的任务类型
export type BackgroundTaskState =
  | LocalShellTaskState
  | LocalAgentTaskState
  | RemoteAgentTaskState
  | InProcessTeammateTaskState
  | LocalWorkflowTaskState
  | MonitorMcpTaskState
  | DreamTaskState

/**
 * 判断一个任务是否应当显示在后台任务指示器中。
 * 满足以下条件的任务视为后台任务：
 * 1. 处于 running 或 pending 状态
 * 2. 已被显式后台化（不是前台任务）
 */
export function isBackgroundTask(task: TaskState): task is BackgroundTaskState {
  if (task.status !== 'running' && task.status !== 'pending') {
    return false
  }
  // 前台任务（isBackgrounded === false）尚不属于“后台任务”
  if ('isBackgrounded' in task && task.isBackgrounded === false) {
    return false
  }
  return true
}
