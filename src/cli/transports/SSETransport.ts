import axios, { type AxiosError } from 'axios'
import type { StdoutMessage } from 'src/entrypoints/sdk/controlTypes.js'
import { logForDebugging } from '../../utils/debug.js'
import { rcLog } from '../../bridge/rcDebugLog.js'
import { logForDiagnosticsNoPII } from '../../utils/diagLogs.js'
import { errorMessage } from '../../utils/errors.js'
import { getSessionIngressAuthHeaders } from '../../utils/sessionIngressAuth.js'
import { sleep } from '../../utils/sleep.js'
import { jsonParse, jsonStringify } from '../../utils/slowOperations.js'
import { getClaudeCodeUserAgent } from '../../utils/userAgent.js'
import type { Transport } from './Transport.js'

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const RECONNECT_BASE_DELAY_MS = 1000
const RECONNECT_MAX_DELAY_MS = 30_000
/** 放弃之前的重连尝试时间预算（10 分钟）。 */
const RECONNECT_GIVE_UP_MS = 600_000
/** 服务端每 15s 发送一次 keepalive；静默 45s 后视为连接已死。 */
const LIVENESS_TIMEOUT_MS = 45_000

/**
 * 表示服务端永久性拒绝的 HTTP 状态码。
 * 传输层会立即转为 'closed' 状态，不再重试。
 */
const PERMANENT_HTTP_CODES = new Set([401, 403, 404])

// POST 重试配置（与 HybridTransport 一致）
const POST_MAX_RETRIES = 10
const POST_BASE_DELAY_MS = 500
const POST_MAX_DELAY_MS = 8000

/** 提升为顶层的 TextDecoder 选项，避免 readStream 中每个 chunk 都分配。 */
const STREAM_DECODE_OPTS: TextDecodeOptions = { stream: true }

/** 提升为顶层的 axios validateStatus 回调，避免每次请求都分配闭包。 */
function alwaysValidStatus(): boolean {
  return true
}

// ---------------------------------------------------------------------------
// SSE 帧解析器
// ---------------------------------------------------------------------------

type SSEFrame = {
  event?: string
  id?: string
  data?: string
}

/**
 * 从文本缓冲区增量解析 SSE 帧。
 * 返回解析出的帧以及剩余（不完整的）缓冲区。
 *
 * @internal 导出以供测试
 */
export function parseSSEFrames(buffer: string): {
  frames: SSEFrame[]
  remaining: string
} {
  const frames: SSEFrame[] = []
  let pos = 0

  // SSE 帧以空行分隔。支持 LF 和 CRLF 流。
  const frameDelimiter = /\r?\n\r?\n/g
  frameDelimiter.lastIndex = pos

  let delimiterMatch: RegExpExecArray | null
  while ((delimiterMatch = frameDelimiter.exec(buffer)) !== null) {
    const frameEnd = delimiterMatch.index
    const rawFrame = buffer.slice(pos, frameEnd)
    pos = frameEnd + delimiterMatch[0].length

    // 跳过空帧
    if (!rawFrame.trim()) continue

    const frame: SSEFrame = {}
    let isComment = false

    for (const rawLine of rawFrame.split('\n')) {
      // 在行尾符混用的流中规范化 CRLF 行。
      const line =
        rawLine[rawLine.length - 1] === '\r' ? rawLine.slice(0, -1) : rawLine

      if (line.startsWith(':')) {
        // SSE 注释（例如 `:keepalive`）
        isComment = true
        continue
      }

      const colonIdx = line.indexOf(':')
      if (colonIdx === -1) continue

      const field = line.slice(0, colonIdx)
      // 按 SSE 规范，若冒号后紧跟一个空格则去掉该空格
      const value =
        line[colonIdx + 1] === ' '
          ? line.slice(colonIdx + 2)
          : line.slice(colonIdx + 1)

      switch (field) {
        case 'event':
          frame.event = value
          break
        case 'id':
          frame.id = value
          break
        case 'data':
          // 按 SSE 规范，多行 data: 以 \n 拼接
          frame.data = frame.data ? frame.data + '\n' + value : value
          break
        // 忽略其他字段（retry: 等）
      }
    }

    // 只发出含 data 的帧（或纯注释，用于重置存活判定）
    if (frame.data || isComment) {
      frames.push(frame)
    }
  }

  return { frames, remaining: buffer.slice(pos) }
}

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

type SSETransportState =
  | 'idle'
  | 'connected'
  | 'reconnecting'
  | 'closing'
  | 'closed'

/**
 * `event: client_event` 帧的负载，对应 session_stream.proto 中的
 * StreamClientEvent proto 消息。这是发送给 worker 订阅者的唯一事件类型
 * —— delivery_update、session_update、ephemeral_event 和 catch_up_truncated
 * 仅用于客户端通道（见 notifier.go 与 event_stream.go 的 SubscriberClient 守卫）。
 */
export type StreamClientEvent = {
  event_id: string
  sequence_num: number
  event_type: string
  source: string
  payload: Record<string, unknown>
  created_at: string
}

// ---------------------------------------------------------------------------
// SSETransport（基于 SSE 的传输实现）
// ---------------------------------------------------------------------------

/**
 * 使用 SSE 读取、HTTP POST 写入的传输层。
 *
 * 通过 Server-Sent Events 从 CCR v2 事件流端点读取事件。
 * 通过 HTTP POST 写入事件，带重试逻辑（与 HybridTransport 相同的模式）。
 *
 * 每个 `event: client_event` 帧在 `data:` 中直接携带 StreamClientEvent proto
 * JSON。传输层提取 `payload` 并以换行分隔的 JSON 形式传给 `onData`，
 * 供 StructuredIO 消费方使用。
 *
 * 支持指数退避的自动重连，并在断开后使用 Last-Event-ID 进行续传。
 */
export class SSETransport implements Transport {
  private state: SSETransportState = 'idle'
  private onData?: (data: string) => void
  private onCloseCallback?: (closeCode?: number) => void
  private onEventCallback?: (event: StreamClientEvent) => void
  private headers: Record<string, string>
  private sessionId?: string
  private refreshHeaders?: () => Record<string, string>
  private readonly getAuthHeaders: () => Record<string, string>

  // SSE 连接状态
  private abortController: AbortController | null = null
  private lastSequenceNum = 0
  private seenSequenceNums = new Set<number>()

  // 重连状态
  private reconnectAttempts = 0
  private reconnectStartTime: number | null = null
  private reconnectTimer: NodeJS.Timeout | null = null

  // 存活检测
  private livenessTimer: NodeJS.Timeout | null = null
  private lastActivityTime = 0

  // POST URL（由 SSE URL 推导）
  private postUrl: string

  // CCR v2 事件格式的运行时 epoch

  constructor(
    private readonly url: URL,
    headers: Record<string, string> = {},
    sessionId?: string,
    refreshHeaders?: () => Record<string, string>,
    initialSequenceNum?: number,
    /**
     * 实例级的认证头来源。省略则读取进程级的
     * CLAUDE_CODE_SESSION_ACCESS_TOKEN（单会话调用方）。并发多会话调用方
     * 必须提供 —— 环境变量路径是进程全局的，会在多个会话之间互相覆盖。
     */
    getAuthHeaders?: () => Record<string, string>,
  ) {
    this.headers = headers
    this.sessionId = sessionId
    this.refreshHeaders = refreshHeaders
    this.getAuthHeaders = getAuthHeaders ?? getSessionIngressAuthHeaders
    this.postUrl = convertSSEUrlToPostUrl(url)
    // 以调用方提供的高水位线作为种子，使首次 connect() 发送
    // from_sequence_num / Last-Event-ID。否则新的 SSETransport 总是请求
    // 服务端从序列 0 回放 —— 每次更换传输层都会重放整个会话历史。
    if (initialSequenceNum !== undefined && initialSequenceNum > 0) {
      this.lastSequenceNum = initialSequenceNum
    }
    logForDebugging(`SSETransport: SSE URL = ${url.href}`)
    logForDebugging(`SSETransport: POST URL = ${this.postUrl}`)
    logForDiagnosticsNoPII('info', 'cli_sse_transport_initialized')
  }

  /**
   * 本流上见过的 sequence number 高水位线。重建传输层的调用方
   * （例如 replBridge 的 onWorkReceived）会在 close() 之前读取它，
   * 并作为 `initialSequenceNum` 传给下一个实例，以便服务端从正确的
   * 点续传，而不是全部回放。
   */
  getLastSequenceNum(): number {
    return this.lastSequenceNum
  }

  async connect(): Promise<void> {
    if (this.state !== 'idle' && this.state !== 'reconnecting') {
      logForDebugging(
        `SSETransport: Cannot connect, current state is ${this.state}`,
        { level: 'error' },
      )
      logForDiagnosticsNoPII('error', 'cli_sse_connect_failed')
      return
    }

    this.state = 'reconnecting'
    const connectStartTime = Date.now()

    // 构造带 sequence number 的 SSE URL 以便续传
    const sseUrl = new URL(this.url.href)
    if (this.lastSequenceNum > 0) {
      sseUrl.searchParams.set('from_sequence_num', String(this.lastSequenceNum))
    }

    // 构造 headers —— 使用最新的认证头（支持 Cookie 形式的 session key）。
    // 使用 Cookie 认证时移除 this.headers 中陈旧的 Authorization 头，
    // 因为同时发送两者会让认证拦截器困惑。
    const authHeaders = this.getAuthHeaders()
    const headers: Record<string, string> = {
      ...this.headers,
      ...authHeaders,
      Accept: 'text/event-stream',
      'anthropic-version': '2023-06-01',
      'User-Agent': getClaudeCodeUserAgent(),
    }
    if (authHeaders['Cookie']) {
      delete headers['Authorization']
    }
    if (this.lastSequenceNum > 0) {
      headers['Last-Event-ID'] = String(this.lastSequenceNum)
    }

    logForDebugging(`SSETransport: Opening ${sseUrl.href}`)
    logForDiagnosticsNoPII('info', 'cli_sse_connect_opening')

    this.abortController = new AbortController()

    try {
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      const response = await fetch(sseUrl.href, {
        headers,
        signal: this.abortController.signal,
      })

      if (!response.ok) {
        const isPermanent = PERMANENT_HTTP_CODES.has(response.status)
        logForDebugging(
          `SSETransport: HTTP ${response.status}${isPermanent ? ' (permanent)' : ''}`,
          { level: 'error' },
        )
        logForDiagnosticsNoPII('error', 'cli_sse_connect_http_error', {
          status: response.status,
        })

        if (isPermanent) {
          this.state = 'closed'
          this.onCloseCallback?.(response.status)
          return
        }

        this.handleConnectionError()
        return
      }

      if (!response.body) {
        logForDebugging('SSETransport: No response body')
        this.handleConnectionError()
        return
      }

      // 成功连接
      const connectDuration = Date.now() - connectStartTime
      logForDebugging('SSETransport: Connected')
      logForDiagnosticsNoPII('info', 'cli_sse_connect_connected', {
        duration_ms: connectDuration,
      })

      this.state = 'connected'
      this.reconnectAttempts = 0
      this.reconnectStartTime = null
      this.resetLivenessTimer()

      // 读取 SSE 流
      await this.readStream(response.body)
    } catch (error) {
      if (this.abortController?.signal.aborted) {
        // 主动关闭
        return
      }

      logForDebugging(
        `SSETransport: Connection error: ${errorMessage(error)}`,
        { level: 'error' },
      )
      logForDiagnosticsNoPII('error', 'cli_sse_connect_error')
      this.handleConnectionError()
    }
  }

  /**
   * 读取并处理 SSE 流的 body。
   */
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  private async readStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const MAX_BUFFER_BYTES = 1024 * 1024 // 1MB —— SSE 帧包含 event/data/id 前缀

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, STREAM_DECODE_OPTS)
        if (buffer.length > MAX_BUFFER_BYTES) {
          logForDebugging(
            `SSETransport: Buffer exceeded ${MAX_BUFFER_BYTES} bytes — dropping connection`,
            { level: 'error' },
          )
          logForDiagnosticsNoPII('error', 'cli_sse_buffer_overflow')
          break
        }
        const { frames, remaining } = parseSSEFrames(buffer)
        buffer = remaining

        for (const frame of frames) {
          // 任何帧（包括 keepalive 注释）都证明连接仍存活
          this.resetLivenessTimer()

          if (frame.id) {
            const seqNum = parseInt(frame.id, 10)
            if (!isNaN(seqNum)) {
              if (this.seenSequenceNums.has(seqNum)) {
                logForDebugging(
                  `SSETransport: DUPLICATE frame seq=${seqNum} (lastSequenceNum=${this.lastSequenceNum}, seenCount=${this.seenSequenceNums.size})`,
                  { level: 'warn' },
                )
                logForDiagnosticsNoPII('warn', 'cli_sse_duplicate_sequence')
              } else {
                this.seenSequenceNums.add(seqNum)
                // 避免无限增长：当条目很多时，清理那些远低于高水位线的
                // 旧 sequence number。只有靠近 lastSequenceNum 的 sequence
                // number 才对去重有意义。
                if (this.seenSequenceNums.size > 1000) {
                  const threshold = this.lastSequenceNum - 200
                  for (const s of this.seenSequenceNums) {
                    if (s < threshold) {
                      this.seenSequenceNums.delete(s)
                    }
                  }
                }
              }
              if (seqNum > this.lastSequenceNum) {
                this.lastSequenceNum = seqNum
              }
            }
          }

          if (frame.event && frame.data) {
            this.handleSSEFrame(frame.event, frame.data)
          } else if (frame.data) {
            // 只有 data: 没有 event: —— 服务端在发送旧的 envelope 格式，
            // 或者是 bug。记录日志让事故以信号形式出现，而不是被静默丢弃。
            logForDebugging(
              'SSETransport: Frame has data: but no event: field — dropped',
              { level: 'warn' },
            )
            logForDiagnosticsNoPII('warn', 'cli_sse_frame_missing_event_field')
          }
        }
      }
    } catch (error) {
      if (this.abortController?.signal.aborted) return
      logForDebugging(
        `SSETransport: Stream read error: ${errorMessage(error)}`,
        { level: 'error' },
      )
      logForDiagnosticsNoPII('error', 'cli_sse_stream_read_error')
    } finally {
      reader.releaseLock()
    }

    // 流结束 —— 除非正在关闭，否则重连
    if (this.state !== 'closing' && this.state !== 'closed') {
      logForDebugging('SSETransport: Stream ended, reconnecting')
      this.handleConnectionError()
    }
  }

  /**
   * 处理单个 SSE 帧。event: 字段命名变体；data: 直接携带内部 proto JSON
   * （没有 envelope）。
   *
   * Worker 订阅者只会收到 client_event 帧（见 notifier.go）—— 任何其他
   * 事件类型都说明服务端发生了 CC 尚未理解的变更。记录一条诊断，
   * 以便我们在遥测中注意到。
   */
  private handleSSEFrame(eventType: string, data: string): void {
    if (eventType !== 'client_event') {
      logForDebugging(
        `SSETransport: Unexpected SSE event type '${eventType}' on worker stream`,
        { level: 'warn' },
      )
      logForDiagnosticsNoPII('warn', 'cli_sse_unexpected_event_type', {
        event_type: eventType,
      })
      return
    }

    let ev: StreamClientEvent
    try {
      ev = jsonParse(data) as StreamClientEvent
    } catch (error) {
      logForDebugging(
        `SSETransport: Failed to parse client_event data: ${errorMessage(error)}`,
        { level: 'error' },
      )
      return
    }

    const payload = ev.payload
    if (payload && typeof payload === 'object' && 'type' in payload) {
      const sessionLabel = this.sessionId ? ` session=${this.sessionId}` : ''
      // debug 类型事件量大，跳过 logForDebugging 避免触发 sink 无限循环
      const debugEventTypes = new Set([
        'debug_log',
        'sdk_raw',
        'tool_trace',
        'usage',
      ])
      if (
        !debugEventTypes.has(ev.event_type) &&
        !debugEventTypes.has(String(payload.type))
      ) {
        logForDebugging(
          `SSETransport: Event seq=${ev.sequence_num} event_id=${ev.event_id} event_type=${ev.event_type} payload_type=${String(payload.type)}${sessionLabel}`,
        )
      }
      logForDiagnosticsNoPII('info', 'cli_sse_message_received')
      // 将解包后的 payload 以换行分隔的 JSON 形式传出，
      // 与 StructuredIO/WebSocketTransport 消费方期望的格式一致
      this.onData?.(jsonStringify(payload) + '\n')
    } else {
      logForDebugging(
        `SSETransport: Ignoring client_event with no type in payload: event_id=${ev.event_id}`,
      )
    }

    this.onEventCallback?.(ev)
  }

  /**
   * 以指数退避和时间预算处理连接错误。
   */
  private handleConnectionError(): void {
    rcLog(
      `SSE handleConnectionError: state=${this.state}` +
        ` lastSeqNum=${this.getLastSequenceNum()}` +
        ` reconnectAttempts=${this.reconnectAttempts}` +
        ` msSinceLastActivity=${this.lastActivityTime > 0 ? Date.now() - this.lastActivityTime : -1}`,
    )
    this.clearLivenessTimer()

    if (this.state === 'closing' || this.state === 'closed') return

    // 中止在途的 SSE fetch
    this.abortController?.abort()
    this.abortController = null

    const now = Date.now()
    if (!this.reconnectStartTime) {
      this.reconnectStartTime = now
    }

    const elapsed = now - this.reconnectStartTime
    if (elapsed < RECONNECT_GIVE_UP_MS) {
      // 清除任何已存在的定时器
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
      }

      // 重连前刷新 headers
      if (this.refreshHeaders) {
        const freshHeaders = this.refreshHeaders()
        Object.assign(this.headers, freshHeaders)
        logForDebugging('SSETransport: Refreshed headers for reconnect')
      }

      this.state = 'reconnecting'
      this.reconnectAttempts++

      const baseDelay = Math.min(
        RECONNECT_BASE_DELAY_MS * 2 ** (this.reconnectAttempts - 1),
        RECONNECT_MAX_DELAY_MS,
      )
      // 加 ±25% 的抖动
      const delay = Math.max(
        0,
        baseDelay + baseDelay * 0.25 * (2 * Math.random() - 1),
      )

      logForDebugging(
        `SSETransport: Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts}, ${Math.round(elapsed / 1000)}s elapsed)`,
      )
      logForDiagnosticsNoPII('error', 'cli_sse_reconnect_attempt', {
        reconnectAttempts: this.reconnectAttempts,
      })

      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null
        void this.connect()
      }, delay)
    } else {
      logForDebugging(
        `SSETransport: Reconnection time budget exhausted after ${Math.round(elapsed / 1000)}s`,
        { level: 'error' },
      )
      logForDiagnosticsNoPII('error', 'cli_sse_reconnect_exhausted', {
        reconnectAttempts: this.reconnectAttempts,
        elapsedMs: elapsed,
      })
      this.state = 'closed'
      this.onCloseCallback?.()
    }
  }

  /**
   * 有界的超时回调。从内联闭包提升为成员，使得 resetLivenessTimer
   * （每个帧都会调用）不会在每个 SSE 帧上都分配新的闭包。
   */
  private readonly onLivenessTimeout = (): void => {
    this.livenessTimer = null
    rcLog(
      `SSE liveness timeout (${LIVENESS_TIMEOUT_MS}ms)` +
        ` lastSeqNum=${this.getLastSequenceNum()}` +
        ` state=${this.state}`,
    )
    logForDebugging('SSETransport: Liveness timeout, reconnecting', {
      level: 'error',
    })
    logForDiagnosticsNoPII('error', 'cli_sse_liveness_timeout')
    this.abortController?.abort()
    this.handleConnectionError()
  }

  /**
   * 重置存活定时器。若超时之内没有任何 SSE 帧到达，
   * 视为连接已死并重连。
   */
  private resetLivenessTimer(): void {
    this.clearLivenessTimer()
    this.livenessTimer = setTimeout(this.onLivenessTimeout, LIVENESS_TIMEOUT_MS)
  }

  private clearLivenessTimer(): void {
    if (this.livenessTimer) {
      clearTimeout(this.livenessTimer)
      this.livenessTimer = null
    }
  }

  // -----------------------------------------------------------------------
  // 写入（HTTP POST）—— 与 HybridTransport 相同的模式
  // -----------------------------------------------------------------------

  async write(message: StdoutMessage): Promise<void> {
    const authHeaders = this.getAuthHeaders()
    if (Object.keys(authHeaders).length === 0) {
      logForDebugging('SSETransport: No session token available for POST')
      logForDiagnosticsNoPII('warn', 'cli_sse_post_no_token')
      return
    }

    const headers: Record<string, string> = {
      ...authHeaders,
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'User-Agent': getClaudeCodeUserAgent(),
    }

    logForDebugging(
      `SSETransport: POST body keys=${Object.keys(message as Record<string, unknown>).join(',')}`,
    )

    for (let attempt = 1; attempt <= POST_MAX_RETRIES; attempt++) {
      try {
        const response = await axios.post(this.postUrl, message, {
          headers,
          validateStatus: alwaysValidStatus,
        })

        if (response.status === 200 || response.status === 201) {
          logForDebugging(`SSETransport: POST success type=${message.type}`)
          return
        }

        logForDebugging(
          `SSETransport: POST ${response.status} body=${jsonStringify(response.data).slice(0, 200)}`,
        )
        // 4xx 错误（除 429 外）是永久性的 —— 不重试
        if (
          response.status >= 400 &&
          response.status < 500 &&
          response.status !== 429
        ) {
          logForDebugging(
            `SSETransport: POST returned ${response.status} (client error), not retrying`,
          )
          logForDiagnosticsNoPII('warn', 'cli_sse_post_client_error', {
            status: response.status,
          })
          return
        }

        // 429 或 5xx —— 重试
        logForDebugging(
          `SSETransport: POST returned ${response.status}, attempt ${attempt}/${POST_MAX_RETRIES}`,
        )
        logForDiagnosticsNoPII('warn', 'cli_sse_post_retryable_error', {
          status: response.status,
          attempt,
        })
      } catch (error) {
        const axiosError = error as AxiosError
        logForDebugging(
          `SSETransport: POST error: ${axiosError.message}, attempt ${attempt}/${POST_MAX_RETRIES}`,
        )
        logForDiagnosticsNoPII('warn', 'cli_sse_post_network_error', {
          attempt,
        })
      }

      if (attempt === POST_MAX_RETRIES) {
        logForDebugging(
          `SSETransport: POST failed after ${POST_MAX_RETRIES} attempts, continuing`,
        )
        logForDiagnosticsNoPII('warn', 'cli_sse_post_retries_exhausted')
        return
      }

      const delayMs = Math.min(
        POST_BASE_DELAY_MS * 2 ** (attempt - 1),
        POST_MAX_DELAY_MS,
      )
      await sleep(delayMs)
    }
  }

  // -----------------------------------------------------------------------
  // Transport 接口
  // -----------------------------------------------------------------------

  isConnectedStatus(): boolean {
    return this.state === 'connected'
  }

  isClosedStatus(): boolean {
    return this.state === 'closed'
  }

  setOnData(callback: (data: string) => void): void {
    this.onData = callback
  }

  setOnClose(callback: (closeCode?: number) => void): void {
    this.onCloseCallback = callback
  }

  setOnEvent(callback: (event: StreamClientEvent) => void): void {
    this.onEventCallback = callback
  }

  close(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.clearLivenessTimer()

    this.state = 'closing'
    this.abortController?.abort()
    this.abortController = null
  }
}

// ---------------------------------------------------------------------------
// URL 转换
// ---------------------------------------------------------------------------

/**
 * 将 SSE URL 转换为 HTTP POST 端点 URL。
 * SSE 流 URL 和 POST URL 共享同一个 base；POST 端点位于 `/events`
 * （不带 `/stream`）。
 *
 * From: https://api.example.com/v2/session_ingress/session/<session_id>/events/stream
 * To:   https://api.example.com/v2/session_ingress/session/<session_id>/events
 */
function convertSSEUrlToPostUrl(sseUrl: URL): string {
  let pathname = sseUrl.pathname
  // 移除 /stream 后缀，得到 POST events 端点
  if (pathname.endsWith('/stream')) {
    pathname = pathname.slice(0, -'/stream'.length)
  }
  return `${sseUrl.protocol}//${sseUrl.host}${pathname}`
}
