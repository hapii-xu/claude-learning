import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../../services/analytics/index.js'
import { sanitizeToolNameForAnalytics } from '../../../services/analytics/metadata.js'
import type { ToolPermissionContext } from '../../../Tool.js'
import {
  CLAUDE_FOLDER_PERMISSION_PATTERN,
  FILE_EDIT_TOOL_NAME,
  GLOBAL_CLAUDE_FOLDER_PERMISSION_PATTERN,
} from '@claude-code-best/builtin-tools/tools/FileEditTool/constants.js'
import { env } from '../../../utils/env.js'
import { generateSuggestions } from '../../../utils/permissions/filesystem.js'
import type { PermissionUpdate } from '../../../utils/permissions/PermissionUpdateSchema.js'
import {
  type CompletionType,
  logUnaryEvent,
} from '../../../utils/unaryLogging.js'
import type { ToolUseConfirm } from '../PermissionRequest.js'
import type {
  FileOperationType,
  PermissionOption,
} from './permissionOptions.js'

function logPermissionEvent(
  event: 'accept' | 'reject',
  completionType: CompletionType,
  languageName: string | Promise<string>,
  messageId: string,
  hasFeedback?: boolean,
): void {
  void logUnaryEvent({
    completion_type: completionType,
    event,
    metadata: {
      language_name: languageName,
      message_id: messageId,
      platform: env.platform,
      hasFeedback: hasFeedback ?? false,
    },
  })
}

export type PermissionHandlerParams = {
  messageId: string
  path: string | null
  toolUseConfirm: ToolUseConfirm
  toolPermissionContext: ToolPermissionContext
  onDone: () => void
  onReject: () => void
  completionType: CompletionType
  languageName: string | Promise<string>
  operationType: FileOperationType
}

export type PermissionHandlerOptions = {
  hasFeedback?: boolean
  feedback?: string
  enteredFeedbackMode?: boolean
  scope?: 'claude-folder' | 'global-claude-folder'
}

function handleAcceptOnce(
  params: PermissionHandlerParams,
  options?: PermissionHandlerOptions,
): void {
  const { messageId, toolUseConfirm, onDone, completionType, languageName } =
    params

  logPermissionEvent('accept', completionType, languageName, messageId)

  // 记录 accept 提交及反馈上下文
  logEvent('tengu_accept_submitted', {
    toolName: sanitizeToolNameForAnalytics(
      toolUseConfirm.tool.name,
    ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    isMcp: toolUseConfirm.tool.isMcp ?? false,
    has_instructions: !!options?.feedback,
    instructions_length: options?.feedback?.length ?? 0,
    entered_feedback_mode: options?.enteredFeedbackMode ?? false,
  })

  onDone()
  toolUseConfirm.onAllow(toolUseConfirm.input, [], options?.feedback)
}

function handleAcceptSession(
  params: PermissionHandlerParams,
  options?: PermissionHandlerOptions,
): void {
  const {
    messageId,
    path,
    toolUseConfirm,
    toolPermissionContext,
    onDone,
    completionType,
    languageName,
    operationType,
  } = params

  logPermissionEvent('accept', completionType, languageName, messageId)

  // 对于 claude-folder 作用域，授予对全部 .hclaude/ 文件的 session 级别访问权限
  if (
    options?.scope === 'claude-folder' ||
    options?.scope === 'global-claude-folder'
  ) {
    const pattern =
      options.scope === 'global-claude-folder'
        ? GLOBAL_CLAUDE_FOLDER_PERMISSION_PATTERN
        : CLAUDE_FOLDER_PERMISSION_PATTERN
    const suggestions: PermissionUpdate[] = [
      {
        type: 'addRules',
        rules: [
          {
            toolName: FILE_EDIT_TOOL_NAME,
            ruleContent: pattern,
          },
        ],
        behavior: 'allow',
        destination: 'session',
      },
    ]
    onDone()
    toolUseConfirm.onAllow(toolUseConfirm.input, suggestions)
    return
  }

  // 若提供了路径则生成权限更新
  const suggestions = path
    ? generateSuggestions(path, operationType, toolPermissionContext)
    : []

  onDone()
  // 直接将权限更新传给 onAllow
  toolUseConfirm.onAllow(toolUseConfirm.input, suggestions)
}

function handleReject(
  params: PermissionHandlerParams,
  options?: PermissionHandlerOptions,
): void {
  const {
    messageId,
    toolUseConfirm,
    onDone,
    onReject,
    completionType,
    languageName,
  } = params

  logPermissionEvent(
    'reject',
    completionType,
    languageName,
    messageId,
    options?.hasFeedback,
  )

  // 记录 reject 提交及反馈上下文
  logEvent('tengu_reject_submitted', {
    toolName: sanitizeToolNameForAnalytics(
      toolUseConfirm.tool.name,
    ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    isMcp: toolUseConfirm.tool.isMcp ?? false,
    has_instructions: !!options?.feedback,
    instructions_length: options?.feedback?.length ?? 0,
    entered_feedback_mode: options?.enteredFeedbackMode ?? false,
  })

  onDone()
  onReject()
  toolUseConfirm.onReject(options?.feedback)
}

export const PERMISSION_HANDLERS: Record<
  PermissionOption['type'],
  (params: PermissionHandlerParams, options?: PermissionHandlerOptions) => void
> = {
  'accept-once': handleAcceptOnce,
  'accept-session': handleAcceptSession,
  reject: handleReject,
}
