/**
 * /summary — 生成并展示会话摘要。
 *
 * 触发一次手动的 Session Memory 抽取（绕过自动阈值），
 * 然后读取并展示更新后的 summary.md 文件。
 */
import type { Command, LocalCommandCall } from '../../types/command.js'
import type { Message } from '../../types/message.js'

/** 只有 user/assistant/system 消息对 API 调用是合法的。 */
const API_SAFE_TYPES = new Set(['user', 'assistant', 'system'])

const call: LocalCommandCall = async (_args, context) => {
  const { messages } = context

  // 仅过滤出对 API 安全的消息类型。
  // context.messages 包含 progress/attachment 等会让 API 调用链
  // 崩溃的消息（normalizeMessagesForAPI → addCacheBreakpoints 只接受
  // user/assistant）。自动抽取路径使用 createCacheSafeParams(REPLHookContext)，
  // 其 messages 已经是干净的；而通过 /summary 的手动路径并非如此。
  const safeMessages = (messages ?? []).filter(
    (m): m is Message => m != null && API_SAFE_TYPES.has(m.type),
  )

  if (safeMessages.length === 0) {
    return { type: 'text', value: 'No messages to summarize.' }
  }

  try {
    const { manuallyExtractSessionMemory } = await import(
      '../../services/SessionMemory/sessionMemory.js'
    )
    const { getSessionMemoryContent } = await import(
      '../../services/SessionMemory/sessionMemoryUtils.js'
    )

    const safeContext = { ...context, messages: safeMessages }
    const result = await manuallyExtractSessionMemory(safeMessages, safeContext)

    if (!result.success) {
      return {
        type: 'text',
        value: `Failed to generate session summary: ${result.error ?? 'unknown error'}`,
      }
    }

    const content = await getSessionMemoryContent()

    if (!content || content.trim().length === 0) {
      return {
        type: 'text',
        value: 'Session summary was updated, but the content is empty.',
      }
    }

    return {
      type: 'text',
      value: `Session summary updated.\n\n${content}`,
    }
  } catch (error) {
    return {
      type: 'text',
      value: `Failed to generate session summary: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

const summary = {
  type: 'local',
  name: 'summary',
  description: 'Generate and display a session summary',
  supportsNonInteractive: true,
  isHidden: false,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default summary
