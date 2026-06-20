// MCP 资源监控的后台任务入口。
// 跟踪对 MCP 服务器资源的长期订阅，让原本不可见的流显示在
// footer pill 和 Shift+Down 对话框中。沿用 DreamTask 模式：
// 通过已有的任务注册表进行纯 UI 呈现。

import type { AppState } from '../../state/AppState.js'
import type { SetAppState, Task, TaskStateBase } from '../../Task.js'
import { createTaskStateBase, generateTaskId } from '../../Task.js'
import type { AgentId } from '../../types/ids.js'
import { logForDebugging } from '../../utils/debug.js'
import { registerTask, updateTaskState } from '../../utils/task/framework.js'

export type MonitorMcpTaskState = TaskStateBase & {
  type: 'monitor_mcp'
  /** 被监控的 MCP 服务器名称。 */
  serverName: string
  /** 订阅的资源 URI。 */
  resourceUri: string
  /** 用于驱动监控的 shell 命令（如果有）。 */
  command?: string
  /** spawn 此任务的 agent，用于在 agent 退出时清理孤儿任务。 */
  agentId?: AgentId
  /** 用于取消订阅的 abort controller。 */
  abortController?: AbortController
}

export function isMonitorMcpTask(task: unknown): task is MonitorMcpTaskState {
  return (
    typeof task === 'object' &&
    task !== null &&
    'type' in task &&
    task.type === 'monitor_mcp'
  )
}

export function registerMonitorMcpTask(
  setAppState: SetAppState,
  opts: {
    description: string
    serverName: string
    resourceUri: string
    command?: string
    toolUseId?: string
    agentId?: AgentId
    abortController?: AbortController
  },
): string {
  const id = generateTaskId('monitor_mcp')
  const task: MonitorMcpTaskState = {
    ...createTaskStateBase(id, 'monitor_mcp', opts.description, opts.toolUseId),
    type: 'monitor_mcp',
    status: 'running',
    serverName: opts.serverName,
    resourceUri: opts.resourceUri,
    command: opts.command,
    agentId: opts.agentId,
    abortController: opts.abortController,
  }
  registerTask(task, setAppState)
  return id
}

export function completeMonitorMcpTask(
  taskId: string,
  setAppState: SetAppState,
): void {
  updateTaskState<MonitorMcpTaskState>(taskId, setAppState, task => ({
    ...task,
    status: 'completed',
    endTime: Date.now(),
    notified: true,
    abortController: undefined,
  }))
}

export function failMonitorMcpTask(
  taskId: string,
  setAppState: SetAppState,
): void {
  updateTaskState<MonitorMcpTaskState>(taskId, setAppState, task => ({
    ...task,
    status: 'failed',
    endTime: Date.now(),
    notified: true,
    abortController: undefined,
  }))
}

export function killMonitorMcp(taskId: string, setAppState: SetAppState): void {
  updateTaskState<MonitorMcpTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') return task
    task.abortController?.abort()
    return {
      ...task,
      status: 'killed',
      endTime: Date.now(),
      notified: true,
      abortController: undefined,
    }
  })
}

/**
 * 终止由某个 agent spawn 的所有运行中的 monitor_mcp 任务。
 * 由 runAgent.ts 的 finally 块调用，确保订阅不会比启动它的 agent 存活更久。
 */
export function killMonitorMcpTasksForAgent(
  agentId: AgentId,
  getAppState: () => AppState,
  setAppState: SetAppState,
): void {
  const tasks = getAppState().tasks ?? {}
  for (const [taskId, task] of Object.entries(tasks)) {
    if (
      isMonitorMcpTask(task) &&
      task.agentId === agentId &&
      task.status === 'running'
    ) {
      logForDebugging(
        `killMonitorMcpTasksForAgent: killing orphaned monitor task ${taskId} (agent ${agentId} exiting)`,
      )
      killMonitorMcp(taskId, setAppState)
    }
  }
}

export const MonitorMcpTask: Task = {
  name: 'MonitorMcpTask',
  type: 'monitor_mcp',

  async kill(taskId, setAppState) {
    killMonitorMcp(taskId, setAppState)
  },
}
