/**
 * 集中的速率限制消息生成
 * 所有速率限制相关消息的唯一真相来源
 */

import {
  getOauthAccountInfo,
  getSubscriptionType,
  isOverageProvisioningAllowed,
} from '../utils/auth.js'
import { hasClaudeAiBillingAccess } from '../utils/billing.js'
import { formatResetTime } from '../utils/format.js'
import type { ClaudeAILimits } from './claudeAiLimits.js'

const FEEDBACK_CHANNEL_ANT = '#briarpatch-cc'

/**
 * 所有可能的速率限制错误消息前缀
 * 导出以避免在 UI 组件中进行脆弱的字符串匹配
 */
export const RATE_LIMIT_ERROR_PREFIXES = [
  "You've hit your",
  "You've used",
  "You're now using extra usage",
  "You're close to",
  "You're out of extra usage",
] as const

/**
 * 检查消息是否是速率限制错误
 */
export function isRateLimitErrorMessage(text: string): boolean {
  return RATE_LIMIT_ERROR_PREFIXES.some(prefix => text.startsWith(prefix))
}

export type RateLimitMessage = {
  message: string
  severity: 'error' | 'warning'
}

/**
 * 根据限制状态获取相应的速率限制消息
 * 如果不应显示消息则返回 null
 */
export function getRateLimitMessage(
  limits: ClaudeAILimits,
  model: string,
): RateLimitMessage | null {
  // 首先检查超额用量场景（当订阅被拒绝但超额用量可用时）
  // getUsingOverageText 与警告分开渲染。
  if (limits.isUsingOverage) {
    // 如果接近超额用量消费限制，显示警告
    if (limits.overageStatus === 'allowed_warning') {
      return {
        message: "You're close to your extra usage spending limit",
        severity: 'warning',
      }
    }
    return null
  }

  // 错误状态 —— 当限制被拒绝时
  if (limits.status === 'rejected') {
    return { message: getLimitReachedText(limits, model), severity: 'error' }
  }

  // 警告状态 —— 当通过早期警告接近限制时
  if (limits.status === 'allowed_warning') {
    // 仅当用量高于阈值（70%）时显示警告
    // 这防止了周重置后 API 可能发送
    // 带有过时数据的 allowed_warning 且用量较低时的误报
    const WARNING_THRESHOLD = 0.7
    if (
      limits.utilization !== undefined &&
      limits.utilization < WARNING_THRESHOLD
    ) {
      return null
    }

    // 不要警告无账单访问权限的 Team/Enterprise 用户即将达到计划限制
    // 如果超额用量已启用 —— 他们会无缝切换到超额用量
    const subscriptionType = getSubscriptionType()
    const isTeamOrEnterprise =
      subscriptionType === 'team' || subscriptionType === 'enterprise'
    const hasExtraUsageEnabled =
      getOauthAccountInfo()?.hasExtraUsageEnabled === true

    if (
      isTeamOrEnterprise &&
      hasExtraUsageEnabled &&
      !hasClaudeAiBillingAccess()
    ) {
      return null
    }

    const text = getEarlyWarningText(limits)
    if (text) {
      return { message: text, severity: 'warning' }
    }
  }

  // 无需消息
  return null
}

/**
 * 获取 API 错误的错误消息（用于 errors.ts）
 * 返回消息字符串，如果不应显示错误消息则返回 null
 */
export function getRateLimitErrorMessage(
  limits: ClaudeAILimits,
  model: string,
): string | null {
  const message = getRateLimitMessage(limits, model)

  // 仅返回错误消息，不包括警告
  if (message && message.severity === 'error') {
    return message.message
  }

  return null
}

/**
 * 获取 UI 页脚的警告消息
 * 返回警告消息字符串，如果不应显示警告则返回 null
 */
export function getRateLimitWarning(
  limits: ClaudeAILimits,
  model: string,
): string | null {
  const message = getRateLimitMessage(limits, model)

  // 仅为页脚返回警告 —— 错误显示在 AssistantTextMessages 中
  if (message && message.severity === 'warning') {
    return message.message
  }

  // 不在页脚显示错误
  return null
}

function getLimitReachedText(limits: ClaudeAILimits, model: string): string {
  const resetsAt = limits.resetsAt
  const resetTime = resetsAt ? formatResetTime(resetsAt, true) : undefined
  const overageResetTime = limits.overageResetsAt
    ? formatResetTime(limits.overageResetsAt, true)
    : undefined
  const resetMessage = resetTime ? ` · resets ${resetTime}` : ''

  // 如果订阅（在此方法之前检查）和超额用量都已耗尽
  if (limits.overageStatus === 'rejected') {
    // 显示最早的重置时间以指示用户何时可以恢复
    let overageResetMessage = ''
    if (resetsAt && limits.overageResetsAt) {
      // 两个时间戳都存在 —— 使用较早的那个
      if (resetsAt < limits.overageResetsAt) {
        overageResetMessage = ` · resets ${resetTime}`
      } else {
        overageResetMessage = ` · resets ${overageResetTime}`
      }
    } else if (resetTime) {
      overageResetMessage = ` · resets ${resetTime}`
    } else if (overageResetTime) {
      overageResetMessage = ` · resets ${overageResetTime}`
    }

    if (limits.overageDisabledReason === 'out_of_credits') {
      return `You're out of extra usage${overageResetMessage}`
    }

    return formatLimitReachedText('limit', overageResetMessage, model)
  }

  if (limits.rateLimitType === 'seven_day_sonnet') {
    const subscriptionType = getSubscriptionType()
    const isProOrEnterprise =
      subscriptionType === 'pro' || subscriptionType === 'enterprise'
    // 对于 pro 和 enterprise，Sonnet 限制与周限制相同
    const limit = isProOrEnterprise ? 'weekly limit' : 'Sonnet limit'
    return formatLimitReachedText(limit, resetMessage, model)
  }

  if (limits.rateLimitType === 'seven_day_opus') {
    return formatLimitReachedText('Opus limit', resetMessage, model)
  }

  if (limits.rateLimitType === 'seven_day') {
    return formatLimitReachedText('weekly limit', resetMessage, model)
  }

  if (limits.rateLimitType === 'five_hour') {
    return formatLimitReachedText('session limit', resetMessage, model)
  }

  return formatLimitReachedText('usage limit', resetMessage, model)
}

function getEarlyWarningText(limits: ClaudeAILimits): string | null {
  let limitName: string | null = null
  switch (limits.rateLimitType) {
    case 'seven_day':
      limitName = 'weekly limit'
      break
    case 'five_hour':
      limitName = 'session limit'
      break
    case 'seven_day_opus':
      limitName = 'Opus limit'
      break
    case 'seven_day_sonnet':
      limitName = 'Sonnet limit'
      break
    case 'overage':
      limitName = 'extra usage'
      break
    case undefined:
      return null
  }

  // utilization 和 resetsAt 应该已定义，因为早期警告是基于它们计算的
  const used = limits.utilization
    ? Math.floor(limits.utilization * 100)
    : undefined
  const resetTime = limits.resetsAt
    ? formatResetTime(limits.resetsAt, true)
    : undefined

  // 根据订阅类型和限制类型获取追加销售命令
  const upsell = getWarningUpsellText(limits.rateLimitType)

  if (used && resetTime) {
    const base = `You've used ${used}% of your ${limitName} · resets ${resetTime}`
    return upsell ? `${base} · ${upsell}` : base
  }

  if (used) {
    const base = `You've used ${used}% of your ${limitName}`
    return upsell ? `${base} · ${upsell}` : base
  }

  if (limits.rateLimitType === 'overage') {
    // 对于"Approaching <x>"的措辞，"extra usage limit"比"extra usage"更合理
    limitName += ' limit'
  }

  if (resetTime) {
    const base = `Approaching ${limitName} · resets ${resetTime}`
    return upsell ? `${base} · ${upsell}` : base
  }

  const base = `Approaching ${limitName}`
  return upsell ? `${base} · ${upsell}` : base
}

/**
 * 根据订阅和限制类型获取警告消息的追加销售命令文本。
 * 如果不应显示追加销售则返回 null。
 * 仅用于警告，因为实际的速率限制触发会看到交互式选项菜单。
 */
function getWarningUpsellText(
  rateLimitType: ClaudeAILimits['rateLimitType'],
): string | null {
  const subscriptionType = getSubscriptionType()
  const hasExtraUsageEnabled =
    getOauthAccountInfo()?.hasExtraUsageEnabled === true

  // 5 小时会话限制警告
  if (rateLimitType === 'five_hour') {
    // 禁用了超额用量的 Teams/Enterprise：提示申请额外用量
    // 仅当此组织类型允许超额用量配置时显示（例如，非 AWS marketplace）
    if (subscriptionType === 'team' || subscriptionType === 'enterprise') {
      if (!hasExtraUsageEnabled && isOverageProvisioningAllowed()) {
        return '/extra-usage to request more'
      }
      // 启用了超额用量或不支持的账单类型的 Teams/Enterprise 不需要追加销售
      return null
    }

    // Pro/Max 用户：提示升级
    if (subscriptionType === 'pro' || subscriptionType === 'max') {
      return '/upgrade to keep using Claude Code'
    }
  }

  // 超额用量警告（接近消费限制）
  if (rateLimitType === 'overage') {
    if (subscriptionType === 'team' || subscriptionType === 'enterprise') {
      if (!hasExtraUsageEnabled && isOverageProvisioningAllowed()) {
        return '/extra-usage to request more'
      }
    }
  }

  // 根据规范，周限制警告不显示追加销售
  return null
}

/**
 * 获取超额用量模式转换的通知文本
 * 用于进入超额用量模式时的瞬时通知
 */
export function getUsingOverageText(limits: ClaudeAILimits): string {
  const resetTime = limits.resetsAt
    ? formatResetTime(limits.resetsAt, true)
    : ''

  let limitName = ''
  if (limits.rateLimitType === 'five_hour') {
    limitName = 'session limit'
  } else if (limits.rateLimitType === 'seven_day') {
    limitName = 'weekly limit'
  } else if (limits.rateLimitType === 'seven_day_opus') {
    limitName = 'Opus limit'
  } else if (limits.rateLimitType === 'seven_day_sonnet') {
    const subscriptionType = getSubscriptionType()
    const isProOrEnterprise =
      subscriptionType === 'pro' || subscriptionType === 'enterprise'
    // 对于 pro 和 enterprise，Sonnet 限制与周限制相同
    limitName = isProOrEnterprise ? 'weekly limit' : 'Sonnet limit'
  }

  if (!limitName) {
    return 'Now using extra usage'
  }

  const resetMessage = resetTime
    ? ` · Your ${limitName} resets ${resetTime}`
    : ''
  return `You're now using extra usage${resetMessage}`
}

function formatLimitReachedText(
  limit: string,
  resetMessage: string,
  _model: string,
): string {
  // 为 Ant 用户增强消息
  if (process.env.USER_TYPE === 'ant') {
    return `You've hit your ${limit}${resetMessage}. If you have feedback about this limit, post in ${FEEDBACK_CHANNEL_ANT}. You can reset your limits with /reset-limits`
  }

  return `You've hit your ${limit}${resetMessage}`
}
