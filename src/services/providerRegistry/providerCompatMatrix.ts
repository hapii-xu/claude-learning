import type { CompatRule } from './types.js'

/**
 * 各 provider 的 OpenAI 兼容字段白名单。
 *
 * 每个 profile 描述了端点实际接受的字段，以便我们剔除
 * 会导致严格端点拒绝请求的字段。
 */
export interface CompatProfile {
  /**
   * 服务器是否在聊天补全中接受 stream_options.include_usage。
   * 严格端点（Cerebras、Qwen）会拒绝未知的顶层字段。
   */
  supportsStreamUsageOption: boolean

  /**
   * 服务器是否在消息中接受自定义的 'thinking' 字段。
   * 仅宽松或 DeepSeek 思考模式端点支持此字段。
   */
  supportsThinkingField: boolean

  /**
   * 在往返请求中如何处理 reasoning_content。
   *
   * DeepSeek 有三种模式：
   *   - thinking-only：    模型返回 reasoning_content，无工具调用
   *   - thinking+tools：   模型同时返回 reasoning_content 和工具调用
   *   - normal：           模型两者都不返回
   *
   * 'always-preserve':      回传（DeepSeek thinking+tools 往返场景）
   * 'drop-on-non-thinking': 非思考模型时删除
   * 'strip':                始终删除（严格端点的安全默认值）
   */
  reasoningContentEcho: 'always-preserve' | 'drop-on-non-thinking' | 'strip'

  /**
   * 端点支持的工具调用模式。
   * 'openai-v2' = 标准 OpenAI 函数调用模式
   */
  toolCallFormat: 'openai-v2'
}

export const COMPAT_PROFILES: Record<CompatRule, CompatProfile> = {
  cerebras: {
    supportsStreamUsageOption: false,
    supportsThinkingField: false,
    reasoningContentEcho: 'strip',
    toolCallFormat: 'openai-v2',
  },
  groq: {
    supportsStreamUsageOption: false,
    supportsThinkingField: false,
    reasoningContentEcho: 'strip',
    toolCallFormat: 'openai-v2',
  },
  deepseek: {
    // DeepSeek-reasoner 支持 reasoning_content 和 thinking 字段。
    // 对于普通 deepseek-chat，thinking 字段会被忽略而非拒绝。
    supportsStreamUsageOption: true,
    supportsThinkingField: true,
    reasoningContentEcho: 'always-preserve',
    toolCallFormat: 'openai-v2',
  },
  'strict-openai': {
    supportsStreamUsageOption: false,
    supportsThinkingField: false,
    reasoningContentEcho: 'strip',
    toolCallFormat: 'openai-v2',
  },
  permissive: {
    supportsStreamUsageOption: true,
    supportsThinkingField: true,
    reasoningContentEcho: 'drop-on-non-thinking',
    toolCallFormat: 'openai-v2',
  },
}

/**
 * 根据 assistant 消息中是否存在 reasoning_content 和 tool_calls
 * 来确定 DeepSeek 推理模式。
 *
 * DeepSeek thinking-only：有 reasoning_content，无 tool_calls
 * DeepSeek thinking+tools：同时有 reasoning_content 和 tool_calls
 * DeepSeek normal：无 reasoning_content
 */
export function getDeepSeekReasoningMode(
  assistantMessage: Record<string, unknown>,
): 'thinking-only' | 'thinking+tools' | 'normal' {
  const hasReasoning = Boolean(assistantMessage['reasoning_content'])
  const toolCalls = assistantMessage['tool_calls']
  const hasTools = Array.isArray(toolCalls) && toolCalls.length > 0

  if (hasReasoning && hasTools) return 'thinking+tools'
  if (hasReasoning) return 'thinking-only'
  return 'normal'
}

/**
 * 将兼容规则应用于出站请求体，删除目标端点不接受的字段。
 * 返回新对象（不可变）。
 *
 * 这是纯函数：不修改输入的请求体。
 */
export function applyCompatRule(
  body: Record<string, unknown>,
  rule: CompatRule,
): Record<string, unknown> {
  const profile = COMPAT_PROFILES[rule]
  const result: Record<string, unknown> = { ...body }

  // 若端点不支持，则删除 stream_options.include_usage
  if (!profile.supportsStreamUsageOption) {
    const streamOptions = result['stream_options']
    if (
      streamOptions !== null &&
      typeof streamOptions === 'object' &&
      !Array.isArray(streamOptions)
    ) {
      const { include_usage: _dropped, ...rest } = streamOptions as Record<
        string,
        unknown
      >
      if (Object.keys(rest).length === 0) {
        delete result['stream_options']
      } else {
        result['stream_options'] = rest
      }
    }
  }

  // 若端点不支持，则从消息中删除 'thinking' 字段
  if (!profile.supportsThinkingField && Array.isArray(result['messages'])) {
    result['messages'] = (result['messages'] as Record<string, unknown>[]).map(
      msg => {
        if ('thinking' in msg) {
          const { thinking: _dropped, ...rest } = msg
          return rest
        }
        return msg
      },
    )
  }

  // 处理 reasoning_content 回传策略
  if (
    profile.reasoningContentEcho === 'strip' &&
    Array.isArray(result['messages'])
  ) {
    result['messages'] = (result['messages'] as Record<string, unknown>[]).map(
      msg => {
        if ('reasoning_content' in msg) {
          const { reasoning_content: _dropped, ...rest } = msg
          return rest
        }
        return msg
      },
    )
  }

  // 对于 'drop-on-non-thinking'：除非模型名称中包含 'reason' 或 'think'（表示思考模型变体），
  // 否则删除 reasoning_content
  if (profile.reasoningContentEcho === 'drop-on-non-thinking') {
    const model = typeof result['model'] === 'string' ? result['model'] : ''
    const isThinkingModel = /reason|think/i.test(model)
    if (!isThinkingModel && Array.isArray(result['messages'])) {
      result['messages'] = (
        result['messages'] as Record<string, unknown>[]
      ).map(msg => {
        if ('reasoning_content' in msg) {
          const { reasoning_content: _dropped, ...rest } = msg
          return rest
        }
        return msg
      })
    }
  }

  return result
}
