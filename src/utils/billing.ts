import {
  getAnthropicApiKey,
  getAuthTokenSource,
  getSubscriptionType,
  isClaudeAISubscriber,
} from './auth.js'
import { getGlobalConfig } from './config.js'
import { isEnvTruthy } from './envUtils.js'

export function hasConsoleBillingAccess(): boolean {
  // 检查是否通过环境变量禁用了成本报告
  if (isEnvTruthy(process.env.DISABLE_COST_WARNINGS)) {
    return false
  }

  const isSubscriber = isClaudeAISubscriber()

  // 如果用户已登录 Max 但同时使用 API 密钥，这可能不准确，但
  // 我们已在这种情况下在启动时显示警告
  if (isSubscriber) return false

  // 检查用户是否有任何形式的认证
  const authSource = getAuthTokenSource()
  const hasApiKey = getAnthropicApiKey() !== null

  // 如果用户完全没有认证（已登出），不显示成本
  if (!authSource.hasToken && !hasApiKey) {
    return false
  }

  const config = getGlobalConfig()
  const orgRole = config.oauthAccount?.organizationRole
  const workspaceRole = config.oauthAccount?.workspaceRole

  if (!orgRole || !workspaceRole) {
    return false // 隐藏自我们添加角色以来未重新认证的老用户的成本
  }

  // 如果用户在工作区或组织级别是管理员或计费角色，则具有计费访问权限
  return (
    ['admin', 'billing'].includes(orgRole) ||
    ['workspace_admin', 'workspace_billing'].includes(workspaceRole)
  )
}

// /mock-limits 测试的模拟计费访问（由 mockRateLimits.ts 设置）
let mockBillingAccessOverride: boolean | null = null

export function setMockBillingAccessOverride(value: boolean | null): void {
  mockBillingAccessOverride = value
}

export function hasClaudeAiBillingAccess(): boolean {
  // 首先检查模拟计费访问（用于 /mock-limits 测试）
  if (mockBillingAccessOverride !== null) {
    return mockBillingAccessOverride
  }

  if (!isClaudeAISubscriber()) {
    return false
  }

  const subscriptionType = getSubscriptionType()

  // 消费者计划（Max/Pro）—— 个人用户始终具有计费访问权限
  if (subscriptionType === 'max' || subscriptionType === 'pro') {
    return true
  }

  // 团队/企业 —— 检查管理员或计费角色
  const config = getGlobalConfig()
  const orgRole = config.oauthAccount?.organizationRole

  return (
    !!orgRole &&
    ['admin', 'billing', 'owner', 'primary_owner'].includes(orgRole)
  )
}
