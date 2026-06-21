/**
 * 管理会话后台化的 hook（Ctrl+B 后台化/前台化会话）。
 *
 * 处理：
 * - 调用 onBackgroundQuery 为当前查询生成后台任务
 * - 重新后台化已前台化的任务
 * - 将前台化任务的消息/状态同步到主视图
 */

import { useCallback, useEffect, useRef } from 'react'
import { useAppState, useSetAppState } from '../state/AppState.js'
import type { Message } from '../types/message.js'

type UseSessionBackgroundingProps = {
  setMessages: (messages: Message[] | ((prev: Message[]) => Message[])) => void
  setIsLoading: (loading: boolean) => void
  resetLoadingState: () => void
  setAbortController: (controller: AbortController | null) => void
  onBackgroundQuery: () => void
}

type UseSessionBackgroundingResult = {
  /** 用户想要后台化（Ctrl+B）时调用 */
  handleBackgroundSession: () => void
}

export function useSessionBackgrounding({
  setMessages,
  setIsLoading,
  resetLoadingState,
  setAbortController,
  onBackgroundQuery,
}: UseSessionBackgroundingProps): UseSessionBackgroundingResult {
  const foregroundedTaskId = useAppState(s => s.foregroundedTaskId)
  const foregroundedTask = useAppState(s =>
    s.foregroundedTaskId ? s.tasks[s.foregroundedTaskId] : undefined,
  )
  const setAppState = useSetAppState()
  const lastSyncedMessagesLengthRef = useRef<number>(0)

  const handleBackgroundSession = useCallback(() => {
    if (foregroundedTaskId) {
      // 重新后台化已前台化的任务
      setAppState(prev => {
        const taskId = prev.foregroundedTaskId
        if (!taskId) return prev
        const task = prev.tasks[taskId]
        if (!task) {
          return { ...prev, foregroundedTaskId: undefined }
        }
        return {
          ...prev,
          foregroundedTaskId: undefined,
          tasks: {
            ...prev.tasks,
            [taskId]: { ...task, isBackgrounded: true },
          },
        }
      })
      setMessages([])
      resetLoadingState()
      setAbortController(null)
      return
    }

    onBackgroundQuery()
  }, [
    foregroundedTaskId,
    setAppState,
    setMessages,
    resetLoadingState,
    setAbortController,
    onBackgroundQuery,
  ])

  // 将前台化任务的消息和加载状态同步到主视图
  useEffect(() => {
    if (!foregroundedTaskId) {
      // 没有前台化任务时重置
      lastSyncedMessagesLengthRef.current = 0
      return
    }

    if (!foregroundedTask || foregroundedTask.type !== 'local_agent') {
      setAppState(prev => ({ ...prev, foregroundedTaskId: undefined }))
      resetLoadingState()
      lastSyncedMessagesLengthRef.current = 0
      return
    }

    // 从后台任务同步消息到主视图
    // 仅在消息确实变化时更新，避免冗余渲染
    const taskMessages = foregroundedTask.messages ?? []
    if (taskMessages.length !== lastSyncedMessagesLengthRef.current) {
      lastSyncedMessagesLengthRef.current = taskMessages.length
      setMessages([...taskMessages])
    }

    if (foregroundedTask.status === 'running') {
      // 检查任务是否被中止（用户按了 Escape）
      const taskAbortController = foregroundedTask.abortController
      if (taskAbortController?.signal.aborted) {
        // 任务被中止 —— 立即清除前台化状态
        setAppState(prev => {
          if (!prev.foregroundedTaskId) return prev
          const task = prev.tasks[prev.foregroundedTaskId]
          if (!task) return { ...prev, foregroundedTaskId: undefined }
          return {
            ...prev,
            foregroundedTaskId: undefined,
            tasks: {
              ...prev.tasks,
              [prev.foregroundedTaskId]: { ...task, isBackgrounded: true },
            },
          }
        })
        resetLoadingState()
        setAbortController(null)
        lastSyncedMessagesLengthRef.current = 0
        return
      }

      setIsLoading(true)
      // 将 abort controller 设置为前台化任务的 controller 以处理 Escape
      if (taskAbortController) {
        setAbortController(taskAbortController)
      }
    } else {
      // 任务完成 —— 恢复到后台并清除前台化视图
      setAppState(prev => {
        const taskId = prev.foregroundedTaskId
        if (!taskId) return prev
        const task = prev.tasks[taskId]
        if (!task) return { ...prev, foregroundedTaskId: undefined }
        return {
          ...prev,
          foregroundedTaskId: undefined,
          tasks: { ...prev.tasks, [taskId]: { ...task, isBackgrounded: true } },
        }
      })
      resetLoadingState()
      setAbortController(null)
      lastSyncedMessagesLengthRef.current = 0
    }
  }, [
    foregroundedTaskId,
    foregroundedTask,
    setAppState,
    setMessages,
    setIsLoading,
    resetLoadingState,
    setAbortController,
  ])

  return {
    handleBackgroundSession,
  }
}
