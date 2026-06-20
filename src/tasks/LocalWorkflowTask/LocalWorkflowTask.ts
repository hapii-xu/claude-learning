// 本地工作流执行的后台任务入口。
// 让工作流脚本显示在 footer pill 和 Shift+Down 对话框中。
// 沿用 DreamTask 的模式：通过已有的任务注册表进行生命周期管理与 UI 呈现。

import type { AppState } from '../../state/AppState.js'
import type { SetAppState, Task, TaskStateBase } from '../../Task.js'
import { createTaskStateBase, generateTaskId } from '../../Task.js'
import type { AgentId } from '../../types/ids.js'
import { logForDebugging } from '../../utils/debug.js'
import { registerTask, updateTaskState } from '../../utils/task/framework.js'

export type LocalWorkflowTaskState = TaskStateBase & {
  type: 'local_workflow'
  /** 来自工作流脚本的 meta.name（例如 'spec'）。 */
  workflowName: string
  /** 磁盘上工作流文件的绝对路径。 */
  workflowFile: string
  /** 可读的一行摘要，用于任务列表。 */
  summary?: string
  /** 该工作流 spawn 的子 agent 数量。 */
  agentCount?: number
  /** 工作流执行的捕获输出。 */
  output?: string
  /** 失败原因，呈现在 BackgroundTasksDialog 中（对应 RunProgress.error）。 */
  error?: string
  /** spawn 此任务的 agent，用于孤儿清理。 */
  agentId?: AgentId
  /** 用于取消的 abort controller。 */
  abortController?: AbortController
  /**
   * 该工作流内某个子 agent 的待处理动作。
   * 工作流执行循环会轮询此字段并据此执行。
   */
  pendingAgentAction?: {
    kind: 'skip' | 'retry'
    agentId: AgentId
    requestedAt: number
  }
}

export function isLocalWorkflowTask(
  value: unknown,
): value is LocalWorkflowTaskState {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    (value as { type: string }).type === 'local_workflow'
  )
}

export function registerLocalWorkflowTask(
  setAppState: SetAppState,
  opts: {
    description: string
    workflowName: string
    workflowFile: string
    summary?: string
    toolUseId?: string
    agentId?: AgentId
    abortController?: AbortController
  },
): string {
  const id = generateTaskId('local_workflow')
  const task: LocalWorkflowTaskState = {
    ...createTaskStateBase(
      id,
      'local_workflow',
      opts.description,
      opts.toolUseId,
    ),
    type: 'local_workflow',
    status: 'running',
    workflowName: opts.workflowName,
    workflowFile: opts.workflowFile,
    summary: opts.summary,
    agentId: opts.agentId,
    abortController: opts.abortController,
  }
  registerTask(task, setAppState)
  return id
}

export function completeWorkflowTask(
  taskId: string,
  setAppState: SetAppState,
): void {
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => ({
    ...task,
    status: 'completed',
    endTime: Date.now(),
    notified: true,
    abortController: undefined,
  }))
}

export function failWorkflowTask(
  taskId: string,
  setAppState: SetAppState,
  error?: string,
): void {
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => ({
    ...task,
    status: 'failed',
    endTime: Date.now(),
    notified: true,
    abortController: undefined,
    ...(error !== undefined ? { error } : {}),
  }))
}

/**
 * 终止运行中的工作流任务。由 BackgroundTasksDialog 通过 feature 门控的
 * `killWorkflowTask` 绑定调用。
 */
export function killWorkflowTask(
  taskId: string,
  setAppState: SetAppState,
): void {
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => {
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
 * 在运行中的工作流里跳过当前的 agent 步骤。
 * 由 BackgroundTasksDialog 通过 feature 门控的
 * `skipWorkflowAgent` 绑定调用：skipWorkflowAgent(taskId, agentId, setAppState)。
 */
export function skipWorkflowAgent(
  taskId: string,
  agentId: AgentId,
  setAppState: SetAppState,
): void {
  logForDebugging(
    `skipWorkflowAgent: skipping agent ${agentId} in workflow task ${taskId}`,
  )
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') return task
    return {
      ...task,
      pendingAgentAction: {
        kind: 'skip',
        agentId,
        requestedAt: Date.now(),
      },
    }
  })
}

/**
 * 在运行中的工作流里重试当前的 agent 步骤。
 * 由 BackgroundTasksDialog 通过 feature 门控的
 * `retryWorkflowAgent` 绑定调用：retryWorkflowAgent(taskId, agentId, setAppState)。
 */
export function retryWorkflowAgent(
  taskId: string,
  agentId: AgentId,
  setAppState: SetAppState,
): void {
  logForDebugging(
    `retryWorkflowAgent: retrying agent ${agentId} in workflow task ${taskId}`,
  )
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') return task
    return {
      ...task,
      pendingAgentAction: {
        kind: 'retry',
        agentId,
        requestedAt: Date.now(),
      },
    }
  })
}

/**
 * 终止由某个 agent spawn 的所有运行中的工作流任务。
 * 由 runAgent.ts 的 finally 块调用。
 */
export function killWorkflowTasksForAgent(
  agentId: AgentId,
  getAppState: () => AppState,
  setAppState: SetAppState,
): void {
  const tasks = getAppState().tasks ?? {}
  for (const [taskId, task] of Object.entries(tasks)) {
    if (
      isLocalWorkflowTask(task) &&
      task.agentId === agentId &&
      task.status === 'running'
    ) {
      logForDebugging(
        `killWorkflowTasksForAgent: killing orphaned workflow task ${taskId} (agent ${agentId} exiting)`,
      )
      killWorkflowTask(taskId, setAppState)
    }
  }
}

export const LocalWorkflowTask: Task = {
  name: 'LocalWorkflowTask',
  type: 'local_workflow',
  async kill(taskId: string, setAppState: SetAppState) {
    killWorkflowTask(taskId, setAppState)
  },
}
