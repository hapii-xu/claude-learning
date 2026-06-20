import { logEvent } from '../services/analytics/index.js'
import { logForDebugging } from '../utils/debug.js'
import { logForDiagnosticsNoPII } from '../utils/diagLogs.js'
import { errorMessage } from '../utils/errors.js'
import { jsonParse } from '../utils/slowOperations.js'

/** 把毫秒时长格式化成易读字符串（例如 "5m 30s"）。 */
function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return s > 0 ? `${m}m ${s}s` : `${m}m`
}

/**
 * 不校验签名地解码 JWT 的 payload 段。
 * 如果存在 `sk-ant-si-` session-ingress 前缀，会先剥离。
 * 返回解析后的 JSON payload（类型为 `unknown`）；若 token 格式错误或
 * payload 不是合法 JSON，则返回 `null`。
 */
export function decodeJwtPayload(token: string): unknown | null {
  const jwt = token.startsWith('sk-ant-si-')
    ? token.slice('sk-ant-si-'.length)
    : token
  const parts = jwt.split('.')
  if (parts.length !== 3 || !parts[1]) return null
  try {
    return jsonParse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

/**
 * 不校验签名地从 JWT 中解码 `exp`（过期时间）claim。
 * @returns 以 Unix 秒为单位的 `exp` 值；无法解析时返回 `null`
 */
export function decodeJwtExpiry(token: string): number | null {
  const payload = decodeJwtPayload(token)
  if (
    payload !== null &&
    typeof payload === 'object' &&
    'exp' in payload &&
    typeof payload.exp === 'number'
  ) {
    return payload.exp
  }
  return null
}

/** 刷新缓冲：在过期之前请求一个新 token。 */
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000

/** 新 token 过期时间未知时的兜底刷新间隔。 */
const FALLBACK_REFRESH_INTERVAL_MS = 30 * 60 * 1000 // 30 分钟

/** 放弃刷新链之前的最大连续失败次数。 */
const MAX_REFRESH_FAILURES = 3

/** getAccessToken 返回 undefined 时的重试延迟。 */
const REFRESH_RETRY_DELAY_MS = 60_000

/**
 * 创建一个 token 刷新调度器，在 session token 过期前主动刷新。
 * 同时被 standalone bridge 和 REPL bridge 使用。
 *
 * token 即将过期时，调度器会用 session ID 和 bridge 的 OAuth access
 * token 调用 `onRefresh`。调用方负责把 token 投递到正确的 transport
 *（standalone bridge 投递到子进程 stdin，REPL bridge 通过 WebSocket
 * 重连投递）。
 */
export function createTokenRefreshScheduler({
  getAccessToken,
  onRefresh,
  label,
  refreshBufferMs = TOKEN_REFRESH_BUFFER_MS,
}: {
  getAccessToken: () => string | undefined | Promise<string | undefined>
  onRefresh: (sessionId: string, oauthToken: string) => void
  label: string
  /** 距离过期多久开始触发刷新。默认 5 分钟。 */
  refreshBufferMs?: number
}): {
  schedule: (sessionId: string, token: string) => void
  scheduleFromExpiresIn: (sessionId: string, expiresInSeconds: number) => void
  cancel: (sessionId: string) => void
  cancelAll: () => void
} {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const failureCounts = new Map<string, number>()
  // 每个 session 一个 generation 计数 —— schedule() 和 cancel() 会自增，
  // 这样在途的 async doRefresh() 调用能检测到自己已被取代，
  // 应当跳过设置后续 timer。
  const generations = new Map<string, number>()

  function nextGeneration(sessionId: string): number {
    const gen = (generations.get(sessionId) ?? 0) + 1
    generations.set(sessionId, gen)
    return gen
  }

  function schedule(sessionId: string, token: string): void {
    const expiry = decodeJwtExpiry(token)
    if (!expiry) {
      // token 不是可解码的 JWT（例如从 REPL bridge WebSocket 打开处理
      // 里传来的 OAuth token）。保留任何已有的 timer（例如 doRefresh
      // 设置的后续刷新），避免刷新链中断。
      logForDebugging(
        `[${label}:token] Could not decode JWT expiry for sessionId=${sessionId}, token prefix=${token.slice(0, 15)}…, keeping existing timer`,
      )
      return
    }

    // 清掉已有的刷新 timer —— 我们现在有具体的过期时间来替换它。
    const existing = timers.get(sessionId)
    if (existing) {
      clearTimeout(existing)
    }

    // 自增 generation 让在途的 async doRefresh 失效。
    const gen = nextGeneration(sessionId)

    const expiryDate = new Date(expiry * 1000).toISOString()
    const delayMs = expiry * 1000 - Date.now() - refreshBufferMs
    if (delayMs <= 0) {
      logForDebugging(
        `[${label}:token] Token for sessionId=${sessionId} expires=${expiryDate} (past or within buffer), refreshing immediately`,
      )
      void doRefresh(sessionId, gen)
      return
    }

    logForDebugging(
      `[${label}:token] Scheduled token refresh for sessionId=${sessionId} in ${formatDuration(delayMs)} (expires=${expiryDate}, buffer=${refreshBufferMs / 1000}s)`,
    )

    const timer = setTimeout(doRefresh, delayMs, sessionId, gen)
    timers.set(sessionId, timer)
  }

  /**
   * 用显式 TTL（距离过期的秒数）调度刷新，而不是解码 JWT 的 exp claim。
   * 用于 JWT 不透明的调用方（例如 POST /v1/code/sessions/{id}/bridge
   * 直接返回 expires_in）。
   */
  function scheduleFromExpiresIn(
    sessionId: string,
    expiresInSeconds: number,
  ): void {
    const existing = timers.get(sessionId)
    if (existing) clearTimeout(existing)
    const gen = nextGeneration(sessionId)
    // 钳制到 30s 下限 —— 如果 refreshBufferMs 超过了服务器的 expires_in
    //（例如高频刷新测试用到了超大 buffer，或服务器意外缩短了 expires_in），
    // 不钳制会让 delayMs ≤ 0，触发紧密循环。
    const delayMs = Math.max(expiresInSeconds * 1000 - refreshBufferMs, 30_000)
    logForDebugging(
      `[${label}:token] Scheduled token refresh for sessionId=${sessionId} in ${formatDuration(delayMs)} (expires_in=${expiresInSeconds}s, buffer=${refreshBufferMs / 1000}s)`,
    )
    const timer = setTimeout(doRefresh, delayMs, sessionId, gen)
    timers.set(sessionId, timer)
  }

  async function doRefresh(sessionId: string, gen: number): Promise<void> {
    let oauthToken: string | undefined
    try {
      oauthToken = await getAccessToken()
    } catch (err) {
      logForDebugging(
        `[${label}:token] getAccessToken threw for sessionId=${sessionId}: ${errorMessage(err)}`,
        { level: 'error' },
      )
    }

    // 如果在 await 期间 session 被取消或重排，generation 会变 ——
    // 直接退出避免遗留 timer。
    if (generations.get(sessionId) !== gen) {
      logForDebugging(
        `[${label}:token] doRefresh for sessionId=${sessionId} stale (gen ${gen} vs ${generations.get(sessionId)}), skipping`,
      )
      return
    }

    if (!oauthToken) {
      const failures = (failureCounts.get(sessionId) ?? 0) + 1
      failureCounts.set(sessionId, failures)
      logForDebugging(
        `[${label}:token] No OAuth token available for refresh, sessionId=${sessionId} (failure ${failures}/${MAX_REFRESH_FAILURES})`,
        { level: 'error' },
      )
      logForDiagnosticsNoPII('error', 'bridge_token_refresh_no_oauth')
      // 安排一次重试，让刷新链在 token 重新可用时（例如刷新期间临时
      // 清缓存）能恢复。重试次数有上限，避免在真实失败场景下刷屏。
      if (failures < MAX_REFRESH_FAILURES) {
        const retryTimer = setTimeout(
          doRefresh,
          REFRESH_RETRY_DELAY_MS,
          sessionId,
          gen,
        )
        timers.set(sessionId, retryTimer)
      }
      return
    }

    // 成功取到 token 后重置失败计数
    failureCounts.delete(sessionId)

    logForDebugging(
      `[${label}:token] Refreshing token for sessionId=${sessionId}: new token prefix=${oauthToken.slice(0, 15)}…`,
    )
    logEvent('tengu_bridge_token_refreshed', {})
    onRefresh(sessionId, oauthToken)

    // 安排一次后续刷新，让长运行 session 保持认证。
    // 不做这一步的话，一次性 timer 会让 session 在跑过第一个刷新窗口后
    // 暴露在 token 过期风险里。
    const timer = setTimeout(
      doRefresh,
      FALLBACK_REFRESH_INTERVAL_MS,
      sessionId,
      gen,
    )
    timers.set(sessionId, timer)
    logForDebugging(
      `[${label}:token] Scheduled follow-up refresh for sessionId=${sessionId} in ${formatDuration(FALLBACK_REFRESH_INTERVAL_MS)}`,
    )
  }

  function cancel(sessionId: string): void {
    // 自增 generation 让在途的 async doRefresh 失效。
    nextGeneration(sessionId)
    const timer = timers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      timers.delete(sessionId)
    }
    failureCounts.delete(sessionId)
  }

  function cancelAll(): void {
    // 把所有 generation 自增，让在途的 doRefresh 调用失效。
    for (const sessionId of generations.keys()) {
      nextGeneration(sessionId)
    }
    for (const timer of timers.values()) {
      clearTimeout(timer)
    }
    timers.clear()
    failureCounts.clear()
  }

  return { schedule, scheduleFromExpiresIn, cancel, cancelAll }
}
