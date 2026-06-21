/**
 * 会话活动跟踪，基于引用计数的心跳计时器。
 *
 * 传输层通过 registerSessionActivityCallback() 注册其保活发送器。
 * 调用方（API 流式传输、工具执行）通过 startSessionActivity() /
 * stopSessionActivity() 包裹其工作。当引用计数 >0 时，周期性计时器
 * 每 30 秒触发已注册的回调以保持容器活跃。
 *
 * 发送保活信号受 CLAUDE_CODE_REMOTE_SEND_KEEPALIVES 门控。
 * 诊断日志始终触发以帮助诊断空闲间隔。
 */

import { registerCleanup } from './cleanupRegistry.js'
import { logForDiagnosticsNoPII } from './diagLogs.js'
import { isEnvTruthy } from './envUtils.js'

const SESSION_ACTIVITY_INTERVAL_MS = 30_000

export type SessionActivityReason = 'api_call' | 'tool_exec'

let activityCallback: (() => void) | null = null
let refcount = 0
const activeReasons = new Map<SessionActivityReason, number>()
let oldestActivityStartedAt: number | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null
let cleanupRegistered = false

function startHeartbeatTimer(): void {
  clearIdleTimer()
  heartbeatTimer = setInterval(() => {
    logForDiagnosticsNoPII('debug', 'session_keepalive_heartbeat', {
      refcount,
    })
    if (isEnvTruthy(process.env.CLAUDE_CODE_REMOTE_SEND_KEEPALIVES)) {
      activityCallback?.()
    }
  }, SESSION_ACTIVITY_INTERVAL_MS)
}

function startIdleTimer(): void {
  clearIdleTimer()
  if (activityCallback === null) {
    return
  }
  idleTimer = setTimeout(() => {
    logForDiagnosticsNoPII('info', 'session_idle_30s')
    idleTimer = null
  }, SESSION_ACTIVITY_INTERVAL_MS)
}

function clearIdleTimer(): void {
  if (idleTimer !== null) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
}

export function registerSessionActivityCallback(cb: () => void): void {
  activityCallback = cb
  // 如果工作已在进行中，则重启计时器（例如，流式传输期间重连）
  if (refcount > 0 && heartbeatTimer === null) {
    startHeartbeatTimer()
  }
}

export function unregisterSessionActivityCallback(): void {
  activityCallback = null
  // 如果回调被移除，则停止计时器
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
  clearIdleTimer()
}

export function sendSessionActivitySignal(): void {
  if (isEnvTruthy(process.env.CLAUDE_CODE_REMOTE_SEND_KEEPALIVES)) {
    activityCallback?.()
  }
}

export function isSessionActivityTrackingActive(): boolean {
  return activityCallback !== null
}

/**
 * 递增活动引用计数。当从 0→1 转换且已注册回调时，
 * 启动周期性心跳计时器。
 */
export function startSessionActivity(reason: SessionActivityReason): void {
  refcount++
  activeReasons.set(reason, (activeReasons.get(reason) ?? 0) + 1)
  if (refcount === 1) {
    oldestActivityStartedAt = Date.now()
    if (activityCallback !== null && heartbeatTimer === null) {
      startHeartbeatTimer()
    }
  }
  if (!cleanupRegistered) {
    cleanupRegistered = true
    registerCleanup(async () => {
      logForDiagnosticsNoPII('info', 'session_activity_at_shutdown', {
        refcount,
        active: Object.fromEntries(activeReasons),
        // 仅在工作进行中时有意义；否则为陈旧数据
        oldest_activity_ms:
          refcount > 0 && oldestActivityStartedAt !== null
            ? Date.now() - oldestActivityStartedAt
            : null,
      })
    })
  }
}

/**
 * 递减活动引用计数。当达到 0 时，停止心跳计时器
 * 并启动空闲计时器，在 30 秒不活动后记录日志。
 */
export function stopSessionActivity(reason: SessionActivityReason): void {
  if (refcount > 0) {
    refcount--
  }
  const n = (activeReasons.get(reason) ?? 0) - 1
  if (n > 0) activeReasons.set(reason, n)
  else activeReasons.delete(reason)
  if (refcount === 0 && heartbeatTimer !== null) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
    startIdleTimer()
  }
}
