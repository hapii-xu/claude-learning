import { randomUUID } from 'crypto'
import type {
  SDKPartialAssistantMessage,
  StdoutMessage,
} from 'src/entrypoints/sdk/controlTypes.js'
import { decodeJwtExpiry } from '../../bridge/jwtUtils.js'
import { logForDebugging } from '../../utils/debug.js'
import { logForDiagnosticsNoPII } from '../../utils/diagLogs.js'
import { errorMessage, getErrnoCode } from '../../utils/errors.js'
import { createAxiosInstance } from '../../utils/proxy.js'
import {
  registerSessionActivityCallback,
  unregisterSessionActivityCallback,
} from '../../utils/sessionActivity.js'
import {
  getSessionIngressAuthHeaders,
  getSessionIngressAuthToken,
} from '../../utils/sessionIngressAuth.js'
import type {
  RequiresActionDetails,
  SessionState,
} from '../../utils/sessionState.js'
import { sleep } from '../../utils/sleep.js'
import { getClaudeCodeUserAgent } from '../../utils/userAgent.js'
import {
  RetryableError,
  SerialBatchEventUploader,
} from './SerialBatchEventUploader.js'
import type { SSETransport, StreamClientEvent } from './SSETransport.js'
import { WorkerStateUploader } from './WorkerStateUploader.js'

/** 心跳事件之间的默认间隔（20 秒；服务端 TTL 为 60 秒）。 */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000

/**
 * stream_event 消息会在延迟缓冲区中累积至多这么多毫秒后再入队。
 * 与 HybridTransport 的批处理窗口保持一致。同一个 content block 的
 * text_delta 事件会在每次 flush 时合并为单个“截至目前完整内容”的快照
 * —— 每个发出的事件都是自包含的，因此在中途接入的客户端看到的是
 * 完整文本，而不是片段。
 */
const STREAM_EVENT_FLUSH_INTERVAL_MS = 100

/** 提升为顶层 axios validateStatus 回调，避免每次请求都分配闭包。 */
function alwaysValidStatus(): boolean {
  return true
}

export type CCRInitFailReason =
  | 'no_auth_headers'
  | 'missing_epoch'
  | 'worker_register_failed'

/** 由 initialize() 抛出；携带类型化的原因供诊断分类器使用。 */
export class CCRInitError extends Error {
  constructor(readonly reason: CCRInitFailReason) {
    super(`CCRClient init failed: ${reason}`)
  }
}

/**
 * 在放弃之前允许的、伴随“看起来有效的”token 的连续 401/403 次数。
 * 已过期的 JWT 会短路此流程（立即退出 —— 是确定性的，重试无意义）。
 * 该阈值用于不确定的情况：token 的 exp 在未来，但服务端返回 401
 * （userauth 宕机、KMS 抖动、时钟偏移）。10 × 20s 心跳 ≈ 200s 可熬过该情况。
 */
const MAX_CONSECUTIVE_AUTH_FAILURES = 10

type EventPayload = {
  uuid: string
  type: string
  [key: string]: unknown
}

type ClientEvent = {
  payload: EventPayload
  ephemeral?: boolean
}

/**
 * 携带 text_delta 的 stream_event 的结构化子集。并非对
 * SDKPartialAssistantMessage 的收窄 —— RawMessageStreamEvent 的 delta 是
 * 联合类型，跨两层收窄会破坏判别标志。
 */
type CoalescedStreamEvent = {
  type: 'stream_event'
  uuid: string
  session_id: string
  parent_tool_use_id: string | null
  event: {
    type: 'content_block_delta'
    index: number
    delta: { type: 'text_delta'; text: string }
  }
}

/**
 * text_delta 合并用的累加器状态。按 API 消息 ID 作为键，因此生命周期
 * 与助手消息绑定 —— 当完整的 SDKAssistantMessage 到达时（writeEvent）
 * 清空，这在 abort/错误路径跳过 content_block_stop/message_stop 投递时
 * 仍然可靠。
 */
export type StreamAccumulatorState = {
  /** API 消息 ID (msg_...) → blocks[blockIndex] → chunk 数组。 */
  byMessage: Map<string, string[][]>
  /**
   * {session_id}:{parent_tool_use_id} → 当前活动消息 ID。
   * content_block_delta 事件不携带消息 ID（只有 message_start 才有），
   * 因此我们为每个作用域追踪当前正在流式传输的消息。每个作用域同时
   * 最多只有一条消息在流式传输。
   */
  scopeToMessage: Map<string, string>
}

export function createStreamAccumulator(): StreamAccumulatorState {
  return { byMessage: new Map(), scopeToMessage: new Map() }
}

function scopeKey(m: {
  session_id: string
  parent_tool_use_id?: string | null
}): string {
  return `${m.session_id}:${m.parent_tool_use_id ?? ''}`
}

/**
 * 将 text_delta stream_event 累积为每个 content block 的“截至目前完整内容”
 * 快照。每次 flush 为每个被触及的 block 发出一条事件，包含该 block 从头
 * 开始的完整累积文本 —— 中途接入的客户端收到的是自包含快照，而不是片段。
 *
 * 非 text_delta 事件原样透传。message_start 记录该作用域当前活动的消息 ID；
 * content_block_delta 追加 chunk；快照事件复用本次 flush 中该 block 首次出现
 * 的 text_delta UUID，以保证服务端幂等性在重试之间保持稳定。
 *
 * 清理在 writeEvent 中、完整助手消息到达时进行（可靠），而不是在此处的
 * stop 事件上进行（abort/错误路径会跳过这些事件）。
 */
export function accumulateStreamEvents(
  buffer: SDKPartialAssistantMessage[],
  state: StreamAccumulatorState,
): EventPayload[] {
  const out: EventPayload[] = []
  // chunks[] → 本次 flush 中已写入 `out` 的快照。以 chunks 数组引用为键
  // （对每个 {messageId, index} 稳定），这样后续 delta 会改写同一条目，
  // 而不是每个 delta 都发出一条事件。
  const touched = new Map<string[], CoalescedStreamEvent>()
  for (const msg of buffer) {
    const evt = msg.event as Record<string, unknown>
    switch (evt.type) {
      case 'message_start': {
        const id = (evt.message as { id: string }).id
        const prevId = state.scopeToMessage.get(scopeKey(msg))
        if (prevId) state.byMessage.delete(prevId)
        state.scopeToMessage.set(scopeKey(msg), id)
        state.byMessage.set(id, [])
        out.push(msg)
        break
      }
      case 'content_block_delta': {
        const delta = evt.delta as Record<string, unknown>
        if (delta.type !== 'text_delta') {
          out.push(msg)
          break
        }
        const messageId = state.scopeToMessage.get(scopeKey(msg))
        const blocks = messageId ? state.byMessage.get(messageId) : undefined
        if (!blocks) {
          // 没有前置 message_start 的 Delta（中途重连，或 message_start
          // 在之前被丢弃的缓冲区中）。原样透传 —— 反正没有之前的 chunk
          // 也无法生成“截至目前完整内容”的快照。
          out.push(msg)
          break
        }
        const idx = evt.index as number
        const chunks = (blocks[idx] ??= [])
        chunks.push(delta.text as string)
        const existing = touched.get(chunks)
        if (existing) {
          ;(existing.event as Record<string, unknown>).delta = {
            type: 'text_delta',
            text: chunks.join(''),
          }
          break
        }
        const snapshot: CoalescedStreamEvent = {
          type: 'stream_event',
          uuid: msg.uuid,
          session_id: msg.session_id,
          parent_tool_use_id: msg.parent_tool_use_id,
          event: {
            type: 'content_block_delta',
            index: idx,
            delta: { type: 'text_delta', text: chunks.join('') },
          },
        }
        touched.set(chunks, snapshot)
        out.push(snapshot)
        break
      }
      default:
        out.push(msg)
    }
  }
  return out
}

/**
 * 清除已完成助手消息对应的累加器条目。在 writeEvent 中 SDKAssistantMessage
 * 到达时调用 —— 这是可靠的流结束信号，即使在 abort/中断/错误跳过 SSE stop
 * 事件时也会触发。
 */
export function clearStreamAccumulatorForMessage(
  state: StreamAccumulatorState,
  assistant: {
    session_id: string
    parent_tool_use_id: string | null
    message: { id: string }
  },
): void {
  state.byMessage.delete(assistant.message.id)
  const scope = scopeKey(assistant)
  if (state.scopeToMessage.get(scope) === assistant.message.id) {
    state.scopeToMessage.delete(scope)
  }
}

type RequestResult = { ok: true } | { ok: false; retryAfterMs?: number }

type WorkerEvent = {
  payload: EventPayload
  is_compaction?: boolean
  agent_id?: string
}

export type InternalEvent = {
  event_id: string
  event_type: string
  payload: Record<string, unknown>
  event_metadata?: Record<string, unknown> | null
  is_compaction: boolean
  created_at: string
  agent_id?: string
}

type ListInternalEventsResponse = {
  data: InternalEvent[]
  next_cursor?: string
}

type WorkerStateResponse = {
  worker?: {
    external_metadata?: Record<string, unknown>
  }
}

/**
 * 管理与 CCR v2 的 worker 生命周期协议：
 * - Epoch 管理：从 CLAUDE_CODE_WORKER_EPOCH 环境变量读取 worker_epoch
 * - 运行时状态上报：PUT /sessions/{id}/worker
 * - 心跳：POST /sessions/{id}/worker/heartbeat，用于存活检测
 *
 * 所有写入都经由 this.request()。
 */
export class CCRClient {
  private workerEpoch = 0
  private readonly heartbeatIntervalMs: number
  private readonly heartbeatJitterFraction: number
  private heartbeatTimer: NodeJS.Timeout | null = null
  private heartbeatInFlight = false
  private closed = false
  private consecutiveAuthFailures = 0
  private currentState: SessionState | null = null
  private readonly sessionBaseUrl: string
  private readonly sessionId: string
  private readonly http = createAxiosInstance({ keepAlive: true })

  // stream_event 延迟缓冲区 —— 累积 content delta 至多
  // STREAM_EVENT_FLUSH_INTERVAL_MS 后再入队（减少 POST 次数并启用 text_delta
  // 合并）。沿用 HybridTransport 的模式。
  private streamEventBuffer: SDKPartialAssistantMessage[] = []
  private streamEventTimer: ReturnType<typeof setTimeout> | null = null
  // “截至目前完整内容”的文本累加器。跨 flush 持久化，使每个发出的
  // text_delta 事件携带该 block 从头开始的完整文本 —— 中途重连时看到的
  // 是自包含快照。按 API 消息 ID 作为键；在 writeEvent 中、完整助手消息
  // 到达时清空。
  private streamTextAccumulator = createStreamAccumulator()

  private readonly workerState: WorkerStateUploader
  private readonly eventUploader: SerialBatchEventUploader<ClientEvent>
  private readonly internalEventUploader: SerialBatchEventUploader<WorkerEvent>
  private readonly deliveryUploader: SerialBatchEventUploader<{
    eventId: string
    status: 'received' | 'processing' | 'processed'
  }>

  /**
   * 当服务端返回 409（更新的 worker epoch 取代了我们）时被调用。
   * 默认：process.exit(1) —— 对于 spawn 模式子进程是正确的，父级 bridge
   * 会重新 spawn。进程内调用方（replBridge）必须改写为优雅关闭；否则
   * 退出会杀掉用户的 REPL。
   */
  private readonly onEpochMismatch: () => never

  /**
   * 认证头来源。默认为进程级的 session-ingress token
   * （CLAUDE_CODE_SESSION_ACCESS_TOKEN 环境变量）。管理多个使用不同 JWT 的
   * 并发会话的调用方必须注入此项 —— 环境变量路径是进程全局的，会在多个
   * 会话之间互相覆盖。
   */
  private readonly getAuthHeaders: () => Record<string, string>

  constructor(
    transport: SSETransport,
    sessionUrl: URL,
    opts?: {
      onEpochMismatch?: () => never
      heartbeatIntervalMs?: number
      heartbeatJitterFraction?: number
      /**
       * 实例级的认证头来源。省略则读取进程级的
       * CLAUDE_CODE_SESSION_ACCESS_TOKEN（单会话调用方 —— REPL、daemon）。
       * 并发多会话调用方必须提供。
       */
      getAuthHeaders?: () => Record<string, string>
    },
  ) {
    this.onEpochMismatch =
      opts?.onEpochMismatch ??
      (() => {
        // eslint-disable-next-line custom-rules/no-process-exit
        process.exit(1)
      })
    this.heartbeatIntervalMs =
      opts?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
    this.heartbeatJitterFraction = opts?.heartbeatJitterFraction ?? 0
    this.getAuthHeaders = opts?.getAuthHeaders ?? getSessionIngressAuthHeaders
    // Session URL: https://host/v1/code/sessions/{id}（会话 URL）
    if (sessionUrl.protocol !== 'http:' && sessionUrl.protocol !== 'https:') {
      throw new Error(
        `CCRClient: Expected http(s) URL, got ${sessionUrl.protocol}`,
      )
    }
    const pathname = sessionUrl.pathname.replace(/\/$/, '')
    this.sessionBaseUrl = `${sessionUrl.protocol}//${sessionUrl.host}${pathname}`
    // 从 URL 路径（最后一段）中提取 session ID
    this.sessionId = pathname.split('/').pop() || ''

    this.workerState = new WorkerStateUploader({
      send: body =>
        this.request(
          'put',
          '/worker',
          { worker_epoch: this.workerEpoch, ...body },
          'PUT worker',
        ).then(r => r.ok),
      baseDelayMs: 500,
      maxDelayMs: 30_000,
      jitterMs: 500,
    })

    this.eventUploader = new SerialBatchEventUploader<ClientEvent>({
      maxBatchSize: 100,
      maxBatchBytes: 10 * 1024 * 1024,
      // flushStreamEventBuffer() 一次入队一个完整 100ms 窗口内累积的
      // stream_event。混合的、无法折叠为单条快照的 delta 突发可能超过
      // 旧的阈值（50），从而在 SerialBatchEventUploader 的背压检查上死锁。
      // 与 HybridTransport 的边界保持一致 —— 足够高，只受内存约束。
      maxQueueSize: 100_000,
      send: async batch => {
        const result = await this.request(
          'post',
          '/worker/events',
          { worker_epoch: this.workerEpoch, events: batch },
          'client events',
        )
        if (!result.ok) {
          throw new RetryableError(
            'client event POST failed',
            result.retryAfterMs,
          )
        }
      },
      baseDelayMs: 500,
      maxDelayMs: 30_000,
      jitterMs: 500,
    })

    this.internalEventUploader = new SerialBatchEventUploader<WorkerEvent>({
      maxBatchSize: 100,
      maxBatchBytes: 10 * 1024 * 1024,
      maxQueueSize: 200,
      send: async batch => {
        const result = await this.request(
          'post',
          '/worker/internal-events',
          { worker_epoch: this.workerEpoch, events: batch },
          'internal events',
        )
        if (!result.ok) {
          throw new RetryableError(
            'internal event POST failed',
            result.retryAfterMs,
          )
        }
      },
      baseDelayMs: 500,
      maxDelayMs: 30_000,
      jitterMs: 500,
    })

    this.deliveryUploader = new SerialBatchEventUploader<{
      eventId: string
      status: 'received' | 'processing' | 'processed'
    }>({
      maxBatchSize: 64,
      maxQueueSize: 64,
      send: async batch => {
        const result = await this.request(
          'post',
          '/worker/events/delivery',
          {
            worker_epoch: this.workerEpoch,
            updates: batch.map(d => ({
              event_id: d.eventId,
              status: d.status,
            })),
          },
          'delivery batch',
        )
        if (!result.ok) {
          throw new RetryableError('delivery POST failed', result.retryAfterMs)
        }
      },
      baseDelayMs: 500,
      maxDelayMs: 30_000,
      jitterMs: 500,
    })

    // 对每个收到的 client_event 进行确认，以便 CCR 追踪投递状态。
    // 在此处（而不是 initialize() 中）接入，使回调在 new CCRClient()
    // 返回的那一刻就注册好 —— remoteIO 必须可以紧接着立即调用
    // transport.connect()，而不会让第一个 SSE 追赶帧与尚未接入的
    // onEventCallback 产生竞态。
    transport.setOnEvent((event: StreamClientEvent) => {
      this.reportDelivery(event.event_id, 'received')
    })
  }

  /**
   * 初始化 session worker：
   * 1. 从参数取 worker_epoch，否则回退到 CLAUDE_CODE_WORKER_EPOCH
   *    （由 env-manager / bridge spawner 设置）
   * 2. 上报状态为 'idle'
   * 3. 启动心跳定时器
   *
   * 进程内调用方（replBridge）直接传入 epoch —— 它们自己注册了 worker，
   * 没有父进程来设置环境变量。
   */
  async initialize(epoch?: number): Promise<Record<string, unknown> | null> {
    const startMs = Date.now()
    if (Object.keys(this.getAuthHeaders()).length === 0) {
      throw new CCRInitError('no_auth_headers')
    }
    if (epoch === undefined) {
      const rawEpoch = process.env.CLAUDE_CODE_WORKER_EPOCH
      epoch = rawEpoch ? parseInt(rawEpoch, 10) : NaN
    }
    if (isNaN(epoch)) {
      throw new CCRInitError('missing_epoch')
    }
    this.workerEpoch = epoch

    // 与初始化的 PUT 并发执行 —— 二者互不依赖。
    const restoredPromise = this.getWorkerState()

    const result = await this.request(
      'put',
      '/worker',
      {
        worker_status: 'idle',
        worker_epoch: this.workerEpoch,
        // 清除之前 worker 崩溃留下的陈旧 pending_action/task_summary
        // —— 会话内的清除在进程重启后无法保留。
        external_metadata: {
          pending_action: null,
          task_summary: null,
          automation_state: null,
        },
      },
      'PUT worker (init)',
    )
    if (!result.ok) {
      // 409 → onEpochMismatch 可能抛出，但 request() 会捕获它并返回
      // false。若不做此检查，我们会继续 startHeartbeat()，泄漏一个针对
      // 已死亡 epoch 的 20 秒定时器。抛出，让 connect() 的拒绝处理路径
      // 触发，而不是走成功路径。
      throw new CCRInitError('worker_register_failed')
    }
    this.currentState = 'idle'
    this.startHeartbeat()

    // sessionActivity 基于引用计数的定时器会在 API 调用或工具在途期间触发；
    // 若没有写入，容器租约可能在等待过程中过期。
    // v1 在 WebSocketTransport 中按连接接入此项。
    registerSessionActivityCallback(() => {
      void this.writeEvent({ type: 'keep_alive' })
    })

    logForDebugging(`CCRClient: initialized, epoch=${this.workerEpoch}`)
    logForDiagnosticsNoPII('info', 'cli_worker_lifecycle_initialized', {
      epoch: this.workerEpoch,
      duration_ms: Date.now() - startMs,
    })

    // 在 PUT 成功之后 await 并发的 GET 并在此处记录 state_restored ——
    // 在 getWorkerState() 内部记录会有竞态：若 GET 在 PUT 失败之前就解析
    // 完成，诊断会对同一会话同时显示 init_failed 和 state_restored。
    const { metadata, durationMs } = await restoredPromise
    if (!this.closed) {
      logForDiagnosticsNoPII('info', 'cli_worker_state_restored', {
        duration_ms: durationMs,
        had_state: metadata !== null,
      })
    }
    return metadata
  }

  // control_request 会被标记为已处理，且在重启后不会重新投递，
  // 因此读回前一个 worker 写入的内容。
  private async getWorkerState(): Promise<{
    metadata: Record<string, unknown> | null
    durationMs: number
  }> {
    const startMs = Date.now()
    const authHeaders = this.getAuthHeaders()
    if (Object.keys(authHeaders).length === 0) {
      return { metadata: null, durationMs: 0 }
    }
    const data = await this.getWithRetry<WorkerStateResponse>(
      `${this.sessionBaseUrl}/worker`,
      authHeaders,
      'worker_state',
    )
    return {
      metadata: data?.worker?.external_metadata ?? null,
      durationMs: Date.now() - startMs,
    }
  }

  /**
   * 向 CCR 发送经过认证的 HTTP 请求。处理认证头、409 epoch 不匹配以及
   * 错误日志。2xx 返回 { ok: true }。
   * 429 时读取 Retry-After（整数秒），以便上传器遵循服务端的退避提示，
   * 而不是盲目做指数退避。
   */
  private async request(
    method: 'post' | 'put',
    path: string,
    body: unknown,
    label: string,
    { timeout = 10_000 }: { timeout?: number } = {},
  ): Promise<RequestResult> {
    const authHeaders = this.getAuthHeaders()
    if (Object.keys(authHeaders).length === 0) return { ok: false }

    try {
      const response = await this.http[method](
        `${this.sessionBaseUrl}${path}`,
        body,
        {
          headers: {
            ...authHeaders,
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
            'User-Agent': getClaudeCodeUserAgent(),
          },
          validateStatus: alwaysValidStatus,
          timeout,
        },
      )

      if (response.status >= 200 && response.status < 300) {
        this.consecutiveAuthFailures = 0
        return { ok: true }
      }
      if (response.status === 409) {
        this.handleEpochMismatch()
      }
      if (response.status === 401 || response.status === 403) {
        // 携带已过期 JWT 的 401 是确定性的 —— 任何重试都不可能成功。
        // 在阈值循环里耗费墙上时间之前，先检查 token 自身的 exp。
        const tok = getSessionIngressAuthToken()
        const exp = tok ? decodeJwtExpiry(tok) : null
        if (exp !== null && exp * 1000 < Date.now()) {
          logForDebugging(
            `CCRClient: session_token expired (exp=${new Date(exp * 1000).toISOString()}) — no refresh was delivered, exiting`,
            { level: 'error' },
          )
          logForDiagnosticsNoPII('error', 'cli_worker_token_expired_no_refresh')
          this.onEpochMismatch()
        }
        // Token 看起来有效但服务端返回 401 —— 可能是服务端短暂抖动
        // （userauth 宕机、KMS 抖动）。计入阈值。
        this.consecutiveAuthFailures++
        if (this.consecutiveAuthFailures >= MAX_CONSECUTIVE_AUTH_FAILURES) {
          logForDebugging(
            `CCRClient: ${this.consecutiveAuthFailures} consecutive auth failures with a valid-looking token — server-side auth unrecoverable, exiting`,
            { level: 'error' },
          )
          logForDiagnosticsNoPII('error', 'cli_worker_auth_failures_exhausted')
          this.onEpochMismatch()
        }
      }
      logForDebugging(`CCRClient: ${label} returned ${response.status}`, {
        level: 'warn',
      })
      logForDiagnosticsNoPII('warn', 'cli_worker_request_failed', {
        method,
        path,
        status: response.status,
      })
      if (response.status === 429) {
        const raw = response.headers?.['retry-after']
        const seconds = typeof raw === 'string' ? parseInt(raw, 10) : NaN
        if (!isNaN(seconds) && seconds >= 0) {
          return { ok: false, retryAfterMs: seconds * 1000 }
        }
      }
      return { ok: false }
    } catch (error) {
      logForDebugging(`CCRClient: ${label} failed: ${errorMessage(error)}`, {
        level: 'warn',
      })
      logForDiagnosticsNoPII('warn', 'cli_worker_request_error', {
        method,
        path,
        error_code: getErrnoCode(error),
      })
      return { ok: false }
    }
  }

  /** 通过 PUT /sessions/{id}/worker 向 CCR 上报 worker 状态。 */
  reportState(state: SessionState, details?: RequiresActionDetails): void {
    if (state === this.currentState && !details) return
    this.currentState = state
    this.workerState.enqueue({
      worker_status: state,
      requires_action_details: details
        ? {
            tool_name: details.tool_name,
            action_description: details.action_description,
            request_id: details.request_id,
          }
        : null,
    })
  }

  /** 通过 PUT /worker 向 CCR 上报 external metadata。 */
  reportMetadata(metadata: Record<string, unknown>): void {
    this.workerState.enqueue({ external_metadata: metadata })
  }

  /**
   * 处理 epoch 不匹配（409 Conflict）。一个更新的 CC 实例已替换了当前
   * 实例 —— 立即退出。
   */
  private handleEpochMismatch(): never {
    logForDebugging('CCRClient: Epoch mismatch (409), shutting down', {
      level: 'error',
    })
    logForDiagnosticsNoPII('error', 'cli_worker_epoch_mismatch')
    this.onEpochMismatch()
  }

  /** 启动周期性心跳。 */
  private startHeartbeat(): void {
    this.stopHeartbeat()
    const schedule = (): void => {
      const jitter =
        this.heartbeatIntervalMs *
        this.heartbeatJitterFraction *
        (2 * Math.random() - 1)
      this.heartbeatTimer = setTimeout(tick, this.heartbeatIntervalMs + jitter)
    }
    const tick = (): void => {
      void this.sendHeartbeat()
      // stopHeartbeat 会把定时器置空；在 fire-and-forget 发送之后、
      // 重新调度之前进行检查，以便 close() 在 sendHeartbeat 进行中
      // 时也能被尊重。
      if (this.heartbeatTimer === null) return
      schedule()
    }
    schedule()
  }

  /** 停止心跳定时器。 */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  /** 通过 POST /sessions/{id}/worker/heartbeat 发送心跳。 */
  private async sendHeartbeat(): Promise<void> {
    if (this.heartbeatInFlight) return
    this.heartbeatInFlight = true
    try {
      const result = await this.request(
        'post',
        '/worker/heartbeat',
        { session_id: this.sessionId, worker_epoch: this.workerEpoch },
        'Heartbeat',
        { timeout: 5_000 },
      )
      if (result.ok) {
        logForDebugging('CCRClient: Heartbeat sent')
      }
    } finally {
      this.heartbeatInFlight = false
    }
  }

  /**
   * 通过 POST /sessions/{id}/worker/events 将 StdoutMessage 写为 client event。
   * 这些事件通过 SSE 流对前端客户端可见。
   * 若缺失则注入 UUID，以保证重试时服务端幂等。
   *
   * stream_event 消息会暂存在 100ms 的延迟缓冲区中并累积（同一 content block
   * 的 text_delta 在每次 flush 时发出“截至目前完整内容”的快照）。
   * 非 stream_event 的写入会先把缓冲区 flush，以保留下游顺序。
   */
  async writeEvent(message: StdoutMessage): Promise<void> {
    if (message.type === 'stream_event') {
      this.streamEventBuffer.push(message)
      if (!this.streamEventTimer) {
        this.streamEventTimer = setTimeout(
          () => void this.flushStreamEventBuffer(),
          STREAM_EVENT_FLUSH_INTERVAL_MS,
        )
      }
      return
    }
    await this.flushStreamEventBuffer()
    if (message.type === 'assistant') {
      clearStreamAccumulatorForMessage(
        this.streamTextAccumulator,
        message as {
          session_id: string
          parent_tool_use_id: string | null
          message: { id: string }
        },
      )
    }
    await this.eventUploader.enqueue(this.toClientEvent(message))
  }

  /** 将 StdoutMessage 包装为 ClientEvent，缺失时注入 UUID。 */
  private toClientEvent(message: StdoutMessage): ClientEvent {
    const msg = message as unknown as Record<string, unknown>
    return {
      payload: {
        ...msg,
        uuid: typeof msg.uuid === 'string' ? msg.uuid : randomUUID(),
      } as EventPayload,
    }
  }

  /**
   * 排空 stream_event 延迟缓冲区：将 text_delta 累积为“截至目前完整内容”
   * 的快照，清除定时器，并把结果事件入队。
   * 由定时器调用、由 writeEvent 在非流消息时调用、以及由 flush() 调用。
   * close() 会丢弃缓冲区 —— 若需要投递，请先调用 flush()。
   */
  private async flushStreamEventBuffer(): Promise<void> {
    if (this.streamEventTimer) {
      clearTimeout(this.streamEventTimer)
      this.streamEventTimer = null
    }
    if (this.streamEventBuffer.length === 0) return
    const buffered = this.streamEventBuffer
    this.streamEventBuffer = []
    const payloads = accumulateStreamEvents(
      buffered,
      this.streamTextAccumulator,
    )
    await this.eventUploader.enqueue(
      payloads.map(payload => ({ payload, ephemeral: true })),
    )
  }

  /**
   * 通过 POST /sessions/{id}/worker/internal-events 写入一条 worker 内部事件。
   * 这些事件对前端客户端不可见 —— 它们存储 worker 内部状态（会话记录消息、
   * 压缩标记），用于 session 恢复。
   */
  async writeInternalEvent(
    eventType: string,
    payload: Record<string, unknown>,
    {
      isCompaction = false,
      agentId,
    }: {
      isCompaction?: boolean
      agentId?: string
    } = {},
  ): Promise<void> {
    const event: WorkerEvent = {
      payload: {
        type: eventType,
        ...payload,
        uuid: typeof payload.uuid === 'string' ? payload.uuid : randomUUID(),
      } as EventPayload,
      ...(isCompaction && { is_compaction: true }),
      ...(agentId && { agent_id: agentId }),
    }
    await this.internalEventUploader.enqueue(event)
  }

  /**
   * 刷新挂起的内部事件。在轮次之间以及关闭时调用，
   * 以确保会话记录条目被持久化。
   */
  flushInternalEvents(): Promise<void> {
    return this.internalEventUploader.flush()
  }

  /**
   * 刷新挂起的 client event（writeEvent 队列）。当调用方需要投递确认时，
   * 在 close() 之前调用 —— close() 会抛弃队列。在上传器排空或拒绝之后
   * resolve；无论单个 POST 是否成功都会返回（如需关心，请另行检查
   * 服务端状态）。
   */
  async flush(): Promise<void> {
    await this.flushStreamEventBuffer()
    return this.eventUploader.flush()
  }

  /**
   * 从 GET /sessions/{id}/worker/internal-events 读取前台 agent 内部事件。
   * 返回自上一次压缩边界以来的会话记录条目，失败时返回 null。
   * 用于 session 恢复。
   */
  async readInternalEvents(): Promise<InternalEvent[] | null> {
    return this.paginatedGet('/worker/internal-events', {}, 'internal_events')
  }

  /**
   * 从 GET /sessions/{id}/worker/internal-events?subagents=true 读取所有
   * 子 agent 的内部事件。返回跨所有非前台 agent 的合并流，每条都从其
   * 压缩点开始。用于 session 恢复。
   */
  async readSubagentInternalEvents(): Promise<InternalEvent[] | null> {
    return this.paginatedGet(
      '/worker/internal-events',
      { subagents: 'true' },
      'subagent_events',
    )
  }

  /**
   * 带重试的分页 GET。从列表端点拉取所有页面，每页失败时以指数退避 + 抖动重试。
   */
  private async paginatedGet(
    path: string,
    params: Record<string, string>,
    context: string,
  ): Promise<InternalEvent[] | null> {
    const authHeaders = this.getAuthHeaders()
    if (Object.keys(authHeaders).length === 0) return null

    const allEvents: InternalEvent[] = []
    let cursor: string | undefined

    do {
      const url = new URL(`${this.sessionBaseUrl}${path}`)
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v)
      }
      if (cursor) {
        url.searchParams.set('cursor', cursor)
      }

      const page = await this.getWithRetry<ListInternalEventsResponse>(
        url.toString(),
        authHeaders,
        context,
      )
      if (!page) return null

      allEvents.push(...(page.data ?? []))
      cursor = page.next_cursor
    } while (cursor)

    logForDebugging(
      `CCRClient: Read ${allEvents.length} internal events from ${path}${params.subagents ? ' (subagents)' : ''}`,
    )
    return allEvents
  }

  /**
   * 带重试的单次 GET 请求。成功时返回解析后的响应体，
   * 所有重试耗尽时返回 null。
   */
  private async getWithRetry<T>(
    url: string,
    authHeaders: Record<string, string>,
    context: string,
  ): Promise<T | null> {
    for (let attempt = 1; attempt <= 10; attempt++) {
      let response
      try {
        response = await this.http.get<T>(url, {
          headers: {
            ...authHeaders,
            'anthropic-version': '2023-06-01',
            'User-Agent': getClaudeCodeUserAgent(),
          },
          validateStatus: alwaysValidStatus,
          timeout: 30_000,
        })
      } catch (error) {
        logForDebugging(
          `CCRClient: GET ${url} failed (attempt ${attempt}/10): ${errorMessage(error)}`,
          { level: 'warn' },
        )
        if (attempt < 10) {
          const delay =
            Math.min(500 * 2 ** (attempt - 1), 30_000) + Math.random() * 500
          await sleep(delay)
        }
        continue
      }

      if (response.status >= 200 && response.status < 300) {
        return response.data
      }
      if (response.status === 409) {
        this.handleEpochMismatch()
      }
      logForDebugging(
        `CCRClient: GET ${url} returned ${response.status} (attempt ${attempt}/10)`,
        { level: 'warn' },
      )

      if (attempt < 10) {
        const delay =
          Math.min(500 * 2 ** (attempt - 1), 30_000) + Math.random() * 500
        await sleep(delay)
      }
    }

    logForDebugging('CCRClient: GET retries exhausted', { level: 'error' })
    logForDiagnosticsNoPII('error', 'cli_worker_get_retries_exhausted', {
      context,
    })
    return null
  }

  /**
   * 上报 client-to-worker 事件的投递状态。
   * POST /v1/code/sessions/{id}/worker/events/delivery（批量端点）
   */
  reportDelivery(
    eventId: string,
    status: 'received' | 'processing' | 'processed',
  ): void {
    void this.deliveryUploader.enqueue({ eventId, status })
  }

  /** 获取当前 epoch（供外部使用）。 */
  getWorkerEpoch(): number {
    return this.workerEpoch
  }

  /** 内部事件队列深度 —— 关闭快照的背压信号。 */
  get internalEventsPending(): number {
    return this.internalEventUploader.pendingCount
  }

  /** 清理上传器与定时器。 */
  close(): void {
    this.closed = true
    this.stopHeartbeat()
    unregisterSessionActivityCallback()
    if (this.streamEventTimer) {
      clearTimeout(this.streamEventTimer)
      this.streamEventTimer = null
    }
    this.streamEventBuffer = []
    this.streamTextAccumulator.byMessage.clear()
    this.streamTextAccumulator.scopeToMessage.clear()
    this.workerState.close()
    this.eventUploader.close()
    this.internalEventUploader.close()
    this.deliveryUploader.close()
  }
}
