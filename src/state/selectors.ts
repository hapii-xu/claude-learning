/**
 * 从 AppState 派生计算状态的选择器。
 * 保持选择器纯粹且简单 - 仅数据提取，无副作用。
 */

import { logForDebugging } from '../utils/debug.js'
import type { InProcessTeammateTaskState } from '../tasks/InProcessTeammateTask/types.js'
import { isInProcessTeammateTask } from '../tasks/InProcessTeammateTask/types.js'
import type { LocalAgentTaskState } from '../tasks/LocalAgentTask/LocalAgentTask.js'
import type { AppState } from './AppStateStore.js'

/**
 * 获取当前查看的队友任务（如果有）。
 * 以下情况返回 undefined：
 * - 未查看任何队友（viewingAgentTaskId 为 undefined）
 * - 任务 ID 在 tasks 中不存在
 * - 任务不是进程内队友任务
 */
export function getViewedTeammateTask(
  appState: Pick<AppState, 'viewingAgentTaskId' | 'tasks'>,
): InProcessTeammateTaskState | undefined {
  const { viewingAgentTaskId, tasks } = appState

  // 未查看任何队友
  if (!viewingAgentTaskId) {
    return undefined
  }

  // 查找任务
  const task = tasks[viewingAgentTaskId]
  if (!task) {
    logForDebugging(
      `[Hapii] selectors.getViewedTeammateTask taskId=${viewingAgentTaskId} 不存在`,
      { level: 'info' },
    )
    return undefined
  }

  // 验证是否为进程内队友任务
  if (!isInProcessTeammateTask(task)) {
    logForDebugging(
      `[Hapii] selectors.getViewedTeammateTask taskId=${viewingAgentTaskId} 不是 InProcessTeammateTask`,
      { level: 'info' },
    )
    return undefined
  }

  logForDebugging(
    `[Hapii] selectors.getViewedTeammateTask → 找到队友任务 taskId=${viewingAgentTaskId}`,
    { level: 'info' },
  )
  return task
}

/**
 * getActiveAgentForInput 选择器的返回类型。
 * 用于类型安全输入路由的判别联合类型。
 */
export type ActiveAgentForInput =
  | { type: 'leader' }
  | { type: 'viewed'; task: InProcessTeammateTaskState }
  | { type: 'named_agent'; task: LocalAgentTaskState }

/**
 * 确定用户输入应路由到何处。
 * 返回：
 * - { type: 'leader' } 当未查看队友时（输入发送给领导者）
 * - { type: 'viewed', task } 当查看代理时（输入发送给该代理）
 *
 * 由输入路由逻辑使用，将用户消息定向到正确的代理。
 */
export function getActiveAgentForInput(
  appState: AppState,
): ActiveAgentForInput {
  const viewedTask = getViewedTeammateTask(appState)
  if (viewedTask) {
    logForDebugging('[Hapii] selectors.getActiveAgentForInput → type=viewed', {
      level: 'info',
    })
    return { type: 'viewed', task: viewedTask }
  }

  const { viewingAgentTaskId, tasks } = appState
  if (viewingAgentTaskId) {
    const task = tasks[viewingAgentTaskId]
    if (task?.type === 'local_agent') {
      logForDebugging(
        `[Hapii] selectors.getActiveAgentForInput → type=named_agent taskId=${viewingAgentTaskId}`,
        { level: 'info' },
      )
      return { type: 'named_agent', task }
    }
  }

  logForDebugging('[Hapii] selectors.getActiveAgentForInput → type=leader', {
    level: 'info',
  })
  return { type: 'leader' }
}
