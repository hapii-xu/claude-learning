import { feature } from 'bun:bundle'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import {
  getClaudeAIOAuthTokens,
  isAnthropicAuthEnabled,
} from '../utils/auth.js'

/**
 * 语音模式的熔断开关检查。除非 `tengu_amber_quartz_disabled`
 * GrowthBook 标志被翻转（紧急关闭），否则返回 true。默认 `false`
 * 意味着缺失/陈旧的磁盘缓存被读作"未被熔断"——因此全新安装无需
 * 等待 GrowthBook 初始化即可立即使用语音。用于决定语音模式是否
 * 应*可见*（例如命令注册、配置 UI）。
 */
export function isVoiceGrowthBookEnabled(): boolean {
  // 肯定式三元模式 —— 见 docs/feature-gating.md。
  // 否定模式 (if (!feature(...)) return) 不会从外部构建中
  // 消除内联字符串字面量。
  return feature('VOICE_MODE')
    ? !getFeatureValue_CACHED_MAY_BE_STALE('tengu_amber_quartz_disabled', false)
    : false
}

/**
 * 仅认证检查的语音模式。当用户拥有有效的 Anthropic OAuth
 * 令牌时返回 true。由已 memoize 的 getClaudeAIOAuthTokens 支持——
 * 首次调用在 macOS 上会生成 `security` 进程（约 20-50ms），后续调用
 * 命中缓存。memoize 在令牌刷新时清除（约每小时一次），因此每次
 * 刷新预期一次冷启动。对于使用时检查足够廉价。
 */
export function hasVoiceAuth(): boolean {
  // 语音模式需要 Anthropic OAuth —— 它使用 claude.ai 上的
  // voice_stream 端点，该端点在使用 API 密钥、Bedrock、Vertex
  // 或 Foundry 时不可用。
  if (!isAnthropicAuthEnabled()) {
    return false
  }
  // isAnthropicAuthEnabled 只检查认证*提供者*，不检查令牌是否存在。
  // 没有此检查，语音 UI 会渲染但 connectVoiceStream 在用户未登录时
  // 会静默失败。
  const tokens = getClaudeAIOAuthTokens()
  return Boolean(tokens?.accessToken)
}

/**
 * Anthropic voice_stream 后端的完整运行时检查。
 * 当认证 + GrowthBook 熔断开关均通过时返回 true。
 */
export function isVoiceModeEnabled(): boolean {
  return hasVoiceAuth() && isVoiceGrowthBookEnabled()
}

/**
 * 检查语音模式是否可使用任意 STT 后端激活。
 * 当 VOICE_MODE 功能标志开启且 GrowthBook 熔断开关关闭时始终返回
 * true —— Doubao 后端不需要 Anthropic 认证。
 */
export function isVoiceAvailable(): boolean {
  return isVoiceGrowthBookEnabled()
}
