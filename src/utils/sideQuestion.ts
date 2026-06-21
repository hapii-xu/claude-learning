/**
 * Side Question ("/btw") 功能 - 允许在不中断主 agent 上下文的情况下
 * 提出快速问题。
 *
 * 使用 runForkedAgent 利用父上下文的提示缓存，同时保持侧问题响应
 * 与主对话分离。
 */

import { formatAPIError } from '@ant/model-provider'
import type { NonNullableUsage } from '@ant/model-provider'
import type { Message, SystemAPIErrorMessage } from '../types/message.js'
import { type CacheSafeParams, runForkedAgent } from './forkedAgent.js'
import { createUserMessage, extractTextContent } from './messages.js'

// 检测文本开头 "/btw" 的模式（不区分大小写，单词边界）
const BTW_PATTERN = /^\/btw\b/gi

/**
 * 查找文本开头用于高亮的 "/btw" 关键字位置。
 * 类似于 thinking.ts 中的 findThinkingTriggerPositions。
 */
export function findBtwTriggerPositions(text: string): Array<{
  word: string
  start: number
  end: number
}> {
  const positions: Array<{ word: string; start: number; end: number }> = []
  const matches = text.matchAll(BTW_PATTERN)

  for (const match of matches) {
    if (match.index !== undefined) {
      positions.push({
        word: match[0],
        start: match.index,
        end: match.index + match[0].length,
      })
    }
  }

  return positions
}

export type SideQuestionResult = {
  response: string | null
  usage: NonNullableUsage
}

/**
 * 使用分叉 agent 运行侧问题。
 * 共享父级的提示缓存 — 无思考覆盖，无缓存写入。
 * 所有工具被阻止，且限制为 1 轮。
 */
export async function runSideQuestion({
  question,
  cacheSafeParams,
}: {
  question: string
  cacheSafeParams: CacheSafeParams
}): Promise<SideQuestionResult> {
  // 用指令包装问题，要求直接回答而不使用工具
  const wrappedQuestion = `<system-reminder>This is a side question from the user. You must answer this question directly in a single response.

IMPORTANT CONTEXT:
- You are a separate, lightweight agent spawned to answer this one question
- The main agent is NOT interrupted - it continues working independently in the background
- You share the conversation context but are a completely separate instance
- Do NOT reference being interrupted or what you were "previously doing" - that framing is incorrect

CRITICAL CONSTRAINTS:
- You have NO tools available - you cannot read files, run commands, search, or take any actions
- This is a one-off response - there will be no follow-up turns
- You can ONLY provide information based on what you already know from the conversation context
- NEVER say things like "Let me try...", "I'll now...", "Let me check...", or promise to take any action
- If you don't know the answer, say so - do not offer to look it up or investigate

Simply answer the question with the information you have.</system-reminder>

${question}`

  const agentResult = await runForkedAgent({
    promptMessages: [createUserMessage({ content: wrappedQuestion })],
    // 不要覆盖 thinkingConfig — 思考是 API 缓存键的一部分，
    // 与主线程的配置分歧会破坏提示缓存。
    // 快速问答上的自适应思考开销可忽略不计。
    cacheSafeParams,
    canUseTool: async () => ({
      behavior: 'deny' as const,
      message: 'Side questions cannot use tools',
      decisionReason: { type: 'other' as const, reason: 'side_question' },
    }),
    querySource: 'side_question',
    forkLabel: 'side_question',
    maxTurns: 1, // 仅单轮 — 无工具使用循环
    // 没有未来的请求共享此后缀；跳过写入缓存条目。
    skipCacheWrite: true,
  })

  return {
    response: extractSideQuestionResponse(agentResult.messages),
    usage: agentResult.totalUsage,
  }
}

/**
 * 从分叉 agent 消息中提取显示字符串。
 *
 * 重要：claude.ts 每个内容块生成一条 AssistantMessage，而非每条
 * API 响应一条。启用自适应思考（从主线程继承以保持缓存键）时，
 * 思考响应到达形式为：
 *   messages[0] = assistant { content: [thinking_block] }
 *   messages[1] = assistant { content: [text_block] }
 *
 * 旧代码使用 `.find(m => m.type === 'assistant')` 获取第一条
 *（仅思考）消息，找不到文本块并返回 null →"未收到响应"。
 * 具有大上下文的仓库（许多 skill、大型 CLAUDE.md）更常触发思考，
 * 这就是为什么在 monorepo 中复现而非这里。
 *
 * 其他故障模式也表现为"未收到响应"：
 *   - 模型尝试 tool_use → content = [thinking, tool_use]，无文本。
 *     罕见 — 系统提醒通常会阻止此情况，但在此处理。
 *   - API 错误耗尽重试 → query 生成 system api_error + user
 *     interruption，完全没有 assistant 消息。
 */
function extractSideQuestionResponse(messages: Message[]): string | null {
  // 展平跨每块消息的所有 assistant 内容块。
  const assistantBlocks = messages.flatMap(m =>
    m.type === 'assistant'
      ? (m.message!.content as unknown as Array<{
          type: string
          [key: string]: unknown
        }>)
      : [],
  )

  if (assistantBlocks.length > 0) {
    // 连接所有文本块（通常最多一个，但为了安全起见）。
    const text = extractTextContent(assistantBlocks, '\n\n').trim()
    if (text) return text

    // 无文本 — 检查模型是否违反指令尝试调用工具。
    const toolUse = assistantBlocks.find(b => b.type === 'tool_use')
    if (toolUse) {
      const toolName =
        'name' in toolUse
          ? (toolUse as unknown as { name: string }).name
          : 'a tool'
      return `(The model tried to call ${toolName} instead of answering directly. Try rephrasing or ask in the main conversation.)`
    }
  }

  // 无 assistant 内容 — 可能是 API 错误耗尽重试。显示第一条
  // 系统 api_error 消息，让用户看到发生了什么。
  const apiErr = messages.find(
    (m): m is SystemAPIErrorMessage =>
      m.type === 'system' && 'subtype' in m && m.subtype === 'api_error',
  )
  if (apiErr) {
    return `(API error: ${formatAPIError(apiErr.error as Parameters<typeof formatAPIError>[0])})`
  }

  return null
}
