import axios from 'axios'
import { getOauthConfig, OAUTH_BETA_HEADER } from 'src/constants/oauth.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import {
  getIsNonInteractiveSession,
  getKairosActive,
  preferThirdPartyAuthentication,
} from '../bootstrap/state.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import {
  getAnthropicApiKey,
  getClaudeAIOAuthTokens,
  handleOAuth401Error,
  hasProfileScope,
} from './auth.js'
import { isInBundledMode } from './bundledMode.js'
import { getGlobalConfig, saveGlobalConfig } from './config.js'
import { logForDebugging } from './debug.js'
import { isEnvTruthy } from './envUtils.js'
import {
  getDefaultMainLoopModelSetting,
  isOpus1mMergeEnabled,
  type ModelSetting,
  parseUserSpecifiedModel,
} from './model/model.js'
import { getAPIProvider } from './model/providers.js'
import { isEssentialTrafficOnly } from './privacyLevel.js'
import {
  getInitialSettings,
  getSettingsForSource,
  updateSettingsForSource,
} from './settings/settings.js'
import { createSignal } from './signal.js'

export function isFastModeEnabled(): boolean {
  return !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_FAST_MODE)
}

export function isFastModeAvailable(): boolean {
  if (!isFastModeEnabled()) {
    return false
  }
  return getFastModeUnavailableReason() === null
}

type AuthType = 'oauth' | 'api-key'

function getDisabledReasonMessage(
  disabledReason: FastModeDisabledReason,
  authType: AuthType,
): string {
  switch (disabledReason) {
    case 'free':
      return authType === 'oauth'
        ? 'Fast mode requires a paid subscription'
        : 'Fast mode unavailable during evaluation. Please purchase credits.'
    case 'preference':
      return 'Fast mode has been disabled by your organization'
    case 'extra_usage_disabled':
      // 仅 OAuth 用户会出现 extra_usage_disabled；控制台用户不存在此概念
      return 'Fast mode requires extra usage billing · /extra-usage to enable'
    case 'network_error':
      return 'Fast mode unavailable due to network connectivity issues'
    case 'unknown':
      return 'Fast mode is currently unavailable'
  }
}

export function getFastModeUnavailableReason(): string | null {
  if (!isFastModeEnabled()) {
    return 'Fast mode is not available'
  }

  const statigReason = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_penguins_off',
    null,
  )
  // Statsig 原因优先于其他原因。
  if (statigReason !== null) {
    logForDebugging(`Fast mode unavailable: ${statigReason}`)
    return statigReason
  }

  // 此前 fast mode 需要原生二进制（bun build）。现已不再
  // 需要，但我们仍保留此选项作为标志，以防万一。
  if (
    !isInBundledMode() &&
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_marble_sandcastle', false)
  ) {
    return 'Fast mode requires the native binary · Install from: https://claude.com/product/claude-code'
  }

  // SDK 中不可用，除非通过 --settings 显式开启。
  // Assistant daemon 模式例外 — 它是第一方编排，且
  // kairosActive 在此检查运行前已设置（main.tsx:~1626 vs ~3249）。
  if (
    getIsNonInteractiveSession() &&
    preferThirdPartyAuthentication() &&
    !getKairosActive()
  ) {
    const flagFastMode = getSettingsForSource('flagSettings')?.fastMode
    if (!flagFastMode) {
      const reason = 'Fast mode is not available in the Agent SDK'
      logForDebugging(`Fast mode unavailable: ${reason}`)
      return reason
    }
  }

  // 仅 1P 可用（不支持 Bedrock/Vertex/Foundry）
  if (getAPIProvider() !== 'firstParty') {
    const reason = 'Fast mode is not available on Bedrock, Vertex, or Foundry'
    logForDebugging(`Fast mode unavailable: ${reason}`)
    return reason
  }

  if (orgStatus.status === 'disabled') {
    if (
      orgStatus.reason === 'network_error' ||
      orgStatus.reason === 'unknown'
    ) {
      // 组织检查在企业代理阻止端点时可能失败。我们添加了
      // CLAUDE_CODE_SKIP_FAST_MODE_NETWORK_ERRORS=1 以在 CC 二进制中
      // 绕过此检查。这是可行的，因为当被组织禁用时，
      // 我们在 API 中有另一个检查会报错。
      if (isEnvTruthy(process.env.CLAUDE_CODE_SKIP_FAST_MODE_NETWORK_ERRORS)) {
        return null
      }
    }
    const authType: AuthType =
      getClaudeAIOAuthTokens() !== null ? 'oauth' : 'api-key'
    const reason = getDisabledReasonMessage(orgStatus.reason, authType)
    logForDebugging(`Fast mode unavailable: ${reason}`)
    return reason
  }

  return null
}

// @[MODEL LAUNCH]: 更新受支持的 Fast Mode 模型。
export const FAST_MODE_MODEL_DISPLAY = 'Opus 4.7'

export function getFastModeModel(): string {
  return 'opus' + (isOpus1mMergeEnabled() ? '[1m]' : '')
}

export function getInitialFastModeSetting(model: ModelSetting): boolean {
  if (!isFastModeEnabled()) {
    return false
  }
  if (!isFastModeAvailable()) {
    return false
  }
  if (!isFastModeSupportedByModel(model)) {
    return false
  }
  const settings = getInitialSettings()
  // 若需要每会话开启，fast mode 在每个会话开始时关闭
  if (settings.fastModePerSessionOptIn) {
    return false
  }
  return settings.fastMode === true
}

export function isFastModeSupportedByModel(
  modelSetting: ModelSetting,
): boolean {
  if (!isFastModeEnabled()) {
    return false
  }
  const model = modelSetting ?? getDefaultMainLoopModelSetting()
  const parsedModel = parseUserSpecifiedModel(model)
  return (
    parsedModel.toLowerCase().includes('opus-4-7') ||
    parsedModel.toLowerCase().includes('opus-4-6')
  )
}

// --- Fast mode 运行时状态 ---
// 与用户偏好（settings.fastMode）分离。这跟踪实际
// 操作状态：我们是在积极发送 fast speed 还是在速率限制后
// 处于冷却中。

export type FastModeRuntimeState =
  | { status: 'active' }
  | { status: 'cooldown'; resetAt: number; reason: CooldownReason }

let runtimeState: FastModeRuntimeState = { status: 'active' }
let hasLoggedCooldownExpiry = false

// --- 冷却事件监听器 ---
export type CooldownReason = 'rate_limit' | 'overloaded'

const cooldownTriggered =
  createSignal<[resetAt: number, reason: CooldownReason]>()
const cooldownExpired = createSignal()
export const onCooldownTriggered = cooldownTriggered.subscribe
export const onCooldownExpired = cooldownExpired.subscribe

export function getFastModeRuntimeState(): FastModeRuntimeState {
  if (
    runtimeState.status === 'cooldown' &&
    Date.now() >= runtimeState.resetAt
  ) {
    if (isFastModeEnabled() && !hasLoggedCooldownExpiry) {
      logForDebugging('Fast mode cooldown expired, re-enabling fast mode')
      hasLoggedCooldownExpiry = true
      cooldownExpired.emit()
    }
    runtimeState = { status: 'active' }
  }
  return runtimeState
}

export function triggerFastModeCooldown(
  resetTimestamp: number,
  reason: CooldownReason,
): void {
  if (!isFastModeEnabled()) {
    return
  }
  runtimeState = { status: 'cooldown', resetAt: resetTimestamp, reason }
  hasLoggedCooldownExpiry = false
  const cooldownDurationMs = resetTimestamp - Date.now()
  logForDebugging(
    `Fast mode cooldown triggered (${reason}), duration ${Math.round(cooldownDurationMs / 1000)}s`,
  )
  logEvent('tengu_fast_mode_fallback_triggered', {
    cooldown_duration_ms: cooldownDurationMs,
    cooldown_reason:
      reason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
  cooldownTriggered.emit(resetTimestamp, reason)
}

export function clearFastModeCooldown(): void {
  runtimeState = { status: 'active' }
}

/**
 * 当 API 拒绝 fast mode 请求时调用（如 400 "Fast mode is
 * not enabled for your organization"）。使用与 prefetch 发现
 * 组织已禁用时相同的流程永久禁用 fast mode。
 */
export function handleFastModeRejectedByAPI(): void {
  if (orgStatus.status === 'disabled') {
    return
  }
  orgStatus = { status: 'disabled', reason: 'preference' }
  updateSettingsForSource('userSettings', { fastMode: undefined })
  saveGlobalConfig(current => ({
    ...current,
    penguinModeOrgEnabled: false,
  }))
  orgFastModeChange.emit(false)
}

// --- 超额拒绝监听器 ---
// 当 429 表示 fast mode 因 extra usage
// （超额计费）不可用而被拒绝时触发。与组织级禁用不同。
const overageRejection = createSignal<[message: string]>()
export const onFastModeOverageRejection = overageRejection.subscribe

function getOverageDisabledMessage(reason: string | null): string {
  switch (reason) {
    case 'out_of_credits':
      return 'Fast mode disabled · extra usage credits exhausted'
    case 'org_level_disabled':
    case 'org_service_level_disabled':
      return 'Fast mode disabled · extra usage disabled by your organization'
    case 'org_level_disabled_until':
      return 'Fast mode disabled · extra usage spending cap reached'
    case 'member_level_disabled':
      return 'Fast mode disabled · extra usage disabled for your account'
    case 'seat_tier_level_disabled':
    case 'seat_tier_zero_credit_limit':
    case 'member_zero_credit_limit':
      return 'Fast mode disabled · extra usage not available for your plan'
    case 'overage_not_provisioned':
    case 'no_limits_configured':
      return 'Fast mode requires extra usage billing · /extra-usage to enable'
    default:
      return 'Fast mode disabled · extra usage not available'
  }
}

function isOutOfCreditsReason(reason: string | null): boolean {
  return reason === 'org_level_disabled_until' || reason === 'out_of_credits'
}

/**
 * 当 429 表示 fast mode 因 extra usage 不可用而被拒绝时调用。
 * 永久禁用 fast mode（除非用户额度耗尽），并以原因特定的消息通知。
 */
export function handleFastModeOverageRejection(reason: string | null): void {
  const message = getOverageDisabledMessage(reason)
  logForDebugging(
    `Fast mode overage rejection: ${reason ?? 'unknown'} — ${message}`,
  )
  logEvent('tengu_fast_mode_overage_rejected', {
    overage_disabled_reason: (reason ??
      'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
  // 除非用户额度耗尽，否则永久禁用 fast mode
  if (!isOutOfCreditsReason(reason)) {
    updateSettingsForSource('userSettings', { fastMode: undefined })
    saveGlobalConfig(current => ({
      ...current,
      penguinModeOrgEnabled: false,
    }))
  }
  overageRejection.emit(message)
}

export function isFastModeCooldown(): boolean {
  return getFastModeRuntimeState().status === 'cooldown'
}

export function getFastModeState(
  model: ModelSetting,
  fastModeUserEnabled: boolean | undefined,
): 'off' | 'cooldown' | 'on' {
  const enabled =
    isFastModeEnabled() &&
    isFastModeAvailable() &&
    !!fastModeUserEnabled &&
    isFastModeSupportedByModel(model)
  if (enabled && isFastModeCooldown()) {
    return 'cooldown'
  }
  if (enabled) {
    return 'on'
  }
  return 'off'
}

// API 返回的禁用原因。API 是 fast mode 禁用原因的权威来源
// （免费账户、管理员偏好、未启用 extra usage）。
export type FastModeDisabledReason =
  | 'free'
  | 'preference'
  | 'extra_usage_disabled'
  | 'network_error'
  | 'unknown'

// 来自 API 的 fast mode 状态的内存缓存。
// 与用户的 fastMode app 状态不同 — 这表示
// 组织是否*允许* fast mode 以及可能被禁用的原因。
// 建模为可辨识联合，使无效状态
// （禁用而无原因）无法表示。
type FastModeOrgStatus =
  | { status: 'pending' }
  | { status: 'enabled' }
  | { status: 'disabled'; reason: FastModeDisabledReason }

let orgStatus: FastModeOrgStatus = { status: 'pending' }

// 当组织级 fast mode 状态变化时通知的监听器
const orgFastModeChange = createSignal<[orgEnabled: boolean]>()
export const onOrgFastModeChanged = orgFastModeChange.subscribe

type FastModeResponse = {
  enabled: boolean
  disabled_reason: FastModeDisabledReason | null
}

async function fetchFastModeStatus(
  auth: { accessToken: string } | { apiKey: string },
): Promise<FastModeResponse> {
  const endpoint = `${getOauthConfig().BASE_API_URL}/api/claude_code_penguin_mode`
  const headers: Record<string, string> =
    'accessToken' in auth
      ? {
          Authorization: `Bearer ${auth.accessToken}`,
          'anthropic-beta': OAUTH_BETA_HEADER,
        }
      : { 'x-api-key': auth.apiKey }

  const response = await axios.get<FastModeResponse>(endpoint, { headers })
  return response.data
}

const PREFETCH_MIN_INTERVAL_MS = 30_000
let lastPrefetchAt = 0
let inflightPrefetch: Promise<void> | null = null

/**
 * 从持久化缓存解析 orgStatus 而不发起任何 API 调用。
 * 用于启动 prefetch 被限流时，避免访问网络的同时
 * 让 fast mode 可用性检查正常工作。
 */
export function resolveFastModeStatusFromCache(): void {
  if (!isFastModeEnabled()) {
    return
  }
  if (orgStatus.status !== 'pending') {
    return
  }
  const isAnt = process.env.USER_TYPE === 'ant'
  const cachedEnabled = getGlobalConfig().penguinModeOrgEnabled === true
  orgStatus =
    isAnt || cachedEnabled
      ? { status: 'enabled' }
      : { status: 'disabled', reason: 'unknown' }
}

export async function prefetchFastModeStatus(): Promise<void> {
  // 若非必要流量已禁用，则跳过网络请求
  if (isEssentialTrafficOnly()) {
    return
  }

  if (!isFastModeEnabled()) {
    return
  }

  if (inflightPrefetch) {
    logForDebugging(
      'Fast mode prefetch in progress, returning in-flight promise',
    )
    return inflightPrefetch
  }

  // Service key OAuth 会话缺少 user:profile scope → 端点返回 403。
  // 在消耗限流窗口前从缓存解析 orgStatus 并退出。
  // API key 认证不受影响。
  const apiKey = getAnthropicApiKey()
  const hasUsableOAuth =
    getClaudeAIOAuthTokens()?.accessToken && hasProfileScope()
  if (!hasUsableOAuth && !apiKey) {
    const isAnt = process.env.USER_TYPE === 'ant'
    const cachedEnabled = getGlobalConfig().penguinModeOrgEnabled === true
    orgStatus =
      isAnt || cachedEnabled
        ? { status: 'enabled' }
        : { status: 'disabled', reason: 'preference' }
    return
  }

  const now = Date.now()
  if (now - lastPrefetchAt < PREFETCH_MIN_INTERVAL_MS) {
    logForDebugging('Skipping fast mode prefetch, fetched recently')
    return
  }
  lastPrefetchAt = now

  const fetchWithCurrentAuth = async (): Promise<FastModeResponse> => {
    const currentTokens = getClaudeAIOAuthTokens()
    const auth =
      currentTokens?.accessToken && hasProfileScope()
        ? { accessToken: currentTokens.accessToken }
        : apiKey
          ? { apiKey }
          : null
    if (!auth) {
      throw new Error('No auth available')
    }
    return fetchFastModeStatus(auth)
  }

  async function doFetch(): Promise<void> {
    try {
      let status: FastModeResponse
      try {
        status = await fetchWithCurrentAuth()
      } catch (err) {
        const isAuthError =
          axios.isAxiosError(err) &&
          (err.response?.status === 401 ||
            (err.response?.status === 403 &&
              typeof err.response?.data === 'string' &&
              err.response.data.includes('OAuth token has been revoked')))
        if (isAuthError) {
          const failedAccessToken = getClaudeAIOAuthTokens()?.accessToken
          if (failedAccessToken) {
            await handleOAuth401Error(failedAccessToken)
            status = await fetchWithCurrentAuth()
          } else {
            throw err
          }
        } else {
          throw err
        }
      }

      const previousEnabled =
        orgStatus.status !== 'pending'
          ? orgStatus.status === 'enabled'
          : getGlobalConfig().penguinModeOrgEnabled
      orgStatus = status.enabled
        ? { status: 'enabled' }
        : {
            status: 'disabled',
            reason: status.disabled_reason ?? 'preference',
          }
      if (previousEnabled !== status.enabled) {
        // 当组织禁用 fast mode 时，永久关闭用户的 fast mode 设置
        if (!status.enabled) {
          updateSettingsForSource('userSettings', { fastMode: undefined })
        }
        saveGlobalConfig(current => ({
          ...current,
          penguinModeOrgEnabled: status.enabled,
        }))
        orgFastModeChange.emit(status.enabled)
      }
      logForDebugging(
        `Org fast mode: ${status.enabled ? 'enabled' : `disabled (${status.disabled_reason ?? 'preference'})`}`,
      )
    } catch (err) {
      // 失败时：ant 默认启用（不阻塞内部用户）。
      // 外部用户：回退到缓存的 penguinModeOrgEnabled 值；
      // 若无正向缓存，则以 network_error 原因禁用。
      const isAnt = process.env.USER_TYPE === 'ant'
      const cachedEnabled = getGlobalConfig().penguinModeOrgEnabled === true
      orgStatus =
        isAnt || cachedEnabled
          ? { status: 'enabled' }
          : { status: 'disabled', reason: 'network_error' }
      logForDebugging(
        `Failed to fetch org fast mode status, defaulting to ${orgStatus.status === 'enabled' ? 'enabled (cached)' : 'disabled (network_error)'}: ${err}`,
        { level: 'error' },
      )
      logEvent('tengu_org_penguin_mode_fetch_failed', {})
    } finally {
      inflightPrefetch = null
    }
  }

  inflightPrefetch = doFetch()
  return inflightPrefetch
}
