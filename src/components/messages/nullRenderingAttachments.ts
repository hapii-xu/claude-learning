import type { Attachment } from 'src/utils/attachments.js'
import type { Message, NormalizedMessage } from '../../types/message.js'

/**
 * AttachmentMessage 无条件渲染为 `null` 的 Attachment 类型
 * （无论运行时状态如何都没有可见输出）。Messages.tsx 在渲染上限/消息计数
 * 之前过滤这些类型，以防隐藏条目消耗 200 条消息的渲染预算（CC-724）。
 *
 * TypeScript 强制同步：AttachmentMessage 的 switch `default:` 分支
 * 断言 `attachment.type satisfies NullRenderingAttachmentType`。
 * 添加新的 Attachment 类型而不添加对应的 case 或此处的条目将导致类型检查失败。
 */
const NULL_RENDERING_TYPES = [
  'hook_success',
  'hook_additional_context',
  'hook_cancelled',
  'command_permissions',
  'agent_mention',
  'budget_usd',
  'critical_system_reminder',
  'edited_image_file',
  'edited_text_file',
  'opened_file_in_ide',
  'output_style',
  'plan_mode',
  'plan_mode_exit',
  'plan_mode_reentry',
  'structured_output',
  'team_context',
  'todo_reminder',
  'context_efficiency',
  'deferred_tools_delta',
  'mcp_instructions_delta',
  'companion_intro',
  'token_usage',
  'ultrathink_effort',
  'max_turns_reached',
  'task_reminder',
  'auto_mode',
  'auto_mode_exit',
  'output_token_usage',
  'verify_plan_reminder',
  'current_session_memory',
  'compaction_reminder',
  'date_change',
] as const satisfies readonly Attachment['type'][]

export type NullRenderingAttachmentType = (typeof NULL_RENDERING_TYPES)[number]

const NULL_RENDERING_ATTACHMENT_TYPES: ReadonlySet<Attachment['type']> =
  new Set(NULL_RENDERING_TYPES)

/**
 * 当此消息是 AttachmentMessage 渲染为 null（没有可见输出）的 attachment 时返回 true。
 * Messages.tsx 在计数之前以及应用 200 条消息渲染上限之前过滤这些，
 * 这样隐藏的 hook 附件（hook_success、hook_additional_context、hook_cancelled）
 * 不会膨胀 "N 条消息" 计数或占用渲染预算（CC-724）。
 */
export function isNullRenderingAttachment(
  msg: Message | NormalizedMessage,
): boolean {
  return (
    msg.type === 'attachment' &&
    NULL_RENDERING_ATTACHMENT_TYPES.has(
      msg.attachment!.type as Attachment['type'],
    )
  )
}
