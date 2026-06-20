import axios from 'axios'
import memoize from 'lodash-es/memoize.js'
import { hostname } from 'os'
import { getOauthConfig } from '../constants/oauth.js'
import {
  checkGate_CACHED_OR_BLOCKING,
  getFeatureValue_CACHED_MAY_BE_STALE,
} from '../services/analytics/growthbook.js'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import { isEssentialTrafficOnly } from '../utils/privacyLevel.js'
import { getSecureStorage } from '../utils/secureStorage/index.js'
import { jsonStringify } from '../utils/slowOperations.js'

/**
 * bridge（remote-control）session 的 trusted device token 来源。
 *
 * bridge session 在服务器侧（CCR v2）SecurityTier=ELEVATED。服务器用自己
 * 的 flag（Anthropic Main 中的 sessions_elevated_auth_enforcement）来
 * 守卫 ConnectBridgeWorker；这个 CLI 侧的 flag 控制的是 CLI 是否真的
 * 发送 X-Trusted-Device-Token。两个 flag 让灰度可以分阶段：先翻 CLI 侧
 *（header 开始往外发，服务器侧仍是 no-op），再翻服务器侧。
 *
 * Enrollment（POST /auth/trusted_devices）服务器侧用
 * account_session.created_at < 10min 限制，所以必须在 /login 期间完成。
 * token 是持久的（90 天滚动过期），存放在 keychain 里。
 *
 * 参见 anthropics/anthropic#274559（spec）、#310375（B1b 租户 RPC）、
 * #295987（B2 Python 路由）、#307150（C1' CCR v2 gate）。
 */

const TRUSTED_DEVICE_GATE = 'tengu_sessions_elevated_auth_enforcement'

function isGateEnabled(): boolean {
  return getFeatureValue_CACHED_MAY_BE_STALE(TRUSTED_DEVICE_GATE, false)
}

// memoize —— secureStorage.read() 会 spawn 一个 macOS `security` 子进程
//（约 40ms）。bridgeApi.ts 每次 poll/heartbeat/ack 都会从 getHeaders()
// 里调到这里。enrollment（下方）后和登出（clearAuthRelatedCaches）时会
// 清缓存。
//
// 只有 storage 读取被 memoize —— GrowthBook gate 每次实时检查，保证
// GrowthBook 刷新后翻转的 gate 不用重启就生效。
const readStoredToken = memoize((): string | undefined => {
  // 测试 / canary 场景下，env 变量优先。
  const envToken = process.env.CLAUDE_TRUSTED_DEVICE_TOKEN
  if (envToken) {
    return envToken
  }
  return getSecureStorage().read()?.trustedDeviceToken
})

export function getTrustedDeviceToken(): string | undefined {
  if (!isGateEnabled()) {
    return undefined
  }
  return readStoredToken()
}

export function clearTrustedDeviceTokenCache(): void {
  readStoredToken.cache?.clear?.()
}

/**
 * 从 secure storage 和 memo 缓存中清掉存储的 trusted device token。
 * 在 /login 期间、enrollTrustedDevice() 之前调用，避免上一个账号的陈旧
 * token 在 enrollment 还在飞的期间作为 X-Trusted-Device-Token 发出去
 *（enrollTrustedDevice 是异步的 —— login 到 enrollment 完成之间发出的
 * bridge API 调用，否则会读到旧缓存里的 token）。
 */
export function clearTrustedDeviceToken(): void {
  if (!isGateEnabled()) {
    return
  }
  const secureStorage = getSecureStorage()
  try {
    const data = secureStorage.read()
    if (data?.trustedDeviceToken) {
      delete data.trustedDeviceToken
      secureStorage.update(data)
    }
  } catch {
    // best-effort —— storage 不可访问时不要阻塞 login
  }
  readStoredToken.cache?.clear?.()
}

/**
 * 通过 POST /auth/trusted_devices 注册本机并把 token 持久化到 keychain。
 * best-effort —— 失败时记录日志并返回，让调用方（post-login 钩子）不会
 * 卡住 login 流程。
 *
 * 服务器用 account_session.created_at < 10min 作为 enrollment 的闸门，
 * 所以必须在一次全新 /login 之后立刻调用。延后调用（比如在 /bridge 403
 * 时 lazy enroll）会得到 403 stale_session。
 */
export async function enrollTrustedDevice(): Promise<void> {
  try {
    // checkGate_CACHED_OR_BLOCKING 会先等任何进行中的 GrowthBook 重新
    // 初始化（login.tsx 中 refreshGrowthBookAfterAuthChange 触发），再读
    // gate，所以我们拿到的是刷新后的值。
    if (!(await checkGate_CACHED_OR_BLOCKING(TRUSTED_DEVICE_GATE))) {
      logForDebugging(
        `[trusted-device] Gate ${TRUSTED_DEVICE_GATE} is off, skipping enrollment`,
      )
      return
    }
    // 如果设置了 CLAUDE_TRUSTED_DEVICE_TOKEN（例如企业包装脚本），跳过
    // enrollment —— env 变量在 readStoredToken() 里优先级更高，enroll
    // 出来的 token 会被它遮蔽、永远用不上。
    if (process.env.CLAUDE_TRUSTED_DEVICE_TOKEN) {
      logForDebugging(
        '[trusted-device] CLAUDE_TRUSTED_DEVICE_TOKEN env var is set, skipping enrollment (env var takes precedence)',
      )
      return
    }
    // 懒加载 require —— utils/auth.ts 会传递性地拉进约 1300 个模块
    //（config → file → permissions → sessionStorage → commands）。调用
    // getTrustedDeviceToken() 的 daemon 调用方不需要它，只有 /login 需要。
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { getClaudeAIOAuthTokens } =
      require('../utils/auth.js') as typeof import('../utils/auth.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    const accessToken = getClaudeAIOAuthTokens()?.accessToken
    if (!accessToken) {
      logForDebugging('[trusted-device] No OAuth token, skipping enrollment')
      return
    }
    // /login 时永远重新 enroll —— 现存 token 可能属于另一个账号
    //（未 /logout 就切换账号）。跳过 enrollment 会在新账号的 bridge 调用
    // 上发出旧账号的 token。
    const secureStorage = getSecureStorage()

    if (isEssentialTrafficOnly()) {
      logForDebugging(
        '[trusted-device] Essential traffic only, skipping enrollment',
      )
      return
    }

    const baseUrl = getOauthConfig().BASE_API_URL
    let response
    try {
      response = await axios.post<{
        device_token?: string
        device_id?: string
      }>(
        `${baseUrl}/api/auth/trusted_devices`,
        { display_name: `Claude Code on ${hostname()} · ${process.platform}` },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          timeout: 10_000,
          validateStatus: s => s < 500,
        },
      )
    } catch (err: unknown) {
      logForDebugging(
        `[trusted-device] Enrollment request failed: ${errorMessage(err)}`,
      )
      return
    }

    if (response.status !== 200 && response.status !== 201) {
      logForDebugging(
        `[trusted-device] Enrollment failed ${response.status}: ${jsonStringify(response.data).slice(0, 200)}`,
      )
      return
    }

    const token = response.data?.device_token
    if (!token || typeof token !== 'string') {
      logForDebugging(
        '[trusted-device] Enrollment response missing device_token field',
      )
      return
    }

    try {
      const storageData = secureStorage.read()
      if (!storageData) {
        logForDebugging(
          '[trusted-device] Cannot read storage, skipping token persist',
        )
        return
      }
      storageData.trustedDeviceToken = token
      const result = secureStorage.update(storageData)
      if (!result.success) {
        logForDebugging(
          `[trusted-device] Failed to persist token: ${result.warning ?? 'unknown'}`,
        )
        return
      }
      readStoredToken.cache?.clear?.()
      logForDebugging(
        `[trusted-device] Enrolled device_id=${response.data.device_id ?? 'unknown'}`,
      )
    } catch (err: unknown) {
      logForDebugging(
        `[trusted-device] Storage write failed: ${errorMessage(err)}`,
      )
    }
  } catch (err: unknown) {
    logForDebugging(`[trusted-device] Enrollment error: ${errorMessage(err)}`)
  }
}
