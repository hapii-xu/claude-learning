/**
 * 共享的 analytics 配置
 *
 * 用于判断何时应禁用 analytics 的公共逻辑，
 * 适用于所有 analytics 系统（Datadog、1P）
 */

import { isEnvTruthy } from '../../utils/envUtils.js'
import { isTelemetryDisabled } from '../../utils/privacyLevel.js'

/**
 * 检查是否应禁用 analytics 操作
 *
 * 在以下情况下禁用 analytics：
 * - 测试环境（NODE_ENV === 'test'）
 * - 第三方云 provider（Bedrock/Vertex）
 * - privacy level 为 no-telemetry 或 essential-traffic
 */
export function isAnalyticsDisabled(): boolean {
  return (
    process.env.NODE_ENV === 'test' ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY) ||
    isTelemetryDisabled()
  )
}

/**
 * 检查是否应抑制 feedback survey。
 *
 * 与 isAnalyticsDisabled() 不同，此函数不会因 3P provider
 *（Bedrock/Vertex/Foundry）而阻塞。survey 是一个本地 UI 提示，
 * 不含 transcript 数据——企业客户通过 OTEL 采集响应。
 */
export function isFeedbackSurveyDisabled(): boolean {
  return process.env.NODE_ENV === 'test' || isTelemetryDisabled()
}
