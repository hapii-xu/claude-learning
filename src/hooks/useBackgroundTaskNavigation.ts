import { useEffect, useRef } from 'react'
import { KeyboardEvent, useInput } from '@anthropic/ink'
// backward-compat bridge until REPL wires handleKeyDown to <Box onKeyDown>
import {
  type AppState,
  useAppState,
  useSetAppState,
} from '../state/AppState.js'
import {
  enterTeammateView,
  exitTeammateView,
} from '../state/teammateViewHelpers.js'
import {
  getRunningTeammatesSorted,
  InProcessTeammateTask,
} from '../tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import {
  type InProcessTeammateTaskState,
  isInProcessTeammateTask,
} from '../tasks/InProcessTeammateTask/types.js'
import { isBackgroundTask } from '../tasks/types.js'

// 按增量步进队友选择，在 leader(-1)..队友(0..n-1)..隐藏(n) 之间循环。
// 从折叠树的第一步展开它并停在 leader 上。
function stepTeammateSelection(
  delta: 1 | -1,
  setAppState: (updater: (prev: AppState) => AppState) => void,
): void {
  setAppState(prev => {
    const currentCount = getRunningTeammatesSorted(prev.tasks).length
    if (currentCount === 0) return prev

    if (prev.expandedView !== 'teammates') {
      return {
        ...prev,
        expandedView: 'teammates' as const,
        viewSelectionMode: 'selecting-agent',
        selectedIPAgentIndex: -1,
      }
    }

    const maxIdx = currentCount // hide row
    const cur = prev.selectedIPAgentIndex
    const next =
      delta === 1
        ? cur >= maxIdx
          ? -1
          : cur + 1
        : cur <= -1
          ? maxIdx
          : cur - 1
    return {
      ...prev,
      selectedIPAgentIndex: next,
      viewSelectionMode: 'selecting-agent',
    }
  })
}

/**
 * 自定义 hook，处理后台任务的 Shift+Up/Down 键盘导航。
 * 当存在队友（swarm）时，在 leader 和队友之间导航。
 * 当仅存在非队友后台任务时，打开后台任务对话框。
 * 当 pipe IPC 处于活动状态（UDS_INBOX）时，Shift+Down 切换 pipe 选择器面板。
 * 还处理 Enter 确认选择、'f' 查看日志和 'k' 终止。
 */
export function useBackgroundTaskNavigation(options?: {
  onOpenBackgroundTasks?: () => void
  onTogglePipeSelector?: () => void
}): { handleKeyDown: (e: KeyboardEvent) => void } {
  const tasks = useAppState(s => s.tasks)
  const viewSelectionMode = useAppState(s => s.viewSelectionMode)
  const viewingAgentTaskId = useAppState(s => s.viewingAgentTaskId)
  const selectedIPAgentIndex = useAppState(s => s.selectedIPAgentIndex)
  const pipeIpc = useAppState(s => s.pipeIpc)
  const setAppState = useSetAppState()

  // 过滤到运行中的队友并按字母排序以匹配 TeammateSpinnerTree 显示
  const teammateTasks = getRunningTeammatesSorted(tasks)
  const teammateCount = teammateTasks.length

  // 检查非队友后台任务（local_agent、local_bash 等）
  const hasNonTeammateBackgroundTasks = Object.values(tasks).some(
    t => isBackgroundTask(t) && t.type !== 'in_process_teammate',
  )

  // 跟踪先前的队友数量以检测队友被移除时
  const prevTeammateCountRef = useRef<number>(teammateCount)

  // 当队友被移除时钳制选择索引或当数量变为 0 时重置
  useEffect(() => {
    const prevCount = prevTeammateCountRef.current
    prevTeammateCountRef.current = teammateCount

    setAppState(prev => {
      const currentTeammates = getRunningTeammatesSorted(prev.tasks)
      const currentCount = currentTeammates.length

      // 当队友被移除时（数量从 >0 变为 0），重置选择
      // 仅在之前有队友时重置（不是在初始挂载时为 0）
      // 如果正在查看队友日志则不要覆盖 viewSelectionMode ——
      // 用户可能正在查看已完成的队友并需要 escape 退出
      if (
        currentCount === 0 &&
        prevCount > 0 &&
        prev.selectedIPAgentIndex !== -1
      ) {
        if (prev.viewSelectionMode === 'viewing-agent') {
          return {
            ...prev,
            selectedIPAgentIndex: -1,
          }
        }
        return {
          ...prev,
          selectedIPAgentIndex: -1,
          viewSelectionMode: 'none',
        }
      }

      // 如果索引越界则钳制
      // 当显示 spinner 树时最大有效索引是 currentCount（"隐藏"行）
      const maxIndex =
        prev.expandedView === 'teammates' ? currentCount : currentCount - 1
      if (currentCount > 0 && prev.selectedIPAgentIndex > maxIndex) {
        return {
          ...prev,
          selectedIPAgentIndex: maxIndex,
        }
      }

      return prev
    })
  }, [teammateCount, setAppState])

  // 获取所选队友的任务信息
  const getSelectedTeammate = (): {
    taskId: string
    task: InProcessTeammateTaskState
  } | null => {
    if (teammateCount === 0) return null
    const selectedIndex = selectedIPAgentIndex
    const task = teammateTasks[selectedIndex]
    if (!task) return null

    return { taskId: task.id, task }
  }

  const handleKeyDown = (e: KeyboardEvent): void => {
    // 查看模式下的 Escape：
    // - 如果队友正在运行：仅中止当前工作（停止当前回合，队友保持活动）
    // - 如果队友未在运行（已完成/已终止/失败）：退出视图返回 leader
    if (e.key === 'escape' && viewSelectionMode === 'viewing-agent') {
      e.preventDefault()
      const taskId = viewingAgentTaskId
      if (taskId) {
        const task = tasks[taskId]
        if (isInProcessTeammateTask(task) && task.status === 'running') {
          // 中止 currentWorkAbortController（停止当前回合）而不是 abortController（终止队友）
          task.currentWorkAbortController?.abort()
          return
        }
      }
      // 队友未在运行或任务不存在 —— 退出视图
      exitTeammateView(setAppState)
      return
    }

    // 选择模式下的 Escape：退出选择而不中止 leader
    if (e.key === 'escape' && viewSelectionMode === 'selecting-agent') {
      e.preventDefault()
      setAppState(prev => ({
        ...prev,
        viewSelectionMode: 'none',
        selectedIPAgentIndex: -1,
      }))
      return
    }

    // Shift+Up/Down 用于队友日志切换（循环）
    // 索引 -1 代表 leader，0+ 是队友
    // 当 showSpinnerTree 为真时，索引 === teammateCount 是"隐藏"行
    // 第三种情况：当 pipe IPC 处于活动状态且没有队友/后台任务时，切换 pipe 选择器
    if (e.shift && (e.key === 'up' || e.key === 'down')) {
      e.preventDefault()
      if (teammateCount > 0) {
        stepTeammateSelection(e.key === 'down' ? 1 : -1, setAppState)
      } else if (hasNonTeammateBackgroundTasks) {
        options?.onOpenBackgroundTasks?.()
      } else if (
        e.key === 'down' &&
        pipeIpc?.statusVisible &&
        options?.onTogglePipeSelector
      ) {
        // 当 pipe IPC 处于活动状态且没有其他导航目标时，Shift+Down 打开 pipe 选择器
        options.onTogglePipeSelector()
      }
      return
    }

    // 'f' 查看所选队友的日志（仅在选择模式下）
    if (
      e.key === 'f' &&
      viewSelectionMode === 'selecting-agent' &&
      teammateCount > 0
    ) {
      e.preventDefault()
      const selected = getSelectedTeammate()
      if (selected) {
        enterTeammateView(selected.taskId, setAppState)
      }
      return
    }

    // Enter 确认选择（仅在选择模式下）
    if (e.key === 'return' && viewSelectionMode === 'selecting-agent') {
      e.preventDefault()
      if (selectedIPAgentIndex === -1) {
        exitTeammateView(setAppState)
      } else if (selectedIPAgentIndex >= teammateCount) {
        // "Hide" row selected - collapse the spinner tree
        setAppState(prev => ({
          ...prev,
          expandedView: 'none' as const,
          viewSelectionMode: 'none',
          selectedIPAgentIndex: -1,
        }))
      } else {
        const selected = getSelectedTeammate()
        if (selected) {
          enterTeammateView(selected.taskId, setAppState)
        }
      }
      return
    }

    // k 终止所选队友（仅在选择模式下）
    if (
      e.key === 'k' &&
      viewSelectionMode === 'selecting-agent' &&
      selectedIPAgentIndex >= 0
    ) {
      e.preventDefault()
      const selected = getSelectedTeammate()
      if (selected && selected.task.status === 'running') {
        void InProcessTeammateTask.kill(selected.taskId, setAppState)
      }
      return
    }
  }

  // 向后兼容桥接：REPL.tsx 尚未将 handleKeyDown 连接到
  // <Box onKeyDown>。通过 useInput 订阅并适配 InputEvent →
  // KeyboardEvent 直到使用者迁移（单独的 PR）。
  // TODO(onKeyDown-migration)：一旦 REPL 传递 handleKeyDown 则移除。
  useInput((_input, _key, event) => {
    handleKeyDown(new KeyboardEvent(event.keypress))
  })

  return { handleKeyDown }
}
