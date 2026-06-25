import { feature } from 'bun:bundle'
import type Anthropic from '@anthropic-ai/sdk'
import {
  APIConnectionError,
  APIError,
  APIUserAbortError,
} from '@anthropic-ai/sdk'
import type { QuerySource } from 'src/constants/querySource.js'
import type { SystemAPIErrorMessage } from 'src/types/message.js'
import { isAwsCredentialsProviderError } from 'src/utils/aws.js'
import { logForDebugging } from 'src/utils/debug.js'
import { logError } from 'src/utils/log.js'
import { createSystemAPIErrorMessage } from 'src/utils/messages.js'
import { getAPIProviderForStatsig } from 'src/utils/model/providers.js'
import {
  clearApiKeyHelperCache,
  clearAwsCredentialsCache,
  clearGcpCredentialsCache,
  getClaudeAIOAuthTokens,
  handleOAuth401Error,
  isClaudeAISubscriber,
  isEnterpriseSubscriber,
} from '../../utils/auth.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { errorMessage } from '../../utils/errors.js'
import {
  type CooldownReason,
  handleFastModeOverageRejection,
  handleFastModeRejectedByAPI,
  isFastModeCooldown,
  isFastModeEnabled,
  triggerFastModeCooldown,
} from '../../utils/fastMode.js'
import { isNonCustomOpusModel } from '../../utils/model/model.js'
import { disableKeepAlive } from '../../utils/proxy.js'
import { sleep } from '../../utils/sleep.js'
import type { ThinkingConfig } from '../../utils/thinking.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import {
  checkMockRateLimitError,
  isMockRateLimitError,
} from '../rateLimitMocking.js'
import { REPEATED_529_ERROR_MESSAGE } from './errors.js'
import { extractConnectionErrorDetails } from './errorUtils.js'

const abortError = () => new APIUserAbortError()

const DEFAULT_MAX_RETRIES = 10
const FLOOR_OUTPUT_TOKENS = 3000
const MAX_529_RETRIES = 3
export const BASE_DELAY_MS = 500

// 用户会阻塞等待结果的前台 query source —— 这些会在 529 时重试。
// 其他所有 source（摘要、标题、建议、分类器）都会立即放弃：在容量级联期间，
// 每次重试都会带来 3-10× 的网关放大，而用户根本看不到这些失败。新增的
// source 默认不重试 —— 仅当用户在等待结果时才加到这里。
const FOREGROUND_529_RETRY_SOURCES = new Set<QuerySource>([
  'repl_main_thread',
  'repl_main_thread:outputStyle:custom',
  'repl_main_thread:outputStyle:Explanatory',
  'repl_main_thread:outputStyle:Learning',
  'sdk',
  'agent:custom',
  'agent:default',
  'agent:builtin',
  'compact',
  'hook_agent',
  'hook_prompt',
  'verification_agent',
  'side_question',
  // 安全分类器 —— 必须完成才能保证 auto-mode 的正确性。
  // yoloClassifier.ts 使用的是 'auto_mode'（不是 'yolo_classifier' ——
  // 那个只是类型用）。bash_classifier 仅 ant 可用；做 feature-gate，
  // 让该字符串能从外部构建中被 tree-shake（excluded-strings.txt）。
  'auto_mode',
  ...(feature('BASH_CLASSIFIER') ? (['bash_classifier'] as const) : []),
])

function shouldRetry529(querySource: QuerySource | undefined): boolean {
  // undefined → 重试（对未打标的调用路径采取保守策略）
  return (
    querySource === undefined || FOREGROUND_529_RETRY_SOURCES.has(querySource)
  )
}

// CLAUDE_CODE_UNATTENDED_RETRY：用于无人值守 session（仅 ant）。无限重试
// 429/529，使用更长的退避并周期性 yield keep-alive，避免宿主环境在等待中
// 把 session 标记为 idle。
// TODO(ANT-344)：通过 SystemAPIErrorMessage yield 做 keep-alive 只是临时方案，
// 直到有专门的 keep-alive 通道为止。
const PERSISTENT_MAX_BACKOFF_MS = 5 * 60 * 1000
const PERSISTENT_RESET_CAP_MS = 6 * 60 * 60 * 1000
const HEARTBEAT_INTERVAL_MS = 30_000

function isPersistentRetryEnabled(): boolean {
  return feature('UNATTENDED_RETRY')
    ? isEnvTruthy(process.env.CLAUDE_CODE_UNATTENDED_RETRY)
    : false
}

function isTransientCapacityError(error: unknown): boolean {
  return (
    is529Error(error) || (error instanceof APIError && error.status === 429)
  )
}

function isStaleConnectionError(error: unknown): boolean {
  if (!(error instanceof APIConnectionError)) {
    return false
  }
  const details = extractConnectionErrorDetails(error)
  return details?.code === 'ECONNRESET' || details?.code === 'EPIPE'
}

export interface RetryContext {
  maxTokensOverride?: number
  model: string
  thinkingConfig: ThinkingConfig
  fastMode?: boolean
}

interface RetryOptions {
  maxRetries?: number
  model: string
  fallbackModel?: string
  thinkingConfig: ThinkingConfig
  fastMode?: boolean
  signal?: AbortSignal
  querySource?: QuerySource
  /**
   * 预置连续 529 计数器。当本重试循环是流式 529 之后的非流式 fallback 时
   * 使用 —— 流式的 529 应计入 MAX_529_RETRIES，使触发 fallback 前的总 529
   * 次数与命中过载的请求模式无关，保持一致。
   */
  initialConsecutive529Errors?: number
}

export class CannotRetryError extends Error {
  constructor(
    public readonly originalError: unknown,
    public readonly retryContext: RetryContext,
  ) {
    const message = errorMessage(originalError)
    super(message)
    this.name = 'RetryError'

    // 若可用则保留原始的 stack trace
    if (originalError instanceof Error && originalError.stack) {
      this.stack = originalError.stack
    }
  }
}

export class FallbackTriggeredError extends Error {
  constructor(
    public readonly originalModel: string,
    public readonly fallbackModel: string,
  ) {
    super(`Model fallback triggered: ${originalModel} -> ${fallbackModel}`)
    this.name = 'FallbackTriggeredError'
  }
}

export async function* withRetry<T>(
  getClient: () => Promise<Anthropic>,
  operation: (
    client: Anthropic,
    attempt: number,
    context: RetryContext,
  ) => Promise<T>,
  options: RetryOptions,
): AsyncGenerator<SystemAPIErrorMessage, T> {
  const maxRetries = getMaxRetries(options)
  const retryContext: RetryContext = {
    model: options.model,
    thinkingConfig: options.thinkingConfig,
    ...(isFastModeEnabled() && { fastMode: options.fastMode }),
  }
  let client: Anthropic | null = null
  let consecutive529Errors = options.initialConsecutive529Errors ?? 0
  let lastError: unknown
  let persistentAttempt = 0
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (options.signal?.aborted) {
      throw new APIUserAbortError()
    }

    // 在本次尝试之前捕获 fast mode 是否激活
    // （fallback 可能会在循环中途改变状态）
    const wasFastModeActive = isFastModeEnabled()
      ? retryContext.fastMode && !isFastModeCooldown()
      : false

    try {
      // 检查 mock rate limit（由 Ant 员工的 /mock-limits 命令使用）
      if (process.env.USER_TYPE === 'ant') {
        const mockError = checkMockRateLimitError(
          retryContext.model,
          wasFastModeActive,
        )
        if (mockError) {
          throw mockError
        }
      }

      // 在首次尝试或认证错误之后获取新的客户端实例
      // - 401：first-party API 认证失败
      // - 403 "OAuth token has been revoked"（另一个进程刷新了 token）
      // - Bedrock 专属认证错误（403 或 CredentialsProviderError）
      // - Vertex 专属认证错误（凭证刷新失败、401）
      // - ECONNRESET/EPIPE：陈旧的 keep-alive socket；禁用连接池并重连
      const isStaleConnection = isStaleConnectionError(lastError)
      if (
        isStaleConnection &&
        getFeatureValue_CACHED_MAY_BE_STALE(
          'tengu_disable_keepalive_on_econnreset',
          false,
        )
      ) {
        logForDebugging(
          'Stale connection (ECONNRESET/EPIPE) — disabling keep-alive for retry',
        )
        disableKeepAlive()
      }

      if (
        client === null ||
        (lastError instanceof APIError && lastError.status === 401) ||
        isOAuthTokenRevokedError(lastError) ||
        isBedrockAuthError(lastError) ||
        isVertexAuthError(lastError) ||
        isStaleConnection
      ) {
        // 在 401 "token expired" 或 403 "token revoked" 时，强制刷新 token
        if (
          (lastError instanceof APIError && lastError.status === 401) ||
          isOAuthTokenRevokedError(lastError)
        ) {
          const failedAccessToken = getClaudeAIOAuthTokens()?.accessToken
          if (failedAccessToken) {
            await handleOAuth401Error(failedAccessToken)
          }
        }
        client = await getClient()
      }

      return await operation(client, attempt, retryContext)
    } catch (error) {
      lastError = error
      logForDebugging(
        `API error (attempt ${attempt}/${maxRetries + 1}): ${error instanceof APIError ? `${error.status} ${error.message}` : errorMessage(error)}`,
        { level: 'error' },
      )

      // Fast mode fallback：在 429/529 时，要么等待并重试（短延迟），
      // 要么回退到标准速度（长延迟）以避免缓存抖动。
      // 在 persistent 模式下跳过：下面的短重试路径在 fast mode 仍激活时循环，
      // 所以它的 `continue` 永远到不了 attempt 的夹断逻辑，for 循环会终止。
      // Persistent session 反正想要分块的 keep-alive 路径，而不是 fast mode 的
      // 缓存保护。
      if (
        wasFastModeActive &&
        !isPersistentRetryEnabled() &&
        error instanceof APIError &&
        (error.status === 429 || is529Error(error))
      ) {
        // 如果 429 明确是因为 extra usage（overage）不可用，
        // 则永久禁用 fast mode 并给出相应消息。
        const overageReason = error.headers?.get(
          'anthropic-ratelimit-unified-overage-disabled-reason',
        )
        if (overageReason !== null && overageReason !== undefined) {
          handleFastModeOverageRejection(overageReason)
          retryContext.fastMode = false
          continue
        }

        const retryAfterMs = getRetryAfterMs(error)
        if (retryAfterMs !== null && retryAfterMs < SHORT_RETRY_THRESHOLD_MS) {
          // 短 retry-after：等待并在 fast mode 仍激活的情况下重试，
          // 以保留 prompt 缓存（重试时使用同一个模型名）。
          await sleep(retryAfterMs, options.signal, { abortError })
          continue
        }
        // 长或未知的 retry-after：进入冷却（切换到标准速度模型），
        // 带最小下限以避免来回切换。
        const cooldownMs = Math.max(
          retryAfterMs ?? DEFAULT_FAST_MODE_FALLBACK_HOLD_MS,
          MIN_COOLDOWN_MS,
        )
        const cooldownReason: CooldownReason = is529Error(error)
          ? 'overloaded'
          : 'rate_limit'
        triggerFastModeCooldown(Date.now() + cooldownMs, cooldownReason)
        if (isFastModeEnabled()) {
          retryContext.fastMode = false
        }
        continue
      }

      // Fast mode fallback：如果 API 拒绝 fast mode 参数
      // （例如 org 没有启用 fast mode），永久禁用 fast mode 并以标准速度重试。
      if (wasFastModeActive && isFastModeNotEnabledError(error)) {
        handleFastModeRejectedByAPI()
        retryContext.fastMode = false
        continue
      }

      // 非前台 source 在 529 时立即放弃 —— 在容量级联期间不做重试放大。
      // 用户看不到这些失败。
      if (is529Error(error) && !shouldRetry529(options.querySource)) {
        logEvent('tengu_api_529_background_dropped', {
          query_source:
            options.querySource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        throw new CannotRetryError(error, retryContext)
      }

      // 跟踪连续 529 错误
      if (
        is529Error(error) &&
        // 若 FALLBACK_FOR_ALL_PRIMARY_MODELS 未设置，则仅当主模型是非自定义 Opus 模型时才进入下方逻辑。
        // TODO: 重新审视 isNonCustomOpusModel 检查是否还应该存在，或者 isNonCustomOpusModel 只是 Claude Code 硬编码使用 Opus 时期的陈旧遗留。
        (process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS ||
          (!isClaudeAISubscriber() && isNonCustomOpusModel(options.model)))
      ) {
        consecutive529Errors++
        if (consecutive529Errors >= MAX_529_RETRIES) {
          // 检查是否指定了 fallback 模型
          if (options.fallbackModel) {
            logEvent('tengu_api_opus_fallback_triggered', {
              original_model:
                options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              fallback_model:
                options.fallbackModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              provider: getAPIProviderForStatsig(),
            })

            // 抛出特殊错误以表示触发了 fallback
            throw new FallbackTriggeredError(
              options.model,
              options.fallbackModel,
            )
          }

          if (
            process.env.USER_TYPE === 'external' &&
            !process.env.IS_SANDBOX &&
            !isPersistentRetryEnabled()
          ) {
            logEvent('tengu_api_custom_529_overloaded_error', {})
            throw new CannotRetryError(
              new Error(REPEATED_529_ERROR_MESSAGE),
              retryContext,
            )
          }
        }
      }

      // 仅当错误提示我们应该重试时才重试
      const persistent =
        isPersistentRetryEnabled() && isTransientCapacityError(error)
      if (attempt > maxRetries && !persistent) {
        throw new CannotRetryError(error, retryContext)
      }

      // AWS/GCP 错误不总是 APIError，但可以重试
      const handledCloudAuthError =
        handleAwsCredentialError(error) || handleGcpCredentialError(error)
      if (
        !handledCloudAuthError &&
        (!(error instanceof APIError) || !shouldRetry(error))
      ) {
        throw new CannotRetryError(error, retryContext)
      }

      // 通过为下一次尝试调整 max_tokens 来处理 max_tokens 上下文溢出错误
      // 注意：有了 extended-context-window beta，这个 400 错误不应该再出现。
      // API 现在会返回 'model_context_window_exceeded' stop_reason 替代它。
      // 保留是为了向后兼容。
      if (error instanceof APIError) {
        const overflowData = parseMaxTokensContextOverflowError(error)
        if (overflowData) {
          const { inputTokens, contextLimit } = overflowData

          const safetyBuffer = 1000
          const availableContext = Math.max(
            0,
            contextLimit - inputTokens - safetyBuffer,
          )
          if (availableContext < FLOOR_OUTPUT_TOKENS) {
            logError(
              new Error(
                `availableContext ${availableContext} is less than FLOOR_OUTPUT_TOKENS ${FLOOR_OUTPUT_TOKENS}`,
              ),
            )
            throw error
          }
          // 确保至少有足够 thinking + 1 个 output token 的空间
          const minRequired =
            (retryContext.thinkingConfig.type === 'enabled'
              ? retryContext.thinkingConfig.budgetTokens
              : 0) + 1
          const adjustedMaxTokens = Math.max(
            FLOOR_OUTPUT_TOKENS,
            availableContext,
            minRequired,
          )
          retryContext.maxTokensOverride = adjustedMaxTokens

          logEvent('tengu_max_tokens_context_overflow_adjustment', {
            inputTokens,
            contextLimit,
            adjustedMaxTokens,
            attempt,
          })

          continue
        }
      }

      // 其他错误走正常的重试逻辑
      // 获取 retry-after 头（若有）
      const retryAfter = getRetryAfter(error)
      let delayMs: number
      if (persistent && error instanceof APIError && error.status === 429) {
        persistentAttempt++
        // 基于窗口的限额（例如 5 小时 Max/Pro）会附带 reset 时间戳。
        // 等到 reset，而不是每 5 分钟无意义地轮询。
        const resetDelay = getRateLimitResetDelayMs(error)
        delayMs =
          resetDelay ??
          Math.min(
            getRetryDelay(
              persistentAttempt,
              retryAfter,
              PERSISTENT_MAX_BACKOFF_MS,
            ),
            PERSISTENT_RESET_CAP_MS,
          )
      } else if (persistent) {
        persistentAttempt++
        // Retry-After 是服务端指令，在 getRetryDelay 内部会绕过
        // maxDelayMs（故意的 —— 遵循它是正确的）。在这里用 6 小时的
        // reset-cap 做上限，避免病态的 header 导致无限等待。
        delayMs = Math.min(
          getRetryDelay(
            persistentAttempt,
            retryAfter,
            PERSISTENT_MAX_BACKOFF_MS,
          ),
          PERSISTENT_RESET_CAP_MS,
        )
      } else {
        delayMs = getRetryDelay(attempt, retryAfter)
      }

      // persistent 模式下 for 循环的 `attempt` 被夹到 maxRetries+1；
      // 在遥测/yield 里使用 persistentAttempt，使其反映真实计数。
      const reportedAttempt = persistent ? persistentAttempt : attempt
      logEvent('tengu_api_retry', {
        attempt: reportedAttempt,
        delayMs: delayMs,
        error: (error as APIError)
          .message as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        status: (error as APIError).status,
        provider: getAPIProviderForStatsig(),
      })

      if (persistent) {
        if (delayMs > 60_000) {
          logEvent('tengu_api_persistent_retry_wait', {
            status: (error as APIError).status,
            delayMs,
            attempt: reportedAttempt,
            provider: getAPIProviderForStatsig(),
          })
        }
        // 把长睡眠切成块，让宿主能周期性地看到 stdout 活动，
        // 不会把 session 标记为 idle。每次 yield 通过 QueryEngine
        // 以 {type:'system', subtype:'api_retry'} 形式输出到 stdout。
        let remaining = delayMs
        while (remaining > 0) {
          if (options.signal?.aborted) throw new APIUserAbortError()
          if (error instanceof APIError) {
            yield createSystemAPIErrorMessage(
              error,
              remaining,
              reportedAttempt,
              maxRetries,
            )
          }
          const chunk = Math.min(remaining, HEARTBEAT_INTERVAL_MS)
          await sleep(chunk, options.signal, { abortError })
          remaining -= chunk
        }
        // 夹断让 for 循环永不终止。退避使用独立的 persistentAttempt 计数器，
        // 它会一直增长到 5 分钟上限。
        if (attempt >= maxRetries) attempt = maxRetries
      } else {
        if (error instanceof APIError) {
          yield createSystemAPIErrorMessage(error, delayMs, attempt, maxRetries)
        }
        await sleep(delayMs, options.signal, { abortError })
      }
    }
  }

  throw new CannotRetryError(lastError, retryContext)
}

function getRetryAfter(error: unknown): string | null {
  return (
    ((error as { headers?: { 'retry-after'?: string } }).headers?.[
      'retry-after'
    ] ||
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      ((error as APIError).headers as Headers)?.get?.('retry-after')) ??
    null
  )
}

export function getRetryDelay(
  attempt: number,
  retryAfterHeader?: string | null,
  maxDelayMs = 32000,
): number {
  if (retryAfterHeader) {
    const seconds = parseInt(retryAfterHeader, 10)
    if (!isNaN(seconds)) {
      return seconds * 1000
    }
  }

  const baseDelay = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), maxDelayMs)
  const jitter = Math.random() * 0.25 * baseDelay
  return baseDelay + jitter
}

export function parseMaxTokensContextOverflowError(error: APIError):
  | {
      inputTokens: number
      maxTokens: number
      contextLimit: number
    }
  | undefined {
  if (error.status !== 400 || !error.message) {
    return undefined
  }

  if (
    !error.message.includes(
      'input length and `max_tokens` exceed context limit',
    )
  ) {
    return undefined
  }

  // 示例格式："input length and `max_tokens` exceed context limit: 188059 + 20000 > 200000"
  const regex =
    /input length and `max_tokens` exceed context limit: (\d+) \+ (\d+) > (\d+)/
  const match = error.message.match(regex)

  if (!match || match.length !== 4) {
    return undefined
  }

  if (!match[1] || !match[2] || !match[3]) {
    logError(
      new Error(
        'Unable to parse max_tokens from max_tokens exceed context limit error message',
      ),
    )
    return undefined
  }
  const inputTokens = parseInt(match[1], 10)
  const maxTokens = parseInt(match[2], 10)
  const contextLimit = parseInt(match[3], 10)

  if (isNaN(inputTokens) || isNaN(maxTokens) || isNaN(contextLimit)) {
    return undefined
  }

  return { inputTokens, maxTokens, contextLimit }
}

// TODO: 等 API 增加专门的 fast-mode 拒绝响应头（例如 x-fast-mode-rejected）
// 之后改为检查响应头。字符串匹配错误消息很脆弱，API 措辞一变就会失效。
function isFastModeNotEnabledError(error: unknown): boolean {
  if (!(error instanceof APIError)) {
    return false
  }
  return (
    error.status === 400 &&
    (error.message?.includes('Fast mode is not enabled') ?? false)
  )
}

export function is529Error(error: unknown): boolean {
  if (!(error instanceof APIError)) {
    return false
  }

  // 检查 529 状态码或消息中的 overloaded 错误
  return (
    error.status === 529 ||
    // 见下方：SDK 在流式传输时有时无法正确传递 529 状态码
    (error.message?.includes('"type":"overloaded_error"') ?? false)
  )
}

function isOAuthTokenRevokedError(error: unknown): boolean {
  return (
    error instanceof APIError &&
    error.status === 403 &&
    (error.message?.includes('OAuth token has been revoked') ?? false)
  )
}

function isBedrockAuthError(error: unknown): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)) {
    // 若 .aws 中有过期的 Expiration，AWS 库不做 API 调用就直接拒绝；
    // 否则，使用过期 token 的 API 调用会返回通用 403
    // "The security token included in the request is invalid"
    if (
      isAwsCredentialsProviderError(error) ||
      (error instanceof APIError && error.status === 403)
    ) {
      return true
    }
  }
  return false
}

/**
 * 在合适时清空 AWS 认证缓存。
 * @returns true 表示已采取动作。
 */
function handleAwsCredentialError(error: unknown): boolean {
  if (isBedrockAuthError(error)) {
    clearAwsCredentialsCache()
    return true
  }
  return false
}

// google-auth-library 抛出的是普通 Error（没有像 AWS 的
// CredentialsProviderError 那样的具名类型）。这里匹配常见的 SDK 层凭证失败消息。
function isGoogleAuthLibraryCredentialError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const msg = error.message
  return (
    msg.includes('Could not load the default credentials') ||
    msg.includes('Could not refresh access token') ||
    msg.includes('invalid_grant')
  )
}

function isVertexAuthError(error: unknown): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)) {
    // SDK 层：google-auth-library 在 HTTP 调用之前于 prepareOptions() 中失败
    if (isGoogleAuthLibraryCredentialError(error)) {
      return true
    }
    // 服务端：Vertex 对过期/无效 token 返回 401
    if (error instanceof APIError && error.status === 401) {
      return true
    }
  }
  return false
}

/**
 * 在合适时清空 GCP 认证缓存。
 * @returns true 表示已采取动作。
 */
function handleGcpCredentialError(error: unknown): boolean {
  if (isVertexAuthError(error)) {
    clearGcpCredentialsCache()
    return true
  }
  return false
}

function shouldRetry(error: APIError): boolean {
  // 绝不重试 mock 错误 —— 它们来自 /mock-limits 命令用于测试
  if (isMockRateLimitError(error)) {
    return false
  }

  // Persistent 模式：429/529 总是可重试，绕过订阅用户门槛和
  // x-should-retry 头。
  if (isPersistentRetryEnabled() && isTransientCapacityError(error)) {
    return true
  }

  // CCR 模式：认证走基础设施提供的 JWT，所以 401/403 是瞬时抖动
  // （认证服务抖动、网络打嗝），而不是凭证问题。绕过 x-should-retry:false ——
  // 服务端假设我们会用同一个坏 key 重试，但我们的 key 是好的。
  if (
    isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) &&
    (error.status === 401 || error.status === 403)
  ) {
    return true
  }

  // 先检查消息内容判断是否为 overloaded 错误
  // SDK 在流式传输时有时无法正确传递 529 状态码，
  // 所以需要直接检查错误消息
  if (error.message?.includes('"type":"overloaded_error"')) {
    return true
  }

  // 检查是否为我们能处理的 max tokens 上下文溢出错误
  if (parseMaxTokensContextOverflowError(error)) {
    return true
  }

  // 注意这不是标准头。
  const shouldRetryHeader = error.headers?.get('x-should-retry')

  // 若服务端明确表示是否重试，则遵从。
  // 对 Max 和 Pro 用户，should-retry 为 true，但往往要等几小时，所以我们不重试。
  // 企业用户可以重试，因为他们通常使用 PAYG 而非 rate limit。
  if (
    shouldRetryHeader === 'true' &&
    (!isClaudeAISubscriber() || isEnterpriseSubscriber())
  ) {
    return true
  }

  // ant 可以仅对 5xx 服务端错误忽略 x-should-retry: false。
  // 对其他状态码（401、403、400、429 等），遵循该头。
  if (shouldRetryHeader === 'false') {
    const is5xxError = error.status !== undefined && error.status >= 500
    if (!(process.env.USER_TYPE === 'ant' && is5xxError)) {
      return false
    }
  }

  if (error instanceof APIConnectionError) {
    return true
  }

  if (!error.status) return false

  // 请求超时则重试。
  if (error.status === 408) return true

  // 锁超时则重试。
  if (error.status === 409) return true

  // 限流则重试，但 ClaudeAI 订阅用户除外
  // 企业用户可以重试，因为他们通常使用 PAYG 而非 rate limit
  if (error.status === 429) {
    return !isClaudeAISubscriber() || isEnterpriseSubscriber()
  }

  // 401 时清空 API key 缓存并允许重试。
  // OAuth token 的处理在主重试循环中通过 handleOAuth401Error 完成。
  if (error.status === 401) {
    clearApiKeyHelperCache()
    return true
  }

  // 403 "token revoked" 时重试（与 401 的刷新逻辑相同，见上面）
  if (isOAuthTokenRevokedError(error)) {
    return true
  }

  // 内部错误则重试。
  if (error.status && error.status >= 500) return true

  return false
}

export function getDefaultMaxRetries(): number {
  if (process.env.CLAUDE_CODE_MAX_RETRIES) {
    return parseInt(process.env.CLAUDE_CODE_MAX_RETRIES, 10)
  }
  return DEFAULT_MAX_RETRIES
}
function getMaxRetries(options: RetryOptions): number {
  return options.maxRetries ?? getDefaultMaxRetries()
}

const DEFAULT_FAST_MODE_FALLBACK_HOLD_MS = 30 * 60 * 1000 // 30 分钟
const SHORT_RETRY_THRESHOLD_MS = 20 * 1000 // 20 秒
const MIN_COOLDOWN_MS = 10 * 60 * 1000 // 10 分钟

function getRetryAfterMs(error: APIError): number | null {
  const retryAfter = getRetryAfter(error)
  if (retryAfter) {
    const seconds = parseInt(retryAfter, 10)
    if (!isNaN(seconds)) {
      return seconds * 1000
    }
  }
  return null
}

function getRateLimitResetDelayMs(error: APIError): number | null {
  const resetHeader = error.headers?.get?.('anthropic-ratelimit-unified-reset')
  if (!resetHeader) return null
  const resetUnixSec = Number(resetHeader)
  if (!Number.isFinite(resetUnixSec)) return null
  const delayMs = resetUnixSec * 1000 - Date.now()
  if (delayMs <= 0) return null
  return Math.min(delayMs, PERSISTENT_RESET_CAP_MS)
}
