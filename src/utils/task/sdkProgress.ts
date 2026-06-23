import type { SdkWorkflowProgress } from '../../types/tools.js'
import { enqueueSdkEvent } from '../sdkEventQueue.js'

/**
 * 触发一个 `task_progress` SDK 事件。由后台 agent（在 runAsyncAgentLifecycle 中每次 tool_use 时）
 * 和工作流（每次 flushProgress 批量处理时）共用。接收已经计算好的原始值，以便调用方从各自的
 * 状态结构中派生这些值（agent 使用 ProgressTracker，工作流使用 LocalWorkflowTaskState）。
 */
export function emitTaskProgress(params: {
  taskId: string
  toolUseId: string | undefined
  description: string
  startTime: number
  totalTokens: number
  toolUses: number
  lastToolName?: string
  summary?: string
  workflowProgress?: SdkWorkflowProgress[]
}): void {
  enqueueSdkEvent({
    type: 'system',
    subtype: 'task_progress',
    task_id: params.taskId,
    tool_use_id: params.toolUseId,
    description: params.description,
    usage: {
      total_tokens: params.totalTokens,
      tool_uses: params.toolUses,
      duration_ms: Date.now() - params.startTime,
    },
    last_tool_name: params.lastToolName,
    summary: params.summary,
    workflow_progress: params.workflowProgress,
  })
}
