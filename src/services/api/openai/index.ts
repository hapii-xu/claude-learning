import type {
  BetaToolUnion,
  BetaMessage,
  BetaUsage,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { SystemPrompt } from '../../../utils/systemPromptType.js'
import type {
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
  AssistantMessage,
  UserMessage,
} from '../../../types/message.js'
import type { AgentId } from '../../../types/ids.js'
import type { Tools } from '../../../Tool.js'
import { getOpenAIClient } from './client.js'
import { updateOpenAIUsage } from './openaiShared.js'
import {
  anthropicMessagesToOpenAI,
  resolveOpenAIModel,
  adaptOpenAIStreamToAnthropic,
  anthropicToolsToOpenAI,
  anthropicToolChoiceToOpenAI,
} from '@ant/model-provider'
import { isChatGPTAuthEnabled } from './chatgptAuth.js'
import {
  adaptResponsesStreamToAnthropic,
  buildResponsesRequest,
  createChatGPTResponsesStream,
  type ResponsesReasoningEffort,
} from './responsesAdapter.js'
import { normalizeMessagesForAPI } from '../../../utils/messages.js'
import { toolToAPISchema } from '../../../utils/api.js'
import {
  getEmptyToolPermissionContext,
  toolMatchesName,
} from '../../../Tool.js'
import { logForDebugging } from '../../../utils/debug.js'
import { addToTotalSessionCost } from '../../../cost-tracker.js'
import { calculateUSDCost } from '../../../utils/modelCost.js'
import {
  isOpenAIThinkingEnabled,
  resolveOpenAIMaxTokens,
  buildOpenAIRequestBody,
} from './requestBody.js'
import { recordLLMObservation } from '../../../services/langfuse/tracing.js'
import {
  convertMessagesToLangfuse,
  convertOutputToLangfuse,
  convertToolsToLangfuse,
} from '../../../services/langfuse/convert.js'
export {
  isOpenAIThinkingEnabled,
  resolveOpenAIMaxTokens,
  buildOpenAIRequestBody,
}
import { getModelMaxOutputTokens } from '../../../utils/context.js'
import type { Options } from '../claude.js'
import { randomUUID } from 'crypto'
import {
  createAssistantAPIErrorMessage,
  createUserMessage,
  normalizeContentFromAPI,
} from '../../../utils/messages.js'
import type { SDKAssistantMessageError } from '../../../entrypoints/agentSdkTypes.js'
import {
  isSearchExtraToolsEnabled,
  isDeferredToolsDeltaEnabled,
} from '../../../utils/searchExtraTools.js'
import {
  formatDeferredToolLine,
  isDeferredTool,
  SEARCH_EXTRA_TOOLS_TOOL_NAME,
} from '@claude-code-best/builtin-tools/tools/SearchExtraToolsTool/prompt.js'

function convertToResponsesReasoningEffort(
  effortValue: unknown,
): ResponsesReasoningEffort | undefined {
  if (effortValue === 'low') return 'low'
  if (effortValue === 'medium') return 'medium'
  if (effortValue === 'high') return 'high'
  if (effortValue === 'xhigh' || effortValue === 'max') return 'xhigh'
  if (typeof effortValue === 'number') return 'high'
  return undefined
}

function getChatGPTResponsesReasoningEffort(
  effortValue: unknown,
): ResponsesReasoningEffort | undefined {
  const envOverride = process.env.CLAUDE_CODE_EFFORT_LEVEL?.toLowerCase()
  if (envOverride === 'auto' || envOverride === 'unset') return undefined
  return (
    convertToResponsesReasoningEffort(envOverride) ??
    convertToResponsesReasoningEffort(effortValue) ??
    'medium'
  )
}

/**
 * 镜像 Anthropic 请求路径的 deferred-tool 公告，供 OpenAI 使用。
 *
 * OpenAI 兼容端点无法直接消费 Anthropic 的 `defer_loading` 或
 * `tool_reference` beta payload，因此模型需要与 Anthropic 接收到
 * 相同的延迟 MCP 工具名文本列表，然后才能调用 SearchExtraToolsTool
 * 加载其完整 schema。
 */
function prependDeferredToolListIfNeeded(
  messages: (AssistantMessage | UserMessage)[],
  tools: Tools,
  deferredToolNames: Set<string>,
  useSearchExtraTools: boolean,
): (AssistantMessage | UserMessage)[] {
  if (!useSearchExtraTools || isDeferredToolsDeltaEnabled()) return messages

  const deferredToolList = tools
    .filter(tool => deferredToolNames.has(tool.name))
    .map(formatDeferredToolLine)
    .sort()
    .join('\n')

  if (!deferredToolList) return messages

  return [
    createUserMessage({
      content: `<available-deferred-tools>\n${deferredToolList}\n</available-deferred-tools>`,
      isMeta: true,
    }),
    ...messages,
  ]
}

function isOpenAIConvertibleMessage(
  msg: Message,
): msg is AssistantMessage | UserMessage {
  return msg.type === 'assistant' || msg.type === 'user'
}

/**
 * 从累积的流状态组装最终的 AssistantMessage（以及可选的 max_tokens 错误）。
 * 提取出来以避免 `message_stop` 处理函数与循环后的兜底逻辑重复实现。
 */
function assembleFinalAssistantOutputs(params: {
  partialMessage: BetaMessage | null
  contentBlocks: Record<number, Record<string, unknown>>
  tools: Tools
  agentId: string | undefined
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  }
  stopReason: string | null
  maxTokens: number
}): (AssistantMessage | SystemAPIErrorMessage)[] {
  const {
    partialMessage,
    contentBlocks,
    tools,
    agentId,
    usage,
    stopReason,
    maxTokens,
  } = params
  const outputs: (AssistantMessage | SystemAPIErrorMessage)[] = []

  const allBlocks = Object.keys(contentBlocks)
    .sort((a, b) => Number(a) - Number(b))
    .map(k => contentBlocks[Number(k)])
    .filter(Boolean)

  if (allBlocks.length > 0 && partialMessage) {
    outputs.push({
      message: {
        ...partialMessage,
        content: normalizeContentFromAPI(
          allBlocks as unknown as BetaMessage['content'],
          tools,
          agentId as AgentId | undefined,
        ),
        usage,
        stop_reason: stopReason,
        stop_sequence: null,
      } as AssistantMessage['message'],
      requestId: undefined,
      type: 'assistant',
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
    } as AssistantMessage)
  }

  if (stopReason === 'max_tokens') {
    outputs.push(
      createAssistantAPIErrorMessage({
        content:
          `Output truncated: response exceeded the ${maxTokens} token limit. ` +
          `Set OPENAI_MAX_TOKENS or CLAUDE_CODE_MAX_OUTPUT_TOKENS to override.`,
        apiError: 'max_output_tokens',
        error: 'max_output_tokens',
      }),
    )
  }

  return outputs
}

/**
 * OpenAI 兼容查询路径。将 Anthropic 格式的 messages/tools 转换为 OpenAI 格式，
 * 调用 OpenAI 兼容端点，然后将 SSE 流转换回 Anthropic BetaRawMessageStreamEvent
 * 供现有查询管线使用。
 */
export async function* queryModelOpenAI(
  messages: Message[],
  systemPrompt: SystemPrompt,
  tools: Tools,
  signal: AbortSignal,
  options: Options,
): AsyncGenerator<
  StreamEvent | AssistantMessage | SystemAPIErrorMessage,
  void
> {
  try {
    // 1. 解析模型名
    const openaiModel = resolveOpenAIModel(options.model)

    // 2. 使用共享预处理规范化 messages
    const messagesForAPI = normalizeMessagesForAPI(messages, tools)

    // 3. 检查是否启用 tool search（类似 Anthropic 路径）
    const useSearchExtraTools = await isSearchExtraToolsEnabled(
      options.model,
      tools,
      options.getToolPermissionContext ||
        (async () => getEmptyToolPermissionContext()),
      options.agents || [],
      options.querySource,
    )

    // 4. 构建 deferred tools 集合（类似 Anthropic 路径）
    const deferredToolNames = new Set<string>()
    if (useSearchExtraTools) {
      for (const t of tools) {
        if (isDeferredTool(t)) deferredToolNames.add(t.name)
      }
    }

    // 5. 过滤 tools（类似 Anthropic 路径）
    // 永远不要在 API tools 数组中包含 deferred tools —— 它们通过
    // ExecuteExtraTool 在运行时从全局 tool 注册表查询调用。保持 tools
    // 数组稳定可保留 prompt cache。
    let filteredTools = tools
    if (useSearchExtraTools && deferredToolNames.size > 0) {
      filteredTools = tools.filter(tool => {
        // 始终包含非 deferred tools
        if (!deferredToolNames.has(tool.name)) return true
        // 始终包含 SearchExtraToolsTool（以便它能发现更多 tools）
        if (toolMatchesName(tool, SEARCH_EXTRA_TOOLS_TOOL_NAME)) return true
        // 其他所有 deferred tools 都被排除 —— 改用 ExecuteExtraTool
        return false
      })
    }

    // 6. 使用 deferLoading flag 构建 tool schemas
    const toolSchemas = await Promise.all(
      filteredTools.map(tool =>
        toolToAPISchema(tool, {
          getToolPermissionContext: options.getToolPermissionContext,
          tools,
          agents: options.agents,
          allowedAgentTypes: options.allowedAgentTypes,
          model: options.model,
          deferLoading: useSearchExtraTools && deferredToolNames.has(tool.name),
        }),
      ),
    )

    // 7. 过滤非标准 tools（advisor 等服务端 tools）
    const standardTools = toolSchemas.filter(
      (t): t is BetaToolUnion & { type: string } => {
        const anyT = t as unknown as Record<string, unknown>
        return (
          anyT.type !== 'advisor_20260301' && anyT.type !== 'computer_20250124'
        )
      },
    )

    // 8. 将 messages 和 tools 转换为 OpenAI 格式
    const enableThinking = isOpenAIThinkingEnabled(openaiModel)
    const openAIConvertibleMessages = messagesForAPI.filter(
      isOpenAIConvertibleMessage,
    )
    const messagesWithDeferredToolList = prependDeferredToolListIfNeeded(
      openAIConvertibleMessages,
      tools,
      deferredToolNames,
      useSearchExtraTools,
    )
    const openaiMessages = anthropicMessagesToOpenAI(
      messagesWithDeferredToolList,
      systemPrompt,
      { enableThinking },
    )
    const openaiTools = anthropicToolsToOpenAI(standardTools)
    const openaiToolChoice = anthropicToolChoiceToOpenAI(options.toolChoice)
    const reasoningEffort = getChatGPTResponsesReasoningEffort(
      options.effortValue,
    )

    // 9. 记录 tool 过滤详情
    if (useSearchExtraTools) {
      const includedDeferredTools = filteredTools.filter(t =>
        deferredToolNames.has(t.name),
      ).length
      logForDebugging(
        `[OpenAI] Tool search 已启用：${includedDeferredTools}/${deferredToolNames.size} deferred tools 已包含，总 tools=${openaiTools.length}`,
      )
    } else {
      logForDebugging(
        `[OpenAI] Tool search 未启用，总 tools=${openaiTools.length}`,
      )
    }

    // 10. 计算 max_tokens —— 大多数 OpenAI 兼容端点必需。
    //     不设置则服务端使用很小的默认值，当启用 thinking 时，
    //     thinking 阶段会消耗完整个预算，导致最终响应无 token 可用。
    //
    //     使用 upperLimit（而非 slot-cap 默认值）是因为 Anthropic 路径的
    //     slot 预留上限（CAPPED_DEFAULT_MAX_TOKENS=8k）与 query.ts 中
    //     64k 的自动重试配对使用。OpenAI 路径没有此类重试，因此使用
    //     上限 8k 默认值会在多轮对话中悄悄截断响应（thinking 会消耗大部分预算）。
    //
    //     覆盖优先级：
    //     1. options.maxOutputTokensOverride（程序化）
    //     2. OPENAI_MAX_TOKENS 环境变量（OpenAI 专用，适用于小上下文窗口的本地模型，
    //        如 RTX 3060 12GB 运行 65536-token 模型）
    //     3. CLAUDE_CODE_MAX_OUTPUT_TOKENS 环境变量（通用覆盖）
    //     4. upperLimit 默认值（64000）
    const { upperLimit } = getModelMaxOutputTokens(openaiModel)
    const maxTokens = resolveOpenAIMaxTokens(
      upperLimit,
      options.maxOutputTokensOverride,
    )

    logForDebugging(
      `[OpenAI] Calling model=${openaiModel}, messages=${openaiMessages.length}, tools=${openaiTools.length}, thinking=${enableThinking}`,
    )

    // 11. 使用流式调用 OpenAI API。ChatGPT 订阅认证使用 Codex Responses 后端；
    // API key / OpenAI 兼容认证保留现有的 Chat Completions 适配器。
    const adaptedStream = isChatGPTAuthEnabled()
      ? adaptResponsesStreamToAnthropic(
          await createChatGPTResponsesStream({
            request: buildResponsesRequest({
              model: openaiModel,
              messages: openaiMessages,
              tools: openaiTools,
              toolChoice: openaiToolChoice,
              reasoningEffort,
            }),
            signal,
            fetchOverride: options.fetchOverride as unknown as typeof fetch,
          }),
          openaiModel,
        )
      : adaptOpenAIStreamToAnthropic(
          await getOpenAIClient({
            maxRetries: 0,
            fetchOverride: options.fetchOverride as unknown as typeof fetch,
            source: options.querySource,
          }).chat.completions.create(
            buildOpenAIRequestBody({
              model: openaiModel,
              messages: openaiMessages,
              tools: openaiTools,
              toolChoice: openaiToolChoice,
              enableThinking,
              maxTokens,
              temperatureOverride: options.temperatureOverride,
            }),
            { signal },
          ),
          openaiModel,
        )

    // 12. 将 OpenAI 流转换为 Anthropic 事件，然后处理成
    //     AssistantMessage + StreamEvent（与 Anthropic 路径行为一致）

    // 累积 content blocks 和 usage，与 claude.ts 中 Anthropic 路径相同
    const contentBlocks: Record<number, Record<string, unknown>> = {}
    const collectedMessages: AssistantMessage[] = []
    let partialMessage: BetaMessage | null = null
    let stopReason: string | null = null
    let usage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    }
    let ttftMs = 0
    const start = Date.now()

    for await (const event of adaptedStream) {
      switch (event.type) {
        case 'message_start': {
          partialMessage = event.message
          ttftMs = Date.now() - start
          if (event.message.usage) {
            usage = {
              ...usage,
              ...(event.message.usage as unknown as typeof usage),
            }
          }
          break
        }
        case 'content_block_start': {
          const idx = event.index
          const cb = event.content_block
          if (cb.type === 'tool_use') {
            contentBlocks[idx] = { ...cb, input: '' }
          } else if (cb.type === 'text') {
            contentBlocks[idx] = { ...cb, text: '' }
          } else if (cb.type === 'thinking') {
            contentBlocks[idx] = { ...cb, thinking: '', signature: '' }
          } else {
            contentBlocks[idx] = { ...cb }
          }
          break
        }
        case 'content_block_delta': {
          const idx = event.index
          const delta = event.delta
          const block = contentBlocks[idx]
          if (!block) break
          if (delta.type === 'text_delta') {
            block.text = ((block.text as string | undefined) || '') + delta.text
          } else if (delta.type === 'input_json_delta') {
            block.input =
              ((block.input as string | undefined) || '') + delta.partial_json
          } else if (delta.type === 'thinking_delta') {
            block.thinking =
              ((block.thinking as string | undefined) || '') + delta.thinking
          } else if (delta.type === 'signature_delta') {
            block.signature = delta.signature
          }
          break
        }
        case 'content_block_stop': {
          // Block 累积完成；组装在 message_stop 时进行。
          break
        }
        case 'message_delta': {
          const deltaUsage = event.usage
          if (deltaUsage) {
            usage = updateOpenAIUsage(
              usage,
              deltaUsage as unknown as Parameters<typeof updateOpenAIUsage>[1],
            )
          }
          if (event.delta.stop_reason != null) {
            stopReason = event.delta.stop_reason
          }
          break
        }
        case 'message_stop': {
          // 组装一个包含所有 content blocks 的 AssistantMessage，匹配
          // Anthropic SDK 路径。真实 usage（input + output tokens）此处可用，
          // 会被注入以便 tokenCountWithEstimation() 读取。
          if (partialMessage) {
            for (const output of assembleFinalAssistantOutputs({
              partialMessage,
              contentBlocks,
              tools,
              agentId: options.agentId,
              usage,
              stopReason,
              maxTokens,
            })) {
              if (output.type === 'assistant') {
                collectedMessages.push(output)
              }
              yield output
            }
            // 重置 partialMessage，使循环后的兜底逻辑不会 yield
            // 第二个相同的 AssistantMessage。
            partialMessage = null
          }
          // 跟踪成本与 token 用量
          if (usage.input_tokens + usage.output_tokens > 0) {
            const costUSD = calculateUSDCost(
              openaiModel,
              usage as unknown as BetaUsage,
            )
            addToTotalSessionCost(
              costUSD,
              usage as unknown as BetaUsage,
              options.model,
            )
          }
          break
        }
      }

      // 同时 yield 为 StreamEvent 以便实时显示（匹配 Anthropic 路径）
      yield {
        type: 'stream_event',
        event,
        ...(event.type === 'message_start' ? { ttftMs } : undefined),
      } as StreamEvent
    }

    // 在 Langfuse 中记录 LLM 观测（未配置时为 no-op）
    recordLLMObservation(options.langfuseTrace ?? null, {
      model: openaiModel,
      provider: 'openai',
      input: convertMessagesToLangfuse(openaiMessages),
      output: convertOutputToLangfuse(collectedMessages),
      usage: {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_creation_input_tokens: usage.cache_creation_input_tokens,
        cache_read_input_tokens: usage.cache_read_input_tokens,
      },
      startTime: new Date(start),
      endTime: new Date(),
      completionStartTime: ttftMs > 0 ? new Date(start + ttftMs) : undefined,
      tools: convertToolsToLangfuse(toolSchemas as unknown[]),
      ...(enableThinking && { thinking: { type: 'enabled' } }),
    })

    // 兜底：若流未以 message_stop 结束，组装并 yield 当前已有的内容
    if (partialMessage) {
      for (const output of assembleFinalAssistantOutputs({
        partialMessage,
        contentBlocks,
        tools,
        agentId: options.agentId,
        usage,
        stopReason,
        maxTokens,
      })) {
        yield output
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logForDebugging(`[OpenAI] Error: ${errorMessage}`, { level: 'error' })
    yield createAssistantAPIErrorMessage({
      content: `API Error: ${errorMessage}`,
      apiError: 'api_error',
      error: (error instanceof Error
        ? error
        : new Error(String(error))) as unknown as SDKAssistantMessageError,
    })
  }
}
