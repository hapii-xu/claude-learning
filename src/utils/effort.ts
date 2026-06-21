// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { isUltrathinkEnabled } from './thinking.js'
import { getInitialSettings } from './settings/settings.js'
import { isProSubscriber, isMaxSubscriber, isTeamSubscriber } from './auth.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import { getAPIProvider } from './model/providers.js'
import { get3PModelCapabilityOverride } from './model/modelSupportOverrides.js'
import { isEnvTruthy } from './envUtils.js'
import type { EffortLevel } from 'src/entrypoints/sdk/runtimeTypes.js'
import { resolveAntModel } from './model/antModels.js'
import { getAntModelOverrideConfig } from './model/antModels.js'
import {
  isChatGPTAuthMode,
  isChatGPTCodexReasoningModel,
} from './model/chatgptModels.js'

export type { EffortLevel }

// 注意：'ultracode' 不是 effort 级别。它是会话作用域的多 agent
// 编排选项，由 harness（claude.ai/client）作为 system-reminder
// 注入，与 effort 参数正交。EffortLevel / EffortValue
// 绝不能包含 'ultracode'；/effort 仅接受下方列出的级别。
export const EFFORT_LEVELS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly EffortLevel[]

export type EffortValue = EffortLevel | number

// @[MODEL LAUNCH]: 若新模型支持 effort 参数，将其加入白名单。
export function modelSupportsEffort(model: string): boolean {
  const m = model.toLowerCase()
  if (isEnvTruthy(process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT)) {
    return true
  }
  const supported3P = get3PModelCapabilityOverride(model, 'effort')
  if (supported3P !== undefined) {
    return supported3P
  }
  if (
    getAPIProvider() === 'openai' &&
    isChatGPTAuthMode() &&
    isChatGPTCodexReasoningModel(model)
  ) {
    return true
  }
  // 由 Claude 4 模型的子集支持
  if (
    m.includes('opus-4-7') ||
    m.includes('opus-4-6') ||
    m.includes('sonnet-4-6') ||
    m.includes('deepseek-v4-pro')
  ) {
    return true
  }
  // 排除其他已知的旧模型（haiku、旧版 opus/sonnet 变体）
  if (m.includes('haiku') || m.includes('sonnet') || m.includes('opus')) {
    return false
  }

  // 重要：更改默认 effort 支持前请通知
  // 模型发布 DRI 和研发团队。这是一个敏感的
  // 设置，会极大影响模型质量和评价。

  // 对 1P 上的未知模型字符串默认为 true。
  // 对 3P 不默认为 true，因为他们的模型字符串格式不同
  //（如 anthropics/claude-code#30795）
  return getAPIProvider() === 'firstParty'
}

// Effort max/xhigh 限制已移除 —— 所有支持 effort 的模型
// 现在都可以使用这些级别。API 错误由用户负责。
export function modelSupportsMaxEffort(_model: string): boolean {
  const supported3P = get3PModelCapabilityOverride(_model, 'max_effort')
  if (supported3P !== undefined) {
    return supported3P
  }
  return true
}

export function modelSupportsXhighEffort(_model: string): boolean {
  const supported3P = get3PModelCapabilityOverride(_model, 'xhigh_effort')
  if (supported3P !== undefined) {
    return supported3P
  }
  return true
}

export function isEffortLevel(value: string): value is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(value)
}

export function parseEffortValue(value: unknown): EffortValue | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  if (typeof value === 'number' && isValidNumericEffort(value)) {
    return value
  }
  const str = String(value).toLowerCase()
  if (isEffortLevel(str)) {
    return str
  }
  const numericValue = parseInt(str, 10)
  if (!isNaN(numericValue) && isValidNumericEffort(numericValue)) {
    return numericValue
  }
  return undefined
}

/**
 * 数值仅表示模型默认，不被持久化。
 * 'max' 对外部用户是会话作用域（ant 可持久化）。
 * 写入点在保存到 settings 前调用此函数，
 * 以便 Zod schema（仅接受字符串级别）不会拒绝写入。
 */
export function toPersistableEffort(
  value: EffortValue | undefined,
): EffortLevel | undefined {
  if (
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh'
  ) {
    return value
  }
  if (value === 'max' && process.env.USER_TYPE === 'ant') {
    return value
  }
  return undefined
}

export function getInitialEffortSetting(): EffortLevel | undefined {
  // toPersistableEffort 在读取时为非 ant 用户过滤 'max'，
  // 因此手动编辑的 settings.json 不会将会话作用域的 max
  // 泄漏到新会话中。
  return toPersistableEffort(getInitialSettings().effortLevel)
}

/**
 * 决定用户在 ModelPicker 中选择模型时要持久化哪个 effort 级别
 *（若有）。即使与所选模型的默认值匹配，也保留先前显式的
 * /effort 选择粘性，而纯默认和会话临时 effort
 *（CLI --effort、EffortCallout 默认）降级为 undefined，
 * 以便跟随未来的模型默认变更。
 *
 * priorPersisted 必须来自磁盘上的 userSettings
 *（getSettingsForSource('userSettings')?.effortLevel），而非合并后的 settings
 *（project/policy 层会泄漏到用户的全局 settings.json）
 * 也非 AppState.effortValue（包含故意不写入 settings.json 的会话作用域来源）。
 */
export function resolvePickerEffortPersistence(
  picked: EffortLevel | undefined,
  modelDefault: EffortLevel,
  priorPersisted: EffortLevel | undefined,
  toggledInPicker: boolean,
): EffortLevel | undefined {
  const hadExplicit = priorPersisted !== undefined || toggledInPicker
  return hadExplicit || picked !== modelDefault ? picked : undefined
}

export function getEffortEnvOverride(): EffortValue | null | undefined {
  const envOverride = process.env.CLAUDE_CODE_EFFORT_LEVEL
  return envOverride?.toLowerCase() === 'unset' ||
    envOverride?.toLowerCase() === 'auto'
    ? null
    : parseEffortValue(envOverride)
}

/**
 * 解析将实际发送给 API 的 effort 值，遵循给定模型的
 * 完整优先级链：
 *   环境变量 CLAUDE_CODE_EFFORT_LEVEL → appState.effortValue → 模型默认
 *
 * 当不应发送 effort 参数时返回 undefined
 *（env 设置为 'unset'，或模型无默认值）。
 */
export function resolveAppliedEffort(
  model: string,
  appStateEffortValue: EffortValue | undefined,
): EffortValue | undefined {
  const envOverride = getEffortEnvOverride()
  if (envOverride === null) {
    return undefined
  }
  const resolved =
    envOverride ?? appStateEffortValue ?? getDefaultEffortForModel(model)
  // OpenAI Responses 使用 xhigh 作为其最高的公开推理 effort。
  // 在 ChatGPT 订阅模式下保留 /effort max 作为熟悉的别名。
  if (
    resolved === 'max' &&
    getAPIProvider() === 'openai' &&
    isChatGPTAuthMode() &&
    modelSupportsXhighEffort(model)
  ) {
    return 'xhigh'
  }
  return resolved
}

/**
 * 解析要展示给用户的 effort 级别。包装 resolveAppliedEffort
 * 并使用 'high' 回退（API 在未发送 effort 参数时使用的值）。
 * 状态栏和 /effort 输出的单一真相来源（CC-1088）。
 */
export function getDisplayedEffortLevel(
  model: string,
  appStateEffort: EffortValue | undefined,
): EffortLevel {
  const resolved = resolveAppliedEffort(model, appStateEffort) ?? 'high'
  return convertEffortValueToLevel(resolved)
}

/**
 * 构建 Logo/Spinner 中显示的 ` with {level} effort` 后缀。
 * 若用户未显式设置 effort 值则返回空字符串。
 * 委托给 resolveAppliedEffort() 以便显示级别与
 * API 实际接收的内容匹配（包括非 Opus 模型的 max→high 限制）。
 */
export function getEffortSuffix(
  model: string,
  effortValue: EffortValue | undefined,
): string {
  if (effortValue === undefined) return ''
  const resolved = resolveAppliedEffort(model, effortValue)
  if (resolved === undefined) return ''
  return ` with ${convertEffortValueToLevel(resolved)} effort`
}

export function isValidNumericEffort(value: number): boolean {
  return Number.isInteger(value)
}

export function convertEffortValueToLevel(value: EffortValue): EffortLevel {
  if (typeof value === 'string') {
    // 运行时守卫：value 可能来自远程配置（GrowthBook），
    // TypeScript 类型无法帮助我们。将未知字符串强制为 'high'
    // 而非不检查直接传递。
    return isEffortLevel(value) ? value : 'high'
  }
  if (process.env.USER_TYPE === 'ant' && typeof value === 'number') {
    if (value <= 50) return 'low'
    if (value <= 85) return 'medium'
    if (value <= 100) return 'high'
    return 'max'
  }
  return 'high'
}

/**
 * 获取 effort 级别的用户可见描述
 *
 * @param level 要描述的 effort 级别
 * @returns 人类可读的描述
 */
export function getEffortLevelDescription(level: EffortLevel): string {
  switch (level) {
    case 'low':
      return 'Quick, straightforward implementation with minimal overhead'
    case 'medium':
      return 'Balanced approach with standard implementation and testing'
    case 'high':
      return 'Comprehensive implementation with extensive testing and documentation'
    case 'xhigh':
      return 'Extended reasoning beyond high, short of max'
    case 'max':
      return 'Maximum capability with deepest reasoning'
  }
}

/**
 * 获取 effort 值的用户可见描述（字符串和数值）
 *
 * @param value 要描述的 effort 值
 * @returns 人类可读的描述
 */
export function getEffortValueDescription(value: EffortValue): string {
  if (process.env.USER_TYPE === 'ant' && typeof value === 'number') {
    return `[ANT-ONLY] Numeric effort value of ${value}`
  }

  if (typeof value === 'string') {
    return getEffortLevelDescription(value)
  }
  return 'Balanced approach with standard implementation and testing'
}

export type OpusDefaultEffortConfig = {
  enabled: boolean
  dialogTitle: string
  dialogDescription: string
}

const OPUS_DEFAULT_EFFORT_CONFIG_DEFAULT: OpusDefaultEffortConfig = {
  enabled: true,
  dialogTitle: 'We recommend medium effort for Opus',
  dialogDescription:
    'Effort determines how long Claude thinks for when completing your task. We recommend medium effort for most tasks to balance speed and intelligence and maximize rate limits. Use ultrathink to trigger high effort when needed.',
}

export function getOpusDefaultEffortConfig(): OpusDefaultEffortConfig {
  const config = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_grey_step2',
    OPUS_DEFAULT_EFFORT_CONFIG_DEFAULT,
  )
  return {
    ...OPUS_DEFAULT_EFFORT_CONFIG_DEFAULT,
    ...config,
  }
}

// @[MODEL LAUNCH]: 更新新模型的默认 effort 级别
export function getDefaultEffortForModel(
  model: string,
): EffortValue | undefined {
  if (process.env.USER_TYPE === 'ant') {
    const config = getAntModelOverrideConfig()
    const isDefaultModel =
      config?.defaultModel !== undefined &&
      model.toLowerCase() === (config.defaultModel as string).toLowerCase()
    if (isDefaultModel && config?.defaultModelEffortLevel) {
      return config.defaultModelEffortLevel as EffortValue
    }
    const antModel = resolveAntModel(model)
    if (antModel) {
      if (antModel.defaultEffortLevel) {
        return antModel.defaultEffortLevel
      }
      if (antModel.defaultEffortValue !== undefined) {
        return antModel.defaultEffortValue
      }
    }
    // 始终默认为 ant 用户返回 undefined/high
    return undefined
  }

  // 重要：更改默认 effort 级别前请通知
  // 模型发布 DRI 和研发团队。默认 effort 是敏感设置，
  // 会极大影响模型质量和评价。

  if (
    getAPIProvider() === 'openai' &&
    isChatGPTAuthMode() &&
    isChatGPTCodexReasoningModel(model)
  ) {
    return 'medium'
  }

  // Pro 用户的 Opus 4.6 默认 effort 为 medium。
  // 启用 tengu_grey_step2 配置时，Max/Team 也获得 medium。
  if (
    model.toLowerCase().includes('opus-4-7') ||
    model.toLowerCase().includes('opus-4-6')
  ) {
    if (isProSubscriber()) {
      return 'high'
    }
    if (
      getOpusDefaultEffortConfig().enabled &&
      (isMaxSubscriber() || isTeamSubscriber())
    ) {
      return 'high'
    }
  }

  // 启用 ultrathink 功能时，默认 effort 为 medium（ultrathink 提升到 high）
  if (isUltrathinkEnabled() && modelSupportsEffort(model)) {
    return 'medium'
  }

  // 回退到 undefined，表示我们不设置 effort 级别。这
  // 在 API 中会解析为 high effort 级别。
  return undefined
}
