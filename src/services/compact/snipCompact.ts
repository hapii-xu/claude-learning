import type { Message } from 'src/types/message.js'

/**
 * 每个 token 的估算字符数（对代码/文本混合内容保守估计）。
 */
const CHARS_PER_TOKEN = 4

/**
 * 在 nudge 模型考虑 snip 之前的最小消息数量。
 */
const SNIP_NUDGE_THRESHOLD = 30

/**
 * 当对话足够长、可从 snip 中受益时，向模型展示的 nudge 文本。
 */
export const SNIP_NUDGE_TEXT: string =
  'The conversation history is getting long. Consider using the /force-snip command or the snip tool to compress older messages, freeing context window space for continued work.'

/**
 * 检查消息是否为内部 snip marker（非用户可见）。
 * Snip marker 是由 snip tool 注入的 system 消息，用于跟踪
 * 哪些消息已被登记为未来待删除的对象。
 */
export function isSnipMarkerMessage(message: Message): boolean {
  if (message.type !== 'system') return false
  return (message as Record<string, unknown>).subtype === 'snip_marker'
}

/**
 * 通过序列化消息内容来估算单条消息的 token 数。
 * 这是一个粗略的启发式估计（约 4 字符/token），用于上报
 * tokensFreed，不需要精确。
 */
function estimateMessageTokens(message: Message): number {
  const content = message.message?.content
  let chars = 0
  if (typeof content === 'string') {
    chars = content.length
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === 'string') {
        chars += (block as string).length
      } else if (block && typeof block === 'object') {
        const obj = block as unknown as Record<string, unknown>
        const text = obj.text ?? obj.content
        if (typeof text === 'string') {
          chars += text.length
        } else {
          chars += JSON.stringify(block).length
        }
      }
    }
  } else if (content !== null && content !== undefined) {
    chars = JSON.stringify(content).length
  }
  return Math.max(1, Math.ceil(chars / CHARS_PER_TOKEN))
}

/**
 * 扫描消息数组，找到最后一条 `snip_boundary` system 消息，
 * 若找到则移除所有 UUID 出现在其 `snipMetadata.removedUuids` 中的消息。
 *
 * 这是核心的内存节省函数。当 snip boundary 存在时：
 * 1. 所有在 `removedUuids` 中列出的消息会被过滤掉。
 * 2. boundary 消息本身保留（它记录了被删除的内容）。
 * 3. 不在 `removedUuids` 中的消息（包括 boundary 之后的消息）被保留。
 *
 * 调用方：
 * - `query.ts` — 在发送到 API 前，从面向模型的消息数组中剔除已 snip 的消息。
 * - `QueryEngine.ts` `snipReplay` — 裁剪 `mutableMessages`，
 *   防止长 SDK 会话中内存存储无限增长。
 *
 * @param messages  完整消息数组（可能包含 snip_boundary）。
 * @param options   `force` — 若为 true，有 boundary 时总是执行。
 *                  不带 `force` 时，找到 boundary 同样执行
 *                  （"if needed" 指的是 boundary 是否存在，而非 token 阈值）。
 */
export function snipCompactIfNeeded(
  messages: Message[],
  _options?: { force?: boolean },
): {
  messages: Message[]
  executed: boolean
  tokensFreed: number
  boundaryMessage?: Message
} {
  // Find the last snip_boundary message
  let boundaryIdx = -1
  let removedUuids: string[] | undefined

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (
      msg.type === 'system' &&
      (msg as Record<string, unknown>).subtype === 'snip_boundary'
    ) {
      boundaryIdx = i
      const meta = (msg as Record<string, unknown>).snipMetadata as
        | { removedUuids?: string[] }
        | undefined
      removedUuids = meta?.removedUuids
      break
    }
  }

  if (boundaryIdx === -1) {
    return { messages, executed: false, tokensFreed: 0 }
  }

  const boundaryMessage = messages[boundaryIdx]!

  // No removedUuids metadata — fallback: keep boundary + everything after
  if (!removedUuids || removedUuids.length === 0) {
    const kept = messages.slice(boundaryIdx)
    return {
      messages: kept,
      executed: true,
      tokensFreed: 0,
      boundaryMessage,
    }
  }

  // Filter out messages whose UUIDs are listed in removedUuids
  const removedSet = new Set(removedUuids)
  const kept: Message[] = []
  let tokensFreed = 0

  for (const msg of messages) {
    if (removedSet.has(msg.uuid)) {
      tokensFreed += estimateMessageTokens(msg)
      continue
    }
    kept.push(msg)
  }

  return {
    messages: kept,
    executed: true,
    tokensFreed,
    boundaryMessage,
  }
}

/**
 * Returns true when the snip runtime is active.
 * Because this module is only loaded when the HISTORY_SNIP feature flag
 * is enabled, this always returns true.
 */
export function isSnipRuntimeEnabled(): boolean {
  return true
}

/**
 * Determine whether the conversation is long enough to warrant a nudge
 * to the model to consider snipping. Uses a simple message-count
 * threshold rather than an expensive token count.
 */
export function shouldNudgeForSnips(messages: Message[]): boolean {
  return messages.length >= SNIP_NUDGE_THRESHOLD
}
