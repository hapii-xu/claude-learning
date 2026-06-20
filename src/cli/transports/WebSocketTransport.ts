import type { StdoutMessage } from 'src/entrypoints/sdk/controlTypes.js'
import type WsWebSocket from 'ws'
import { logEvent } from '../../services/analytics/index.js'
import { CircularBuffer } from '../../utils/CircularBuffer.js'
import { logForDebugging } from '../../utils/debug.js'
import { rcLog } from '../../bridge/rcDebugLog.js'
import { logForDiagnosticsNoPII } from '../../utils/diagLogs.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { getWebSocketTLSOptions } from '../../utils/mtls.js'
import {
  getWebSocketProxyAgent,
  getWebSocketProxyUrl,
} from '../../utils/proxy.js'
import {
  registerSessionActivityCallback,
  unregisterSessionActivityCallback,
} from '../../utils/sessionActivity.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import type { Transport } from './Transport.js'

const KEEP_ALIVE_FRAME = '{"type":"keep_alive"}\n'

const DEFAULT_MAX_BUFFER_SIZE = 1000
const DEFAULT_BASE_RECONNECT_DELAY = 1000
const DEFAULT_MAX_RECONNECT_DELAY = 30000
/** Time budget for reconnection attempts before giving up (10 minutes). */
const DEFAULT_RECONNECT_GIVE_UP_MS = 600_000
const DEFAULT_PING_INTERVAL = 10000
const DEFAULT_KEEPALIVE_INTERVAL = 120_000 // 2 分钟 —— 必须小于 Bun 的 255s idleTimeout

/**
 * 用于检测系统休眠/唤醒的阈值。若两次连续重连尝试之间的间隔超过此值，
 * 机器很可能进入了休眠。我们重置重连预算并重试 —— 若会话在休眠期间
 * 被回收，服务端会以永久关闭码（4001/1002）拒绝。
 */
const SLEEP_DETECTION_THRESHOLD_MS = DEFAULT_MAX_RECONNECT_DELAY * 2 // 60s

/**
 * 表示服务端永久性拒绝的 WebSocket 关闭码。
 * 传输层会立即转为 'closed' 状态，不再重试。
 */
const PERMANENT_CLOSE_CODES = new Set([
  1002, // 协议错误 —— 服务端拒绝了握手（例如会话被回收）
  4001, // 会话过期 / 未找到
  4003, // 未授权
])

export type WebSocketTransportOptions = {
  /** 为 false 时，传输层在断开后不尝试自动重连。
   *  当调用方有自己的恢复机制（例如 REPL bridge 轮询循环）时使用。
   *  默认为 true。 */
  autoReconnect?: boolean
  /** 控制 tengu_ws_transport_* 遥测事件是否发送。在 REPL bridge 构造处
   *  设为 true，使只有 Remote Control 会话（Cloudflare 空闲超时那一批）
   *  会发送；print 模式的 worker 保持静默。默认为 false。 */
  isBridge?: boolean
}

type WebSocketTransportState =
  | 'idle'
  | 'connected'
  | 'reconnecting'
  | 'closing'
  | 'closed'

// globalThis.WebSocket 与 ws.WebSocket 之间的公共接口
type WebSocketLike = {
  close(): void
  send(data: string): void
  ping?(): void // Bun 和 ws 都支持此方法
}

export class WebSocketTransport implements Transport {
  private ws: WebSocketLike | null = null
  private lastSentId: string | null = null
  protected url: URL
  protected state: WebSocketTransportState = 'idle'
  protected onData?: (data: string) => void
  private onCloseCallback?: (closeCode?: number) => void
  private onConnectCallback?: () => void
  private headers: Record<string, string>
  private sessionId?: string
  private autoReconnect: boolean
  private isBridge: boolean

  // 重连状态
  private reconnectAttempts = 0
  private reconnectStartTime: number | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private lastReconnectAttemptTime: number | null = null
  // 最近一次 WS 数据帧活动的墙上时间（入站消息或出站 ws.send）。用于在
  // 关闭时计算空闲时长 —— 这是诊断代理空闲超时 RST（例如 Cloudflare
  // 5 分钟）的信号。不包括 ping/pong 控制帧（代理不会计入这些）。
  private lastActivityTime = 0

  // 用于连接健康检查的 ping 间隔
  private pingInterval: NodeJS.Timeout | null = null
  private pongReceived = true

  // 周期性 keep_alive 数据帧，用于重置代理的空闲定时器
  private keepAliveInterval: NodeJS.Timeout | null = null

  // 用于重连时回放的消息缓冲
  private messageBuffer: CircularBuffer<StdoutMessage>
  // 追踪当前使用的是哪个运行时的 WS，以便用匹配的 API 卸载监听器
  //（removeEventListener 还是 off）。
  private isBunWs = false

  // 在 connect() 时捕获，用于 handleOpenEvent 的计时。存为实例字段，
  // 使 onOpen 处理器可以是一个稳定的类属性箭头函数（可在 doDisconnect
  // 中移除），而不是一个对局部变量求闭包的闭包。
  private connectStartTime = 0

  private refreshHeaders?: () => Record<string, string>

  constructor(
    url: URL,
    headers: Record<string, string> = {},
    sessionId?: string,
    refreshHeaders?: () => Record<string, string>,
    options?: WebSocketTransportOptions,
  ) {
    this.url = url
    this.headers = headers
    this.sessionId = sessionId
    this.refreshHeaders = refreshHeaders
    this.autoReconnect = options?.autoReconnect ?? true
    this.isBridge = options?.isBridge ?? false
    this.messageBuffer = new CircularBuffer(DEFAULT_MAX_BUFFER_SIZE)
  }

  public async connect(): Promise<void> {
    if (this.state !== 'idle' && this.state !== 'reconnecting') {
      logForDebugging(
        `WebSocketTransport: Cannot connect, current state is ${this.state}`,
        { level: 'error' },
      )
      logForDiagnosticsNoPII('error', 'cli_websocket_connect_failed')
      return
    }
    this.state = 'reconnecting'

    this.connectStartTime = Date.now()
    logForDebugging(`WebSocketTransport: Opening ${this.url.href}`)
    logForDiagnosticsNoPII('info', 'cli_websocket_connect_opening')

    // 以传入的 headers 为起点，再加入运行时 headers
    const headers = { ...this.headers }
    if (this.lastSentId) {
      headers['X-Last-Request-Id'] = this.lastSentId
      logForDebugging(
        `WebSocketTransport: Adding X-Last-Request-Id header: ${this.lastSentId}`,
      )
    }

    if (typeof Bun !== 'undefined') {
      // Bun 的 WebSocket 支持 headers/proxy 选项，但 DOM 类型定义里没有
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      const ws = new globalThis.WebSocket(this.url.href, {
        headers,
        proxy: getWebSocketProxyUrl(this.url.href),
        tls: getWebSocketTLSOptions() || undefined,
      } as unknown as string[])
      this.ws = ws
      this.isBunWs = true

      ws.addEventListener('open', this.onBunOpen)
      ws.addEventListener('message', this.onBunMessage)
      ws.addEventListener('error', this.onBunError)
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      ws.addEventListener('close', this.onBunClose)
      // 'pong' 是 Bun 特有的 —— DOM 类型定义里没有。
      ws.addEventListener('pong', this.onPong)
    } else {
      const { default: WS } = await import('ws')
      const ws = new WS(this.url.href, {
        headers,
        agent: getWebSocketProxyAgent(this.url.href),
        ...getWebSocketTLSOptions(),
      })
      this.ws = ws
      this.isBunWs = false

      ws.on('open', this.onNodeOpen)
      ws.on('message', this.onNodeMessage)
      ws.on('error', this.onNodeError)
      ws.on('close', this.onNodeClose)
      ws.on('pong', this.onPong)
    }
  }

  // --- Bun（原生 WebSocket）事件处理器 ---
  // 以类属性箭头函数形式存储，便于在 doDisconnect() 中移除。若不移除，
  // 每次重连都会让旧的 WS 对象及其 5 个闭包成为孤儿，直到 GC，这在
  // 网络不稳定时会累积。沿用 src/utils/mcpWebSocketTransport.ts 的模式。

  private onBunOpen = () => {
    this.handleOpenEvent()
    // Bun 的 WebSocket 不暴露 upgrade 响应头，
    // 因此回放所有缓冲消息。服务端会按 UUID 去重。
    if (this.lastSentId) {
      this.replayBufferedMessages('')
    }
  }

  private onBunMessage = (event: MessageEvent) => {
    const message =
      typeof event.data === 'string' ? event.data : String(event.data)
    this.lastActivityTime = Date.now()
    logForDiagnosticsNoPII('info', 'cli_websocket_message_received', {
      length: message.length,
    })
    if (this.onData) {
      this.onData(message)
    }
  }

  private onBunError = () => {
    logForDebugging('WebSocketTransport: Error', {
      level: 'error',
    })
    logForDiagnosticsNoPII('error', 'cli_websocket_connect_error')
    // close 事件会在 error 之后触发 —— 让它去调用 handleConnectionError
  }

  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  private onBunClose = (event: CloseEvent) => {
    const isClean = event.code === 1000 || event.code === 1001
    logForDebugging(
      `WebSocketTransport: Closed: ${event.code}`,
      isClean ? undefined : { level: 'error' },
    )
    logForDiagnosticsNoPII('error', 'cli_websocket_connect_closed')
    this.handleConnectionError(event.code)
  }

  // --- Node（ws 包）事件处理器 ---

  private onNodeOpen = () => {
    // 在 handleOpenEvent() 调用 onConnectCallback 之前捕获 ws —— 若回调同步
    // 关闭了传输层，this.ws 会变为 null。旧的内联闭包代码通过闭包捕获隐式
    // 具备了这种安全性。
    const ws = this.ws
    this.handleOpenEvent()
    if (!ws) return
    // 在 upgrade 响应头中查找 last-id（仅 ws 包支持）
    const nws = ws as unknown as WsWebSocket & {
      upgradeReq?: { headers?: Record<string, string> }
    }
    const upgradeResponse = nws.upgradeReq
    if (upgradeResponse?.headers?.['x-last-request-id']) {
      const serverLastId = upgradeResponse.headers['x-last-request-id']
      this.replayBufferedMessages(serverLastId)
    }
  }

  private onNodeMessage = (data: Buffer) => {
    const message = data.toString()
    this.lastActivityTime = Date.now()
    logForDiagnosticsNoPII('info', 'cli_websocket_message_received', {
      length: message.length,
    })
    if (this.onData) {
      this.onData(message)
    }
  }

  private onNodeError = (err: Error) => {
    logForDebugging(`WebSocketTransport: Error: ${err.message}`, {
      level: 'error',
    })
    logForDiagnosticsNoPII('error', 'cli_websocket_connect_error')
    // close 事件会在 error 之后触发 —— 让它去调用 handleConnectionError
  }

  private onNodeClose = (code: number, _reason: Buffer) => {
    const isClean = code === 1000 || code === 1001
    logForDebugging(
      `WebSocketTransport: Closed: ${code}`,
      isClean ? undefined : { level: 'error' },
    )
    logForDiagnosticsNoPII('error', 'cli_websocket_connect_closed')
    this.handleConnectionError(code)
  }

  // --- 共享处理器 ---

  private onPong = () => {
    this.pongReceived = true
  }

  private handleOpenEvent(): void {
    const connectDuration = Date.now() - this.connectStartTime
    logForDebugging('WebSocketTransport: Connected')
    logForDiagnosticsNoPII('info', 'cli_websocket_connect_connected', {
      duration_ms: connectDuration,
    })

    // 重连成功 —— 在重置之前捕获尝试次数和停机时长。
    // reconnectStartTime 在首次连接时为 null，在重开时非 null。
    if (this.isBridge && this.reconnectStartTime !== null) {
      logEvent('tengu_ws_transport_reconnected', {
        attempts: this.reconnectAttempts,
        downtimeMs: Date.now() - this.reconnectStartTime,
      })
    }

    this.reconnectAttempts = 0
    this.reconnectStartTime = null
    this.lastReconnectAttemptTime = null
    this.lastActivityTime = Date.now()
    this.state = 'connected'
    this.onConnectCallback?.()

    // 启动周期性 ping 以检测死连接
    this.startPingInterval()

    // 启动周期性 keep_alive 数据帧以重置代理空闲定时器
    this.startKeepaliveInterval()

    // 注册 session 活动信号回调
    registerSessionActivityCallback(() => {
      void this.write({ type: 'keep_alive' })
    })
  }

  protected sendLine(line: string): boolean {
    if (!this.ws || this.state !== 'connected') {
      logForDebugging('WebSocketTransport: Not connected')
      logForDiagnosticsNoPII('info', 'cli_websocket_send_not_connected')
      return false
    }

    try {
      this.ws.send(line)
      this.lastActivityTime = Date.now()
      return true
    } catch (error) {
      logForDebugging(`WebSocketTransport: Failed to send: ${error}`, {
        level: 'error',
      })
      logForDiagnosticsNoPII('error', 'cli_websocket_send_error')
      // 不要在此处置空 this.ws —— 让 doDisconnect()（经由
      // handleConnectionError）来处理清理，以便在 WS 被释放前先移除监听器。
      this.handleConnectionError()
      return false
    }
  }

  /**
   * 移除在 connect() 中为给定 WebSocket 附加的所有监听器。若不移除，
   * 每次重连都会让旧的 WS 对象及其闭包成为孤儿，直到 GC —— 在网络
   * 不稳定时会累积。沿用 src/utils/mcpWebSocketTransport.ts 的模式。
   */
  private removeWsListeners(ws: WebSocketLike): void {
    if (this.isBunWs) {
      const nws = ws as unknown as globalThis.WebSocket
      nws.removeEventListener('open', this.onBunOpen)
      nws.removeEventListener('message', this.onBunMessage)
      nws.removeEventListener('error', this.onBunError)
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      nws.removeEventListener('close', this.onBunClose)
      // 'pong' 是 Bun 特有的 —— DOM 类型定义里没有
      nws.removeEventListener('pong' as 'message', this.onPong)
    } else {
      const nws = ws as unknown as WsWebSocket
      nws.off('open', this.onNodeOpen)
      nws.off('message', this.onNodeMessage)
      nws.off('error', this.onNodeError)
      nws.off('close', this.onNodeClose)
      nws.off('pong', this.onPong)
    }
  }

  protected doDisconnect(): void {
    // 断开时停止 ping 和 keepalive
    this.stopPingInterval()
    this.stopKeepaliveInterval()

    // 注销 session 活动回调
    unregisterSessionActivityCallback()

    if (this.ws) {
      // 在 close() 之前移除监听器，使旧的 WS 及其闭包可以及时被 GC，
      // 而不是拖延到下一轮 mark-and-sweep。
      this.removeWsListeners(this.ws)
      this.ws.close()
      this.ws = null
    }
  }

  private handleConnectionError(closeCode?: number): void {
    rcLog(
      `WS handleConnectionError: code=${closeCode}` +
        ` state=${this.state}` +
        ` url=${this.url.href.replace(/token=[^&]+/, 'token=***')}` +
        ` msSinceLastActivity=${this.lastActivityTime > 0 ? Date.now() - this.lastActivityTime : -1}` +
        ` reconnectAttempts=${this.reconnectAttempts}`,
    )
    logForDebugging(
      `WebSocketTransport: Disconnected from ${this.url.href}` +
        (closeCode != null ? ` (code ${closeCode})` : ''),
    )
    logForDiagnosticsNoPII('info', 'cli_websocket_disconnected')
    if (this.isBridge) {
      // 每次关闭都触发 —— 包括重连风暴中间的那些（这些从不暴露给
      // onCloseCallback 消费方）。对于 Cloudflare 5 分钟空闲假设：对
      // msSinceLastActivity 做聚类；若峰值集中在 ~300s 且 closeCode 为
      // 1006，那就是代理 RST。
      logEvent('tengu_ws_transport_closed', {
        closeCode,
        msSinceLastActivity:
          this.lastActivityTime > 0 ? Date.now() - this.lastActivityTime : -1,
        // 'connected' = 健康断开（Cloudflare 那种情况）；'reconnecting' =
        // 风暴中途的连接被拒。下面的分支才会改变 state，因此此处读到的是
        // 关闭前的值。
        wasConnected: this.state === 'connected',
        reconnectAttempts: this.reconnectAttempts,
      })
    }
    this.doDisconnect()

    if (this.state === 'closing' || this.state === 'closed') return

    // 永久关闭码：不重试 —— 服务端已明确结束了会话。
    // 例外：4003（未授权）在 refreshHeaders 可用且返回新 token 时可以重试
    //（例如父进程在重连期间签发了新的 session ingress token）。
    let headersRefreshed = false
    if (closeCode === 4003 && this.refreshHeaders) {
      const freshHeaders = this.refreshHeaders()
      if (freshHeaders.Authorization !== this.headers.Authorization) {
        Object.assign(this.headers, freshHeaders)
        headersRefreshed = true
        logForDebugging(
          'WebSocketTransport: 4003 received but headers refreshed, scheduling reconnect',
        )
        logForDiagnosticsNoPII('info', 'cli_websocket_4003_token_refreshed')
      }
    }

    if (
      closeCode != null &&
      PERMANENT_CLOSE_CODES.has(closeCode) &&
      !headersRefreshed
    ) {
      logForDebugging(
        `WebSocketTransport: Permanent close code ${closeCode}, not reconnecting`,
        { level: 'error' },
      )
      logForDiagnosticsNoPII('error', 'cli_websocket_permanent_close', {
        closeCode,
      })
      this.state = 'closed'
      this.onCloseCallback?.(closeCode)
      return
    }

    // 当 autoReconnect 被禁用时，直接进入 closed 状态。
    // 由调用方（例如 REPL bridge 轮询循环）处理恢复。
    if (!this.autoReconnect) {
      this.state = 'closed'
      this.onCloseCallback?.(closeCode)
      return
    }

    // 以指数退避和时间预算调度重连
    const now = Date.now()
    if (!this.reconnectStartTime) {
      this.reconnectStartTime = now
    }

    // 检测系统休眠/唤醒：若距离上一次重连尝试的间隔远超过最大延迟，
    // 机器很可能休眠了（例如笔记本合盖）。重置预算并从头重试 —— 若
    // 会话在休眠期间被回收，服务端会以永久关闭码（4001/1002）拒绝。
    if (
      this.lastReconnectAttemptTime !== null &&
      now - this.lastReconnectAttemptTime > SLEEP_DETECTION_THRESHOLD_MS
    ) {
      logForDebugging(
        `WebSocketTransport: Detected system sleep (${Math.round((now - this.lastReconnectAttemptTime) / 1000)}s gap), resetting reconnection budget`,
      )
      logForDiagnosticsNoPII('info', 'cli_websocket_sleep_detected', {
        gapMs: now - this.lastReconnectAttemptTime,
      })
      this.reconnectStartTime = now
      this.reconnectAttempts = 0
    }
    this.lastReconnectAttemptTime = now

    const elapsed = now - this.reconnectStartTime
    if (elapsed < DEFAULT_RECONNECT_GIVE_UP_MS) {
      // 清除任何已存在的重连定时器以避免重复
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
      }

      // 重连前刷新 headers（例如获取新的 session token）。
      // 若已由上方 4003 路径刷新过则跳过。
      if (!headersRefreshed && this.refreshHeaders) {
        const freshHeaders = this.refreshHeaders()
        Object.assign(this.headers, freshHeaders)
        logForDebugging('WebSocketTransport: Refreshed headers for reconnect')
      }

      this.state = 'reconnecting'
      this.reconnectAttempts++

      const baseDelay = Math.min(
        DEFAULT_BASE_RECONNECT_DELAY * 2 ** (this.reconnectAttempts - 1),
        DEFAULT_MAX_RECONNECT_DELAY,
      )
      // 加 ±25% 抖动以避免惊群
      const delay = Math.max(
        0,
        baseDelay + baseDelay * 0.25 * (2 * Math.random() - 1),
      )

      logForDebugging(
        `WebSocketTransport: Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts}, ${Math.round(elapsed / 1000)}s elapsed)`,
      )
      logForDiagnosticsNoPII('error', 'cli_websocket_reconnect_attempt', {
        reconnectAttempts: this.reconnectAttempts,
      })
      if (this.isBridge) {
        logEvent('tengu_ws_transport_reconnecting', {
          attempt: this.reconnectAttempts,
          elapsedMs: elapsed,
          delayMs: Math.round(delay),
        })
      }

      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null
        void this.connect()
      }, delay)
    } else {
      logForDebugging(
        `WebSocketTransport: Reconnection time budget exhausted after ${Math.round(elapsed / 1000)}s for ${this.url.href}`,
        { level: 'error' },
      )
      logForDiagnosticsNoPII('error', 'cli_websocket_reconnect_exhausted', {
        reconnectAttempts: this.reconnectAttempts,
        elapsedMs: elapsed,
      })
      this.state = 'closed'

      // 通知 close 回调
      if (this.onCloseCallback) {
        this.onCloseCallback(closeCode)
      }
    }
  }

  close(): void {
    // 清除任何挂起的重连定时器
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    // 清除 ping 和 keepalive 间隔
    this.stopPingInterval()
    this.stopKeepaliveInterval()

    // 注销 session 活动回调
    unregisterSessionActivityCallback()

    this.state = 'closing'
    this.doDisconnect()
  }

  private replayBufferedMessages(lastId: string): void {
    const messages = this.messageBuffer.toArray()
    if (messages.length === 0) return

    // 根据服务端最后收到的消息，找到回放的起点
    let startIndex = 0
    if (lastId) {
      const lastConfirmedIndex = messages.findIndex(
        message => 'uuid' in message && message.uuid === lastId,
      )
      if (lastConfirmedIndex >= 0) {
        // 服务端确认了直到 lastConfirmedIndex 的消息 —— 将它们逐出
        startIndex = lastConfirmedIndex + 1
        // 仅用未确认的消息重建缓冲区
        const remaining = messages.slice(startIndex)
        this.messageBuffer.clear()
        this.messageBuffer.addAll(remaining)
        if (remaining.length === 0) {
          this.lastSentId = null
        }
        logForDebugging(
          `WebSocketTransport: Evicted ${startIndex} confirmed messages, ${remaining.length} remaining`,
        )
        logForDiagnosticsNoPII(
          'info',
          'cli_websocket_evicted_confirmed_messages',
          {
            evicted: startIndex,
            remaining: remaining.length,
          },
        )
      }
    }

    const messagesToReplay = messages.slice(startIndex)
    if (messagesToReplay.length === 0) {
      logForDebugging('WebSocketTransport: No new messages to replay')
      logForDiagnosticsNoPII('info', 'cli_websocket_no_messages_to_replay')
      return
    }

    logForDebugging(
      `WebSocketTransport: Replaying ${messagesToReplay.length} buffered messages`,
    )
    logForDiagnosticsNoPII('info', 'cli_websocket_messages_to_replay', {
      count: messagesToReplay.length,
    })

    for (const message of messagesToReplay) {
      const line = jsonStringify(message) + '\n'
      const success = this.sendLine(line)
      if (!success) {
        this.handleConnectionError()
        break
      }
    }
    // 回放后不要清空缓冲区 —— 消息会一直留在缓冲区中，直到服务端在下一次
    // 重连时确认收到。这样可避免连接在回放之后、服务端处理之前断开而导致
    // 消息丢失。
  }

  isConnectedStatus(): boolean {
    return this.state === 'connected'
  }

  isClosedStatus(): boolean {
    return this.state === 'closed'
  }

  setOnData(callback: (data: string) => void): void {
    this.onData = callback
  }

  setOnConnect(callback: () => void): void {
    this.onConnectCallback = callback
  }

  setOnClose(callback: (closeCode?: number) => void): void {
    this.onCloseCallback = callback
  }

  getStateLabel(): string {
    return this.state
  }

  async write(message: StdoutMessage): Promise<void> {
    if ('uuid' in message && typeof message.uuid === 'string') {
      this.messageBuffer.add(message)
      this.lastSentId = message.uuid
    }

    const line = jsonStringify(message) + '\n'

    if (this.state !== 'connected') {
      // 消息已缓冲，待连接后回放（若含有 UUID）
      return
    }

    const sessionLabel = this.sessionId ? ` session=${this.sessionId}` : ''
    const detailLabel = this.getControlMessageDetailLabel(message)

    logForDebugging(
      `WebSocketTransport: Sending message type=${message.type}${sessionLabel}${detailLabel}`,
    )

    this.sendLine(line)
  }

  private getControlMessageDetailLabel(message: StdoutMessage): string {
    if (message.type === 'control_request') {
      const { request_id, request } = message
      const toolName =
        request.subtype === 'can_use_tool' ? request.tool_name : ''
      return ` subtype=${request.subtype} request_id=${request_id}${toolName ? ` tool=${toolName}` : ''}`
    }
    if (message.type === 'control_response') {
      const { subtype, request_id } = message.response
      return ` subtype=${subtype} request_id=${request_id}`
    }
    return ''
  }

  private startPingInterval(): void {
    // 清除任何已存在的 interval
    this.stopPingInterval()

    this.pongReceived = true
    let lastTickTime = Date.now()

    // 周期性发送 ping 以检测死连接。
    // 若上一次 ping 没有收到 pong，则视为连接已死。
    this.pingInterval = setInterval(() => {
      if (this.state === 'connected' && this.ws) {
        const now = Date.now()
        const gap = now - lastTickTime
        lastTickTime = now

        // 进程挂起检测器。若两次 tick 之间的墙上时间间隔远超过 10s 间隔，
        // 说明进程被挂起了（笔记本合盖、SIGSTOP、VM 暂停）。setInterval 不会
        // 把错过的 tick 排队 —— 它会合并 —— 因此唤醒后此回调只会触发一次，
        // 带着一个巨大的 gap。此时 socket 几乎肯定已死：NAT 映射在 30s–5min
        // 内就会失效，服务端也一直在向空中重传。不要等待一次 ping/pong
        // 往返来确认（ws.ping() 在死 socket 上会立即返回且无错 —— 字节进入
        // 内核发送缓冲区）。假定已死并立即重连。短时间休眠后的误判重连代价
        // 很小 —— replayBufferedMessages() 会处理，服务端也会按 UUID 去重。
        if (gap > SLEEP_DETECTION_THRESHOLD_MS) {
          logForDebugging(
            `WebSocketTransport: ${Math.round(gap / 1000)}s tick gap detected — process was suspended, forcing reconnect`,
          )
          logForDiagnosticsNoPII(
            'info',
            'cli_websocket_sleep_detected_on_ping',
            { gapMs: gap },
          )
          this.handleConnectionError()
          return
        }

        if (!this.pongReceived) {
          logForDebugging(
            'WebSocketTransport: No pong received, connection appears dead',
            { level: 'error' },
          )
          logForDiagnosticsNoPII('error', 'cli_websocket_pong_timeout')
          this.handleConnectionError()
          return
        }

        this.pongReceived = false
        try {
          this.ws.ping?.()
        } catch (error) {
          logForDebugging(`WebSocketTransport: Ping failed: ${error}`, {
            level: 'error',
          })
          logForDiagnosticsNoPII('error', 'cli_websocket_ping_failed')
        }
      }
    }, DEFAULT_PING_INTERVAL)
  }

  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval)
      this.pingInterval = null
    }
  }

  private startKeepaliveInterval(): void {
    this.stopKeepaliveInterval()

    // 在 CCR 会话中，由 session 活动心跳处理 keep-alive
    if (isEnvTruthy(process.env.CLAUDE_CODE_REMOTE)) {
      return
    }

    this.keepAliveInterval = setInterval(() => {
      if (this.state === 'connected' && this.ws) {
        try {
          this.ws.send(KEEP_ALIVE_FRAME)
          this.lastActivityTime = Date.now()
          logForDebugging(
            'WebSocketTransport: Sent periodic keep_alive data frame',
          )
        } catch (error) {
          logForDebugging(
            `WebSocketTransport: Periodic keep_alive failed: ${error}`,
            { level: 'error' },
          )
          logForDiagnosticsNoPII('error', 'cli_websocket_keepalive_failed')
        }
      }
    }, DEFAULT_KEEPALIVE_INTERVAL)
  }

  private stopKeepaliveInterval(): void {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval)
      this.keepAliveInterval = null
    }
  }
}
