// biome-ignore-all assist/source/organizeImports: ANT-ONLY 导入标记不可重排
/**
 * 无 env 层的 Remote Control bridge 核心。
 *
 * "Env-less" = 没有 Environments API 层。与 "CCR v2"（/worker/* transport
 * 协议）不同 —— 基于 env 的路径（replBridge.ts）也可以通过
 * CLAUDE_CODE_USE_CCR_V2 使用 CCR v2 transport。本文件关注的是移除
 * poll/派发层，与底层用哪个 transport 协议无关。
 *
 * 与 initBridgeCore（基于 env，约 2400 行）不同，这里直接连到
 * session-ingress 层，不经过 Environments API 的 work 派发层：
 *
 *   1. POST /v1/code/sessions              (OAuth，无 env_id) → session.id
 *   2. POST /v1/code/sessions/{id}/bridge  (OAuth)            → {worker_jwt, expires_in, api_base_url, worker_epoch}
 *      每次 /bridge 调用都会让 epoch 自增 —— 它本身就是注册。没有单独的
 *      /worker/register。
 *   3. createV2ReplTransport(worker_jwt, worker_epoch)        → SSE + CCRClient
 *   4. createTokenRefreshScheduler                           → 主动重新调用 /bridge（新 JWT + 新 epoch）
 *   5. SSE 上 401 → 用新的 /bridge 凭据重建 transport（保留 seq-num）
 *
 * 没有 register/poll/ack/stop/heartbeat/deregister 的 env 生命周期。
 * Environments API 历史上之所以存在，是因为 CCR 的 /worker/* endpoint
 * 需要带 session_id+role=worker 的 JWT，而那种 JWT 只有 work 派发层能签发。
 * 服务器 PR #292605（在 #293280 中改名）新增了 /bridge endpoint 作为
 * OAuth → worker_jwt 的直接交换，让 env 层对 REPL session 变成可选。
 *
 * 由 initReplBridge.ts 中的 `tengu_bridge_repl_v2` GrowthBook flag 门控。
 * 仅 REPL —— daemon/print 继续走 env-based。
 */

import { feature } from 'bun:bundle'
import axios from 'axios'
import {
  createV2ReplTransport,
  type ReplBridgeTransport,
} from './replBridgeTransport.js'
import { buildCCRv2SdkUrl } from './workSecret.js'
import { toCompatSessionId } from './sessionIdCompat.js'
import { FlushGate } from './flushGate.js'
import { createTokenRefreshScheduler } from './jwtUtils.js'
import { getTrustedDeviceToken } from './trustedDevice.js'
import {
  getEnvLessBridgeConfig,
  type EnvLessBridgeConfig,
} from './envLessBridgeConfig.js'
import {
  handleIngressMessage,
  handleServerControlRequest,
  makeResultMessage,
  isEligibleBridgeMessage,
  extractTitleText,
  shouldReportRunningForMessage,
  shouldReportRunningForMessages,
  BoundedUUIDSet,
} from './bridgeMessaging.js'
import { logBridgeSkip } from './debugUtils.js'
import { logForDebugging } from '../utils/debug.js'
import { logForDiagnosticsNoPII } from '../utils/diagLogs.js'
import { isInProtectedNamespace } from '../utils/envUtils.js'
import { errorMessage } from '../utils/errors.js'
import { sleep } from '../utils/sleep.js'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import type { ReplBridgeHandle, BridgeState } from './replBridge.js'
import type { Message } from '../types/message.js'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import type {
  SDKControlRequest,
  SDKControlResponse,
} from '../entrypoints/sdk/controlTypes.js'
import type { StdoutMessage } from '../entrypoints/sdk/controlTypes.js'
import type { PermissionMode } from '../utils/permissions/PermissionMode.js'
import { setSessionMetadataChangedListener } from '../utils/sessionState.js'

/**
 * 带可选 session_id 的 StdoutMessage。transport 层接收 StdoutMessage，
 * 但我们在运行时给它加上 session_id。用 optional 是因为类型系统无法
 * 验证给 union 类型加 session_id 永远合法，尽管运行时确实如此。
 *
 * 传给 transport 时需要用 'as StdoutMessage'，因为 TypeScript 无法
 * 验证带 session_id 的对象是合法的 StdoutMessage。
 */
type TransportMessage = StdoutMessage & { session_id?: string }

const ANTHROPIC_VERSION = '2023-06-01'

// ws_connected 的遥测区分字段。'initial' 是默认值，永远不会传给
// rebuildTransport（它只能在 init 之后调用）；Exclude<> 在两个签名处都
// 让该约束显式化。
type ConnectCause = 'initial' | 'proactive_refresh' | 'auth_401_recovery'

function oauthHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
  }
}

export type EnvLessBridgeParams = {
  baseUrl: string
  orgUUID: string
  title: string
  getAccessToken: () => string | undefined
  onAuth401?: (staleAccessToken: string) => Promise<boolean>
  /**
   * 把内部 Message[] 转成 SDKMessage[]，供 writeMessages() 和
   * initial-flush/drain 路径使用。注入而非直接 import —— mappers.ts 会
   * 传递性拉入 src/commands.ts（整个 command registry + React 树），
   * 会让没有这些的包膨胀。
   */
  toSDKMessages: (messages: Message[]) => SDKMessage[]
  initialHistoryCap: number
  initialMessages?: Message[]
  onInboundMessage?: (msg: SDKMessage) => void | Promise<void>
  /**
   * 在 writeMessages() 中看到的每条有资格当标题的 user 消息都会触发，
   * 直到回调返回 true（结束）。对应 replBridge.ts 的 onUserMessage ——
   * 调用方推导标题并 PATCH /v1/sessions/{id}，让自动启动的 session 不会
   * 停在通用兜底标题。调用方自负"count 1 和 3 时推导"的策略；transport
   * 只是一直调用直到被告停。sessionId 是原始 cse_* ——
   * updateBridgeSessionTitle 内部重新打 tag。
   */
  onUserMessage?: (text: string, sessionId: string) => boolean
  onPermissionResponse?: (response: SDKControlResponse) => void
  onInterrupt?: () => void
  onSetModel?: (model: string | undefined) => void
  onSetMaxThinkingTokens?: (maxTokens: number | null) => void
  onSetPermissionMode?: (
    mode: PermissionMode,
  ) => { ok: true } | { ok: false; error: string }
  onStateChange?: (state: BridgeState, detail?: string) => void
  /**
   * 为 true 时跳过打开 SSE 读流 —— 只激活 CCRClient 写路径。透传到
   * createV2ReplTransport 和 handleServerControlRequest。
   */
  outboundOnly?: boolean
  /** 自由格式的 tag，用于 session 分类（例如 ['ccr-mirror']）。 */
  tags?: string[]
}

/**
 * 创建 session、获取 worker JWT、连接 v2 transport。
 *
 * 任何前置失败（session 创建失败、/bridge 失败、transport 设置失败）都
 * 返回 null。调用方（initReplBridge）把它呈现为通用的"初始化失败"状态。
 */
export async function initEnvLessBridgeCore(
  params: EnvLessBridgeParams,
): Promise<ReplBridgeHandle | null> {
  const {
    baseUrl,
    orgUUID,
    title,
    getAccessToken,
    onAuth401,
    toSDKMessages,
    initialHistoryCap,
    initialMessages,
    onInboundMessage,
    onUserMessage,
    onPermissionResponse,
    onInterrupt,
    onSetModel,
    onSetMaxThinkingTokens,
    onSetPermissionMode,
    onStateChange,
    outboundOnly,
    tags,
  } = params

  const cfg = await getEnvLessBridgeConfig()

  // ── 1. 创建 session（POST /v1/code/sessions，无 env_id） ───────────────
  const accessToken = getAccessToken()
  if (!accessToken) {
    logForDebugging('[remote-bridge] No OAuth token')
    return null
  }

  const createdSessionId = await withRetry(
    () =>
      createCodeSession(baseUrl, accessToken, title, cfg.http_timeout_ms, tags),
    'createCodeSession',
    cfg,
  )
  if (!createdSessionId) {
    onStateChange?.('failed', 'Session creation failed — see debug log')
    logBridgeSkip('v2_session_create_failed', undefined, true)
    return null
  }
  const sessionId: string = createdSessionId
  logForDebugging(`[remote-bridge] Created session ${sessionId}`)
  logForDiagnosticsNoPII('info', 'bridge_repl_v2_session_created')

  // ── 2. 获取 bridge 凭据（POST /bridge → worker_jwt, expires_in, api_base_url） ──
  const credentials = await withRetry(
    () =>
      fetchRemoteCredentials(
        sessionId,
        baseUrl,
        accessToken,
        cfg.http_timeout_ms,
      ),
    'fetchRemoteCredentials',
    cfg,
  )
  if (!credentials) {
    onStateChange?.('failed', 'Remote credentials fetch failed — see debug log')
    logBridgeSkip('v2_remote_creds_failed', undefined, true)
    void archiveSession(
      sessionId,
      baseUrl,
      accessToken,
      orgUUID,
      cfg.http_timeout_ms,
    )
    return null
  }
  logForDebugging(
    `[remote-bridge] Fetched bridge credentials (expires_in=${credentials.expires_in}s)`,
  )

  // ── 3. 构建 v2 transport（SSETransport + CCRClient） ────────────────────
  const sessionUrl = buildCCRv2SdkUrl(credentials.api_base_url, sessionId)
  logForDebugging(`[remote-bridge] v2 session URL: ${sessionUrl}`)

  let transport: ReplBridgeTransport
  try {
    transport = await createV2ReplTransport({
      sessionUrl,
      ingressToken: credentials.worker_jwt,
      sessionId,
      epoch: credentials.worker_epoch,
      heartbeatIntervalMs: cfg.heartbeat_interval_ms,
      heartbeatJitterFraction: cfg.heartbeat_jitter_fraction,
      // per-instance 闭包 —— 把 worker JWT 排除在
      // process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN 之外，否则
      // mcp/client.ts 会无门控地读它，发到用户配置的 ws/http MCP 服务器。
      // 构造时冻结是正确的：refresh 时整个 transport 重建（见下面
      // rebuildTransport）。
      getAuthToken: () => credentials.worker_jwt,
      outboundOnly,
    })
  } catch (err) {
    logForDebugging(
      `[remote-bridge] v2 transport setup failed: ${errorMessage(err)}`,
      { level: 'error' },
    )
    onStateChange?.('failed', `Transport setup failed: ${errorMessage(err)}`)
    logBridgeSkip('v2_transport_setup_failed', undefined, true)
    void archiveSession(
      sessionId,
      baseUrl,
      accessToken,
      orgUUID,
      cfg.http_timeout_ms,
    )
    return null
  }
  logForDebugging(
    `[remote-bridge] v2 transport created (epoch=${credentials.worker_epoch})`,
  )
  onStateChange?.('ready')

  // ── 4. 状态 ────────────────────────────────────────────────────────────

  // Echo 去重：我们 POST 的消息会在读流上回弹。用 initial 消息 UUID 作为
  // 种子，让服务器回弹的已 flush 历史被识别。两个集合都覆盖 initial
  // UUID —— recentPostedUUIDs 是容量 2000 的环形缓冲，足够多实时写入后
  // 会把它们淘汰；initialMessageUUIDs 是无界兜底。纵深防御；镜像
  // replBridge.ts。
  const recentPostedUUIDs = new BoundedUUIDSet(cfg.uuid_dedup_buffer_size)
  const initialMessageUUIDs = new Set<string>()
  if (initialMessages) {
    for (const msg of initialMessages) {
      initialMessageUUIDs.add(msg.uuid)
      recentPostedUUIDs.add(msg.uuid)
    }
  }

  // 防御性去重，用于被重新投递的 inbound prompt（seq-num 协商边缘场景、
  // transport 切换后服务器历史重放）。
  const recentInboundUUIDs = new BoundedUUIDSet(cfg.uuid_dedup_buffer_size)

  // FlushGate：历史 flush POST 在途时排队实时写入，让服务器收到顺序为
  // [history..., live...]。
  const flushGate = new FlushGate<Message>()

  let initialFlushDone = false
  let tornDown = false
  let authRecoveryInFlight = false
  // onUserMessage 的闩锁 —— 回调返回 true（策略认为"推导完"）时翻为 true。
  // sessionId 是 const（没有重建路径 —— rebuildTransport 只换 JWT/epoch，
  // 同一个 session），所以不需要重置。
  let userMessageCallbackDone = !onUserMessage

  // 遥测：onConnect 为什么触发？由 rebuildTransport 在
  // wireTransportCallbacks 之前设置；由 onConnect 异步读取。无竞态，
  // 因为 authRecoveryInFlight 串行化 rebuild 调用方，而全新的
  // initEnvLessBridgeCore() 调用会得到全新的闭包，默认为 'initial'。
  let connectCause: ConnectCause = 'initial'

  // transport.connect() 之后 onConnect 的截止时间。由 onConnect
  //（已连接）和 onClose（收到 close —— 不是静默）清除。如果两者都没在
  // cfg.connect_timeout_ms 之前触发，onConnectTimeout 就会发送 —— 这是
  // `started → (silence)` 间隔的唯一信号。
  let connectDeadline: ReturnType<typeof setTimeout> | undefined
  function onConnectTimeout(cause: ConnectCause): void {
    if (tornDown) return
    logEvent('tengu_bridge_repl_connect_timeout', {
      v2: true,
      elapsed_ms: cfg.connect_timeout_ms,
      cause:
        cause as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  }

  // 把当前 REPL 的 external metadata 更新镜像到 bridge 的 CCR worker
  // 通道。没这步的话，主动 wait/sleep 只改本地 UI 状态，web session 详情
  // 会回落到通用 working 加载图标，因为 automation_state 永远到不了
  // remote-control。
  setSessionMetadataChangedListener(
    metadata => {
      if (tornDown) return
      transport.reportMetadata(metadata)
    },
    { replayCurrent: true },
  )

  // ── 5. JWT 刷新调度器 ────────────────────────────────────────────────────
  // 在过期前 5 分钟调度一次回调（依据 response.expires_in）。触发时用
  // OAuth 重新 fetch /bridge → 用新凭据重建 transport。每次 /bridge 调用
  // 都会让服务器侧的 epoch 自增，所以只换 JWT 会让旧 CCRClient 用过期
  // epoch 心跳 → 20 秒内 409。JWT 不透明 —— 不要解码。
  const refresh = createTokenRefreshScheduler({
    refreshBufferMs: cfg.token_refresh_buffer_ms,
    getAccessToken: async () => {
      // 调 /bridge 之前无条件刷新 OAuth —— getAccessToken() 会把过期 token
      // 当作非空字符串返回（不检查 expiresAt），所以真值不等于有效。
      // 把过期 token 传给 onAuth401，让 handleOAuth401Error 的 keychain
      // 对比能检测并行刷新。
      const stale = getAccessToken()
      if (onAuth401) await onAuth401(stale ?? '')
      return getAccessToken() ?? stale
    },
    onRefresh: (sid, oauthToken) => {
      void (async () => {
        // 笔记本唤醒：过期的主动定时器和 SSE 401 几乎同时触发。
        // 在 /bridge fetch 之前抢占 flag，让另一条路径整体跳过 ——
        // 防止双重 epoch 自增（每次 /bridge 调用都会自增；如果两边都
        // fetch，第一个 rebuild 会拿到过期 epoch 并 409）。
        if (authRecoveryInFlight || tornDown) {
          logForDebugging(
            '[remote-bridge] Recovery already in flight, skipping proactive refresh',
          )
          return
        }
        authRecoveryInFlight = true
        try {
          const fresh = await withRetry(
            () =>
              fetchRemoteCredentials(
                sid,
                baseUrl,
                oauthToken,
                cfg.http_timeout_ms,
              ),
            'fetchRemoteCredentials (proactive)',
            cfg,
          )
          if (!fresh || tornDown) return
          await rebuildTransport(fresh, 'proactive_refresh')
          logForDebugging(
            '[remote-bridge] Transport rebuilt (proactive refresh)',
          )
        } catch (err) {
          logForDebugging(
            `[remote-bridge] Proactive refresh rebuild failed: ${errorMessage(err)}`,
            { level: 'error' },
          )
          logForDiagnosticsNoPII(
            'error',
            'bridge_repl_v2_proactive_refresh_failed',
          )
          if (!tornDown) {
            onStateChange?.('failed', `Refresh failed: ${errorMessage(err)}`)
          }
        } finally {
          authRecoveryInFlight = false
        }
      })()
    },
    label: 'remote',
  })
  refresh.scheduleFromExpiresIn(sessionId, credentials.expires_in)

  // ── 6. 接好回调（抽出来让 transport 重建可以重新接线） ──────
  function wireTransportCallbacks(): void {
    transport.setOnConnect(() => {
      clearTimeout(connectDeadline)
      logForDebugging('[remote-bridge] v2 transport connected')
      logForDiagnosticsNoPII('info', 'bridge_repl_v2_transport_connected')
      logEvent('tengu_bridge_repl_ws_connected', {
        v2: true,
        cause:
          connectCause as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })

      if (!initialFlushDone && initialMessages && initialMessages.length > 0) {
        initialFlushDone = true
        // 捕获当前 transport —— 如果 flush 中途 401/teardown，过期的
        // .finally() 绝不能排空 gate 或发送 connected。
        //（与 replBridge.ts:1119 同样的守卫模式。）
        const flushTransport = transport
        void flushHistory(initialMessages)
          .catch(e =>
            logForDebugging(`[remote-bridge] flushHistory failed: ${e}`),
          )
          .finally(() => {
            // authRecoveryInFlight 抓住 v1 与 v2 的不对称：v1 在 setOnClose
            //（replBridge.ts:1175）中同步把 transport 置空，所以
            // transport !== flushTransport 立刻命中。v2 不置空 —— transport
            // 只在 rebuildTransport:346 重新赋值，那里有 3 层 await 深度。
            // authRecoveryInFlight 在 rebuildTransport 入口同步设置。
            if (
              transport !== flushTransport ||
              tornDown ||
              authRecoveryInFlight
            ) {
              return
            }
            drainFlushGate()
            onStateChange?.('connected')
          })
      } else if (!flushGate.active) {
        onStateChange?.('connected')
      }
    })

    transport.setOnData((data: string) => {
      handleIngressMessage(
        data,
        recentPostedUUIDs,
        recentInboundUUIDs,
        onInboundMessage,
        // 远程客户端回答了权限提示 —— 回合恢复。没这步的话服务器会停在
        // requires_action，直到下一条 user 消息或回合结束的 result。
        onPermissionResponse
          ? res => {
              transport.reportState('running')
              onPermissionResponse(res)
            }
          : undefined,
        req =>
          handleServerControlRequest(req, {
            transport,
            sessionId,
            onInterrupt,
            onSetModel,
            onSetMaxThinkingTokens,
            onSetPermissionMode,
            outboundOnly,
          }),
      )
    })

    transport.setOnClose((code?: number) => {
      clearTimeout(connectDeadline)
      if (tornDown) return
      logForDebugging(`[remote-bridge] v2 transport closed (code=${code})`)
      logEvent('tengu_bridge_repl_ws_closed', { code, v2: true })
      // onClose 只在终态失败时触发：401（JWT 无效）、4090（CCR epoch 不
      // 匹配）、4091（CCR 初始化失败），或 SSE 10 分钟重连预算耗尽。
      // 瞬时断开由 SSETransport 透明处理。401 我们能恢复（拉新 JWT、
      // 重建 transport）；其他 code 都是死路。
      if (code === 401 && !authRecoveryInFlight) {
        void recoverFromAuthFailure()
        return
      }
      onStateChange?.('failed', `Transport closed (code ${code})`)
    })
  }

  // ── 7. transport 重建（主动刷新 + 401 恢复共用） ──
  // 每次 /bridge 调用都会让服务器侧 epoch 自增。两条刷新路径都必须用新
  // epoch 重建 transport —— 只换 JWT 会让旧 CCRClient 用过期 epoch 心跳
  // → 409。SSE 从旧 transport 的高水位 seq-num 继续，所以服务器侧不会
  // 重放。
  // 调用方必须在调用之前（同步地，在任何 await 之前）置
  // authRecoveryInFlight = true，并在 finally 中清掉。本函数不管这个
  // flag —— 移到这里就太晚了，挡不住双 /bridge fetch，而每次 fetch 都
  // 会自增 epoch。
  async function rebuildTransport(
    fresh: RemoteCredentials,
    cause: Exclude<ConnectCause, 'initial'>,
  ): Promise<void> {
    connectCause = cause
    // 重建期间排队写入 —— /bridge 一旦返回，旧 transport 的 epoch 就过期
    // 了，它下一次 write/heartbeat 会 409。没这个 gate 的话，
    // writeMessages 会把 UUID 加到 recentPostedUUIDs，然后 writeBatch
    // 静默 no-op（409 之后 uploader 已关闭）→ 永久静默丢消息。
    flushGate.start()
    try {
      const seq = transport.getLastSequenceNum()
      transport.close()
      transport = await createV2ReplTransport({
        sessionUrl: buildCCRv2SdkUrl(fresh.api_base_url, sessionId),
        ingressToken: fresh.worker_jwt,
        sessionId,
        epoch: fresh.worker_epoch,
        heartbeatIntervalMs: cfg.heartbeat_interval_ms,
        heartbeatJitterFraction: cfg.heartbeat_jitter_fraction,
        initialSequenceNum: seq,
        getAuthToken: () => fresh.worker_jwt,
        outboundOnly,
      })
      if (tornDown) {
        // async createV2ReplTransport 窗口里触发了 teardown。
        // 不要接线/connect/调度 —— 会在 cancelAll() 之后重新武装定时器，
        // 并向已 teardown 的 bridge 触发 onInboundMessage。
        transport.close()
        return
      }
      wireTransportCallbacks()
      transport.connect()
      connectDeadline = setTimeout(
        onConnectTimeout,
        cfg.connect_timeout_ms,
        connectCause,
      )
      refresh.scheduleFromExpiresIn(sessionId, fresh.expires_in)
      // 把排队写入排进新 uploader。在 ccr.initialize() resolve 之前运行
      //（transport.connect() 是 fire-and-forget），但 uploader 会在初始
      // PUT /worker 之后串行化。如果 init 失败（4091），事件会丢 —— 但
      // 只有 recentPostedUUIDs（per-instance）被填充，所以重新启用
      // bridge 时会重新 flush。
      drainFlushGate()
    } finally {
      // 失败路径上也要结束 gate —— 成功路径的 drainFlushGate 已经结束
      // 了它。排队的消息被丢弃（transport 仍然死着）。
      flushGate.drop()
    }
  }

  // ── 8. 401 恢复（OAuth 刷新 + 重建） ───────────────────────────
  async function recoverFromAuthFailure(): Promise<void> {
    // setOnClose 已经守卫了 `!authRecoveryInFlight`，但那次检查和这里的
    // 赋值必须对 onRefresh 原子 —— 在任何 await 之前同步抢占。笔记本
    // 唤醒时两条路径几乎同时触发。
    if (authRecoveryInFlight) return
    authRecoveryInFlight = true
    onStateChange?.('reconnecting', 'JWT expired — refreshing')
    logForDebugging('[remote-bridge] 401 on SSE — attempting JWT refresh')
    try {
      // 无条件尝试 OAuth 刷新 —— getAccessToken() 把过期 token 当作非空
      // 字符串返回，所以 !oauthToken 捕获不到过期。把过期 token 传进去
      // 让 handleOAuth401Error 的 keychain 对比能检测是不是另一个 tab
      // 已经刷新过。
      const stale = getAccessToken()
      if (onAuth401) await onAuth401(stale ?? '')
      const oauthToken = getAccessToken() ?? stale
      if (!oauthToken || tornDown) {
        if (!tornDown) {
          onStateChange?.('failed', 'JWT refresh failed: no OAuth token')
        }
        return
      }

      const fresh = await withRetry(
        () =>
          fetchRemoteCredentials(
            sessionId,
            baseUrl,
            oauthToken,
            cfg.http_timeout_ms,
          ),
        'fetchRemoteCredentials (recovery)',
        cfg,
      )
      if (!fresh || tornDown) {
        if (!tornDown) {
          onStateChange?.('failed', 'JWT refresh failed after 401')
        }
        return
      }
      // 如果 401 打断了 initial flush，writeBatch 可能在已关闭的 uploader
      // 上静默 no-op 了（ccr.close() 在我们的 setOnClose 回调之前在
      // SSE wrapper 里跑过）。重置让新的 onConnect 重新 flush。
      //（v1 在 replBridge.ts:1027 把 initialFlushDone 限定在每个 transport
      // 的闭包里，自然重置；v2 放在外层作用域。）
      initialFlushDone = false
      await rebuildTransport(fresh, 'auth_401_recovery')
      logForDebugging('[remote-bridge] Transport rebuilt after 401')
    } catch (err) {
      logForDebugging(
        `[remote-bridge] 401 recovery failed: ${errorMessage(err)}`,
        { level: 'error' },
      )
      logForDiagnosticsNoPII('error', 'bridge_repl_v2_jwt_refresh_failed')
      if (!tornDown) {
        onStateChange?.('failed', `JWT refresh failed: ${errorMessage(err)}`)
      }
    } finally {
      authRecoveryInFlight = false
    }
  }

  wireTransportCallbacks()

  // 在 connect 之前启动 flushGate，让握手期间的 writeMessages() 排队，
  // 而不是与历史 POST 竞态。
  if (initialMessages && initialMessages.length > 0) {
    flushGate.start()
  }
  transport.connect()
  connectDeadline = setTimeout(
    onConnectTimeout,
    cfg.connect_timeout_ms,
    connectCause,
  )

  // ── 8. 历史 flush + 排空辅助函数 ────────────────────────────────────
  function drainFlushGate(): void {
    const msgs = flushGate.end()
    if (msgs.length === 0) return
    for (const msg of msgs) recentPostedUUIDs.add(msg.uuid)
    const events: TransportMessage[] = toSDKMessages(msgs).map(m => ({
      ...m,
      session_id: sessionId,
    })) as TransportMessage[]
    if (shouldReportRunningForMessages(msgs)) {
      transport.reportState('running')
    }
    logForDebugging(
      `[remote-bridge] Drained ${msgs.length} queued message(s) after flush`,
    )
    void transport.writeBatch(events as StdoutMessage[])
  }

  async function flushHistory(msgs: Message[]): Promise<void> {
    // v2 总是创建全新的服务器 session（上面无条件的 createCodeSession）
    // —— 没有 session 复用，没有重复投递风险。与 v1 不同，我们不用
    // previouslyFlushedUUIDs 过滤：那个集合在 REPL enable/disable 循环中
    // 一直保留（useRef），重新 enable 时会错误地压制历史。
    const eligible = msgs.filter(isEligibleBridgeMessage)
    const capped =
      initialHistoryCap > 0 && eligible.length > initialHistoryCap
        ? eligible.slice(-initialHistoryCap)
        : eligible
    if (capped.length < eligible.length) {
      logForDebugging(
        `[remote-bridge] Capped initial flush: ${eligible.length} -> ${capped.length} (cap=${initialHistoryCap})`,
      )
    }
    const events: TransportMessage[] = toSDKMessages(capped).map(m => ({
      ...m,
      session_id: sessionId,
    })) as TransportMessage[]
    if (events.length === 0) return
    // 回合中途 init：如果 Remote Control 在一次 query 运行时被启用，
    // 最后一条 eligible 消息可能是真实 user prompt 或 tool_result。
    // 隐式 slash-command 脚手架和纯 reminder 包裹不应该把已完成的回合
    // 复活成 "running"。检查 eligible（封顶前），不检查 capped：
    // cap 可能正好截到一条 user 消息，而实际末尾消息是 assistant。
    const lastEligible = eligible.at(-1)
    if (lastEligible && shouldReportRunningForMessage(lastEligible)) {
      transport.reportState('running')
    }
    logForDebugging(`[remote-bridge] Flushing ${events.length} history events`)
    await transport.writeBatch(events as StdoutMessage[])
  }

  // ── 9. Teardown ───────────────────────────────────────────────────────
  // SIGINT/SIGTERM/⁠/exit 时，gracefulShutdown 让 runCleanupFunctions()
  // 与 2s 上限赛跑，然后 forceExit 杀掉进程。按预算安排：
  //   - archive：teardown_archive_timeout_ms（默认 1500，上限 2000）
  //   - result 写入：fire-and-forget，archive 延迟覆盖排空
  //   - 401 重试：仅第一次 archive 401 时，共用同一预算
  async function teardown(): Promise<void> {
    if (tornDown) return
    tornDown = true
    refresh.cancelAll()
    clearTimeout(connectDeadline)
    flushGate.drop()

    // 在 archive 之前先发 result 消息 —— transport.write() 只 await 入队
    //（SerialBatchEventUploader 一旦缓冲就 resolve，排空是异步的）。
    // close() 之前 archive 给 uploader 的排空循环一个窗口（典型 archive
    // ≈ 100-500ms）去 POST result，不需要显式 sleep。close() 会把
    // closed=true 置位，让下一次 while 检查中断排空，所以先 close 再
    // archive 会丢掉 result。
    transport.reportState('idle')
    const resultMsg = {
      ...makeResultMessage(sessionId),
      session_id: sessionId,
    } as unknown as TransportMessage
    void transport.write(resultMsg as StdoutMessage)
    let token = getAccessToken()
    let status = await archiveSession(
      sessionId,
      baseUrl,
      token,
      orgUUID,
      cfg.teardown_archive_timeout_ms,
    )

    // token 通常是新鲜的（刷新调度器在过期前 5 分钟跑），但笔记本唤醒
    // 错过刷新窗口会让 getAccessToken() 返回过期字符串。401 时重试一次
    // —— onAuth401（= handleOAuth401Error）清 keychain 缓存 + 强制刷新。
    // happy path 不做主动刷新：handleOAuth401Error 即使对有效 token 也会
    // 强制刷新，99% 的情况下是在浪费预算。try/catch 对应
    // recoverFromAuthFailure：keychain 读可能抛异常（macOS 唤醒后锁定）；
    // 这里不接住异常就会跳过 transport.close + 遥测。
    if (status === 401 && onAuth401) {
      try {
        await onAuth401(token ?? '')
        token = getAccessToken()
        status = await archiveSession(
          sessionId,
          baseUrl,
          token,
          orgUUID,
          cfg.teardown_archive_timeout_ms,
        )
      } catch (err) {
        logForDebugging(
          `[remote-bridge] Teardown 401 retry threw: ${errorMessage(err)}`,
          { level: 'error' },
        )
      }
    }

    transport.close()

    const archiveStatus: ArchiveTelemetryStatus =
      status === 'no_token'
        ? 'skipped_no_token'
        : status === 'timeout' || status === 'error'
          ? 'network_error'
          : status >= 500
            ? 'server_5xx'
            : status >= 400
              ? 'server_4xx'
              : 'ok'

    logForDebugging(`[remote-bridge] Torn down (archive=${status})`)
    logForDiagnosticsNoPII('info', 'bridge_repl_v2_teardown')
    logEvent(
      feature('CCR_MIRROR') && outboundOnly
        ? 'tengu_ccr_mirror_teardown'
        : 'tengu_bridge_repl_teardown',
      {
        v2: true,
        archive_status:
          archiveStatus as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        archive_ok: typeof status === 'number' && status < 400,
        archive_http_status: typeof status === 'number' ? status : undefined,
        archive_timeout: status === 'timeout',
        archive_no_token: status === 'no_token',
      },
    )
  }
  const unregister = registerCleanup(teardown)

  if (feature('CCR_MIRROR') && outboundOnly) {
    logEvent('tengu_ccr_mirror_started', {
      v2: true,
      expires_in_s: credentials.expires_in,
    })
  } else {
    logEvent('tengu_bridge_repl_started', {
      has_initial_messages: !!(initialMessages && initialMessages.length > 0),
      v2: true,
      expires_in_s: credentials.expires_in,
      inProtectedNamespace: isInProtectedNamespace(),
    })
  }

  // ── 10. Handle ──────────────────────────────────────────────────────
  return {
    bridgeSessionId: sessionId,
    environmentId: '',
    sessionIngressUrl: credentials.api_base_url,
    writeMessages(messages) {
      const filtered = messages.filter(
        m =>
          isEligibleBridgeMessage(m) &&
          !initialMessageUUIDs.has(m.uuid) &&
          !recentPostedUUIDs.has(m.uuid),
      )
      if (filtered.length === 0) return

      // 触发 onUserMessage 推导标题。在 flushGate 检查之前扫描 —— 即使
      // prompt 被排队，它也有资格当标题。对每条有资格的消息都调，直到
      // 回调返回 true；策略由调用方决定（1 和 3 时推导，显式标题则跳过）。
      if (!userMessageCallbackDone) {
        for (const m of filtered) {
          const text = extractTitleText(m)
          if (text !== undefined && onUserMessage?.(text, sessionId)) {
            userMessageCallbackDone = true
            break
          }
        }
      }

      if (flushGate.enqueue(...filtered)) {
        logForDebugging(
          `[remote-bridge] Queued ${filtered.length} message(s) during flush`,
        )
        return
      }

      for (const msg of filtered) recentPostedUUIDs.add(msg.uuid)
      const events: TransportMessage[] = toSDKMessages(filtered).map(m => ({
        ...m,
        session_id: sessionId,
      })) as TransportMessage[]
      // v2 在服务器侧不从事件推导 worker_status（与 v1 的
      // session-ingress session_status_updater.go 不同）。从这里推上去，
      // 让 CCR web session 列表显示 Running 而不是卡在 Idle。只有启动
      // work 的 user 消息才标记回合开始；隐式 local-command 脚手架和
      // 纯 reminder 不应重新打开已完成的回合。CCRClient.reportState 对
      // 连续同状态推送去重。
      if (shouldReportRunningForMessages(filtered)) {
        transport.reportState('running')
      }
      logForDebugging(`[remote-bridge] Sending ${filtered.length} message(s)`)
      void transport.writeBatch(events as StdoutMessage[])
    },
    writeSdkMessages(messages: SDKMessage[]) {
      const filtered = messages.filter(
        m => !m.uuid || !recentPostedUUIDs.has(m.uuid as string),
      )
      if (filtered.length === 0) return
      for (const msg of filtered) {
        if (msg.uuid) recentPostedUUIDs.add(msg.uuid as string)
      }
      const events = filtered.map(m => ({
        ...m,
        session_id: sessionId,
      })) as StdoutMessage[]
      void transport.writeBatch(events)
    },
    sendControlRequest(request: SDKControlRequest) {
      if (authRecoveryInFlight) {
        logForDebugging(
          `[remote-bridge] Dropping control_request during 401 recovery: ${request.request_id}`,
        )
        return
      }
      const event: TransportMessage = {
        ...request,
        session_id: sessionId,
      } as TransportMessage
      if (
        (request as { request?: { subtype?: string } }).request?.subtype ===
        'can_use_tool'
      ) {
        transport.reportState('requires_action')
      }
      void transport.write(event as StdoutMessage)
      logForDebugging(
        `[remote-bridge] Sent control_request request_id=${request.request_id}`,
      )
    },
    sendControlResponse(response: SDKControlResponse) {
      if (authRecoveryInFlight) {
        logForDebugging(
          '[remote-bridge] Dropping control_response during 401 recovery',
        )
        return
      }
      const event: TransportMessage = {
        ...response,
        session_id: sessionId,
      } as TransportMessage
      transport.reportState('running')
      void transport.write(event as StdoutMessage)
      logForDebugging('[remote-bridge] Sent control_response')
    },
    sendControlCancelRequest(requestId: string) {
      if (authRecoveryInFlight) {
        logForDebugging(
          `[remote-bridge] Dropping control_cancel_request during 401 recovery: ${requestId}`,
        )
        return
      }
      const event: TransportMessage = {
        type: 'control_cancel_request' as const,
        request_id: requestId,
        session_id: sessionId,
      } as TransportMessage
      // Hook/classifier/channel/recheck 在本地解析了权限 ——
      // interactiveHandler 在这些路径上只调 cancelRequest（不调
      // sendResponse），所以没这步的话服务器会停在 requires_action。
      transport.reportState('running')
      void transport.write(event as StdoutMessage)
      logForDebugging(
        `[remote-bridge] Sent control_cancel_request request_id=${requestId}`,
      )
    },
    sendResult() {
      if (authRecoveryInFlight) {
        logForDebugging('[remote-bridge] Dropping result during 401 recovery')
        return
      }
      transport.reportState('idle')
      const resultMsg = {
        ...makeResultMessage(sessionId),
        session_id: sessionId,
      } as unknown as TransportMessage
      void transport.write(resultMsg as StdoutMessage)
      logForDebugging(`[remote-bridge] Sent result`)
    },
    async teardown() {
      unregister()
      await teardown()
    },
  }
}

// ─── Session API（v2 /code/sessions，无 env） ─────────────────────────────────

/** 用指数退避 + 抖动重试 async init 调用。 */
async function withRetry<T>(
  fn: () => Promise<T | null>,
  label: string,
  cfg: EnvLessBridgeConfig,
): Promise<T | null> {
  const max = cfg.init_retry_max_attempts
  for (let attempt = 1; attempt <= max; attempt++) {
    const result = await fn()
    if (result !== null) return result
    if (attempt < max) {
      const base = cfg.init_retry_base_delay_ms * 2 ** (attempt - 1)
      const jitter =
        base * cfg.init_retry_jitter_fraction * (2 * Math.random() - 1)
      const delay = Math.min(base + jitter, cfg.init_retry_max_delay_ms)
      logForDebugging(
        `[remote-bridge] ${label} failed (attempt ${attempt}/${max}), retrying in ${Math.round(delay)}ms`,
      )
      await sleep(delay)
    }
  }
  return null
}

// 移到 codeSessionApi.ts，让 SDK /bridge 子路径能打包它们而不引入本
// 文件沉重的 CLI 树（analytics、transport）。
export {
  createCodeSession,
  type RemoteCredentials,
} from './codeSessionApi.js'
import {
  createCodeSession,
  fetchRemoteCredentials as fetchRemoteCredentialsRaw,
  type RemoteCredentials,
} from './codeSessionApi.js'
import { getBridgeBaseUrlOverride } from './bridgeConfig.js'

// CLI 侧包装：应用 CLAUDE_BRIDGE_BASE_URL 开发覆盖并注入 trusted-device
// token（两者都是 env/GrowthBook 读，面向 SDK 的 codeSessionApi.ts 导出
// 必须不沾这些）。
export async function fetchRemoteCredentials(
  sessionId: string,
  baseUrl: string,
  accessToken: string,
  timeoutMs: number,
): Promise<RemoteCredentials | null> {
  const creds = await fetchRemoteCredentialsRaw(
    sessionId,
    baseUrl,
    accessToken,
    timeoutMs,
    getTrustedDeviceToken(),
  )
  if (!creds) return null
  return getBridgeBaseUrlOverride()
    ? { ...creds, api_base_url: baseUrl }
    : creds
}

type ArchiveStatus = number | 'timeout' | 'error' | 'no_token'

// BQ `GROUP BY archive_status` 用的单一分类字段。_teardown 上的布尔值比
// 它更早存在，与它重复（archive_timeout 除外，它把 ECONNABORTED 与其他
// 网络错误区分 —— 这里都映射到 'network_error'，因为 1.5s 窗口内的
// 主要原因是超时）。
type ArchiveTelemetryStatus =
  | 'ok'
  | 'skipped_no_token'
  | 'network_error'
  | 'server_4xx'
  | 'server_5xx'

async function archiveSession(
  sessionId: string,
  baseUrl: string,
  accessToken: string | undefined,
  orgUUID: string,
  timeoutMs: number,
): Promise<ArchiveStatus> {
  if (!accessToken) return 'no_token'
  // archive 位于 compat 层（/v1/sessions/*，不是 /v1/code/sessions）。
  // compat.parseSessionID 只接受 TagSession（session_*），所以把 cse_*
  // 重新打 tag。anthropic-beta + x-organization-uuid 是必填 —— 缺它们
  // compat 网关会在到达 handler 之前 404。
  //
  // 与 bridgeMain.ts（在 sessionCompatIds 中缓存 compatId，让内存中的
  // titledSessions/logger key 在 session 中途 gate 翻转时保持一致）不同，
  // 这里的 compatId 只是服务器 URL 路径段 —— 没有内存状态。每次现算匹配
  // 服务器当前校验的内容：如果 gate 是 OFF，服务器已被更新为接受
  // cse_*，我们正确地发送它。
  const compatId = toCompatSessionId(sessionId)
  try {
    const response = await axios.post(
      `${baseUrl}/v1/sessions/${compatId}/archive`,
      {},
      {
        headers: {
          ...oauthHeaders(accessToken),
          'anthropic-beta': 'ccr-byoc-2025-07-29',
          'x-organization-uuid': orgUUID,
        },
        timeout: timeoutMs,
        validateStatus: () => true,
      },
    )
    logForDebugging(
      `[remote-bridge] Archive ${compatId} status=${response.status}`,
    )
    return response.status
  } catch (err) {
    const msg = errorMessage(err)
    logForDebugging(`[remote-bridge] Archive failed: ${msg}`)
    return axios.isAxiosError(err) && err.code === 'ECONNABORTED'
      ? 'timeout'
      : 'error'
  }
}
