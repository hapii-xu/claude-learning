import { useCallback, useMemo, useState } from 'react'
import { useAppState } from 'src/state/AppState.js'
import { useKeybindings } from '../../../keybindings/useKeybinding.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../../services/analytics/index.js'
import { sanitizeToolNameForAnalytics } from '../../../services/analytics/metadata.js'
import type { PermissionUpdate } from '../../../utils/permissions/PermissionUpdateSchema.js'
import type { CompletionType } from '../../../utils/unaryLogging.js'
import type { ToolUseConfirm } from '../PermissionRequest.js'
import {
  type FileOperationType,
  getFilePermissionOptions,
  type PermissionOption,
  type PermissionOptionWithLabel,
} from './permissionOptions.js'
import {
  PERMISSION_HANDLERS,
  type PermissionHandlerParams,
} from './usePermissionHandler.js'

export interface ToolInput {
  [key: string]: unknown
}

export type UseFilePermissionDialogProps<T extends ToolInput> = {
  filePath: string
  completionType: CompletionType
  languageName: string | Promise<string>
  toolUseConfirm: ToolUseConfirm
  onDone: () => void
  onReject: () => void
  parseInput: (input: unknown) => T
  operationType?: FileOperationType
}

export type UseFilePermissionDialogResult<T> = {
  options: PermissionOptionWithLabel[]
  onChange: (option: PermissionOption, input: T, feedback?: string) => void
  acceptFeedback: string
  rejectFeedback: string
  focusedOption: string
  setFocusedOption: (option: string) => void
  handleInputModeToggle: (value: string) => void
  yesInputMode: boolean
  noInputMode: boolean
}

/**
 * 用于处理文件权限对话框的通用逻辑 Hook
 */
export function useFilePermissionDialog<T extends ToolInput>({
  filePath,
  completionType,
  languageName,
  toolUseConfirm,
  onDone,
  onReject,
  parseInput,
  operationType = 'write',
}: UseFilePermissionDialogProps<T>): UseFilePermissionDialogResult<T> {
  const toolPermissionContext = useAppState(s => s.toolPermissionContext)
  const [acceptFeedback, setAcceptFeedback] = useState('')
  const [rejectFeedback, setRejectFeedback] = useState('')
  const [focusedOption, setFocusedOption] = useState('yes')
  const [yesInputMode, setYesInputMode] = useState(false)
  const [noInputMode, setNoInputMode] = useState(false)
  // 追踪用户是否曾经进入过反馈模式（收起后仍保留状态）
  const [yesFeedbackModeEntered, setYesFeedbackModeEntered] = useState(false)
  const [noFeedbackModeEntered, setNoFeedbackModeEntered] = useState(false)

  // 基于上下文生成选项
  const options = useMemo(
    () =>
      getFilePermissionOptions({
        filePath,
        toolPermissionContext,
        operationType,
        onRejectFeedbackChange: setRejectFeedback,
        onAcceptFeedbackChange: setAcceptFeedback,
        yesInputMode,
        noInputMode,
      }),
    [filePath, toolPermissionContext, operationType, yesInputMode, noInputMode],
  )

  // 使用共享处理器处理选项选择
  const onChange = useCallback(
    (option: PermissionOption, input: T, feedback?: string) => {
      const params: PermissionHandlerParams = {
        messageId: toolUseConfirm.assistantMessage.message.id!,
        path: filePath,
        toolUseConfirm,
        toolPermissionContext,
        onDone,
        onReject,
        completionType,
        languageName,
        operationType,
      }

      // 覆写 toolUseConfirm 中的 input 以传入解析后的 input
      const originalOnAllow = toolUseConfirm.onAllow
      toolUseConfirm.onAllow = (
        _input: unknown,
        permissionUpdates: PermissionUpdate[],
        feedback?: string,
      ) => {
        originalOnAllow(input, permissionUpdates, feedback)
      }

      const handler = PERMISSION_HANDLERS[option.type]
      handler(params, {
        feedback,
        hasFeedback: !!feedback,
        enteredFeedbackMode:
          option.type === 'accept-once'
            ? yesFeedbackModeEntered
            : noFeedbackModeEntered,
        scope: option.type === 'accept-session' ? option.scope : undefined,
      })
    },
    [
      filePath,
      completionType,
      languageName,
      toolUseConfirm,
      toolPermissionContext,
      onDone,
      onReject,
      operationType,
      yesFeedbackModeEntered,
      noFeedbackModeEntered,
    ],
  )

  // confirm:cycleMode 的处理器 - 选择 accept-session 选项
  const handleCycleMode = useCallback(() => {
    const sessionOption = options.find(o => o.option.type === 'accept-session')
    if (sessionOption) {
      const parsedInput = parseInput(toolUseConfirm.input)
      onChange(sessionOption.option, parsedInput)
    }
  }, [options, parseInput, toolUseConfirm.input, onChange])

  // 通过快捷键系统注册键盘快捷键处理器
  useKeybindings(
    { 'confirm:cycleMode': handleCycleMode },
    { context: 'Confirmation' },
  )

  // 包装 setFocusedOption，并在离开时重置输入模式
  const handleFocusedOptionChange = useCallback(
    (value: string) => {
      // 离开时重置输入模式，但仅当未输入文本时
      if (value !== 'yes' && yesInputMode && !acceptFeedback.trim()) {
        setYesInputMode(false)
      }
      if (value !== 'no' && noInputMode && !rejectFeedback.trim()) {
        setNoInputMode(false)
      }
      setFocusedOption(value)
    },
    [yesInputMode, noInputMode, acceptFeedback, rejectFeedback],
  )

  // 处理 Tab 键切换 Yes/No 选项的输入模式
  const handleInputModeToggle = useCallback(
    (value: string) => {
      const analyticsProps = {
        toolName: sanitizeToolNameForAnalytics(
          toolUseConfirm.tool.name,
        ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        isMcp: toolUseConfirm.tool.isMcp ?? false,
      }

      if (value === 'yes') {
        if (yesInputMode) {
          setYesInputMode(false)
          logEvent('tengu_accept_feedback_mode_collapsed', analyticsProps)
        } else {
          setYesInputMode(true)
          setYesFeedbackModeEntered(true)
          logEvent('tengu_accept_feedback_mode_entered', analyticsProps)
        }
      } else if (value === 'no') {
        if (noInputMode) {
          setNoInputMode(false)
          logEvent('tengu_reject_feedback_mode_collapsed', analyticsProps)
        } else {
          setNoInputMode(true)
          setNoFeedbackModeEntered(true)
          logEvent('tengu_reject_feedback_mode_entered', analyticsProps)
        }
      }
    },
    [yesInputMode, noInputMode, toolUseConfirm],
  )

  return {
    options,
    onChange,
    acceptFeedback,
    rejectFeedback,
    focusedOption,
    setFocusedOption: handleFocusedOptionChange,
    handleInputModeToggle,
    yesInputMode,
    noInputMode,
  }
}
