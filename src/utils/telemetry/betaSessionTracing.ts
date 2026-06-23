/**
 * Claude Code 的 Beta 会话追踪
 *
 * 本模块包含在设置了 ENABLE_BETA_TRACING_DETAILED=1 和 BETA_TRACING_ENDPOINT 时
 * 启用的 Beta 追踪功能。
 *
 * 对于外部用户，追踪在 SDK/无头模式下启用，或在交互模式下当组织通过
 * tengu_trace_lantern GrowthBook 门控被列入白名单时启用。
 * 对于内部用户（ant），追踪在所有模式下启用。
 *
 * 可见性规则：
 * | 内容            | 外部用户 | 内部用户 |
 * |------------------|----------|------|
 * | 系统提示词       | ✅                  | ✅   |
 * | 模型输出         | ✅                  | ✅   |
 * | 思考过程输出     | ❌                  | ✅   |
 * | 工具             | ✅                  | ✅   |
 * | new_context      | ✅                  | ✅   |
 *
 * 功能特性：
 * - 基于哈希去重的逐 Agent 消息追踪
 * - 系统提示词日志记录（每个唯一哈希仅记录一次）
 * - Hook 执行跨度
 * - LLM 请求的详细 new_context 属性
 */

import type { Span } from '@opentelemetry/api'
import { createHash } from 'crypto'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { sanitizeToolNameForAnalytics } from '../../services/analytics/metadata.js'
import type { AssistantMessage, UserMessage } from '../../types/message.js'
import { isEnvTruthy } from '../envUtils.js'
import { jsonParse, jsonStringify } from '../slowOperations.js'
import { logOTelEvent } from './events.js'

// API 调用的消息类型（UserMessage 或 AssistantMessage）
type APIMessage = UserMessage | AssistantMessage

/**
 * 追踪本次会话中已记录过的哈希值（系统提示词、工具等）。
 *
 * 原因：系统提示词和工具 Schema 体积较大，且在同一个会话内很少变化。
 * 每次请求都发送完整内容会造成浪费。因此我们使用哈希，
 * 每个唯一哈希仅记录一次完整内容。
 */
const seenHashes = new Set<string>()

/**
 * 追踪每个 querySource（Agent）的上次已报告消息哈希，用于增量上下文。
 *
 * 原因：在调试追踪时，我们希望看到每一轮新增了哪些信息，
 * 而不是整个对话历史（可能非常庞大）。通过追踪每个 Agent 上次报告的消息，
 * 我们可以计算并仅发送增量（自上次请求以来的新消息）。
 * 这里按 Agent（querySource）分别追踪，因为不同 Agent
 * （主线程、子 Agent、预热请求）拥有独立的对话上下文。
 */
const lastReportedMessageHash = new Map<string, string>()

/**
 * 在压缩后清除追踪状态。
 * 消息被替换后，旧的哈希值不再有效。
 */
export function clearBetaTracingState(): void {
  seenHashes.clear()
  lastReportedMessageHash.clear()
}

const MAX_CONTENT_SIZE = 60 * 1024 // 60KB（Honeycomb 限制为 64KB，留出安全余量）

/**
 * 检查是否启用了 Beta 详细追踪。
 * - 需要 ENABLE_BETA_TRACING_DETAILED=1 和 BETA_TRACING_ENDPOINT
 * - 对于外部用户，在 SDK/无头模式下启用，或通过
 *   tengu_trace_lantern GrowthBook 门控将组织列入白名单时启用
 */
export function isBetaTracingEnabled(): boolean {
  const baseEnabled =
    isEnvTruthy(process.env.ENABLE_BETA_TRACING_DETAILED) &&
    Boolean(process.env.BETA_TRACING_ENDPOINT)

  if (!baseEnabled) {
    return false
  }

  // 对于外部用户，在 SDK/无头模式下启用，或在组织被列入白名单时启用。
  // 门控从磁盘缓存读取，因此加入白名单后的首次运行返回 false；
  // 从第二次运行开始生效（与 enhanced_telemetry_beta 行为相同）。
  if (process.env.USER_TYPE !== 'ant') {
    return (
      getIsNonInteractiveSession() ||
      getFeatureValue_CACHED_MAY_BE_STALE('tengu_trace_lantern', false)
    )
  }

  return true
}

/**
 * 截断内容以适应 Honeycomb 的限制。
 */
export function truncateContent(
  content: string,
  maxSize: number = MAX_CONTENT_SIZE,
): { content: string; truncated: boolean } {
  if (content.length <= maxSize) {
    return { content, truncated: false }
  }

  return {
    content:
      content.slice(0, maxSize) +
      '\n\n[TRUNCATED - Content exceeds 60KB limit]',
    truncated: true,
  }
}

/**
 * 生成短哈希（SHA-256 的前 12 个十六进制字符）。
 */
function shortHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 12)
}

/**
 * 为系统提示词生成哈希。
 */
function hashSystemPrompt(systemPrompt: string): string {
  return `sp_${shortHash(systemPrompt)}`
}

/**
 * 根据消息内容生成消息哈希。
 */
function hashMessage(message: APIMessage): string {
  const content = jsonStringify(message.message.content)
  return `msg_${shortHash(content)}`
}

// 用于检测被 <system-reminder> 标签包裹的内容的正则表达式
const SYSTEM_REMINDER_REGEX =
  /^<system-reminder>\n?([\s\S]*?)\n?<\/system-reminder>$/

/**
 * 检查文本是否完全是一个系统提醒（被 <system-reminder> 标签包裹）。
 * 如果是则返回内部内容，否则返回 null。
 */
function extractSystemReminderContent(text: string): string | null {
  const match = text.trim().match(SYSTEM_REMINDER_REGEX)
  return match && match[1] ? match[1].trim() : null
}

/**
 * 消息格式化结果 - 将常规内容与系统提醒分离。
 */
interface FormattedMessages {
  contextParts: string[]
  systemReminders: string[]
}

/**
 * 为用户消息格式化为 new_context 显示，分离系统提醒。
 * 仅处理用户消息（助手消息在调用此函数之前已被过滤掉）。
 */
function formatMessagesForContext(messages: UserMessage[]): FormattedMessages {
  const contextParts: string[] = []
  const systemReminders: string[] = []

  for (const message of messages) {
    const content = message.message.content
    if (typeof content === 'string') {
      const reminderContent = extractSystemReminderContent(content)
      if (reminderContent) {
        systemReminders.push(reminderContent)
      } else {
        contextParts.push(`[USER]\n${content}`)
      }
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text') {
          const reminderContent = extractSystemReminderContent(block.text)
          if (reminderContent) {
            systemReminders.push(reminderContent)
          } else {
            contextParts.push(`[USER]\n${block.text}`)
          }
        } else if (block.type === 'tool_result') {
          const resultContent =
            typeof block.content === 'string'
              ? block.content
              : jsonStringify(block.content)
          // 工具结果也可能包含系统提醒（例如恶意软件警告）
          const reminderContent = extractSystemReminderContent(resultContent)
          if (reminderContent) {
            systemReminders.push(reminderContent)
          } else {
            contextParts.push(
              `[TOOL RESULT: ${block.tool_use_id}]\n${resultContent}`,
            )
          }
        }
      }
    }
  }

  return { contextParts, systemReminders }
}

export interface LLMRequestNewContext {
  /** 系统提示词（通常仅在首次请求或变更时包含） */
  systemPrompt?: string
  /** 标识 Agent/用途的查询来源（例如 'repl_main_thread'、'agent:builtin'） */
  querySource?: string
  /** 随请求发送的工具 Schema */
  tools?: string
}

/**
 * 为交互跨度添加 Beta 属性。
 * 添加包含用户提示词的 new_context。
 */
export function addBetaInteractionAttributes(
  span: Span,
  userPrompt: string,
): void {
  if (!isBetaTracingEnabled()) {
    return
  }

  const { content: truncatedPrompt, truncated } = truncateContent(
    `[USER PROMPT]\n${userPrompt}`,
  )
  span.setAttributes({
    new_context: truncatedPrompt,
    ...(truncated && {
      new_context_truncated: true,
      new_context_original_length: userPrompt.length,
    }),
  })
}

/**
 * 为 LLM 请求跨度添加 Beta 属性。
 * 处理系统提示词日志记录和 new_context 计算。
 */
export function addBetaLLMRequestAttributes(
  span: Span,
  newContext?: LLMRequestNewContext,
  messagesForAPI?: APIMessage[],
): void {
  if (!isBetaTracingEnabled()) {
    return
  }

  // 将系统提示词信息添加到跨度
  if (newContext?.systemPrompt) {
    const promptHash = hashSystemPrompt(newContext.systemPrompt)
    const preview = newContext.systemPrompt.slice(0, 500)

    // 始终将哈希、预览和长度添加到跨度
    span.setAttribute('system_prompt_hash', promptHash)
    span.setAttribute('system_prompt_preview', preview)
    span.setAttribute('system_prompt_length', newContext.systemPrompt.length)

    // 每个唯一哈希在本次会话中仅记录一次完整系统提示词
    if (!seenHashes.has(promptHash)) {
      seenHashes.add(promptHash)

      // 如需要则截断日志内容
      const { content: truncatedPrompt, truncated } = truncateContent(
        newContext.systemPrompt,
      )

      void logOTelEvent('system_prompt', {
        system_prompt_hash: promptHash,
        system_prompt: truncatedPrompt,
        system_prompt_length: String(newContext.systemPrompt.length),
        ...(truncated && { system_prompt_truncated: 'true' }),
      })
    }
  }

  // 将工具信息添加到跨度
  if (newContext?.tools) {
    try {
      const toolsArray = jsonParse(newContext.tools) as Record<
        string,
        unknown
      >[]

      // 为每个工具构建 {name, hash} 数组
      const toolsWithHashes = toolsArray.map(tool => {
        const toolJson = jsonStringify(tool)
        const toolHash = shortHash(toolJson)
        return {
          name: typeof tool.name === 'string' ? tool.name : 'unknown',
          hash: toolHash,
          json: toolJson,
        }
      })

      // 使用名称/哈希对数组设置跨度属性
      span.setAttribute(
        'tools',
        jsonStringify(
          toolsWithHashes.map(({ name, hash }) => ({ name, hash })),
        ),
      )
      span.setAttribute('tools_count', toolsWithHashes.length)

      // 每个唯一哈希仅记录一次工具的完整描述
      for (const { name, hash, json } of toolsWithHashes) {
        if (!seenHashes.has(`tool_${hash}`)) {
          seenHashes.add(`tool_${hash}`)

          const { content: truncatedTool, truncated } = truncateContent(json)

          void logOTelEvent('tool', {
            tool_name: sanitizeToolNameForAnalytics(name),
            tool_hash: hash,
            tool: truncatedTool,
            ...(truncated && { tool_truncated: 'true' }),
          })
        }
      }
    } catch {
      // 如果解析失败，记录原始工具字符串
      span.setAttribute('tools_parse_error', true)
    }
  }

  // 使用基于哈希的追踪添加 new_context（所有用户可见）
  if (messagesForAPI && messagesForAPI.length > 0 && newContext?.querySource) {
    const querySource = newContext.querySource
    const lastHash = lastReportedMessageHash.get(querySource)

    // 查找上次报告的消息在数组中的位置
    let startIndex = 0
    if (lastHash) {
      for (let i = 0; i < messagesForAPI.length; i++) {
        const msg = messagesForAPI[i]
        if (msg && hashMessage(msg) === lastHash) {
          startIndex = i + 1 // 从上次报告的消息之后开始
          break
        }
      }
      // 如果未找到 lastHash，startIndex 保持为 0（发送全部内容）
    }

    // 获取新消息（过滤掉助手消息 - 我们只需要用户输入/工具结果）
    const newMessages = messagesForAPI
      .slice(startIndex)
      .filter((m): m is UserMessage => m.type === 'user')

    if (newMessages.length > 0) {
      // 格式化新消息，将系统提醒与常规内容分离
      const { contextParts, systemReminders } =
        formatMessagesForContext(newMessages)

      // 设置 new_context（常规用户内容和工具结果）
      if (contextParts.length > 0) {
        const fullContext = contextParts.join('\n\n---\n\n')
        const { content: truncatedContext, truncated } =
          truncateContent(fullContext)

        span.setAttributes({
          new_context: truncatedContext,
          new_context_message_count: newMessages.length,
          ...(truncated && {
            new_context_truncated: true,
            new_context_original_length: fullContext.length,
          }),
        })
      }

      // 将系统提醒作为单独的属性设置
      if (systemReminders.length > 0) {
        const fullReminders = systemReminders.join('\n\n---\n\n')
        const { content: truncatedReminders, truncated: remindersTruncated } =
          truncateContent(fullReminders)

        span.setAttributes({
          system_reminders: truncatedReminders,
          system_reminders_count: systemReminders.length,
          ...(remindersTruncated && {
            system_reminders_truncated: true,
            system_reminders_original_length: fullReminders.length,
          }),
        })
      }

      // 将上次报告的哈希更新为数组中最后一条消息
      const lastMessage = messagesForAPI[messagesForAPI.length - 1]
      if (lastMessage) {
        lastReportedMessageHash.set(querySource, hashMessage(lastMessage))
      }
    }
  }
}

/**
 * 为 endLLMRequestSpan 添加 Beta 属性。
 * 处理 model_output 和 thinking_output 的截断。
 */
export function addBetaLLMResponseAttributes(
  endAttributes: Record<string, string | number | boolean>,
  metadata?: {
    modelOutput?: string
    thinkingOutput?: string
  },
): void {
  if (!isBetaTracingEnabled() || !metadata) {
    return
  }

  // 添加 model_output（文本内容）- 所有用户可见
  if (metadata.modelOutput !== undefined) {
    const { content: modelOutput, truncated: outputTruncated } =
      truncateContent(metadata.modelOutput)
    endAttributes['response.model_output'] = modelOutput
    if (outputTruncated) {
      endAttributes['response.model_output_truncated'] = true
      endAttributes['response.model_output_original_length'] =
        metadata.modelOutput.length
    }
  }

  // 添加 thinking_output - 仅限内部用户
  if (
    process.env.USER_TYPE === 'ant' &&
    metadata.thinkingOutput !== undefined
  ) {
    const { content: thinkingOutput, truncated: thinkingTruncated } =
      truncateContent(metadata.thinkingOutput)
    endAttributes['response.thinking_output'] = thinkingOutput
    if (thinkingTruncated) {
      endAttributes['response.thinking_output_truncated'] = true
      endAttributes['response.thinking_output_original_length'] =
        metadata.thinkingOutput.length
    }
  }
}

/**
 * 为 startToolSpan 添加 Beta 属性。
 * 添加包含序列化工具输入的 tool_input。
 */
export function addBetaToolInputAttributes(
  span: Span,
  toolName: string,
  toolInput: string,
): void {
  if (!isBetaTracingEnabled()) {
    return
  }

  const { content: truncatedInput, truncated } = truncateContent(
    `[TOOL INPUT: ${toolName}]\n${toolInput}`,
  )
  span.setAttributes({
    tool_input: truncatedInput,
    ...(truncated && {
      tool_input_truncated: true,
      tool_input_original_length: toolInput.length,
    }),
  })
}

/**
 * 为 endToolSpan 添加 Beta 属性。
 * 添加包含工具结果的 new_context。
 */
export function addBetaToolResultAttributes(
  endAttributes: Record<string, string | number | boolean>,
  toolName: string | number | boolean,
  toolResult: string,
): void {
  if (!isBetaTracingEnabled()) {
    return
  }

  const { content: truncatedResult, truncated } = truncateContent(
    `[TOOL RESULT: ${toolName}]\n${toolResult}`,
  )
  endAttributes['new_context'] = truncatedResult
  if (truncated) {
    endAttributes['new_context_truncated'] = true
    endAttributes['new_context_original_length'] = toolResult.length
  }
}
