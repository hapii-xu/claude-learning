/**
 * 纯工具函数，用于构建 OpenAI 请求体与检测 thinking 模式。
 * 从 index.ts 中提取出来，以便测试可直接导入而不会触发
 * 重量级模块副作用（OpenAI 客户端、流适配器等）。
 */
import type { ChatCompletionCreateParamsStreaming } from 'openai/resources/chat/completions/completions.mjs'
import { isEnvTruthy, isEnvDefinedFalsy } from '../../../utils/envUtils.js'

/**
 * 检测当前模型是否应启用 thinking 模式。
 *
 * 启用条件：
 * 1. 设置了 OPENAI_ENABLE_THINKING=1（显式启用），或
 * 2. 模型名包含 "deepseek" 或 "mimo"（自动检测，不区分大小写）
 *
 * 禁用条件：
 * - 显式设置了 OPENAI_ENABLE_THINKING=0/false/no/off（覆盖模型检测）
 *
 * @param model - 已解析的 OpenAI 模型名
 */
export function isOpenAIThinkingEnabled(model: string): boolean {
  // 显式禁用优先级最高（覆盖模型自动检测）
  if (isEnvDefinedFalsy(process.env.OPENAI_ENABLE_THINKING)) return false
  // 显式启用
  if (isEnvTruthy(process.env.OPENAI_ENABLE_THINKING)) return true
  // 根据模型名自动检测（DeepSeek 与 MiMo 模型支持 thinking 模式）。
  // Grok 被有意排除 —— Grok 推理模型会自动推理，
  // 不需要在请求体中传入 thinking/enable_thinking 参数。
  const modelLower = model.toLowerCase()
  return modelLower.includes('deepseek') || modelLower.includes('mimo')
}

/**
 * 解析 OpenAI 兼容路径的最大输出 token 数。
 *
 * 覆盖优先级：
 * 1. maxOutputTokensOverride（程序化，来自查询管线）
 * 2. OPENAI_MAX_TOKENS 环境变量（OpenAI 专用，适用于小上下文窗口的本地模型，
 *    如 RTX 3060 12GB 运行 65536-token 模型）
 * 3. CLAUDE_CODE_MAX_OUTPUT_TOKENS 环境变量（通用覆盖）
 * 4. upperLimit 默认值（64000）
 */
export function resolveOpenAIMaxTokens(
  upperLimit: number,
  maxOutputTokensOverride?: number,
): number {
  return (
    maxOutputTokensOverride ??
    (process.env.OPENAI_MAX_TOKENS
      ? parseInt(process.env.OPENAI_MAX_TOKENS, 10) || undefined
      : undefined) ??
    (process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
      ? parseInt(process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, 10) || undefined
      : undefined) ??
    upperLimit
  )
}

/**
 * 构建 OpenAI chat.completions.create() 的请求体。
 * 提取出来以便测试 —— thinking 模式参数在此注入。
 *
 * 同时发送三种 thinking-mode 格式；各端点使用其能识别的格式并忽略其他：
 * - 官方 DeepSeek API：   `thinking: { type: 'enabled' }`
 * - 自部署 DeepSeek：     `enable_thinking: true` + `chat_template_kwargs: { thinking: true }`
 * - MiMo（小米）：        `chat_template_kwargs: { enable_thinking: true }`
 * OpenAI SDK 会将未知键透传到 HTTP body。
 */
export function buildOpenAIRequestBody(params: {
  model: string
  messages: any[]
  tools: any[]
  toolChoice: any
  enableThinking: boolean
  maxTokens: number
  temperatureOverride?: number
}): ChatCompletionCreateParamsStreaming & {
  thinking?: { type: string }
  enable_thinking?: boolean
  chat_template_kwargs?: { thinking: boolean; enable_thinking: boolean }
} {
  const {
    model,
    messages,
    tools,
    toolChoice,
    enableThinking,
    maxTokens,
    temperatureOverride,
  } = params
  return {
    model,
    messages,
    max_tokens: maxTokens,
    ...(tools.length > 0 && {
      tools,
      ...(toolChoice && { tool_choice: toolChoice }),
    }),
    stream: true,
    stream_options: { include_usage: true },
    // 为 DeepSeek 与 MiMo 模型启用思维链输出。
    // 启用后 temperature/top_p/presence_penalty/frequency_penalty 会被忽略。
    ...(enableThinking && {
      // 官方 DeepSeek API 格式
      thinking: { type: 'enabled' },
      // 自部署 DeepSeek-V3.2 格式
      enable_thinking: true,
      // DeepSeek 自部署与 MiMo 共用的 chat_template_kwargs 格式
      chat_template_kwargs: { thinking: true, enable_thinking: true },
    }),
    // 仅在 thinking 模式关闭时发送 temperature（DeepSeek 反正会忽略，
    // 但其他 provider 可能会尊重该参数）
    ...(!enableThinking &&
      temperatureOverride !== undefined && {
        temperature: temperatureOverride,
      }),
  }
}
