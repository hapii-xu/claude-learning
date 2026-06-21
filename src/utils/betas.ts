import { feature } from 'bun:bundle'
import memoize from 'lodash-es/memoize.js'
import { logForDebugging } from './debug.js'
import {
  checkStatsigFeatureGate_CACHED_MAY_BE_STALE,
  getFeatureValue_CACHED_MAY_BE_STALE,
} from 'src/services/analytics/growthbook.js'
import { getIsNonInteractiveSession, getSdkBetas } from '../bootstrap/state.js'
import {
  BEDROCK_EXTRA_PARAMS_HEADERS,
  CLAUDE_CODE_20250219_BETA_HEADER,
  CLI_INTERNAL_BETA_HEADER,
  CONTEXT_1M_BETA_HEADER,
  CONTEXT_MANAGEMENT_BETA_HEADER,
  INTERLEAVED_THINKING_BETA_HEADER,
  PROMPT_CACHING_SCOPE_BETA_HEADER,
  REDACT_THINKING_BETA_HEADER,
  STRUCTURED_OUTPUTS_BETA_HEADER,
  TOKEN_EFFICIENT_TOOLS_BETA_HEADER,
  SEARCH_EXTRA_TOOLS_BETA_HEADER_1P,
  SEARCH_EXTRA_TOOLS_BETA_HEADER_3P,
  WEB_SEARCH_BETA_HEADER,
} from '../constants/betas.js'
import { OAUTH_BETA_HEADER } from '../constants/oauth.js'
import { isClaudeAISubscriber } from './auth.js'
import { has1mContext } from './context.js'
import { isEnvTruthy } from './envUtils.js'
import { getCanonicalName } from './model/model.js'
import { get3PModelCapabilityOverride } from './model/modelSupportOverrides.js'
import {
  getAPIProvider,
  isFirstPartyAnthropicBaseUrl,
} from './model/providers.js'
import { getInitialSettings } from './settings/settings.js'

/**
 * 允许 API key 用户使用的 SDK 提供 betas。
 * 仅此列表中的 betas 可通过 SDK 选项传递。
 */
const ALLOWED_SDK_BETAS = [CONTEXT_1M_BETA_HEADER]

/**
 * 过滤 betas 仅保留白名单中的项。
 * 分别返回允许与拒绝的 betas。
 */
function partitionBetasByAllowlist(betas: string[]): {
  allowed: string[]
  disallowed: string[]
} {
  const allowed: string[] = []
  const disallowed: string[] = []
  for (const beta of betas) {
    if (ALLOWED_SDK_BETAS.includes(beta)) {
      allowed.push(beta)
    } else {
      disallowed.push(beta)
    }
  }
  return { allowed, disallowed }
}

/**
 * 过滤 SDK betas 仅保留允许的项。
 * 对不允许的 betas 与 subscriber 限制输出警告。
 * 若无有效 beta 残留或用户是 subscriber，则返回 undefined。
 */
export function filterAllowedSdkBetas(
  sdkBetas: string[] | undefined,
): string[] | undefined {
  if (!sdkBetas || sdkBetas.length === 0) {
    return undefined
  }

  if (isClaudeAISubscriber()) {
    console.warn(
      '警告：自定义 betas 仅对 API key 用户可用，已忽略传入的 betas。',
    )
    return undefined
  }

  const { allowed, disallowed } = partitionBetasByAllowlist(sdkBetas)
  for (const beta of disallowed) {
    console.warn(
      `警告：Beta header '${beta}' 不被允许。仅支持以下 betas：${ALLOWED_SDK_BETAS.join(', ')}`,
    )
  }
  return allowed.length > 0 ? allowed : undefined
}

// 一般而言，foundry 支持所有 1P 特性；
// 但出于谨慎，我们不启用任何仍在实验中的特性

export function modelSupportsISP(model: string): boolean {
  const supported3P = get3PModelCapabilityOverride(
    model,
    'interleaved_thinking',
  )
  if (supported3P !== undefined) {
    return supported3P
  }
  const canonical = getCanonicalName(model)
  const provider = getAPIProvider()
  // Foundry 对所有模型支持 interleaved thinking
  if (provider === 'foundry') {
    return true
  }
  if (provider === 'firstParty') {
    return !canonical.includes('claude-3-')
  }
  return (
    canonical.includes('claude-opus-4') || canonical.includes('claude-sonnet-4')
  )
}

function vertexModelSupportsWebSearch(model: string): boolean {
  const canonical = getCanonicalName(model)
  // Vertex 上仅 Claude 4.0+ 模型支持 web search
  return (
    canonical.includes('claude-opus-4') ||
    canonical.includes('claude-sonnet-4') ||
    canonical.includes('claude-haiku-4')
  )
}

// Claude 4+ 模型支持 context management
export function modelSupportsContextManagement(model: string): boolean {
  const canonical = getCanonicalName(model)
  const provider = getAPIProvider()
  if (provider === 'foundry') {
    return true
  }
  if (provider === 'firstParty') {
    return !canonical.includes('claude-3-')
  }
  return (
    canonical.includes('claude-opus-4') ||
    canonical.includes('claude-sonnet-4') ||
    canonical.includes('claude-haiku-4')
  )
}

// @[MODEL LAUNCH]: 若新模型支持 structured outputs，将其 ID 加入此列表。
export function modelSupportsStructuredOutputs(model: string): boolean {
  const canonical = getCanonicalName(model)
  const provider = getAPIProvider()
  // structured outputs 仅在 firstParty 和 Foundry 上支持（Bedrock/Vertex 暂不支持）
  if (provider !== 'firstParty' && provider !== 'foundry') {
    return false
  }
  return (
    canonical.includes('claude-sonnet-4-6') ||
    canonical.includes('claude-sonnet-4-5') ||
    canonical.includes('claude-opus-4-1') ||
    canonical.includes('claude-opus-4-5') ||
    canonical.includes('claude-opus-4-6') ||
    canonical.includes('claude-opus-4-7') ||
    canonical.includes('claude-haiku-4-5')
  )
}

export function modelSupportsAutoMode(_model: string): boolean {
  return feature('TRANSCRIPT_CLASSIFIER') ? true : false
}

/**
 * 根据当前 API provider 返回正确的 tool search beta header。
 * - Vertex AI / Bedrock：tool-search-tool-2025-10-19
 * - 其他所有 provider：advanced-tool-use-2025-11-20
 */
export function getSearchExtraToolsBetaHeader(): string {
  const provider = getAPIProvider()
  if (provider === 'vertex' || provider === 'bedrock') {
    return SEARCH_EXTRA_TOOLS_BETA_HEADER_3P
  }
  return SEARCH_EXTRA_TOOLS_BETA_HEADER_1P
}

/**
 * 检查是否应包含实验性 betas。
 * 这些 betas 仅在 firstParty provider 上可用，代理或其他 provider 可能不支持。
 */
export function shouldIncludeFirstPartyOnlyBetas(): boolean {
  return (
    (getAPIProvider() === 'firstParty' || getAPIProvider() === 'foundry') &&
    !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS) &&
    isFirstPartyAnthropicBaseUrl()
  )
}

/**
 * Global-scope prompt caching 仅限 firstParty。Foundry 被排除是因为
 * GrowthBook 从未将 Foundry 用户纳入灰度实验 —— 实验数据仅来自
 * firstParty。
 */
export function shouldUseGlobalCacheScope(): boolean {
  return (
    getAPIProvider() === 'firstParty' &&
    !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS)
  )
}

export const getAllModelBetas = memoize((model: string): string[] => {
  const betaHeaders = []
  const isHaiku = getCanonicalName(model).includes('haiku')
  const provider = getAPIProvider()
  const includeFirstPartyOnlyBetas = shouldIncludeFirstPartyOnlyBetas()

  if (!isHaiku) {
    betaHeaders.push(CLAUDE_CODE_20250219_BETA_HEADER)
    if (
      process.env.USER_TYPE === 'ant' &&
      process.env.CLAUDE_CODE_ENTRYPOINT === 'cli'
    ) {
      if (CLI_INTERNAL_BETA_HEADER) {
        betaHeaders.push(CLI_INTERNAL_BETA_HEADER)
      }
    }
  }
  if (isClaudeAISubscriber()) {
    betaHeaders.push(OAUTH_BETA_HEADER)
  }
  if (has1mContext(model)) {
    betaHeaders.push(CONTEXT_1M_BETA_HEADER)
  }
  if (
    !isEnvTruthy(process.env.DISABLE_INTERLEAVED_THINKING) &&
    modelSupportsISP(model)
  ) {
    betaHeaders.push(INTERLEAVED_THINKING_BETA_HEADER)
  }

  // 跳过 API 端的 Haiku thinking summarizer —— 其摘要仅用于 ctrl+o 显示，
  // 交互式用户很少打开该界面。API 会返回 redacted_thinking 块作为替代；
  // AssistantRedactedThinkingMessage 已将其渲染为占位。SDK / print 模式
  // 保留摘要，因为调用方可能遍历 thinking 内容。用户可通过 settings.json
  // 的 showThinkingSummaries 重新开启。
  if (
    includeFirstPartyOnlyBetas &&
    modelSupportsISP(model) &&
    !getIsNonInteractiveSession() &&
    getInitialSettings().showThinkingSummaries !== true
  ) {
    betaHeaders.push(REDACT_THINKING_BETA_HEADER)
  }

  // 为 tool 清理或 thinking 保留添加 context management beta。
  // tool 清理对所有用户默认启用（上游以 ant 作为门控）；
  // thinking 保留在模型支持 context management 时激活。
  const toolClearingOptIn =
    isEnvTruthy(process.env.USE_API_CONTEXT_MANAGEMENT) ||
    modelSupportsContextManagement(model)

  const thinkingPreservationEnabled = modelSupportsContextManagement(model)

  if (
    shouldIncludeFirstPartyOnlyBetas() &&
    (toolClearingOptIn || thinkingPreservationEnabled)
  ) {
    betaHeaders.push(CONTEXT_MANAGEMENT_BETA_HEADER)
  }
  // 若实验开启则添加 strict tool use beta。
  // 以 includeFirstPartyOnlyBetas 作门控：CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
  // 已在 api.ts 的关键节点从 tool body 中剥离 schema.strict，但此 header
  // 曾绕过了该 kill switch。伪装成 firstParty 但实际转发到 Vertex 的代理网关
  // 会以 400 拒绝该 header。
  // github.com/deshaw/anthropic-issues/issues/5
  const strictToolsEnabled =
    checkStatsigFeatureGate_CACHED_MAY_BE_STALE('tengu_tool_pear')
  // 3P 默认：false。API 会同时拒绝 strict + token-efficient-tools
  //（tool_use.py:139），二者互斥 —— strict 胜出。
  const tokenEfficientToolsEnabled =
    !strictToolsEnabled &&
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_amber_json_tools', false)
  if (
    includeFirstPartyOnlyBetas &&
    modelSupportsStructuredOutputs(model) &&
    strictToolsEnabled
  ) {
    betaHeaders.push(STRUCTURED_OUTPUTS_BETA_HEADER)
  }
  // JSON tool_use 格式（FC v3）—— 相较 ANTML 约 4.5% 输出 token 缩减。
  // 发送 anthropics/anthropic#337072 中新增的 v2 header（2026-03-28），
  // 以将 CC A/B 实验队列与现有 ~9.2M/周的 v1 调用方隔离。在恢复的
  // JsonToolUseOutputParser 稳定前仅 ant 内部使用。
  if (
    process.env.USER_TYPE === 'ant' &&
    includeFirstPartyOnlyBetas &&
    tokenEfficientToolsEnabled
  ) {
    betaHeaders.push(TOKEN_EFFICIENT_TOOLS_BETA_HEADER)
  }

  // 仅对 Vertex 上 Claude 4.0+ 模型添加 web search beta
  if (provider === 'vertex' && vertexModelSupportsWebSearch(model)) {
    betaHeaders.push(WEB_SEARCH_BETA_HEADER)
  }
  // Foundry 仅发布已支持 Web Search 的模型
  if (provider === 'foundry') {
    betaHeaders.push(WEB_SEARCH_BETA_HEADER)
  }

  // 始终为 1P 发送该 beta header。在没有 scope 字段时该 header 是 no-op。
  if (includeFirstPartyOnlyBetas) {
    betaHeaders.push(PROMPT_CACHING_SCOPE_BETA_HEADER)
  }

  // 若设置了 ANTHROPIC_BETAS，按逗号切分并加入 betaHeaders。
  // 这是显式的用户 opt-in，无视模型情况一律尊重。
  if (process.env.ANTHROPIC_BETAS) {
    betaHeaders.push(
      ...process.env.ANTHROPIC_BETAS.split(',')
        .map(_ => _.trim())
        .filter(Boolean),
    )
  }
  return betaHeaders
})

export const getModelBetas = memoize((model: string): string[] => {
  const modelBetas = getAllModelBetas(model)
  if (getAPIProvider() === 'bedrock') {
    return modelBetas.filter(b => !BEDROCK_EXTRA_PARAMS_HEADERS.has(b))
  }
  return modelBetas
})

export const getBedrockExtraBodyParamsBetas = memoize(
  (model: string): string[] => {
    const modelBetas = getAllModelBetas(model)
    return modelBetas.filter(b => BEDROCK_EXTRA_PARAMS_HEADERS.has(b))
  },
)

/**
 * 将 SDK 提供的 betas 与自动检测的模型 betas 合并。
 * SDK betas 从全局 state 读取（通过 main.tsx 中的 setSdkBetas 写入）。
 * 这些 betas 已经由 filterAllowedSdkBetas 预过滤，后者负责处理
 * subscriber 检查与白名单校验并输出警告。
 *
 * @param options.isAgenticQuery - 为 true 时确保 agentic 查询所需的
 *   beta header 存在。对非 Haiku 模型这些已由 getAllModelBetas() 包含；
 *   对 Haiku 则被排除，因为非 agentic 调用（压缩、分类器、token 估算）不需要。
 */
export function getMergedBetas(
  model: string,
  options?: { isAgenticQuery?: boolean },
): string[] {
  const baseBetas = [...getModelBetas(model)]
  logForDebugging(
    `[Hapii] Betas.getMergedBetas model=${model} isAgenticQuery=${options?.isAgenticQuery ?? false} baseBetas=[${baseBetas.join(', ')}]`,
    { level: 'info' },
  )

  // Agentic 查询始终需要 claude-code 与 cli-internal beta header。
  // 对非 Haiku 模型这些已在 baseBetas 中；对 Haiku 则被 getAllModelBetas()
  // 排除，因为非 agentic Haiku 调用不需要它们。
  if (options?.isAgenticQuery) {
    if (!baseBetas.includes(CLAUDE_CODE_20250219_BETA_HEADER)) {
      baseBetas.push(CLAUDE_CODE_20250219_BETA_HEADER)
    }
    if (
      process.env.USER_TYPE === 'ant' &&
      process.env.CLAUDE_CODE_ENTRYPOINT === 'cli' &&
      CLI_INTERNAL_BETA_HEADER &&
      !baseBetas.includes(CLI_INTERNAL_BETA_HEADER)
    ) {
      baseBetas.push(CLI_INTERNAL_BETA_HEADER)
    }
  }

  const sdkBetas = getSdkBetas()

  if (!sdkBetas || sdkBetas.length === 0) {
    return baseBetas
  }

  // 合并 SDK betas 并去重（已由 filterAllowedSdkBetas 过滤）
  return [...baseBetas, ...sdkBetas.filter(b => !baseBetas.includes(b))]
}

export function clearBetasCaches(): void {
  getAllModelBetas.cache?.clear?.()
  getModelBetas.cache?.clear?.()
  getBedrockExtraBodyParamsBetas.cache?.clear?.()
}
