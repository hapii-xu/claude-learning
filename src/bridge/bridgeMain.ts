import { feature } from 'bun:bundle'
import { randomUUID } from 'crypto'
import { hostname, tmpdir } from 'os'
import { basename, join, resolve } from 'path'
import { getRemoteSessionUrl } from '../constants/product.js'
import { shutdownDatadog } from '../services/analytics/datadog.js'
import { shutdown1PEventLogging } from '../services/analytics/firstPartyEventLogger.js'
import { checkGate_CACHED_OR_BLOCKING } from '../services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
  logEventAsync,
} from '../services/analytics/index.js'
import { getBootstrapArgs, getScriptPath } from '../utils/cliLaunch.js'
import { logForDebugging } from '../utils/debug.js'
import { rcLog } from './rcDebugLog.js'
import { logForDiagnosticsNoPII } from '../utils/diagLogs.js'
import { isEnvTruthy, isInProtectedNamespace } from '../utils/envUtils.js'
import { errorMessage } from '../utils/errors.js'
import { truncateToWidth } from '../utils/format.js'
import { logError } from '../utils/log.js'
import { sleep } from '../utils/sleep.js'
import { createAgentWorktree, removeAgentWorktree } from '../utils/worktree.js'
import {
  BridgeFatalError,
  createBridgeApiClient,
  isExpiredErrorType,
  isSuppressible403,
  validateBridgeId,
} from './bridgeApi.js'
import { formatDuration } from './bridgeStatusUtil.js'
import { createBridgeLogger } from './bridgeUI.js'
import { createCapacityWake } from './capacityWake.js'
import { describeAxiosError } from './debugUtils.js'
import { createTokenRefreshScheduler } from './jwtUtils.js'
import { getPollIntervalConfig } from './pollConfig.js'
import { toCompatSessionId, toInfraSessionId } from './sessionIdCompat.js'
import { createSessionSpawner, safeFilenameId } from './sessionRunner.js'
import { getTrustedDeviceToken } from './trustedDevice.js'
import {
  BRIDGE_LOGIN_ERROR,
  type BridgeApiClient,
  type BridgeConfig,
  type BridgeLogger,
  DEFAULT_SESSION_TIMEOUT_MS,
  type SessionDoneStatus,
  type SessionHandle,
  type SessionSpawner,
  type SessionSpawnOpts,
  type SpawnMode,
} from './types.js'
import {
  buildCCRv2SdkUrl,
  buildSdkUrl,
  decodeWorkSecret,
  registerWorker,
  sameSessionId,
} from './workSecret.js'

export type BackoffConfig = {
  connInitialMs: number
  connCapMs: number
  connGiveUpMs: number
  generalInitialMs: number
  generalCapMs: number
  generalGiveUpMs: number
  /** 关闭时的 SIGTERM→SIGKILL 宽限期。默认 30s。 */
  shutdownGraceMs?: number
  /** stopWorkWithRetry 的基础延迟（1s/2s/4s 指数退避）。默认 1000ms。 */
  stopWorkBaseDelayMs?: number
}

const DEFAULT_BACKOFF: BackoffConfig = {
  connInitialMs: 2_000,
  connCapMs: 120_000, // 2 分钟
  connGiveUpMs: 600_000, // 10 分钟
  generalInitialMs: 500,
  generalCapMs: 30_000,
  generalGiveUpMs: 600_000, // 10 分钟
}

/** 实时状态展示的刷新间隔（ms）。 */
const STATUS_UPDATE_INTERVAL_MS = 1_000
const SPAWN_SESSIONS_DEFAULT = 32

/**
 * 控制 multi-session spawn 模式（--spawn / --capacity / --create-session-in-dir）
 * 的 GrowthBook gate。与 tengu_ccr_bridge_multi_environment（每个 host:dir 多 env）
 * 是兄弟 gate —— 这个 gate 打开的是每个 environment 多 session。
 * 通过 targeting rules 分阶段开放：先内部，再逐步开放给外部用户。
 *
 * 用阻塞式 gate 检查，避免磁盘缓存失效时不公平地拒绝用户。
 * 快路径（缓存中已有 true）仍然即时返回；只有冷启动路径会等服务端
 * 拉取，而那次拉取也会顺便种下磁盘缓存，下一次就命中了。
 */
async function isMultiSessionSpawnEnabled(): Promise<boolean> {
  return checkGate_CACHED_OR_BLOCKING('tengu_ccr_bridge_multi_session')
}

/**
 * 返回 poll 循环中检测系统睡眠/唤醒的阈值。必须大于最大 backoff 上限 ——
 * 否则正常的 backoff 延迟会被误判为睡眠（把错误预算无限重置）。取连接
 * backoff 上限的 2×，与 WebSocketTransport 和 replBridge 中的同款做法保持
 * 一致。
 */
function pollSleepDetectionThresholdMs(backoff: BackoffConfig): number {
  return backoff.connCapMs * 2
}

/**
 * 返回 spawn 子 claude 进程时必须放在 CLI flag 之前的参数。委托给
 * 集中化的 cliLaunch 模块处理 bundled-vs-script 模式、execArgv 清洗，
 * 以及 Bun execArgv 泄漏的怪癖。见 anthropics/claude-code#28334。
 */
function spawnScriptArgs(): string[] {
  const bootstrap = [...getBootstrapArgs()]
  const script = getScriptPath()
  if (script) bootstrap.push(script)
  return bootstrap
}

/** 尝试 spawn 一个 session；spawn 抛错时返回错误字符串。 */
function safeSpawn(
  spawner: SessionSpawner,
  opts: SessionSpawnOpts,
  dir: string,
): SessionHandle | string {
  try {
    return spawner.spawn(opts, dir)
  } catch (err) {
    const errMsg = errorMessage(err)
    logError(new Error(`Session spawn failed: ${errMsg}`))
    return errMsg
  }
}

export async function runBridgeLoop(
  config: BridgeConfig,
  environmentId: string,
  environmentSecret: string,
  api: BridgeApiClient,
  spawner: SessionSpawner,
  logger: BridgeLogger,
  signal: AbortSignal,
  backoffConfig: BackoffConfig = DEFAULT_BACKOFF,
  initialSessionId?: string,
  getAccessToken?: () => string | undefined | Promise<string | undefined>,
): Promise<void> {
  // 本地 abort controller —— 让 onSessionDone 能停掉 poll 循环。
  // 与外部传入的 signal 联动，外部 abort 同样生效。
  const controller = new AbortController()
  if (signal.aborted) {
    controller.abort()
  } else {
    signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  const loopSignal = controller.signal

  const activeSessions = new Map<string, SessionHandle>()
  const sessionStartTimes = new Map<string, number>()
  const sessionWorkIds = new Map<string, string>()
  // Compat-surface ID（session_*）在 spawn 时算一次并缓存，让 cleanup 和
  // 状态更新 tick 用同一个 key，不受 tengu_bridge_repl_v2_cse_shim_enabled
  // gate 在 session 中途翻转影响。
  const sessionCompatIds = new Map<string, string>()
  // 用于 heartbeat 鉴权的 session ingress JWT，按 sessionId 索引。
  // 与 handle.accessToken 分开存放，因为 token refresh scheduler 会在
  //（约 3h55m 后）用 OAuth token 覆盖那个字段。
  const sessionIngressTokens = new Map<string, string>()
  const sessionTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const completedWorkIds = new Set<string>()
  const sessionWorktrees = new Map<
    string,
    {
      worktreePath: string
      worktreeBranch?: string
      gitRoot?: string
      hookBased?: boolean
    }
  >()
  // 记录被超时看门狗 kill 掉的 session，让 onSessionDone 能把它们和
  // 服务器发起或 shutdown 引起的中断区分开。
  const timedOutSessions = new Set<string>()
  // 已经有标题（服务器设置或 bridge 派生）的 session，让
  // onFirstUserMessage 不会覆盖用户指定的 --name / web 重命名。
  // 按 compatSessionId 索引，与 logger.setSessionTitle 的 key 一致。
  const titledSessions = new Set<string>()
  // 当一个 session 完成时提前唤醒 at-capacity 睡眠，让 bridge 立刻能接新活。
  const capacityWake = createCapacityWake(loopSignal)

  /**
   * 对所有 active 的 work item 发心跳。至少一个成功返回 'ok'；
   * 任何一个拿到 401/403（JWT 过期 —— 通过 reconnectSession 重新入队，
   * 下一次 poll 会派发新 work）返回 'auth_failed'；全部因其他原因失败
   * 返回 'failed'。
   */
  async function heartbeatActiveWorkItems(): Promise<
    'ok' | 'auth_failed' | 'fatal' | 'failed'
  > {
    rcLog(`heartbeat: checking ${activeSessions.size} active session(s)`)
    let anySuccess = false
    let anyFatal = false
    const authFailedSessions: string[] = []
    for (const [sessionId] of activeSessions) {
      const workId = sessionWorkIds.get(sessionId)
      const ingressToken = sessionIngressTokens.get(sessionId)
      if (!workId || !ingressToken) {
        continue
      }
      try {
        await api.heartbeatWork(environmentId, workId, ingressToken)
        anySuccess = true
      } catch (err) {
        logForDebugging(
          `[bridge:heartbeat] Failed for sessionId=${sessionId} workId=${workId}: ${errorMessage(err)}`,
        )
        if (err instanceof BridgeFatalError) {
          logEvent('tengu_bridge_heartbeat_error', {
            status:
              err.status as unknown as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            error_type: (err.status === 401 || err.status === 403
              ? 'auth_failed'
              : 'fatal') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          })
          if (err.status === 401 || err.status === 403) {
            authFailedSessions.push(sessionId)
          } else {
            // 404/410 = environment 过期或被删 —— 重试无意义
            anyFatal = true
          }
        }
      }
    }
    // JWT 过期 → 触发服务端重新派发。不做这步的话，work 会一直被 ACK 在
    // Redis PEL 里，poll 永远返回空（CC-1263）。下面的 existingHandle 路径
    // 会把新 token 投递给子进程。sessionId 已经是 /bridge/reconnect 期望的
    // 格式：它来自 work.data.id，与服务器的 EnvironmentInstance store 一致
    //（compat gate 下是 cse_*，否则是 session_*）。
    for (const sessionId of authFailedSessions) {
      logger.logVerbose(
        `Session ${sessionId} token expired — re-queuing via bridge/reconnect`,
      )
      try {
        await api.reconnectSession(environmentId, sessionId)
        logForDebugging(
          `[bridge:heartbeat] Re-queued sessionId=${sessionId} via bridge/reconnect`,
        )
      } catch (err) {
        logger.logError(
          `Failed to refresh session ${sessionId} token: ${errorMessage(err)}`,
        )
        logForDebugging(
          `[bridge:heartbeat] reconnectSession(${sessionId}) failed: ${errorMessage(err)}`,
          { level: 'error' },
        )
      }
    }
    if (anyFatal) {
      return 'fatal'
    }
    if (authFailedSessions.length > 0) {
      return 'auth_failed'
    }
    return anySuccess ? 'ok' : 'failed'
  }

  // 用 CCR v2 env 变量 spawn 出来的 session。v2 子进程不能用 OAuth
  // token（CCR worker 端点会校验 JWT 的 session_id claim，见
  // register_worker.go:32），所以 onRefresh 触发服务端重新派发 —— 下一次
  // poll 会通过下面的 existingHandle 路径派发带新 JWT 的新 work。
  const v2Sessions = new Set<string>()

  // 主动 token refresh：在 session ingress JWT 过期前 5min 调度一个定时器。
  // v1 直接派发 OAuth；v2 调 reconnectSession 触发服务端重新派发
  //（CC-1263：不做这步的话，v2 daemon session 在 ~5h 时会静默死亡，因为
  // 服务器不会在 lease 到期时自动重新派发 ACK'd 的 work）。
  const tokenRefresh = getAccessToken
    ? createTokenRefreshScheduler({
        getAccessToken,
        onRefresh: (sessionId, oauthToken) => {
          const handle = activeSessions.get(sessionId)
          if (!handle) {
            return
          }
          if (v2Sessions.has(sessionId)) {
            logger.logVerbose(
              `Refreshing session ${sessionId} token via bridge/reconnect`,
            )
            void api
              .reconnectSession(environmentId, sessionId)
              .catch((err: unknown) => {
                logger.logError(
                  `Failed to refresh session ${sessionId} token: ${errorMessage(err)}`,
                )
                logForDebugging(
                  `[bridge:token] reconnectSession(${sessionId}) failed: ${errorMessage(err)}`,
                  { level: 'error' },
                )
              })
          } else {
            handle.updateAccessToken(oauthToken)
          }
        },
        label: 'bridge',
      })
    : null
  const loopStartTime = Date.now()
  // 跟踪所有在飞的 cleanup promise（stopWork、worktree 移除），让 shutdown
  // 序列在 process.exit() 之前能 await 完它们。
  const pendingCleanups = new Set<Promise<unknown>>()
  function trackCleanup(p: Promise<unknown>): void {
    pendingCleanups.add(p)
    void p.finally(() => pendingCleanups.delete(p))
  }
  let connBackoff = 0
  let generalBackoff = 0
  let connErrorStart: number | null = null
  let generalErrorStart: number | null = null
  let lastPollErrorTime: number | null = null
  let statusUpdateTimer: ReturnType<typeof setInterval> | null = null
  // 由 BridgeFatalError 和 give-up 路径设置，让 shutdown 代码块可以跳过
  // resume 提示（env 过期 / 鉴权失败 / 持续连接错误之后 resume 不可能成功）。
  let fatalExit = false

  logForDebugging(
    `[bridge:work] Starting poll loop spawnMode=${config.spawnMode} maxSessions=${config.maxSessions} environmentId=${environmentId}`,
  )
  logForDiagnosticsNoPII('info', 'bridge_loop_started', {
    max_sessions: config.maxSessions,
    spawn_mode: config.spawnMode,
  })

  // 对 ant 用户，展示 session debug 日志会落到哪里，方便他们 tail。
  // sessionRunner.ts 用同一个 base path。文件在 session spawn 后才出现。
  if (process.env.USER_TYPE === 'ant') {
    let debugGlob: string
    if (config.debugFile) {
      const ext = config.debugFile.lastIndexOf('.')
      debugGlob =
        ext > 0
          ? `${config.debugFile.slice(0, ext)}-*${config.debugFile.slice(ext)}`
          : `${config.debugFile}-*`
    } else {
      debugGlob = join(tmpdir(), 'claude', 'bridge-session-*.log')
    }
    logger.setDebugLogPath(debugGlob)
  }

  logger.printBanner(config, environmentId)

  // 在任何渲染之前先把 logger 的 session 计数和 spawn 模式种好。不这步做
  // 的话，下面 setAttached() 会用 logger 默认的 sessionMax=1 渲染，显示
  // 出 "Capacity: 0/1"，直到状态 ticker 启动（它由 !initialSessionId 控制，
  // 仅在 poll 循环拿到 work 后才启动）。
  logger.updateSessionCount(0, config.maxSessions, config.spawnMode)

  // 如果已经预创建了一个 initial session，从一开始就展示它的 URL，让用户
  // 能立刻点过去（与 /remote-control 行为一致）。
  if (initialSessionId) {
    logger.setAttached(initialSessionId)
  }

  /** 刷新行内状态显示。根据当前 state 展示 idle 或 active。 */
  function updateStatusDisplay(): void {
    // 推送 session 计数（maxSessions === 1 时是 no-op），让下一次
    // renderStatusLine tick 展示最新计数。
    logger.updateSessionCount(
      activeSessions.size,
      config.maxSessions,
      config.spawnMode,
    )

    // 把 per-session 活动推给 multi-session 展示。
    for (const [sid, handle] of activeSessions) {
      const act = handle.currentActivity
      if (act) {
        logger.updateSessionActivity(sessionCompatIds.get(sid) ?? sid, act)
      }
    }

    if (activeSessions.size === 0) {
      logger.updateIdleStatus()
      return
    }

    // 展示最近启动且仍在工作的 session。当前活动是 'result' 或 'error'
    // 的 session 处于 turn 之间 —— CLI 已经发出结果但进程还活着等下一条
    // 用户消息。跳过更新，让状态行保持原来的 state（Attached / session 标题）。
    const [sessionId, handle] = [...activeSessions.entries()].pop()!
    const startTime = sessionStartTimes.get(sessionId)
    if (!startTime) return

    const activity = handle.currentActivity
    if (!activity || activity.type === 'result' || activity.type === 'error') {
      // session 处于 turn 之间 —— 保持当前状态（Attached/titled）。
      // 多 session 模式下仍然刷新，让 bullet-list 的活动信息保持最新。
      if (config.maxSessions > 1) logger.refreshDisplay()
      return
    }

    const elapsed = formatDuration(Date.now() - startTime)

    // 从最近的 tool activities（最后 5 条）构造 trail
    const trail = handle.activities
      .filter(a => a.type === 'tool_start')
      .slice(-5)
      .map(a => a.summary)

    logger.updateSessionStatus(sessionId, elapsed, activity, trail)
  }

  /** 启动状态展示更新 ticker。 */
  function startStatusUpdates(): void {
    stopStatusUpdates()
    // 立刻调一次，让第一次状态切换（如 Connecting → Ready）不延迟发生，
    // 避免多个 timer 并发竞争。
    updateStatusDisplay()
    statusUpdateTimer = setInterval(
      updateStatusDisplay,
      STATUS_UPDATE_INTERVAL_MS,
    )
  }

  /** 停止状态展示更新 ticker。 */
  function stopStatusUpdates(): void {
    if (statusUpdateTimer) {
      clearInterval(statusUpdateTimer)
      statusUpdateTimer = null
    }
  }

  function onSessionDone(
    sessionId: string,
    startTime: number,
    handle: SessionHandle,
  ): (status: SessionDoneStatus) => void {
    return (rawStatus: SessionDoneStatus): void => {
      const workId = sessionWorkIds.get(sessionId)
      rcLog(
        `session done: sessionId=${sessionId} workId=${workId ?? 'none'} status=${rawStatus}` +
          ` wasTimedOut=${timedOutSessions.has(sessionId)} duration=${Math.round((Date.now() - startTime) / 1000)}s` +
          ` stderr=${handle.lastStderr.length > 0 ? handle.lastStderr.join('\\n').slice(0, 500) : '(none)'}`,
      )
      activeSessions.delete(sessionId)
      sessionStartTimes.delete(sessionId)
      sessionWorkIds.delete(sessionId)
      sessionIngressTokens.delete(sessionId)
      const compatId = sessionCompatIds.get(sessionId) ?? sessionId
      sessionCompatIds.delete(sessionId)
      logger.removeSession(compatId)
      titledSessions.delete(compatId)
      v2Sessions.delete(sessionId)
      // 清除 per-session 超时 timer
      const timer = sessionTimers.get(sessionId)
      if (timer) {
        clearTimeout(timer)
        sessionTimers.delete(sessionId)
      }
      // 清除 token refresh timer
      tokenRefresh?.cancel(sessionId)
      // 唤醒 at-capacity 睡眠，让 bridge 立刻能接新活
      capacityWake.wake()

      // 如果 session 是被超时看门狗 kill 掉的，把它当作 failed session 处理
      //（不是 server/shutdown 引起的中断），这样下面仍然会调 stopWork 和
      // archiveSession。
      const wasTimedOut = timedOutSessions.delete(sessionId)
      const status: SessionDoneStatus =
        wasTimedOut && rawStatus === 'interrupted' ? 'failed' : rawStatus
      const durationMs = Date.now() - startTime

      logForDebugging(
        `[bridge:session] sessionId=${sessionId} workId=${workId ?? 'unknown'} exited status=${status} duration=${formatDuration(durationMs)}`,
      )
      logEvent('tengu_bridge_session_done', {
        status:
          status as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        duration_ms: durationMs,
      })
      logForDiagnosticsNoPII('info', 'bridge_session_done', {
        status,
        duration_ms: durationMs,
      })

      // 打印最终日志前清掉状态展示
      logger.clearStatus()
      stopStatusUpdates()

      // 如果有 stderr，用它构造错误消息
      const stderrSummary =
        handle.lastStderr.length > 0 ? handle.lastStderr.join('\n') : undefined
      let failureMessage: string | undefined

      switch (status) {
        case 'completed':
          logger.logSessionComplete(sessionId, durationMs)
          break
        case 'failed':
          // shutdown 期间跳过 failure log —— 子进程被 kill 时以非零退出，
          // 这是预期行为，不算真正的失败。
          // 超时被 kill 的 session 也跳过 —— 超时看门狗已经记了一条清晰的
          // 超时日志。
          if (!wasTimedOut && !loopSignal.aborted) {
            failureMessage = stderrSummary ?? 'Process exited with error'
            logger.logSessionFailed(sessionId, failureMessage)
            logError(new Error(`Bridge session failed: ${failureMessage}`))
          }
          break
        case 'interrupted':
          logger.logVerbose(`Session ${sessionId} interrupted`)
          break
      }

      // 通知服务器这个 work item 完成。interrupted 的 session 跳过 ——
      // 中断要么是服务器主动发起（服务器已经知道），要么是 bridge shutdown
      // 引起（shutdown 流程会单独调 stopWork()）。
      if (status !== 'interrupted' && workId) {
        trackCleanup(
          stopWorkWithRetry(
            api,
            environmentId,
            workId,
            logger,
            backoffConfig.stopWorkBaseDelayMs,
          ),
        )
        completedWorkIds.add(workId)
      }

      // 清理为该 session 创建的 worktree
      const wt = sessionWorktrees.get(sessionId)
      if (wt) {
        sessionWorktrees.delete(sessionId)
        trackCleanup(
          removeAgentWorktree(
            wt.worktreePath,
            wt.worktreeBranch,
            wt.gitRoot,
            wt.hookBased,
          ).catch((err: unknown) =>
            logger.logVerbose(
              `Failed to remove worktree ${wt.worktreePath}: ${errorMessage(err)}`,
            ),
          ),
        )
      }

      // 生命周期决策：multi-session 模式下，session 完成后让 bridge 继续跑。
      // single-session 模式下 abort poll 循环，让 bridge 干净地退出。
      if (status !== 'interrupted' && !loopSignal.aborted) {
        if (config.spawnMode !== 'single-session') {
          // Multi-session：把已完成的 session archive 掉，免得它在 web UI 上
          // 留成 stale。archiveSession 是幂等的（已 archive 会返回 409），
          // 所以 shutdown 时再 archive 一次也是安全的。
          // sessionId 从 work poll 拿到的是 cse_*（infrastructure-layer tag）。
          // archiveSession 打的是 /v1/sessions/{id}/archive，这是 compat 层
          // 端点，校验的是 TagSession（session_*）。重新打 tag —— 底层
          // UUID 相同。
          trackCleanup(
            api
              .archiveSession(compatId)
              .catch((err: unknown) =>
                logger.logVerbose(
                  `Failed to archive session ${sessionId}: ${errorMessage(err)}`,
                ),
              ),
          )
          logForDebugging(
            `[bridge:session] Session ${status}, returning to idle (multi-session mode)`,
          )
        } else {
          // Single-session：耦合的生命周期 —— 拆除 environment
          logForDebugging(
            `[bridge:session] Session ${status}, aborting poll loop to tear down environment`,
          )
          controller.abort()
          return
        }
      }

      if (!loopSignal.aborted) {
        startStatusUpdates()
      }
    }
  }

  // 立刻启动 idle 状态展示 —— 除非已经预创建了一个 session，那种情况下
  // setAttached() 已经设置好展示，poll 循环拿到 session 时会启动状态更新。
  if (!initialSessionId) {
    startStatusUpdates()
  }

  while (!loopSignal.aborted) {
    // 每轮迭代拉一次 —— GrowthBook 缓存每 5 分钟刷新一次，所以按 at-capacity
    // 速率跑的循环在一个睡眠周期内就能拿到配置变更。
    const pollConfig = getPollIntervalConfig()

    try {
      rcLog(
        `poll: envId=${environmentId} activeSessions=${activeSessions.size}`,
      )
      const work = await api.pollForWork(
        environmentId,
        environmentSecret,
        loopSignal,
        pollConfig.reclaim_older_than_ms,
      )

      // 如果之前断过连，记一条重连日志
      const wasDisconnected =
        connErrorStart !== null || generalErrorStart !== null
      if (wasDisconnected) {
        const disconnectedMs =
          Date.now() - (connErrorStart ?? generalErrorStart ?? Date.now())
        logger.logReconnected(disconnectedMs)
        logForDebugging(
          `[bridge:poll] Reconnected after ${formatDuration(disconnectedMs)}`,
        )
        logEvent('tengu_bridge_reconnected', {
          disconnected_ms: disconnectedMs,
        })
      }

      connBackoff = 0
      generalBackoff = 0
      connErrorStart = null
      generalErrorStart = null
      lastPollErrorTime = null

      // 响应为 null = 队列里没有 work。加一个最小延迟避免 hammer 服务器。
      if (!work) {
        // 用实时检查（不是快照），因为 session 在 poll 期间也可能结束。
        const atCap = activeSessions.size >= config.maxSessions
        if (atCap) {
          const atCapMs = pollConfig.multisession_poll_interval_ms_at_capacity
          // 心跳循环不 poll。当 at-capacity poll 也开着时（atCapMs > 0），
          // 循环追踪一个 deadline，到点就跳出去 poll —— 心跳和 poll 组合
          // 在一起，而不是一个抑制另一个。跳出循环去 poll 的条件：
          //   - 到 poll deadline（仅 atCapMs > 0 时）
          //   - 鉴权失败（JWT 过期 → poll 会刷新 token）
          //   - capacity wake 触发（session 结束 → poll 接新活）
          //   - 循环被 abort（shutdown）
          if (pollConfig.non_exclusive_heartbeat_interval_ms > 0) {
            logEvent('tengu_bridge_heartbeat_mode_entered', {
              active_sessions: activeSessions.size,
              heartbeat_interval_ms:
                pollConfig.non_exclusive_heartbeat_interval_ms,
            })
            // 进入时一次性算好 deadline —— GB 对 atCapMs 的更新不会改动
            // in-flight 的 deadline（下一次进入会拿到新值）。
            const pollDeadline = atCapMs > 0 ? Date.now() + atCapMs : null
            let hbResult: 'ok' | 'auth_failed' | 'fatal' | 'failed' = 'ok'
            let hbCycles = 0
            while (
              !loopSignal.aborted &&
              activeSessions.size >= config.maxSessions &&
              (pollDeadline === null || Date.now() < pollDeadline)
            ) {
              // 每轮重新读 config，让 GrowthBook 的更新立即生效
              const hbConfig = getPollIntervalConfig()
              if (hbConfig.non_exclusive_heartbeat_interval_ms <= 0) break

              // 在 async heartbeat 调用之前抓取 capacity 信号，这样 HTTP
              // 请求期间结束的 session 会被随后的 sleep 捕获（而不是丢给
              // 一个被替换掉的 controller）。
              const cap = capacityWake.signal()

              hbResult = await heartbeatActiveWorkItems()
              if (hbResult === 'auth_failed' || hbResult === 'fatal') {
                cap.cleanup()
                break
              }

              hbCycles++
              await sleep(
                hbConfig.non_exclusive_heartbeat_interval_ms,
                cap.signal,
              )
              cap.cleanup()
            }

            // 为 telemetry 决定退出原因
            const exitReason =
              hbResult === 'auth_failed' || hbResult === 'fatal'
                ? hbResult
                : loopSignal.aborted
                  ? 'shutdown'
                  : activeSessions.size < config.maxSessions
                    ? 'capacity_changed'
                    : pollDeadline !== null && Date.now() >= pollDeadline
                      ? 'poll_due'
                      : 'config_disabled'
            logEvent('tengu_bridge_heartbeat_mode_exited', {
              reason:
                exitReason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              heartbeat_cycles: hbCycles,
              active_sessions: activeSessions.size,
            })
            if (exitReason === 'poll_due') {
              // bridgeApi 对空 poll 日志做了节流（EMPTY_POLL_LOG_INTERVAL=100），
              // 所以每 10min 一次的 poll_due poll 在 counter=2 时是看不到的。
              // 在这里单独记一条，让 verification run 能在 debug 日志里同时
              // 看到两个端点。
              logForDebugging(
                `[bridge:poll] Heartbeat poll_due after ${hbCycles} cycles — falling through to pollForWork`,
              )
            }

            // auth_failed 或 fatal 时先睡一会儿再 poll，避免 poll+heartbeat
            // 紧循环。Auth_failed：heartbeatActiveWorkItems 已经调过
            // reconnectSession —— 睡眠给服务器传播 re-queue 的时间。Fatal
            //（404/410）：可能是单个 work item 被 GC 了，但 environment 本身
            // 仍然有效。atCapMs 启用时用它，否则用心跳间隔作为下限
            //（这里保证 > 0），避免只有心跳配置的场景进入紧循环。
            if (hbResult === 'auth_failed' || hbResult === 'fatal') {
              const cap = capacityWake.signal()
              await sleep(
                atCapMs > 0
                  ? atCapMs
                  : pollConfig.non_exclusive_heartbeat_interval_ms,
                cap.signal,
              )
              cap.cleanup()
            }
          } else if (atCapMs > 0) {
            // 心跳禁用：用慢 poll 作为 liveness 信号。
            const cap = capacityWake.signal()
            await sleep(atCapMs, cap.signal)
            cap.cleanup()
          }
        } else {
          const interval =
            activeSessions.size > 0
              ? pollConfig.multisession_poll_interval_ms_partial_capacity
              : pollConfig.multisession_poll_interval_ms_not_at_capacity
          await sleep(interval, loopSignal)
        }
        continue
      }

      // At capacity —— 我们 poll 是为了保持心跳，但现在接不了新活。仍然
      // 进入下面的 switch，让已有 session 的 token refresh 能被处理
      //（case 'session' 处理器在内部的 capacity 守卫之前会先检查是否是
      // 已存在的 session）。
      const atCapacityBeforeSwitch = activeSessions.size >= config.maxSessions

      // 跳过已经完成并 stopped 的 work item。服务器在我们发出的 stop 请求
      // 还没处理完之前可能重新派发 stale work，不跳过的话会 spawn 出重复
      // 的 session。
      if (completedWorkIds.has(work.id)) {
        logForDebugging(
          `[bridge:work] Skipping already-completed workId=${work.id}`,
        )
        // 遵守 capacity 节流 —— 不在这里睡一下的话，持续的 stale redelivery
        // 会以 poll 请求的速度进入紧循环（上面 !work 分支是唯一的 sleep，
        // 而 work != null 会跳过它）。
        if (atCapacityBeforeSwitch) {
          const cap = capacityWake.signal()
          if (pollConfig.non_exclusive_heartbeat_interval_ms > 0) {
            await heartbeatActiveWorkItems()
            await sleep(
              pollConfig.non_exclusive_heartbeat_interval_ms,
              cap.signal,
            )
          } else if (pollConfig.multisession_poll_interval_ms_at_capacity > 0) {
            await sleep(
              pollConfig.multisession_poll_interval_ms_at_capacity,
              cap.signal,
            )
          }
          cap.cleanup()
        } else {
          await sleep(1000, loopSignal)
        }
        continue
      }

      // 解码 work secret，用于 session spawn 和下面 ack 调用里要用到的 JWT。
      let secret
      try {
        secret = decodeWorkSecret(work.secret)
      } catch (err) {
        const errMsg = errorMessage(err)
        logger.logError(
          `Failed to decode work secret for workId=${work.id}: ${errMsg}`,
        )
        logEvent('tengu_bridge_work_secret_failed', {})
        // 没 JWT 就 ack 不了（ack 需要它）。stopWork 用 OAuth，所以这里仍能
        // 调 —— 避免 XAUTOCLAIM 每个 reclaim_older_than_ms 周期都把这个
        // poisoned item 再派发一次。
        completedWorkIds.add(work.id)
        trackCleanup(
          stopWorkWithRetry(
            api,
            environmentId,
            work.id,
            logger,
            backoffConfig.stopWorkBaseDelayMs,
          ),
        )
        // 重试前遵守 capacity 节流 —— 不睡一下的话，at capacity 时反复
        // decode 失败会以 poll 请求的速度进入紧循环（work != null 会跳过
        // 上面的 !work sleep）。
        if (atCapacityBeforeSwitch) {
          const cap = capacityWake.signal()
          if (pollConfig.non_exclusive_heartbeat_interval_ms > 0) {
            await heartbeatActiveWorkItems()
            await sleep(
              pollConfig.non_exclusive_heartbeat_interval_ms,
              cap.signal,
            )
          } else if (pollConfig.multisession_poll_interval_ms_at_capacity > 0) {
            await sleep(
              pollConfig.multisession_poll_interval_ms_at_capacity,
              cap.signal,
            )
          }
          cap.cleanup()
        }
        continue
      }

      // 明确在确定要处理这个 work 之后再 ack —— 不要提前 ack。case 'session'
      // 里的 at-capacity 守卫可能在没 spawn 的情况下就 break；那里 ack 会
      // 永久丢失这个 work。ack 失败不致命：服务器会重新派发，existingHandle
      // 和 completedWorkIds 路径会做去重。
      const ackWork = async (): Promise<void> => {
        logForDebugging(`[bridge:work] Acknowledging workId=${work.id}`)
        try {
          await api.acknowledgeWork(
            environmentId,
            work.id,
            secret.session_ingress_token,
          )
        } catch (err) {
          logForDebugging(
            `[bridge:work] Acknowledge failed workId=${work.id}: ${errorMessage(err)}`,
          )
        }
      }

      const workType: string = work.data.type
      switch (work.data.type) {
        case 'healthcheck':
          await ackWork()
          logForDebugging('[bridge:work] Healthcheck received')
          logger.logVerbose('Healthcheck received')
          break
        case 'session': {
          const sessionId = work.data.id
          rcLog(
            `work received: type=session sessionId=${sessionId} workId=${work.id}`,
          )
          try {
            validateBridgeId(sessionId, 'session_id')
          } catch {
            await ackWork()
            logger.logError(`Invalid session_id received: ${sessionId}`)
            break
          }

          // 如果 session 已经在跑，把新 token 投递给子进程，让它能用新的
          // session ingress token 重连 WebSocket。这里处理服务器在 WS 掉线后
          // 重新派发已有 session 的 work 的场景。
          const existingHandle = activeSessions.get(sessionId)
          if (existingHandle) {
            existingHandle.updateAccessToken(secret.session_ingress_token)
            sessionIngressTokens.set(sessionId, secret.session_ingress_token)
            sessionWorkIds.set(sessionId, work.id)
            // 用新 JWT 的过期时间重新调度下一次 refresh。onRefresh 根据
            // v2Sessions 分支，v1 和 v2 在这里都安全。
            tokenRefresh?.schedule(sessionId, secret.session_ingress_token)
            logForDebugging(
              `[bridge:work] Updated access token for existing sessionId=${sessionId} workId=${work.id}`,
            )
            await ackWork()
            break
          }

          // At capacity —— 已有 session 的 token refresh 上面已经处理，但
          // 这里没法 spawn 新的。switch 之后的 capacity sleep 会节流循环，
          // 这里直接 break。
          if (activeSessions.size >= config.maxSessions) {
            logForDebugging(
              `[bridge:work] At capacity (${activeSessions.size}/${config.maxSessions}), cannot spawn new session for workId=${work.id}`,
            )
            break
          }

          await ackWork()
          const spawnStartTime = Date.now()

          // CCR v2 路径：把本 bridge 注册为 session 的 worker，拿到 epoch，
          // 把子进程指向 /v1/code/sessions/{id}。子进程已经有完整的 v2
          // client（SSETransport + CCRClient）—— 与 environment-manager 在
          // 容器里 launch 的代码路径相同。
          //
          // v1 路径：Session-Ingress WebSocket。用的是 config.sessionIngressUrl
          //（不是 secret.api_base_url，后者可能指向一个不知道本地创建的
          // session 的远程代理隧道）。
          let sdkUrl: string
          let useCcrV2 = false
          let workerEpoch: number | undefined
          // 服务器通过 work secret 按 session 决定；env 变量是 ant 开发
          // override（例如在服务器 flag 打开前强制走 v2）。
          if (
            secret.use_code_sessions === true ||
            isEnvTruthy(process.env.CLAUDE_BRIDGE_USE_CCR_V2)
          ) {
            sdkUrl = buildCCRv2SdkUrl(config.apiBaseUrl, sessionId)
            // 瞬时失败（网络抖动、500）时重试一次，再彻底放弃并 kill session。
            for (let attempt = 1; attempt <= 2; attempt++) {
              try {
                workerEpoch = await registerWorker(
                  sdkUrl,
                  secret.session_ingress_token,
                )
                useCcrV2 = true
                logForDebugging(
                  `[bridge:session] CCR v2: registered worker sessionId=${sessionId} epoch=${workerEpoch} attempt=${attempt}`,
                )
                break
              } catch (err) {
                const errMsg = errorMessage(err)
                if (attempt < 2) {
                  logForDebugging(
                    `[bridge:session] CCR v2: registerWorker attempt ${attempt} failed, retrying: ${errMsg}`,
                  )
                  await sleep(2_000, loopSignal)
                  if (loopSignal.aborted) break
                  continue
                }
                logger.logError(
                  `CCR v2 worker registration failed for session ${sessionId}: ${errMsg}`,
                )
                logError(new Error(`registerWorker failed: ${errMsg}`))
                completedWorkIds.add(work.id)
                trackCleanup(
                  stopWorkWithRetry(
                    api,
                    environmentId,
                    work.id,
                    logger,
                    backoffConfig.stopWorkBaseDelayMs,
                  ),
                )
              }
            }
            if (!useCcrV2) break
          } else {
            sdkUrl = buildSdkUrl(config.sessionIngressUrl, sessionId)
          }

          // worktree 模式下，按需创建的 session 会得到一个独立的 git worktree，
          // 避免并发 session 之间互相干扰文件改动。预创建的 initial session
          //（如果有）跑在 config.dir 里，让用户的第一个 session 落在他调用
          // `rc` 的那个目录 —— 与旧的 single-session UX 保持一致。
          // same-dir 和 single-session 模式下，所有 session 共用 config.dir。
          // 在下面的 await 之前抓取 spawnMode —— `w` 键处理器会直接修改
          // config.spawnMode，而 createAgentWorktree 可能花 1-2 秒，await
          // 之后再读 config.spawnMode 会产生自相矛盾的埋点
          //（spawn_mode:'same-dir', in_worktree:true）。
          const spawnModeAtDecision = config.spawnMode
          let sessionDir = config.dir
          let worktreeCreateMs = 0
          if (
            spawnModeAtDecision === 'worktree' &&
            (initialSessionId === undefined ||
              !sameSessionId(sessionId, initialSessionId))
          ) {
            const wtStart = Date.now()
            try {
              const wt = await createAgentWorktree(
                `bridge-${safeFilenameId(sessionId)}`,
              )
              worktreeCreateMs = Date.now() - wtStart
              sessionWorktrees.set(sessionId, {
                worktreePath: wt.worktreePath,
                worktreeBranch: wt.worktreeBranch,
                gitRoot: wt.gitRoot,
                hookBased: wt.hookBased,
              })
              sessionDir = wt.worktreePath
              logForDebugging(
                `[bridge:session] Created worktree for sessionId=${sessionId} at ${wt.worktreePath}`,
              )
            } catch (err) {
              const errMsg = errorMessage(err)
              logger.logError(
                `Failed to create worktree for session ${sessionId}: ${errMsg}`,
              )
              logError(new Error(`Worktree creation failed: ${errMsg}`))
              completedWorkIds.add(work.id)
              trackCleanup(
                stopWorkWithRetry(
                  api,
                  environmentId,
                  work.id,
                  logger,
                  backoffConfig.stopWorkBaseDelayMs,
                ),
              )
              break
            }
          }

          logForDebugging(
            `[bridge:session] Spawning sessionId=${sessionId} sdkUrl=${sdkUrl}`,
          )

          // 给 logger/Sessions-API 调用用的 compat-surface session_* 形式。
          // Work poll 在 v2 compat 下返回 cse_*；在 spawn 之前转换，让
          // onFirstUserMessage 回调能闭包到它。
          const compatSessionId = toCompatSessionId(sessionId)

          rcLog(
            `spawning session: sessionId=${sessionId} sdkUrl=${sdkUrl}` +
              ` useCcrV2=${useCcrV2} workerEpoch=${workerEpoch}` +
              ` dir=${sessionDir}` +
              ` accessToken=${secret.session_ingress_token ? secret.session_ingress_token.slice(0, 8) + '...' : 'NONE'}`,
          )
          const spawnResult = safeSpawn(
            spawner,
            {
              sessionId,
              sdkUrl,
              accessToken: secret.session_ingress_token,
              useCcrV2,
              workerEpoch,
              onFirstUserMessage: text => {
                // 服务器设置的标题（--name、web 重命名）优先。fetchSessionTitle
                // 并发跑；如果它已经填好 titledSessions，就跳过。如果它还没
                // resolve，派生出的标题就生效 —— 因为 spawn 时服务器没有
                // 标题，这样是可以接受的。
                if (titledSessions.has(compatSessionId)) return
                titledSessions.add(compatSessionId)
                const title = deriveSessionTitle(text)
                logger.setSessionTitle(compatSessionId, title)
                logForDebugging(
                  `[bridge:title] derived title for ${compatSessionId}: ${title}`,
                )
                void import('./createSession.js')
                  .then(({ updateBridgeSessionTitle }) =>
                    updateBridgeSessionTitle(compatSessionId, title, {
                      baseUrl: config.apiBaseUrl,
                    }),
                  )
                  .catch(err =>
                    logForDebugging(
                      `[bridge:title] failed to update title for ${compatSessionId}: ${err}`,
                      { level: 'error' },
                    ),
                  )
              },
            },
            sessionDir,
          )
          if (typeof spawnResult === 'string') {
            logger.logError(
              `Failed to spawn session ${sessionId}: ${spawnResult}`,
            )
            // 清理为该 session 创建的 worktree
            const wt = sessionWorktrees.get(sessionId)
            if (wt) {
              sessionWorktrees.delete(sessionId)
              trackCleanup(
                removeAgentWorktree(
                  wt.worktreePath,
                  wt.worktreeBranch,
                  wt.gitRoot,
                  wt.hookBased,
                ).catch((err: unknown) =>
                  logger.logVerbose(
                    `Failed to remove worktree ${wt.worktreePath}: ${errorMessage(err)}`,
                  ),
                ),
              )
            }
            completedWorkIds.add(work.id)
            trackCleanup(
              stopWorkWithRetry(
                api,
                environmentId,
                work.id,
                logger,
                backoffConfig.stopWorkBaseDelayMs,
              ),
            )
            break
          }
          const handle = spawnResult

          const spawnDurationMs = Date.now() - spawnStartTime
          logEvent('tengu_bridge_session_started', {
            active_sessions: activeSessions.size,
            spawn_mode:
              spawnModeAtDecision as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            in_worktree: sessionWorktrees.has(sessionId),
            spawn_duration_ms: spawnDurationMs,
            worktree_create_ms: worktreeCreateMs,
            inProtectedNamespace: isInProtectedNamespace(),
          })
          logForDiagnosticsNoPII('info', 'bridge_session_started', {
            spawn_mode: spawnModeAtDecision,
            in_worktree: sessionWorktrees.has(sessionId),
            spawn_duration_ms: spawnDurationMs,
            worktree_create_ms: worktreeCreateMs,
          })

          activeSessions.set(sessionId, handle)
          sessionWorkIds.set(sessionId, work.id)
          sessionIngressTokens.set(sessionId, secret.session_ingress_token)
          sessionCompatIds.set(sessionId, compatSessionId)

          const startTime = Date.now()
          sessionStartTimes.set(sessionId, startTime)

          // 用一个通用的 prompt 描述，因为我们已经拿不到 startup_context
          logger.logSessionStart(sessionId, `Session ${sessionId}`)

          // 算出实际的 debug 文件路径（与 sessionRunner.ts 的逻辑对齐）
          const safeId = safeFilenameId(sessionId)
          let sessionDebugFile: string | undefined
          if (config.debugFile) {
            const ext = config.debugFile.lastIndexOf('.')
            if (ext > 0) {
              sessionDebugFile = `${config.debugFile.slice(0, ext)}-${safeId}${config.debugFile.slice(ext)}`
            } else {
              sessionDebugFile = `${config.debugFile}-${safeId}`
            }
          } else if (config.verbose || process.env.USER_TYPE === 'ant') {
            sessionDebugFile = join(
              tmpdir(),
              'claude',
              `bridge-session-${safeId}.log`,
            )
          }

          if (sessionDebugFile) {
            logger.logVerbose(`Debug log: ${sessionDebugFile}`)
          }

          // 在启动状态更新之前先注册到 sessions Map 里，让第一次 render tick
          // 同步展示正确的计数和 bullet list。
          logger.addSession(
            compatSessionId,
            getRemoteSessionUrl(compatSessionId, config.sessionIngressUrl),
          )

          // 启动实时状态更新，切换到 "Attached" 状态。
          startStatusUpdates()
          logger.setAttached(compatSessionId)

          // 一次性拉取 session 标题。如果 session 已经有标题（通过 --name、
          // web 重命名或 /remote-control 设置），就展示它并标记为 titled，
          // 这样首条用户消息的 fallback 就不会覆盖它。否则 onFirstUserMessage
          // 会从第一条 prompt 派生标题。
          void fetchSessionTitle(compatSessionId, config.apiBaseUrl)
            .then(title => {
              if (title && activeSessions.has(sessionId)) {
                titledSessions.add(compatSessionId)
                logger.setSessionTitle(compatSessionId, title)
                logForDebugging(
                  `[bridge:title] server title for ${compatSessionId}: ${title}`,
                )
              }
            })
            .catch(err =>
              logForDebugging(
                `[bridge:title] failed to fetch title for ${compatSessionId}: ${err}`,
                { level: 'error' },
              ),
            )

          // 启动 per-session 超时看门狗
          const timeoutMs =
            config.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS
          if (timeoutMs > 0) {
            const timer = setTimeout(
              onSessionTimeout,
              timeoutMs,
              sessionId,
              timeoutMs,
              logger,
              timedOutSessions,
              handle,
            )
            sessionTimers.set(sessionId, timer)
          }

          // 在 JWT 过期前调度主动 token refresh。onRefresh 按 v2Sessions 分
          // 支：v1 把 OAuth 派发给子进程；v2 通过 reconnectSession 触发服务
          // 端重新派发。
          if (useCcrV2) {
            v2Sessions.add(sessionId)
          }
          tokenRefresh?.schedule(sessionId, secret.session_ingress_token)

          void handle.done.then(onSessionDone(sessionId, startTime, handle))
          break
        }
        default:
          await ackWork()
          // 优雅地忽略未知 work 类型。后端可能在 bridge client 更新之前
          // 先发新类型过来。
          logForDebugging(
            `[bridge:work] Unknown work type: ${workType}, skipping`,
          )
          break
      }

      // at capacity 时，节流循环。上面的 switch 仍然执行，这样已有 session
      // 的 token refresh 能被处理，但这里要 sleep 避免忙循环。把 capacity
      // wake 信号带上，让 session 完成时 sleep 能立刻被中断。
      if (atCapacityBeforeSwitch) {
        const cap = capacityWake.signal()
        if (pollConfig.non_exclusive_heartbeat_interval_ms > 0) {
          await heartbeatActiveWorkItems()
          await sleep(
            pollConfig.non_exclusive_heartbeat_interval_ms,
            cap.signal,
          )
        } else if (pollConfig.multisession_poll_interval_ms_at_capacity > 0) {
          await sleep(
            pollConfig.multisession_poll_interval_ms_at_capacity,
            cap.signal,
          )
        }
        cap.cleanup()
      }
    } catch (err) {
      if (loopSignal.aborted) {
        break
      }

      // 致命错误（401/403）—— 重试没意义，auth 不会自己修好
      if (err instanceof BridgeFatalError) {
        fatalExit = true
        // 服务器强制过期得到一条干净的状态消息，不是错误
        if (isExpiredErrorType(err.errorType)) {
          logger.logStatus(err.message)
        } else if (isSuppressible403(err)) {
          // 装饰性 403 错误（例如 external_poll_sessions scope、
          // environments:manage 权限）—— 不展示给用户
          logForDebugging(`[bridge:work] Suppressed 403 error: ${err.message}`)
        } else {
          logger.logError(err.message)
          logError(err)
        }
        logEvent('tengu_bridge_fatal_error', {
          status: err.status,
          error_type:
            err.errorType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        logForDiagnosticsNoPII(
          isExpiredErrorType(err.errorType) ? 'info' : 'error',
          'bridge_fatal_error',
          { status: err.status, error_type: err.errorType },
        )
        break
      }

      const errMsg = describeAxiosError(err)
      rcLog(
        `poll error: ${errMsg}` +
          ` isConn=${isConnectionError(err)} isServer=${isServerError(err)}` +
          ` activeSessions=${activeSessions.size}`,
      )

      if (isConnectionError(err) || isServerError(err)) {
        const now = Date.now()

        // 检测系统睡眠/唤醒：如果距离上次 poll 错误的间隔远超预期 backoff，
        // 机器很可能是睡过了。重置错误追踪，让 bridge 用新的预算重试。
        if (
          lastPollErrorTime !== null &&
          now - lastPollErrorTime > pollSleepDetectionThresholdMs(backoffConfig)
        ) {
          logForDebugging(
            `[bridge:work] Detected system sleep (${Math.round((now - lastPollErrorTime) / 1000)}s gap), resetting error budget`,
          )
          logForDiagnosticsNoPII('info', 'bridge_poll_sleep_detected', {
            gapMs: now - lastPollErrorTime,
          })
          connErrorStart = null
          connBackoff = 0
          generalErrorStart = null
          generalBackoff = 0
        }
        lastPollErrorTime = now

        if (!connErrorStart) {
          connErrorStart = now
        }
        const elapsed = now - connErrorStart
        if (elapsed >= backoffConfig.connGiveUpMs) {
          logger.logError(
            `Server unreachable for ${Math.round(elapsed / 60_000)} minutes, giving up.`,
          )
          logEvent('tengu_bridge_poll_give_up', {
            error_type:
              'connection' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            elapsed_ms: elapsed,
          })
          logForDiagnosticsNoPII('error', 'bridge_poll_give_up', {
            error_type: 'connection',
            elapsed_ms: elapsed,
          })
          fatalExit = true
          break
        }

        // 切换错误类型时重置另一条 track
        generalErrorStart = null
        generalBackoff = 0

        connBackoff = connBackoff
          ? Math.min(connBackoff * 2, backoffConfig.connCapMs)
          : backoffConfig.connInitialMs
        const delay = addJitter(connBackoff)
        logger.logVerbose(
          `Connection error, retrying in ${formatDelay(delay)} (${Math.round(elapsed / 1000)}s elapsed): ${errMsg}`,
        )
        logger.updateReconnectingStatus(
          formatDelay(delay),
          formatDuration(elapsed),
        )
        // poll_due 心跳循环退出后，一条健康的 lease 会暴露给这条 backoff
        // 路径。每次 sleep 前发心跳，避免 /poll 宕机（heartbeat 就是为绕开
        // VerifyEnvironmentSecretAuth DB 路径引入的）搞掉 300s 的 lease TTL。
        // activeSessions 为空或 heartbeat 禁用时是 no-op。
        if (getPollIntervalConfig().non_exclusive_heartbeat_interval_ms > 0) {
          await heartbeatActiveWorkItems()
        }
        await sleep(delay, loopSignal)
      } else {
        const now = Date.now()

        // 通用错误的睡眠检测（逻辑与连接错误相同）
        if (
          lastPollErrorTime !== null &&
          now - lastPollErrorTime > pollSleepDetectionThresholdMs(backoffConfig)
        ) {
          logForDebugging(
            `[bridge:work] Detected system sleep (${Math.round((now - lastPollErrorTime) / 1000)}s gap), resetting error budget`,
          )
          logForDiagnosticsNoPII('info', 'bridge_poll_sleep_detected', {
            gapMs: now - lastPollErrorTime,
          })
          connErrorStart = null
          connBackoff = 0
          generalErrorStart = null
          generalBackoff = 0
        }
        lastPollErrorTime = now

        if (!generalErrorStart) {
          generalErrorStart = now
        }
        const elapsed = now - generalErrorStart
        if (elapsed >= backoffConfig.generalGiveUpMs) {
          logger.logError(
            `Persistent errors for ${Math.round(elapsed / 60_000)} minutes, giving up.`,
          )
          logEvent('tengu_bridge_poll_give_up', {
            error_type:
              'general' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            elapsed_ms: elapsed,
          })
          logForDiagnosticsNoPII('error', 'bridge_poll_give_up', {
            error_type: 'general',
            elapsed_ms: elapsed,
          })
          fatalExit = true
          break
        }

        // 切换错误类型时重置另一条 track
        connErrorStart = null
        connBackoff = 0

        generalBackoff = generalBackoff
          ? Math.min(generalBackoff * 2, backoffConfig.generalCapMs)
          : backoffConfig.generalInitialMs
        const delay = addJitter(generalBackoff)
        logger.logVerbose(
          `Poll failed, retrying in ${formatDelay(delay)} (${Math.round(elapsed / 1000)}s elapsed): ${errMsg}`,
        )
        logger.updateReconnectingStatus(
          formatDelay(delay),
          formatDuration(elapsed),
        )
        if (getPollIntervalConfig().non_exclusive_heartbeat_interval_ms > 0) {
          await heartbeatActiveWorkItems()
        }
        await sleep(delay, loopSignal)
      }
    }
  }

  // 清理
  stopStatusUpdates()
  logger.clearStatus()

  const loopDurationMs = Date.now() - loopStartTime
  logEvent('tengu_bridge_shutdown', {
    active_sessions: activeSessions.size,
    loop_duration_ms: loopDurationMs,
  })
  logForDiagnosticsNoPII('info', 'bridge_shutdown', {
    active_sessions: activeSessions.size,
    loop_duration_ms: loopDurationMs,
  })

  // 优雅 shutdown：kill 掉 active 的 session、报告它们为 interrupted、
  // archive session，最后 deregister environment，让 web UI 把 bridge 显示
  // 为离线。

  // 收集退出时要 archive 的所有 session ID。包括：
  // 1. Active session（kill 之前快照 —— onSessionDone 会清 maps）
  // 2. 自动创建的 initial session（可能从没派发过 work）
  // api.archiveSession 是幂等的（已 archive 返回 409），所以重复 archive 也安全。
  const sessionsToArchive = new Set(activeSessions.keys())
  if (initialSessionId) {
    sessionsToArchive.add(initialSessionId)
  }
  // kill 之前快照 —— onSessionDone 会清 sessionCompatIds。
  const compatIdSnapshot = new Map(sessionCompatIds)

  if (activeSessions.size > 0) {
    logForDebugging(
      `[bridge:shutdown] Shutting down ${activeSessions.size} active session(s)`,
    )
    logger.logStatus(
      `Shutting down ${activeSessions.size} active session(s)\u2026`,
    )

    // kill 之前快照 work ID —— onSessionDone 在每个子进程退出时会清 maps，
    // 所以下面 stopWork 调用要用自己的拷贝。
    const shutdownWorkIds = new Map(sessionWorkIds)

    for (const [sessionId, handle] of activeSessions.entries()) {
      logForDebugging(
        `[bridge:shutdown] Sending SIGTERM to sessionId=${sessionId}`,
      )
      handle.kill()
    }

    const timeout = new AbortController()
    await Promise.race([
      Promise.allSettled([...activeSessions.values()].map(h => h.done)),
      sleep(backoffConfig.shutdownGraceMs ?? 30_000, timeout.signal),
    ])
    timeout.abort()

    // 在 grace 期内没响应 SIGTERM 的进程 SIGKILL 掉
    for (const [sid, handle] of activeSessions.entries()) {
      logForDebugging(`[bridge:shutdown] Force-killing stuck sessionId=${sid}`)
      handle.forceKill()
    }

    // 清掉所有残留的 session 超时和 refresh 定时器
    for (const timer of sessionTimers.values()) {
      clearTimeout(timer)
    }
    sessionTimers.clear()
    tokenRefresh?.cancelAll()

    // 清理 active session 残留的 worktree。先快照并清掉 map，避免
    // onSessionDone（在下面 await 期间 handle.done resolve 时可能触发）再次
    // 尝试移除同样的 worktree。
    if (sessionWorktrees.size > 0) {
      const remainingWorktrees = [...sessionWorktrees.values()]
      sessionWorktrees.clear()
      logForDebugging(
        `[bridge:shutdown] Cleaning up ${remainingWorktrees.length} worktree(s)`,
      )
      await Promise.allSettled(
        remainingWorktrees.map(wt =>
          removeAgentWorktree(
            wt.worktreePath,
            wt.worktreeBranch,
            wt.gitRoot,
            wt.hookBased,
          ),
        ),
      )
    }

    // 停掉所有 active 的 work item，让服务器知道它们已经结束
    await Promise.allSettled(
      [...shutdownWorkIds.entries()].map(([sessionId, workId]) => {
        return api
          .stopWork(environmentId, workId, true)
          .catch(err =>
            logger.logVerbose(
              `Failed to stop work ${workId} for session ${sessionId}: ${errorMessage(err)}`,
            ),
          )
      }),
    )
  }

  // 在 deregister 之前确保 onSessionDone 中所有在飞的 cleanup（stopWork、
  // worktree 移除）都完成 —— 否则 process.exit() 会把它们中途 kill 掉。
  if (pendingCleanups.size > 0) {
    await Promise.allSettled([...pendingCleanups])
  }

  // 在 single-session 模式且 session ID 已知时，保留 session 和 environment，
  // 让 `claude remote-control --session-id=<id>` 能 resume。后端通过 4h TTL
  //（BRIDGE_LAST_POLL_TTL）GC 掉 stale environment。archive session 或
  // deregister environment 会让打印出来的 resume 命令变成谎言 —— deregister
  // 会删除 Firestore + Redis stream。循环致命退出时（env 过期、鉴权失败、
  // give-up）跳过 —— 这些情况下 resume 不可能成功，消息会和已打印的错误
  // 自相矛盾。
  // feature('KAIROS') gate：--session-id 是 ant-only；gate 关闭时退回 PR
  // 之前的行为（每次 shutdown 都 archive + deregister）。
  if (
    feature('KAIROS') &&
    config.spawnMode === 'single-session' &&
    initialSessionId &&
    !fatalExit
  ) {
    logger.logStatus(
      `Resume this session by running \`claude remote-control --continue\``,
    )
    logForDebugging(
      `[bridge:shutdown] Skipping archive+deregister to allow resume of session ${initialSessionId}`,
    )
    return
  }

  // 把所有已知 session archive 掉，避免 bridge 离线后它们在服务器上留成
  // idle/running。
  if (sessionsToArchive.size > 0) {
    logForDebugging(
      `[bridge:shutdown] Archiving ${sessionsToArchive.size} session(s)`,
    )
    await Promise.allSettled(
      [...sessionsToArchive].map(sessionId =>
        api
          .archiveSession(
            compatIdSnapshot.get(sessionId) ?? toCompatSessionId(sessionId),
          )
          .catch(err =>
            logger.logVerbose(
              `Failed to archive session ${sessionId}: ${errorMessage(err)}`,
            ),
          ),
      ),
    )
  }

  // Deregister environment，让 web UI 把 bridge 显示为离线，并清理 Redis stream。
  try {
    await api.deregisterEnvironment(environmentId)
    logForDebugging(
      `[bridge:shutdown] Environment deregistered, bridge offline`,
    )
    logger.logVerbose('Environment deregistered.')
  } catch (err) {
    logger.logVerbose(`Failed to deregister environment: ${errorMessage(err)}`)
  }

  // 清掉崩溃恢复指针 —— env 没了，指针会是 stale 的。上面的早返回
  //（可 resume 的 SIGINT shutdown）会跳过这步，把指针留作打印出来的
  // --session-id 提示的备份。
  const { clearBridgePointer } = await import('./bridgePointer.js')
  await clearBridgePointer(config.dir)

  logger.logVerbose('Environment offline.')
}

const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EHOSTUNREACH',
])

export function isConnectionError(err: unknown): boolean {
  if (
    err &&
    typeof err === 'object' &&
    'code' in err &&
    typeof err.code === 'string' &&
    CONNECTION_ERROR_CODES.has(err.code)
  ) {
    return true
  }
  return false
}

/** 检测 axios 的 HTTP 5xx 错误（code: 'ERR_BAD_RESPONSE'）。 */
export function isServerError(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    'code' in err &&
    typeof err.code === 'string' &&
    err.code === 'ERR_BAD_RESPONSE'
  )
}

/** 给一个延迟值加 ±25% 的抖动。 */
function addJitter(ms: number): number {
  return Math.max(0, ms + ms * 0.25 * (2 * Math.random() - 1))
}

function formatDelay(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`
}

/**
 * 用指数退避重试 stopWork（3 次尝试，1s/2s/4s）。确保服务器知道 work item
 * 已经结束，避免服务端僵尸。
 */
async function stopWorkWithRetry(
  api: BridgeApiClient,
  environmentId: string,
  workId: string,
  logger: BridgeLogger,
  baseDelayMs = 1000,
): Promise<void> {
  const MAX_ATTEMPTS = 3

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await api.stopWork(environmentId, workId, false)
      logForDebugging(
        `[bridge:work] stopWork succeeded for workId=${workId} on attempt ${attempt}/${MAX_ATTEMPTS}`,
      )
      return
    } catch (err) {
      // 鉴权/权限错误重试也修不好
      if (err instanceof BridgeFatalError) {
        if (isSuppressible403(err)) {
          logForDebugging(
            `[bridge:work] Suppressed stopWork 403 for ${workId}: ${err.message}`,
          )
        } else {
          logger.logError(`Failed to stop work ${workId}: ${err.message}`)
        }
        logForDiagnosticsNoPII('error', 'bridge_stop_work_failed', {
          attempts: attempt,
          fatal: true,
        })
        return
      }
      const errMsg = errorMessage(err)
      if (attempt < MAX_ATTEMPTS) {
        const delay = addJitter(baseDelayMs * 2 ** (attempt - 1))
        logger.logVerbose(
          `Failed to stop work ${workId} (attempt ${attempt}/${MAX_ATTEMPTS}), retrying in ${formatDelay(delay)}: ${errMsg}`,
        )
        await sleep(delay)
      } else {
        logger.logError(
          `Failed to stop work ${workId} after ${MAX_ATTEMPTS} attempts: ${errMsg}`,
        )
        logForDiagnosticsNoPII('error', 'bridge_stop_work_failed', {
          attempts: MAX_ATTEMPTS,
        })
      }
    }
  }
}

function onSessionTimeout(
  sessionId: string,
  timeoutMs: number,
  logger: BridgeLogger,
  timedOutSessions: Set<string>,
  handle: SessionHandle,
): void {
  logForDebugging(
    `[bridge:session] sessionId=${sessionId} timed out after ${formatDuration(timeoutMs)}`,
  )
  logEvent('tengu_bridge_session_timeout', {
    timeout_ms: timeoutMs,
  })
  logger.logSessionFailed(
    sessionId,
    `Session timed out after ${formatDuration(timeoutMs)}`,
  )
  timedOutSessions.add(sessionId)
  handle.kill()
}

export type ParsedArgs = {
  verbose: boolean
  sandbox: boolean
  debugFile?: string
  sessionTimeoutMs?: number
  permissionMode?: string
  name?: string
  /** 传给 --spawn 的值（如果有）；没传 --spawn flag 时为 undefined。 */
  spawnMode: SpawnMode | undefined
  /** 传给 --capacity 的值（如果有）；没传 --capacity flag 时为 undefined。 */
  capacity: number | undefined
  /** --[no-]create-session-in-dir override；undefined = 用默认值（on）。 */
  createSessionInDir: boolean | undefined
  /** resume 一个已有 session，而不是创建新 session。 */
  sessionId?: string
  /** resume 这个目录下的最后一个 session（读 bridge-pointer.json）。 */
  continueSession: boolean
  help: boolean
  error?: string
}

const SPAWN_FLAG_VALUES = ['session', 'same-dir', 'worktree'] as const

function parseSpawnValue(raw: string | undefined): SpawnMode | string {
  if (raw === 'session') return 'single-session'
  if (raw === 'same-dir') return 'same-dir'
  if (raw === 'worktree') return 'worktree'
  return `--spawn requires one of: ${SPAWN_FLAG_VALUES.join(', ')} (got: ${raw ?? '<missing>'})`
}

function parseCapacityValue(raw: string | undefined): number | string {
  const n = raw === undefined ? NaN : parseInt(raw, 10)
  if (isNaN(n) || n < 1) {
    return `--capacity requires a positive integer (got: ${raw ?? '<missing>'})`
  }
  return n
}

export function parseArgs(args: string[]): ParsedArgs {
  let verbose = false
  let sandbox = false
  let debugFile: string | undefined
  let sessionTimeoutMs: number | undefined
  let permissionMode: string | undefined
  let name: string | undefined
  let help = false
  let spawnMode: SpawnMode | undefined
  let capacity: number | undefined
  let createSessionInDir: boolean | undefined
  let sessionId: string | undefined
  let continueSession = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--help' || arg === '-h') {
      help = true
    } else if (arg === '--verbose' || arg === '-v') {
      verbose = true
    } else if (arg === '--sandbox') {
      sandbox = true
    } else if (arg === '--no-sandbox') {
      sandbox = false
    } else if (arg === '--debug-file' && i + 1 < args.length) {
      debugFile = resolve(args[++i]!)
    } else if (arg.startsWith('--debug-file=')) {
      debugFile = resolve(arg.slice('--debug-file='.length))
    } else if (arg === '--session-timeout' && i + 1 < args.length) {
      sessionTimeoutMs = parseInt(args[++i]!, 10) * 1000
    } else if (arg.startsWith('--session-timeout=')) {
      sessionTimeoutMs =
        parseInt(arg.slice('--session-timeout='.length), 10) * 1000
    } else if (arg === '--permission-mode' && i + 1 < args.length) {
      permissionMode = args[++i]!
    } else if (arg.startsWith('--permission-mode=')) {
      permissionMode = arg.slice('--permission-mode='.length)
    } else if (arg === '--name' && i + 1 < args.length) {
      name = args[++i]!
    } else if (arg.startsWith('--name=')) {
      name = arg.slice('--name='.length)
    } else if (
      feature('KAIROS') &&
      arg === '--session-id' &&
      i + 1 < args.length
    ) {
      sessionId = args[++i]!
      if (!sessionId) {
        return makeError('--session-id requires a value')
      }
    } else if (feature('KAIROS') && arg.startsWith('--session-id=')) {
      sessionId = arg.slice('--session-id='.length)
      if (!sessionId) {
        return makeError('--session-id requires a value')
      }
    } else if (feature('KAIROS') && (arg === '--continue' || arg === '-c')) {
      continueSession = true
    } else if (arg === '--spawn' || arg.startsWith('--spawn=')) {
      if (spawnMode !== undefined) {
        return makeError('--spawn may only be specified once')
      }
      const raw = arg.startsWith('--spawn=')
        ? arg.slice('--spawn='.length)
        : args[++i]
      const v = parseSpawnValue(raw)
      if (v === 'single-session' || v === 'same-dir' || v === 'worktree') {
        spawnMode = v
      } else {
        return makeError(v)
      }
    } else if (arg === '--capacity' || arg.startsWith('--capacity=')) {
      if (capacity !== undefined) {
        return makeError('--capacity may only be specified once')
      }
      const raw = arg.startsWith('--capacity=')
        ? arg.slice('--capacity='.length)
        : args[++i]
      const v = parseCapacityValue(raw)
      if (typeof v === 'number') capacity = v
      else return makeError(v)
    } else if (arg === '--create-session-in-dir') {
      createSessionInDir = true
    } else if (arg === '--no-create-session-in-dir') {
      createSessionInDir = false
    } else {
      return makeError(
        `Unknown argument: ${arg}\nRun 'claude remote-control --help' for usage.`,
      )
    }
  }

  // 注意：--spawn/--capacity/--create-session-in-dir 的 gate 检查在 bridgeMain
  // 里（gate-aware 错误）。flag 的交叉校验在这里做。

  // --capacity 只在 multi-session 模式下有意义。
  if (spawnMode === 'single-session' && capacity !== undefined) {
    return makeError(
      `--capacity cannot be used with --spawn=session (single-session mode has fixed capacity 1).`,
    )
  }

  // --session-id / --continue 是在原 environment 上 resume 一个特定的
  // session；与 spawn 相关的 flag（它们配置新 session 的创建）不兼容，
  // 且彼此互斥。
  if (
    (sessionId || continueSession) &&
    (spawnMode !== undefined ||
      capacity !== undefined ||
      createSessionInDir !== undefined)
  ) {
    return makeError(
      `--session-id and --continue cannot be used with --spawn, --capacity, or --create-session-in-dir.`,
    )
  }
  if (sessionId && continueSession) {
    return makeError(`--session-id and --continue cannot be used together.`)
  }

  return {
    verbose,
    sandbox,
    debugFile,
    sessionTimeoutMs,
    permissionMode,
    name,
    spawnMode,
    capacity,
    createSessionInDir,
    sessionId,
    continueSession,
    help,
  }

  function makeError(error: string): ParsedArgs {
    return {
      verbose,
      sandbox,
      debugFile,
      sessionTimeoutMs,
      permissionMode,
      name,
      spawnMode,
      capacity,
      createSessionInDir,
      sessionId,
      continueSession,
      help,
      error,
    }
  }
}

async function printHelp(): Promise<void> {
  // help 文本用 EXTERNAL_PERMISSION_MODES —— 内部模式（bubble）是 ant-only，
  // auto 是 feature-gated；validation 仍然接受它们。
  const { EXTERNAL_PERMISSION_MODES } = await import('../types/permissions.js')
  const modes = EXTERNAL_PERMISSION_MODES.join(', ')
  const showServer = await isMultiSessionSpawnEnabled()
  const serverOptions = showServer
    ? `  --spawn <mode>                   Spawn mode: same-dir, worktree, session
                                   (default: same-dir)
  --capacity <N>                   Max concurrent sessions in worktree or
                                   same-dir mode (default: ${SPAWN_SESSIONS_DEFAULT})
  --[no-]create-session-in-dir     Pre-create a session in the current
                                   directory; in worktree mode this session
                                   stays in cwd while on-demand sessions get
                                   isolated worktrees (default: on)
`
    : ''
  const serverDescription = showServer
    ? `
  Remote Control runs as a persistent server that accepts multiple concurrent
  sessions in the current directory. One session is pre-created on start so
  you have somewhere to type immediately. Use --spawn=worktree to isolate
  each on-demand session in its own git worktree, or --spawn=session for
  the classic single-session mode (exits when that session ends). Press 'w'
  during runtime to toggle between same-dir and worktree.
`
    : ''
  const serverNote = showServer
    ? `  - Worktree mode requires a git repository or WorktreeCreate/WorktreeRemove hooks
`
    : ''
  const help = `
Remote Control - Connect your local environment to claude.ai/code

USAGE
  claude remote-control [options]
OPTIONS
  --name <name>                    Name for the session (shown in claude.ai/code)
${
  feature('KAIROS')
    ? `  -c, --continue                   Resume the last session in this directory
  --session-id <id>                Resume a specific session by ID (cannot be
                                   used with spawn flags or --continue)
`
    : ''
}  --permission-mode <mode>         Permission mode for spawned sessions
                                   (${modes})
  --debug-file <path>              Write debug logs to file
  -v, --verbose                    Enable verbose output
  -h, --help                       Show this help
${serverOptions}
DESCRIPTION
  Remote Control allows you to control sessions on your local device from
  claude.ai/code (https://claude.ai/code). Run this command in the
  directory you want to work in, then connect from the Claude app or web.
${serverDescription}
NOTES
  - You must be logged in with a Claude account that has a subscription
  - Run \`claude\` first in the directory to accept the workspace trust dialog
${serverNote}`
  console.log(help)
}

const TITLE_MAX_LEN = 80

/** 从用户消息派生 session 标题：取首行，截断。 */
function deriveSessionTitle(text: string): string {
  // 折叠空白 —— 换行/制表符会破坏单行状态展示。
  const flat = text.replace(/\s+/g, ' ').trim()
  return truncateToWidth(flat, TITLE_MAX_LEN)
}

/**
 * 通过 GET /v1/sessions/{id} 一次性拉取 session 标题。
 *
 * 用 createSession.ts 的 `getBridgeSession`（ccr-byoc headers + org UUID），
 * 而不是 environments 级别的 bridgeApi client —— 后者的 headers 会让
 * Sessions API 返回 404。session 还没标题或拉取失败时返回 undefined ——
 * 调用方会回退到从首条用户消息派生标题。
 */
async function fetchSessionTitle(
  compatSessionId: string,
  baseUrl: string,
): Promise<string | undefined> {
  const { getBridgeSession } = await import('./createSession.js')
  const session = await getBridgeSession(compatSessionId, { baseUrl })
  return session?.title || undefined
}

export async function bridgeMain(args: string[]): Promise<void> {
  const parsed = parseArgs(args)

  if (parsed.help) {
    await printHelp()
    return
  }
  if (parsed.error) {
    console.error(`Error: ${parsed.error}`)
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(1)
  }

  const {
    verbose,
    sandbox,
    debugFile,
    sessionTimeoutMs,
    permissionMode,
    name,
    spawnMode: parsedSpawnMode,
    capacity: parsedCapacity,
    createSessionInDir: parsedCreateSessionInDir,
    sessionId: parsedSessionId,
    continueSession,
  } = parsed
  // 用 let 是为了让 --continue 能从 pointer 文件设置它。下面的 #20460
  // resume 流程随后会把它当作显式 --session-id 一样处理。
  let resumeSessionId = parsedSessionId
  // --continue 找到 pointer 时，这是 pointer 来源目录（可能是 worktree
  // 兄弟目录，不是 `dir`）。resume 流程确定性失败时，清掉这个文件，避免
  // --continue 一直撞同一个 dead session。显式 --session-id 时为 undefined
  //（不动 pointer）。
  let resumePointerDir: string | undefined

  const usedMultiSessionFeature =
    parsedSpawnMode !== undefined ||
    parsedCapacity !== undefined ||
    parsedCreateSessionInDir !== undefined

  // 早一点校验 permission mode，让用户在 bridge 开始 poll work 之前就看到
  // 错误。
  if (permissionMode !== undefined) {
    const { PERMISSION_MODES } = await import('../types/permissions.js')
    const valid: readonly string[] = PERMISSION_MODES
    if (!valid.includes(permissionMode)) {
      console.error(
        `Error: Invalid permission mode '${permissionMode}'. Valid modes: ${valid.join(', ')}`,
      )
      // eslint-disable-next-line custom-rules/no-process-exit
      process.exit(1)
    }
  }

  const dir = resolve('.')

  // bridge 快速路径绕过 init.ts，所以必须在任何会传递调用 getGlobalConfig()
  // 的代码之前先启用 config 读取。
  const { enableConfigs, checkHasTrustDialogAccepted } = await import(
    '../utils/config.js'
  )
  enableConfigs()

  // 初始化 analytics 和 error reporting sinks。bridge 绕过 setup() init 流程，
  // 所以这里直接调 initSinks() 来挂上 sinks。
  const { initSinks } = await import('../utils/sinks.js')
  initSinks()

  // Gate-aware 校验：--spawn / --capacity / --create-session-in-dir 需要
  // multi-session gate。parseArgs 已经校验过 flag 组合；这里只查 gate，
  // 因为它需要一次 async 的 GrowthBook 调用。在 enableConfigs()（GrowthBook
  // 缓存读 global config）之后、initSinks() 之后跑 —— 这样 denial 事件能入队。
  const multiSessionEnabled = await isMultiSessionSpawnEnabled()
  if (usedMultiSessionFeature && !multiSessionEnabled) {
    await logEventAsync('tengu_bridge_multi_session_denied', {
      used_spawn: parsedSpawnMode !== undefined,
      used_capacity: parsedCapacity !== undefined,
      used_create_session_in_dir: parsedCreateSessionInDir !== undefined,
    })
    // logEventAsync 只入队 —— process.exit() 会丢弃缓冲的事件。显式 flush，
    // 上限 500ms，与 gracefulShutdown.ts 对齐。（sleep() 没有 unref 自己的
    // timer，但紧接着就是 process.exit()，所以 ref'd timer 拖不住 shutdown。）
    await Promise.race([
      Promise.all([shutdown1PEventLogging(), shutdownDatadog()]),
      sleep(500, undefined, { unref: true }),
    ]).catch(() => {})
    console.error(
      'Error: Multi-session Remote Control is not enabled for your account yet.',
    )
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(1)
  }

  // 设置 bootstrap CWD，让 trust 校验、project config 查找、git 工具
  //（getBranch、getRemoteUrl）都按正确的路径解析。
  const { setOriginalCwd, setCwdState } = await import('../bootstrap/state.js')
  setOriginalCwd(dir)
  setCwdState(dir)

  // bridge 绕过 main.tsx（它通过 showSetupScreens 渲染交互式 TrustDialog），
  // 所以必须校验 trust 是否在之前的普通 `claude` session 中已经建立。
  if (!checkHasTrustDialogAccepted()) {
    console.error(
      `Error: Workspace not trusted. Please run \`claude\` in ${dir} first to review and accept the workspace trust dialog.`,
    )
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(1)
  }

  // 解析 auth
  const { clearOAuthTokenCache, checkAndRefreshOAuthTokenIfNeeded } =
    await import('../utils/auth.js')
  const { getBridgeAccessToken, getBridgeBaseUrl } = await import(
    './bridgeConfig.js'
  )

  const bridgeToken = getBridgeAccessToken()
  if (!bridgeToken) {
    console.error(BRIDGE_LOGIN_ERROR)
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(1)
  }

  // 首次 remote 对话 —— 解释 bridge 是干什么的并征得同意
  const {
    getGlobalConfig,
    saveGlobalConfig,
    getCurrentProjectConfig,
    saveCurrentProjectConfig,
  } = await import('../utils/config.js')
  if (!getGlobalConfig().remoteDialogSeen) {
    const readline = await import('readline')
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })
    console.log(
      '\nRemote Control lets you access this CLI session from the web (claude.ai/code)\nor the Claude app, so you can pick up where you left off on any device.\n\nYou can disconnect remote access anytime by running /remote-control again.\n',
    )
    const answer = await new Promise<string>(resolve => {
      rl.question('Enable Remote Control? (y/n) ', resolve)
    })
    rl.close()
    saveGlobalConfig(current => {
      if (current.remoteDialogSeen) return current
      return { ...current, remoteDialogSeen: true }
    })
    if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
      // eslint-disable-next-line custom-rules/no-process-exit
      process.exit(0)
    }
  }

  // --continue：从崩溃恢复 pointer 解析最近的 session，链入 #20460 的
  // --session-id 流程。Worktree-aware：先查当前目录（快路径，零 exec），
  // 没命中再扇出到 git worktree 兄弟目录 —— REPL bridge 写的是
  // getOriginalCwd()，而 EnterWorktreeTool/activeWorktreeSession 可能把它
  // 指向一个 worktree，此时用户的 shell 还在 repo 根目录。
  // KAIROS-gated at parseArgs —— continueSession 在外部构建里永远是 false，
  // 所以这个块会被 tree-shake 掉。
  if (feature('KAIROS') && continueSession) {
    const { readBridgePointerAcrossWorktrees } = await import(
      './bridgePointer.js'
    )
    const found = await readBridgePointerAcrossWorktrees(dir)
    if (!found) {
      console.error(
        `Error: No recent session found in this directory or its worktrees. Run \`claude remote-control\` to start a new one.`,
      )
      // eslint-disable-next-line custom-rules/no-process-exit
      process.exit(1)
    }
    const { pointer, dir: pointerDir } = found
    const ageMin = Math.round(pointer.ageMs / 60_000)
    const ageStr = ageMin < 60 ? `${ageMin}m` : `${Math.round(ageMin / 60)}h`
    const fromWt = pointerDir !== dir ? ` from worktree ${pointerDir}` : ''
    console.error(
      `Resuming session ${pointer.sessionId} (${ageStr} ago)${fromWt}\u2026`,
    )
    resumeSessionId = pointer.sessionId
    // 记下 pointer 来源目录，以便下面 #20460 的 exit(1) 路径在确定性失败
    // 时能清掉正确的文件 —— 否则 --continue 会一直撞同一个 dead session。
    // 可能是 worktree 兄弟目录。
    resumePointerDir = pointerDir
  }

  // 生产环境里 baseUrl 是 Anthropic API（来自 OAuth config）。
  // CLAUDE_BRIDGE_BASE_URL 只用于 ant 本地开发 override。
  const baseUrl = getBridgeBaseUrl()

  // 非 localhost 目标必须用 HTTPS 来保护凭据。
  if (
    baseUrl.startsWith('http://') &&
    !baseUrl.includes('localhost') &&
    !baseUrl.includes('127.0.0.1')
  ) {
    console.error(
      'Error: Remote Control base URL uses HTTP. Only HTTPS or localhost HTTP is allowed.',
    )
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(1)
  }

  // WebSocket 连接用的 Session ingress URL。生产环境里它和 baseUrl 相同
  //（Envoy 把 /v1/session_ingress/* 路由到 session-ingress）。本地环境下，
  // session-ingress 跑在另一个端口（9413），与 contain-provide-api（8211）
  // 不同，所以必须显式设置 CLAUDE_BRIDGE_SESSION_INGRESS_URL。Ant-only，
  // 与 CLAUDE_BRIDGE_BASE_URL 对应。
  const sessionIngressUrl =
    process.env.CLAUDE_BRIDGE_SESSION_INGRESS_URL || baseUrl

  const { getBranch, getRemoteUrl, findGitRoot } = await import(
    '../utils/git.js'
  )

  // 预查 worktree 可用性，用于 first-run 对话和 `w` 切换。无条件做，这样
  // 一开始就知道 worktree 是不是可选项。
  const { hasWorktreeCreateHook } = await import('../utils/hooks.js')
  const worktreeAvailable = hasWorktreeCreateHook() || findGitRoot(dir) !== null

  // 加载按项目保存的 spawn-mode 偏好。由 multiSessionEnabled 控制，让
  // GrowthBook rollback 能干净地把用户退回 single-session —— 否则一个
  // 已保存的偏好会悄悄重新启用 multi-session 行为（worktree 隔离、32 个
  // max session、w 切换），即便 gate 已经关掉。同时防一个 stale worktree
  // 偏好 —— 可能这个目录曾经是 git repo（或用户复制了 config），清掉它
  // 避免每次启动都重复警告。
  let savedSpawnMode = multiSessionEnabled
    ? getCurrentProjectConfig().remoteControlSpawnMode
    : undefined
  if (savedSpawnMode === 'worktree' && !worktreeAvailable) {
    console.error(
      'Warning: Saved spawn mode is worktree but this directory is not a git repository. Falling back to same-dir.',
    )
    savedSpawnMode = undefined
    saveCurrentProjectConfig(current => {
      if (current.remoteControlSpawnMode === undefined) return current
      return { ...current, remoteControlSpawnMode: undefined }
    })
  }

  // First-run spawn-mode 选择：在每个项目里这个选择有意义时问一次
  //（gate 开、两种模式都可用、没显式 override、不在 resume）。保存到
  // ProjectConfig，后续运行就跳过。
  if (
    multiSessionEnabled &&
    !savedSpawnMode &&
    worktreeAvailable &&
    parsedSpawnMode === undefined &&
    !resumeSessionId &&
    process.stdin.isTTY
  ) {
    const readline = await import('readline')
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })
    console.log(
      `\nClaude Remote Control is launching in spawn mode which lets you create new sessions in this project from Claude Code on Web or your Mobile app. Learn more here: https://code.claude.com/docs/en/remote-control\n\n` +
        `Spawn mode for this project:\n` +
        `  [1] same-dir \u2014 sessions share the current directory (default)\n` +
        `  [2] worktree \u2014 each session gets an isolated git worktree\n\n` +
        `This can be changed later or explicitly set with --spawn=same-dir or --spawn=worktree.\n`,
    )
    const answer = await new Promise<string>(resolve => {
      rl.question('Choose [1/2] (default: 1): ', resolve)
    })
    rl.close()
    const chosen: 'same-dir' | 'worktree' =
      answer.trim() === '2' ? 'worktree' : 'same-dir'
    savedSpawnMode = chosen
    logEvent('tengu_bridge_spawn_mode_chosen', {
      spawn_mode:
        chosen as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    saveCurrentProjectConfig(current => {
      if (current.remoteControlSpawnMode === chosen) return current
      return { ...current, remoteControlSpawnMode: chosen }
    })
  }

  // 决定 effective spawn mode。
  // 优先级：resume > 显式 --spawn > 已保存的项目偏好 > gate 默认
  // - 通过 --continue / --session-id resume：永远是 single-session
  //  （resume 目标是原目录中的某一个特定 session）
  // - 显式 --spawn flag：直接用那个值（不持久化）
  // - 已保存的 ProjectConfig.remoteControlSpawnMode：由 first-run 对话或
  //  `w` 设置
  // - gate 开时的默认：same-dir（持久 multi-session，共享 cwd）
  // - gate 关时的默认：single-session（不变的 legacy 行为）
  // 追踪 spawn mode 是怎么决定的，用于 rollout 埋点。
  type SpawnModeSource = 'resume' | 'flag' | 'saved' | 'gate_default'
  let spawnModeSource: SpawnModeSource
  let spawnMode: SpawnMode
  if (resumeSessionId) {
    spawnMode = 'single-session'
    spawnModeSource = 'resume'
  } else if (parsedSpawnMode !== undefined) {
    spawnMode = parsedSpawnMode
    spawnModeSource = 'flag'
  } else if (savedSpawnMode !== undefined) {
    spawnMode = savedSpawnMode
    spawnModeSource = 'saved'
  } else {
    spawnMode = multiSessionEnabled ? 'same-dir' : 'single-session'
    spawnModeSource = 'gate_default'
  }
  const maxSessions =
    spawnMode === 'single-session'
      ? 1
      : (parsedCapacity ?? SPAWN_SESSIONS_DEFAULT)
  // 启动时预创建一个空 session，让用户立刻有地方可输入，跑在当前目录
  //（spawn 循环里豁免它，不创建 worktree）。默认开启；
  // --no-create-session-in-dir 选择关闭，做一个纯按需 server，每个 session
  // 都是隔离的。创建位置那边的 effectiveResumeSessionId 守卫处理 resume
  // 情况（resume 成功时跳过创建；env-mismatch 回退时落回新创建）。
  const preCreateSession = parsedCreateSessionInDir ?? true

  // 没 --continue 时：残留的 pointer 意味着上次没干净 shutdown（崩溃、
  // kill -9、终端关闭）。清掉它，避免 stale env 一直留着。所有模式都跑
  //（clearBridgePointer 在文件不存在时是 no-op）—— 覆盖 gate 切换场景：
  // 用户在 single-session 模式崩溃，然后切到 worktree 模式重新启动。
  // 只有 single-session 模式才会写新 pointer。
  if (!resumeSessionId) {
    const { clearBridgePointer } = await import('./bridgePointer.js')
    await clearBridgePointer(dir)
  }

  // Worktree 模式需要 git 或 WorktreeCreate/WorktreeRemove hooks。只能
  // 通过显式 --spawn=worktree 触发（默认是 same-dir）；已保存的 worktree
  // 偏好上面已经守过了。
  if (spawnMode === 'worktree' && !worktreeAvailable) {
    console.error(
      `Error: Worktree mode requires a git repository or WorktreeCreate hooks configured. Use --spawn=session for single-session mode.`,
    )
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(1)
  }

  const branch = await getBranch()
  const gitRepoUrl = await getRemoteUrl()
  const machineName = hostname()
  const bridgeId = randomUUID()

  const { handleOAuth401Error } = await import('../utils/auth.js')
  const api = createBridgeApiClient({
    baseUrl,
    getAccessToken: getBridgeAccessToken,
    runnerVersion: MACRO.VERSION,
    onDebug: logForDebugging,
    onAuth401: handleOAuth401Error,
    getTrustedDeviceToken,
  })

  // 通过 --session-id resume 时，拉取它以拿到 environment_id，并复用它来
  // 注册（对后端是幂等的）。否则保持 undefined —— 后端拒绝客户端生成的
  // UUID，会分配一个新的 environment。
  // feature('KAIROS') gate：--session-id 是 ant-only；parseArgs 已经在 gate
  // 关闭时拒绝这个 flag，所以外部构建里 resumeSessionId 在这里永远是
  // undefined —— 这个守卫是为了 tree-shaking。
  let reuseEnvironmentId: string | undefined
  if (feature('KAIROS') && resumeSessionId) {
    try {
      validateBridgeId(resumeSessionId, 'sessionId')
    } catch {
      console.error(
        `Error: Invalid session ID "${resumeSessionId}". Session IDs must not contain unsafe characters.`,
      )
      // eslint-disable-next-line custom-rules/no-process-exit
      process.exit(1)
    }
    // 主动刷新 OAuth token —— getBridgeSession 用的是原生 axios，没有
    // withOAuthRetry 的 401-refresh 逻辑。否则一个过期但仍存在的 token 会
    // 产生误导性的 "not found" 错误。
    await checkAndRefreshOAuthTokenIfNeeded()
    clearOAuthTokenCache()
    const { getBridgeSession } = await import('./createSession.js')
    const session = await getBridgeSession(resumeSessionId, {
      baseUrl,
      getAccessToken: getBridgeAccessToken,
    })
    if (!session) {
      // 服务器上 session 没了 → pointer 是 stale 的。清掉它，避免下次启动
      // 又问一次。（显式 --session-id 不动 pointer —— 它是独立的文件，
      // 用户甚至可能没有。）resumePointerDir 可能是 worktree 兄弟 —— 清
      // 那个文件。
      if (resumePointerDir) {
        const { clearBridgePointer } = await import('./bridgePointer.js')
        await clearBridgePointer(resumePointerDir)
      }
      console.error(
        `Error: Session ${resumeSessionId} not found. It may have been archived or expired, or your login may have lapsed (run \`claude /login\`).`,
      )
      // eslint-disable-next-line custom-rules/no-process-exit
      process.exit(1)
    }
    if (!session.environment_id) {
      if (resumePointerDir) {
        const { clearBridgePointer } = await import('./bridgePointer.js')
        await clearBridgePointer(resumePointerDir)
      }
      console.error(
        `Error: Session ${resumeSessionId} has no environment_id. It may never have been attached to a bridge.`,
      )
      // eslint-disable-next-line custom-rules/no-process-exit
      process.exit(1)
    }
    reuseEnvironmentId = session.environment_id
    logForDebugging(
      `[bridge:init] Resuming session ${resumeSessionId} on environment ${reuseEnvironmentId}`,
    )
  }

  const config: BridgeConfig = {
    dir,
    machineName,
    branch,
    gitRepoUrl,
    maxSessions,
    spawnMode,
    verbose,
    sandbox,
    bridgeId,
    workerType: 'claude_code',
    environmentId: randomUUID(),
    reuseEnvironmentId,
    apiBaseUrl: baseUrl,
    sessionIngressUrl,
    debugFile,
    sessionTimeoutMs,
  }

  logForDebugging(
    `[bridge:init] bridgeId=${bridgeId}${reuseEnvironmentId ? ` reuseEnvironmentId=${reuseEnvironmentId}` : ''} dir=${dir} branch=${branch} gitRepoUrl=${gitRepoUrl} machine=${machineName}`,
  )
  logForDebugging(
    `[bridge:init] apiBaseUrl=${baseUrl} sessionIngressUrl=${sessionIngressUrl}`,
  )
  logForDebugging(
    `[bridge:init] sandbox=${sandbox}${debugFile ? ` debugFile=${debugFile}` : ''}`,
  )

  // 在进入 poll 循环之前注册 bridge environment。
  let environmentId: string
  let environmentSecret: string
  try {
    const reg = await api.registerBridgeEnvironment(config)
    environmentId = reg.environment_id
    environmentSecret = reg.environment_secret
  } catch (err) {
    logEvent('tengu_bridge_registration_failed', {
      status: err instanceof BridgeFatalError ? err.status : undefined,
    })
    // 注册失败是致命的 —— 打印干净的消息而不是 stack trace。
    console.error(
      err instanceof BridgeFatalError && err.status === 404
        ? 'Remote Control environments are not available for your account.'
        : `Error: ${errorMessage(err)}`,
    )
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(1)
  }

  // 追踪 --session-id resume 流程是否成功完成。下面用它来跳过新 session
  // 创建并种下 initialSessionId。env mismatch 时清空，优雅地回退到新
  // session。
  let effectiveResumeSessionId: string | undefined
  if (feature('KAIROS') && resumeSessionId) {
    if (reuseEnvironmentId && environmentId !== reuseEnvironmentId) {
      // 后端返回了一个不同的 environment_id —— 原 env 已经过期或被回收。
      // 对新 env 做 reconnect 不会成功（session 绑在旧 env 上）。记 sentry
      // 留痕，落回新 env 上的 fresh session 创建。
      logError(
        new Error(
          `Bridge resume env mismatch: requested ${reuseEnvironmentId}, backend returned ${environmentId}. Falling back to fresh session.`,
        ),
      )
      console.warn(
        `Warning: Could not resume session ${resumeSessionId} — its environment has expired. Creating a fresh session instead.`,
      )
      // 不 deregister —— 我们要用这个新 environment。
      // effectiveResumeSessionId 保持 undefined → 下面走 fresh session 路径。
    } else {
      // 强制停掉这个 session 的所有 stale worker 实例并重新入队，让我们的
      // poll 循环能拿到它。必须在注册之后做 —— 后端需要知道 environment 上
      // 有一个活着的 worker。
      //
      // pointer 存的是 session_* ID，但 ccr_v2_compat_enabled 开启时
      // /bridge/reconnect 用 infra tag（cse_*）查 session。两种都试一次；
      // 如果本来就是 cse_*，转换是 no-op。
      const infraResumeId = toInfraSessionId(resumeSessionId)
      const reconnectCandidates =
        infraResumeId === resumeSessionId
          ? [resumeSessionId]
          : [resumeSessionId, infraResumeId]
      let reconnected = false
      let lastReconnectErr: unknown
      for (const candidateId of reconnectCandidates) {
        try {
          await api.reconnectSession(environmentId, candidateId)
          logForDebugging(
            `[bridge:init] Session ${candidateId} re-queued via bridge/reconnect`,
          )
          effectiveResumeSessionId = resumeSessionId
          reconnected = true
          break
        } catch (err) {
          lastReconnectErr = err
          logForDebugging(
            `[bridge:init] reconnectSession(${candidateId}) failed: ${errorMessage(err)}`,
          )
        }
      }
      if (!reconnected) {
        const err = lastReconnectErr

        // 瞬时 reconnect 失败时不要 deregister —— 此时 environmentId 就是
        // session 自己的 environment。deregister 会让重试不可能。后端的 4h
        // TTL 会清理。
        const isFatal = err instanceof BridgeFatalError
        // 仅在致命 reconnect 失败时清 pointer。瞬时失败（"再跑一次同样的
        // 命令"）应保留 pointer，让下次启动重新提示 —— 那才是重试机制。
        if (resumePointerDir && isFatal) {
          const { clearBridgePointer } = await import('./bridgePointer.js')
          await clearBridgePointer(resumePointerDir)
        }
        console.error(
          isFatal
            ? `Error: ${errorMessage(err)}`
            : `Error: Failed to reconnect session ${resumeSessionId}: ${errorMessage(err)}\nThe session may still be resumable — try running the same command again.`,
        )
        // eslint-disable-next-line custom-rules/no-process-exit
        process.exit(1)
      }
    }
  }

  logForDebugging(
    `[bridge:init] Registered, server environmentId=${environmentId}`,
  )
  const startupPollConfig = getPollIntervalConfig()
  logEvent('tengu_bridge_started', {
    max_sessions: config.maxSessions,
    has_debug_file: !!config.debugFile,
    sandbox: config.sandbox,
    verbose: config.verbose,
    heartbeat_interval_ms:
      startupPollConfig.non_exclusive_heartbeat_interval_ms,
    spawn_mode:
      config.spawnMode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    spawn_mode_source:
      spawnModeSource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    multi_session_gate: multiSessionEnabled,
    pre_create_session: preCreateSession,
    worktree_available: worktreeAvailable,
  })
  logForDiagnosticsNoPII('info', 'bridge_started', {
    max_sessions: config.maxSessions,
    sandbox: config.sandbox,
    spawn_mode: config.spawnMode,
  })

  const spawner = createSessionSpawner({
    execPath: process.execPath,
    scriptArgs: spawnScriptArgs(),
    env: process.env,
    verbose,
    sandbox,
    debugFile,
    permissionMode,
    onDebug: logForDebugging,
    onActivity: (sessionId, activity) => {
      logForDebugging(
        `[bridge:activity] sessionId=${sessionId} ${activity.type} ${activity.summary}`,
      )
    },
    onPermissionRequest: (sessionId, request, _accessToken) => {
      logForDebugging(
        `[bridge:perm] sessionId=${sessionId} tool=${request.request.tool_name} request_id=${request.request_id} (not auto-approving)`,
      )
    },
  })

  const logger = createBridgeLogger({ verbose })
  const { parseGitHubRepository } = await import('../utils/detectRepository.js')
  const ownerRepo = gitRepoUrl ? parseGitHubRepository(gitRepoUrl) : null
  // 用解析出的 owner/repo 中的 repo 名，否则回退到 dir basename
  const repoName = ownerRepo ? ownerRepo.split('/').pop()! : basename(dir)
  logger.setRepoInfo(repoName, branch)

  // `w` 切换仅在我们处于 multi-session 模式且 worktree 是可选项时可用。
  // 不可用时隐藏 mode 后缀和提示。
  const toggleAvailable = spawnMode !== 'single-session' && worktreeAvailable
  if (toggleAvailable) {
    // 安全 cast：spawnMode 不是 single-session（上面已校验），而
    // saved-worktree-in-non-git 守卫 + 上面的 exit 校验保证 worktree 只在
    // 可用时才会走到。
    logger.setSpawnModeDisplay(spawnMode as 'same-dir' | 'worktree')
  }

  // 监听按键：space 切换 QR 码，w 切换 spawn 模式
  const onStdinData = (data: Buffer): void => {
    if (data[0] === 0x03 || data[0] === 0x04) {
      // Ctrl+C / Ctrl+D —— 触发优雅 shutdown
      process.emit('SIGINT')
      return
    }
    if (data[0] === 0x20 /* space */) {
      logger.toggleQr()
      return
    }
    if (data[0] === 0x77 /* 'w' */) {
      if (!toggleAvailable) return
      const newMode: 'same-dir' | 'worktree' =
        config.spawnMode === 'same-dir' ? 'worktree' : 'same-dir'
      config.spawnMode = newMode
      logEvent('tengu_bridge_spawn_mode_toggled', {
        spawn_mode:
          newMode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      logger.logStatus(
        newMode === 'worktree'
          ? 'Spawn mode: worktree (new sessions get isolated git worktrees)'
          : 'Spawn mode: same-dir (new sessions share the current directory)',
      )
      logger.setSpawnModeDisplay(newMode)
      logger.refreshDisplay()
      saveCurrentProjectConfig(current => {
        if (current.remoteControlSpawnMode === newMode) return current
        return { ...current, remoteControlSpawnMode: newMode }
      })
      return
    }
  }
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on('data', onStdinData)
  }

  const controller = new AbortController()
  const onSigint = (): void => {
    logForDebugging('[bridge:shutdown] SIGINT received, shutting down')
    controller.abort()
  }
  const onSigterm = (): void => {
    logForDebugging('[bridge:shutdown] SIGTERM received, shutting down')
    controller.abort()
  }
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)

  // 自动创建一个空 session，让用户立刻有地方可输入（与 /remote-control 行为
  // 一致）。由 preCreateSession 控制：默认开启；--no-create-session-in-dir
  // 选择关闭。当 --session-id resume 成功时，完全跳过创建 —— session 已
  // 存在，bridge/reconnect 已经重新入队。当 resume 被请求但 env mismatch
  // 失败时，effectiveResumeSessionId 是 undefined，落回到 fresh session 创建
  //（遵循上面打印的 "Creating a fresh session instead" 警告）。
  let initialSessionId: string | null =
    feature('KAIROS') && effectiveResumeSessionId
      ? effectiveResumeSessionId
      : null
  if (preCreateSession && !(feature('KAIROS') && effectiveResumeSessionId)) {
    const { createBridgeSession } = await import('./createSession.js')
    try {
      initialSessionId = await createBridgeSession({
        environmentId,
        title: name,
        events: [],
        gitRepoUrl,
        branch,
        signal: controller.signal,
        baseUrl,
        getAccessToken: getBridgeAccessToken,
        permissionMode,
      })
      if (initialSessionId) {
        logForDebugging(
          `[bridge:init] Created initial session ${initialSessionId}`,
        )
      }
    } catch (err) {
      logForDebugging(
        `[bridge:init] Session creation failed (non-fatal): ${errorMessage(err)}`,
      )
    }
  }

  // 崩溃恢复 pointer：立刻写入，这样在这之后的任何时刻 kill -9 都会留下
  // 一条可恢复的轨迹。覆盖 fresh session 和 resumed session（这样 resume
  // 之后再次崩溃仍然可恢复）。runBridgeLoop 落到 archive+deregister 时清掉；
  // SIGINT 可 resume shutdown 返回路径上保留（作为用户在抄打印出来的
  // --session-id 提示前关掉终端时的备份）。每小时刷新一次，这样 5h+ 的
  // session 崩溃时仍然有新鲜的 pointer（staleness 校验文件 mtime，后端
  // TTL 是 rolling-from-poll）。
  let pointerRefreshTimer: ReturnType<typeof setInterval> | null = null
  // 仅 single-session：--continue 在 resume 时强制 single-session 模式，
  // 所以 multi-session 模式写的 pointer 会与用户 resume 时的配置矛盾。
  // 可 resume shutdown 路径也 gate 到 single-session（约 line 1254），否则
  // pointer 会变成孤儿。
  if (initialSessionId && spawnMode === 'single-session') {
    const { writeBridgePointer } = await import('./bridgePointer.js')
    const pointerPayload = {
      sessionId: initialSessionId,
      environmentId,
      source: 'standalone' as const,
    }
    await writeBridgePointer(config.dir, pointerPayload)
    pointerRefreshTimer = setInterval(
      writeBridgePointer,
      60 * 60 * 1000,
      config.dir,
      pointerPayload,
    )
    // 别让这个 interval 自己拖住进程。
    pointerRefreshTimer.unref?.()
  }

  try {
    await runBridgeLoop(
      config,
      environmentId,
      environmentSecret,
      api,
      spawner,
      logger,
      controller.signal,
      undefined,
      initialSessionId ?? undefined,
      async () => {
        // 清掉 memoize 的 OAuth token 缓存，重新从安全存储读，拿到子进程
        // 刷新的 token。
        clearOAuthTokenCache()
        // 如果磁盘上的 token 也过期了，主动刷新一下。
        await checkAndRefreshOAuthTokenIfNeeded()
        return getBridgeAccessToken()
      },
    )
  } finally {
    if (pointerRefreshTimer !== null) {
      clearInterval(pointerRefreshTimer)
    }
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
    process.stdin.off('data', onStdinData)
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false)
    }
    process.stdin.pause()
  }

  // bridge 绕过 init.ts（以及它的 graceful shutdown handler），所以必须
  // 显式退出。
  // eslint-disable-next-line custom-rules/no-process-exit
  process.exit(0)
}

// ─── Headless bridge（daemon worker）────────────────────────────────────────

/**
 * 由 runBridgeHeadless 在 supervisor 不应该重试的配置问题上抛出
 *（trust 未接受、worktree 不可用、http-not-https）。daemon worker 捕获后
 * 以 EXIT_CODE_PERMANENT 退出，让 supervisor 把 worker 停在那，而不是按
 * backoff 不断重启。
 */
export class BridgeHeadlessPermanentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BridgeHeadlessPermanentError'
  }
}

export type HeadlessBridgeOpts = {
  dir: string
  name?: string
  spawnMode: 'same-dir' | 'worktree'
  capacity: number
  permissionMode?: string
  sandbox: boolean
  sessionTimeoutMs?: number
  createSessionOnStart: boolean
  getAccessToken: () => string | undefined
  onAuth401: (failedToken: string) => Promise<boolean>
  log: (s: string) => void
}

/**
 * `remoteControl` daemon worker 的非交互式 bridge 入口。
 *
 * bridgeMain() 的线性子集：没有 readline 对话、没有 stdin 按键处理器、
 * 没有 TUI、没有 process.exit()。Config 由调用方传入（daemon.json），auth
 * 通过 IPC 传入（supervisor 的 AuthManager），日志走 worker 的 stdout
 * 管道。致命错误时抛出 —— worker 捕获并把 permanent vs transient 映射到
 * 正确的退出码。
 *
 * `signal` abort 且 poll 循环拆除时正常 resolve。
 */
export async function runBridgeHeadless(
  opts: HeadlessBridgeOpts,
  signal: AbortSignal,
): Promise<void> {
  const { dir, log } = opts

  // worker 继承 supervisor 的 CWD。先 chdir，这样 git 工具
  //（getBranch/getRemoteUrl —— 它们从下面设置的 bootstrap CWD state 读）
  // 能按正确的 repo 解析。
  process.chdir(dir)
  const { setOriginalCwd, setCwdState } = await import('../bootstrap/state.js')
  setOriginalCwd(dir)
  setCwdState(dir)

  const { enableConfigs, checkHasTrustDialogAccepted } = await import(
    '../utils/config.js'
  )
  enableConfigs()
  const { initSinks } = await import('../utils/sinks.js')
  initSinks()

  if (!checkHasTrustDialogAccepted()) {
    throw new BridgeHeadlessPermanentError(
      `Workspace not trusted: ${dir}. Run \`claude\` in that directory first to accept the trust dialog.`,
    )
  }

  if (!opts.getAccessToken()) {
    // 瞬时错误 —— supervisor 的 AuthManager 可能在下一轮拿到 token。
    throw new Error(BRIDGE_LOGIN_ERROR)
  }

  const { getBridgeBaseUrl } = await import('./bridgeConfig.js')
  const baseUrl = getBridgeBaseUrl()
  if (
    baseUrl.startsWith('http://') &&
    !baseUrl.includes('localhost') &&
    !baseUrl.includes('127.0.0.1')
  ) {
    throw new BridgeHeadlessPermanentError(
      'Remote Control base URL uses HTTP. Only HTTPS or localhost HTTP is allowed.',
    )
  }
  const sessionIngressUrl =
    process.env.CLAUDE_BRIDGE_SESSION_INGRESS_URL || baseUrl

  const { getBranch, getRemoteUrl, findGitRoot } = await import(
    '../utils/git.js'
  )
  const { hasWorktreeCreateHook } = await import('../utils/hooks.js')

  if (opts.spawnMode === 'worktree') {
    const worktreeAvailable =
      hasWorktreeCreateHook() || findGitRoot(dir) !== null
    if (!worktreeAvailable) {
      throw new BridgeHeadlessPermanentError(
        `Worktree mode requires a git repository or WorktreeCreate hooks. Directory ${dir} has neither.`,
      )
    }
  }

  const branch = await getBranch()
  const gitRepoUrl = await getRemoteUrl()
  const machineName = hostname()
  const bridgeId = randomUUID()

  const config: BridgeConfig = {
    dir,
    machineName,
    branch,
    gitRepoUrl,
    maxSessions: opts.capacity,
    spawnMode: opts.spawnMode,
    verbose: false,
    sandbox: opts.sandbox,
    bridgeId,
    workerType: 'claude_code',
    environmentId: randomUUID(),
    apiBaseUrl: baseUrl,
    sessionIngressUrl,
    sessionTimeoutMs: opts.sessionTimeoutMs,
  }

  const api = createBridgeApiClient({
    baseUrl,
    getAccessToken: opts.getAccessToken,
    runnerVersion: MACRO.VERSION,
    onDebug: log,
    onAuth401: opts.onAuth401,
    getTrustedDeviceToken,
  })

  let environmentId: string
  let environmentSecret: string
  try {
    const reg = await api.registerBridgeEnvironment(config)
    environmentId = reg.environment_id
    environmentSecret = reg.environment_secret
  } catch (err) {
    // 瞬时错误 —— 让 supervisor 按背避重试。
    throw new Error(`Bridge registration failed: ${errorMessage(err)}`)
  }

  const spawner = createSessionSpawner({
    execPath: process.execPath,
    scriptArgs: spawnScriptArgs(),
    env: process.env,
    verbose: false,
    sandbox: opts.sandbox,
    permissionMode: opts.permissionMode,
    onDebug: log,
  })

  const logger = createHeadlessBridgeLogger(log)
  logger.printBanner(config, environmentId)

  let initialSessionId: string | undefined
  if (opts.createSessionOnStart) {
    const { createBridgeSession } = await import('./createSession.js')
    try {
      const sid = await createBridgeSession({
        environmentId,
        title: opts.name,
        events: [],
        gitRepoUrl,
        branch,
        signal,
        baseUrl,
        getAccessToken: opts.getAccessToken,
        permissionMode: opts.permissionMode,
      })
      if (sid) {
        initialSessionId = sid
        log(`created initial session ${sid}`)
      }
    } catch (err) {
      log(`session pre-creation failed (non-fatal): ${errorMessage(err)}`)
    }
  }

  await runBridgeLoop(
    config,
    environmentId,
    environmentSecret,
    api,
    spawner,
    logger,
    signal,
    undefined,
    initialSessionId,
    async () => opts.getAccessToken(),
  )
}

/** BridgeLogger 适配器：把所有调用都路由到一个单行 log 函数。 */
function createHeadlessBridgeLogger(log: (s: string) => void): BridgeLogger {
  const noop = (): void => {}
  return {
    printBanner: (cfg, envId) =>
      log(
        `registered environmentId=${envId} dir=${cfg.dir} spawnMode=${cfg.spawnMode} capacity=${cfg.maxSessions}`,
      ),
    logSessionStart: (id, _prompt) => log(`session start ${id}`),
    logSessionComplete: (id, ms) => log(`session complete ${id} (${ms}ms)`),
    logSessionFailed: (id, err) => log(`session failed ${id}: ${err}`),
    logStatus: log,
    logVerbose: log,
    logError: s => log(`error: ${s}`),
    logReconnected: ms => log(`reconnected after ${ms}ms`),
    addSession: (id, _url) => log(`session attached ${id}`),
    removeSession: id => log(`session detached ${id}`),
    updateIdleStatus: noop,
    updateReconnectingStatus: noop,
    updateSessionStatus: noop,
    updateSessionActivity: noop,
    updateSessionCount: noop,
    updateFailedStatus: noop,
    setSpawnModeDisplay: noop,
    setRepoInfo: noop,
    setDebugLogPath: noop,
    setAttached: noop,
    setSessionTitle: noop,
    clearStatus: noop,
    toggleQr: noop,
    refreshDisplay: noop,
  }
}
