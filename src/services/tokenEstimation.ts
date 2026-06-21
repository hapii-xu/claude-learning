import type { Anthropic } from '@anthropic-ai/sdk'
import type { BetaMessageParam as MessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
// @aws-sdk/client-bedrock-runtime is imported dynamically in countTokensWithBedrock()
// to defer ~279KB of AWS SDK code until a Bedrock call is actually made
import type { CountTokensCommandInput } from '@aws-sdk/client-bedrock-runtime'
import { getAPIProvider } from 'src/utils/model/providers.js'
import { VERTEX_COUNT_TOKENS_ALLOWED_BETAS } from '../constants/betas.js'
import type { Attachment } from '../utils/attachments.js'
import { getModelBetas } from '../utils/betas.js'
import { getVertexRegionForModel, isEnvTruthy } from '../utils/envUtils.js'
import { logError } from '../utils/log.js'
import { normalizeAttachmentForAPI } from '../utils/messages.js'
import {
  createBedrockRuntimeClient,
  getInferenceProfileBackingModel,
  isFoundationModel,
} from '../utils/model/bedrock.js'
import {
  getDefaultSonnetModel,
  getMainLoopModel,
  getSmallFastModel,
  normalizeModelStringForAPI,
} from '../utils/model/model.js'
import { jsonStringify } from '../utils/slowOperations.js'
import { isToolReferenceBlock } from '../utils/searchExtraTools.js'
import { getAPIMetadata, getExtraBodyParams } from './api/claude.js'
import { getAnthropicClient } from './api/client.js'
import {
  createTrace,
  endTrace,
  isLangfuseEnabled,
  recordLLMObservation,
} from './langfuse/index.js'
import { getSessionId } from '../bootstrap/state.js'
import { withTokenCountVCR } from './vcr.js'

// 启用 thinking 时用于 token 计数的最小值
// API 约束：max_tokens 必须大于 thinking.budget_tokens
const TOKEN_COUNT_THINKING_BUDGET = 1024
const TOKEN_COUNT_MAX_TOKENS = 2048

/**
 * 检查消息是否包含 thinking 块
 */
function hasThinkingBlocks(
  messages: Anthropic.Beta.Messages.BetaMessageParam[],
): boolean {
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (
          typeof block === 'object' &&
          block !== null &&
          'type' in block &&
          (block.type === 'thinking' || block.type === 'redacted_thinking')
        ) {
          return true
        }
      }
    }
  }
  return false
}

/**
 * 在发送进行 token 计数前从消息中移除工具搜索特有字段。
 * 这会从 tool_use 块中移除 'caller'，从 tool_result 内容中移除 'tool_reference'。
 * 这些字段仅在工具搜索 beta 下有效，否则会导致错误。
 *
 * 注意：我们使用 'as unknown as' 转换，因为 SDK 类型不包含工具搜索 beta 字段，
 * 但在运行时，当工具搜索被启用时，这些字段可能从 API 响应中存在。
 */
function stripSearchExtraToolsFieldsFromMessages(
  messages: Anthropic.Beta.Messages.BetaMessageParam[],
): Anthropic.Beta.Messages.BetaMessageParam[] {
  return messages.map(message => {
    if (!Array.isArray(message.content)) {
      return message
    }

    const normalizedContent = message.content.map(block => {
      // 从 tool_use 块（assistant 消息）中移除 'caller'
      if (block.type === 'tool_use') {
        // 解构以排除任何额外字段如 'caller'
        const toolUse =
          block as Anthropic.Beta.Messages.BetaToolUseBlockParam & {
            caller?: unknown
          }
        return {
          type: 'tool_use' as const,
          id: toolUse.id,
          name: toolUse.name,
          input: toolUse.input,
        }
      }

      // 从 tool_result 内容（user 消息）中移除 tool_reference 块
      if (block.type === 'tool_result') {
        const toolResult =
          block as Anthropic.Beta.Messages.BetaToolResultBlockParam
        if (Array.isArray(toolResult.content)) {
          const filteredContent = (toolResult.content as unknown[]).filter(
            c => !isToolReferenceBlock(c),
          ) as typeof toolResult.content

          if (filteredContent.length === 0) {
            return {
              ...toolResult,
              content: [{ type: 'text' as const, text: '[tool references]' }],
            }
          }
          if (filteredContent.length !== toolResult.content.length) {
            return {
              ...toolResult,
              content: filteredContent,
            }
          }
        }
      }

      return block
    })

    return {
      ...message,
      content: normalizedContent,
    }
  })
}

export async function countTokensWithAPI(
  content: string,
): Promise<number | null> {
  // 空内容的特殊情况 —— API 不接受空消息
  if (!content) {
    return 0
  }

  const message: Anthropic.Beta.Messages.BetaMessageParam = {
    role: 'user',
    content: content,
  }

  return countMessagesTokensWithAPI([message], [])
}

export async function countMessagesTokensWithAPI(
  messages: Anthropic.Beta.Messages.BetaMessageParam[],
  tools: Anthropic.Beta.Messages.BetaToolUnion[],
): Promise<number | null> {
  return withTokenCountVCR(messages, tools, async () => {
    try {
      const provider = getAPIProvider()
      if (provider === 'gemini') {
        return roughTokenCountEstimationForAPIRequest(messages, tools)
      }

      const model = getMainLoopModel()
      const betas = getModelBetas(model)
      const containsThinking = hasThinkingBlocks(messages)

      if (provider === 'bedrock') {
        // @anthropic-sdk/bedrock-sdk 目前不支持 countTokens
        return countTokensWithBedrock({
          model: normalizeModelStringForAPI(model),
          messages,
          tools,
          betas,
          containsThinking,
        })
      }

      const anthropic = await getAnthropicClient({
        maxRetries: 1,
        model,
        source: 'count_tokens',
      })

      const filteredBetas =
        getAPIProvider() === 'vertex'
          ? betas.filter(b => VERTEX_COUNT_TOKENS_ALLOWED_BETAS.has(b))
          : betas

      const response = await anthropic.beta.messages.countTokens({
        model: normalizeModelStringForAPI(model),
        messages:
          // When we pass tools and no messages, we need to pass a dummy message
          // to get an accurate tool token count.
          messages.length > 0 ? messages : [{ role: 'user', content: 'foo' }],
        tools,
        ...(filteredBetas.length > 0 && { betas: filteredBetas }),
        // Enable thinking if messages contain thinking blocks
        ...(containsThinking && {
          thinking: {
            type: 'enabled',
            budget_tokens: TOKEN_COUNT_THINKING_BUDGET,
          },
        }),
      })

      if (typeof response.input_tokens !== 'number') {
        // Vertex 客户端抛出异常
        // Bedrock 客户端返回成功但带有 { Output: { __type: 'com.amazon.coral.service#UnknownOperationException' }, Version: '1.0' }
        return null
      }

      return response.input_tokens
    } catch (error) {
      logError(error)
      return null
    }
  })
}

export function roughTokenCountEstimation(
  content: string,
  bytesPerToken: number = 4,
): number {
  return Math.round(content.length / bytesPerToken)
}

/**
 * 返回给定文件扩展名的估计字节/Token 比率。
 * 密集的 JSON 有许多单字符 token（`{`、`}`、`:`、`,`、`"`），
 * 这使得实际比率接近 2 而非默认的 4。
 */
export function bytesPerTokenForFileType(fileExtension: string): number {
  switch (fileExtension) {
    case 'json':
    case 'jsonl':
    case 'jsonc':
      return 2
    default:
      return 4
  }
}

/**
 * 类似于 {@link roughTokenCountEstimation}，但在文件类型已知时使用更准确的
 * 字节/Token 比率。
 *
 * 这在基于 API 的 token 计数不可用时（例如在 Bedrock 上）很重要，
 * 我们会回退到粗略估计 —— 低估可能让过大的工具结果混入对话。
 */
export function roughTokenCountEstimationForFileType(
  content: string,
  fileExtension: string,
): number {
  return roughTokenCountEstimation(
    content,
    bytesPerTokenForFileType(fileExtension),
  )
}

/**
 * 通过提取和分析文本内容来估算 Message 对象的 token 计数。
 * 对于可能已被压缩的消息，这提供了比 getTokenUsage 更可靠的估计。
 * 使用 Haiku 进行 token 计数（Haiku 4.5 支持 thinking 块），除了：
 * - Vertex 全局区域：使用 Sonnet（Haiku 不可用）
 * - 带 thinking 块的 Bedrock：使用 Sonnet（Haiku 3.5 不支持 thinking）
 */
export async function countTokensViaHaikuFallback(
  messages: Anthropic.Beta.Messages.BetaMessageParam[],
  tools: Anthropic.Beta.Messages.BetaToolUnion[],
): Promise<number | null> {
  const provider = getAPIProvider()
  if (provider === 'gemini') {
    return roughTokenCountEstimationForAPIRequest(messages, tools)
  }

  // 检查消息是否包含 thinking 块
  const containsThinking = hasThinkingBlocks(messages)

  // 如果我们在 Vertex 上使用全局区域，始终使用 Sonnet，因为 Haiku 在那里不可用。
  const isVertexGlobalEndpoint =
    isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) &&
    getVertexRegionForModel(getSmallFastModel()) === 'global'
  // 如果我们在带 thinking 块的 Bedrock 上，使用 Sonnet，因为 Haiku 3.5 不支持 thinking
  const isBedrockWithThinking =
    isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) && containsThinking
  // 如果我们在带 thinking 块的 Vertex 上，使用 Sonnet，因为 Haiku 3.5 不支持 thinking
  const isVertexWithThinking =
    isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) && containsThinking
  // 否则始终使用 Haiku —— Haiku 4.5 支持 thinking 块。
  // 警告：如果将其更改为使用非 Haiku 模型，此请求在 1P 中会失败，除非使用 getCLISyspromptPrefix。
  // 注意：我们不需要为 tool_reference 块使用 Sonnet，因为我们在发送前通过
  // stripSearchExtraToolsFieldsFromMessages() 移除了它们。
  // 使用 getSmallFastModel() 以尊重 Bedrock 用户的 ANTHROPIC_SMALL_FAST_MODEL 环境变量，
  // 用于全局推理配置文件（见 issue #10883）。
  const model =
    isVertexGlobalEndpoint || isBedrockWithThinking || isVertexWithThinking
      ? getDefaultSonnetModel()
      : getSmallFastModel()
  const anthropic = await getAnthropicClient({
    maxRetries: 1,
    model,
    source: 'count_tokens',
  })

  // 在发送前移除工具搜索特有字段（caller、tool_reference）
  // 这些字段仅在工具搜索 beta header 下有效
  const normalizedMessages = stripSearchExtraToolsFieldsFromMessages(messages)

  const messagesToSend: MessageParam[] =
    normalizedMessages.length > 0
      ? (normalizedMessages as MessageParam[])
      : [{ role: 'user', content: 'count' }]

  const betas = getModelBetas(model)
  // 为 Vertex 过滤 beta —— 某些 beta（如 web-search）在某些
  // Vertex 端点上会导致 400 错误。见 issue #10789。
  const filteredBetas =
    getAPIProvider() === 'vertex'
      ? betas.filter(b => VERTEX_COUNT_TOKENS_ALLOWED_BETAS.has(b))
      : betas

  const apiStart = Date.now()
  const langfuseTrace = isLangfuseEnabled()
    ? createTrace({
        sessionId: getSessionId(),
        model: normalizeModelStringForAPI(model),
        provider: getAPIProvider(),
        name: 'token-estimation',
      })
    : null
  const response = await anthropic.beta.messages.create({
    model: normalizeModelStringForAPI(model),
    max_tokens: containsThinking ? TOKEN_COUNT_MAX_TOKENS : 1,
    messages: messagesToSend,
    tools: tools.length > 0 ? tools : undefined,
    ...(filteredBetas.length > 0 && { betas: filteredBetas }),
    metadata: getAPIMetadata(),
    ...getExtraBodyParams(),
    // 如果消息包含 thinking 块，启用 thinking
    ...(containsThinking && {
      thinking: {
        type: 'enabled',
        budget_tokens: TOKEN_COUNT_THINKING_BUDGET,
      },
    }),
  })

  const usage = response.usage
  const inputTokens = usage.input_tokens
  const cacheCreationTokens = usage.cache_creation_input_tokens || 0
  const cacheReadTokens = usage.cache_read_input_tokens || 0

  recordLLMObservation(langfuseTrace, {
    model: normalizeModelStringForAPI(model),
    provider: getAPIProvider(),
    input: messagesToSend,
    output: response.content,
    usage: {
      input_tokens: inputTokens,
      output_tokens: usage.output_tokens,
      cache_creation_input_tokens: cacheCreationTokens || undefined,
      cache_read_input_tokens: cacheReadTokens || undefined,
    },
    startTime: new Date(apiStart),
    endTime: new Date(),
    ...(containsThinking && {
      thinking: { type: 'enabled', budgetTokens: TOKEN_COUNT_THINKING_BUDGET },
    }),
  })
  endTrace(langfuseTrace)

  return inputTokens + cacheCreationTokens + cacheReadTokens
}

export function roughTokenCountEstimationForMessages(
  messages: readonly {
    type: string
    message?: { content?: unknown }
    attachment?: Attachment
  }[],
): number {
  let totalTokens = 0
  for (const message of messages) {
    totalTokens += roughTokenCountEstimationForMessage(message)
  }
  return totalTokens
}

export function roughTokenCountEstimationForMessage(message: {
  type: string
  message?: { content?: unknown }
  attachment?: Attachment
}): number {
  if (
    (message.type === 'assistant' || message.type === 'user') &&
    message.message?.content
  ) {
    return roughTokenCountEstimationForContent(
      message.message?.content as
        | string
        | Array<Anthropic.ContentBlock>
        | Array<Anthropic.ContentBlockParam>
        | undefined,
    )
  }

  if (message.type === 'attachment' && message.attachment) {
    const userMessages = normalizeAttachmentForAPI(message.attachment)
    let total = 0
    for (const userMsg of userMessages) {
      total += roughTokenCountEstimationForContent(userMsg.message.content)
    }
    return total
  }

  return 0
}

function roughTokenCountEstimationForContent(
  content:
    | string
    | Array<Anthropic.ContentBlock>
    | Array<Anthropic.ContentBlockParam>
    | undefined,
): number {
  if (!content) {
    return 0
  }
  if (typeof content === 'string') {
    return roughTokenCountEstimation(content)
  }
  let totalTokens = 0
  for (const block of content) {
    totalTokens += roughTokenCountEstimationForBlock(block)
  }
  return totalTokens
}

function roughTokenCountEstimationForAPIRequest(
  messages: Anthropic.Beta.Messages.BetaMessageParam[],
  tools: Anthropic.Beta.Messages.BetaToolUnion[],
): number {
  let totalTokens = 0

  for (const message of messages) {
    totalTokens += roughTokenCountEstimationForContent(
      message.content as
        | string
        | Array<Anthropic.ContentBlock>
        | Array<Anthropic.ContentBlockParam>
        | undefined,
    )
  }

  if (tools.length > 0) {
    totalTokens += roughTokenCountEstimation(jsonStringify(tools))
  }

  return totalTokens
}

function roughTokenCountEstimationForBlock(
  block: string | Anthropic.ContentBlock | Anthropic.ContentBlockParam,
): number {
  if (typeof block === 'string') {
    return roughTokenCountEstimation(block)
  }
  if (block.type === 'text') {
    return roughTokenCountEstimation(block.text)
  }
  if (block.type === 'image' || block.type === 'document') {
    // https://platform.claude.com/docs/en/build-with-claude/vision#calculate-image-costs
    // tokens = (宽像素 * 高像素)/750
    // 图片被调整为最大 2000x2000（5333 tokens）。使用与
    // microCompact 的 IMAGE_MAX_TOKEN_SIZE 匹配的保守估计，避免
    // 低估并过晚触发自动压缩。
    //
    // document: source.data 中的 base64 PDF。绝对不能进入
    // jsonStringify 的兜底逻辑 —— 1MB 的 PDF 约 1.33M 个 base64 字符 →
    // 约 325k 估算 tokens，而 API 实际只收取约 2000。
    // 与 microCompact 的 calculateToolResultTokens 使用相同常量。
    return 2000
  }
  if (block.type === 'tool_result') {
    return roughTokenCountEstimationForContent(block.content as any)
  }
  if (block.type === 'tool_use') {
    // input 是模型生成的 JSON —— 任意大小（bash
    // 命令、Edit diff、文件内容）。为字符计数 stringify 一次；
    // API 反正会重新序列化，所以这就是它看到的。
    return roughTokenCountEstimation(
      block.name + jsonStringify(block.input ?? {}),
    )
  }
  if (block.type === 'thinking') {
    return roughTokenCountEstimation(block.thinking)
  }
  if (block.type === 'redacted_thinking') {
    return roughTokenCountEstimation(block.data)
  }
  // server_tool_use、web_search_tool_result、mcp_tool_use 等 ——
  // 类文本载荷（工具输入、搜索结果，无 base64）。
  // Stringify 长度跟踪 API 看到的序列化形式；
  // key/括号开销在实际块上是个位数百分比。
  return roughTokenCountEstimation(jsonStringify(block))
}

async function countTokensWithBedrock({
  model,
  messages,
  tools,
  betas,
  containsThinking,
}: {
  model: string
  messages: Anthropic.Beta.Messages.BetaMessageParam[]
  tools: Anthropic.Beta.Messages.BetaToolUnion[]
  betas: string[]
  containsThinking: boolean
}): Promise<number | null> {
  try {
    const client = await createBedrockRuntimeClient()
    // Bedrock CountTokens 需要模型 ID，而不是推理配置文件 / ARN
    const modelId = isFoundationModel(model)
      ? model
      : await getInferenceProfileBackingModel(model)
    if (!modelId) {
      return null
    }

    const requestBody = {
      anthropic_version: 'bedrock-2023-05-31',
      // 当我们传入工具但没有消息时，需要传入一个 dummy 消息
      // 以获得准确的工具 token 计数。
      messages:
        messages.length > 0 ? messages : [{ role: 'user', content: 'foo' }],
      max_tokens: containsThinking ? TOKEN_COUNT_MAX_TOKENS : 1,
      ...(tools.length > 0 && { tools }),
      ...(betas.length > 0 && { anthropic_beta: betas }),
      ...(containsThinking && {
        thinking: {
          type: 'enabled',
          budget_tokens: TOKEN_COUNT_THINKING_BUDGET,
        },
      }),
    }

    const { CountTokensCommand } = await import(
      '@aws-sdk/client-bedrock-runtime'
    )
    const input: CountTokensCommandInput = {
      modelId,
      input: {
        invokeModel: {
          body: new TextEncoder().encode(jsonStringify(requestBody)),
        },
      },
    }
    const response = await client.send(new CountTokensCommand(input))
    const tokenCount = response.inputTokens ?? null
    return tokenCount
  } catch (error) {
    logError(error)
    return null
  }
}
