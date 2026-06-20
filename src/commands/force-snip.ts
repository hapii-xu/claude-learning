import { randomUUID } from 'crypto'
import type { Command, LocalCommandCall } from '../types/command.js'
import type { Message } from '../types/message.js'

/**
 * 向消息数组中插入一条 snip 边界。
 *
 * snip 边界是一条 system 消息，标记其之前的所有内容为「已 snip」。
 * 下一个 query 周期中，`snipCompactIfNeeded`（位于
 * services/compact/snipCompact.ts）会识别该边界并移除 —— 或折叠 ——
 * 较旧的消息，使其不再占用上下文窗口 token。REPL 仍保留完整历史用于 UI 回滚，
 * 该边界只影响面向模型的投影。
 *
 * `snipMetadata.removedUuids` 字段告知下游消费者（sessionStorage 持久化、
 * snipProjection）哪些消息已被移除。
 */
const call: LocalCommandCall = async (_args, context) => {
  const { messages, setMessages } = context

  if (messages.length === 0) {
    return { type: 'text', value: 'No messages to snip.' }
  }

  // 收集所有将被 snip 掉的消息 UUID（即当前会话中的所有消息）。
  // 下一次调用 `snipCompactIfNeeded` 时会识别该边界，并把这些消息从面向模型的视图中剥离。
  const removedUuids = messages.map(m => m.uuid)

  const boundaryMessage: Message = {
    type: 'system',
    subtype: 'snip_boundary',
    content: '[snip] Conversation history before this point has been snipped.',
    isMeta: true,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
    snipMetadata: {
      removedUuids,
    },
  } as Message // subtype 受 feature gate 控制；通过 Message 进行类型转换

  setMessages(prev => [...prev, boundaryMessage])

  return {
    type: 'text',
    value: `Snipped ${removedUuids.length} message(s). Older history will be excluded from the next model query.`,
  }
}

const forceSnip = {
  type: 'local',
  name: 'force-snip',
  description: 'Force snip conversation history at current point',
  supportsNonInteractive: true,
  isHidden: false,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default forceSnip
