// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
/**
 * 此处引入的任何模型代号也必须添加到 scripts/excluded-strings.txt
 * 以防止泄露。将所有代号字符串字面量用
 * process.env.USER_TYPE === 'ant' 包裹，供 Bun 在死代码消除时移除。
 */
import { getMainLoopModelOverride } from '../../bootstrap/state.js'
import { resolveAntModel, getAntModelOverrideConfig } from './antModels.js'
import {
  getSubscriptionType,
  isClaudeAISubscriber,
  isMaxSubscriber,
  isProSubscriber,
  isTeamPremiumSubscriber,
} from '../auth.js'
import {
  has1mContext,
  is1mContextDisabled,
  modelSupports1M,
} from '../context.js'
import { isEnvTruthy } from '../envUtils.js'
import { getModelStrings, resolveOverriddenModel } from './modelStrings.js'
import { formatModelPricing, getOpus46CostTier } from '../modelCost.js'
import { getSettings_DEPRECATED } from '../settings/settings.js'
import type { PermissionMode } from '../permissions/PermissionMode.js'
import { getAPIProvider, isFirstPartyAnthropicBaseUrl } from './providers.js'
import { LIGHTNING_BOLT } from '../../constants/figures.js'
import { isModelAllowed } from './modelAllowlist.js'
import { type ModelAlias, isModelAlias } from './aliases.js'
import { capitalize } from '../stringUtils.js'
import {
  CHATGPT_CODEX_DEFAULT_MODEL,
  CHATGPT_CODEX_FAST_MODEL,
  isChatGPTAuthMode,
} from './chatgptModels.js'

export type ModelShortName = string
export type ModelName = string
export type ModelSetting = ModelName | ModelAlias | null

export function getSmallFastModel(): ModelName {
  const provider = getAPIProvider()
  if (provider === 'openai' && isChatGPTAuthMode()) {
    return process.env.OPENAI_SMALL_FAST_MODEL ?? CHATGPT_CODEX_FAST_MODEL
  }
  // Provider 专属小型快速模型
  if (provider === 'openai' && process.env.OPENAI_SMALL_FAST_MODEL) {
    return process.env.OPENAI_SMALL_FAST_MODEL
  }
  if (provider === 'gemini' && process.env.GEMINI_SMALL_FAST_MODEL) {
    return process.env.GEMINI_SMALL_FAST_MODEL
  }
  // Anthropic 专属或回退值
  return process.env.ANTHROPIC_SMALL_FAST_MODEL || getDefaultHaikuModel()
}

export function isNonCustomOpusModel(model: ModelName): boolean {
  return (
    model === getModelStrings().opus40 ||
    model === getModelStrings().opus41 ||
    model === getModelStrings().opus45 ||
    model === getModelStrings().opus46 ||
    model === getModelStrings().opus47
  )
}

/**
 * 从 /model（含 /config）、--model 标志、环境变量或保存的设置中获取模型。
 * 返回值可以是用户指定的模型别名。
 * 若用户未配置任何内容则返回 undefined，此时回退到默认值（null）。
 *
 * 此函数内的优先级顺序：
 * 1. 会话期间的模型覆盖（来自 /model 命令）——最高优先级
 * 2. 启动时的模型覆盖（来自 --model 标志）
 * 3. ANTHROPIC_MODEL 环境变量
 * 4. 设置（来自用户保存的设置）
 */
export function getUserSpecifiedModelSetting(): ModelSetting | undefined {
  let specifiedModel: ModelSetting | undefined

  const modelOverride = getMainLoopModelOverride()
  if (modelOverride !== undefined) {
    specifiedModel = modelOverride
  } else {
    const settings = getSettings_DEPRECATED() || {}
    specifiedModel = process.env.ANTHROPIC_MODEL || settings.model || undefined
  }

  // 若用户指定的模型不在 availableModels 白名单中则忽略。
  if (specifiedModel && !isModelAllowed(specifiedModel)) {
    return undefined
  }

  return specifiedModel
}

/**
 * 获取当前会话的主循环模型。
 *
 * 模型选择优先级顺序：
 * 1. 会话期间的模型覆盖（来自 /model 命令）——最高优先级
 * 2. 启动时的模型覆盖（来自 --model 标志）
 * 3. ANTHROPIC_MODEL 环境变量
 * 4. 设置（来自用户保存的设置）
 * 5. 内置默认值
 *
 * @returns 要使用的解析后模型名称
 */
export function getMainLoopModel(): ModelName {
  const model = getUserSpecifiedModelSetting()
  if (model !== undefined && model !== null) {
    return parseUserSpecifiedModel(model)
  }
  return getDefaultMainLoopModel()
}

export function getBestModel(): ModelName {
  return getDefaultOpusModel()
}

/**
 * 从 provider 的环境变量（如 OPENAI_MODEL）解析其主模型。
 * 对没有主模型环境变量的 provider（Bedrock、Vertex、Foundry、firstParty）返回 undefined。
 */
function getProviderPrimaryModel(): ModelName | undefined {
  const provider = getAPIProvider()
  if (provider === 'openai') return process.env.OPENAI_MODEL
  if (provider === 'gemini') return process.env.GEMINI_MODEL
  if (provider === 'grok') return process.env.GROK_MODEL
  return undefined
}

// @[MODEL LAUNCH]: 更新默认 Opus 模型（3P provider 可能滞后，保持默认不变）。
export function getDefaultOpusModel(): ModelName {
  const provider = getAPIProvider()
  if (provider === 'openai' && isChatGPTAuthMode()) {
    return CHATGPT_CODEX_DEFAULT_MODEL
  }
  // 对 OpenAI provider，优先检查 OPENAI_DEFAULT_OPUS_MODEL
  if (provider === 'openai' && process.env.OPENAI_DEFAULT_OPUS_MODEL) {
    return process.env.OPENAI_DEFAULT_OPUS_MODEL
  }
  // 对 Gemini provider，检查 GEMINI_DEFAULT_OPUS_MODEL
  if (provider === 'gemini' && process.env.GEMINI_DEFAULT_OPUS_MODEL) {
    return process.env.GEMINI_DEFAULT_OPUS_MODEL
  }
  // Anthropic 专属覆盖（用于 first-party 和其他 3P provider）
  if (process.env.ANTHROPIC_DEFAULT_OPUS_MODEL) {
    return process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
  }
  // 3P provider：若用户设置了主模型（如 OPENAI_MODEL=glm-5.1），
  // 回退到该模型而非硬编码的 Anthropic 模型。这防止在用户配置了
  // 第三方 provider 时，sideQuery / 后台任务向 Anthropic API 发送请求。
  const primaryModel = getProviderPrimaryModel()
  if (primaryModel) return primaryModel
  if (provider !== 'firstParty') {
    return getModelStrings().opus47
  }
  return getModelStrings().opus47
}

// @[MODEL LAUNCH]: 更新默认 Sonnet 模型（3P provider 可能滞后，保持默认不变）。
export function getDefaultSonnetModel(): ModelName {
  const provider = getAPIProvider()
  if (provider === 'openai' && isChatGPTAuthMode()) {
    return CHATGPT_CODEX_DEFAULT_MODEL
  }
  // 对 OpenAI provider，优先检查 OPENAI_DEFAULT_SONNET_MODEL
  if (provider === 'openai' && process.env.OPENAI_DEFAULT_SONNET_MODEL) {
    return process.env.OPENAI_DEFAULT_SONNET_MODEL
  }
  // 对 Gemini provider，检查 GEMINI_DEFAULT_SONNET_MODEL
  if (provider === 'gemini' && process.env.GEMINI_DEFAULT_SONNET_MODEL) {
    return process.env.GEMINI_DEFAULT_SONNET_MODEL
  }
  // Anthropic 专属覆盖（用于 first-party 和其他 3P provider）
  if (process.env.ANTHROPIC_DEFAULT_SONNET_MODEL) {
    return process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
  }
  // 3P provider：回退到用户的主模型而非硬编码的 Anthropic 模型名。
  // 防止在用户配置了第三方端点时后台 API 调用路由到 Anthropic。
  const primaryModel = getProviderPrimaryModel()
  if (primaryModel) return primaryModel
  if (provider !== 'firstParty') {
    return getModelStrings().sonnet45
  }
  return getModelStrings().sonnet46
}

// @[MODEL LAUNCH]: 更新默认 Haiku 模型（3P provider 可能滞后，保持默认不变）。
export function getDefaultHaikuModel(): ModelName {
  const provider = getAPIProvider()
  if (provider === 'openai' && isChatGPTAuthMode()) {
    return CHATGPT_CODEX_FAST_MODEL
  }
  // 对 OpenAI provider，优先检查 OPENAI_DEFAULT_HAIKU_MODEL
  if (provider === 'openai' && process.env.OPENAI_DEFAULT_HAIKU_MODEL) {
    return process.env.OPENAI_DEFAULT_HAIKU_MODEL
  }
  // 对 Gemini provider，检查 GEMINI_DEFAULT_HAIKU_MODEL
  if (provider === 'gemini' && process.env.GEMINI_DEFAULT_HAIKU_MODEL) {
    return process.env.GEMINI_DEFAULT_HAIKU_MODEL
  }
  // Anthropic 专属覆盖（用于 first-party 和其他 3P provider）
  if (process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL) {
    return process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  }
  // 3P provider：回退到用户的主模型而非硬编码的 Anthropic 模型名。
  const primaryModel = getProviderPrimaryModel()
  if (primaryModel) return primaryModel

  // Haiku 4.5 在所有平台可用（first-party、Foundry、Bedrock、Vertex）
  return getModelStrings().haiku45
}

/**
 * 根据运行时上下文获取要使用的模型。
 * @param params 运行时上下文的子集，用于确定模型。
 * @returns 要使用的模型
 */
export function getRuntimeMainLoopModel(params: {
  permissionMode: PermissionMode
  mainLoopModel: string
  exceeds200kTokens?: boolean
}): ModelName {
  const { permissionMode, mainLoopModel, exceeds200kTokens = false } = params

  // opusplan 在 plan 模式下使用 Opus，不带 [1m] 后缀。
  if (
    getUserSpecifiedModelSetting() === 'opusplan' &&
    permissionMode === 'plan' &&
    !exceeds200kTokens
  ) {
    return getDefaultOpusModel()
  }

  // 默认 sonnetplan
  if (getUserSpecifiedModelSetting() === 'haiku' && permissionMode === 'plan') {
    return getDefaultSonnetModel()
  }

  return mainLoopModel
}

/**
 * 获取默认的主循环模型设置。
 *
 * 处理内置默认值：
 * - Max 和 Team Premium 用户使用 Opus
 * - 其他所有用户（含 Team Standard、Pro、Enterprise）使用 Sonnet 4.6
 *
 * @returns 要使用的默认模型设置
 */
export function getDefaultMainLoopModelSetting(): ModelName | ModelAlias {
  // Ant 员工默认使用 flag 配置中的 defaultModel，或若未配置则用 Opus 1M
  if (process.env.USER_TYPE === 'ant') {
    return (
      (getAntModelOverrideConfig()?.defaultModel as string) ??
      getDefaultOpusModel() + '[1m]'
    )
  }

  // Max 用户默认使用 Opus
  if (isMaxSubscriber()) {
    return getDefaultOpusModel() + (isOpus1mMergeEnabled() ? '[1m]' : '')
  }

  // Team Premium 与 Max 相同，默认使用 Opus
  if (isTeamPremiumSubscriber()) {
    return getDefaultOpusModel() + (isOpus1mMergeEnabled() ? '[1m]' : '')
  }

  // 按量付费（1P 和 3P）、Enterprise、Team Standard 和 Pro 默认使用 Sonnet
  // 注意 PAYG（3P）可能默认使用较旧的 Sonnet 模型
  return getDefaultSonnetModel()
}

/**
 * 同步获取要使用的默认主循环模型（绕过任何用户指定的值）。
 */
export function getDefaultMainLoopModel(): ModelName {
  return parseUserSpecifiedModel(getDefaultMainLoopModelSetting())
}

// @[MODEL LAUNCH]: 在下方为新模型添加规范名称映射。
/**
 * 纯字符串匹配，从 first-party 模型名中去除日期/provider 后缀。
 * 输入必须已经是 1P 格式 ID（如 'claude-3-7-sonnet-20250219'、
 * 'us.anthropic.claude-opus-4-6-v1:0'）。不访问设置，
 * 在模块顶层安全使用（参见 modelCost.ts 中的 MODEL_COSTS）。
 */
export function firstPartyNameToCanonical(name: ModelName): ModelShortName {
  name = name.toLowerCase()
  // Claude 4+ 模型的特殊情况，用于区分版本
  // 顺序很重要：先检查更具体的版本（4-5 早于 4）
  if (name.includes('claude-opus-4-7')) {
    return 'claude-opus-4-7'
  }
  if (name.includes('claude-opus-4-6')) {
    return 'claude-opus-4-6'
  }
  if (name.includes('claude-opus-4-5')) {
    return 'claude-opus-4-5'
  }
  if (name.includes('claude-opus-4-1')) {
    return 'claude-opus-4-1'
  }
  if (name.includes('claude-opus-4')) {
    return 'claude-opus-4'
  }
  if (name.includes('claude-sonnet-4-6')) {
    return 'claude-sonnet-4-6'
  }
  if (name.includes('claude-sonnet-4-5')) {
    return 'claude-sonnet-4-5'
  }
  if (name.includes('claude-sonnet-4')) {
    return 'claude-sonnet-4'
  }
  if (name.includes('claude-haiku-4-5')) {
    return 'claude-haiku-4-5'
  }
  // Claude 3.x 模型使用不同的命名规则（claude-3-{family}）
  if (name.includes('claude-3-7-sonnet')) {
    return 'claude-3-7-sonnet'
  }
  if (name.includes('claude-3-5-sonnet')) {
    return 'claude-3-5-sonnet'
  }
  if (name.includes('claude-3-5-haiku')) {
    return 'claude-3-5-haiku'
  }
  if (name.includes('claude-3-opus')) {
    return 'claude-3-opus'
  }
  if (name.includes('claude-3-sonnet')) {
    return 'claude-3-sonnet'
  }
  if (name.includes('claude-3-haiku')) {
    return 'claude-3-haiku'
  }
  const match = name.match(/(claude-(\d+-\d+-)?\w+)/)
  if (match && match[1]) {
    return match[1]
  }
  // 若无模式匹配则回退到原始名称
  return name
}

/**
 * 将完整模型字符串映射为跨 1P 和 3P provider 统一的简短规范版本。
 * 例如 'claude-3-5-haiku-20241022' 和 'us.anthropic.claude-3-5-haiku-20241022-v1:0'
 * 都会映射为 'claude-3-5-haiku'。
 * @param fullModelName 完整模型名（如 'claude-3-5-haiku-20241022'）
 * @returns 找到时返回简短名称（如 'claude-3-5-haiku'），否则返回原始名称
 */
export function getCanonicalName(fullModelName: ModelName): ModelShortName {
  // 将被覆盖的模型 ID（如 Bedrock ARN）解析回规范名称。
  // resolved 始终是 1P 格式 ID，firstPartyNameToCanonical 可处理。
  return firstPartyNameToCanonical(resolveOverriddenModel(fullModelName))
}

// @[MODEL LAUNCH]: 更新向用户展示的默认模型描述字符串。
export function getClaudeAiUserDefaultModelDescription(
  fastMode = false,
): string {
  if (isMaxSubscriber() || isTeamPremiumSubscriber()) {
    if (isOpus1mMergeEnabled()) {
      return `Opus 4.7 with 1M context · Most capable for complex work${fastMode ? getOpusPricingSuffix(true) : ''}`
    }
    return `Opus 4.7 · Most capable for complex work${fastMode ? getOpusPricingSuffix(true) : ''}`
  }
  return 'Sonnet 4.6 · Best for everyday tasks'
}

export function renderDefaultModelSetting(
  setting: ModelName | ModelAlias,
): string {
  if (setting === 'opusplan') {
    return 'Opus 4.7 in plan mode, else Sonnet 4.6'
  }
  return renderModelName(parseUserSpecifiedModel(setting))
}

export function getOpusPricingSuffix(fastMode: boolean): string {
  if (getAPIProvider() !== 'firstParty') return ''
  const pricing = formatModelPricing(getOpus46CostTier(fastMode))
  const fastModeIndicator = fastMode ? ` (${LIGHTNING_BOLT})` : ''
  return ` ·${fastModeIndicator} ${pricing}`
}

export function isOpus1mMergeEnabled(): boolean {
  if (
    is1mContextDisabled() ||
    isProSubscriber() ||
    getAPIProvider() !== 'firstParty' ||
    !isFirstPartyAnthropicBaseUrl()
  ) {
    return false
  }
  // 订阅类型未知时失败关闭。VS Code 配置加载子进程可能拥有有效 scope 的
  // OAuth token 但缺少 subscriptionType 字段（过期或部分刷新）。若没有此守卫，
  // isProSubscriber() 对这类用户返回 false，merge 会将 opus[1m] 泄漏进
  // 模型下拉列表——API 随后以误导性的"rate limit reached"错误拒绝。
  if (isClaudeAISubscriber() && getSubscriptionType() === null) {
    return false
  }
  return true
}

export function renderModelSetting(setting: ModelName | ModelAlias): string {
  if (setting === 'opusplan') {
    return 'Opus Plan'
  }
  if (isModelAlias(setting)) {
    return capitalize(setting)
  }
  return renderModelName(setting)
}

// @[MODEL LAUNCH]: 为新模型添加展示名称（基础版 + [1m] 变体，如适用）。
/**
 * 返回已知公开模型的可读展示名称，若模型不是已知公开模型则返回 null。
 */
export function getPublicModelDisplayName(model: ModelName): string | null {
  switch (model) {
    case getModelStrings().opus47:
      return 'Opus 4.7'
    case getModelStrings().opus47 + '[1m]':
      return 'Opus 4.7 (1M context)'
    case getModelStrings().opus46:
      return 'Opus 4.6'
    case getModelStrings().opus46 + '[1m]':
      return 'Opus 4.6 (1M context)'
    case getModelStrings().opus45:
      return 'Opus 4.5'
    case getModelStrings().opus41:
      return 'Opus 4.1'
    case getModelStrings().opus40:
      return 'Opus 4'
    case getModelStrings().sonnet46 + '[1m]':
      return 'Sonnet 4.6 (1M context)'
    case getModelStrings().sonnet46:
      return 'Sonnet 4.6'
    case getModelStrings().sonnet45 + '[1m]':
      return 'Sonnet 4.5 (1M context)'
    case getModelStrings().sonnet45:
      return 'Sonnet 4.5'
    case getModelStrings().sonnet40:
      return 'Sonnet 4'
    case getModelStrings().sonnet40 + '[1m]':
      return 'Sonnet 4 (1M context)'
    case getModelStrings().sonnet37:
      return 'Sonnet 3.7'
    case getModelStrings().sonnet35:
      return 'Sonnet 3.5'
    case getModelStrings().haiku45:
      return 'Haiku 4.5'
    case getModelStrings().haiku35:
      return 'Haiku 3.5'
    default:
      return null
  }
}

function maskModelCodename(baseName: string): string {
  // 仅对第一个以连字符分隔的段（代号）打码，保留其余部分
  // 例如 capybara-v2-fast → cap*****-v2-fast
  const [codename = '', ...rest] = baseName.split('-')
  const masked =
    codename.slice(0, 3) + '*'.repeat(Math.max(0, codename.length - 3))
  return [masked, ...rest].join('-')
}

export function renderModelName(model: ModelName): string {
  const publicName = getPublicModelDisplayName(model)
  if (publicName) {
    return publicName
  }
  if (process.env.USER_TYPE === 'ant') {
    const resolved = parseUserSpecifiedModel(model)
    const antModel = resolveAntModel(model)
    if (antModel) {
      const baseName = antModel.model.replace(/\[1m\]$/i, '')
      const masked = maskModelCodename(baseName)
      const suffix = has1mContext(resolved) ? '[1m]' : ''
      return masked + suffix
    }
    if (resolved !== model) {
      return `${model} (${resolved})`
    }
    return resolved
  }
  return model
}

/**
 * 返回适合公开展示的安全作者名（如 git commit trailer）。
 * 已知公开模型返回 "Claude {ModelName}"，未知/内部模型返回
 * "Claude ({model})" 以保留确切模型名称。
 *
 * @param model 完整模型名称
 * @returns 公开模型返回 "Claude {ModelName}"，非公开模型返回 "Claude ({model})"
 */
export function getPublicModelName(model: ModelName): string {
  const publicName = getPublicModelDisplayName(model)
  if (publicName) {
    return `Claude ${publicName}`
  }
  return `Claude (${model})`
}

/**
 * 返回本会话中使用的完整模型名称，可能在解析模型别名之后。
 *
 * 此函数故意不支持版本号，以与模型切换器对齐。
 *
 * 支持在任何模型别名上附加 [1m] 后缀（如 haiku[1m]、sonnet[1m]），
 * 启用 1M 上下文窗口，无需将每个变体加入 MODEL_ALIASES。
 *
 * @param modelInput 用户提供的模型别名或名称。
 */
export function parseUserSpecifiedModel(
  modelInput: ModelName | ModelAlias,
): ModelName {
  const modelInputTrimmed = modelInput.trim()
  const normalizedModel = modelInputTrimmed.toLowerCase()

  const has1mTag = has1mContext(normalizedModel)
  const modelString = has1mTag
    ? normalizedModel.replace(/\[1m]$/i, '').trim()
    : normalizedModel

  if (isModelAlias(modelString)) {
    switch (modelString) {
      case 'opusplan':
        return getDefaultSonnetModel() + (has1mTag ? '[1m]' : '') // 默认 Sonnet，plan 模式下用 Opus
      case 'sonnet':
        return getDefaultSonnetModel() + (has1mTag ? '[1m]' : '')
      case 'haiku':
        return getDefaultHaikuModel() + (has1mTag ? '[1m]' : '')
      case 'opus':
        return getDefaultOpusModel() + (has1mTag ? '[1m]' : '')
      case 'best':
        return getBestModel()
      default:
    }
  }

  // Opus 4/4.1 在 first-party API 上不再可用（与 Claude.ai 相同）——
  // 静默重映射到当前 Opus 默认值。'opus' 别名解析为当前默认 Opus（4.7），
  // 因此使用这些显式字符串的用户是在 4.5 发布前通过 settings/env/--model/SDK 固定的。
  // 3P provider 可能尚无 4.6/4.7 容量，故直接穿透不变。
  if (
    getAPIProvider() === 'firstParty' &&
    isLegacyOpusFirstParty(modelString) &&
    isLegacyModelRemapEnabled()
  ) {
    return getDefaultOpusModel() + (has1mTag ? '[1m]' : '')
  }

  if (process.env.USER_TYPE === 'ant') {
    const has1mAntTag = has1mContext(normalizedModel)
    const baseAntModel = normalizedModel.replace(/\[1m]$/i, '').trim()

    const antModel = resolveAntModel(baseAntModel)
    if (antModel) {
      const suffix = has1mAntTag ? '[1m]' : ''
      return antModel.model + suffix
    }

    // 若无法加载配置则穿透到别名字符串。API 调用会以此字符串失败，
    // 但我们会通过反馈听到，并告诉用户重启/等待 flag 缓存刷新以获取最新值。
  }

  // 保留自定义模型名称的原始大小写（如 Azure Foundry deployment ID）
  // 仅在存在时去除 [1m] 后缀，保持基础模型的大小写
  if (has1mTag) {
    return modelInputTrimmed.replace(/\[1m\]$/i, '').trim() + '[1m]'
  }
  return modelInputTrimmed
}

/**
 * 将 skill 的 `model:` frontmatter 根据当前模型解析，
 * 在目标系列支持时携带 `[1m]` 后缀。
 *
 * skill 作者写 `model: opus` 意为"使用 opus 级推理"——而非"降级到 200K"。
 * 若用户在 230K token 时使用 opus[1m]，并调用含 `model: opus` 的 skill，
 * 裸别名穿透会将有效上下文窗口从 1M 降至 200K，导致 autocompact
 * 在表观用量 23% 时触发，并显示"Context limit reached"，即使实际未溢出。
 *
 * 仅在目标实际支持时（sonnet/opus）携带 [1m]。在 1M 会话中 `model: haiku`
 * 的 skill 仍会降级——haiku 没有 1M 变体，后续的 autocompact 是正确的。
 * 已指定 [1m] 的 skill 保持不变。
 */
export function resolveSkillModelOverride(
  skillModel: string,
  currentModel: string,
): string {
  if (has1mContext(skillModel) || !has1mContext(currentModel)) {
    return skillModel
  }
  // modelSupports1M 匹配规范 ID（'claude-opus-4-6'、'claude-sonnet-4'）；
  // 裸 'opus' 别名在 getCanonicalName 中无法匹配，需先解析。
  if (modelSupports1M(parseUserSpecifiedModel(skillModel))) {
    return skillModel + '[1m]'
  }
  return skillModel
}

const LEGACY_OPUS_FIRSTPARTY = [
  'claude-opus-4-20250514',
  'claude-opus-4-1-20250805',
  'claude-opus-4-0',
  'claude-opus-4-1',
]

function isLegacyOpusFirstParty(model: string): boolean {
  return LEGACY_OPUS_FIRSTPARTY.includes(model)
}

/**
 * 旧版 Opus 4.0/4.1 → 当前 Opus 重映射的退出选项。
 */
export function isLegacyModelRemapEnabled(): boolean {
  return !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP)
}

export function modelDisplayString(model: ModelSetting): string {
  if (model === null) {
    if (process.env.USER_TYPE === 'ant') {
      return `Default for Ants (${renderDefaultModelSetting(getDefaultMainLoopModelSetting())})`
    } else if (isClaudeAISubscriber()) {
      return `Default (${getClaudeAiUserDefaultModelDescription()})`
    }
    return `Default (${getDefaultMainLoopModel()})`
  }
  const resolvedModel = parseUserSpecifiedModel(model)
  return model === resolvedModel ? resolvedModel : `${model} (${resolvedModel})`
}

// @[MODEL LAUNCH]: 在下方为新模型添加营销名称映射。
export function getMarketingNameForModel(modelId: string): string | undefined {
  if (getAPIProvider() === 'foundry') {
    // Foundry 中 deployment ID 由用户定义，可能与实际模型无关
    return undefined
  }

  const has1m = modelId.toLowerCase().includes('[1m]')
  const canonical = getCanonicalName(modelId)

  if (canonical.includes('claude-opus-4-7')) {
    return has1m ? 'Opus 4.7 (with 1M context)' : 'Opus 4.7'
  }
  if (canonical.includes('claude-opus-4-6')) {
    return has1m ? 'Opus 4.6 (with 1M context)' : 'Opus 4.6'
  }
  if (canonical.includes('claude-opus-4-5')) {
    return 'Opus 4.5'
  }
  if (canonical.includes('claude-opus-4-1')) {
    return 'Opus 4.1'
  }
  if (canonical.includes('claude-opus-4')) {
    return 'Opus 4'
  }
  if (canonical.includes('claude-sonnet-4-6')) {
    return has1m ? 'Sonnet 4.6 (with 1M context)' : 'Sonnet 4.6'
  }
  if (canonical.includes('claude-sonnet-4-5')) {
    return has1m ? 'Sonnet 4.5 (with 1M context)' : 'Sonnet 4.5'
  }
  if (canonical.includes('claude-sonnet-4')) {
    return has1m ? 'Sonnet 4 (with 1M context)' : 'Sonnet 4'
  }
  if (canonical.includes('claude-3-7-sonnet')) {
    return 'Claude 3.7 Sonnet'
  }
  if (canonical.includes('claude-3-5-sonnet')) {
    return 'Claude 3.5 Sonnet'
  }
  if (canonical.includes('claude-haiku-4-5')) {
    return 'Haiku 4.5'
  }
  if (canonical.includes('claude-3-5-haiku')) {
    return 'Claude 3.5 Haiku'
  }

  return undefined
}

export function normalizeModelStringForAPI(model: string): string {
  return model.replace(/\[(1|2)m\]/gi, '')
}
