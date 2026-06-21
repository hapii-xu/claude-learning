import type { BetaUsage as Usage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { roughTokenCountEstimationForMessages } from '../services/tokenEstimation.js'
import type {
  AssistantMessage,
  ContentItem,
  Message,
} from '../types/message.js'
import { SYNTHETIC_MESSAGES, SYNTHETIC_MODEL } from './messages.js'
import { logForDebugging } from './debug.js'
import { jsonStringify } from './slowOperations.js'

export function getTokenUsage(message: Message): Usage | undefined {
  if (
    message?.type === 'assistant' &&
    message.message &&
    'usage' in message.message &&
    !(
      Array.isArray(message.message.content) &&
      (message.message.content as ContentItem[])[0]?.type === 'text' &&
      SYNTHETIC_MESSAGES.has(
        (message.message.content as Array<ContentItem & { text: string }>)[0]!
          .text,
      )
    ) &&
    message.message.model !== SYNTHETIC_MODEL
  ) {
    return message.message.usage as Usage
  }
  return undefined
}

/**
 * 获取带有真实（非合成）usage 的 assistant 消息的 API response id。
 * 用于识别来自同一 API response 的拆分 assistant 记录 —
 * 当并行工具调用被流式传输时，每个内容块成为一条独立的
 * AssistantMessage 记录，但它们共享同一个 message.id。
 */
function getAssistantMessageId(message: Message): string | undefined {
  if (
    message?.type === 'assistant' &&
    'id' in message.message! &&
    message.message!.model !== SYNTHETIC_MODEL
  ) {
    return message.message!.id
  }
  return undefined
}

/**
 * 根据 API response 的 usage 数据计算总上下文窗口 token 数。
 * 包含 input_tokens + cache tokens + output_tokens。
 *
 * 这表示该 API 调用时的完整上下文大小。
 * 需要从 messages 获取上下文大小时请使用 tokenCountWithEstimation()。
 */
export function getTokenCountFromUsage(usage: Usage): number {
  if (!usage) {
    return 0
  }
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.output_tokens ?? 0)
  )
}

export function tokenCountFromLastAPIResponse(messages: Message[]): number {
  let i = messages.length - 1
  while (i >= 0) {
    const message = messages[i]
    const usage = message ? getTokenUsage(message) : undefined
    if (usage) {
      return getTokenCountFromUsage(usage)
    }
    i--
  }
  return 0
}

/**
 * 从最后一次 API response 的 usage.iterations[-1] 获取最终上下文窗口大小。
 * 用于跨压缩边界计算 task_budget.remaining —
 * 服务端的预算倒计时基于上下文，因此 remaining 按压缩前的
 * 最终窗口递减，而非按计费消耗。服务端计算参见 monorepo
 * api/api/sampling/prompt/renderer.py:292。
 *
 * 当 iterations 不存在时回退到顶层 input_tokens + output_tokens
 * （无服务端工具循环，因此顶层 usage 即最终窗口）。
 * 两条路径都排除 cache tokens 以匹配 #304930 的公式。
 */
export function finalContextTokensFromLastResponse(
  messages: Message[],
): number {
  let i = messages.length - 1
  while (i >= 0) {
    const message = messages[i]
    const usage = message ? getTokenUsage(message) : undefined
    if (usage) {
      // Stainless 类型尚未包含 iterations — 像 advisor.ts:43 那样转换
      const iterations = (
        usage as {
          iterations?: Array<{
            input_tokens: number
            output_tokens: number
          }> | null
        }
      ).iterations
      if (iterations && iterations.length > 0) {
        const last = iterations.at(-1)!
        return last.input_tokens + last.output_tokens
      }
      // 无 iterations → 无服务端工具循环 → 顶层 usage 即最终
      // 窗口。匹配 iterations 路径的公式（input + output，无 cache）
      // 而非 getTokenCountFromUsage — #304930 将最终窗口定义为
      // 非 cache input + output。服务端的预算倒计时
      // （renderer.py:292 calculate_context_tokens）是否以相同方式
      // 计算 cache 是一个开放问题；与 iterations 路径对齐以在
      // 解决该问题前保持两个分支一致。
      return usage.input_tokens + usage.output_tokens
    }
    i--
  }
  return 0
}

/**
 * 仅从最后一次 API response 中获取 output_tokens。
 * 不包括输入上下文（system prompt、tools、之前的 messages）。
 *
 * 警告：不要将此用于阈值比较（autocompact、session memory）。
 * 请改用 tokenCountWithEstimation()，它度量完整上下文大小。
 * 此函数仅用于度量 Claude 在单次响应中生成了多少 token，
 * 而非上下文窗口有多满。
 */
export function messageTokenCountFromLastAPIResponse(
  messages: Message[],
): number {
  let i = messages.length - 1
  while (i >= 0) {
    const message = messages[i]
    const usage = message ? getTokenUsage(message) : undefined
    if (usage) {
      return usage.output_tokens
    }
    i--
  }
  return 0
}

export function getCurrentUsage(messages: Message[]): {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
} | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    const usage = message ? getTokenUsage(message) : undefined
    if (usage) {
      const inputTokens =
        (usage.input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0)
      // 跳过占位 usage（全为零）— 第三方 API 可能
      // 发出 message_start 而无真实 usage 数据，导致上下文计数器
      // 闪回 0。继续向前回溯到上一条消息。
      if (inputTokens === 0 && (usage.output_tokens ?? 0) === 0) continue
      return {
        input_tokens: usage.input_tokens ?? 0,
        output_tokens: usage.output_tokens ?? 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      }
    }
  }
  return null
}

export function doesMostRecentAssistantMessageExceed200k(
  messages: Message[],
): boolean {
  const THRESHOLD = 200_000

  const lastAsst = messages.findLast(m => m.type === 'assistant')
  if (!lastAsst) return false
  const usage = getTokenUsage(lastAsst)
  return usage ? getTokenCountFromUsage(usage) > THRESHOLD : false
}

/**
 * 计算 assistant 消息的字符内容长度。
 * 用于 spinner token 估算（字符数 / 4 ≈ tokens）。
 * 当 subagent 流式事件被过滤掉而需要从已完成消息中
 * 统计内容时使用。
 *
 * 统计 handleMessageFromStream 通过 delta 统计的相同内容：
 * - text（text_delta）
 * - thinking（thinking_delta）
 * - redacted_thinking data
 * - tool_use input（input_json_delta）
 * 注意：signature_delta 不在流式统计中（非模型输出）。
 */
export function getAssistantMessageContentLength(
  message: AssistantMessage,
): number {
  let contentLength = 0
  const content = message.message?.content
  if (!Array.isArray(content)) return contentLength
  for (const block of content as ContentItem[]) {
    if (block.type === 'text') {
      contentLength += (block as ContentItem & { text: string }).text.length
    } else if (block.type === 'thinking') {
      contentLength += (block as ContentItem & { thinking: string }).thinking
        .length
    } else if (block.type === 'redacted_thinking') {
      contentLength += (block as ContentItem & { data: string }).data.length
    } else if (block.type === 'tool_use') {
      contentLength += jsonStringify(
        (block as ContentItem & { input: unknown }).input,
      ).length
    }
  }
  return contentLength
}

/**
 * 获取当前上下文窗口大小（以 tokens 为单位）。
 *
 * 这是检查阈值（autocompact、session memory 初始化等）时
 * 度量上下文大小的标准函数。使用最后一次 API response 的 token 计数
 * （input + output + cache），并估算之后新增的消息。
 *
 * 务必使用此函数，而非：
 * - 累加 token 计数（随着上下文增长会重复计数）
 * - messageTokenCountFromLastAPIResponse（仅统计 output_tokens）
 * - tokenCountFromLastAPIResponse（不估算新消息）
 *
 * 关于并行工具调用的实现说明：当模型在一个响应中发起多个
 * 工具调用时，流式代码会为每个内容块发出一条独立的 assistant
 * 记录（全部共享同一 message.id 和 usage），并且查询循环会在每个
 * tool_use 之后立即穿插对应的 tool_result。因此 messages 数组看起来像：
 *   [..., assistant(id=A), user(result), assistant(id=A), user(result), ...]
 * 如果停在最后一条 assistant 记录，我们只会估算其后的那一个 tool_result
 * 而遗漏所有更早的穿插 tool_result — 而这些都将出现在下一次 API 请求中。
 * 为避免少计，找到带 usage 的记录后，向前回溯到具有相同 message.id 的
 * 第一条同级记录，使每个穿插的 tool_result 都纳入粗略估算。
 */
export function tokenCountWithEstimation(messages: readonly Message[]): number {
  let i = messages.length - 1
  while (i >= 0) {
    const message = messages[i]
    const usage = message ? getTokenUsage(message) : undefined
    if (message && usage) {
      // 向前回溯到从同一 API response 拆分出的任何更早同级记录
      // （相同 message.id），使它们之间穿插的 tool_result
      // 被包含在估算切片中。
      const responseId = getAssistantMessageId(message)
      if (responseId) {
        let j = i - 1
        while (j >= 0) {
          const prior = messages[j]
          const priorId = prior ? getAssistantMessageId(prior) : undefined
          if (priorId === responseId) {
            // 同一 API response 的更早拆分 — 在此处锚定。
            i = j
          } else if (priorId !== undefined) {
            // 遇到不同的 API response — 停止回溯。
            break
          }
          // priorId === undefined：user/tool_result/attachment 消息，
          // 可能穿插在拆分之间 — 继续回溯。
          j--
        }
      }
      const total =
        getTokenCountFromUsage(usage) +
        roughTokenCountEstimationForMessages(
          messages.slice(i + 1) as Parameters<
            typeof roughTokenCountEstimationForMessages
          >[0],
        )
      logForDebugging(
        `[Hapii] Tokens.tokenCountWithEstimation 精确+估算 apiReported=${getTokenCountFromUsage(usage)} estimatedNew=${total - getTokenCountFromUsage(usage)} total=${total} msgCount=${messages.length}`,
        { level: 'info' },
      )
      return total
    }
    i--
  }
  const estimated = roughTokenCountEstimationForMessages(
    messages as Parameters<typeof roughTokenCountEstimationForMessages>[0],
  )
  logForDebugging(
    `[Hapii] Tokens.tokenCountWithEstimation 纯估算 total=${estimated} msgCount=${messages.length}`,
    { level: 'info' },
  )
  return estimated
}
