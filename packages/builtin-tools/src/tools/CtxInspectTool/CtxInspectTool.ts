import { z } from 'zod/v4'
import type { ToolResultBlockParam } from 'src/Tool.js'
import { buildTool } from 'src/Tool.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { tokenCountWithEstimation } from 'src/utils/tokens.js'
import {
  getStats,
  isContextCollapseEnabled,
} from 'src/services/contextCollapse/index.js'
import { isSessionMemoryInitialized } from 'src/services/SessionMemory/sessionMemoryUtils.js'

const CTX_INSPECT_TOOL_NAME = 'CtxInspect'

const inputSchema = lazySchema(() =>
  z.strictObject({
    query: z
      .string()
      .optional()
      .describe(
        '可选的查询，用于过滤上下文条目。如果省略，返回所有上下文的摘要。',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type CtxInput = z.infer<InputSchema>

type CtxOutput = {
  total_tokens: number
  message_count: number
  context_window_model: string
  prompt_caching_enabled: boolean
  session_memory_enabled: boolean
  context_collapse_enabled: boolean
  summary: string
}

export const CtxInspectTool = buildTool({
  name: CTX_INSPECT_TOOL_NAME,
  searchHint: 'context inspect tokens usage messages window collapse',
  maxResultSizeChars: 50_000,
  strict: true,

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  async description() {
    return '检查当前上下文窗口内容和令牌使用情况'
  },
  async prompt() {
    return `检查当前的对话上下文。显示令牌使用量、消息数量以及占用上下文空间的内容明细。

在决定是否裁剪旧消息或调整你的方法之前，使用此工具了解你的上下文预算。`
  },

  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },

  userFacingName() {
    return 'CtxInspect'
  },

  renderToolUseMessage() {
    return 'Context Inspect'
  },

  mapToolResultToToolResultBlockParam(
    content: CtxOutput,
    toolUseID: string,
  ): ToolResultBlockParam {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `Context: ${content.total_tokens} tokens, ${content.message_count} messages\n${content.summary}`,
    }
  },

  async call(input: CtxInput, context) {
    const messages = context.messages ?? []
    const model = context.options?.mainLoopModel ?? 'unknown'
    const totalTokens = tokenCountWithEstimation(messages)
    const collapseEnabled = isContextCollapseEnabled()
    const collapseStats = getStats()
    const focused = input.query?.trim()

    const sessionMemoryEnabled = isSessionMemoryInitialized()
    // 提示缓存是由提供商控制的 API 级别功能，而不是
    // 面向用户的开关。仅对已知支持
    // Anthropic 风格提示缓存的提供商（第一方、Bedrock、Vertex）报告为已启用。
    const promptCachingEnabled =
      !model.startsWith('openai/') &&
      !model.startsWith('grok/') &&
      !model.startsWith('gemini/')

    const summaryParts = [
      focused ? `Focus: ${focused}` : 'Overall context summary',
      `Model context: ${model}`,
      `Prompt caching: ${promptCachingEnabled ? 'enabled' : 'disabled'}`,
      `Session memory: ${sessionMemoryEnabled ? 'enabled' : 'disabled'}`,
      `Context collapse: ${collapseEnabled ? 'enabled' : 'disabled'}`,
    ]

    if (collapseEnabled) {
      summaryParts.push(
        `Collapse spans: ${collapseStats.collapsedSpans} committed, ${collapseStats.stagedSpans} staged, ${collapseStats.collapsedMessages} messages summarized`,
      )
    }

    return {
      data: {
        total_tokens: totalTokens,
        message_count: messages.length,
        context_window_model: model,
        prompt_caching_enabled: promptCachingEnabled,
        session_memory_enabled: sessionMemoryEnabled,
        context_collapse_enabled: collapseEnabled,
        summary: summaryParts.join('\n'),
      },
    }
  },
})
