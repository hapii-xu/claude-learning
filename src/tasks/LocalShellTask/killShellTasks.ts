// LocalShellTask 的纯函数（非 React）kill 辅助。
// 抽取出来是为了让 runAgent.ts 在终止 agent 作用域下的 bash 任务时，
// 不必把 React/Ink 拉进它的模块图（原因与 guards.ts 相同）。

import type { AppState } from '../../state/AppState.js'
import type { AgentId } from '../../types/ids.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { dequeueAllMatching } from '../../utils/messageQueueManager.js'
import { evictTaskOutput } from '../../utils/task/diskOutput.js'
import { updateTaskState } from '../../utils/task/framework.js'
import { isLocalShellTask } from './guards.js'

type SetAppStateFn = (updater: (prev: AppState) => AppState) => void

export function killTask(taskId: string, setAppState: SetAppStateFn): void {
  updateTaskState(taskId, setAppState, task => {
    if ((task as any).status !== 'running' || !isLocalShellTask(task)) {
      return task
    }

    try {
      logForDebugging(`LocalShellTask ${taskId} kill requested`)
      task.shellCommand?.kill()
      task.shellCommand?.cleanup()
    } catch (error) {
      logError(error)
    }

    task.unregisterCleanup?.()
    if (task.cleanupTimeoutId) {
      clearTimeout(task.cleanupTimeoutId)
    }

    return {
      ...task,
      status: 'killed',
      notified: true,
      shellCommand: null,
      unregisterCleanup: undefined,
      cleanupTimeoutId: undefined,
      endTime: Date.now(),
    }
  })
  void evictTaskOutput(taskId)
}

/**
 * 终止由某个 agent spawn 的所有 running bash 任务。
 * 由 runAgent.ts 的 finally 块调用，确保后台进程不会比
 * 启动它的 agent 存活更久（避免出现跑 10 天的 fake-logs.sh 僵尸进程）。
 */
export function killShellTasksForAgent(
  agentId: AgentId,
  getAppState: () => AppState,
  setAppState: SetAppStateFn,
): void {
  const tasks = getAppState().tasks ?? {}
  for (const [taskId, task] of Object.entries(tasks)) {
    if (
      isLocalShellTask(task) &&
      task.agentId === agentId &&
      task.status === 'running'
    ) {
      logForDebugging(
        `killShellTasksForAgent: killing orphaned shell task ${taskId} (agent ${agentId} exiting)`,
      )
      killTask(taskId, setAppState)
    }
  }
  // 清除所有发往此 agent 的排队通知 —— 它的 query 循环已经退出，
  // 不会再消费这些通知。killTask 会异步触发 'killed' 通知；
  // 这里丢弃已经入队的，后续再进入的也会被无害地闲置
  // （没有消费者会匹配一个已死的 agentId）。
  dequeueAllMatching(cmd => cmd.agentId === agentId)
}
