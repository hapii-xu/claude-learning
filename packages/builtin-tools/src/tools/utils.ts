import type {
  AssistantMessage,
  AttachmentMessage,
  SystemMessage,
  UserMessage,
} from 'src/types/message.js'

/**
 * 用 sourceToolUseID 为用户消息打标，使其在工具完成前保持瞬态。
 * 这样可以避免 "is running" 消息在 UI 中重复出现。
 */
export function tagMessagesWithToolUseID(
  messages: (UserMessage | AttachmentMessage | SystemMessage)[],
  toolUseID: string | undefined,
): (UserMessage | AttachmentMessage | SystemMessage)[] {
  if (!toolUseID) {
    return messages
  }
  return messages.map(m => {
    if (m.type === 'user') {
      return { ...m, sourceToolUseID: toolUseID }
    }
    return m
  })
}

/**
 * 从父消息中提取给定工具名对应的 tool use ID。
 */
export function getToolUseIDFromParentMessage(
  parentMessage: AssistantMessage,
  toolName: string,
): string | undefined {
  const toolUseBlock = Array.isArray(parentMessage.message.content)
    ? parentMessage.message.content.find(
        block => block.type === 'tool_use' && block.name === toolName,
      )
    : undefined
  return toolUseBlock && toolUseBlock.type === 'tool_use'
    ? toolUseBlock.id
    : undefined
}
