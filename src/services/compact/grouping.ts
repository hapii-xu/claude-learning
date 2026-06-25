import type { Message } from '../../types/message.js'

/**
 * 按 API round 边界对消息分组：每次 API 往返一个 group。
 * 当新的 assistant 响应开始时触发边界（message.id 与上一条 assistant 不同）。
 * 对于格式正确的对话，这是一个 API 安全的分割点——API 协议要求每个 tool_use
 * 在下一个 assistant 轮次前必须被 resolved，因此配对合法性自然由 assistant-id
 * 边界保证。对于格式异常的输入（resume/truncation 后的孤立 tool_use），
 * fork 的 ensureToolResultPairing 会在 API 层修复该分割。
 *
 * 替代了旧版的 human-turn 分组（仅在真实用户 prompt 处分组），
 * 改用更细粒度的 API-round 分组，使 reactive compact 能在单提示的
 * agentic 会话（SDK/CCR/eval 调用方）中运作——这类会话整个工作负载
 * 只有一个 human turn。
 *
 * 拆分到独立文件是为了打破 compact.ts ↔ compactMessages.ts 的循环（CC-1180）——
 * 该循环导致模块初始化顺序改变，从而在 CI shard-2 中暴露了一个隐性的
 * ws CJS/ESM 解析竞态。
 */
export function groupMessagesByApiRound(messages: Message[]): Message[][] {
  const groups: Message[][] = []
  let current: Message[] = []
  // 最近一次见到的 assistant 的 message.id。这是唯一的边界门控：
  // 同一 API 响应的流式 chunk 共享相同的 id，因此边界只在真正新一轮
  // 开始时触发。normalizeMessages 每个 content block 生成一条 AssistantMessage，
  // StreamingToolExecutor 在 chunk 之间实时穿插 tool_results
  //（yield 顺序，不是 concat 顺序——见 query.ts:613）。
  // id 检查能正确地将 `[tu_A(id=X), result_A, tu_B(id=X)]` 保留在同一 group 中。
  let lastAssistantId: string | undefined

  // 对于格式正确的对话，API 协议保证每个 tool_use 在下一个 assistant 轮次前
  // 被 resolved，因此 lastAssistantId 单独作为边界门控就已足够。
  // 跟踪未 resolved 的 tool_use ID 只在对话格式异常时才有意义
  //（resume-from-partial-batch 或 max_tokens 截断后的孤立 tool_use）——
  // 而那种情况会让门控永久关闭，把后续所有轮次合并成一个 group。
  // 我们让那些边界照常触发；summarizer fork 的 ensureToolResultPairing
  // 在 claude.ts:1136 处会在 API 层修复孤立的 tu。
  for (const msg of messages) {
    if (
      msg.type === 'assistant' &&
      msg.message!.id !== lastAssistantId &&
      current.length > 0
    ) {
      groups.push(current)
      current = [msg]
    } else {
      current.push(msg)
    }
    if (msg.type === 'assistant') {
      lastAssistantId = msg.message!.id
    }
  }

  if (current.length > 0) {
    groups.push(current)
  }
  return groups
}
