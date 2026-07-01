// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
/**
 * 文档和源码注释都透露了原因：
  1. 性能更好（文档明说）
    对于许多工作负载，尤其是双峰任务和长周期智能体工作流，自适应思考可以比使用固定 budget_tokens  的扩展思考带来更好的性能。
  2. 不需要精确预算（降低心智负担）
    手动模式需要你自己算 budget_tokens：太小不够思考，太大浪费 token。adaptive 让模型自己决定。     
  3. 自动启用交错思考（agent 友好）
    自适应思考还会自动启用交错思考。这意味着 Claude 可以在工具调用之间进行思考，使其在智能体工作流中尤为有效。
  4. 与 effort 参数配合（软性引导）
    adaptive + effort: low/medium/high/max/xhigh 比硬编码 budget_tokens 更灵活。
 * 
 */
import type { Theme } from './theme.js'
import { feature } from 'bun:bundle'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { getCanonicalName } from './model/model.js'
import { get3PModelCapabilityOverride } from './model/modelSupportOverrides.js'
import { getAPIProvider } from './model/providers.js'
import { getSettingsWithErrors } from './settings/settings.js'
import { resolveAntModel } from './model/antModels.js'

/**
  ┌───────────────────────────┬──────────────────────────────────┐
  │           type            │               含义               │
  ├───────────────────────────┼──────────────────────────────────┤
  │ "enabled" + budget_tokens │ 手动开启，指定最大思考 token     │
  ├───────────────────────────┼──────────────────────────────────┤
  │ "adaptive"                │ 模型自行决定要不要思考、思考多少 │
  ├───────────────────────────┼──────────────────────────────────┤
  │ "disabled"                │ 关闭思考                         │
  └───────────────────────────┴──────────────────────────────────┘
  关键结论：
    - 新模型（4.7+）：手动模式被硬拒绝，必须用 adaptive
    - 过渡模型（4.6）：手动模式已弃用但还能用，官方推荐迁移
    - 老模型（4.5 及以下）：手动模式是唯一选择，还没被淘汰
  ┌───────────────────┬────────────────────────┬─────────────────────────┬──────────────────┐
  │       模型        │    手动 (enabled +     │    自适应 (adaptive)    │ 禁用 (disabled)  │
  │                   │     budget_tokens)     │                         │                  │
  ├───────────────────┼────────────────────────┼─────────────────────────┼──────────────────┤
  │ Claude Fable 5 /  │ ❌ 400 错误            │ ✅                      │ ❌ 不支持        │
  │ Mythos 5          │                        │ 始终强制开启，无法禁用    │                  │     
  ├───────────────────┼────────────────────────┼─────────────────────────┼──────────────────┤
  │ Claude Mythos     │ ✅ 可用                │ ✅ 默认模式             │ ❌ 不支持        │     
  │ Preview           │                        │                         │                  │
  ├───────────────────┼────────────────────────┼─────────────────────────┼──────────────────┤
  │ Claude Opus 4.8   │ ❌ 400 错误            │ ✅ 唯一支持             │ ✅ 但需显式设    │     
  │                   │                        │                         │ adaptive         │     
  ├───────────────────┼────────────────────────┼─────────────────────────┼──────────────────┤     
  │ Claude Opus 4.7   │ ❌ 400 错误            │ ✅ 唯一支持             │ ✅ 但需显式设    │     
  │                   │                        │                         │ adaptive         │     
  ├───────────────────┼────────────────────────┼─────────────────────────┼──────────────────┤     
  │ Claude Opus 4.6   │ ⚠️ 已弃用，仍可用      │ ✅ 推荐                 │ ✅               │     
  ├───────────────────┼────────────────────────┼─────────────────────────┼──────────────────┤     
  │ Claude Sonnet 4.6 │ ⚠️ 已弃用，仍可用      │ ✅ 推荐                 │ ✅               │     
  ├───────────────────┼────────────────────────┼─────────────────────────┼──────────────────┤     
  │ Opus 4.5 / Haiku  │ ✅ 唯一选择            │ ❌ 不支持               │ ✅               │     
  │ 4.5 / 更早        │                        │                         │                  │     
  └───────────────────┴────────────────────────┴─────────────────────────┴──────────────────┘
 */

export type ThinkingConfig =
  | { type: 'adaptive' }
  | { type: 'enabled'; budgetTokens: number }
  | { type: 'disabled' }

/**
 * 构建时开关（feature flag）+ 运行时开关（GrowthBook）。
 * 构建标志控制代码是否包含在外部构建中；GB 标志控制功能灰度发布。
 */
export function isUltrathinkEnabled(): boolean {
  if (!feature('ULTRATHINK')) {
    return false
  }
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_turtle_carbon', true)
}

/**
 * 检查文本中是否包含 "ultrathink" 关键词。
 */
export function hasUltrathinkKeyword(text: string): boolean {
  return /\bultrathink\b/i.test(text)
}

/**
 * 查找文本中 "ultrathink" 关键词的位置（用于 UI 高亮/通知）
 */
export function findThinkingTriggerPositions(text: string): Array<{
  word: string
  start: number
  end: number
}> {
  const positions: Array<{ word: string; start: number; end: number }> = []
  // 每次调用都创建新的 /g 字面量 —— String.prototype.matchAll 会从源正则表达式
  // 复制 lastIndex，所以共享实例会将 hasUltrathinkKeyword 的 .test() 状态
  // 泄漏到下次渲染时的本次调用中。
  const matches = text.matchAll(/\bultrathink\b/gi)

  for (const match of matches) {
    if (match.index !== undefined) {
      positions.push({
        word: match[0],
        start: match.index,
        end: match.index + match[0].length,
      })
    }
  }

  return positions
}

const RAINBOW_COLORS: Array<keyof Theme> = [
  'rainbow_red',
  'rainbow_orange',
  'rainbow_yellow',
  'rainbow_green',
  'rainbow_blue',
  'rainbow_indigo',
  'rainbow_violet',
]

const RAINBOW_SHIMMER_COLORS: Array<keyof Theme> = [
  'rainbow_red_shimmer',
  'rainbow_orange_shimmer',
  'rainbow_yellow_shimmer',
  'rainbow_green_shimmer',
  'rainbow_blue_shimmer',
  'rainbow_indigo_shimmer',
  'rainbow_violet_shimmer',
]

export function getRainbowColor(
  charIndex: number,
  shimmer: boolean = false,
): keyof Theme {
  const colors = shimmer ? RAINBOW_SHIMMER_COLORS : RAINBOW_COLORS
  return colors[charIndex % colors.length]!
}

// TODO(inigo): 添加通过 API 错误检测来探测未知模型的支持能力 感知 Provider 的 thinking 支持检测（与 betas.ts 中的 modelSupportsISP 对齐）
export function modelSupportsThinking(model: string): boolean {
  const supported3P = get3PModelCapabilityOverride(model, 'thinking')
  if (supported3P !== undefined) {
    return supported3P
  }
  if (process.env.USER_TYPE === 'ant') {
    if (resolveAntModel(model.toLowerCase())) {
      return true
    }
  }
  // 重要：不要在没有通知模型发布 DRI 和研究团队的情况下更改 thinking 支持。这会极大地影响模型质量和评测表现。
  const canonical = getCanonicalName(model)
  const provider = getAPIProvider()
  // 第一方和 Foundry：所有 Claude 4+ 模型（包括 Haiku 4.5）
  if (provider === 'foundry' || provider === 'firstParty') {
    return !canonical.includes('claude-3-') // 排除 Claude 3 系列
  }
  // 第三方（Bedrock/Vertex）：仅 Opus 4+ 和 Sonnet 4+
  return canonical.includes('sonnet-4') || canonical.includes('opus-4')
}

// @[模型发布]: 如果新模型支持自适应 thinking，将其加入白名单。
export function modelSupportsAdaptiveThinking(model: string): boolean {
  const supported3P = get3PModelCapabilityOverride(model, 'adaptive_thinking')
  if (supported3P !== undefined) {
    return supported3P
  }
  const canonical = getCanonicalName(model)
  // 部分 Claude 4 模型支持此功能
  if (
    canonical.includes('opus-4-7') ||
    canonical.includes('opus-4-6') ||
    canonical.includes('sonnet-4-6')
  ) {
    return true
  }
  // 排除其他已知的旧模型（上面的白名单会先匹配 4-6+ 版本）
  if (
    canonical.includes('opus') ||
    canonical.includes('sonnet') ||
    canonical.includes('haiku')
  ) {
    return false
  }
  // 重要：不要在没有通知模型发布 DRI 和研究团队的情况下更改自适应 thinking 支持。这会极大地影响模型质量和评测表现。
  // 更新的模型（4.6+）都使用自适应 thinking 进行训练，必须启用此功能才能进行模型测试。不要对第一方模型默认设为 false，否则可能会悄然降低模型质量。

  // 对于 1P 和 Foundry 上的未知模型字符串默认为 true（因为 Foundry 是代理）。不要对其他第三方默认为 true，因为它们的模型字符串格式不同。
  const provider = getAPIProvider()
  return provider === 'firstParty' || provider === 'foundry'
}

export function shouldEnableThinkingByDefault(): boolean {
  if (process.env.MAX_THINKING_TOKENS) {
    return parseInt(process.env.MAX_THINKING_TOKENS, 10) > 0
  }

  const { settings } = getSettingsWithErrors()
  if (settings.alwaysThinkingEnabled === false) {
    return false
  }

  // 重要：不要在没有通知模型发布 DRI 和研究团队的情况下更改默认 thinking 启用值。这会极大地影响模型质量和评测表现。
  // 默认启用 thinking，除非显式禁用。
  return true
}
