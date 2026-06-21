import { APIError } from '@anthropic-ai/sdk'
import type { MessageParam } from '@anthropic-ai/sdk/resources/index.mjs'
import isEqual from 'lodash-es/isEqual.js'
import { getIsNonInteractiveSession } from '../bootstrap/state.js'
import { isClaudeAISubscriber } from '../utils/auth.js'
import { getModelBetas } from '../utils/betas.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { logError } from '../utils/log.js'
import { getSmallFastModel } from '../utils/model/model.js'
import { isEssentialTrafficOnly } from '../utils/privacyLevel.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from './analytics/index.js'
import { logEvent } from './analytics/index.js'
import { getAPIMetadata } from './api/claude.js'
import { getAnthropicClient } from './api/client.js'
import { anthropicAdapter } from './providerUsage/adapters/anthropic.js'
import { updateProviderBuckets } from './providerUsage/store.js'
import {
  processRateLimitHeaders,
  shouldProcessRateLimits,
} from './rateLimitMocking.js'

// 从集中位置重新导出消息函数
export {
  getRateLimitErrorMessage,
  getRateLimitWarning,
  getUsingOverageText,
} from './rateLimitMessages.js'

type QuotaStatus = 'allowed' | 'allowed_warning' | 'rejected'

type RateLimitType =
  | 'five_hour'
  | 'seven_day'
  | 'seven_day_opus'
  | 'seven_day_sonnet'
  | 'overage'

export type { RateLimitType }

type EarlyWarningThreshold = {
  utilization: number // 0-1 比例：当用量 >= 此值时触发警告
  timePct: number // 0-1 比例：当已用时间 <= 此值时触发警告
}

type EarlyWarningConfig = {
  rateLimitType: RateLimitType
  claimAbbrev: '5h' | '7d'
  windowSeconds: number
  thresholds: EarlyWarningThreshold[]
}

// 早期警告配置，按优先级顺序（从先到后检查）
// 当服务器不发送 surpassed-threshold 头时用作回退
// 当用户消耗配额速度快于时间窗口允许时警告用户
const EARLY_WARNING_CONFIGS: EarlyWarningConfig[] = [
  {
    rateLimitType: 'five_hour',
    claimAbbrev: '5h',
    windowSeconds: 5 * 60 * 60,
    thresholds: [{ utilization: 0.9, timePct: 0.72 }],
  },
  {
    rateLimitType: 'seven_day',
    claimAbbrev: '7d',
    windowSeconds: 7 * 24 * 60 * 60,
    thresholds: [
      { utilization: 0.75, timePct: 0.6 },
      { utilization: 0.5, timePct: 0.35 },
      { utilization: 0.25, timePct: 0.15 },
    ],
  },
]

// 将声明缩写映射到速率限制类型，用于基于 header 的检测
const EARLY_WARNING_CLAIM_MAP: Record<string, RateLimitType> = {
  '5h': 'five_hour',
  '7d': 'seven_day',
  overage: 'overage',
}

const RATE_LIMIT_DISPLAY_NAMES: Record<RateLimitType, string> = {
  five_hour: 'session limit',
  seven_day: 'weekly limit',
  seven_day_opus: 'Opus limit',
  seven_day_sonnet: 'Sonnet limit',
  overage: 'extra usage limit',
}

export function getRateLimitDisplayName(type: RateLimitType): string {
  return RATE_LIMIT_DISPLAY_NAMES[type] || type
}

/**
 * 计算时间窗口已过去的比例。
 * 用于时间相对早期警告回退。
 * @param resetsAt - 限制重置时的 Unix epoch 时间戳（秒）
 * @param windowSeconds - 窗口持续时间（秒）
 * @returns 已过去的窗口比例（0-1）
 */
function computeTimeProgress(resetsAt: number, windowSeconds: number): number {
  const nowSeconds = Date.now() / 1000
  const windowStart = resetsAt - windowSeconds
  const elapsed = nowSeconds - windowStart
  return Math.max(0, Math.min(1, elapsed / windowSeconds))
}

// 超额用量被禁用/拒绝的原因
// 这些值来自 API 的统一限制器
export type OverageDisabledReason =
  | 'overage_not_provisioned' // 此组织或席位等级未配置超额用量
  | 'org_level_disabled' // 组织未启用超额用量
  | 'org_level_disabled_until' // 组织超额用量被临时禁用
  | 'out_of_credits' // 组织额度不足
  | 'seat_tier_level_disabled' // 席位等级未启用超额用量
  | 'member_level_disabled' // 此账号专门禁用了超额用量
  | 'seat_tier_zero_credit_limit' // 席位等级的额度限制为零
  | 'group_zero_credit_limit' // 解析后的组限制额度为零
  | 'member_zero_credit_limit' // 账号的额度限制为零
  | 'org_service_level_disabled' // 组织服务专门禁用了超额用量
  | 'org_service_zero_credit_limit' // 组织服务的额度限制为零
  | 'no_limits_configured' // 账号未配置超额用量限制
  | 'unknown' // 未知原因，不应发生

export type ClaudeAILimits = {
  status: QuotaStatus
  // unifiedRateLimitFallbackAvailable 目前用于警告将模型设置为 Opus 的用户
  // 他们即将耗尽配额。它不会更改实际使用的模型。
  unifiedRateLimitFallbackAvailable: boolean
  resetsAt?: number
  rateLimitType?: RateLimitType
  utilization?: number
  overageStatus?: QuotaStatus
  overageResetsAt?: number
  overageDisabledReason?: OverageDisabledReason
  isUsingOverage?: boolean
  surpassedThreshold?: number
}

// 仅供测试导出
export let currentLimits: ClaudeAILimits = {
  status: 'allowed',
  unifiedRateLimitFallbackAvailable: false,
  isUsingOverage: false,
}

/**
 * 来自响应头的每窗口原始用量，在每次 API 响应时跟踪
 * （不同于 currentLimits.utilization，后者仅在触发警告阈值时设置）。
 * 通过 getRawUtilization() 暴露给 statusline 脚本使用。
 */
type RawWindowUtilization = {
  utilization: number // 0-1 比例
  resets_at: number // Unix epoch 秒
}
type RawUtilization = {
  five_hour?: RawWindowUtilization
  seven_day?: RawWindowUtilization
}
let rawUtilization: RawUtilization = {}

export function getRawUtilization(): RawUtilization {
  return rawUtilization
}

function extractRawUtilization(headers: globalThis.Headers): RawUtilization {
  const result: RawUtilization = {}
  for (const [key, abbrev] of [
    ['five_hour', '5h'],
    ['seven_day', '7d'],
  ] as const) {
    const util = headers.get(
      `anthropic-ratelimit-unified-${abbrev}-utilization`,
    )
    const reset = headers.get(`anthropic-ratelimit-unified-${abbrev}-reset`)
    if (util !== null && reset !== null) {
      result[key] = { utilization: Number(util), resets_at: Number(reset) }
    }
  }
  return result
}

type StatusChangeListener = (limits: ClaudeAILimits) => void
export const statusListeners: Set<StatusChangeListener> = new Set()

export function emitStatusChange(limits: ClaudeAILimits) {
  currentLimits = limits
  statusListeners.forEach(listener => listener(limits))
  const hoursTillReset = Math.round(
    (limits.resetsAt ? limits.resetsAt - Date.now() / 1000 : 0) / (60 * 60),
  )

  logEvent('tengu_claudeai_limits_status_changed', {
    status:
      limits.status as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    unifiedRateLimitFallbackAvailable: limits.unifiedRateLimitFallbackAvailable,
    hoursTillReset,
  })
}

async function makeTestQuery() {
  const model = getSmallFastModel()
  const anthropic = await getAnthropicClient({
    maxRetries: 0,
    model,
    source: 'quota_check',
  })
  const messages: MessageParam[] = [{ role: 'user', content: 'quota' }]
  const betas = getModelBetas(model)
  return anthropic.beta.messages
    .create({
      model,
      max_tokens: 1,
      messages,
      metadata: getAPIMetadata(),
      ...(betas.length > 0 ? { betas } : {}),
    })
    .asResponse()
}

export async function checkQuotaStatus(): Promise<void> {
  // 如果非必要流量被禁用，跳过网络请求
  if (isEssentialTrafficOnly()) {
    return
  }

  // 检查是否应处理速率限制（真实订阅者或 mock 测试）
  if (!shouldProcessRateLimits(isClaudeAISubscriber())) {
    return
  }

  // 在非交互模式（-p）下，真实查询会立即跟随执行，
  // extractQuotaStatusFromHeaders() 会从其响应头更新限制
  // （claude.ts），因此跳过此预检查 API 调用。
  if (getIsNonInteractiveSession()) {
    return
  }

  try {
    // 发起最小请求以检查配额
    const raw = await makeTestQuery()

    // 根据响应更新限制
    extractQuotaStatusFromHeaders(raw.headers)
  } catch (error) {
    if (error instanceof APIError) {
      extractQuotaStatusFromError(error)
    }
  }
}

/**
 * 基于 surpassed-threshold header 检查是否应触发早期警告。
 * 如果超过阈值，返回 ClaudeAILimits；否则返回 null。
 */
function getHeaderBasedEarlyWarning(
  headers: globalThis.Headers,
  unifiedRateLimitFallbackAvailable: boolean,
): ClaudeAILimits | null {
  // 检查每种声明类型的 surpassed threshold header
  for (const [claimAbbrev, rateLimitType] of Object.entries(
    EARLY_WARNING_CLAIM_MAP,
  )) {
    const surpassedThreshold = headers.get(
      `anthropic-ratelimit-unified-${claimAbbrev}-surpassed-threshold`,
    )

    // 如果存在阈值 header，说明用户已跨越警告阈值
    if (surpassedThreshold !== null) {
      const utilizationHeader = headers.get(
        `anthropic-ratelimit-unified-${claimAbbrev}-utilization`,
      )
      const resetHeader = headers.get(
        `anthropic-ratelimit-unified-${claimAbbrev}-reset`,
      )

      const utilization = utilizationHeader
        ? Number(utilizationHeader)
        : undefined
      const resetsAt = resetHeader ? Number(resetHeader) : undefined

      return {
        status: 'allowed_warning',
        resetsAt,
        rateLimitType: rateLimitType as RateLimitType,
        utilization,
        unifiedRateLimitFallbackAvailable,
        isUsingOverage: false,
        surpassedThreshold: Number(surpassedThreshold),
      }
    }
  }

  return null
}

/**
 * 检查对某种速率限制类型是否应触发时间相对早期警告。
 * 当服务器不发送 surpassed-threshold header 时作为回退方案。
 * 如果超过阈值，返回 ClaudeAILimits；否则返回 null。
 */
function getTimeRelativeEarlyWarning(
  headers: globalThis.Headers,
  config: EarlyWarningConfig,
  unifiedRateLimitFallbackAvailable: boolean,
): ClaudeAILimits | null {
  const { rateLimitType, claimAbbrev, windowSeconds, thresholds } = config

  const utilizationHeader = headers.get(
    `anthropic-ratelimit-unified-${claimAbbrev}-utilization`,
  )
  const resetHeader = headers.get(
    `anthropic-ratelimit-unified-${claimAbbrev}-reset`,
  )

  if (utilizationHeader === null || resetHeader === null) {
    return null
  }

  const utilization = Number(utilizationHeader)
  const resetsAt = Number(resetHeader)
  const timeProgress = computeTimeProgress(resetsAt, windowSeconds)

  // 检查是否超过任何阈值：窗口早期用量高
  const shouldWarn = thresholds.some(
    t => utilization >= t.utilization && timeProgress <= t.timePct,
  )

  if (!shouldWarn) {
    return null
  }

  return {
    status: 'allowed_warning',
    resetsAt,
    rateLimitType,
    utilization,
    unifiedRateLimitFallbackAvailable,
    isUsingOverage: false,
  }
}

/**
 * 使用基于 header 的检测加时间相对回退获取早期警告限制。
 * 1. 首先检查 surpassed-threshold header（新的服务端方案）
 * 2. 回退到时间相对阈值（客户端计算）
 */
function getEarlyWarningFromHeaders(
  headers: globalThis.Headers,
  unifiedRateLimitFallbackAvailable: boolean,
): ClaudeAILimits | null {
  // 先尝试基于 header 的检测（当 API 发送 header 时优先使用）
  const headerBasedWarning = getHeaderBasedEarlyWarning(
    headers,
    unifiedRateLimitFallbackAvailable,
  )
  if (headerBasedWarning) {
    return headerBasedWarning
  }

  // 回退：使用时间相对阈值（客户端计算）
  // 这可以捕获比可持续速度更快消耗配额的用户
  for (const config of EARLY_WARNING_CONFIGS) {
    const timeRelativeWarning = getTimeRelativeEarlyWarning(
      headers,
      config,
      unifiedRateLimitFallbackAvailable,
    )
    if (timeRelativeWarning) {
      return timeRelativeWarning
    }
  }

  return null
}

function computeNewLimitsFromHeaders(
  headers: globalThis.Headers,
): ClaudeAILimits {
  const status =
    (headers.get('anthropic-ratelimit-unified-status') as QuotaStatus) ||
    'allowed'
  const resetsAtHeader = headers.get('anthropic-ratelimit-unified-reset')
  const resetsAt = resetsAtHeader ? Number(resetsAtHeader) : undefined
  const unifiedRateLimitFallbackAvailable =
    headers.get('anthropic-ratelimit-unified-fallback') === 'available'

  // 速率限制类型和超额用量支持的 header
  const rateLimitType = headers.get(
    'anthropic-ratelimit-unified-representative-claim',
  ) as RateLimitType | null
  const overageStatus = headers.get(
    'anthropic-ratelimit-unified-overage-status',
  ) as QuotaStatus | null
  const overageResetsAtHeader = headers.get(
    'anthropic-ratelimit-unified-overage-reset',
  )
  const overageResetsAt = overageResetsAtHeader
    ? Number(overageResetsAtHeader)
    : undefined

  // 超额用量被禁用的原因（消费上限或钱包为空）
  const overageDisabledReason = headers.get(
    'anthropic-ratelimit-unified-overage-disabled-reason',
  ) as OverageDisabledReason | null

  // 判断是否正在使用超额用量（标准限制被拒绝但超额用量被允许）
  const isUsingOverage =
    status === 'rejected' &&
    (overageStatus === 'allowed' || overageStatus === 'allowed_warning')

  // 基于 surpassed-threshold header 检查早期警告
  // 如果状态是 allowed/allowed_warning 且我们找到超过的阈值，显示警告
  let finalStatus: QuotaStatus = status
  if (status === 'allowed' || status === 'allowed_warning') {
    const earlyWarning = getEarlyWarningFromHeaders(
      headers,
      unifiedRateLimitFallbackAvailable,
    )
    if (earlyWarning) {
      return earlyWarning
    }
    // 没有超过早期警告阈值
    finalStatus = 'allowed'
  }

  return {
    status: finalStatus,
    resetsAt,
    unifiedRateLimitFallbackAvailable,
    ...(rateLimitType && { rateLimitType }),
    ...(overageStatus && { overageStatus }),
    ...(overageResetsAt && { overageResetsAt }),
    ...(overageDisabledReason && { overageDisabledReason }),
    isUsingOverage,
  }
}

/**
 * 缓存来自 API header 的额外用量禁用原因。
 */
function cacheExtraUsageDisabledReason(headers: globalThis.Headers): void {
  // null 原因意味着额外用量已启用（无禁用原因 header）
  const reason =
    headers.get('anthropic-ratelimit-unified-overage-disabled-reason') ?? null
  const cached = getGlobalConfig().cachedExtraUsageDisabledReason
  if (cached !== reason) {
    saveGlobalConfig(current => ({
      ...current,
      cachedExtraUsageDisabledReason: reason,
    }))
  }
}

export function extractQuotaStatusFromHeaders(
  headers: globalThis.Headers,
): void {
  // 检查是否需要处理速率限制
  const isSubscriber = isClaudeAISubscriber()

  if (!shouldProcessRateLimits(isSubscriber)) {
    // 如果有任何速率限制状态，清除它
    rawUtilization = {}
    updateProviderBuckets('anthropic', [])
    if (currentLimits.status !== 'allowed' || currentLimits.resetsAt) {
      const defaultLimits: ClaudeAILimits = {
        status: 'allowed',
        unifiedRateLimitFallbackAvailable: false,
        isUsingOverage: false,
      }
      emitStatusChange(defaultLimits)
    }
    return
  }

  // 处理 header（如果激活 /mock-limits 命令则应用 mock）
  const headersToUse = processRateLimitHeaders(headers)
  rawUtilization = extractRawUtilization(headersToUse)
  updateProviderBuckets(
    'anthropic',
    anthropicAdapter.parseHeaders(headersToUse),
  )
  const newLimits = computeNewLimitsFromHeaders(headersToUse)

  // 缓存额外用量状态（跨会话持久化）
  cacheExtraUsageDisabledReason(headersToUse)

  if (!isEqual(currentLimits, newLimits)) {
    emitStatusChange(newLimits)
  }
}

export function extractQuotaStatusFromError(error: APIError): void {
  if (
    !shouldProcessRateLimits(isClaudeAISubscriber()) ||
    error.status !== 429
  ) {
    return
  }

  try {
    let newLimits = { ...currentLimits }
    if (error.headers) {
      // 处理 header（如果激活 /mock-limits 命令则应用 mock）
      const headersToUse = processRateLimitHeaders(error.headers)
      rawUtilization = extractRawUtilization(headersToUse)
      updateProviderBuckets(
        'anthropic',
        anthropicAdapter.parseHeaders(headersToUse),
      )
      newLimits = computeNewLimitsFromHeaders(headersToUse)

      // 缓存额外用量状态（跨会话持久化）
      cacheExtraUsageDisabledReason(headersToUse)
    }
    // 对于错误，即使 header 不存在也总是将状态设置为 rejected。
    newLimits.status = 'rejected'

    if (!isEqual(currentLimits, newLimits)) {
      emitStatusChange(newLimits)
    }
  } catch (e) {
    logError(e as Error)
  }
}
