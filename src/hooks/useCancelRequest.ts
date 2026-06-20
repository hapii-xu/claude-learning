/**
 * CancelRequestHandler 组件，用于处理取消/Escape 快捷键。
 *
 * 必须在 KeybindingSetup 内部渲染以访问快捷键上下文。
 * 此组件不渲染任何内容 - 仅注册取消快捷键处理程序。
 */
import { useCallback, useRef } from 'react'
import { logEvent } from 'src/services/analytics/index.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from 'src/services/analytics/metadata.js'
import {
  useAppState,
  useAppStateStore,
  useSetAppState,
} from 'src/state/AppState.js'
import { isVimModeEnabled } from '../components/PromptInput/utils.js'
import type { ToolUseConfirm } from '../components/permissions/PermissionRequest.js'
import type { SpinnerMode } from '../components/Spinner/types.js'
import { useNotifications } from '../context/notifications.js'
import { useIsOverlayActive } from '../context/overlayContext.js'
import { useCommandQueue } from '../hooks/useCommandQueue.js'
import { getShortcutDisplay } from '../keybindings/shortcutFormat.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import type { Screen } from '../screens/REPL.js'
import { exitTeammateView } from '../state/teammateViewHelpers.js'
import {
  killAllRunningAgentTasks,
  markAgentsNotified,
} from '../tasks/LocalAgentTask/LocalAgentTask.js'
import type { PromptInputMode, VimMode } from '../types/textInputTypes.js'
import {
  clearCommandQueue,
  enqueuePendingNotification,
  hasCommandsInQueue,
} from '../utils/messageQueueManager.js'
import { emitTaskTerminatedSdk } from '../utils/sdkEventQueue.js'

/** 第二次按键在此时间窗口内将杀死所有后台 agent 的确认窗口（毫秒）。 */
const KILL_AGENTS_CONFIRM_WINDOW_MS = 3000

type CancelRequestHandlerProps = {
  setToolUseConfirmQueue: (
    f: (toolUseConfirmQueue: ToolUseConfirm[]) => ToolUseConfirm[],
  ) => void
  onCancel: () => void
  onAgentsKilled: () => void
  isMessageSelectorVisible: boolean
  screen: Screen
  abortSignal?: AbortSignal
  popCommandFromQueue?: () => void
  vimMode?: VimMode
  isLocalJSXCommand?: boolean
  isSearchingHistory?: boolean
  isHelpOpen?: boolean
  inputMode?: PromptInputMode
  inputValue?: string
  streamMode?: SpinnerMode
}

/**
 * 处理取消请求的组件。
 * 渲染为 null 但注册 'chat:cancel' 快捷键处理程序。
 */
export function CancelRequestHandler(props: CancelRequestHandlerProps): null {
  const {
    setToolUseConfirmQueue,
    onCancel,
    onAgentsKilled,
    isMessageSelectorVisible,
    screen,
    abortSignal,
    popCommandFromQueue,
    vimMode,
    isLocalJSXCommand,
    isSearchingHistory,
    isHelpOpen,
    inputMode,
    inputValue,
    streamMode,
  } = props
  const store = useAppStateStore()
  const setAppState = useSetAppState()
  const queuedCommandsLength = useCommandQueue().length
  const { addNotification, removeNotification } = useNotifications()
  const lastKillAgentsPressRef = useRef<number>(0)
  const viewSelectionMode = useAppState(s => s.viewSelectionMode)

  const handleCancel = useCallback(() => {
    const cancelProps = {
      source:
        'escape' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      streamMode:
        streamMode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    }

    // 优先级 1：如果有活跃任务正在运行，先取消它
    // 这优先于队列管理，以便用户始终可以中断 Claude
    if (abortSignal !== undefined && !abortSignal.aborted) {
      logEvent('tengu_cancel', cancelProps)
      setToolUseConfirmQueue(() => [])
      onCancel()
      return
    }

    // 优先级 2：当 Claude 空闲时（没有运行中的任务可取消），弹出队列
    if (hasCommandsInQueue()) {
      if (popCommandFromQueue) {
        popCommandFromQueue()
        return
      }
    }

    // 回退：没有可取消或弹出的内容（如果 isActive 正确则不应到达这里）
    logEvent('tengu_cancel', cancelProps)
    setToolUseConfirmQueue(() => [])
    onCancel()
  }, [
    abortSignal,
    popCommandFromQueue,
    setToolUseConfirmQueue,
    onCancel,
    streamMode,
  ])

  // 判断此处理程序是否应处于活动状态
  // 其他上下文（Transcript、HistorySearch、Help）有自己的 escape 处理程序
  // 覆盖层（ModelPicker、ThinkingToggle 等）通过 useRegisterOverlay 注册自己
  // 本地 JSX 命令（如 /model、/btw）处理自己的输入
  const isOverlayActive = useIsOverlayActive()
  const canCancelRunningTask = abortSignal !== undefined && !abortSignal.aborted
  const hasQueuedCommands = queuedCommandsLength > 0
  // 在 bash/background 模式下且输入为空时，escape 应该退出模式
  // 而不是取消请求。让 PromptInput 处理模式退出。
  // 这仅适用于 Escape，不适用于应始终取消的 Ctrl+C。
  const isInSpecialModeWithEmptyInput =
    inputMode !== undefined && inputMode !== 'prompt' && !inputValue
  // 查看队友的 transcript 时，让 useBackgroundTaskNavigation 处理 Escape
  const isViewingTeammate = viewSelectionMode === 'viewing-agent'
  // 上下文守卫：其他屏幕/覆盖层处理自己的取消
  const isContextActive =
    screen !== 'transcript' &&
    !isSearchingHistory &&
    !isMessageSelectorVisible &&
    !isLocalJSXCommand &&
    !isHelpOpen &&
    !isOverlayActive &&
    !(isVimModeEnabled() && vimMode === 'INSERT')

  // Escape (chat:cancel) 在特殊模式下输入为空时让位于模式退出，
  // 查看队友时让位于 useBackgroundTaskNavigation
  const isEscapeActive =
    isContextActive &&
    (canCancelRunningTask || hasQueuedCommands) &&
    !isInSpecialModeWithEmptyInput &&
    !isViewingTeammate

  // Ctrl+C (app:interrupt)：查看队友时，停止所有内容并
  // 返回主线程。否则只执行 handleCancel。在主线空闲于提示符时
  // 绝不能占用 ctrl+c —— 那会阻止复制选择
  // 处理程序和双击退出永远看不到该按键。
  const isCtrlCActive =
    isContextActive &&
    (canCancelRunningTask || hasQueuedCommands || isViewingTeammate)

  useKeybinding('chat:cancel', handleCancel, {
    context: 'Chat',
    isActive: isEscapeActive,
  })

  // 共享的杀死路径：停止所有 agent，抑制逐 agent 通知，
  // 发出 SDK 事件，入队单个聚合的面向模型的通知。
  // 如果有东西被杀死则返回 true。
  const killAllAgentsAndNotify = useCallback((): boolean => {
    const tasks = store.getState().tasks
    const running = Object.entries(tasks).filter(
      ([, t]) => t.type === 'local_agent' && t.status === 'running',
    )
    if (running.length === 0) return false
    killAllRunningAgentTasks(tasks, setAppState)
    const descriptions: string[] = []
    for (const [taskId, task] of running) {
      markAgentsNotified(taskId, setAppState)
      descriptions.push(task.description)
      emitTaskTerminatedSdk(taskId, 'stopped', {
        toolUseId: task.toolUseId,
        summary: task.description,
      })
    }
    const summary =
      descriptions.length === 1
        ? `Background agent "${descriptions[0]}" was stopped by the user.`
        : `${descriptions.length} background agents were stopped by the user: ${descriptions.map(d => `"${d}"`).join(', ')}.`
    enqueuePendingNotification({ value: summary, mode: 'task-notification' })
    onAgentsKilled()
    return true
  }, [store, setAppState, onAgentsKilled])

  // Ctrl+C (app:interrupt)。作用域限于队友视图：从
  // 主提示符杀死 agent 保持为刻意手势 (chat:killAgents)，
  // 而不是取消回合的副作用。
  const handleInterrupt = useCallback(() => {
    if (isViewingTeammate) {
      killAllAgentsAndNotify()
      exitTeammateView(setAppState)
    }
    if (canCancelRunningTask || hasQueuedCommands) {
      handleCancel()
    }
  }, [
    isViewingTeammate,
    killAllAgentsAndNotify,
    setAppState,
    canCancelRunningTask,
    hasQueuedCommands,
    handleCancel,
  ])

  useKeybinding('app:interrupt', handleInterrupt, {
    context: 'Global',
    isActive: isCtrlCActive,
  })

  // chat:killAgents 使用两次按键模式：第一次按下显示
  // 确认提示，窗口内的第二次按下实际杀死所有
  // agent。直接从 store 读取 tasks 以避免过时闭包。
  const handleKillAgents = useCallback(() => {
    const tasks = store.getState().tasks
    const hasRunningAgents = Object.values(tasks).some(
      t => t.type === 'local_agent' && t.status === 'running',
    )
    if (!hasRunningAgents) {
      addNotification({
        key: 'kill-agents-none',
        text: 'No background agents running',
        priority: 'immediate',
        timeoutMs: 2000,
      })
      return
    }
    const now = Date.now()
    const elapsed = now - lastKillAgentsPressRef.current
    if (elapsed <= KILL_AGENTS_CONFIRM_WINDOW_MS) {
      // 窗口内的第二次按下 —— 杀死所有后台 agent
      lastKillAgentsPressRef.current = 0
      removeNotification('kill-agents-confirm')
      logEvent('tengu_cancel', {
        source:
          'kill_agents' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      clearCommandQueue()
      killAllAgentsAndNotify()
      return
    }
    // 第一次按下 —— 在状态栏显示确认提示
    lastKillAgentsPressRef.current = now
    const shortcut = getShortcutDisplay(
      'chat:killAgents',
      'Chat',
      'ctrl+x ctrl+k',
    )
    addNotification({
      key: 'kill-agents-confirm',
      text: `Press ${shortcut} again to stop background agents`,
      priority: 'immediate',
      timeoutMs: KILL_AGENTS_CONFIRM_WINDOW_MS,
    })
  }, [store, addNotification, removeNotification, killAllAgentsAndNotify])

  // 必须保持 always-active：ctrl+x 作为和弦前缀被消耗，无论
  // isActive 如何（因为 ctrl+x ctrl+e 始终活跃），所以此处非活跃的处理程序
  // 会将 ctrl+k 泄漏给 readline 的行终止。处理程序内部进行门控。
  useKeybinding('chat:killAgents', handleKillAgents, {
    context: 'Chat',
  })

  return null
}
