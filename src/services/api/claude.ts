// 用于将原始 SDK 事件流式传输至浏览器调试面板的调试接收端
type ApiRawSink = (event: unknown) => void
let _apiRawSink: ApiRawSink | null = null
export function setApiRawSink(sink: ApiRawSink | null): void {
  _apiRawSink = sink
}

import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaImageBlockParam,
  BetaJSONOutputFormat,
  BetaMessage,
  BetaMessageDeltaUsage,
  BetaMessageStreamParams,
  BetaOutputConfig,
  BetaRawMessageStreamEvent,
  BetaRequestDocumentBlock,
  BetaStopReason,
  BetaToolChoiceAuto,
  BetaToolChoiceTool,
  BetaToolResultBlockParam,
  BetaToolUnion,
  BetaUsage,
  BetaMessageParam as MessageParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { Stream } from '@anthropic-ai/sdk/streaming.mjs'
import { randomUUID } from 'crypto'
import { existsSync, unlinkSync } from 'node:fs'
import {
  getAPIProvider,
  isFirstPartyAnthropicBaseUrl,
} from 'src/utils/model/providers.js'
import {
  getAttributionHeader,
  getCLISyspromptPrefix,
} from '../../constants/system.js'
import {
  getEmptyToolPermissionContext,
  type QueryChainTracking,
  type Tool,
  type ToolPermissionContext,
  type Tools,
  toolMatchesName,
} from '../../Tool.js'
import type { AgentDefinition } from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import {
  type ConnectorTextBlock,
  type ConnectorTextDelta,
  isConnectorTextBlock,
} from '../../types/connectorText.js'
import type {
  AssistantMessage,
  Message,
  MessageContent,
  StreamEvent,
  SystemAPIErrorMessage,
  UserMessage,
} from '../../types/message.js'
import {
  type CacheScope,
  logAPIPrefix,
  splitSysPromptPrefix,
  toolToAPISchema,
} from '../../utils/api.js'
import { getOauthAccountInfo } from '../../utils/auth.js'
import {
  getBedrockExtraBodyParamsBetas,
  getMergedBetas,
  getModelBetas,
} from '../../utils/betas.js'
import { getOrCreateUserID } from '../../utils/config.js'
import {
  CAPPED_DEFAULT_MAX_TOKENS,
  getModelMaxOutputTokens,
  getSonnet1mExpTreatmentEnabled,
} from '../../utils/context.js'
import { resolveAppliedEffort } from '../../utils/effort.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { errorMessage } from '../../utils/errors.js'
import { computeFingerprintFromMessages } from '../../utils/fingerprint.js'
import { captureAPIRequest, logError } from '../../utils/log.js'
import {
  createAssistantAPIErrorMessage,
  createUserMessage,
  ensureToolResultPairing,
  normalizeContentFromAPI,
  normalizeMessagesForAPI,
  stripAdvisorBlocks,
  stripCallerFieldFromAssistantMessage,
  stripToolReferenceBlocksFromUserMessage,
} from '../../utils/messages.js'
import {
  getDefaultOpusModel,
  getDefaultSonnetModel,
  getSmallFastModel,
  isNonCustomOpusModel,
} from '../../utils/model/model.js'
import {
  asSystemPrompt,
  type SystemPrompt,
} from '../../utils/systemPromptType.js'
import {
  getBreakCacheMarkerPath,
  getBreakCacheAlwaysPath,
} from '../../commands/break-cache/index.js'
import { tokenCountFromLastAPIResponse } from '../../utils/tokens.js'
import { getDynamicConfig_BLOCKS_ON_INIT } from '../analytics/growthbook.js'
import {
  currentLimits,
  extractQuotaStatusFromError,
  extractQuotaStatusFromHeaders,
} from '../claudeAiLimits.js'
import { getAPIContextManagement } from '../compact/apiMicrocompact.js'
import { bedrockAdapter } from '../providerUsage/adapters/bedrock.js'
import { updateProviderBuckets } from '../providerUsage/store.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const autoModeStateModule = feature('TRANSCRIPT_CLASSIFIER')
  ? (require('../../utils/permissions/autoModeState.js') as typeof import('../../utils/permissions/autoModeState.js'))
  : null

import { feature } from 'bun:bundle'
import type { ClientOptions } from '@anthropic-ai/sdk'
import {
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from '@anthropic-ai/sdk/error'
import {
  getAfkModeHeaderLatched,
  getCacheEditingHeaderLatched,
  getFastModeHeaderLatched,
  getPromptCache1hAllowlist,
  getPromptCache1hEligible,
  getSessionId,
  setAfkModeHeaderLatched,
  setCacheEditingHeaderLatched,
  setFastModeHeaderLatched,
  setLastMainRequestId,
  setPromptCache1hAllowlist,
  setPromptCache1hEligible,
} from 'src/bootstrap/state.js'
import {
  AFK_MODE_BETA_HEADER,
  CONTEXT_1M_BETA_HEADER,
  CONTEXT_MANAGEMENT_BETA_HEADER,
  EFFORT_BETA_HEADER,
  FAST_MODE_BETA_HEADER,
  PROMPT_CACHING_SCOPE_BETA_HEADER,
  REDACT_THINKING_BETA_HEADER,
  STRUCTURED_OUTPUTS_BETA_HEADER,
  TASK_BUDGETS_BETA_HEADER,
} from 'src/constants/betas.js'
import type { QuerySource } from 'src/constants/querySource.js'
import type { Notification } from 'src/context/notifications.js'
import { addToTotalSessionCost } from 'src/cost-tracker.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import type { AgentId } from 'src/types/ids.js'
import {
  ADVISOR_TOOL_INSTRUCTIONS,
  getExperimentAdvisorModels,
  isAdvisorEnabled,
  isValidAdvisorModel,
  modelSupportsAdvisor,
} from 'src/utils/advisor.js'
import { getAgentContext } from 'src/utils/agentContext.js'
import { isClaudeAISubscriber } from 'src/utils/auth.js'
import {
  getToolSearchBetaHeader,
  modelSupportsStructuredOutputs,
  shouldIncludeFirstPartyOnlyBetas,
  shouldUseGlobalCacheScope,
} from 'src/utils/betas.js'
import { CLAUDE_IN_CHROME_MCP_SERVER_NAME } from 'src/utils/claudeInChrome/common.js'
import { CHROME_SEARCH_EXTRA_TOOLS_INSTRUCTIONS } from 'src/utils/claudeInChrome/prompt.js'
import { getMaxThinkingTokensForModel } from 'src/utils/context.js'
import { logForDebugging } from 'src/utils/debug.js'
import { logForDiagnosticsNoPII } from 'src/utils/diagLogs.js'
import { type EffortValue, modelSupportsEffort } from 'src/utils/effort.js'
import {
  isFastModeAvailable,
  isFastModeCooldown,
  isFastModeEnabled,
  isFastModeSupportedByModel,
} from 'src/utils/fastMode.js'
import { returnValue } from 'src/utils/generators.js'
import { headlessProfilerCheckpoint } from 'src/utils/headlessProfiler.js'
import { isMcpInstructionsDeltaEnabled } from 'src/utils/mcpInstructionsDelta.js'
import { calculateUSDCost } from 'src/utils/modelCost.js'
import { endQueryProfile, queryCheckpoint } from 'src/utils/queryProfiler.js'
import {
  modelSupportsAdaptiveThinking,
  modelSupportsThinking,
  type ThinkingConfig,
} from 'src/utils/thinking.js'
import {
  isDeferredToolsDeltaEnabled,
  isSearchExtraToolsEnabled,
} from 'src/utils/searchExtraTools.js'
import { API_MAX_MEDIA_PER_REQUEST } from '../../constants/apiLimits.js'
import { ADVISOR_BETA_HEADER } from '../../constants/betas.js'
import {
  formatDeferredToolLine,
  isDeferredTool,
  SEARCH_EXTRA_TOOLS_TOOL_NAME,
} from '@claude-code-best/builtin-tools/tools/SearchExtraToolsTool/prompt.js'
import { count } from '../../utils/array.js'
import { insertBlockAfterToolResults } from '../../utils/contentArray.js'
import { validateBoundedIntEnvVar } from '../../utils/envValidation.js'
import { safeParseJSON } from '../../utils/json.js'
import { getInferenceProfileBackingModel } from '../../utils/model/bedrock.js'
import {
  normalizeModelStringForAPI,
  parseUserSpecifiedModel,
} from '../../utils/model/model.js'
import {
  startSessionActivity,
  stopSessionActivity,
} from '../../utils/sessionActivity.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  isBetaTracingEnabled,
  type LLMRequestNewContext,
  startLLMRequestSpan,
} from '../../utils/telemetry/sessionTracing.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import {
  consumePendingCacheEdits,
  getPinnedCacheEdits,
  markToolsSentToAPIState,
  pinCacheEdits,
} from '../compact/microCompact.js'
import { getInitializationStatus } from '../lsp/manager.js'
import { isToolFromMcpServer } from '../mcp/utils.js'
import { recordLLMObservation } from '../langfuse/index.js'
import type { LangfuseSpan } from '../langfuse/index.js'
import {
  convertMessagesToLangfuse,
  convertOutputToLangfuse,
  convertToolsToLangfuse,
} from '../langfuse/convert.js'
import { withStreamingVCR, withVCR } from '../vcr.js'
import { CLIENT_REQUEST_ID_HEADER, getAnthropicClient } from './client.js'
import {
  API_ERROR_MESSAGE_PREFIX,
  CUSTOM_OFF_SWITCH_MESSAGE,
  getAssistantMessageFromError,
  getErrorMessageIfRefusal,
} from './errors.js'
import {
  EMPTY_USAGE,
  type GlobalCacheStrategy,
  logAPIError,
  logAPIQuery,
  logAPISuccessAndDuration,
  type NonNullableUsage,
} from './logging.js'
import {
  checkResponseForCacheBreak,
  recordPromptState,
} from './promptCacheBreakDetection.js'
import {
  CannotRetryError,
  FallbackTriggeredError,
  is529Error,
  type RetryContext,
  withRetry,
} from './withRetry.js'

// 表示合法 JSON 值的类型
type JsonValue = string | number | boolean | null | JsonObject | JsonArray
type JsonObject = { [key: string]: JsonValue }
type JsonArray = JsonValue[]

/**
 * 根据 CLAUDE_CODE_EXTRA_BODY 环境变量（若存在）和 beta 头（主要用于
 * Bedrock 请求）组装 API 请求的额外 body 参数。
 *
 * @param betaHeaders - 要包含在请求中的 beta 头数组。
 * @returns 表示额外 body 参数的 JSON 对象。
 */
export function getExtraBodyParams(betaHeaders?: string[]): JsonObject {
  // 先解析用户的额外 body 参数
  const extraBodyStr = process.env.CLAUDE_CODE_EXTRA_BODY
  let result: JsonObject = {}

  if (extraBodyStr) {
    try {
      // 以 JSON 解析，可为 null、boolean、number、string、array 或 object
      const parsed = safeParseJSON(extraBodyStr)
      // 期望是键值对对象，以便展开到 API 参数中
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // 浅拷贝 —— safeParseJSON 使用 LRU 缓存，对同一字符串返回同一对象引用。
        // 下面修改 `result` 会污染缓存，导致旧值残留。
        result = { ...(parsed as JsonObject) }
      } else {
        logForDebugging(
          `CLAUDE_CODE_EXTRA_BODY env var must be a JSON object, but was given ${extraBodyStr}`,
          { level: 'error' },
        )
      }
    } catch (error) {
      logForDebugging(
        `Error parsing CLAUDE_CODE_EXTRA_BODY: ${errorMessage(error)}`,
        { level: 'error' },
      )
    }
  }

  // 处理传入的 beta 头
  if (betaHeaders && betaHeaders.length > 0) {
    if (result.anthropic_beta && Array.isArray(result.anthropic_beta)) {
      // 加到已有数组中，避免重复
      const existingHeaders = result.anthropic_beta as string[]
      const newHeaders = betaHeaders.filter(
        header => !existingHeaders.includes(header),
      )
      result.anthropic_beta = [...existingHeaders, ...newHeaders]
    } else {
      // 用 beta 头新建数组
      result.anthropic_beta = betaHeaders
    }
  }

  return result
}

export function getPromptCachingEnabled(model: string): boolean {
  // 全局禁用优先
  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING)) {
    logForDebugging(
      `[Hapii][Cache] getPromptCachingEnabled: DISABLED by env DISABLE_PROMPT_CACHING`,
    )
    return false
  }

  // 检查是否要对 small/fast 模型禁用
  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING_HAIKU)) {
    const smallFastModel = getSmallFastModel()
    if (model === smallFastModel) {
      logForDebugging(
        `[Hapii][Cache] getPromptCachingEnabled: DISABLED for small/fast model=${model}`,
      )
      return false
    }
  }

  // 检查是否要对默认 Sonnet 禁用
  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING_SONNET)) {
    const defaultSonnet = getDefaultSonnetModel()
    if (model === defaultSonnet) {
      logForDebugging(
        `[Hapii][Cache] getPromptCachingEnabled: DISABLED for Sonnet model=${model}`,
      )
      return false
    }
  }

  // 检查是否要对默认 Opus 禁用
  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING_OPUS)) {
    const defaultOpus = getDefaultOpusModel()
    if (model === defaultOpus) {
      logForDebugging(
        `[Hapii][Cache] getPromptCachingEnabled: DISABLED for Opus model=${model}`,
      )
      return false
    }
  }

  logForDebugging(
    `[Hapii][Cache] getPromptCachingEnabled: ENABLED for model=${model}`,
  )
  return true
}

export function getCacheControl({
  scope,
  querySource,
}: {
  scope?: CacheScope
  querySource?: QuerySource
} = {}): {
  type: 'ephemeral'
  ttl?: '1h'
  scope?: CacheScope
} {
  const use1hTTL = should1hCacheTTL(querySource)
  const result = {
    type: 'ephemeral' as const,
    ...(use1hTTL && { ttl: '1h' as const }),
    ...(scope === 'global' && { scope: 'global' as const }),
  }
  logForDebugging(
    `[Hapii][Cache] getCacheControl: scope=${scope ?? 'none'} querySource=${querySource ?? 'none'} → ttl=${result.ttl ?? '5m'} scope=${result.scope ?? 'default'}`,
  )
  return result
}

/**
 * 判断是否应使用 1 小时 TTL 做 prompt 缓存。
 *
 * 仅在以下条件同时满足时启用：
 * 1. 用户符合资格（ant 或在限流内的订阅用户）
 * 2. query source 匹配 GrowthBook 白名单中的某个模式
 *
 * GrowthBook 配置结构：{ allowlist: string[] }
 * 模式支持尾部 '*' 做前缀匹配。
 * 示例：
 * - { allowlist: ["repl_main_thread*", "sdk"] } —— 仅主线程 + SDK
 * - { allowlist: ["repl_main_thread*", "sdk", "agent:*"] } —— 加上子 agent
 * - { allowlist: ["*"] } —— 全部 source
 *
 * 白名单会被缓存到 STATE 中以保持会话稳定性——防止 GrowthBook 磁盘缓存
 * 在请求中途刷新时出现混合的 TTL。
 */
function should1hCacheTTL(querySource?: QuerySource): boolean {
  // 第三方 Bedrock 用户在通过环境变量开启时获得 1 小时 TTL —— 他们自己管理账单
  // 无需 GrowthBook 门控，因为第三方用户未配置 GrowthBook
  if (
    getAPIProvider() === 'bedrock' &&
    isEnvTruthy(process.env.ENABLE_PROMPT_CACHING_1H_BEDROCK)
  ) {
    logForDebugging(
      `[Hapii][Cache] should1hCacheTTL: ENABLED for Bedrock via env`,
    )
    return true
  }

  // 将资格锁存在 bootstrap state 中，保持会话稳定性——防止会话中途
  // 超额状态切换改变了 cache_control 的 TTL，从而破坏服务端的 prompt 缓存
  // （每次切换约 2 万 token）。
  let userEligible = getPromptCache1hEligible()
  if (userEligible === null) {
    userEligible =
      process.env.USER_TYPE === 'ant' ||
      (isClaudeAISubscriber() && !currentLimits.isUsingOverage)
    setPromptCache1hEligible(userEligible)
    logForDebugging(
      `[Hapii][Cache] should1hCacheTTL: userEligible=${userEligible} (isAnt=${process.env.USER_TYPE === 'ant'}, isSubscriber=${isClaudeAISubscriber()}, isOverage=${currentLimits.isUsingOverage})`,
    )
  }
  if (!userEligible) {
    logForDebugging(
      `[Hapii][Cache] should1hCacheTTL: DISABLED — user not eligible (not ant/subscriber or using overage)`,
    )
    return false
  }

  // 将白名单缓存到 bootstrap state 中以保持会话稳定性——防止 GrowthBook
  // 磁盘缓存在请求中途刷新时出现混合的 TTL
  let allowlist = getPromptCache1hAllowlist()
  if (allowlist === null) {
    const config = getFeatureValue_CACHED_MAY_BE_STALE<{
      allowlist?: string[]
    }>('tengu_prompt_cache_1h_config', {})
    allowlist = config.allowlist ?? []
    setPromptCache1hAllowlist(allowlist)
    logForDebugging(
      `[Hapii][Cache] should1hCacheTTL: loaded allowlist from GrowthBook: [${allowlist.join(', ')}]`,
    )
  }

  const matched =
    querySource !== undefined &&
    allowlist.some(pattern =>
      pattern.endsWith('*')
        ? querySource.startsWith(pattern.slice(0, -1))
        : querySource === pattern,
    )
  logForDebugging(
    `[Hapii][Cache] should1hCacheTTL: querySource=${querySource ?? 'undefined'} matched=${matched} allowlist=[${allowlist.join(', ')}]`,
  )
  return matched
}

/**
 * 为 API 请求配置 effort 参数。
 */
function configureEffortParams(
  effortValue: EffortValue | undefined,
  outputConfig: BetaOutputConfig,
  extraBodyParams: Record<string, unknown>,
  betas: string[],
  model: string,
): void {
  if (!modelSupportsEffort(model) || 'effort' in outputConfig) {
    return
  }

  if (effortValue === undefined) {
    betas.push(EFFORT_BETA_HEADER) // 用 beta 头让 API 自己决定
  } else if (typeof effortValue === 'string') {
    // 字符串形式的 effort 级别原样发送
    outputConfig.effort = effortValue as 'high' | 'medium' | 'low' | 'max'
    betas.push(EFFORT_BETA_HEADER) // 显式设置 effort 级别
  } else if (process.env.USER_TYPE === 'ant') {
    // 数值形式的 effort 覆盖 —— 仅限 ant（使用 anthropic_internal）
    const existingInternal =
      (extraBodyParams.anthropic_internal as Record<string, unknown>) || {}
    extraBodyParams.anthropic_internal = {
      ...existingInternal,
      effort_override: effortValue,
    }
  }
}

// output_config.task_budget —— 让模型感知 API 侧的 token 预算。
// Stainless SDK 类型还没有把 task_budget 加到 BetaOutputConfig 上，因此
// 我们在本地定义线上结构并做类型转换。API 在收到时会校验；参见 monorepo
// 中的 api/api/schemas/messages/request/output_config.py:12-39。
// Beta：task-budgets-2026-03-13（EAP，截至 2026 年 3 月仅 claude-strudel-eap 可用）。
type TaskBudgetParam = {
  type: 'tokens'
  total: number
  remaining?: number
}

export function configureTaskBudgetParams(
  taskBudget: Options['taskBudget'],
  outputConfig: BetaOutputConfig & { task_budget?: TaskBudgetParam },
  betas: string[],
): void {
  if (
    !taskBudget ||
    'task_budget' in outputConfig ||
    !shouldIncludeFirstPartyOnlyBetas()
  ) {
    return
  }
  outputConfig.task_budget = {
    type: 'tokens',
    total: taskBudget.total,
    ...(taskBudget.remaining !== undefined && {
      remaining: taskBudget.remaining,
    }),
  }
  if (!betas.includes(TASK_BUDGETS_BETA_HEADER)) {
    betas.push(TASK_BUDGETS_BETA_HEADER)
  }
}

export function getAPIMetadata() {
  // https://docs.google.com/document/d/1dURO9ycXXQCBS0V4Vhl4poDBRgkelFc5t2BNPoEgH5Q/edit?tab=t.0#heading=h.5g7nec5b09w5
  let extra: JsonObject = {}
  const extraStr = process.env.CLAUDE_CODE_EXTRA_METADATA
  if (extraStr) {
    const parsed = safeParseJSON(extraStr, false)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      extra = parsed as JsonObject
    } else {
      logForDebugging(
        `CLAUDE_CODE_EXTRA_METADATA env var must be a JSON object, but was given ${extraStr}`,
        { level: 'error' },
      )
    }
  }

  return {
    user_id: jsonStringify({
      ...extra,
      device_id: getOrCreateUserID(),
      // 仅在实际使用 OAuth 认证时才包含 OAuth 账户 UUID
      account_uuid: getOauthAccountInfo()?.accountUuid ?? '',
      session_id: getSessionId(),
    }),
  }
}

export async function verifyApiKey(
  apiKey: string,
  isNonInteractiveSession: boolean,
): Promise<boolean> {
  logForDebugging(
    `-------------- verifyApiKey 开始 ----------- isNonInteractiveSession=${isNonInteractiveSession}`,
    { level: 'info' },
  )
  // 如果运行在 print 模式（isNonInteractiveSession）下，跳过 API 校验
  if (isNonInteractiveSession) {
    logForDebugging(
      `------------ verifyApiKey 结束 (skipped_non_interactive) ---------`,
      { level: 'info' },
    )
    return true
  }

  try {
    // 警告：如果改成使用非 Haiku 的模型，除非使用 getCLISyspromptPrefix，否则在 1P 下该请求会失败。
    const model = getSmallFastModel()
    const betas = getModelBetas(model)
    logForDebugging(`[Hapii] verifyApiKey — 发送测试请求 model=${model}`, {
      level: 'info',
    })
    const result = await returnValue(
      withRetry(
        () =>
          getAnthropicClient({
            apiKey,
            maxRetries: 3,
            model,
            source: 'verify_api_key',
          }),
        async anthropic => {
          const messages: MessageParam[] = [{ role: 'user', content: 'test' }]
          await anthropic.beta.messages.create({
            model,
            max_tokens: 1,
            messages,
            temperature: 1,
            ...(betas.length > 0 && { betas: betas.filter(Boolean) }),
            metadata: getAPIMetadata(),
            ...getExtraBodyParams(),
          })
          return true
        },
        { maxRetries: 2, model, thinkingConfig: { type: 'disabled' } }, // API key 校验使用更少的重试次数
      ),
    )
    logForDebugging(
      `------------ verifyApiKey 结束 (success) --------- result=${result}`,
      { level: 'info' },
    )
    return result
  } catch (errorFromRetry) {
    let error = errorFromRetry
    if (errorFromRetry instanceof CannotRetryError) {
      error = errorFromRetry.originalError
    }
    logError(error)
    // 检查是否为认证错误
    if (
      error instanceof Error &&
      error.message.includes(
        '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
      )
    ) {
      logForDebugging(`------------ verifyApiKey 结束 (auth_error) ---------`, {
        level: 'error',
      })
      return false
    }
    logForDebugging(
      `------------ verifyApiKey 结束 (error) --------- error=${error instanceof Error ? error.message : String(error)}`,
      { level: 'error' },
    )
    throw error
  }
}

export function userMessageToMessageParam(
  message: UserMessage,
  addCache = false,
  enablePromptCaching: boolean,
  querySource?: QuerySource,
): MessageParam {
  if (addCache) {
    if (typeof message.message!.content === 'string') {
      return {
        role: 'user',
        content: [
          {
            type: 'text',
            text: message.message!.content,
            ...(enablePromptCaching && {
              cache_control: getCacheControl({ querySource }),
            }),
          },
        ],
      }
    } else {
      return {
        role: 'user',
        content: message.message!.content!.map((_, i) => ({
          ..._,
          ...(i === message.message!.content!.length - 1
            ? enablePromptCaching
              ? { cache_control: getCacheControl({ querySource }) }
              : {}
            : {}),
        })),
      }
    }
  }
  // 克隆数组内容，避免原地修改（例如 insertCacheEditsBlock 的 splice）
  // 污染原始消息。不克隆的话，多次调用 addCacheBreakpoints 会共享同一数组，
  // 每次都 splice 进重复的 cache_edits。
  return {
    role: 'user',
    content: (Array.isArray(message.message!.content)
      ? [...message.message!.content]
      : message.message!
          .content) as import('@anthropic-ai/sdk/resources/beta/messages/messages.js').BetaContentBlockParam[],
  }
}

export function assistantMessageToMessageParam(
  message: AssistantMessage,
  addCache = false,
  enablePromptCaching: boolean,
  querySource?: QuerySource,
): MessageParam {
  if (addCache) {
    if (typeof message.message!.content === 'string') {
      return {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: message.message!.content,
            ...(enablePromptCaching && {
              cache_control: getCacheControl({ querySource }),
            }),
          },
        ],
      }
    } else {
      // 理解要点：
      // - thinking / redacted_thinking 块不加 cache_control 标记 —— 它们作为 assistant 消息的一部分被传回 API，但不作为缓存断点
      // - 这对应文档说的「思考块会被缓存，并在从缓存读取时计为输入令牌」—— 通过上一段的系统缓存被带上，但不会单独成为缓存断点

      // 5.3 为什么必须原样传回
      // 文档说修改 thinking 块会得到 400 错误 thinking blocks cannot be modified。源码侧的对应处理在
      // normalizeMessagesForAPI：
      // - 它合并相同 message.id 的 assistant 消息
      // - 它通过 ensureToolResultPairing 修复 tool_use/tool_result 错位
      // - 但从不修改 thinking 块的内容 —— thinking 块只是被原样搬运
      return {
        role: 'assistant',
        content: message.message!.content!.map((_, i) => {
          const contentBlock = stripGeminiProviderMetadata(_)
          return {
            ...contentBlock,
            ...(i === message.message!.content!.length - 1 &&
            contentBlock.type !== 'thinking' && // ← 关键！
            contentBlock.type !== 'redacted_thinking' && // ← 关键！
            (feature('CONNECTOR_TEXT')
              ? !isConnectorTextBlock(contentBlock)
              : true)
              ? enablePromptCaching
                ? { cache_control: getCacheControl({ querySource }) }
                : {}
              : {}),
          }
        }),
      }
    }
  }
  return {
    role: 'assistant',
    content:
      typeof message.message!.content === 'string'
        ? message.message!.content
        : (message.message!.content!.map(
            stripGeminiProviderMetadata,
          ) as BetaContentBlockParam[]),
  }
}

function stripGeminiProviderMetadata<T extends BetaContentBlockParam | string>(
  contentBlock: T,
): T {
  if (
    typeof contentBlock === 'string' ||
    !('_geminiThoughtSignature' in (contentBlock as object))
  ) {
    return contentBlock
  }

  const obj = contentBlock as unknown as Record<string, unknown>
  const { _geminiThoughtSignature: _unusedGeminiThoughtSignature, ...rest } =
    obj
  return rest as unknown as T
}

export type Options = {
  /**
   * 获取当前工具权限上下文的回调。
   * 返回 PermissionMode（'default'|'plan'|'bypassPermissions' 等）、
   * alwaysAllow/alwaysDeny/alwaysAsk 规则列表等，供每个 tool 的 prompt()
   * 方法根据权限状态生成不同的工具描述文本，也用于日志/分析。
   */
  getToolPermissionContext: () => Promise<ToolPermissionContext>

  /**
   * 请求的目标模型 ID（如 'claude-opus-4-7'、'claude-sonnet-4-5'）。
   * 在 Bedrock 场景下可能是 Inference Profile ARN，会先经过 resolvedModel 解析。
   * 遇到 529 过载错误时可能被 fallbackModel 替换。
   */
  model: string

  /**
   * 工具选择策略：
   * - { type: 'auto' }：模型自行决定是否使用工具（默认）
   * - { type: 'tool', name: string }：强制模型调用指定工具
   * - undefined：由 API 端默认行为处理
   * 常用于 compact 等辅助查询中限制模型行为。
   */
  toolChoice?: BetaToolChoiceTool | BetaToolChoiceAuto | undefined

  /**
   * 是否为非交互式会话。
   * true = CLI 管道模式（-p flag）或 SDK 调用，使用 AGENT_SDK_PREFIX 系统提示词，
   *       跳过 API key 验证，不显示缓存警告。
   * false = 交互式 REPL 终端，使用 DEFAULT_PREFIX 系统提示词。
   */
  isNonInteractiveSession: boolean

  /**
   * 追加到标准工具列表之外的额外工具 schema。
   * 典型用例：advisor 服务端工具（advisor_20260301）、WebSearch 工具等。
   * 这些工具不来自本地 Tool 注册表，而是由 API 侧直接提供服务。
   */
  extraToolSchemas?: BetaToolUnion[]

  /**
   * 覆盖模型默认的最大输出 token 数。
   * 典型场景：上下文超限恢复、速率限制降级时临时压缩输出长度，
   * 强制模型给出更短的回复以避免再次触发限制。
   */
  maxOutputTokensOverride?: number

  /**
   * 降级模型 ID。当主模型连续返回 529（过载）错误达到阈值时，
   * withRetry 抛出 FallbackTriggeredError，query.ts 捕获后
   * 将 currentModel 切换到 fallbackModel 并重试。
   * 常见组合：主用 Opus → 降级到 Sonnet。
   */
  fallbackModel?: string

  /**
   * 流式请求失败、降级到非流式模式时的回调。
   * 用于通知调用方（如 query.ts）更新 UI 状态或记录降级事件。
   */
  onStreamingFallback?: () => void

  /**
   * 标识本次 API 调用的业务来源（如 'repl_main_thread'、'agent:custom'、
   * 'compact'、'extract_memories' 等）。
   * 用于：遥测分析、isAgenticQuery 判断、529 重试策略选择、
   *       缓存 TTL 控制、功能开关（Advisor、AFK 模式等）。
   */
  querySource: QuerySource

  /**
   * 当前可用的 agent 定义列表（内置 + 用户自定义 + 插件）。
   * 传递给 AgentTool 的 prompt() 方法，让模型知道可以 spawn 哪些子代理，
   * 每个代理的 whenToUse、可用工具、隔离模式等信息。
   */
  agents: AgentDefinition[]

  /**
   * agent 类型白名单过滤器。设置后只有列表中的 agent 类型可被 spawn。
   * 用于策略管控场景（如管理员限制可用代理类型），undefined 表示不限制。
   */
  allowedAgentTypes?: string[]

  /**
   * 是否设置了 appendSystemPrompt（附加系统提示词）。
   * 影响系统提示词前缀选择：
   * - 非交互 + hasAppendSystemPrompt → AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX
   * - 非交互 + 无附加提示词 → AGENT_SDK_PREFIX
   * - 交互模式 → DEFAULT_PREFIX
   */
  hasAppendSystemPrompt: boolean

  /**
   * 覆盖 Anthropic SDK 默认的 fetch 函数。
   * 用于「dump prompts」调试功能——拦截并记录发送给 API 的请求体，
   * 仅对内部用户（USER_TYPE=ant）启用。
   */
  fetchOverride?: ClientOptions['fetch']

  /**
   * 是否启用 Prompt Caching（提示缓存）。
   * true/false = 显式覆盖；undefined = 自动检测（根据模型/环境变量决定）。
   * 启用后会在系统提示词和消息上添加 cache_control: { type: 'ephemeral' } 标记。
   * 可通过 DISABLE_PROMPT_CACHING / DISABLE_PROMPT_CACHING_HAIKU 等环境变量关闭。
   */
  enablePromptCaching?: boolean

  /**
   * 跳过缓存写入。为 true 时将缓存断点从最后一条消息移到倒数第二条，
   * 用于「发射即忘」的子代理调用——这些调用的结果不会被复用，
   * 写缓存条目是浪费。
   */
  skipCacheWrite?: boolean

  /**
   * 覆盖默认温度值（默认 1.0）。
   * 注意：仅在 thinking（思考模式）关闭时生效，API 要求
   * thinking 模式下 temperature 必须为 1。
   * 用于辅助查询（side_question、extract_memories 等）控制创造力。
   */
  temperatureOverride?: number

  /**
   * 模型推理力度等级，控制模型「思考多少再回答」。
   * 可选值：'low' | 'medium' | 'high' | 'xhigh' | 'max' 或数值（内部用户）。
   * 映射为 API 参数 output_config.effort，通过 /effort 命令或
   * CLAUDE_CODE_EFFORT_LEVEL 环境变量设置。
   */
  effortValue?: EffortValue

  /**
   * MCP（Model Context Protocol）服务器提供的工具列表。
   * 与内置工具分开管理，独立追加到 API 请求的 tools 数组中。
   * 还影响缓存策略：MCP 工具是 per-user 的，不能走全局缓存。
   */
  mcpTools: Tools

  /**
   * 是否有 MCP 服务器仍在连接中（未完成初始化）。
   * 为 true 时，即使当前没有延迟加载工具，也保持 SearchExtraTools 可用，
   * 让模型能发现正在连接中的服务器提供的工具。
   */
  hasPendingMcpServers?: boolean

  /**
   * 查询链追踪信息，记录本次调用在整个调用链中的位置。
   * chainId：整条链的唯一 ID（主线程 → 子代理 → 嵌套子代理共享同一 ID）
   * depth：嵌套深度（0 = 主线程，1 = 子代理，2 = 嵌套子代理……）
   * 用于日志关联、分析归因。
   */
  queryTracking?: QueryChainTracking

  /** 当前子代理的唯一标识。undefined 表示主线程（非子代理调用）。 */
  agentId?: AgentId

  /**
   * 结构化 JSON 输出格式定义（{ type: 'json_schema', schema: {...} }）。
   * 启用后模型输出必须符合指定 JSON Schema，使用 Anthropic structured outputs beta。
   * 通过 --json-schema CLI 参数或代码中特定场景（如 queryHaiku）设置。
   */
  outputFormat?: BetaJSONOutputFormat

  /**
   * 是否启用 Fast Mode（快速模式）。
   * 在请求中设置 speed: 'fast'，换取更快的响应速度（可能牺牲质量）。
   * 需同时满足：功能开关开启 + 模型支持 + 未在限速冷却期 + 用户主动启用。
   * 限速后可能自动进入冷却期。
   */
  fastMode?: boolean

  /**
   * Advisor（顾问）模型 ID。启用后向 API 注册 advisor 服务端工具，
   * 主模型在推理过程中可以「请教」一个更强的 reviewer 模型获取指导。
   * 通过 /advisor 命令设置，需要模型支持（如 Opus 4-7+）。
   */
  advisorModel?: string

  /**
   * UI 通知推送回调。用于在终端 TUI 中显示横幅警告/信息，
   * 如 auto-mode 拒绝通知、达到最大轮次警告等。
   * 非交互场景下为 undefined。
   */
  addNotification?: (notif: Notification) => void

  // API 侧任务预算（output_config.task_budget）。与 tokenBudget.ts 里
  // +50 万的自动续写功能不同——这个会发送给 API，让模型自己掌握节奏。
  // `remaining` 由调用方计算（query.ts 在 agent 循环中递减）。
  taskBudget?: { total: number; remaining?: number }

  /** 用于可观测性的 Langfuse 根 trace span。为 null/undefined 时是 no-op。 */
  langfuseTrace?: LangfuseSpan | null
}

export async function queryModelWithoutStreaming({
  messages,
  systemPrompt,
  thinkingConfig,
  tools,
  signal,
  options,
}: {
  messages: Message[]
  systemPrompt: SystemPrompt
  thinkingConfig: ThinkingConfig
  tools: Tools
  signal: AbortSignal
  options: Options
}): Promise<AssistantMessage> {
  logForDebugging(
    `-------------- queryModelWithoutStreaming 开始 ----------- messages=${messages.length} model=${options.model} tools=${tools.length} source=${options.querySource}`,
    { level: 'info' },
  )
  // 存下 assistant 消息，但继续消费生成器，确保 logAPISuccessAndDuration
  // 会被调用（它在所有 yield 之后发生）
  let assistantMessage: AssistantMessage | undefined
  for await (const message of withStreamingVCR(messages, async function* () {
    yield* queryModel(
      messages,
      systemPrompt,
      thinkingConfig,
      tools,
      signal,
      options,
    )
  })) {
    if (message.type === 'assistant') {
      assistantMessage = message as AssistantMessage
    }
  }
  if (!assistantMessage) {
    // 如果 signal 已中止，抛出 APIUserAbortError 而非通用错误
    // 这样调用方可以优雅地处理中止场景
    if (signal.aborted) {
      logForDebugging(
        `------------ queryModelWithoutStreaming 结束 (aborted) ---------`,
        { level: 'warn' },
      )
      throw new APIUserAbortError()
    }
    logForDebugging(
      `------------ queryModelWithoutStreaming 结束 (no_assistant_message) ---------`,
      { level: 'error' },
    )
    throw new Error('No assistant message found')
  }
  logForDebugging(
    `------------ queryModelWithoutStreaming 结束 --------- model=${options.model}`,
    { level: 'info' },
  )
  return assistantMessage
}

export async function* queryModelWithStreaming({
  messages,
  systemPrompt,
  thinkingConfig,
  tools,
  signal,
  options,
}: {
  messages: Message[]
  systemPrompt: SystemPrompt
  thinkingConfig: ThinkingConfig
  tools: Tools
  signal: AbortSignal
  options: Options
}): AsyncGenerator<
  StreamEvent | AssistantMessage | SystemAPIErrorMessage,
  void
> {
  logForDebugging(
    `-------------- queryModelWithStreaming 开始 ----------- model=${options.model} messages=${messages.length} tools=${tools.length} source=${options.querySource}`,
    { level: 'info' },
  )
  return yield* withStreamingVCR(messages, async function* () {
    yield* queryModel(
      messages,
      systemPrompt,
      thinkingConfig,
      tools,
      signal,
      options,
    )
  })
}

/**
 * 判断一个 LSP 工具是否应当被延迟加载（工具以 defer_loading: true 出现），
 * 因为 LSP 初始化尚未完成。
 */
function shouldDeferLspTool(tool: Tool): boolean {
  if (!('isLsp' in tool) || !tool.isLsp) {
    return false
  }
  const status = getInitializationStatus()
  // pending 或 not-started 时延迟
  return status.status === 'pending' || status.status === 'not-started'
}

/**
 * 非流式降级请求每次尝试的超时时间（毫秒）。
 * 设置了 API_TIMEOUT_MS 时读取它，使慢后端和流式路径共享同一上限。
 *
 * 远端会话默认 120 秒，低于 CCR 的容器空闲杀死阈值（约 5 分钟），
 * 这样对卡住的后端的降级会得到干净的 APIConnectionTimeoutError，
 * 而不是一直卡到被 SIGKILL。
 *
 * 否则默认 300 秒——既能覆盖慢后端，又不至于逼近 API 的 10 分钟非流式上限。
 */
function getNonstreamingFallbackTimeoutMs(): number {
  const override = parseInt(process.env.API_TIMEOUT_MS || '', 10)
  if (override) return override
  return isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) ? 120_000 : 300_000
}

/**
 * 非流式 API 请求的辅助生成器。
 * 封装了创建 withRetry 生成器、迭代 yield 系统消息、返回最终 BetaMessage
 * 的通用模式。
 */
export async function* executeNonStreamingRequest(
  clientOptions: {
    model: string
    fetchOverride?: Options['fetchOverride']
    source: string
  },
  retryOptions: {
    model: string
    fallbackModel?: string
    thinkingConfig: ThinkingConfig
    fastMode?: boolean
    signal: AbortSignal
    initialConsecutive529Errors?: number
    querySource?: QuerySource
  },
  paramsFromContext: (context: RetryContext) => BetaMessageStreamParams,
  onAttempt: (attempt: number, start: number, maxOutputTokens: number) => void,
  captureRequest: (params: BetaMessageStreamParams) => void,
  /**
   * 此降级正在恢复的那次失败流式请求的 request ID。
   * 在 tengu_nonstreaming_fallback_error 中上报用于漏斗关联。
   */
  originatingRequestId?: string | null,
): AsyncGenerator<SystemAPIErrorMessage, BetaMessage> {
  const fallbackTimeoutMs = getNonstreamingFallbackTimeoutMs()
  logForDebugging(
    `-------------- executeNonStreamingRequest 开始 ----------- model=${retryOptions.model} source=${clientOptions.source} timeoutMs=${fallbackTimeoutMs}`,
    { level: 'warn' },
  )
  const generator = withRetry(
    () =>
      getAnthropicClient({
        maxRetries: 0,
        model: clientOptions.model,
        fetchOverride: clientOptions.fetchOverride,
        source: clientOptions.source,
      }),
    async (anthropic, attempt, context) => {
      const start = Date.now()
      const retryParams = paramsFromContext(context)
      captureRequest(retryParams)
      onAttempt(attempt, start, retryParams.max_tokens)

      const adjustedParams = adjustParamsForNonStreaming(
        retryParams,
        MAX_NON_STREAMING_TOKENS,
      )

      try {
        return await anthropic.beta.messages.create(
          {
            ...adjustedParams,
            model: normalizeModelStringForAPI(adjustedParams.model),
          },
          {
            signal: retryOptions.signal,
            timeout: fallbackTimeoutMs,
          },
        )
      } catch (err) {
        // 用户中止不算错误 —— 立即重新抛出，不记录日志
        if (err instanceof APIUserAbortError) throw err

        // 埋点：记录非流式请求出错（包括超时）的时间点。用于区分
        // "降级在容器被杀之前一直卡住"（无事件）和"降级命中了有界超时"
        // （此事件）。
        logForDiagnosticsNoPII('error', 'cli_nonstreaming_fallback_error')
        logEvent('tengu_nonstreaming_fallback_error', {
          model:
            clientOptions.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          error:
            err instanceof Error
              ? (err.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
              : ('unknown' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS),
          attempt,
          timeout_ms: fallbackTimeoutMs,
          request_id: (originatingRequestId ??
            'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        throw err
      }
    },
    {
      model: retryOptions.model,
      fallbackModel: retryOptions.fallbackModel,
      thinkingConfig: retryOptions.thinkingConfig,
      ...(isFastModeEnabled() && { fastMode: retryOptions.fastMode }),
      signal: retryOptions.signal,
      initialConsecutive529Errors: retryOptions.initialConsecutive529Errors,
      querySource: retryOptions.querySource,
    },
  )

  let e
  do {
    e = await generator.next()
    if (!e.done && e.value.type === 'system') {
      yield e.value
    }
  } while (!e.done)

  logForDebugging(
    `------------ executeNonStreamingRequest 结束 --------- model=${retryOptions.model} stopReason=${(e.value as BetaMessage)?.stop_reason ?? 'N/A'}`,
    { level: 'info' },
  )
  return e.value as BetaMessage
}

/**
 * 从会话中最近一条 assistant 消息提取 request ID。用于在分析中将连续的
 * API 请求关联起来，以便做缓存命中率分析和增量 token 跟踪。
 *
 * 从消息数组（而非全局 state）中推导，确保每条查询链（主线程、子 agent、
 * 队友）各自独立追踪自己的请求链，回滚/撤销时也会自然更新该值。
 */
function getPreviousRequestIdFromMessages(
  messages: Message[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.type === 'assistant' && msg.requestId) {
      return msg.requestId as string
    }
  }
  return undefined
}

function isMedia(
  block: BetaContentBlockParam,
): block is BetaImageBlockParam | BetaRequestDocumentBlock {
  return block.type === 'image' || block.type === 'document'
}

function isToolResult(
  block: BetaContentBlockParam,
): block is BetaToolResultBlockParam {
  return block.type === 'tool_result'
}

/**
 * 确保消息最多包含 `limit` 个媒体项（图片 + 文档）。
 * 优先剔除最旧的媒体以保留最新的。
 */
export function stripExcessMediaItems(
  messages: (UserMessage | AssistantMessage)[],
  limit: number,
): (UserMessage | AssistantMessage)[] {
  let toRemove = 0
  for (const msg of messages) {
    if (!Array.isArray(msg.message!.content)) continue
    for (const block of msg.message!.content) {
      if (isMedia(block)) toRemove++
      if (isToolResult(block) && Array.isArray(block.content)) {
        for (const nested of block.content) {
          if (isMedia(nested as BetaContentBlockParam)) toRemove++
        }
      }
    }
  }
  toRemove -= limit
  if (toRemove <= 0) return messages

  return messages.map(msg => {
    if (toRemove <= 0) return msg
    const content = msg.message!.content
    if (!Array.isArray(content)) return msg

    const before = toRemove
    const stripped = content
      .map(block => {
        if (
          toRemove <= 0 ||
          !isToolResult(block) ||
          !Array.isArray(block.content)
        )
          return block
        const filtered = block.content.filter(n => {
          if (toRemove > 0 && isMedia(n as BetaContentBlockParam)) {
            toRemove--
            return false
          }
          return true
        })
        return filtered.length === block.content.length
          ? block
          : { ...block, content: filtered }
      })
      .filter(block => {
        if (toRemove > 0 && isMedia(block)) {
          toRemove--
          return false
        }
        return true
      })

    return before === toRemove
      ? msg
      : {
          ...msg,
          message: { ...msg.message, content: stripped },
        }
  }) as (UserMessage | AssistantMessage)[]
}

/**
 * 模块级缓存：已经通过 <available-deferred-tools> 公告过的延迟工具行。
 * 因为注入是临时的（追加到本地 `messagesForAPI`，不会回写到调用方的
 * 消息历史），我们无法扫描历史来检测之前的注入——每次 API 调用后
 * 注入的消息都不复存在。我们保留这个 Set，仅在出现新的延迟工具时
 * （例如 MCP 服务器连接）才重新注入。
 */
const lastAnnouncedDeferredTools = new Set<string>()

async function* queryModel(
  messages: Message[],
  systemPrompt: SystemPrompt,
  thinkingConfig: ThinkingConfig,
  tools: Tools,
  signal: AbortSignal,
  options: Options,
): AsyncGenerator<
  StreamEvent | AssistantMessage | SystemAPIErrorMessage,
  void
> {
  logForDebugging(
    `-------------- queryModel 开始 ----------- model=${options.model} messages=${messages.length} tools=${tools.length} source=${options.querySource} agentId=${options.agentId ?? 'main'}`,
    { level: 'info' },
  )
  // 先检查廉价条件——off-switch 的 await 会阻塞 GrowthBook 初始化
  // （约 10ms）。对非 Opus 模型（haiku、sonnet）可以直接跳过 await。
  // 订阅用户根本不会走到这条路径。

  // 段判断本质上是 Opus 模型的"应急容量关闭开关"（off-switch / kill switch）——当 Anthropic 后端
  // Opus 容量吃紧时，可以远程把一部分用户从 Opus 上挡下来，引导他们切到 Sonnet。
  if (
    !isClaudeAISubscriber() && // 非订阅用户
    isNonCustomOpusModel(options.model) && // 用的是官方 Opus 模型
    (
      await getDynamicConfig_BLOCKS_ON_INIT<{ activated: boolean }>(
        'tengu-off-switch',
        {
          activated: false,
        },
      )
    ).activated // 开关已激活
  ) {
    logEvent('tengu_off_switch_query', {})
    yield getAssistantMessageFromError(
      new Error(CUSTOM_OFF_SWITCH_MESSAGE),
      options.model,
    )
    return
  }

  // 从本查询链中最后一条 assistant 消息推导出上一个 request ID。
  // 按消息数组做作用域隔离（主线程、子 agent、队友各自独立），这样并发 agent 之间不会相互覆盖对方的请求链跟踪。
  // 同时天然支持回滚/撤销——被删除的消息不会出现在数组里。
  const previousRequestId = getPreviousRequestIdFromMessages(messages)

  const resolvedModel =
    getAPIProvider() === 'bedrock' &&
    options.model.includes('application-inference-profile')
      ? ((await getInferenceProfileBackingModel(options.model)) ??
        options.model)
      : options.model

  queryCheckpoint('query_tool_schema_build_start')
  const isAgenticQuery =
    options.querySource.startsWith('repl_main_thread') ||
    options.querySource.startsWith('agent:') ||
    options.querySource === 'sdk' ||
    options.querySource === 'hook_agent' ||
    options.querySource === 'verification_agent'
  const betas = getMergedBetas(options.model, { isAgenticQuery })

  // advisor 启用时始终发送 advisor beta 头，使非 agentic 查询
  // （compact、side_question、extract_memories 等）可以解析会话历史中 - 已有的 advisor server_tool_use 块。
  if (isAdvisorEnabled()) {
    betas.push(ADVISOR_BETA_HEADER)
  }

  let advisorModel: string | undefined
  if (isAgenticQuery && isAdvisorEnabled()) {
    let advisorOption = options.advisorModel

    const advisorExperiment = getExperimentAdvisorModels()
    if (advisorExperiment !== undefined) {
      if (
        normalizeModelStringForAPI(advisorExperiment.baseModel) ===
        normalizeModelStringForAPI(options.model)
      ) {
        // 当基础模型匹配时覆盖 advisor 模型。只有当用户无法自行配置
        // advisor 模型时，实验模型才应该存在。
        advisorOption = advisorExperiment.advisorModel
      }
    }

    if (advisorOption) {
      const normalizedAdvisorModel = normalizeModelStringForAPI(
        parseUserSpecifiedModel(advisorOption),
      )
      if (!modelSupportsAdvisor(options.model)) {
        logForDebugging(
          `[AdvisorTool] Skipping advisor - base model ${options.model} does not support advisor`,
        )
      } else if (!isValidAdvisorModel(normalizedAdvisorModel)) {
        logForDebugging(
          `[AdvisorTool] Skipping advisor - ${normalizedAdvisorModel} is not a valid advisor model`,
        )
      } else {
        advisorModel = normalizedAdvisorModel
        logForDebugging(
          `[AdvisorTool] Server-side tool enabled with ${advisorModel} as the advisor model`,
        )
      }
    }
  }
  // ------------------------------------------------------
  /**
   * 这段代码在做一件事：决定这次请求要把哪些工具的完整定义（schema）真正发给
    模型。 核心目的是省 token、保住 prompt 缓存——不是所有工具都值得每次都发给 AI。
    这套机制叫 SearchExtraTools（工具搜索 / 延迟加载）。
   */
  // ① 决定要不要启用这套机制 ENABLE_SEARCH_EXTRA_TOOLS=false
  // 检查是否启用了工具搜索（检查模式、模型支持以及 auto 模式的阈值） 是异步的，因为 TstAuto 模式可能需要计算 MCP 工具描述的大小
  let useSearchExtraTools = await isSearchExtraToolsEnabled(
    options.model,
    tools,
    options.getToolPermissionContext,
    options.agents,
    'query',
  )

  // ② 预计算延迟工具名单
  // 预先计算一次 —— isDeferredTool 每次调用都会做 2 次 GrowthBook 查询
  const deferredToolNames = new Set<string>()
  if (useSearchExtraTools) {
    for (const t of tools) {
      if (isDeferredTool(t)) deferredToolNames.add(t.name)
    }
  }

  // 即使启用了工具搜索模式，若没有延迟工具且没有 MCP 服务器还在连接中，则跳过。
  // 当服务器仍在等待时，保留 SearchExtraTools，让模型可以在它们连上后发现工具。
  if (
    useSearchExtraTools &&
    deferredToolNames.size === 0 &&
    !options.hasPendingMcpServers
  ) {
    logForDebugging(
      'Tool search disabled: no deferred tools available to search',
    )
    useSearchExtraTools = false
  }

  // 动态工具加载：过滤掉尚未被发现的延迟工具
  let filteredTools: Tools

  // 未被发现的延迟工具会从 API 请求中过滤掉——它们的 schema 只有在 SearchExtraTools 发现之后才会被加入。

  if (useSearchExtraTools) {
    // 永远不要把延迟工具放进 API 的 tools 数组——它们通过 ExecuteExtraTool
    // 在运行时从全局工具注册表中查找调用。保持 tools 数组稳定可以跨轮次
    // 保留 prompt 缓存（被发现的工具不会让 tools JSON 膨胀）。
    filteredTools = tools.filter(tool => {
      // 非延迟工具（核心工具）始终包含
      if (!deferredToolNames.has(tool.name)) return true
      // SearchExtraToolsTool 始终包含（以便它可以发现更多工具）
      if (toolMatchesName(tool, SEARCH_EXTRA_TOOLS_TOOL_NAME)) return true
      // 其他延迟工具全部排除 —— 改用 ExecuteExtraTool
      return false
    })
  } else {
    filteredTools = tools.filter(
      t => !toolMatchesName(t, SEARCH_EXTRA_TOOLS_TOOL_NAME),
    )
  }

  // 工具搜索的 beta 头和 defer_loading 已移除 —— 所有 provider 统一走
  // SearchExtraToolsTool + ExecuteExtraTool 的自建工具搜索。
  // 不再依赖 API 侧的 tool_reference 或 defer_loading 功能。
  const toolSearchHeader = useSearchExtraTools
    ? getToolSearchBetaHeader()
    : null
  if (toolSearchHeader && getAPIProvider() !== 'bedrock') {
    if (!betas.includes(toolSearchHeader)) {
      betas.push(toolSearchHeader)
    }
  }

  // 判断该模型是否启用了 cached microcompact。
  // 在此（异步上下文）计算一次，由 paramsFromContext 闭包捕获。
  // beta 头也在此处捕获，避免在顶层导入 ant 专属的 CACHE_EDITING_BETA_HEADER 常量。
  let cachedMCEnabled = false
  let cacheEditingBetaHeader = ''
  if (feature('CACHED_MICROCOMPACT')) {
    // ┌──────────────────────────┬────────────────────────────────────────────┬──────────┬────────────────────────┐
    // │           功能           │                    字段                    │   面向   │          状态          │
    // ├──────────────────────────┼────────────────────────────────────────────┼──────────┼────────────────────────┤
    // │ Prompt                   │ cache_control 断点                         │ 所有用户 │ 公开 API，正常工作     │
    // │ caching（提示缓存）      │                                            │          │                        │
    // ├──────────────────────────┼────────────────────────────────────────────┼──────────┼────────────────────────┤
    // │ Cache                    │ cache_reference / cache_edits /            │ ant 内部 │ 服务端 beta，header    │
    // │ editing（缓存编辑）      │ delete_tool_result                         │          │ 未公开                 │
    // └──────────────────────────┴────────────────────────────────────────────┴──────────┴────────────────────────┘

    // 你日常享受到的"缓存命中省钱"是前者，公开的，谁都能用。

    // CACHED_MICROCOMPACT 用的是后者——不只是读写缓存，而是能从服务端 KV cache 里定向删除某条
    // tool_result。这是一个更强的能力，属于未公开的 beta。
    const {
      isCachedMicrocompactEnabled,
      isModelSupportedForCacheEditing,
      getCachedMCConfig,
    } = await import('../compact/cachedMicrocompact.js')
    const betas = await import('src/constants/betas.js')
    cacheEditingBetaHeader = betas.CACHE_EDITING_BETA_HEADER
    const featureEnabled = isCachedMicrocompactEnabled()
    const modelSupported = isModelSupportedForCacheEditing(options.model)
    // cachedMC 需要非空的 beta 头；在本 fork 中 CACHE_EDITING_BETA_HEADER 常量
    // 是 ''（上游尚未发布真实值）。如果没有它，请求体里的 cache_reference
    // 和 cache_edits 会触发 API 400："tool_result.cache_reference: Extra
    // inputs are not permitted"。
    const headerAvailable = !!cacheEditingBetaHeader
    cachedMCEnabled = featureEnabled && modelSupported && headerAvailable
    const config = getCachedMCConfig()
    logForDebugging(
      `Cached MC gate: enabled=${featureEnabled} modelSupported=${modelSupported} headerAvailable=${headerAvailable} model=${options.model} supportedModels=${jsonStringify((config as Record<string, unknown>).supportedModels)}`,
    )
  }

  const useGlobalCacheFeature = shouldUseGlobalCacheScope()
  // MCP 工具是每用户独立的 —— 属于动态工具段 —— 无法做全局缓存。
  const needsToolBasedCacheMarker =
    useGlobalCacheFeature && filteredTools.some(t => t.isMcp === true)

  // 全局缓存启用时，确保 prompt_caching_scope beta 头存在。
  if (
    useGlobalCacheFeature &&
    !betas.includes(PROMPT_CACHING_SCOPE_BETA_HEADER)
  ) {
    betas.push(PROMPT_CACHING_SCOPE_BETA_HEADER)
  }

  // 确定用于日志记录的全局缓存策略
  const globalCacheStrategy: GlobalCacheStrategy = useGlobalCacheFeature
    ? needsToolBasedCacheMarker
      ? 'none'
      : 'system_prompt'
    : 'none'

  // 构建工具 schema —— 不使用 defer_loading，因为我们走自建工具搜索
  // 注意：传给 toolToAPISchema 的是完整的 `tools` 列表（而非 filteredTools），
  // 这样 SearchExtraToolsTool 的 prompt 能列出所有可用的 MCP 工具。过滤只
  // 影响真正发送给 API 的工具集合，不影响模型在工具描述里看到的内容。
  const toolSchemas = await Promise.all(
    filteredTools.map(tool =>
      toolToAPISchema(tool, {
        getToolPermissionContext: options.getToolPermissionContext,
        tools,
        agents: options.agents,
        allowedAgentTypes: options.allowedAgentTypes,
        model: options.model,
      }),
    ),
  )

  if (useSearchExtraTools) {
    logForDebugging(
      `Dynamic tool loading: 0/${deferredToolNames.size} deferred tools in API tools array (all via ExecuteExtraTool)`,
    )
  }

  queryCheckpoint('query_tool_schema_build_end')

  // 在构建 system prompt 之前先归一化消息（指纹计算需要）
  // 埋点：记录归一化前的消息数
  logEvent('tengu_api_before_normalize', {
    preNormalizedMessageCount: messages.length,
  })

  queryCheckpoint('query_message_normalization_start')
  let messagesForAPI = normalizeMessagesForAPI(messages, filteredTools)
  queryCheckpoint('query_message_normalization_end')

  // 模型特定的后处理：如果选中的模型不支持工具搜索，剔除工具搜索专用的字段。
  //
  // 为什么除 normalizeMessagesForAPI 之外还需要这一步？
  // - normalizeMessagesForAPI 使用 isSearchExtraToolsEnabledNoModelCheck()，因为它
  //   被约 20 处调用（分析、反馈、分享等），其中许多没有模型上下文。在其签名
  //   里加上 model 会是一次大重构。
  // - 此处后处理使用支持模型的 isSearchExtraToolsEnabled() 检查
  // - 处理对话中途切换模型（例如 Sonnet → Haiku）时，上一个模型遗留的工具搜索
  //   字段会导致 400 错误
  //
  // 注意：对于 assistant 消息，normalizeMessagesForAPI 已经归一化了 tool 输入，
  // 因此 stripCallerFieldFromAssistantMessage 只需要移除 'caller' 字段
  // （不需要再次归一化输入）。
  if (!useSearchExtraTools) {
    messagesForAPI = messagesForAPI.map(msg => {
      switch (msg.type) {
        case 'user':
          // 从 tool_result 内容中剔除 tool_reference 块
          return stripToolReferenceBlocksFromUserMessage(msg)
        case 'assistant':
          // 从 tool_use 块中剔除 'caller' 字段
          return stripCallerFieldFromAssistantMessage(msg)
        default:
          return msg
      }
    })
  }

  // 修复恢复远端/teleport 会话时可能出现的 tool_use/tool_result 配对错位。
  // 为孤立的 tool_use 插入合成的 error tool_result，并剔除引用了不存在
  // tool_use 的孤立 tool_result。
  messagesForAPI = ensureToolResultPairing(messagesForAPI)

  // 剔除 advisor 块 —— 没有 beta 头时 API 会拒绝。
  if (!betas.includes(ADVISOR_BETA_HEADER)) {
    messagesForAPI = stripAdvisorBlocks(messagesForAPI)
  }

  // 发起 API 调用之前剔除多余的媒体项。
  // API 会拒绝超过 100 个媒体项的请求，但返回的错误信息晦涩难懂。
  // 在 Cowork/CCD 中一旦报错很难恢复，所以我们静默剔除最旧的媒体项以保持在限制内。
  messagesForAPI = stripExcessMediaItems(
    messagesForAPI,
    API_MAX_MEDIA_PER_REQUEST,
  )

  // OpenAI 兼容的 provider：在共享的预处理（消息归一化、工具过滤、媒体剔除）之后、Anthropic 专属逻辑（betas、thinking、caching）之前，交给 OpenAI 适配层处理。
  if (getAPIProvider() === 'openai') {
    const { queryModelOpenAI } = await import('./openai/index.js')
    // OpenAI 在客户端模拟 Anthropic 的动态工具加载。它需要完整的工具池，以便 SearchExtraToolsTool 可以搜索那些被有意从上面的初始 API 工具列表里过滤掉的延迟 MCP 工具。
    yield* queryModelOpenAI(
      messagesForAPI,
      systemPrompt,
      tools,
      signal,
      options,
    )
    return
  }

  if (getAPIProvider() === 'gemini') {
    const { queryModelGemini } = await import('./gemini/index.js')
    yield* queryModelGemini(
      messagesForAPI,
      systemPrompt,
      filteredTools,
      signal,
      options,
      thinkingConfig,
    )
    return
  }

  if (getAPIProvider() === 'grok') {
    const { queryModelGrok } = await import('./grok/index.js')
    yield* queryModelGrok(
      messagesForAPI,
      systemPrompt,
      filteredTools,
      signal,
      options,
    )
    return
  }

  // 埋点：记录归一化后的消息数
  logEvent('tengu_api_after_normalize', {
    postNormalizedMessageCount: messagesForAPI.length,
  })

  // 从第一条 user 消息计算指纹用于归因。 必须在注入合成消息（例如延迟工具名）之前进行，使指纹反映真实的用户输入。
  const fingerprint = computeFingerprintFromMessages(messagesForAPI)

  // 启用 delta 附件时，延迟工具通过持久化的 deferred_tools_delta 附件公告，而不是这种临时的前置注入（后者会在工具池变化时打破缓存）。
  if (useSearchExtraTools && !isDeferredToolsDeltaEnabled()) {
    // 把当前的延迟工具与之前 <available-deferred-tools> 注入中已公告过的工具做 diff。仅当出现新工具时（例如会话中途 MCP 服务器连上）才重新注入。
    const deferredToolList = tools
      .filter(t => deferredToolNames.has(t.name))
      .map(formatDeferredToolLine)
      .sort()
      .join('\n')

    if (deferredToolList) {
      const currentTools = new Set(deferredToolList.split('\n'))
      const hasNewTools = [...currentTools].some(
        t => !lastAnnouncedDeferredTools.has(t),
      )

      if (hasNewTools) {
        lastAnnouncedDeferredTools.clear()
        for (const t of currentTools) lastAnnouncedDeferredTools.add(t)

        messagesForAPI = [
          ...messagesForAPI,
          createUserMessage({
            content: `<system-reminder>\n<available-deferred-tools>\n${deferredToolList}\n</available-deferred-tools>\nIMPORTANT: The tools listed above are deferred-loading — they are NOT in your tool list. To use them, you MUST first discover a tool via SearchExtraTools, then invoke it with ExecuteExtraTool.\n\nSearchExtraTools and ExecuteExtraTool are core tools already in your tool list right now — call them directly, do NOT use Bash/Glob to find them.\n\nSteps:\n1. SearchExtraTools({"query": "select:<tool_name>"}) — discover the tool and its schema\n2. ExecuteExtraTool({"tool_name": "<name>", "params": {...}}) — invoke it with correct parameters\n</system-reminder>`,
            isMeta: true,
          }),
        ]
      }
    }
  }

  // Chrome 工具搜索指令：启用 delta 附件时，这些指令作为客户端块放在 mcp_instructions_delta（attachments.ts）中，而不是这里。此处每次请求追加到 system prompt 会在 chrome 延迟连接时打破 prompt 缓存。
  const hasChromeTools = filteredTools.some(t =>
    isToolFromMcpServer(t.name, CLAUDE_IN_CHROME_MCP_SERVER_NAME),
  )
  const injectChromeHere =
    useSearchExtraTools && hasChromeTools && !isMcpInstructionsDeltaEnabled()

  // filter(Boolean) 会把每个元素转成布尔值——空字符串变成 false 被过滤掉。
  systemPrompt = asSystemPrompt(
    [
      getAttributionHeader(fingerprint),
      getCLISyspromptPrefix({
        isNonInteractive: options.isNonInteractiveSession,
        hasAppendSystemPrompt: options.hasAppendSystemPrompt,
      }),
      ...systemPrompt,
      ...(advisorModel ? [ADVISOR_TOOL_INSTRUCTIONS] : []),
      ...(injectChromeHere ? [CHROME_SEARCH_EXTRA_TOOLS_INSTRUCTIONS] : []),
    ].filter(Boolean),
  )

  // ── Break-cache 集成 ──
  // 如果存在一次性的 break-cache 标记，或者开启了 always 模式，就在 system prompt 后面追加一个唯一的临时 nonce 注释，让本次请求的 prefix-cache 哈希发生变化，强制缓存未命中。
  {
    const onceMarker = getBreakCacheMarkerPath()
    const alwaysFlag = getBreakCacheAlwaysPath()
    const shouldBreak = existsSync(onceMarker) || existsSync(alwaysFlag)
    if (shouldBreak) {
      const nonce = randomUUID()
      systemPrompt = asSystemPrompt([
        ...systemPrompt,
        `<!-- cache-break nonce: ${nonce} -->`,
      ])
      // 只删除一次性标记；always 标记会一直保留，直到执行 /break-cache off
      if (existsSync(onceMarker)) {
        try {
          unlinkSync(onceMarker)
        } catch {
          /* 尽力而为 */
        }
      }
    }
  }

  // 前置一个 system prompt 块以便于 API 识别
  logAPIPrefix(systemPrompt)

  const enablePromptCaching =
    options.enablePromptCaching ?? getPromptCachingEnabled(options.model)
  const system = buildSystemPromptBlocks(systemPrompt, enablePromptCaching, {
    skipGlobalCacheForSystemPrompt: needsToolBasedCacheMarker,
    querySource: options.querySource,
  })
  const useBetas = betas.length > 0

  // 为详细 tracing 构建最小上下文（beta tracing 启用时）
  // 注意：实际 new_context 消息的抽取在 sessionTracing.ts 中完成，基于 messagesForAPI 数组按 querySource（agent）做基于哈希的跟踪
  const extraToolSchemas = [...(options.extraToolSchemas ?? [])]
  if (advisorModel) {
    // 按 API 约定，server tool 必须在 tools 数组里。追加在 toolSchemas 携带 cache_control 标记）之后，这样切换 /advisor 只会让后面那段 小尾巴发生变化，不会影响已缓存的前缀。
    extraToolSchemas.push({
      type: 'advisor_20260301',
      name: 'advisor',
      model: advisorModel,
    } as unknown as BetaToolUnion)
  }
  const allTools = [...toolSchemas, ...extraToolSchemas]

  const isFastMode =
    isFastModeEnabled() &&
    isFastModeAvailable() &&
    !isFastModeCooldown() &&
    isFastModeSupportedByModel(options.model) &&
    !!options.fastMode

  // 动态 beta 头的粘性锁存。每个头一旦首次发送，在 session 剩余时间里
  // 都会持续发送，这样会话中途切换不会改变服务端缓存键，避免打破约 5-7 万 token 的缓存。锁存可通过 clearBetaHeaderLatches() 在 /clear 和 /compact 时清除。
  // 按调用维度的闸门（isAgenticQuery、querySource===repl_main_thread）保持按调用维度，使非 agentic 查询拥有自己稳定的 header 集合。

  let afkHeaderLatched = getAfkModeHeaderLatched() === true
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    if (
      !afkHeaderLatched &&
      isAgenticQuery &&
      shouldIncludeFirstPartyOnlyBetas() &&
      (autoModeStateModule?.isAutoModeActive() ?? false)
    ) {
      afkHeaderLatched = true
      setAfkModeHeaderLatched(true)
    }
  }

  let fastModeHeaderLatched = getFastModeHeaderLatched() === true
  if (!fastModeHeaderLatched && isFastMode) {
    fastModeHeaderLatched = true
    setFastModeHeaderLatched(true)
  }

  let cacheEditingHeaderLatched = getCacheEditingHeaderLatched() === true
  if (feature('CACHED_MICROCOMPACT')) {
    if (
      !cacheEditingHeaderLatched &&
      cachedMCEnabled &&
      getAPIProvider() === 'firstParty' &&
      options.querySource === 'repl_main_thread'
    ) {
      cacheEditingHeaderLatched = true
      setCacheEditingHeaderLatched(true)
    }
  }

  const effort = resolveAppliedEffort(options.model, options.effortValue)

  if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
    // 把 defer_loading 工具从哈希中排除 —— API 会把它们从 prompt 中剥离，所以它们根本不会影响实际的缓存键。如果包含它们，当工具被发现或 MCP 服务器重连时会出现误报的 "tool schemas changed" 打破事件。
    const toolsForCacheDetection = allTools.filter(
      t => !('defer_loading' in t && t.defer_loading),
    )
    // 捕获一切可能影响服务端缓存键的因素。传入锁存的 header 值（而非实时 state），使 break 检测反映我们实际发送的内容，而不是用户切换后的状态。
    recordPromptState({
      system,
      toolSchemas: toolsForCacheDetection,
      querySource: options.querySource,
      model: options.model,
      agentId: options.agentId,
      fastMode: fastModeHeaderLatched,
      globalCacheStrategy,
      betas,
      autoModeActive: afkHeaderLatched,
      isUsingOverage: currentLimits.isUsingOverage ?? false,
      cachedMCEnabled: cacheEditingHeaderLatched,
      effortValue: effort,
      extraBodyParams: getExtraBodyParams(),
    })
  }

  const newContext: LLMRequestNewContext | undefined = isBetaTracingEnabled()
    ? {
        systemPrompt: systemPrompt.join('\n\n'),
        querySource: options.querySource,
        tools: jsonStringify(allTools),
      }
    : undefined

  // 捕获 span 以便后续传给 endLLMRequestSpan 这样在多个请求并行时，响应能匹配到正确的请求
  const llmSpan = startLLMRequestSpan(
    options.model,
    newContext,
    messagesForAPI,
    isFastMode,
  )

  const startIncludingRetries = Date.now()
  let start = Date.now()
  let attemptNumber = 0
  const attemptStartTimes: number[] = []
  let stream: Stream<BetaRawMessageStreamEvent> | undefined
  let streamRequestId: string | null | undefined
  let clientRequestId: string | undefined
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins -- Response is available in Node 18+ and is used by the SDK
  let streamResponse: Response | undefined

  // 释放所有流资源以防止本地内存泄漏。
  // Response 对象持有 V8 堆外的本地 TLS/socket 缓冲区（在 Node.js/npm 路径 上观察到；见 GH #32920），因此无论生成器以何种方式退出，都必须显式 cancel 并释放它。
  function releaseStreamResources(): void {
    cleanupStream(stream)
    stream = undefined
    if (streamResponse) {
      streamResponse.body?.cancel().catch(() => {})
      streamResponse = undefined
    }
  }

  // 在定义 paramsFromContext 之前，一次性消费待处理的 cache edits。paramsFromContext 会被多次调用（日志、重试），在其中消费会让第一次调用偷走后续调用的 edits。
  const consumedCacheEdits = cachedMCEnabled ? consumePendingCacheEdits() : null
  const consumedPinnedEdits = cachedMCEnabled ? getPinnedCacheEdits() : []

  // 捕获上一次 API 请求中发送的 betas（包括动态添加的那些），用于日志和遥测。
  let lastRequestBetas: string[] | undefined

  const paramsFromContext = (retryContext: RetryContext) => {
    const betasParams = [...betas]

    // 为 Sonnet 1M 实验动态追加 1M beta。
    if (
      !betasParams.includes(CONTEXT_1M_BETA_HEADER) &&
      getSonnet1mExpTreatmentEnabled(retryContext.model)
    ) {
      betasParams.push(CONTEXT_1M_BETA_HEADER)
    }

    // 对 Bedrock，包含模型相关的 betas（没有 tool search 头 —— 走自建搜索）
    const bedrockBetas =
      getAPIProvider() === 'bedrock'
        ? [...getBedrockExtraBodyParamsBetas(retryContext.model)]
        : []
    const extraBodyParams = getExtraBodyParams(bedrockBetas)

    const outputConfig: BetaOutputConfig = {
      ...((extraBodyParams.output_config as BetaOutputConfig) ?? {}),
    }

    configureEffortParams(
      effort,
      outputConfig,
      extraBodyParams,
      betasParams,
      options.model,
    )

    configureTaskBudgetParams(
      options.taskBudget,
      outputConfig as BetaOutputConfig & { task_budget?: TaskBudgetParam },
      betasParams,
    )

    // 将 outputFormat 合并到 extraBodyParams.output_config 中，与 effort 并列按 SDK 要求需要 structured-outputs beta 头（见 messages.mjs 的 parse()）
    if (options.outputFormat && !('format' in outputConfig)) {
      outputConfig.format = options.outputFormat as BetaJSONOutputFormat
      // 如果尚未包含 beta 头且 provider 支持，则添加
      if (
        modelSupportsStructuredOutputs(options.model) &&
        !betasParams.includes(STRUCTURED_OUTPUTS_BETA_HEADER)
      ) {
        betasParams.push(STRUCTURED_OUTPUTS_BETA_HEADER)
      }
    }

    // 重试上下文优先，因为它会在我们超出上下文窗口限制时尝试纠正
    const maxOutputTokens =
      retryContext?.maxTokensOverride ||
      options.maxOutputTokensOverride ||
      getMaxOutputTokensForModel(options.model)

    const hasThinking =
      thinkingConfig.type !== 'disabled' &&
      !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_THINKING)
    let thinking: BetaMessageStreamParams['thinking'] | undefined

    // 重要：不要在未通知模型发布 DRI 和研究团队的情况下修改下面的 adaptive-vs-budget thinking 选择。这是一项敏感设置，会极大影响模型质量和刷榜表现。
    if (hasThinking && modelSupportsThinking(options.model)) {
      if (
        !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING) &&
        modelSupportsAdaptiveThinking(options.model)
      ) {
        // 对于支持 adaptive thinking 的模型，始终使用不带预算的 adaptive thinking。
        thinking = {
          type: 'adaptive',
        } satisfies BetaMessageStreamParams['thinking']
      } else {
        // 对于不支持 adaptive thinking 的模型，除非显式指定，否则使用 默认 thinking 预算。
        let thinkingBudget = getMaxThinkingTokensForModel(options.model)
        if (
          thinkingConfig.type === 'enabled' &&
          thinkingConfig.budgetTokens !== undefined
        ) {
          thinkingBudget = thinkingConfig.budgetTokens
        }
        thinkingBudget = Math.min(maxOutputTokens - 1, thinkingBudget) // 文档说「budget_tokens 必须小于 max_tokens」，源码严格保证了这点
        thinking = {
          budget_tokens: thinkingBudget,
          type: 'enabled',
        } satisfies BetaMessageStreamParams['thinking']
      }
    }

    // 获取已启用的 API 上下文管理策略
    const contextManagement = getAPIContextManagement({
      hasThinking,
      isRedactThinkingActive: betasParams.includes(REDACT_THINKING_BETA_HEADER),
      clearAllThinking: false,
    })

    const enablePromptCaching =
      options.enablePromptCaching ?? getPromptCachingEnabled(retryContext.model)

    // Fast mode：header 锁存在 session 级别稳定（缓存安全），但 `speed='fast'` 保持动态，使冷却仍能抑制实际的 fast-mode 请求，而不改变缓存键。
    let speed: BetaMessageStreamParams['speed']
    const isFastModeForRetry =
      isFastModeEnabled() &&
      isFastModeAvailable() &&
      !isFastModeCooldown() &&
      isFastModeSupportedByModel(options.model) &&
      !!retryContext.fastMode
    if (isFastModeForRetry) {
      speed = 'fast'
    }
    if (fastModeHeaderLatched && !betasParams.includes(FAST_MODE_BETA_HEADER)) {
      betasParams.push(FAST_MODE_BETA_HEADER)
    }

    // AFK mode beta：auto mode 首次激活后即锁存。仍按调用维度由 isAgenticQuery 闸控，分类器/压缩不会带上它。
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      if (
        afkHeaderLatched &&
        shouldIncludeFirstPartyOnlyBetas() &&
        isAgenticQuery &&
        !betasParams.includes(AFK_MODE_BETA_HEADER)
      ) {
        betasParams.push(AFK_MODE_BETA_HEADER)
      }
    }

    // Cache editing beta：header 锁存在 session 级别稳定；useCachedMC（控制 cache_edits 请求体行为）保持实时，使 feature 关闭时 edits 停止，而 header 不翻转。
    const useCachedMC =
      cachedMCEnabled &&
      getAPIProvider() === 'firstParty' &&
      options.querySource === 'repl_main_thread'
    if (
      cacheEditingHeaderLatched &&
      cacheEditingBetaHeader &&
      getAPIProvider() === 'firstParty' &&
      options.querySource === 'repl_main_thread' &&
      !betasParams.includes(cacheEditingBetaHeader)
    ) {
      betasParams.push(cacheEditingBetaHeader)
      logForDebugging(
        'Cache editing beta header enabled for cached microcompact',
      )
    }

    // 仅在 thinking 关闭时才发送 temperature —— 启用 thinking 时 API 要求 temperature: 1，这已经是默认值。
    //   理解要点：当 thinking 开启，temperature 字段根本不发送给 API（让它用默认值 1）。这比显式发送 temperature: 1 更干净，避免了 API 端的冗余校验。
    const temperature = !hasThinking
      ? (options.temperatureOverride ?? 1)
      : undefined

    // 发送前过滤掉空字符串 beta 头。
    // 像 CACHE_EDITING_BETA_HEADER 或 AFK_MODE_BETA_HEADER 这类常量在其 feature gate 关闭时可能为 ''；betas 数组中的空字符串会产生非法的 anthropic-beta 头（400 错误）。
    const filteredBetas = betasParams.filter(Boolean)
    lastRequestBetas = filteredBetas

    return {
      model: normalizeModelStringForAPI(options.model),
      messages: addCacheBreakpoints(
        messagesForAPI,
        enablePromptCaching,
        options.querySource,
        useCachedMC,
        consumedCacheEdits as any,
        consumedPinnedEdits as any,
        options.skipCacheWrite,
      ),
      system,
      tools: allTools,
      tool_choice: options.toolChoice,
      ...(useBetas && { betas: filteredBetas }),
      metadata: getAPIMetadata(),
      max_tokens: maxOutputTokens,
      thinking,
      ...(temperature !== undefined && { temperature }),
      ...(contextManagement &&
        useBetas &&
        betasParams.includes(CONTEXT_MANAGEMENT_BETA_HEADER) && {
          context_management: contextManagement,
        }),
      ...extraBodyParams,
      ...(Object.keys(outputConfig).length > 0 && {
        output_config: outputConfig,
      }),
      ...(speed !== undefined && { speed }),
    }
  }

  // 同步计算日志标量，使触发即忘的 .then() 闭包只捕获原始值，而不是
  // paramsFromContext 完整闭包作用域（messagesForAPI、system、allTools、betas —— 整个构建请求的上下文），否则这些对象会被一直 pin 到 promise 完成。同时为 Langfuse 可观测性捕获 thinking 参数。
  // 传入完整的 thinking 配置对象，使所有字段（type、budget_tokens 以及未来新增的字段）都能直接透传，无需逐个挑选。
  let langfuseThinking: BetaMessageStreamParams['thinking'] | undefined
  {
    const queryParams = paramsFromContext({
      model: options.model,
      thinkingConfig,
    })
    const logMessagesLength = queryParams.messages.length
    const logBetas = useBetas ? (queryParams.betas ?? []) : []
    const logEffortValue = queryParams.output_config?.effort
    if (queryParams.thinking && queryParams.thinking.type !== 'disabled') {
      langfuseThinking = queryParams.thinking
    }
    void options.getToolPermissionContext().then(permissionContext => {
      logAPIQuery({
        model: options.model,
        messagesLength: logMessagesLength,
        temperature: options.temperatureOverride ?? 1,
        betas: logBetas,
        permissionMode: permissionContext.mode,
        querySource: options.querySource,
        queryTracking: options.queryTracking,
        thinkingConfig,
        effortValue: logEffortValue,
        fastMode: isFastMode,
        previousRequestId,
      })
    })
  }

  const newMessages: AssistantMessage[] = []
  let ttftMs = 0
  let partialMessage: BetaMessage | undefined
  const contentBlocks: (BetaContentBlock | ConnectorTextBlock)[] = []
  const textDeltas = new Map<number, string[]>()
  let usage: NonNullableUsage = EMPTY_USAGE
  let costUSD = 0
  let stopReason: BetaStopReason | null = null
  let didFallBackToNonStreaming = false
  let fallbackMessage: AssistantMessage | undefined
  let maxOutputTokens = 0
  let responseHeaders: globalThis.Headers | undefined
  let research: unknown
  let isFastModeRequest = isFastMode // Keep separate state as it may change if falling back
  let isAdvisorInProgress = false

  try {
    queryCheckpoint('query_client_creation_start')
    const generator = withRetry(
      () =>
        getAnthropicClient({
          maxRetries: 0, // 禁用 SDK 自动重试，改用手动实现
          model: options.model,
          fetchOverride: options.fetchOverride,
          source: options.querySource,
        }),
      async (anthropic, attempt, context) => {
        attemptNumber = attempt
        isFastModeRequest = context.fastMode ?? false
        start = Date.now()
        attemptStartTimes.push(start)
        // 客户端已由 withRetry 的 getClient() 调用创建。每次尝试触发一次；
        // 重试时客户端通常已被缓存（withRetry 只在鉴权错误后才再次调用 getClient()），因此第 1 次尝试时 client_creation_start 到这里的时间差是有意义的。
        queryCheckpoint('query_client_creation_end')

        const params = paramsFromContext(context)
        captureAPIRequest(params, options.querySource) // 为 bug 报告捕获请求

        maxOutputTokens = params.max_tokens

        // 在 fetch 真正发出去之前立即触发。下面的 .withResponse() 会一直 阻塞到响应头返回，所以必须在 await 之前，否则 "Network TTFB" 阶段的测量会出错。
        queryCheckpoint('query_api_request_sent')
        if (!options.agentId) {
          headlessProfilerCheckpoint('api_request_sent')
        }

        // 生成并跟踪客户端 request ID，使超时（不会返回服务端 request ID）仍然能与服务端日志关联。仅限第一方——第三方 provider 不会记录它（inc-4029 类问题）。
        clientRequestId =
          getAPIProvider() === 'firstParty' && isFirstPartyAnthropicBaseUrl()
            ? randomUUID()
            : undefined

        // 使用原始流而不是 BetaMessageStream，避免 O(n²) 的部分 JSON 解析。BetaMessageStream 会在每个 input_json_delta 上调用 partialParse()，而我们并不需要它——tool 输入的累积由我们自己处理
        const result = await anthropic.beta.messages
          .create(
            { ...params, stream: true },
            {
              signal,
              ...(clientRequestId && {
                headers: { [CLIENT_REQUEST_ID_HEADER]: clientRequestId },
              }),
            },
          )
          .withResponse()
        queryCheckpoint('query_response_headers_received')
        streamRequestId = result.request_id
        streamResponse = result.response
        return result.data
      },
      {
        model: options.model,
        fallbackModel: options.fallbackModel,
        thinkingConfig,
        ...(isFastModeEnabled() ? { fastMode: isFastMode } : false),
        signal,
        querySource: options.querySource,
      },
    )

    let e
    do {
      e = await generator.next()

      // yield API 错误消息（流有 'controller' 属性，错误消息没有）
      if (!('controller' in e.value)) {
        yield e.value
      }
    } while (!e.done)
    stream = e.value as Stream<BetaRawMessageStreamEvent>

    // 重置状态
    newMessages.length = 0
    ttftMs = 0
    partialMessage = undefined
    contentBlocks.length = 0
    textDeltas.clear()
    usage = EMPTY_USAGE
    stopReason = null
    isAdvisorInProgress = false

    // 流式空闲超时看门狗：如果 STREAM_IDLE_TIMEOUT_MS 内没有收到任何 chunk，中止该流。与下面的停顿检测（只在下一个 chunk 到来时才触发）
    // 不同，这里使用 setTimeout 主动杀死卡住的流。没有它的话，一个静默 丢包的连接会让会话无限期挂起，因为 SDK 的请求超时只覆盖初始的 fetch()，不覆盖流式响应体。
    const streamWatchdogEnabled = isEnvTruthy(
      process.env.CLAUDE_ENABLE_STREAM_WATCHDOG,
    )
    const STREAM_IDLE_TIMEOUT_MS =
      parseInt(process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS || '', 10) || 90_000
    const STREAM_IDLE_WARNING_MS = STREAM_IDLE_TIMEOUT_MS / 2
    let streamIdleAborted = false
    // 看门狗触发时记录 performance.now() 快照，用于测量 abort 传播延迟
    let streamWatchdogFiredAt: number | null = null
    let streamIdleWarningTimer: ReturnType<typeof setTimeout> | null = null
    let streamIdleTimer: ReturnType<typeof setTimeout> | null = null
    function clearStreamIdleTimers(): void {
      if (streamIdleWarningTimer !== null) {
        clearTimeout(streamIdleWarningTimer)
        streamIdleWarningTimer = null
      }
      if (streamIdleTimer !== null) {
        clearTimeout(streamIdleTimer)
        streamIdleTimer = null
      }
    }
    function resetStreamIdleTimer(): void {
      clearStreamIdleTimers()
      if (!streamWatchdogEnabled) {
        return
      }
      streamIdleWarningTimer = setTimeout(
        warnMs => {
          logForDebugging(
            `Streaming idle warning: no chunks received for ${warnMs / 1000}s`,
            { level: 'warn' },
          )
          logForDiagnosticsNoPII('warn', 'cli_streaming_idle_warning')
        },
        STREAM_IDLE_WARNING_MS,
        STREAM_IDLE_WARNING_MS,
      )
      streamIdleTimer = setTimeout(() => {
        streamIdleAborted = true
        streamWatchdogFiredAt = performance.now()
        logForDebugging(
          `Streaming idle timeout: no chunks received for ${STREAM_IDLE_TIMEOUT_MS / 1000}s, aborting stream`,
          { level: 'error' },
        )
        logForDiagnosticsNoPII('error', 'cli_streaming_idle_timeout')
        logEvent('tengu_streaming_idle_timeout', {
          model:
            options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          request_id: (streamRequestId ??
            'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          timeout_ms: STREAM_IDLE_TIMEOUT_MS,
        })
        releaseStreamResources()
      }, STREAM_IDLE_TIMEOUT_MS)
    }
    resetStreamIdleTimer()

    startSessionActivity('api_call')
    try {
      // 接收流并累积状态
      let isFirstChunk = true
      let lastEventTime: number | null = null // 在第一个 chunk 后才设置，避免把 TTFB 当成停顿
      const STALL_THRESHOLD_MS = 30_000 // 30 秒
      let totalStallTime = 0
      let stallCount = 0

      logForDebugging(
        `[Hapii] ClaudeApi.queryModel 流式请求已发送，等待首个事件...`,
        { level: 'info' },
      )
      logForDebugging(`[API] 流式请求已发送, 等待响应...`, { level: 'info' })

      for await (const part of stream) {
        resetStreamIdleTimer()
        try {
          _apiRawSink?.(part)
        } catch {}
        const now = Date.now()

        // 检测并记录流式停顿（只在第一个事件之后，避免把 TTFB 计入）
        if (lastEventTime !== null) {
          const timeSinceLastEvent = now - lastEventTime
          if (timeSinceLastEvent > STALL_THRESHOLD_MS) {
            stallCount++
            totalStallTime += timeSinceLastEvent
            logForDebugging(
              `Streaming stall detected: ${(timeSinceLastEvent / 1000).toFixed(1)}s gap between events (stall #${stallCount})`,
              { level: 'warn' },
            )
            logEvent('tengu_streaming_stall', {
              stall_duration_ms: timeSinceLastEvent,
              stall_count: stallCount,
              total_stall_time_ms: totalStallTime,
              event_type:
                part.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              model:
                options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              request_id: (streamRequestId ??
                'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            })
          }
        }
        lastEventTime = now

        if (isFirstChunk) {
          logForDebugging('Stream started - received first chunk')
          queryCheckpoint('query_first_chunk_received')
          if (!options.agentId) {
            headlessProfilerCheckpoint('first_chunk')
          }
          endQueryProfile()
          isFirstChunk = false
        }

        switch (part.type) {
          case 'message_start': {
            partialMessage = part.message
            ttftMs = Date.now() - start
            usage = updateUsage(usage, part.message?.usage)
            const msgUsage = part.message?.usage
            logForDebugging(
              `[API] message_start, id=${partialMessage?.id}, model=${partialMessage?.model}`,
              { level: 'info' },
            )
            // [Hapii][Cache] Log cache statistics from API response
            if (msgUsage) {
              const cacheRead = msgUsage.cache_read_input_tokens ?? 0
              const cacheCreate = msgUsage.cache_creation_input_tokens ?? 0
              const inputTokens = msgUsage.input_tokens ?? 0
              const totalInput = inputTokens + cacheRead + cacheCreate
              const cacheHitRate =
                totalInput > 0
                  ? ((cacheRead / totalInput) * 100).toFixed(1)
                  : '0'
              logForDebugging(
                `[Hapii][Cache] message_start usage: input=${inputTokens} cacheRead=${cacheRead} cacheCreate=${cacheCreate} totalInput=${totalInput} hitRate=${cacheHitRate}%`,
              )
              if (cacheRead > 0) {
                logForDebugging(
                  `[Hapii][Cache] ✅ CACHE HIT: ${cacheRead} tokens read from cache (${cacheHitRate}% of total input)`,
                )
              }
              if (cacheCreate > 0) {
                logForDebugging(
                  `[Hapii][Cache] 💾 CACHE WRITE: ${cacheCreate} tokens written to cache (costs 1.25x, reads cost 0.1x)`,
                )
              }
              if (cacheRead === 0 && cacheCreate === 0) {
                logForDebugging(
                  `[Hapii][Cache] ⚠️ NO CACHE: both cacheRead and cacheCreate are 0. Possible reasons: prefix too short (<1024 tokens for Sonnet, <4096 for Opus/Haiku), or caching disabled`,
                )
              }
            }
            // 从 message_start 捕获 research（仅内部）。始终用最新值覆盖。
            if (
              process.env.USER_TYPE === 'ant' &&
              'research' in (part.message as unknown as Record<string, unknown>)
            ) {
              research = (part.message as unknown as Record<string, unknown>)
                .research
            }
            break
          }
          case 'content_block_start':
            switch (part.content_block.type) {
              case 'tool_use':
                contentBlocks[part.index] = {
                  ...part.content_block,
                  input: '',
                }
                logForDebugging(
                  `[API] 工具调用块: name=${part.content_block.name}, id=${part.content_block.id}`,
                  { level: 'info' },
                )
                break
              case 'server_tool_use':
                contentBlocks[part.index] = {
                  ...part.content_block,
                  input: '' as unknown as { [key: string]: unknown },
                }
                if ((part.content_block.name as string) === 'advisor') {
                  isAdvisorInProgress = true
                  logForDebugging(`[AdvisorTool] Advisor tool called`)
                  logEvent('tengu_advisor_tool_call', {
                    model:
                      options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    advisor_model: (advisorModel ??
                      'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                  })
                }
                break
              case 'text':
                textDeltas.set(part.index, [])
                contentBlocks[part.index] = {
                  ...part.content_block,
                  // 有点别扭：sdk 有时会在 content_block_start 消息里就把 text 返回，然后在 content_block_delta 消息里又把同样的 text 再
                  // 返回一遍。我们在这里忽略它，因为似乎没办法判断 content_block_delta 消息里的 text 是否是重复的。
                  text: '',
                }
                break
              case 'thinking':
                contentBlocks[part.index] = {
                  ...part.content_block,
                  thinking: '', //同样别扭  注意：清空 thinking，SDK 自带的初始值会被丢弃
                  signature: '', // 初始化 signature 以确保该字段始终存在，即使 signature_delta 永不到达
                }
                break
              default:
                // 更别扭的是，sdk 会一边工作一边修改 text 块的内容。我们希望这些块是不可变的，以便自己累积状态。
                contentBlocks[part.index] = { ...part.content_block }
                if (
                  (part.content_block.type as string) === 'advisor_tool_result'
                ) {
                  isAdvisorInProgress = false
                  logForDebugging(`[AdvisorTool] Advisor tool result received`)
                }
                break
            }
            break
          case 'content_block_delta': {
            const contentBlock = contentBlocks[part.index]
            const delta = part.delta as typeof part.delta | ConnectorTextDelta
            if (!contentBlock) {
              logEvent('tengu_streaming_error', {
                error_type:
                  'content_block_not_found_delta' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                part_type:
                  part.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                part_index: part.index,
              })
              throw new RangeError('Content block not found')
            }
            if (
              feature('CONNECTOR_TEXT') &&
              delta.type === 'connector_text_delta'
            ) {
              if (contentBlock.type !== 'connector_text') {
                logEvent('tengu_streaming_error', {
                  error_type:
                    'content_block_type_mismatch_connector_text' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                  expected_type:
                    'connector_text' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                  actual_type:
                    contentBlock.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                })
                throw new Error('Content block is not a connector_text block')
              }
              ;(contentBlock as { connector_text: string }).connector_text +=
                delta.connector_text
            } else {
              switch (delta.type) {
                case 'citations_delta':
                  // TODO: 处理 citations
                  break
                case 'input_json_delta':
                  if (
                    contentBlock.type !== 'tool_use' &&
                    contentBlock.type !== 'server_tool_use'
                  ) {
                    logEvent('tengu_streaming_error', {
                      error_type:
                        'content_block_type_mismatch_input_json' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      expected_type:
                        'tool_use' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      actual_type:
                        contentBlock.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    })
                    throw new Error('Content block is not a input_json block')
                  }
                  if (typeof contentBlock.input !== 'string') {
                    logEvent('tengu_streaming_error', {
                      error_type:
                        'content_block_input_not_string' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      input_type:
                        typeof contentBlock.input as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    })
                    throw new Error('Content block input is not a string')
                  }
                  contentBlock.input += delta.partial_json
                  break
                case 'text_delta':
                  if (contentBlock.type !== 'text') {
                    logEvent('tengu_streaming_error', {
                      error_type:
                        'content_block_type_mismatch_text' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      expected_type:
                        'text' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      actual_type:
                        contentBlock.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    })
                    throw new Error('Content block is not a text block')
                  }
                  textDeltas.get(part.index)?.push(delta.text!)
                  break
                case 'signature_delta':
                  // 累积到 contentBlocks[index].signature
                  if (
                    feature('CONNECTOR_TEXT') &&
                    contentBlock.type === 'connector_text'
                  ) {
                    contentBlock.signature = delta.signature
                    break
                  }
                  if (contentBlock.type !== 'thinking') {
                    logEvent('tengu_streaming_error', {
                      error_type:
                        'content_block_type_mismatch_thinking_signature' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      expected_type:
                        'thinking' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      actual_type:
                        contentBlock.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    })
                    throw new Error('Content block is not a thinking block')
                  }
                  contentBlock.signature = delta.signature
                  break
                case 'thinking_delta':
                  // 累积到 contentBlocks[index].thinking
                  // 并做了类型守卫：contentBlock.type !== 'thinking' 时抛错
                  if (contentBlock.type !== 'thinking') {
                    logEvent('tengu_streaming_error', {
                      error_type:
                        'content_block_type_mismatch_thinking_delta' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      expected_type:
                        'thinking' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      actual_type:
                        contentBlock.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    })
                    throw new Error('Content block is not a thinking block')
                  }
                  ;(contentBlock as { thinking: string }).thinking +=
                    delta.thinking
                  break
              }
            }
            // 从 content_block_delta 捕获 research（仅内部）。始终用最新值覆盖。
            if (process.env.USER_TYPE === 'ant' && 'research' in part) {
              research = (part as { research: unknown }).research
            }
            break
          }
          case 'content_block_stop': {
            const contentBlock = contentBlocks[part.index]
            logForDebugging(
              `[Hapii] ClaudeApi 流事件 content_block_stop index=${part.index} blockType=${contentBlock?.type ?? 'unknown'}`,
              { level: 'info' },
            )
            if (!contentBlock) {
              logEvent('tengu_streaming_error', {
                error_type:
                  'content_block_not_found_stop' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                part_type:
                  part.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                part_index: part.index,
              })
              throw new RangeError('Content block not found')
            }
            if (!partialMessage) {
              logEvent('tengu_streaming_error', {
                error_type:
                  'partial_message_not_found' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                part_type:
                  part.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              })
              throw new Error('Message not found')
            }
            // 把累积的 text deltas 合并进内容块（O(n) join，而不是 O(n^2) 的 +=）
            const deltas = textDeltas.get(part.index)
            if (deltas) {
              ;(contentBlock as { text: string }).text = deltas.join('')
              textDeltas.delete(part.index)
            }
            const m: AssistantMessage = {
              message: {
                ...partialMessage,
                usage: partialMessage.usage ?? { ...EMPTY_USAGE },
                content: normalizeContentFromAPI(
                  [contentBlock] as BetaContentBlock[],
                  tools,
                  options.agentId,
                ) as MessageContent,
              },
              requestId: streamRequestId ?? undefined,
              type: 'assistant',
              uuid: randomUUID(),
              timestamp: new Date().toISOString(),
              ...(process.env.USER_TYPE === 'ant' &&
                research !== undefined && { research }),
              ...(advisorModel && { advisorModel }),
            }
            newMessages.push(m)
            yield m
            break
          }
          case 'message_delta': {
            logForDebugging(
              `[Hapii] ClaudeApi 流事件 message_delta stopReason=${part.delta.stop_reason} outputTokens=${part.usage?.output_tokens ?? 0}`,
              { level: 'info' },
            )
            usage = updateUsage(usage, part.usage)
            // 从 message_delta 捕获 research（仅内部）。始终用最新值覆盖。同时写回到已经 yield 出去的消息上，因为 message_delta 在 content_block_stop 之后才到达。
            if (
              process.env.USER_TYPE === 'ant' &&
              'research' in (part as unknown as Record<string, unknown>)
            ) {
              research = (part as unknown as Record<string, unknown>).research
              for (const msg of newMessages) {
                msg.research = research
              }
            }

            // 把最终的 usage 和 stop_reason 写回到最后一条已 yield 的消息。消息是在 content_block_stop 时基于 partialMessage 创建的，而 partialMessage 是在 message_start 时（任何 token 生成之前）
            // 设置的（output_tokens: 0，stop_reason: null）。message_delta 在 content_block_stop 之后才带着真正的值到来。
            //
            // 重要：使用直接属性修改，而不是对象替换。transcript 写入队列持有 message.message 的引用，并以 100ms 的 flush 间隔懒序列化。对象替换（{ ...lastMsg.message, usage }）
            // 会让排队中的引用脱钩；直接修改能确保 transcript 拿到最终值。
            stopReason = part.delta.stop_reason

            const lastMsg = newMessages.at(-1)
            if (lastMsg) {
              lastMsg.message.usage = usage
              lastMsg.message.stop_reason = stopReason
            }

            // 更新成本
            const costUSDForPart = calculateUSDCost(
              resolvedModel,
              usage as unknown as BetaUsage,
            )
            costUSD += addToTotalSessionCost(
              costUSDForPart,
              usage as unknown as BetaUsage,
              options.model,
            )

            const refusalMessage = getErrorMessageIfRefusal(
              part.delta.stop_reason,
              options.model,
            )
            if (refusalMessage) {
              yield refusalMessage
            }

            if (stopReason === 'max_tokens') {
              logEvent('tengu_max_tokens_reached', {
                max_tokens: maxOutputTokens,
              })
              yield createAssistantAPIErrorMessage({
                content: `${API_ERROR_MESSAGE_PREFIX}: Claude's response exceeded the ${
                  maxOutputTokens
                } output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.`,
                apiError: 'max_output_tokens',
                error: 'max_output_tokens',
              })
            }

            if (stopReason === 'model_context_window_exceeded') {
              logEvent('tengu_context_window_exceeded', {
                max_tokens: maxOutputTokens,
                output_tokens: usage.output_tokens,
              })
              // 复用 max_output_tokens 的恢复路径——从模型角度看，两者的含义都是"响应被截断了，请从上次停下的地方继续"。
              yield createAssistantAPIErrorMessage({
                content: `${API_ERROR_MESSAGE_PREFIX}: The model has reached its context window limit.`,
                apiError: 'max_output_tokens',
                error: 'max_output_tokens',
              })
            }
            break
          }
          case 'message_stop':
            {
              const finalCacheRead = usage.cache_read_input_tokens ?? 0
              const finalCacheCreate = usage.cache_creation_input_tokens ?? 0
              const finalInputTokens = usage.input_tokens ?? 0
              const finalTotalInput =
                finalInputTokens + finalCacheRead + finalCacheCreate
              const finalCacheHitRate =
                finalTotalInput > 0
                  ? ((finalCacheRead / finalTotalInput) * 100).toFixed(1)
                  : '0'
              logForDebugging(
                `[Hapii] ClaudeApi.queryModel 流结束 耗时=${Date.now() - start}ms inputTokens=${finalInputTokens} outputTokens=${usage.output_tokens} cacheRead=${finalCacheRead}`,
                { level: 'info' },
              )
              logForDebugging(
                `[API] 消息完成, 总耗时=${Date.now() - start}ms, usage: input=${finalInputTokens}, output=${usage.output_tokens}, cache_read=${finalCacheRead}`,
                { level: 'info' },
              )
              // [Hapii][Cache] Final cache statistics summary
              logForDebugging(
                `[Hapii][Cache] ====== FINAL CACHE SUMMARY ======`,
              )
              logForDebugging(
                `[Hapii][Cache] Total input tokens: ${finalTotalInput} (uncached=${finalInputTokens} + cacheRead=${finalCacheRead} + cacheCreate=${finalCacheCreate})`,
              )
              logForDebugging(
                `[Hapii][Cache] Cache hit rate: ${finalCacheHitRate}% — ${finalCacheRead > 0 ? '✅ CACHE BENEFIT' : '⚠️ NO CACHE BENEFIT'}`,
              )
              if (finalCacheCreate > 0 && finalCacheRead === 0) {
                logForDebugging(
                  `[Hapii][Cache] 💡 NOTE: First request wrote ${finalCacheCreate} tokens to cache. Next requests within 5min (or 1h if eligible) will read at 0.1x cost.`,
                )
              }
              logForDebugging(`[Hapii][Cache] ====== END CACHE SUMMARY ======`)
              break
            }
            break
        }

        yield {
          type: 'stream_event',
          event: part,
          ...(part.type === 'message_start' ? { ttftMs } : undefined),
        }
      }
      // 流循环已退出，清理空闲超时看门狗
      clearStreamIdleTimers()

      // 如果流是被我们的空闲超时看门狗中止的，就降级到非流式重试，而不是当作已完成的流处理。
      if (streamIdleAborted) {
        // 埋点：证明 for-await 在看门狗触发后退出了（而不是永远卡住）。exit_delay_ms 测量 abort 传播延迟：0-10ms 表示 abort 生效；远大于 1000ms 表示是别的东西唤醒了循环。
        const exitDelayMs =
          streamWatchdogFiredAt !== null
            ? Math.round(performance.now() - streamWatchdogFiredAt)
            : -1
        logForDiagnosticsNoPII(
          'info',
          'cli_stream_loop_exited_after_watchdog_clean',
        )
        logEvent('tengu_stream_loop_exited_after_watchdog', {
          request_id: (streamRequestId ??
            'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          exit_delay_ms: exitDelayMs,
          exit_path:
            'clean' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          model:
            options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        // 防止重复 emit：这次 throw 会落到下面的 catch，而那里的 exit_path='error' 埋点以 streamWatchdogFiredAt 作为守卫。
        streamWatchdogFiredAt = null
        throw new Error('Stream idle timeout - no chunks received')
      }

      // 检测流完成后却没有产生任何 assistant 消息的情况。这里覆盖两种代理失败模式：
      // 1. 完全没有事件（!partialMessage）：代理返回了 200，但响应体不是 SSE

      // 2. 部分事件（partialMessage 已设置，但没有完成的内容块，也没收到 stop_reason）：
      //    代理返回了 message_start，但流在 content_block_stop 和携带 stop_reason 的 message_delta 之前就结束了 BetaMessageStream 在 _endRequest() 里有第一项检查，但原始 Stream 没有
      //    —— 没有这个检查，生成器会静默地不返回任何 assistant 消息，在 -p 模式下导致 "Execution error"。

      // 注意：必须检查 stopReason 以避免误报。例如使用结构化输出（--json-schema）时，模型会在第 1 轮调用 StructuredOutput 工具，然后在第 2 轮以 end_turn 回应且没有内容块。这是合法的空响应，不是不完整的流。
      if (!partialMessage || (newMessages.length === 0 && !stopReason)) {
        logForDebugging(
          !partialMessage
            ? 'Stream completed without receiving message_start event - triggering non-streaming fallback'
            : 'Stream completed with message_start but no content blocks completed - triggering non-streaming fallback',
          { level: 'error' },
        )
        logEvent('tengu_stream_no_events', {
          model:
            options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          request_id: (streamRequestId ??
            'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        throw new Error('Stream ended without receiving any events')
      }

      // 如果流式过程中出现过停顿，记录汇总日志
      if (stallCount > 0) {
        logForDebugging(
          `Streaming completed with ${stallCount} stall(s), total stall time: ${(totalStallTime / 1000).toFixed(1)}s`,
          { level: 'warn' },
        )
        logEvent('tengu_streaming_stall_summary', {
          stall_count: stallCount,
          total_stall_time_ms: totalStallTime,
          model:
            options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          request_id: (streamRequestId ??
            'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
      }

      // 根据响应 token 判断缓存是否真的被打破
      if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
        void checkResponseForCacheBreak(
          options.querySource,
          usage.cache_read_input_tokens,
          usage.cache_creation_input_tokens,
          messages,
          options.agentId,
          streamRequestId,
        )
      }

      // 处理降级百分比响应头和配额状态（如果有）streamResponse 是在前面 withRetry 回调里创建流时设置的。
      // TypeScript 的控制流分析无法跟踪回调里设置的 streamResponse eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      const resp = streamResponse as unknown as Response | undefined
      if (resp) {
        extractQuotaStatusFromHeaders(resp.headers)
        // 走同一个客户端路径的非 Anthropic provider（Bedrock）会暴露自己
        // 的限流头 —— 让它们的适配器用自己的 bucket 覆盖 store。
        // Anthropic 的适配器在 extractQuotaStatusFromHeaders 内部执行。
        if (getAPIProvider() === 'bedrock') {
          updateProviderBuckets(
            'bedrock',
            bedrockAdapter.parseHeaders(resp.headers),
          )
        }
        // 保存响应头用于网关检测
        responseHeaders = resp.headers
      }
    } catch (streamingError) {
      // 错误路径也要清理空闲超时看门狗
      clearStreamIdleTimers()

      // 埋点：如果看门狗已经触发、且 for-await 抛出了（而不是干净退出），记录循环确实已退出、以及距看门狗触发多久。用于区分真正的卡死和错误退出。
      if (streamIdleAborted && streamWatchdogFiredAt !== null) {
        const exitDelayMs = Math.round(
          performance.now() - streamWatchdogFiredAt,
        )
        logForDiagnosticsNoPII(
          'info',
          'cli_stream_loop_exited_after_watchdog_error',
        )
        logEvent('tengu_stream_loop_exited_after_watchdog', {
          request_id: (streamRequestId ??
            'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          exit_delay_ms: exitDelayMs,
          exit_path:
            'error' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          error_name:
            streamingError instanceof Error
              ? (streamingError.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
              : ('unknown' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS),
          model:
            options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
      }

      if (streamingError instanceof APIUserAbortError) {
        // 检查 abort 信号是否由用户触发（ESC 键） 如果 signal 已中止，是用户主动中止否则很可能是 SDK 的超时
        if (signal.aborted) {
          // 真正的用户中止（按下了 ESC 键）
          logForDebugging(
            `Streaming aborted by user: ${errorMessage(streamingError)}`,
          )
          if (isAdvisorInProgress) {
            logEvent('tengu_advisor_tool_interrupted', {
              model:
                options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              advisor_model: (advisorModel ??
                'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            })
          }
          throw streamingError
        } else {
          // SDK 抛出了 APIUserAbortError，但我们的 signal 未被中止说明这是 SDK 内部超时
          logForDebugging(
            `Streaming timeout (SDK abort): ${streamingError.message}`,
            { level: 'error' },
          )
          // 抛出更具体的超时错误
          throw new APIConnectionTimeoutError({ message: 'Request timed out' })
        }
      }

      // 当此 flag 开启时，跳过非流式降级，让错误直接传给 withRetry。流式工具执行处于活动状态时，流式中途降级会导致工具被重复执行：
      // 部分流已经启动了一个工具，然后非流式重试又产生同样的 tool_use 并再跑一次。参见 inc-4258。
      const disableFallback =
        isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK) ||
        getFeatureValue_CACHED_MAY_BE_STALE(
          'tengu_disable_streaming_to_non_streaming_fallback',
          false,
        )

      if (disableFallback) {
        logForDebugging(
          `Error streaming (non-streaming fallback disabled): ${errorMessage(streamingError)}`,
          { level: 'error' },
        )
        logEvent('tengu_streaming_fallback_to_non_streaming', {
          model:
            options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          error:
            streamingError instanceof Error
              ? (streamingError.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
              : (String(
                  streamingError,
                ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS),
          attemptNumber,
          maxOutputTokens,
          thinkingType:
            thinkingConfig.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          ...(thinkingConfig.type === 'enabled' && {
            thinkingBudgetTokens: thinkingConfig.budgetTokens,
          }),
          fallback_disabled: true,
          request_id: (streamRequestId ??
            'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          fallback_cause: (streamIdleAborted
            ? 'watchdog'
            : 'other') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        throw streamingError
      }

      logForDebugging(
        `Error streaming, falling back to non-streaming mode: ${errorMessage(streamingError)}`,
        { level: 'error' },
      )
      didFallBackToNonStreaming = true
      if (options.onStreamingFallback) {
        options.onStreamingFallback()
      }

      logEvent('tengu_streaming_fallback_to_non_streaming', {
        model:
          options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        error:
          streamingError instanceof Error
            ? (streamingError.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
            : (String(
                streamingError,
              ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS),
        attemptNumber,
        maxOutputTokens,
        thinkingType:
          thinkingConfig.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        ...(thinkingConfig.type === 'enabled' && {
          thinkingBudgetTokens: thinkingConfig.budgetTokens,
        }),
        fallback_disabled: false,
        request_id: (streamRequestId ??
          'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        fallback_cause: (streamIdleAborted
          ? 'watchdog'
          : 'other') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })

      // 降级到带重试的非流式模式。
      // 如果流式失败本身是 529，把它计入连续 529 预算，使触发模型降级前总共能承受的 529 次数在流式和非流式模式下保持一致。
      // 这是对 https://github.com/anthropics/claude-code/issues/1513 的推测性修复
      // 埋点：证明进入了 executeNonStreamingRequest（而不是降级事件触发但调用本身卡在派发阶段）。
      logForDiagnosticsNoPII('info', 'cli_nonstreaming_fallback_started')
      logEvent('tengu_nonstreaming_fallback_started', {
        request_id: (streamRequestId ??
          'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        model:
          options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        fallback_cause: (streamIdleAborted
          ? 'watchdog'
          : 'other') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      const result = yield* executeNonStreamingRequest(
        { model: options.model, source: options.querySource },
        {
          model: options.model,
          fallbackModel: options.fallbackModel,
          thinkingConfig,
          ...(isFastModeEnabled() && { fastMode: isFastMode }),
          signal,
          initialConsecutive529Errors: is529Error(streamingError) ? 1 : 0,
          querySource: options.querySource,
        },
        paramsFromContext,
        (attempt, _startTime, tokens) => {
          attemptNumber = attempt
          maxOutputTokens = tokens
        },
        params => captureAPIRequest(params, options.querySource),
        streamRequestId,
      )

      const m: AssistantMessage = {
        message: {
          ...result,
          content: normalizeContentFromAPI(
            result.content,
            tools,
            options.agentId,
          ) as MessageContent,
        },
        requestId: streamRequestId ?? undefined,
        type: 'assistant',
        uuid: randomUUID(),
        timestamp: new Date().toISOString(),
        ...(process.env.USER_TYPE === 'ant' &&
          research !== undefined && {
            research,
          }),
        ...(advisorModel && {
          advisorModel,
        }),
      }
      newMessages.push(m)
      fallbackMessage = m
      yield m
    } finally {
      clearStreamIdleTimers()
    }
  } catch (errorFromRetry) {
    // FallbackTriggeredError 必须向上抛给 query.ts，由它执行真正的模型切换。在这里吞掉它会让降级变成空操作——用户只会看到 "Model fallback triggered: X -> Y" 的错误信息，而不会在降级模型上真正重试。
    if (errorFromRetry instanceof FallbackTriggeredError) {
      throw errorFromRetry
    }

    // 检查这是否是流创建期间的 404 错误，应触发非流式降级。这里处理对流式端点返回 404、但非流式能正常工作的网关。在 v2.1.8 之前，
    // BetaMessageStream 会在迭代过程中抛出 404（由内层 catch 捕获并降级），但改用原始流之后，404 在创建期间抛出（在这里被捕获）。
    const is404StreamCreationError =
      !didFallBackToNonStreaming &&
      errorFromRetry instanceof CannotRetryError &&
      errorFromRetry.originalError instanceof APIError &&
      errorFromRetry.originalError.status === 404

    if (is404StreamCreationError) {
      // 404 在 .withResponse() 处抛出，此时 streamRequestId 尚未赋值，而 CannotRetryError 表示每次重试都失败了——因此从错误头中取失败的 request ID。
      const failedRequestId =
        (errorFromRetry.originalError as APIError).requestID ?? 'unknown'
      logForDebugging(
        'Streaming endpoint returned 404, falling back to non-streaming mode',
        { level: 'warn' },
      )
      didFallBackToNonStreaming = true
      if (options.onStreamingFallback) {
        options.onStreamingFallback()
      }

      logEvent('tengu_streaming_fallback_to_non_streaming', {
        model:
          options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        error:
          '404_stream_creation' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        attemptNumber,
        maxOutputTokens,
        thinkingType:
          thinkingConfig.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        ...(thinkingConfig.type === 'enabled' && {
          thinkingBudgetTokens: thinkingConfig.budgetTokens,
        }),
        request_id:
          failedRequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        fallback_cause:
          '404_stream_creation' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })

      try {
        // 降级到非流式模式
        const result = yield* executeNonStreamingRequest(
          { model: options.model, source: options.querySource },
          {
            model: options.model,
            fallbackModel: options.fallbackModel,
            thinkingConfig,
            ...(isFastModeEnabled() && { fastMode: isFastMode }),
            signal,
          },
          paramsFromContext,
          (attempt, _startTime, tokens) => {
            attemptNumber = attempt
            maxOutputTokens = tokens
          },
          params => captureAPIRequest(params, options.querySource),
          failedRequestId,
        )

        const m: AssistantMessage = {
          message: {
            ...result,
            content: normalizeContentFromAPI(
              result.content,
              tools,
              options.agentId,
            ) as MessageContent,
          },
          requestId: streamRequestId ?? undefined,
          type: 'assistant',
          uuid: randomUUID(),
          timestamp: new Date().toISOString(),
          ...(process.env.USER_TYPE === 'ant' &&
            research !== undefined && { research }),
          ...(advisorModel && { advisorModel }),
        }
        newMessages.push(m)
        fallbackMessage = m
        yield m

        // 继续走到下面的成功日志
      } catch (fallbackError) {
        // 把模型降级信号向上传播给 query.ts（见上面的注释）。
        if (fallbackError instanceof FallbackTriggeredError) {
          throw fallbackError
        }

        // 降级也失败了，按普通错误处理
        logForDebugging(
          `Non-streaming fallback also failed: ${errorMessage(fallbackError)}`,
          { level: 'error' },
        )

        let error = fallbackError
        let errorModel = options.model
        if (fallbackError instanceof CannotRetryError) {
          error = fallbackError.originalError
          errorModel = fallbackError.retryContext.model
        }

        if (error instanceof APIError) {
          extractQuotaStatusFromError(error)
        }

        const requestId =
          streamRequestId ||
          (error instanceof APIError ? error.requestID : undefined) ||
          (error instanceof APIError
            ? (error.error as { request_id?: string })?.request_id
            : undefined)

        logAPIError({
          error,
          model: errorModel,
          messageCount: messagesForAPI.length,
          messageTokens: tokenCountFromLastAPIResponse(messagesForAPI),
          durationMs: Date.now() - start,
          durationMsIncludingRetries: Date.now() - startIncludingRetries,
          attempt: attemptNumber,
          requestId,
          clientRequestId,
          didFallBackToNonStreaming,
          queryTracking: options.queryTracking,
          querySource: options.querySource,
          llmSpan,
          fastMode: isFastModeRequest,
          previousRequestId,
        })

        if (error instanceof APIUserAbortError) {
          releaseStreamResources()
          return
        }

        yield getAssistantMessageFromError(error, errorModel, {
          messages,
          messagesForAPI,
        })
        releaseStreamResources()
        return
      }
    } else {
      // 非 404 错误的原始错误处理
      logForDebugging(`Error in API request: ${errorMessage(errorFromRetry)}`, {
        level: 'error',
      })

      let error = errorFromRetry
      let errorModel = options.model
      if (errorFromRetry instanceof CannotRetryError) {
        error = errorFromRetry.originalError
        errorModel = errorFromRetry.retryContext.model
      }

      // 如果是限流错误，从错误头中提取配额状态
      if (error instanceof APIError) {
        extractQuotaStatusFromError(error)
      }

      // 从流、错误头或错误体中提取 requestId
      const requestId =
        streamRequestId ||
        (error instanceof APIError ? error.requestID : undefined) ||
        (error instanceof APIError
          ? (error.error as { request_id?: string })?.request_id
          : undefined)

      logAPIError({
        error,
        model: errorModel,
        messageCount: messagesForAPI.length,
        messageTokens: tokenCountFromLastAPIResponse(messagesForAPI),
        durationMs: Date.now() - start,
        durationMsIncludingRetries: Date.now() - startIncludingRetries,
        attempt: attemptNumber,
        requestId,
        clientRequestId,
        didFallBackToNonStreaming,
        queryTracking: options.queryTracking,
        querySource: options.querySource,
        llmSpan,
        fastMode: isFastModeRequest,
        previousRequestId,
      })

      // 用户中止时不 yield assistant 错误消息 中断消息由 query.ts 处理
      if (error instanceof APIUserAbortError) {
        releaseStreamResources()
        return
      }

      yield getAssistantMessageFromError(error, errorModel, {
        messages,
        messagesForAPI,
      })
      releaseStreamResources()
      return
    }
  } finally {
    stopSessionActivity('api_call')
    // 必须放在 finally 块里：如果生成器被提前通过 .return() 终止（例如消费者跳出 for-await-of，或 query.ts 遇到中止），try/finally 之后的代码永远不会执行。
    // 不这样做的话，Response 对象的本地 TLS/socket 缓冲区会一直泄漏，直到生成器本身被 GC 回收（见 GH #32920）。
    releaseStreamResources()

    // 非流式降级的成本：流式路径在任何 yield 之前于 message_delta 处理器里跟踪成本。降级路径是先 push 到 newMessages 再 yield，因此跟踪必须放在这里，才能在 yield 处的 .return() 中存活。
    if (fallbackMessage) {
      const fallbackUsage = fallbackMessage.message
        .usage as BetaMessageDeltaUsage
      usage = updateUsage(EMPTY_USAGE, fallbackUsage)
      stopReason = fallbackMessage.message.stop_reason as BetaStopReason
      const fallbackCost = calculateUSDCost(
        resolvedModel,
        fallbackUsage as unknown as BetaUsage,
      )
      costUSD += addToTotalSessionCost(
        fallbackCost,
        fallbackUsage as unknown as BetaUsage,
        options.model,
      )
    }
  }

  // 把所有已注册的工具标记为已发送给 API，使它们具备被删除的资格
  if (feature('CACHED_MICROCOMPACT') && cachedMCEnabled) {
    markToolsSentToAPIState()
  }

  // 跟踪主会话链的最后一个 requestId，以便关闭时向推理层发送缓存驱逐提示。排除后台会话（Ctrl+B）——它们共享 repl_main_thread querySource，
  // 但运行在 agent 上下文里——它们是独立的会话链，当前台会话 clear 时不应驱逐它们的缓存。
  if (
    streamRequestId &&
    !getAgentContext() &&
    (options.querySource.startsWith('repl_main_thread') ||
      options.querySource === 'sdk')
  ) {
    setLastMainRequestId(streamRequestId)
  }

  // 预先计算标量，避免触发即忘的 .then() 闭包 pin 住整个 messagesForAPI 数组（即上下文窗口限制以内的整段对话）直到 getToolPermissionContext() 完成。
  const logMessageCount = messagesForAPI.length
  const logMessageTokens = tokenCountFromLastAPIResponse(messagesForAPI)

  // 在 Langfuse 中记录 LLM 观测（未配置时为 no-op）
  recordLLMObservation(options.langfuseTrace ?? null, {
    model: resolvedModel,
    provider: getAPIProvider(),
    input: convertMessagesToLangfuse(messagesForAPI, systemPrompt),
    output: convertOutputToLangfuse(newMessages),
    usage: {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_creation_input_tokens: usage.cache_creation_input_tokens,
      cache_read_input_tokens: usage.cache_read_input_tokens,
    },
    startTime: new Date(startIncludingRetries),
    endTime: new Date(),
    completionStartTime: ttftMs > 0 ? new Date(start + ttftMs) : undefined,
    tools: convertToolsToLangfuse(toolSchemas as unknown[]),
    thinking: langfuseThinking,
  })

  void options.getToolPermissionContext().then(permissionContext => {
    logAPISuccessAndDuration({
      model:
        (newMessages[0]?.message.model as string | undefined) ??
        partialMessage?.model ??
        options.model,
      preNormalizedModel: options.model,
      usage,
      start,
      startIncludingRetries,
      attempt: attemptNumber,
      messageCount: logMessageCount,
      messageTokens: logMessageTokens,
      requestId: streamRequestId ?? null,
      stopReason,
      ttftMs,
      didFallBackToNonStreaming,
      querySource: options.querySource,
      headers: responseHeaders,
      costUSD,
      queryTracking: options.queryTracking,
      permissionMode: permissionContext.mode,
      // 传入 newMessages 用于 beta tracing —— 仅在 beta tracing 启用时，才在 logging.ts 中做提取
      newMessages,
      llmSpan,
      globalCacheStrategy,
      requestSetupMs: start - startIncludingRetries,
      attemptStartTimes,
      fastMode: isFastModeRequest,
      previousRequestId,
      betas: lastRequestBetas,
    })
  })

  // 防御性：正常完成时也释放一次（如果 finally 已执行则为 no-op）。
  logForDebugging(
    `------------ queryModel 结束 --------- model=${options.model} stopReason=${stopReason ?? 'N/A'} usage.in=${usage.input_tokens} out=${usage.output_tokens}`,
    { level: 'info' },
  )
  releaseStreamResources()
}

/**
 * 清理流资源以防止内存泄漏。
 * @internal 导出用于测试
 */
export function cleanupStream(
  stream: Stream<BetaRawMessageStreamEvent> | undefined,
): void {
  if (!stream) {
    return
  }
  try {
    // 如果尚未中止，通过 controller 中止流
    if (!stream.controller.signal.aborted) {
      stream.controller.abort()
    }
  } catch {
    // 忽略 —— 流可能已经关闭
  }
}

/**
 * 用流式 API 事件中的新值更新 usage 统计。
 * 注意：Anthropic 的流式 API 提供的是累计 usage，不是增量 delta。
 * 每个事件包含截至当前位置的完整 usage。
 *
 * 输入相关的 token（input_tokens、cache_creation_input_tokens、cache_read_input_tokens）
 * 通常在 message_start 中设置并保持不变。message_delta 事件可能为这些字段
 * 发送显式的 0 值，不应覆盖 message_start 中的值。
 * 我们只在这些字段为非 null、非 0 值时更新。
 */
export function updateUsage(
  usage: Readonly<NonNullableUsage>,
  partUsage: BetaMessageDeltaUsage | undefined,
): NonNullableUsage {
  if (!partUsage) {
    return { ...usage }
  }
  return {
    input_tokens:
      partUsage.input_tokens !== null && partUsage.input_tokens > 0
        ? partUsage.input_tokens
        : usage.input_tokens,
    cache_creation_input_tokens:
      partUsage.cache_creation_input_tokens !== null &&
      partUsage.cache_creation_input_tokens > 0
        ? partUsage.cache_creation_input_tokens
        : usage.cache_creation_input_tokens,
    cache_read_input_tokens:
      partUsage.cache_read_input_tokens !== null &&
      partUsage.cache_read_input_tokens > 0
        ? partUsage.cache_read_input_tokens
        : usage.cache_read_input_tokens,
    output_tokens: partUsage.output_tokens ?? usage.output_tokens,
    server_tool_use: {
      web_search_requests:
        partUsage.server_tool_use?.web_search_requests ??
        usage.server_tool_use.web_search_requests,
      web_fetch_requests:
        partUsage.server_tool_use?.web_fetch_requests ??
        usage.server_tool_use.web_fetch_requests,
    },
    service_tier: usage.service_tier,
    cache_creation: {
      // SDK 类型 BetaMessageDeltaUsage 缺少 cache_creation，但它确实存在！
      ephemeral_1h_input_tokens:
        (partUsage as BetaUsage).cache_creation?.ephemeral_1h_input_tokens ??
        usage.cache_creation.ephemeral_1h_input_tokens,
      ephemeral_5m_input_tokens:
        (partUsage as BetaUsage).cache_creation?.ephemeral_5m_input_tokens ??
        usage.cache_creation.ephemeral_5m_input_tokens,
    },
    // cache_deleted_input_tokens：当 cache editing 删除 KV 缓存内容时由
    // API 返回，但不在 SDK 类型中。故意不放进 NonNullableUsage，让这个
    // 字符串被外部构建的死代码消除掉。
    // 使用与其他 token 字段相同的 > 0 守卫，防止 message_delta 用 0 覆盖
    // 真实值。
    ...(feature('CACHED_MICROCOMPACT')
      ? {
          cache_deleted_input_tokens:
            (partUsage as unknown as { cache_deleted_input_tokens?: number })
              .cache_deleted_input_tokens != null &&
            (partUsage as unknown as { cache_deleted_input_tokens: number })
              .cache_deleted_input_tokens > 0
              ? (partUsage as unknown as { cache_deleted_input_tokens: number })
                  .cache_deleted_input_tokens
              : ((usage as unknown as { cache_deleted_input_tokens?: number })
                  .cache_deleted_input_tokens ?? 0),
        }
      : {}),
    inference_geo: usage.inference_geo,
    iterations: partUsage.iterations ?? usage.iterations,
    speed: (partUsage as BetaUsage).speed ?? usage.speed,
  }
}

/**
 * 把一条消息的 usage 累加到总 usage 对象中。
 * 用于跟踪跨多轮 assistant 消息的累计 usage。
 */
export function accumulateUsage(
  totalUsage: Readonly<NonNullableUsage>,
  messageUsage: Readonly<NonNullableUsage>,
): NonNullableUsage {
  return {
    input_tokens: totalUsage.input_tokens + messageUsage.input_tokens,
    cache_creation_input_tokens:
      totalUsage.cache_creation_input_tokens +
      messageUsage.cache_creation_input_tokens,
    cache_read_input_tokens:
      totalUsage.cache_read_input_tokens + messageUsage.cache_read_input_tokens,
    output_tokens: totalUsage.output_tokens + messageUsage.output_tokens,
    server_tool_use: {
      web_search_requests:
        totalUsage.server_tool_use.web_search_requests +
        messageUsage.server_tool_use.web_search_requests,
      web_fetch_requests:
        totalUsage.server_tool_use.web_fetch_requests +
        messageUsage.server_tool_use.web_fetch_requests,
    },
    service_tier: messageUsage.service_tier, // 使用最新的 service tier
    cache_creation: {
      ephemeral_1h_input_tokens:
        totalUsage.cache_creation.ephemeral_1h_input_tokens +
        messageUsage.cache_creation.ephemeral_1h_input_tokens,
      ephemeral_5m_input_tokens:
        totalUsage.cache_creation.ephemeral_5m_input_tokens +
        messageUsage.cache_creation.ephemeral_5m_input_tokens,
    },
    // 见 updateUsage 中的注释 —— 该字段不在 NonNullableUsage 中，是为了让
    // 这个字符串不进入外部构建。
    ...(feature('CACHED_MICROCOMPACT')
      ? {
          cache_deleted_input_tokens:
            ((totalUsage as unknown as { cache_deleted_input_tokens?: number })
              .cache_deleted_input_tokens ?? 0) +
            ((
              messageUsage as unknown as { cache_deleted_input_tokens?: number }
            ).cache_deleted_input_tokens ?? 0),
        }
      : {}),
    inference_geo: messageUsage.inference_geo, // 使用最新的
    iterations: messageUsage.iterations, // 使用最新的
    speed: messageUsage.speed, // 使用最新的
  }
}

function isToolResultBlock(
  block: unknown,
): block is { type: 'tool_result'; tool_use_id: string } {
  return (
    block !== null &&
    typeof block === 'object' &&
    'type' in block &&
    (block as { type: string }).type === 'tool_result' &&
    'tool_use_id' in block
  )
}

type CachedMCEditsBlock = {
  type: 'cache_edits'
  edits: { type: 'delete'; cache_reference: string }[]
}

type CachedMCPinnedEdits = {
  userMessageIndex: number
  block: CachedMCEditsBlock
}

// 导出用于测试 cache_reference 的位置约束
export function addCacheBreakpoints(
  messages: (UserMessage | AssistantMessage)[],
  enablePromptCaching: boolean,
  querySource?: QuerySource,
  useCachedMC = false,
  newCacheEdits?: CachedMCEditsBlock | null,
  pinnedEdits?: CachedMCPinnedEdits[],
  skipCacheWrite = false,
): MessageParam[] {
  logEvent('tengu_api_cache_breakpoints', {
    totalMessageCount: messages.length,
    cachingEnabled: enablePromptCaching,
    skipCacheWrite,
  })
  logForDebugging(`[Hapii][Cache] ====== addCacheBreakpoints START ======`)
  logForDebugging(
    `[Hapii][Cache] addCacheBreakpoints: msgCount=${messages.length} enableCaching=${enablePromptCaching} skipCacheWrite=${skipCacheWrite} useCachedMC=${useCachedMC}`,
  )

  // 每次请求只能有一个消息级的 cache_control 标记。Mycro 的轮次间驱逐
  // （page_manager/index.rs: Index::insert）会释放在任何未出现在
  // cache_store_int_token_boundaries 中的缓存前缀位置的本地注意力 KV 页。
  // 如果有两个标记，倒数第二个位置会被保护，它的本地页会多存活一轮，
  // 尽管永远不会从那里恢复——只有一个标记时它们会立即被释放。对
  // 触发即忘的分叉（skipCacheWrite），我们把标记移到倒数第二条消息：
  // 这是最后一个共享前缀点，因此写入对 mycro 而言是无操作的合并
  // （条目已存在），分叉也不会在 KVCC 中留下自己的尾部。密集页是引用计数的，
  // 无论哪种情况都会通过新哈希存活。
  const markerIndex = skipCacheWrite ? messages.length - 2 : messages.length - 1
  logForDebugging(
    `[Hapii][Cache] addCacheBreakpoints: cache_control marker will be placed at message index=${markerIndex} (${skipCacheWrite ? 'skipCacheWrite mode → second-to-last' : 'normal mode → last message'})`,
  )

  const result = messages.map((msg, index) => {
    const addCache = index === markerIndex
    if (addCache) {
      logForDebugging(
        `[Hapii][Cache] addCacheBreakpoints: → Adding cache_control to message[${index}] role=${msg.type} (THIS IS THE CACHE BREAKPOINT)`,
      )
    }
    if (msg.type === 'user') {
      return userMessageToMessageParam(
        msg,
        addCache,
        enablePromptCaching,
        querySource,
      )
    }
    return assistantMessageToMessageParam(
      msg,
      addCache,
      enablePromptCaching,
      querySource,
    )
  })

  logForDebugging(
    `[Hapii][Cache] addCacheBreakpoints: processed ${result.length} messages, cache breakpoint at index=${markerIndex}`,
  )

  if (!useCachedMC) {
    logForDebugging(
      `[Hapii][Cache] addCacheBreakpoints: useCachedMC=false, returning without cache_edits processing`,
    )
    return result
  }

  logForDebugging(
    `[Hapii][Cache] addCacheBreakpoints: useCachedMC=true, processing cache_edits for CachedMC optimization`,
  )

  // 跟踪所有正在被删除的 cache_reference，避免跨块重复。
  const seenDeleteRefs = new Set<string>()

  // 用于对 cache_edits 块与已见过的删除做去重的辅助函数
  const deduplicateEdits = (block: CachedMCEditsBlock): CachedMCEditsBlock => {
    const uniqueEdits = block.edits.filter(edit => {
      if (seenDeleteRefs.has(edit.cache_reference)) {
        return false
      }
      seenDeleteRefs.add(edit.cache_reference)
      return true
    })
    return { ...block, edits: uniqueEdits }
  }

  // 把之前 pin 的所有 cache_edits 重新插入到原位置
  for (const pinned of pinnedEdits ?? []) {
    const msg = result[pinned.userMessageIndex]
    if (msg && msg.role === 'user') {
      if (!Array.isArray(msg.content)) {
        msg.content = [{ type: 'text', text: msg.content as string }]
      }
      const dedupedBlock = deduplicateEdits(pinned.block)
      if (dedupedBlock.edits.length > 0) {
        insertBlockAfterToolResults(msg.content, dedupedBlock)
      }
    }
  }

  // 把新的 cache_edits 插入到最后一条 user 消息中，并把它们 pin 起来
  if (newCacheEdits && result.length > 0) {
    const dedupedNewEdits = deduplicateEdits(newCacheEdits)
    if (dedupedNewEdits.edits.length > 0) {
      for (let i = result.length - 1; i >= 0; i--) {
        const msg = result[i]
        if (msg && msg.role === 'user') {
          if (!Array.isArray(msg.content)) {
            msg.content = [{ type: 'text', text: msg.content as string }]
          }
          insertBlockAfterToolResults(msg.content, dedupedNewEdits)
          // Pin，使此块在未来调用中以相同位置重新发送
          pinCacheEdits(i, newCacheEdits as any)

          logForDebugging(
            `Added cache_edits block with ${dedupedNewEdits.edits.length} deletion(s) to message[${i}]: ${dedupedNewEdits.edits.map(e => e.cache_reference).join(', ')}`,
          )
          break
        }
      }
    }
  }

  // 给位于缓存前缀内的 tool_result 块添加 cache_reference。
  // 必须在 cache_edits 插入之后做，因为那一步会修改内容数组。
  // 注意：此代码仅在 useCachedMC=true 时运行（在约 3202 行提前 return）。
  if (enablePromptCaching) {
    // 查找最后一个包含 cache_control 标记的消息
    let lastCCMsg = -1
    for (let i = 0; i < result.length; i++) {
      const msg = result[i]!
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block && typeof block === 'object' && 'cache_control' in block) {
            lastCCMsg = i
          }
        }
      }
    }

    // 给严格位于最后一个 cache_control 标记之前的 tool_result 块添加
    // cache_reference。API 要求 cache_reference 出现在最后一个 cache_control
    // "之前或之上"——我们采用严格的"之前"，以规避 cache_edits 拼接移动块索引
    // 的边界情况。
    //
    // 创建新对象而不是原地修改，避免污染被不支持 cache_editing 的模型所用
    // 的二次查询中复用的块。
    if (lastCCMsg >= 0) {
      for (let i = 0; i < lastCCMsg; i++) {
        const msg = result[i]!
        if (msg.role !== 'user' || !Array.isArray(msg.content)) {
          continue
        }
        let cloned = false
        for (let j = 0; j < msg.content.length; j++) {
          const block = msg.content[j]
          if (block && isToolResultBlock(block)) {
            if (!cloned) {
              msg.content = [...msg.content]
              cloned = true
            }
            msg.content[j] = Object.assign({}, block, {
              cache_reference: block.tool_use_id,
            })
          }
        }
      }
    }
  }

  return result
}

export function buildSystemPromptBlocks(
  systemPrompt: SystemPrompt,
  enablePromptCaching: boolean,
  options?: {
    skipGlobalCacheForSystemPrompt?: boolean
    querySource?: QuerySource
  },
): TextBlockParam[] {
  const totalChars = systemPrompt.reduce((a, s) => a + s.length, 0)
  logForDebugging(`[Hapii][Cache] ====== buildSystemPromptBlocks START ======`)
  logForDebugging(
    `[Hapii][Cache] buildSystemPromptBlocks: promptBlockCount=${systemPrompt.length} totalChars=${totalChars} estTokens=~${Math.round(totalChars / 4)} enableCaching=${enablePromptCaching} skipGlobalCache=${options?.skipGlobalCacheForSystemPrompt ?? false}`,
  )
  // 重要：不要为缓存再加任何块，否则会返回 400
  const blocks = splitSysPromptPrefix(systemPrompt, {
    skipGlobalCacheForSystemPrompt: options?.skipGlobalCacheForSystemPrompt,
  })
  logForDebugging(
    `[Hapii][Cache] buildSystemPromptBlocks: splitSysPromptPrefix returned ${blocks.length} blocks with scopes=[${blocks.map(b => b.cacheScope ?? 'null').join(', ')}]`,
  )
  const result = blocks.map((block, i) => {
    const willAddCacheControl = enablePromptCaching && block.cacheScope !== null
    const cacheControlValue = willAddCacheControl
      ? getCacheControl({
          scope: block.cacheScope ?? undefined,
          querySource: options?.querySource,
        })
      : null
    logForDebugging(
      `[Hapii][Cache] buildSystemPromptBlocks: block[${i}] scope=${block.cacheScope ?? 'null'} chars=${block.text.length} estTokens=~${Math.round(block.text.length / 4)} cache_control=${willAddCacheControl ? JSON.stringify(cacheControlValue) : 'none'}`,
    )
    return {
      type: 'text' as const,
      text: block.text,
      ...(willAddCacheControl && {
        cache_control: cacheControlValue!,
      }),
    }
  })
  const totalCacheableBlocks = result.filter(b => b.cache_control).length
  logForDebugging(
    `[Hapii][Cache] buildSystemPromptBlocks: result ${result.length} blocks, ${totalCacheableBlocks} with cache_control`,
  )
  logForDebugging(`[Hapii][Cache] ====== buildSystemPromptBlocks END ======`)
  return result
}

type HaikuOptions = Omit<Options, 'model' | 'getToolPermissionContext'>

export async function queryHaiku({
  systemPrompt = asSystemPrompt([]),
  userPrompt,
  outputFormat,
  signal,
  options,
}: {
  systemPrompt: SystemPrompt
  userPrompt: string
  outputFormat?: BetaJSONOutputFormat
  signal: AbortSignal
  options: HaikuOptions
}): Promise<AssistantMessage> {
  const result = await withVCR(
    [
      createUserMessage({
        content: systemPrompt.map(text => ({ type: 'text', text })),
      }),
      createUserMessage({
        content: userPrompt,
      }),
    ],
    async () => {
      const messages = [
        createUserMessage({
          content: userPrompt,
        }),
      ]

      const result = await queryModelWithoutStreaming({
        messages,
        systemPrompt,
        thinkingConfig: { type: 'disabled' },
        tools: [],
        signal,
        options: {
          ...options,
          model: getSmallFastModel(),
          enablePromptCaching: options.enablePromptCaching ?? false,
          outputFormat,
          async getToolPermissionContext() {
            return getEmptyToolPermissionContext()
          },
        },
      })
      return [result]
    },
  )
  // Haiku 不使用流式，所以这样做是安全的
  return result[0]! as AssistantMessage
}

type QueryWithModelOptions = Omit<Options, 'getToolPermissionContext'>

/**
 * 通过 Claude Code 基础设施查询指定模型。
 * 这会走完整的查询流水线，包括正确的认证、betas 和 headers —— 与
 * 直接调用 API 不同。
 */
export async function queryWithModel({
  systemPrompt = asSystemPrompt([]),
  userPrompt,
  outputFormat,
  signal,
  options,
}: {
  systemPrompt: SystemPrompt
  userPrompt: string
  outputFormat?: BetaJSONOutputFormat
  signal: AbortSignal
  options: QueryWithModelOptions
}): Promise<AssistantMessage> {
  const result = await withVCR(
    [
      createUserMessage({
        content: systemPrompt.map(text => ({ type: 'text', text })),
      }),
      createUserMessage({
        content: userPrompt,
      }),
    ],
    async () => {
      const messages = [
        createUserMessage({
          content: userPrompt,
        }),
      ]

      const result = await queryModelWithoutStreaming({
        messages,
        systemPrompt,
        thinkingConfig: { type: 'disabled' },
        tools: [],
        signal,
        options: {
          ...options,
          enablePromptCaching: options.enablePromptCaching ?? false,
          outputFormat,
          async getToolPermissionContext() {
            return getEmptyToolPermissionContext()
          },
        },
      })
      return [result]
    },
  )
  return result[0]! as AssistantMessage
}

// 根据文档，非流式请求最长 10 分钟：
// https://platform.claude.com/docs/en/api/errors#long-requests
// SDK 的 21333 token 上限源自 10 分钟 × 128k token/小时，但我们通过设置
// 客户端级超时绕过了它，因此可以把上限设得更高。
export const MAX_NON_STREAMING_TOKENS = 64_000

/**
 * 当 max_tokens 在非流式降级中被限制时，调整 thinking 预算。
 * 保证 API 约束：max_tokens > thinking.budget_tokens
 *
 * @param params - 将发送给 API 的参数
 * @param maxTokensCap - 允许的最大 token 数（MAX_NON_STREAMING_TOKENS）
 * @returns 调整后的参数（必要时限制 thinking 预算）
 */
export function adjustParamsForNonStreaming<
  T extends {
    max_tokens: number
    thinking?: BetaMessageStreamParams['thinking']
  },
>(params: T, maxTokensCap: number): T {
  const cappedMaxTokens = Math.min(params.max_tokens, maxTokensCap)

  // 如果 thinking 预算超过被限制的 max_tokens，则调整它
  // 以维持约束：max_tokens > thinking.budget_tokens
  const adjustedParams = { ...params }
  if (
    adjustedParams.thinking?.type === 'enabled' &&
    adjustedParams.thinking.budget_tokens
  ) {
    adjustedParams.thinking = {
      ...adjustedParams.thinking,
      budget_tokens: Math.min(
        adjustedParams.thinking.budget_tokens,
        cappedMaxTokens - 1, // 必须比 max_tokens 至少小 1
      ),
    }
  }

  return {
    ...adjustedParams,
    max_tokens: cappedMaxTokens,
  }
}

function isMaxTokensCapEnabled(): boolean {
  // 第三方默认：false（Bedrock/Vertex 上未验证）
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_otk_slot_v1', false)
}

export function getMaxOutputTokensForModel(model: string): number {
  const maxOutputTokens = getModelMaxOutputTokens(model)

  // 槽位预留限制：所有模型的默认值降到 8k。BQ p99 输出 = 4,911 token；
  // 32k/64k 默认值超额预留了 8-16 倍的槽位容量。命中上限的请求会在
  // 64k 上获得一次干净的重试（见 query.ts 的 max_output_tokens_escalate）。
  // Math.min 让原生默认值较低的模型（例如 claude-3-opus 的 4k）保持原值。
  // 在环境变量覆盖之前应用，使 CLAUDE_CODE_MAX_OUTPUT_TOKENS 仍然优先。
  const defaultTokens = isMaxTokensCapEnabled()
    ? Math.min(maxOutputTokens.default, CAPPED_DEFAULT_MAX_TOKENS)
    : maxOutputTokens.default

  const result = validateBoundedIntEnvVar(
    'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
    process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS,
    defaultTokens,
    maxOutputTokens.upperLimit,
  )
  return result.effective
}
