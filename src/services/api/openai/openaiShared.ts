/**
 * OpenAI 兼容 API 路径的共享工具函数。
 *
 * OpenAI 路径（queryModelOpenAI）和 Grok 路径（queryModelGrok）使用
 * 相同的适配器（openaiStreamAdapter、openaiConvertMessages），因此事件
 * 处理逻辑应当共享而不是重复实现。
 */

/**
 * 把 delta usage 合并进累积 usage：当 delta 携带显式零值或 undefined 时，
 * 保留之前值中与 cache 相关的字段。
 *
 * 镜像 claude.ts 中的 updateUsage()：未来如果适配器变化导致某些流式
 * 事件省略 cache 字段，不应静默地将累积计数清零。
 */
export function updateOpenAIUsage(
  current: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  },
  delta: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  },
): typeof current {
  return {
    input_tokens: delta.input_tokens ?? current.input_tokens,
    output_tokens: delta.output_tokens ?? current.output_tokens,
    cache_creation_input_tokens:
      delta.cache_creation_input_tokens !== undefined &&
      delta.cache_creation_input_tokens > 0
        ? delta.cache_creation_input_tokens
        : current.cache_creation_input_tokens,
    cache_read_input_tokens:
      delta.cache_read_input_tokens !== undefined &&
      delta.cache_read_input_tokens > 0
        ? delta.cache_read_input_tokens
        : current.cache_read_input_tokens,
  }
}
