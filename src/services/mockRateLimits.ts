// 用于测试的 Mock 速率限制 [仅限 ANT 内部]
// 允许在不触碰实际限制的情况下测试各种速率限制场景
//
// ⚠️  警告：这仅供内部测试/演示目的！
// Mock header 可能与 API 规范或实际行为不完全一致。
// 在依赖此功能用于生产特性之前，务必根据实际 API 响应进行验证。

import type { SubscriptionType } from '../services/oauth/types.js'
import { setMockBillingAccessOverride } from '../utils/billing.js'
import type { OverageDisabledReason } from './claudeAiLimits.js'

type MockHeaders = {
  'anthropic-ratelimit-unified-status'?:
    | 'allowed'
    | 'allowed_warning'
    | 'rejected'
  'anthropic-ratelimit-unified-reset'?: string
  'anthropic-ratelimit-unified-representative-claim'?:
    | 'five_hour'
    | 'seven_day'
    | 'seven_day_opus'
    | 'seven_day_sonnet'
  'anthropic-ratelimit-unified-overage-status'?:
    | 'allowed'
    | 'allowed_warning'
    | 'rejected'
  'anthropic-ratelimit-unified-overage-reset'?: string
  'anthropic-ratelimit-unified-overage-disabled-reason'?: OverageDisabledReason
  'anthropic-ratelimit-unified-fallback'?: 'available'
  'anthropic-ratelimit-unified-fallback-percentage'?: string
  'retry-after'?: string
  // 早期警告用量 header
  'anthropic-ratelimit-unified-5h-utilization'?: string
  'anthropic-ratelimit-unified-5h-reset'?: string
  'anthropic-ratelimit-unified-5h-surpassed-threshold'?: string
  'anthropic-ratelimit-unified-7d-utilization'?: string
  'anthropic-ratelimit-unified-7d-reset'?: string
  'anthropic-ratelimit-unified-7d-surpassed-threshold'?: string
  'anthropic-ratelimit-unified-overage-utilization'?: string
  'anthropic-ratelimit-unified-overage-surpassed-threshold'?: string
}

export type MockHeaderKey =
  | 'status'
  | 'reset'
  | 'claim'
  | 'overage-status'
  | 'overage-reset'
  | 'overage-disabled-reason'
  | 'fallback'
  | 'fallback-percentage'
  | 'retry-after'
  | '5h-utilization'
  | '5h-reset'
  | '5h-surpassed-threshold'
  | '7d-utilization'
  | '7d-reset'
  | '7d-surpassed-threshold'

export type MockScenario =
  | 'normal'
  | 'session-limit-reached'
  | 'approaching-weekly-limit'
  | 'weekly-limit-reached'
  | 'overage-active'
  | 'overage-warning'
  | 'overage-exhausted'
  | 'out-of-credits'
  | 'org-zero-credit-limit'
  | 'org-spend-cap-hit'
  | 'member-zero-credit-limit'
  | 'seat-tier-zero-credit-limit'
  | 'opus-limit'
  | 'opus-warning'
  | 'sonnet-limit'
  | 'sonnet-warning'
  | 'fast-mode-limit'
  | 'fast-mode-short-limit'
  | 'extra-usage-required'
  | 'clear'

let mockHeaders: MockHeaders = {}
let mockEnabled = false
let mockHeaderless429Message: string | null = null
let mockSubscriptionType: SubscriptionType | null = null
let mockFastModeRateLimitDurationMs: number | null = null
let mockFastModeRateLimitExpiresAt: number | null = null
// mock 测试的默认订阅类型
const DEFAULT_MOCK_SUBSCRIPTION: SubscriptionType = 'max'

// 跟踪单个已超出的限制及其重置时间
type ExceededLimit = {
  type: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet'
  resetsAt: number // Unix 时间戳
}

let exceededLimits: ExceededLimit[] = []

// 新方案：切换单个 header
export function setMockHeader(
  key: MockHeaderKey,
  value: string | undefined,
): void {
  if (process.env.USER_TYPE !== 'ant') {
    return
  }

  mockEnabled = true

  // retry-after 没有 prefix 的特殊情况
  const fullKey = (
    key === 'retry-after' ? 'retry-after' : `anthropic-ratelimit-unified-${key}`
  ) as keyof MockHeaders

  if (value === undefined || value === 'clear') {
    delete mockHeaders[fullKey]
    if (key === 'claim') {
      exceededLimits = []
    }
    // 如果 status 发生变化，更新 retry-after
    if (key === 'status' || key === 'overage-status') {
      updateRetryAfter()
    }
    return
  } else {
    // 处理重置时间的特殊情况
    if (key === 'reset' || key === 'overage-reset') {
      // 如果用户提供的是数字，将其视为距离现在的小时数
      const hours = Number(value)
      if (!isNaN(hours)) {
        value = String(Math.floor(Date.now() / 1000) + hours * 3600)
      }
    }

    // 处理声明 —— 添加到已超出限制
    if (key === 'claim') {
      const validClaims = [
        'five_hour',
        'seven_day',
        'seven_day_opus',
        'seven_day_sonnet',
      ]
      if (validClaims.includes(value)) {
        // 根据声明类型确定重置时间
        let resetsAt: number
        if (value === 'five_hour') {
          resetsAt = Math.floor(Date.now() / 1000) + 5 * 3600
        } else if (
          value === 'seven_day' ||
          value === 'seven_day_opus' ||
          value === 'seven_day_sonnet'
        ) {
          resetsAt = Math.floor(Date.now() / 1000) + 7 * 24 * 3600
        } else {
          resetsAt = Math.floor(Date.now() / 1000) + 3600
        }

        // 添加到已超出限制（如已存在则移除）
        exceededLimits = exceededLimits.filter(l => l.type !== value)
        exceededLimits.push({ type: value as ExceededLimit['type'], resetsAt })

        // 设置代表性声明（重置时间最远的那个）
        updateRepresentativeClaim()
        return
      }
    }
    // 扩展为字符串值记录，以允许动态键赋值。
    // MockHeaders 的值是字符串字面量联合类型；赋值原始用户输入
    // 字符串需要扩展，但这是 mock/测试代码，可以接受。
    const headers: Partial<Record<keyof MockHeaders, string>> = mockHeaders
    headers[fullKey] = value

    // 如果 status 发生变化，更新 retry-after
    if (key === 'status' || key === 'overage-status') {
      updateRetryAfter()
    }
  }

  // 如果所有 header 都已清除，禁用 mock
  if (Object.keys(mockHeaders).length === 0) {
    mockEnabled = false
  }
}

// 根据当前状态更新 retry-after 的辅助函数
function updateRetryAfter(): void {
  const status = mockHeaders['anthropic-ratelimit-unified-status']
  const overageStatus =
    mockHeaders['anthropic-ratelimit-unified-overage-status']
  const reset = mockHeaders['anthropic-ratelimit-unified-reset']

  if (
    status === 'rejected' &&
    (!overageStatus || overageStatus === 'rejected') &&
    reset
  ) {
    // 计算到重置的剩余秒数
    const resetTimestamp = Number(reset)
    const secondsUntilReset = Math.max(
      0,
      resetTimestamp - Math.floor(Date.now() / 1000),
    )
    mockHeaders['retry-after'] = String(secondsUntilReset)
  } else {
    delete mockHeaders['retry-after']
  }
}

// 根据已超出限制更新代表性声明
function updateRepresentativeClaim(): void {
  if (exceededLimits.length === 0) {
    delete mockHeaders['anthropic-ratelimit-unified-representative-claim']
    delete mockHeaders['anthropic-ratelimit-unified-reset']
    delete mockHeaders['retry-after']
    return
  }

  // 查找重置时间最远的限制
  const furthest = exceededLimits.reduce((prev, curr) =>
    curr.resetsAt > prev.resetsAt ? curr : prev,
  )

  // 设置代表性声明（在警告和拒绝时都出现）
  mockHeaders['anthropic-ratelimit-unified-representative-claim'] =
    furthest.type
  mockHeaders['anthropic-ratelimit-unified-reset'] = String(furthest.resetsAt)

  // 如果状态为 rejected 且无可用超额用量，添加 retry-after
  if (mockHeaders['anthropic-ratelimit-unified-status'] === 'rejected') {
    const overageStatus =
      mockHeaders['anthropic-ratelimit-unified-overage-status']
    if (!overageStatus || overageStatus === 'rejected') {
      // 计算到重置的剩余秒数
      const secondsUntilReset = Math.max(
        0,
        furthest.resetsAt - Math.floor(Date.now() / 1000),
      )
      mockHeaders['retry-after'] = String(secondsUntilReset)
    } else {
      // 有可用超额用量，无 retry-after
      delete mockHeaders['retry-after']
    }
  } else {
    delete mockHeaders['retry-after']
  }
}

// 添加自定义重置时间的已超出限制的函数
export function addExceededLimit(
  type: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet',
  hoursFromNow: number,
): void {
  if (process.env.USER_TYPE !== 'ant') {
    return
  }

  mockEnabled = true
  const resetsAt = Math.floor(Date.now() / 1000) + hoursFromNow * 3600

  // 移除同类型的现有限制
  exceededLimits = exceededLimits.filter(l => l.type !== type)
  exceededLimits.push({ type, resetsAt })

  // 如果有已超出的限制，将状态更新为 rejected
  if (exceededLimits.length > 0) {
    mockHeaders['anthropic-ratelimit-unified-status'] = 'rejected'
  }

  updateRepresentativeClaim()
}

// 为时间相对阈值设置 mock 早期警告用量
// claimAbbrev: '5h' 或 '7d'
// utilization: 0-1（例如 0.92 表示已用 92%）
// hoursFromNow: 距离重置的小时数（默认：5h 为 4 小时，7d 为 120 小时）
export function setMockEarlyWarning(
  claimAbbrev: '5h' | '7d' | 'overage',
  utilization: number,
  hoursFromNow?: number,
): void {
  if (process.env.USER_TYPE !== 'ant') {
    return
  }

  mockEnabled = true

  // 首先清除所有早期警告 header（5h 在 7d 之前检查，因此测试 7d 时需要
  // 清除 5h header 以避免 5h 优先）
  clearMockEarlyWarning()

  // 基于 claim 类型的默认小时数（窗口早期以触发警告）
  const defaultHours = claimAbbrev === '5h' ? 4 : 5 * 24
  const hours = hoursFromNow ?? defaultHours
  const resetsAt = Math.floor(Date.now() / 1000) + hours * 3600

  mockHeaders[`anthropic-ratelimit-unified-${claimAbbrev}-utilization`] =
    String(utilization)
  mockHeaders[`anthropic-ratelimit-unified-${claimAbbrev}-reset`] =
    String(resetsAt)
  // 设置 surpassed-threshold header 以触发早期警告
  mockHeaders[
    `anthropic-ratelimit-unified-${claimAbbrev}-surpassed-threshold`
  ] = String(utilization)

  // 将 status 设置为 allowed，以便早期警告逻辑可以将其升级
  if (!mockHeaders['anthropic-ratelimit-unified-status']) {
    mockHeaders['anthropic-ratelimit-unified-status'] = 'allowed'
  }
}

// 清除 mock 早期警告 header
export function clearMockEarlyWarning(): void {
  delete mockHeaders['anthropic-ratelimit-unified-5h-utilization']
  delete mockHeaders['anthropic-ratelimit-unified-5h-reset']
  delete mockHeaders['anthropic-ratelimit-unified-5h-surpassed-threshold']
  delete mockHeaders['anthropic-ratelimit-unified-7d-utilization']
  delete mockHeaders['anthropic-ratelimit-unified-7d-reset']
  delete mockHeaders['anthropic-ratelimit-unified-7d-surpassed-threshold']
}

export function setMockRateLimitScenario(scenario: MockScenario): void {
  if (process.env.USER_TYPE !== 'ant') {
    return
  }

  if (scenario === 'clear') {
    mockHeaders = {}
    mockHeaderless429Message = null
    mockEnabled = false
    return
  }

  mockEnabled = true

  // 为演示设置重置时间
  const fiveHoursFromNow = Math.floor(Date.now() / 1000) + 5 * 3600
  const sevenDaysFromNow = Math.floor(Date.now() / 1000) + 7 * 24 * 3600

  // 清除现有 header
  mockHeaders = {}
  mockHeaderless429Message = null

  // 仅对显式设置已超出限制的场景清除它们
  // 超额用量场景应保留现有已超出限制
  const preserveExceededLimits = [
    'overage-active',
    'overage-warning',
    'overage-exhausted',
  ].includes(scenario)
  if (!preserveExceededLimits) {
    exceededLimits = []
  }

  switch (scenario) {
    case 'normal':
      mockHeaders = {
        'anthropic-ratelimit-unified-status': 'allowed',
        'anthropic-ratelimit-unified-reset': String(fiveHoursFromNow),
      }
      break

    case 'session-limit-reached':
      exceededLimits = [{ type: 'five_hour', resetsAt: fiveHoursFromNow }]
      updateRepresentativeClaim()
      mockHeaders['anthropic-ratelimit-unified-status'] = 'rejected'
      break

    case 'approaching-weekly-limit':
      mockHeaders = {
        'anthropic-ratelimit-unified-status': 'allowed_warning',
        'anthropic-ratelimit-unified-reset': String(sevenDaysFromNow),
        'anthropic-ratelimit-unified-representative-claim': 'seven_day',
      }
      break

    case 'weekly-limit-reached':
      exceededLimits = [{ type: 'seven_day', resetsAt: sevenDaysFromNow }]
      updateRepresentativeClaim()
      mockHeaders['anthropic-ratelimit-unified-status'] = 'rejected'
      break

    case 'overage-active': {
      // 如果还没有限制被超出，默认使用 5 小时
      if (exceededLimits.length === 0) {
        exceededLimits = [{ type: 'five_hour', resetsAt: fiveHoursFromNow }]
      }
      updateRepresentativeClaim()
      mockHeaders['anthropic-ratelimit-unified-status'] = 'rejected'
      mockHeaders['anthropic-ratelimit-unified-overage-status'] = 'allowed'
      // 设置超额用量重置时间（月度）
      const endOfMonthActive = new Date()
      endOfMonthActive.setMonth(endOfMonthActive.getMonth() + 1, 1)
      endOfMonthActive.setHours(0, 0, 0, 0)
      mockHeaders['anthropic-ratelimit-unified-overage-reset'] = String(
        Math.floor(endOfMonthActive.getTime() / 1000),
      )
      break
    }

    case 'overage-warning': {
      // 如果还没有限制被超出，默认使用 5 小时
      if (exceededLimits.length === 0) {
        exceededLimits = [{ type: 'five_hour', resetsAt: fiveHoursFromNow }]
      }
      updateRepresentativeClaim()
      mockHeaders['anthropic-ratelimit-unified-status'] = 'rejected'
      mockHeaders['anthropic-ratelimit-unified-overage-status'] =
        'allowed_warning'
      // 超额用量通常按月重置，但演示中设为月末
      const endOfMonth = new Date()
      endOfMonth.setMonth(endOfMonth.getMonth() + 1, 1)
      endOfMonth.setHours(0, 0, 0, 0)
      mockHeaders['anthropic-ratelimit-unified-overage-reset'] = String(
        Math.floor(endOfMonth.getTime() / 1000),
      )
      break
    }

    case 'overage-exhausted': {
      // 如果还没有限制被超出，默认使用 5 小时
      if (exceededLimits.length === 0) {
        exceededLimits = [{ type: 'five_hour', resetsAt: fiveHoursFromNow }]
      }
      updateRepresentativeClaim()
      mockHeaders['anthropic-ratelimit-unified-status'] = 'rejected'
      mockHeaders['anthropic-ratelimit-unified-overage-status'] = 'rejected'
      // 订阅和超额用量均已耗尽
      // 订阅根据已超出限制重置，超额用量按月重置
      const endOfMonthExhausted = new Date()
      endOfMonthExhausted.setMonth(endOfMonthExhausted.getMonth() + 1, 1)
      endOfMonthExhausted.setHours(0, 0, 0, 0)
      mockHeaders['anthropic-ratelimit-unified-overage-reset'] = String(
        Math.floor(endOfMonthExhausted.getTime() / 1000),
      )
      break
    }

    case 'out-of-credits': {
      // 额度不足 —— 订阅限制被触发，超额用量因额度不足被拒绝
      // （钱包为空）
      if (exceededLimits.length === 0) {
        exceededLimits = [{ type: 'five_hour', resetsAt: fiveHoursFromNow }]
      }
      updateRepresentativeClaim()
      mockHeaders['anthropic-ratelimit-unified-status'] = 'rejected'
      mockHeaders['anthropic-ratelimit-unified-overage-status'] = 'rejected'
      mockHeaders['anthropic-ratelimit-unified-overage-disabled-reason'] =
        'out_of_credits'
      const endOfMonth = new Date()
      endOfMonth.setMonth(endOfMonth.getMonth() + 1, 1)
      endOfMonth.setHours(0, 0, 0, 0)
      mockHeaders['anthropic-ratelimit-unified-overage-reset'] = String(
        Math.floor(endOfMonth.getTime() / 1000),
      )
      break
    }

    case 'org-zero-credit-limit': {
      // 组织服务额度限制为零 —— 管理员将组织级别的消费上限设为 $0
      // 非管理员 Team/Enterprise 用户不应看到"申请额外用量"选项
      if (exceededLimits.length === 0) {
        exceededLimits = [{ type: 'five_hour', resetsAt: fiveHoursFromNow }]
      }
      updateRepresentativeClaim()
      mockHeaders['anthropic-ratelimit-unified-status'] = 'rejected'
      mockHeaders['anthropic-ratelimit-unified-overage-status'] = 'rejected'
      mockHeaders['anthropic-ratelimit-unified-overage-disabled-reason'] =
        'org_service_zero_credit_limit'
      const endOfMonthZero = new Date()
      endOfMonthZero.setMonth(endOfMonthZero.getMonth() + 1, 1)
      endOfMonthZero.setHours(0, 0, 0, 0)
      mockHeaders['anthropic-ratelimit-unified-overage-reset'] = String(
        Math.floor(endOfMonthZero.getTime() / 1000),
      )
      break
    }

    case 'org-spend-cap-hit': {
      // 组织月度消费上限被触发 —— 组织超额用量被临时禁用
      // 非管理员 Team/Enterprise 用户不应看到"申请额外用量"选项
      if (exceededLimits.length === 0) {
        exceededLimits = [{ type: 'five_hour', resetsAt: fiveHoursFromNow }]
      }
      updateRepresentativeClaim()
      mockHeaders['anthropic-ratelimit-unified-status'] = 'rejected'
      mockHeaders['anthropic-ratelimit-unified-overage-status'] = 'rejected'
      mockHeaders['anthropic-ratelimit-unified-overage-disabled-reason'] =
        'org_level_disabled_until'
      const endOfMonthHit = new Date()
      endOfMonthHit.setMonth(endOfMonthHit.getMonth() + 1, 1)
      endOfMonthHit.setHours(0, 0, 0, 0)
      mockHeaders['anthropic-ratelimit-unified-overage-reset'] = String(
        Math.floor(endOfMonthHit.getTime() / 1000),
      )
      break
    }

    case 'member-zero-credit-limit': {
      // 成员额度限制为零 —— 管理员将此用户的个人限制设为 $0
      // 非管理员 Team/Enterprise 用户应看到"申请额外用量"（管理员可以分配更多）
      if (exceededLimits.length === 0) {
        exceededLimits = [{ type: 'five_hour', resetsAt: fiveHoursFromNow }]
      }
      updateRepresentativeClaim()
      mockHeaders['anthropic-ratelimit-unified-status'] = 'rejected'
      mockHeaders['anthropic-ratelimit-unified-overage-status'] = 'rejected'
      mockHeaders['anthropic-ratelimit-unified-overage-disabled-reason'] =
        'member_zero_credit_limit'
      const endOfMonthMember = new Date()
      endOfMonthMember.setMonth(endOfMonthMember.getMonth() + 1, 1)
      endOfMonthMember.setHours(0, 0, 0, 0)
      mockHeaders['anthropic-ratelimit-unified-overage-reset'] = String(
        Math.floor(endOfMonthMember.getTime() / 1000),
      )
      break
    }

    case 'seat-tier-zero-credit-limit': {
      // 席位等级额度限制为零 —— 管理员将此席位等级的限制设为 $0
      // 非管理员 Team/Enterprise 用户应看到"申请额外用量"（管理员可以分配更多）
      if (exceededLimits.length === 0) {
        exceededLimits = [{ type: 'five_hour', resetsAt: fiveHoursFromNow }]
      }
      updateRepresentativeClaim()
      mockHeaders['anthropic-ratelimit-unified-status'] = 'rejected'
      mockHeaders['anthropic-ratelimit-unified-overage-status'] = 'rejected'
      mockHeaders['anthropic-ratelimit-unified-overage-disabled-reason'] =
        'seat_tier_zero_credit_limit'
      const endOfMonthSeatTier = new Date()
      endOfMonthSeatTier.setMonth(endOfMonthSeatTier.getMonth() + 1, 1)
      endOfMonthSeatTier.setHours(0, 0, 0, 0)
      mockHeaders['anthropic-ratelimit-unified-overage-reset'] = String(
        Math.floor(endOfMonthSeatTier.getTime() / 1000),
      )
      break
    }

    case 'opus-limit': {
      exceededLimits = [{ type: 'seven_day_opus', resetsAt: sevenDaysFromNow }]
      updateRepresentativeClaim()
      // 始终发送 429 rejected 状态 —— 错误处理器会根据回退资格
      // 决定是显示错误还是返回 NO_RESPONSE_REQUESTED
      mockHeaders['anthropic-ratelimit-unified-status'] = 'rejected'
      break
    }

    case 'opus-warning': {
      mockHeaders = {
        'anthropic-ratelimit-unified-status': 'allowed_warning',
        'anthropic-ratelimit-unified-reset': String(sevenDaysFromNow),
        'anthropic-ratelimit-unified-representative-claim': 'seven_day_opus',
      }
      break
    }

    case 'sonnet-limit': {
      exceededLimits = [
        { type: 'seven_day_sonnet', resetsAt: sevenDaysFromNow },
      ]
      updateRepresentativeClaim()
      mockHeaders['anthropic-ratelimit-unified-status'] = 'rejected'
      break
    }

    case 'sonnet-warning': {
      mockHeaders = {
        'anthropic-ratelimit-unified-status': 'allowed_warning',
        'anthropic-ratelimit-unified-reset': String(sevenDaysFromNow),
        'anthropic-ratelimit-unified-representative-claim': 'seven_day_sonnet',
      }
      break
    }

    case 'fast-mode-limit': {
      updateRepresentativeClaim()
      mockHeaders['anthropic-ratelimit-unified-status'] = 'rejected'
      // 持续时间（毫秒）> 20 秒阈值以触发冷却
      mockFastModeRateLimitDurationMs = 10 * 60 * 1000
      break
    }

    case 'fast-mode-short-limit': {
      updateRepresentativeClaim()
      mockHeaders['anthropic-ratelimit-unified-status'] = 'rejected'
      // 持续时间（毫秒）< 20 秒阈值，不会触发冷却
      mockFastModeRateLimitDurationMs = 10 * 1000
      break
    }

    case 'extra-usage-required': {
      // 无 header 的 429 —— 测试 errors.ts 中的权益拒绝路径
      mockHeaderless429Message =
        'Extra usage is required for long context requests.'
      break
    }

    default:
      break
  }
}

export function getMockHeaderless429Message(): string | null {
  if (process.env.USER_TYPE !== 'ant') {
    return null
  }
  // 用于 -p / SDK 测试的环境变量路径（此时斜杠命令不可用）
  if (process.env.CLAUDE_MOCK_HEADERLESS_429) {
    return process.env.CLAUDE_MOCK_HEADERLESS_429
  }
  if (!mockEnabled) {
    return null
  }
  return mockHeaderless429Message
}

export function getMockHeaders(): MockHeaders | null {
  if (
    !mockEnabled ||
    process.env.USER_TYPE !== 'ant' ||
    Object.keys(mockHeaders).length === 0
  ) {
    return null
  }
  return mockHeaders
}

export function getMockStatus(): string {
  if (
    !mockEnabled ||
    (Object.keys(mockHeaders).length === 0 && !mockSubscriptionType)
  ) {
    return 'No mock headers active (using real limits)'
  }

  const lines: string[] = []
  lines.push('Active mock headers:')

  // 显示订阅类型 —— 显式设置或默认
  const effectiveSubscription =
    mockSubscriptionType || DEFAULT_MOCK_SUBSCRIPTION
  if (mockSubscriptionType) {
    lines.push(`  Subscription Type: ${mockSubscriptionType} (explicitly set)`)
  } else {
    lines.push(`  Subscription Type: ${effectiveSubscription} (default)`)
  }

  Object.entries(mockHeaders).forEach(([key, value]) => {
    if (value !== undefined) {
      // 美化格式化 header 名称
      const formattedKey = key
        .replace('anthropic-ratelimit-unified-', '')
        .replace(/-/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase())

      // 将时间戳格式化为人类可读形式
      if (key.includes('reset') && value) {
        const timestamp = Number(value)
        const date = new Date(timestamp * 1000)
        lines.push(`  ${formattedKey}: ${value} (${date.toLocaleString()})`)
      } else {
        lines.push(`  ${formattedKey}: ${value}`)
      }
    }
  })

  // 显示已超出的限制（如果有）
  if (exceededLimits.length > 0) {
    lines.push('\nExceeded limits (contributing to representative claim):')
    exceededLimits.forEach(limit => {
      const date = new Date(limit.resetsAt * 1000)
      lines.push(`  ${limit.type}: resets at ${date.toLocaleString()}`)
    })
  }

  return lines.join('\n')
}

export function clearMockHeaders(): void {
  mockHeaders = {}
  exceededLimits = []
  mockSubscriptionType = null
  mockFastModeRateLimitDurationMs = null
  mockFastModeRateLimitExpiresAt = null
  mockHeaderless429Message = null
  setMockBillingAccessOverride(null)
  mockEnabled = false
}

export function applyMockHeaders(
  headers: globalThis.Headers,
): globalThis.Headers {
  const mock = getMockHeaders()
  if (!mock) {
    return headers
  }

  // 创建带有原始 header 的新 Headers 对象
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  const newHeaders = new globalThis.Headers(headers)

  // 应用 mock header（覆盖原始值）
  Object.entries(mock).forEach(([key, value]) => {
    if (value !== undefined) {
      newHeaders.set(key, value)
    }
  })

  return newHeaders
}

// 检查是否应在无订阅的情况下处理速率限制
// 供 Ant 员工使用 mock 进行测试
export function shouldProcessMockLimits(): boolean {
  if (process.env.USER_TYPE !== 'ant') {
    return false
  }
  return mockEnabled || Boolean(process.env.CLAUDE_MOCK_HEADERLESS_429)
}

export function getCurrentMockScenario(): MockScenario | null {
  if (!mockEnabled) {
    return null
  }

  // 从当前 header 反向查找场景
  if (!mockHeaders) return null

  const status = mockHeaders['anthropic-ratelimit-unified-status']
  const overage = mockHeaders['anthropic-ratelimit-unified-overage-status']
  const claim = mockHeaders['anthropic-ratelimit-unified-representative-claim']

  if (claim === 'seven_day_opus') {
    return status === 'rejected' ? 'opus-limit' : 'opus-warning'
  }

  if (claim === 'seven_day_sonnet') {
    return status === 'rejected' ? 'sonnet-limit' : 'sonnet-warning'
  }

  if (overage === 'rejected') return 'overage-exhausted'
  if (overage === 'allowed_warning') return 'overage-warning'
  if (overage === 'allowed') return 'overage-active'

  if (status === 'rejected') {
    if (claim === 'five_hour') return 'session-limit-reached'
    if (claim === 'seven_day') return 'weekly-limit-reached'
  }

  if (status === 'allowed_warning') {
    if (claim === 'seven_day') return 'approaching-weekly-limit'
  }

  if (status === 'allowed') return 'normal'

  return null
}

export function getScenarioDescription(scenario: MockScenario): string {
  switch (scenario) {
    case 'normal':
      return 'Normal usage, no limits'
    case 'session-limit-reached':
      return 'Session rate limit exceeded'
    case 'approaching-weekly-limit':
      return 'Approaching weekly aggregate limit'
    case 'weekly-limit-reached':
      return 'Weekly aggregate limit exceeded'
    case 'overage-active':
      return 'Using extra usage (overage active)'
    case 'overage-warning':
      return 'Approaching extra usage limit'
    case 'overage-exhausted':
      return 'Both subscription and extra usage limits exhausted'
    case 'out-of-credits':
      return 'Out of extra usage credits (wallet empty)'
    case 'org-zero-credit-limit':
      return 'Org spend cap is zero (no extra usage budget)'
    case 'org-spend-cap-hit':
      return 'Org spend cap hit for the month'
    case 'member-zero-credit-limit':
      return 'Member limit is zero (admin can allocate more)'
    case 'seat-tier-zero-credit-limit':
      return 'Seat tier limit is zero (admin can allocate more)'
    case 'opus-limit':
      return 'Opus limit reached'
    case 'opus-warning':
      return 'Approaching Opus limit'
    case 'sonnet-limit':
      return 'Sonnet limit reached'
    case 'sonnet-warning':
      return 'Approaching Sonnet limit'
    case 'fast-mode-limit':
      return 'Fast mode rate limit'
    case 'fast-mode-short-limit':
      return 'Fast mode rate limit (short)'
    case 'extra-usage-required':
      return 'Headerless 429: Extra usage required for 1M context'
    case 'clear':
      return 'Clear mock headers (use real limits)'
    default:
      return 'Unknown scenario'
  }
}

// Mock 订阅类型管理
export function setMockSubscriptionType(
  subscriptionType: SubscriptionType | null,
): void {
  if (process.env.USER_TYPE !== 'ant') {
    return
  }
  mockEnabled = true
  mockSubscriptionType = subscriptionType
}

export function getMockSubscriptionType(): SubscriptionType | null {
  if (!mockEnabled || process.env.USER_TYPE !== 'ant') {
    return null
  }
  // 返回显式设置的订阅类型，或默认为 'max'
  return mockSubscriptionType || DEFAULT_MOCK_SUBSCRIPTION
}

// 导出检查是否应使用 mock 订阅的函数
export function shouldUseMockSubscription(): boolean {
  return (
    mockEnabled &&
    mockSubscriptionType !== null &&
    process.env.USER_TYPE === 'ant'
  )
}

// Mock 账单访问权限（管理员 vs 非管理员）
export function setMockBillingAccess(hasAccess: boolean | null): void {
  if (process.env.USER_TYPE !== 'ant') {
    return
  }
  mockEnabled = true
  setMockBillingAccessOverride(hasAccess)
}

// Mock 快速模式速率限制处理
export function isMockFastModeRateLimitScenario(): boolean {
  return mockFastModeRateLimitDurationMs !== null
}

export function checkMockFastModeRateLimit(
  isFastModeActive?: boolean,
): MockHeaders | null {
  if (mockFastModeRateLimitDurationMs === null) {
    return null
  }

  // 仅在快速模式激活时抛出
  if (!isFastModeActive) {
    return null
  }

  // 检查速率限制是否已过期
  if (
    mockFastModeRateLimitExpiresAt !== null &&
    Date.now() >= mockFastModeRateLimitExpiresAt
  ) {
    clearMockHeaders()
    return null
  }

  // 在首次错误时设置过期时间（配置场景时不设置）
  if (mockFastModeRateLimitExpiresAt === null) {
    mockFastModeRateLimitExpiresAt =
      Date.now() + mockFastModeRateLimitDurationMs
  }

  // 根据剩余时间计算动态 retry-after
  const remainingMs = mockFastModeRateLimitExpiresAt - Date.now()
  const headersToSend = { ...mockHeaders }
  headersToSend['retry-after'] = String(
    Math.max(1, Math.ceil(remainingMs / 1000)),
  )

  return headersToSend
}
