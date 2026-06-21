import { useEffect } from 'react'
import { useAppState, useSetAppState } from '../state/AppState.js'
import { exitTeammateView } from '../state/teammateViewHelpers.js'
import { isInProcessTeammateTask } from '../tasks/InProcessTeammateTask/types.js'

/**
 * 当被查看的 teammate 被杀死或遇到错误时
 * 自动退出 teammate 查看模式。用户可以继续查看已完成的
 * teammate，以便查看完整 transcript。
 */
export function useTeammateViewAutoExit(): void {
  const setAppState = useSetAppState()
  const viewingAgentTaskId = useAppState(s => s.viewingAgentTaskId)
  // 仅选择被查看的任务，而非完整 tasks map —— 否则
  // 任何 teammate 的每次流式更新都会重新渲染此 hook。
  const task = useAppState(s =>
    s.viewingAgentTaskId ? s.tasks[s.viewingAgentTaskId] : undefined,
  )

  const viewedTask = task && isInProcessTeammateTask(task) ? task : undefined
  const viewedStatus = viewedTask?.status
  const viewedError = viewedTask?.error
  const taskExists = task !== undefined

  useEffect(() => {
    // 未查看任何 teammate
    if (!viewingAgentTaskId) {
      return
    }

    // 任务不再存在于 map 中 —— 被从下方驱逐。
    // 检查原始 `task` 而非 teammate 收窄的 `viewedTask`；local_agent
    // 任务存在但收窄为 undefined，会立即弹出。
    if (!taskExists) {
      exitTeammateView(setAppState)
      return
    }
    // 下方的状态检查仅针对 teammate（viewedTask 是 teammate 收窄的）。
    // 对于 local_agent，viewedStatus 为 undefined → 所有检查为假 → 不弹出。
    if (!viewedTask) return

    // 如果 teammate 被杀死、停止、有错误或不再运行，则自动退出
    // 这处理 teammate 变为不活跃的关闭场景
    if (
      viewedStatus === 'killed' ||
      viewedStatus === 'failed' ||
      viewedError ||
      (viewedStatus !== 'running' &&
        viewedStatus !== 'completed' &&
        viewedStatus !== 'pending')
    ) {
      exitTeammateView(setAppState)
      return
    }
  }, [
    viewingAgentTaskId,
    taskExists,
    viewedTask,
    viewedStatus,
    viewedError,
    setAppState,
  ])
}
