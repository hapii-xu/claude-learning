/**
 * workflow 状态变化通知的桥接。
 *
 * 引擎通过 progressEmitter.emit({ type: 'run_done', ... }) 发出事件，
 * progress/store reducer 把状态记录到 RunProgress。但旧实现
 * 没有任何代码把状态转换桥接到 host 的通知机制 ——
 * WorkflowTool 返回文本里"完成时自动通知"的承诺一直没兑现。
 *
 * 本模块订阅 WorkflowService.subscribe，监视 running → completed/failed/killed 的
 * 状态转换，并通过注入的 notifier 回调发出 host 通知
 *（默认走 enqueuePendingNotification 的 task-notification 模式）。
 */
import {
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
  TASK_TYPE_TAG,
} from '../constants/xml.js'
import { enqueuePendingNotification } from '../utils/messageQueueManager.js'
import type { RunProgress } from './progress/store.js'
import type { WorkflowService } from './service.js'

const WORKFLOW_TASK_TYPE = 'local_workflow'

/** 通知器抽象（让测试可以注入 spy）。 */
export type WorkflowNotifier = (message: string) => void

const TERMINAL_STATUSES: ReadonlySet<RunProgress['status']> = new Set([
  'completed',
  'failed',
  'killed',
])

/** 默认通知器：使用 host 消息队列的 task-notification 模式。 */
const defaultNotifier: WorkflowNotifier = message => {
  enqueuePendingNotification({ value: message, mode: 'task-notification' })
}

export function installWorkflowNotifications(
  service: WorkflowService,
  notify: WorkflowNotifier = defaultNotifier,
): () => void {
  const prevStatus = new Map<string, RunProgress['status'] | undefined>()

  const unsubscribe = service.subscribe(() => {
    const runs = service.listRuns()
    for (const run of runs) {
      const prev = prevStatus.get(run.runId)
      // 首次见到该 run：只记录当前状态，不通知
      //（避免在安装时把已存在的历史 run 当作新通知）
      if (prev === undefined) {
        prevStatus.set(run.runId, run.status)
        continue
      }
      // 状态发生变化 + 进入终态 → 发出通知
      if (prev !== run.status && TERMINAL_STATUSES.has(run.status)) {
        notify(buildMessage(run))
      }
      prevStatus.set(run.runId, run.status)
    }
  })

  return () => {
    unsubscribe()
    prevStatus.clear()
  }
}

function buildMessage(run: RunProgress): string {
  const statusText =
    run.status === 'completed'
      ? 'completed successfully'
      : run.status === 'failed'
        ? 'failed'
        : 'was stopped'
  const errorSuffix =
    run.status === 'failed' && run.error ? `: ${run.error}` : ''
  const summary = `Workflow "${run.workflowName}" ${statusText}${errorSuffix}`

  return `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${run.runId}</${TASK_ID_TAG}>
<${TASK_TYPE_TAG}>${WORKFLOW_TASK_TYPE}</${TASK_TYPE_TAG}>
<${STATUS_TAG}>${run.status}</${STATUS_TAG}>
<${SUMMARY_TAG}>${summary}</${SUMMARY_TAG}>
</${TASK_NOTIFICATION_TAG}>`
}
