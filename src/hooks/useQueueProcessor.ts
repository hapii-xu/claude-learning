import { useEffect, useSyncExternalStore } from 'react'
import type { QueuedCommand } from '../types/textInputTypes.js'
import {
  getCommandQueueSnapshot,
  subscribeToCommandQueue,
} from '../utils/messageQueueManager.js'
import type { QueryGuard } from '../utils/QueryGuard.js'
import { processQueueIfReady } from '../utils/queueProcessor.js'

type UseQueueProcessorParams = {
  executeQueuedInput: (commands: QueuedCommand[]) => Promise<void>
  hasActiveLocalJsxUI: boolean
  queryGuard: QueryGuard
}

/**
 * 当条件满足时处理已排队命令的 Hook。
 *
 * 使用单一统一命令队列（模块级 store）。优先级决定处理顺序：
 * 'now' > 'next'（用户输入）> 'later'（任务通知）。
 * dequeue() 函数自动处理优先级排序。
 *
 * 处理触发条件：
 * - 无活跃查询（queryGuard — 通过 useSyncExternalStore 响应式更新）
 * - 队列中有项目
 * - 无活跃的本地 JSX UI 阻塞输入
 */
export function useQueueProcessor({
  executeQueuedInput,
  hasActiveLocalJsxUI,
  queryGuard,
}: UseQueueProcessorParams): void {
  // 订阅 query guard。查询开始或结束时重新渲染
  //（或当 reserve/cancelReservation 转换 dispatching 状态时）。
  const isQueryActive = useSyncExternalStore(
    queryGuard.subscribe,
    queryGuard.getSnapshot,
  )

  // 通过 useSyncExternalStore 订阅统一命令队列。
  // 这保证了 store 变化时重新渲染，绕过 React context 传播延迟
  // （该延迟会导致 Ink 中通知丢失）。
  const queueSnapshot = useSyncExternalStore(
    subscribeToCommandQueue,
    getCommandQueueSnapshot,
  )

  useEffect(() => {
    if (isQueryActive) return
    if (hasActiveLocalJsxUI) return
    if (queueSnapshot.length === 0) return

    // 保留权现在归 handlePromptSubmit 所有（在 executeUserInput 的
    // try 块内）。同步链 executeQueuedInput → handlePromptSubmit →
    // executeUserInput → queryGuard.reserve() 在第一次真正的 await 之前运行，
    // 因此当 React 因出队触发的快照变化重新运行此 effect 时，
    // isQueryActive 已为 true（dispatching），上方守卫提前返回。
    // handlePromptSubmit 的 finally 通过 cancelReservation() 释放保留权
    //（若 onQuery 已运行 end() 则为无操作）。
    processQueueIfReady({ executeInput: executeQueuedInput })
  }, [
    queueSnapshot,
    isQueryActive,
    executeQueuedInput,
    hasActiveLocalJsxUI,
    queryGuard,
  ])
}
