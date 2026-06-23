import {
  OUTPUT_FILE_TAG,
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
  TASK_TYPE_TAG,
  TOOL_USE_ID_TAG,
} from '../../constants/xml.js'
import type { AppState } from '../../state/AppState.js'
import {
  isTerminalTaskStatus,
  type TaskStatus,
  type TaskType,
} from '../../Task.js'
import type { TaskState } from '../../tasks/types.js'
import { enqueuePendingNotification } from '../messageQueueManager.js'
import { enqueueSdkEvent } from '../sdkEventQueue.js'
import { getTaskOutputDelta, getTaskOutputPath } from './diskOutput.js'

// 所有任务的标准轮询间隔
export const POLL_INTERVAL_MS = 1000

// 被终止任务在移除前显示的持续时间
export const STOPPED_DISPLAY_MS = 3_000

// 协调器面板中终端 local_agent 任务的宽限期
export const PANEL_GRACE_MS = 30_000

// 任务状态更新的附件类型
export type TaskAttachment = {
  type: 'task_status'
  taskId: string
  toolUseId?: string
  taskType: TaskType
  status: TaskStatus
  description: string
  deltaSummary: string | null // 自上次附件以来的新输出
}

type SetAppState = (updater: (prev: AppState) => AppState) => void

/**
 * 更新 AppState 中的任务状态。
 * 任务实现的辅助函数。
 * 使用泛型以支持特定任务类型的类型安全更新。
 */
export function updateTaskState<T extends TaskState>(
  taskId: string,
  setAppState: SetAppState,
  updater: (task: T) => T,
): void {
  setAppState(prev => {
    const task = prev.tasks?.[taskId] as T | undefined
    if (!task) {
      return prev
    }
    const updated = updater(task)
    if (updated === task) {
      // 更新器返回了相同引用（提前返回的空操作）。跳过展开，
      // 避免 s.tasks 的订阅者在状态未变化时重新渲染。
      return prev
    }
    return {
      ...prev,
      tasks: {
        ...prev.tasks,
        [taskId]: updated,
      },
    }
  })
}

/**
 * 在 AppState 中注册新任务。
 */
export function registerTask(task: TaskState, setAppState: SetAppState): void {
  let isReplacement = false
  setAppState(prev => {
    const existing = prev.tasks[task.id]
    isReplacement = existing !== undefined
    // 重新注册时保留 UI 持有的状态（resumeAgentBackground
    // 会替换任务；用户的保留状态不应被重置）。startTime 保持
    // 面板排序稳定；messages + diskLoaded 在替换时保留已查看的
    // 转录（用户刚追加的提示在 messages 中，尚未写入磁盘）。
    const merged =
      existing && 'retain' in existing
        ? {
            ...task,
            retain: existing.retain,
            startTime: existing.startTime,
            messages: existing.messages,
            diskLoaded: existing.diskLoaded,
            pendingMessages: existing.pendingMessages,
          }
        : task
    return { ...prev, tasks: { ...prev.tasks, [task.id]: merged } }
  })

  // 替换（恢复）— 不是新的开始。跳过以避免重复发送。
  if (isReplacement) return

  enqueueSdkEvent({
    type: 'system',
    subtype: 'task_started',
    task_id: task.id,
    tool_use_id: task.toolUseId,
    description: task.description,
    task_type: task.type,
    workflow_name:
      'workflowName' in task
        ? (task.workflowName as string | undefined)
        : undefined,
    prompt: 'prompt' in task ? (task.prompt as string) : undefined,
  })
}

/**
 * 主动从 AppState 中驱逐一个终端任务。
 * 任务必须处于终端状态（已完成/失败/已终止）且 notified=true。
 * 这样可以在不等待下一个查询循环迭代的情况下释放内存。
 * generateTaskAttachments() 中的惰性 GC 仍作为安全网保留。
 */
export function evictTerminalTask(
  taskId: string,
  setAppState: SetAppState,
): void {
  setAppState(prev => {
    const task = prev.tasks?.[taskId]
    if (!task) return prev
    if (!isTerminalTaskStatus(task.status)) return prev
    if (!task.notified) return prev
    // 面板宽限期 — 在截止时间到达前阻止驱逐。
    // 'retain' in task 收窄为 LocalAgentTaskState（唯一具有
    // 该字段的类型）；evictAfter 是可选的，所以 'evictAfter' in task 会
    // 遗漏尚未设置该字段的任务。
    if ('retain' in task && (task.evictAfter ?? Infinity) > Date.now()) {
      return prev
    }
    const { [taskId]: _, ...remainingTasks } = prev.tasks
    return { ...prev, tasks: remainingTasks }
  })
}

/**
 * 获取所有正在运行的任务。
 */
export function getRunningTasks(state: AppState): TaskState[] {
  const tasks = state.tasks ?? {}
  return Object.values(tasks).filter(task => task.status === 'running')
}

/**
 * 为具有新输出或状态变化的任务生成附件。
 * 由框架调用以创建推送通知。
 */
export async function generateTaskAttachments(state: AppState): Promise<{
  attachments: TaskAttachment[]
  // 仅偏移量补丁 — 而非完整任务。任务可能在 getTaskOutputDelta 的
  // 异步磁盘读取期间转变为已完成，展开完整的过期快照会覆盖该转变
  // （导致任务变成僵尸状态）。
  updatedTaskOffsets: Record<string, number>
  evictedTaskIds: string[]
}> {
  const attachments: TaskAttachment[] = []
  const updatedTaskOffsets: Record<string, number> = {}
  const evictedTaskIds: string[] = []
  const tasks = state.tasks ?? {}

  for (const taskState of Object.values(tasks)) {
    if (taskState.notified) {
      switch (taskState.status) {
        case 'completed':
        case 'failed':
        case 'killed':
          // 驱逐终端任务 — 它们已被消费，可以回收
          evictedTaskIds.push(taskState.id)
          continue
        case 'pending':
          // 保留在映射中 — 尚未运行，但父任务已知晓
          continue
        case 'running':
          // 继续执行下方的运行逻辑
          break
      }
    }

    if (taskState.status === 'running') {
      const delta = await getTaskOutputDelta(
        taskState.id,
        taskState.outputOffset,
      )
      if (delta.content) {
        updatedTaskOffsets[taskState.id] = delta.newOffset
      }
    }

    // 已完成任务不在此处通知 — 每种任务类型通过
    // enqueuePendingNotification() 处理自己的完成通知。在此处生成
    // 附件会与那些按类型的回调竞争，导致双重传递（一个内联附件 +
    // 一个单独的 API 轮次）。
  }

  return { attachments, updatedTaskOffsets, evictedTaskIds }
}

/**
 * 应用 generateTaskAttachments 产生的 outputOffset 补丁和驱逐。
 * 将补丁合并到新鲜的 prev.tasks（而非过期的 await 前快照），
 * 这样并发的状态转变不会被覆盖。
 */
export function applyTaskOffsetsAndEvictions(
  setAppState: SetAppState,
  updatedTaskOffsets: Record<string, number>,
  evictedTaskIds: string[],
): void {
  const offsetIds = Object.keys(updatedTaskOffsets)
  if (offsetIds.length === 0 && evictedTaskIds.length === 0) {
    return
  }
  setAppState(prev => {
    let changed = false
    const newTasks = { ...prev.tasks }
    for (const id of offsetIds) {
      const fresh = newTasks[id]
      // 在新鲜状态上重新检查状态 — 任务可能在 await 期间已完成。
      // 如果它不再运行，偏移量更新就无关紧要了。
      if (fresh?.status === 'running') {
        newTasks[id] = { ...fresh, outputOffset: updatedTaskOffsets[id]! }
        changed = true
      }
    }
    for (const id of evictedTaskIds) {
      const fresh = newTasks[id]
      // 在新鲜状态上重新检查终端+已通知（TOCTOU：恢复可能在
      // generateTaskAttachments 的 await 期间替换了任务）
      if (!fresh || !isTerminalTaskStatus(fresh.status) || !fresh.notified) {
        continue
      }
      if ('retain' in fresh && (fresh.evictAfter ?? Infinity) > Date.now()) {
        continue
      }
      delete newTasks[id]
      changed = true
    }
    return changed ? { ...prev, tasks: newTasks } : prev
  })
}

/**
 * 轮询所有正在运行的任务并检查更新。
 * 这是框架调用的主轮询循环。
 */
export async function pollTasks(
  getAppState: () => AppState,
  setAppState: SetAppState,
): Promise<void> {
  const state = getAppState()
  const { attachments, updatedTaskOffsets, evictedTaskIds } =
    await generateTaskAttachments(state)

  applyTaskOffsetsAndEvictions(setAppState, updatedTaskOffsets, evictedTaskIds)

  // 为已完成任务发送通知
  for (const attachment of attachments) {
    enqueueTaskNotification(attachment)
  }
}

/**
 * 将任务通知加入消息队列。
 */
function enqueueTaskNotification(attachment: TaskAttachment): void {
  const statusText = getStatusText(attachment.status)

  const outputPath = getTaskOutputPath(attachment.taskId)
  const toolUseIdLine = attachment.toolUseId
    ? `\n<${TOOL_USE_ID_TAG}>${attachment.toolUseId}</${TOOL_USE_ID_TAG}>`
    : ''
  const message = `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${attachment.taskId}</${TASK_ID_TAG}>${toolUseIdLine}
<${TASK_TYPE_TAG}>${attachment.taskType}</${TASK_TYPE_TAG}>
<${OUTPUT_FILE_TAG}>${outputPath}</${OUTPUT_FILE_TAG}>
<${STATUS_TAG}>${attachment.status}</${STATUS_TAG}>
<${SUMMARY_TAG}>Task "${attachment.description}" ${statusText}</${SUMMARY_TAG}>
</${TASK_NOTIFICATION_TAG}>`

  enqueuePendingNotification({ value: message, mode: 'task-notification' })
}

/**
 * 获取人类可读的状态文本。
 */
function getStatusText(status: TaskStatus): string {
  switch (status) {
    case 'completed':
      return 'completed successfully'
    case 'failed':
      return 'failed'
    case 'killed':
      return 'was stopped'
    case 'running':
      return 'is running'
    case 'pending':
      return 'is pending'
  }
}
