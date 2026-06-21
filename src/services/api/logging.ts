import { feature } from 'bun:bundle'
import { APIError } from '@anthropic-ai/sdk'
import type {
  BetaStopReason,
  BetaUsage as Usage,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import {
  addToTotalDurationState,
  consumePostCompaction,
  getIsNonInteractiveSession,
  getLastApiCompletionTimestamp,
  getTeleportedSessionInfo,
  markFirstTeleportMessageLogged,
  setLastApiCompletionTimestamp,
} from 'src/bootstrap/state.js'
import type { QueryChainTracking } from 'src/Tool.js'
import { isConnectorTextBlock } from 'src/types/connectorText.js'
import type { AssistantMessage } from 'src/types/message.js'
import { logForDebugging } from 'src/utils/debug.js'
import type { EffortLevel } from 'src/utils/effort.js'
import { logError } from 'src/utils/log.js'
import { getAPIProviderForStatsig } from 'src/utils/model/providers.js'
import type { PermissionMode } from 'src/utils/permissions/PermissionMode.js'
import { jsonStringify } from 'src/utils/slowOperations.js'
import { logOTelEvent } from 'src/utils/telemetry/events.js'
import type { ThinkingConfig } from 'src/utils/thinking.js'
import {
  endLLMRequestSpan,
  isBetaTracingEnabled,
  type Span,
} from 'src/utils/telemetry/sessionTracing.js'
import type { NonNullableUsage } from '../../entrypoints/sdk/sdkUtilityTypes.js'
import { consumeInvokingRequestId } from '../../utils/agentContext.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import { sanitizeToolNameForAnalytics } from '../analytics/metadata.js'
import { EMPTY_USAGE } from './emptyUsage.js'
import { classifyAPIError } from './errors.js'
import { extractConnectionErrorDetails } from './errorUtils.js'

export type { NonNullableUsage }
export { EMPTY_USAGE }

// 全局 prompt 缓存所使用的策略
export type GlobalCacheStrategy = 'tool_based' | 'system_prompt' | 'none'

function getErrorMessage(error: unknown): string {
  if (error instanceof APIError) {
    const body = error.error as { error?: { message?: string } } | undefined
    if (body?.error?.message) return body.error.message
  }
  return error instanceof Error ? error.message : String(error)
}

type KnownGateway =
  | 'litellm'
  | 'helicone'
  | 'portkey'
  | 'cloudflare-ai-gateway'
  | 'kong'
  | 'braintrust'
  | 'databricks'

// 用于从响应头中检测 AI 网关的网关指纹
const GATEWAY_FINGERPRINTS: Partial<
  Record<KnownGateway, { prefixes: string[] }>
> = {
  // https://docs.litellm.ai/docs/proxy/response_headers
  litellm: {
    prefixes: ['x-litellm-'],
  },
  // https://docs.helicone.ai/helicone-headers/header-directory
  helicone: {
    prefixes: ['helicone-'],
  },
  // https://portkey.ai/docs/api-reference/response-schema
  portkey: {
    prefixes: ['x-portkey-'],
  },
  // https://developers.cloudflare.com/ai-gateway/evaluations/add-human-feedback-api/
  'cloudflare-ai-gateway': {
    prefixes: ['cf-aig-'],
  },
  // https://developer.konghq.com/ai-gateway/ — X-Kong-Upstream-Latency, X-Kong-Proxy-Latency
  kong: {
    prefixes: ['x-kong-'],
  },
  // https://www.braintrust.dev/docs/guides/proxy — x-bt-used-endpoint, x-bt-cached
  braintrust: {
    prefixes: ['x-bt-'],
  },
}

// 使用 provider 自有域名（而非自托管）的网关，因此即便没有特征性响应头，
// ANTHROPIC_BASE_URL 主机名也是一个可靠的信号。
const GATEWAY_HOST_SUFFIXES: Partial<Record<KnownGateway, string[]>> = {
  // https://docs.databricks.com/aws/en/ai-gateway/
  databricks: [
    '.cloud.databricks.com',
    '.azuredatabricks.net',
    '.gcp.databricks.com',
  ],
}

function detectGateway({
  headers,
  baseUrl,
}: {
  headers?: globalThis.Headers
  baseUrl?: string
}): KnownGateway | undefined {
  if (headers) {
    // Header 名称已由 Headers API 转为小写
    const headerNames: string[] = []
    headers.forEach((_, key) => headerNames.push(key))
    for (const [gw, { prefixes }] of Object.entries(GATEWAY_FINGERPRINTS)) {
      if (prefixes.some(p => headerNames.some(h => h.startsWith(p)))) {
        return gw as KnownGateway
      }
    }
  }

  if (baseUrl) {
    try {
      const host = new URL(baseUrl).hostname.toLowerCase()
      for (const [gw, suffixes] of Object.entries(GATEWAY_HOST_SUFFIXES)) {
        if (suffixes.some(s => host.endsWith(s))) {
          return gw as KnownGateway
        }
      }
    } catch {
      // 格式错误的 URL —— 忽略
    }
  }

  return undefined
}

function getAnthropicEnvMetadata() {
  return {
    ...(process.env.ANTHROPIC_BASE_URL
      ? {
          baseUrl: process.env
            .ANTHROPIC_BASE_URL as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    ...(process.env.ANTHROPIC_MODEL
      ? {
          envModel: process.env
            .ANTHROPIC_MODEL as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    ...(process.env.ANTHROPIC_SMALL_FAST_MODEL
      ? {
          envSmallFastModel: process.env
            .ANTHROPIC_SMALL_FAST_MODEL as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
  }
}

function getBuildAgeMinutes(): number | undefined {
  if (!MACRO.BUILD_TIME) return undefined
  const buildTime = new Date(MACRO.BUILD_TIME).getTime()
  if (isNaN(buildTime)) return undefined
  return Math.floor((Date.now() - buildTime) / 60000)
}

export function logAPIQuery({
  model,
  messagesLength,
  temperature,
  betas,
  permissionMode,
  querySource,
  queryTracking,
  thinkingConfig,
  effortValue,
  fastMode,
  previousRequestId,
}: {
  model: string
  messagesLength: number
  temperature: number
  betas?: string[]
  permissionMode?: PermissionMode
  querySource: string
  queryTracking?: QueryChainTracking
  thinkingConfig?: ThinkingConfig
  effortValue?: EffortLevel | null
  fastMode?: boolean
  previousRequestId?: string | null
}): void {
  const thinkingType = thinkingConfig?.type ?? 'disabled'
  const thinkingBudgetTokens =
    thinkingConfig?.type === 'enabled' ? thinkingConfig.budgetTokens : undefined
  logEvent('tengu_api_query', {
    model: model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    messagesLength,
    temperature: temperature,
    provider: getAPIProviderForStatsig(),
    buildAgeMins: getBuildAgeMinutes(),
    ...(betas?.length
      ? {
          betas: betas.join(
            ',',
          ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    permissionMode:
      permissionMode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    querySource:
      querySource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    ...(queryTracking
      ? {
          queryChainId:
            queryTracking.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          queryDepth: queryTracking.depth,
        }
      : {}),
    thinkingType:
      thinkingType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    ...(thinkingBudgetTokens !== undefined && {
      thinkingBudgetTokens,
    }),
    effortValue:
      effortValue as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    fastMode,
    ...(previousRequestId
      ? {
          previousRequestId:
            previousRequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    ...getAnthropicEnvMetadata(),
  })
}

export function logAPIError({
  error,
  model,
  messageCount,
  messageTokens,
  durationMs,
  durationMsIncludingRetries,
  attempt,
  requestId,
  clientRequestId,
  didFallBackToNonStreaming,
  promptCategory,
  headers,
  queryTracking,
  querySource,
  llmSpan,
  fastMode,
  previousRequestId,
}: {
  error: unknown
  model: string
  messageCount: number
  messageTokens?: number
  durationMs: number
  durationMsIncludingRetries: number
  attempt: number
  requestId?: string | null
  /** 客户端生成、作为 x-client-request-id 头发送的 ID（能在超时中保留） */
  clientRequestId?: string
  didFallBackToNonStreaming?: boolean
  promptCategory?: string
  headers?: globalThis.Headers
  queryTracking?: QueryChainTracking
  querySource?: string
  /** 来自 startLLMRequestSpan 的 span —— 传入以正确地把响应对应到请求 */
  llmSpan?: Span
  fastMode?: boolean
  previousRequestId?: string | null
}): void {
  const gateway = detectGateway({
    headers:
      error instanceof APIError && error.headers ? error.headers : headers,
    baseUrl: process.env.ANTHROPIC_BASE_URL,
  })

  const errStr = getErrorMessage(error)
  const status = error instanceof APIError ? String(error.status) : undefined
  const errorType = classifyAPIError(error)

  // 把详细的连接错误信息记录到 debug 日志（通过 --debug 可见）
  const connectionDetails = extractConnectionErrorDetails(error)
  if (connectionDetails) {
    const sslLabel = connectionDetails.isSSLError ? ' (SSL error)' : ''
    logForDebugging(
      `Connection error details: code=${connectionDetails.code}${sslLabel}, message=${connectionDetails.message}`,
      { level: 'error' },
    )
  }

  const invocation = consumeInvokingRequestId()

  if (clientRequestId) {
    logForDebugging(
      `API error x-client-request-id=${clientRequestId} (give this to the API team for server-log lookup)`,
      { level: 'error' },
    )
  }

  logError(error as Error)
  logEvent('tengu_api_error', {
    model: model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    error: errStr as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    status:
      status as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    errorType:
      errorType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    messageCount,
    messageTokens,
    durationMs,
    durationMsIncludingRetries,
    attempt,
    provider: getAPIProviderForStatsig(),
    requestId:
      (requestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS) ||
      undefined,
    ...(invocation
      ? {
          invokingRequestId:
            invocation.invokingRequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          invocationKind:
            invocation.invocationKind as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    clientRequestId:
      (clientRequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS) ||
      undefined,
    didFallBackToNonStreaming,
    ...(promptCategory
      ? {
          promptCategory:
            promptCategory as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    ...(gateway
      ? {
          gateway:
            gateway as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    ...(queryTracking
      ? {
          queryChainId:
            queryTracking.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          queryDepth: queryTracking.depth,
        }
      : {}),
    ...(querySource
      ? {
          querySource:
            querySource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    fastMode,
    ...(previousRequestId
      ? {
          previousRequestId:
            previousRequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    ...getAnthropicEnvMetadata(),
  })

  // 为 OTLP 记录 API 错误事件
  void logOTelEvent('api_error', {
    model: model,
    error: errStr,
    status_code: String(status),
    duration_ms: String(durationMs),
    attempt: String(attempt),
    speed: fastMode ? 'fast' : 'normal',
  })

  // 当启用 beta tracing 时传入 span 以正确地把响应对应到请求
  endLLMRequestSpan(llmSpan, {
    success: false,
    statusCode: status ? parseInt(status, 10) : undefined,
    error: errStr,
    attempt,
  })

  // 为被 teleport 的 session 记录首次错误（可靠性追踪）
  const teleportInfo = getTeleportedSessionInfo()
  if (teleportInfo?.isTeleported && !teleportInfo.hasLoggedFirstMessage) {
    logEvent('tengu_teleport_first_message_error', {
      session_id:
        teleportInfo.sessionId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      error_type:
        errorType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    markFirstTeleportMessageLogged()
  }
}

function logAPISuccess({
  model,
  preNormalizedModel,
  messageCount,
  messageTokens,
  usage,
  durationMs,
  durationMsIncludingRetries,
  attempt,
  ttftMs,
  requestId,
  stopReason,
  costUSD,
  didFallBackToNonStreaming,
  querySource,
  gateway,
  queryTracking,
  permissionMode,
  globalCacheStrategy,
  textContentLength,
  thinkingContentLength,
  toolUseContentLengths,
  connectorTextBlockCount,
  fastMode,
  previousRequestId,
  betas,
}: {
  model: string
  preNormalizedModel: string
  messageCount: number
  messageTokens: number
  usage: Usage
  durationMs: number
  durationMsIncludingRetries: number
  attempt: number
  ttftMs: number | null
  requestId: string | null
  stopReason: BetaStopReason | null
  costUSD: number
  didFallBackToNonStreaming: boolean
  querySource: string
  gateway?: KnownGateway
  queryTracking?: QueryChainTracking
  permissionMode?: PermissionMode
  globalCacheStrategy?: GlobalCacheStrategy
  textContentLength?: number
  thinkingContentLength?: number
  toolUseContentLengths?: Record<string, number>
  connectorTextBlockCount?: number
  fastMode?: boolean
  previousRequestId?: string | null
  betas?: string[]
}): void {
  const isNonInteractiveSession = getIsNonInteractiveSession()
  const isPostCompaction = consumePostCompaction()
  const hasPrintFlag =
    process.argv.includes('-p') || process.argv.includes('--print')

  const now = Date.now()
  const lastCompletion = getLastApiCompletionTimestamp()
  const timeSinceLastApiCallMs =
    lastCompletion !== null ? now - lastCompletion : undefined

  const invocation = consumeInvokingRequestId()

  logEvent('tengu_api_success', {
    model: model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    ...(preNormalizedModel !== model
      ? {
          preNormalizedModel:
            preNormalizedModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    ...(betas?.length
      ? {
          betas: betas.join(
            ',',
          ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    messageCount,
    messageTokens,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cachedInputTokens: usage.cache_read_input_tokens ?? 0,
    uncachedInputTokens: usage.cache_creation_input_tokens ?? 0,
    durationMs: durationMs,
    durationMsIncludingRetries: durationMsIncludingRetries,
    attempt: attempt,
    ttftMs: ttftMs ?? undefined,
    buildAgeMins: getBuildAgeMinutes(),
    provider: getAPIProviderForStatsig(),
    requestId:
      (requestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS) ??
      undefined,
    ...(invocation
      ? {
          invokingRequestId:
            invocation.invokingRequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          invocationKind:
            invocation.invocationKind as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    stop_reason:
      (stopReason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS) ??
      undefined,
    costUSD,
    didFallBackToNonStreaming,
    isNonInteractiveSession,
    print: hasPrintFlag,
    isTTY: process.stdout.isTTY ?? false,
    querySource:
      querySource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    ...(gateway
      ? {
          gateway:
            gateway as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    ...(queryTracking
      ? {
          queryChainId:
            queryTracking.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          queryDepth: queryTracking.depth,
        }
      : {}),
    permissionMode:
      permissionMode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    ...(globalCacheStrategy
      ? {
          globalCacheStrategy:
            globalCacheStrategy as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    ...(textContentLength !== undefined
      ? ({
          textContentLength,
        } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
      : {}),
    ...(thinkingContentLength !== undefined
      ? ({
          thinkingContentLength,
        } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
      : {}),
    ...(toolUseContentLengths !== undefined
      ? ({
          toolUseContentLengths: jsonStringify(
            toolUseContentLengths,
          ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
      : {}),
    ...(connectorTextBlockCount !== undefined
      ? ({
          connectorTextBlockCount,
        } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
      : {}),
    fastMode,
    // 为 cache editing 分析记录 cache_deleted_input_tokens。这里需要类型转换，
    // 因为该字段故意没有放到 NonNullableUsage 中（被外部构建排除）。
    // 由 updateUsage() 在 cache editing 处于活动状态时设置。
    ...(feature('CACHED_MICROCOMPACT') &&
    ((usage as unknown as { cache_deleted_input_tokens?: number })
      .cache_deleted_input_tokens ?? 0) > 0
      ? {
          cacheDeletedInputTokens: (
            usage as unknown as { cache_deleted_input_tokens: number }
          ).cache_deleted_input_tokens,
        }
      : {}),
    ...(previousRequestId
      ? {
          previousRequestId:
            previousRequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    ...(isPostCompaction ? { isPostCompaction } : {}),
    ...getAnthropicEnvMetadata(),
    timeSinceLastApiCallMs,
  })

  setLastApiCompletionTimestamp(now)
}

export function logAPISuccessAndDuration({
  model,
  preNormalizedModel,
  start,
  startIncludingRetries,
  ttftMs,
  usage,
  attempt,
  messageCount,
  messageTokens,
  requestId,
  stopReason,
  didFallBackToNonStreaming,
  querySource,
  headers,
  costUSD,
  queryTracking,
  permissionMode,
  newMessages,
  llmSpan,
  globalCacheStrategy,
  requestSetupMs,
  attemptStartTimes,
  fastMode,
  previousRequestId,
  betas,
}: {
  model: string
  preNormalizedModel: string
  start: number
  startIncludingRetries: number
  ttftMs: number | null
  usage: NonNullableUsage
  attempt: number
  messageCount: number
  messageTokens: number
  requestId: string | null
  stopReason: BetaStopReason | null
  didFallBackToNonStreaming: boolean
  querySource: string
  headers?: globalThis.Headers
  costUSD: number
  queryTracking?: QueryChainTracking
  permissionMode?: PermissionMode
  /** 响应中的 assistant 消息 —— 启用 beta tracing 时用于提取 model_output 和 thinking_output */
  newMessages?: AssistantMessage[]
  /** 来自 startLLMRequestSpan 的 span —— 传入以正确地把响应对应到请求 */
  llmSpan?: Span
  /** 全局 prompt 缓存使用的策略：'tool_based'、'system_prompt' 或 'none' */
  globalCacheStrategy?: GlobalCacheStrategy
  /** 成功那次尝试之前用于请求前设置的时间 */
  requestSetupMs?: number
  /** 每次尝试开始的时间戳（Date.now()）—— 用于 Perfetto 中的重试子 span */
  attemptStartTimes?: number[]
  fastMode?: boolean
  /** 本 session 中上一次 API 调用的 request ID */
  previousRequestId?: string | null
  betas?: string[]
}): void {
  const gateway = detectGateway({
    headers,
    baseUrl: process.env.ANTHROPIC_BASE_URL,
  })

  let textContentLength: number | undefined
  let thinkingContentLength: number | undefined
  let toolUseContentLengths: Record<string, number> | undefined
  let connectorTextBlockCount: number | undefined

  if (newMessages) {
    let textLen = 0
    let thinkingLen = 0
    let hasToolUse = false
    const toolLengths: Record<string, number> = {}
    let connectorCount = 0

    for (const msg of newMessages) {
      const contentArr = Array.isArray(msg.message.content)
        ? msg.message.content
        : []
      for (const block of contentArr) {
        if (typeof block === 'string') continue
        if (block.type === 'text') {
          textLen += (block as { type: 'text'; text: string }).text.length
        } else if (feature('CONNECTOR_TEXT') && isConnectorTextBlock(block)) {
          connectorCount++
        } else if (block.type === 'thinking') {
          thinkingLen += (block as { type: 'thinking'; thinking: string })
            .thinking.length
        } else if (
          block.type === 'tool_use' ||
          block.type === 'server_tool_use' ||
          (block.type as string) === 'mcp_tool_use'
        ) {
          const inputLen = jsonStringify(
            (block as { input: unknown }).input,
          ).length
          const sanitizedName = sanitizeToolNameForAnalytics(
            (block as { name: string }).name,
          )
          toolLengths[sanitizedName] =
            (toolLengths[sanitizedName] ?? 0) + inputLen
          hasToolUse = true
        }
      }
    }

    textContentLength = textLen
    thinkingContentLength = thinkingLen > 0 ? thinkingLen : undefined
    toolUseContentLengths = hasToolUse ? toolLengths : undefined
    connectorTextBlockCount = connectorCount > 0 ? connectorCount : undefined
  }

  const durationMs = Date.now() - start
  const durationMsIncludingRetries = Date.now() - startIncludingRetries
  addToTotalDurationState(durationMsIncludingRetries, durationMs)

  logAPISuccess({
    model,
    preNormalizedModel,
    messageCount,
    messageTokens,
    usage: usage as unknown as Usage,
    durationMs,
    durationMsIncludingRetries,
    attempt,
    ttftMs,
    requestId,
    stopReason,
    costUSD,
    didFallBackToNonStreaming,
    querySource,
    gateway,
    queryTracking,
    permissionMode,
    globalCacheStrategy,
    textContentLength,
    thinkingContentLength,
    toolUseContentLengths,
    connectorTextBlockCount,
    fastMode,
    previousRequestId,
    betas,
  })
  // 为 OTLP 记录 API 请求事件
  void logOTelEvent('api_request', {
    model,
    input_tokens: String(usage.input_tokens),
    output_tokens: String(usage.output_tokens),
    cache_read_tokens: String(usage.cache_read_input_tokens),
    cache_creation_tokens: String(usage.cache_creation_input_tokens),
    cost_usd: String(costUSD),
    duration_ms: String(durationMs),
    speed: fastMode ? 'fast' : 'normal',
  })

  // 启用 beta tracing 时，提取 model output、thinking output 以及 tool call 标记
  let modelOutput: string | undefined
  let thinkingOutput: string | undefined
  let hasToolCall: boolean | undefined

  if (isBetaTracingEnabled() && newMessages) {
    // Model output —— 对所有用户可见
    modelOutput =
      newMessages
        .flatMap(m => {
          const content = m.message.content
          if (!Array.isArray(content)) return []
          return content
            .filter(c => typeof c !== 'string' && c.type === 'text')
            .map(c => (c as { type: 'text'; text: string }).text)
        })
        .join('\n') || undefined

    // Thinking output —— 仅 Ant 可见（构建时门控）
    if (process.env.USER_TYPE === 'ant') {
      thinkingOutput =
        newMessages
          .flatMap(m => {
            const content = m.message.content
            if (!Array.isArray(content)) return []
            return content
              .filter(c => typeof c !== 'string' && c.type === 'thinking')
              .map(c => (c as { type: 'thinking'; thinking: string }).thinking)
          })
          .join('\n') || undefined
    }

    // 检查输出中是否存在 tool_use 块
    hasToolCall = newMessages.some(m => {
      const content = m.message.content
      if (!Array.isArray(content)) return false
      return content.some(c => typeof c !== 'string' && c.type === 'tool_use')
    })
  }

  // 启用 beta tracing 时传入 span 以正确地把响应对应到请求
  endLLMRequestSpan(llmSpan, {
    success: true,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens,
    cacheCreationTokens: usage.cache_creation_input_tokens,
    attempt,
    modelOutput,
    thinkingOutput,
    hasToolCall,
    ttftMs: ttftMs ?? undefined,
    requestSetupMs,
    attemptStartTimes,
  })

  // 为被 teleport 的 session 记录首次成功消息（可靠性追踪）
  const teleportInfo = getTeleportedSessionInfo()
  if (teleportInfo?.isTeleported && !teleportInfo.hasLoggedFirstMessage) {
    logEvent('tengu_teleport_first_message_success', {
      session_id:
        teleportInfo.sessionId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    markFirstTeleportMessageLogged()
  }
}
