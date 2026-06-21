import { useState } from 'react'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { sanitizeToolNameForAnalytics } from '../../services/analytics/metadata.js'
import { useSetAppState } from '../../state/AppState.js'
import type { ToolUseConfirm } from './PermissionRequest.js'
import { logUnaryPermissionEvent } from './utils.js'

/**
 * Shell 权限对话框（Bash、PowerShell）的共享反馈模式状态 + 处理器。
 * 封装了 yes/no 输入模式切换、反馈文本状态、焦点追踪和拒绝处理。
 */
export function useShellPermissionFeedback({
  toolUseConfirm,
  onDone,
  onReject,
  explainerVisible,
}: {
  toolUseConfirm: ToolUseConfirm
  onDone: () => void
  onReject: () => void
  explainerVisible: boolean
}): {
  yesInputMode: boolean
  noInputMode: boolean
  yesFeedbackModeEntered: boolean
  noFeedbackModeEntered: boolean
  acceptFeedback: string
  rejectFeedback: string
  setAcceptFeedback: (v: string) => void
  setRejectFeedback: (v: string) => void
  focusedOption: string
  handleInputModeToggle: (option: string) => void
  handleReject: (feedback?: string) => void
  handleFocus: (value: string) => void
} {
  const setAppState = useSetAppState()
  const [rejectFeedback, setRejectFeedback] = useState('')
  const [acceptFeedback, setAcceptFeedback] = useState('')
  const [yesInputMode, setYesInputMode] = useState(false)
  const [noInputMode, setNoInputMode] = useState(false)
  const [focusedOption, setFocusedOption] = useState('yes')
  // 追踪用户是否曾经进入过反馈模式（收起后仍保留状态）
  const [yesFeedbackModeEntered, setYesFeedbackModeEntered] = useState(false)
  const [noFeedbackModeEntered, setNoFeedbackModeEntered] = useState(false)

  // 处理 Tab 键切换 Yes/No 选项的输入模式
  function handleInputModeToggle(option: string) {
    // 通知用户正在与对话框交互
    toolUseConfirm.onUserInteraction()
    const analyticsProps = {
      toolName: sanitizeToolNameForAnalytics(
        toolUseConfirm.tool.name,
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      isMcp: toolUseConfirm.tool.isMcp ?? false,
    }

    if (option === 'yes') {
      if (yesInputMode) {
        setYesInputMode(false)
        logEvent('tengu_accept_feedback_mode_collapsed', analyticsProps)
      } else {
        setYesInputMode(true)
        setYesFeedbackModeEntered(true)
        logEvent('tengu_accept_feedback_mode_entered', analyticsProps)
      }
    } else if (option === 'no') {
      if (noInputMode) {
        setNoInputMode(false)
        logEvent('tengu_reject_feedback_mode_collapsed', analyticsProps)
      } else {
        setNoInputMode(true)
        setNoFeedbackModeEntered(true)
        logEvent('tengu_reject_feedback_mode_entered', analyticsProps)
      }
    }
  }

  function handleReject(feedback?: string) {
    const trimmedFeedback = feedback?.trim()
    const hasFeedback = !!trimmedFeedback

    // 当未提供反馈时记录 Esc（用户按下了 ESC 键）
    if (!hasFeedback) {
      logEvent('tengu_permission_request_escape', {
        explainer_visible: explainerVisible,
      })
      // 递增 Esc 计数用于归因追踪
      setAppState(prev => ({
        ...prev,
        attribution: {
          ...prev.attribution,
          escapeCount: prev.attribution.escapeCount + 1,
        },
      }))
    }

    logUnaryPermissionEvent(
      'tool_use_single',
      toolUseConfirm,
      'reject',
      hasFeedback,
    )

    if (trimmedFeedback) {
      toolUseConfirm.onReject(trimmedFeedback)
    } else {
      toolUseConfirm.onReject()
    }

    onReject()
    onDone()
  }

  function handleFocus(value: string) {
    // 通知用户正在与对话框交互（仅当焦点发生变化时）
    // 这样可避免初始挂载/渲染时触发
    if (value !== focusedOption) {
      toolUseConfirm.onUserInteraction()
    }
    // 离开时重置输入模式，但仅当未输入文本时
    if (value !== 'yes' && yesInputMode && !acceptFeedback.trim()) {
      setYesInputMode(false)
    }
    if (value !== 'no' && noInputMode && !rejectFeedback.trim()) {
      setNoInputMode(false)
    }
    setFocusedOption(value)
  }

  return {
    yesInputMode,
    noInputMode,
    yesFeedbackModeEntered,
    noFeedbackModeEntered,
    acceptFeedback,
    rejectFeedback,
    setAcceptFeedback,
    setRejectFeedback,
    focusedOption,
    handleInputModeToggle,
    handleReject,
    handleFocus,
  }
}
