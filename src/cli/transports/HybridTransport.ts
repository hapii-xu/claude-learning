import axios, { type AxiosError } from 'axios'
import type { StdoutMessage } from 'src/entrypoints/sdk/controlTypes.js'
import { logForDebugging } from '../../utils/debug.js'
import { rcLog } from '../../bridge/rcDebugLog.js'
import { logForDiagnosticsNoPII } from '../../utils/diagLogs.js'
import { getSessionIngressAuthToken } from '../../utils/sessionIngressAuth.js'
import { SerialBatchEventUploader } from './SerialBatchEventUploader.js'
import {
  WebSocketTransport,
  type WebSocketTransportOptions,
} from './WebSocketTransport.js'

const BATCH_FLUSH_INTERVAL_MS = 100
// 单次 POST 的尝试超时。限制一次卡住的 POST 能阻塞串行队列多久。
// 若无此限制，一条卡住的连接会拖住所有写入。
const POST_TIMEOUT_MS = 15_000
// close() 时排队写入的宽限期。覆盖一次健康的 POST（~100ms）外加余量；
// 尽力而为，在劣化网络下并不保证投递。
// 被 void 掉（没有 await 它），所以是最后手段 —— replBridge 的拆卸现在在
// 归档之后才关闭，因此归档延迟是主要的排空窗口。
// 注意：gracefulShutdown 的清理预算是 2s（不是外层 5s 的兜底）；这里的
// 3s 超过了它，但进程会多活约 2s 用于 hooks+analytics。
const CLOSE_GRACE_MS = 3000

/**
 * 混合传输：WebSocket 用于读，HTTP POST 用于写。
 *
 * 写入流程：
 *
 *   write(stream_event) ─┐
 *                        │ (100ms 定时器)
 *                        │
 *                        ▼
 *   write(other) ────► uploader.enqueue()  (SerialBatchEventUploader)
 *                        ▲    │
 *   writeBatch() ────────┘    │ 串行、批量、无限重试，
 *                             │ 在 maxQueueSize 处产生背压
 *                             ▼
 *                        postOnce()  (单次 HTTP POST，可重试错误时抛出)
 *
 * stream_event 消息在入队前最多在 streamEventBuffer 中累积 100ms
 * （减少高频内容 delta 的 POST 次数）。非流式写入会先 flush 已缓冲的
 * stream_event 以保持顺序。
 *
 * 串行化 + 重试 + 背压交给 SerialBatchEventUploader（与 CCR 使用的同一原语）。
 * 最多只有一次 POST 在途；在 POST 期间到达的事件会并入下一批。失败时，
 * 上传器会重新入队并以指数退避 + 抖动重试。若队列超过 maxQueueSize，
 * enqueue() 会阻塞 —— 给等待中的调用方提供背压。
 *
 * 为什么要串行化？Bridge 模式通过 `void transport.write()` 触发写入
 * （fire-and-forget）。若不串行化，并发的 POST → 并发地写入 Firestore
 * 同一文档 → 冲突 → 重试风暴 → 触发 oncall 告警。
 */
export class HybridTransport extends WebSocketTransport {
  private postUrl: string
  private uploader: SerialBatchEventUploader<StdoutMessage>

  // stream_event 延迟缓冲区 —— 累积 content delta 至多
  // BATCH_FLUSH_INTERVAL_MS 后再入队（减少 POST 次数）
  private streamEventBuffer: StdoutMessage[] = []
  private streamEventTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    url: URL,
    headers: Record<string, string> = {},
    sessionId?: string,
    refreshHeaders?: () => Record<string, string>,
    options?: WebSocketTransportOptions & {
      maxConsecutiveFailures?: number
      onBatchDropped?: (batchSize: number, failures: number) => void
    },
  ) {
    super(url, headers, sessionId, refreshHeaders, options)
    const { maxConsecutiveFailures, onBatchDropped } = options ?? {}
    this.postUrl = convertWsUrlToPostUrl(url)
    this.uploader = new SerialBatchEventUploader<StdoutMessage>({
      // 大上限 —— session-ingress 接受任意 batch 大小。事件在 POST 在途期间
      // 自然会批量；这里只是给 payload 设个上限。
      maxBatchSize: 500,
      // Bridge 调用方使用 `void transport.write()` —— 背压不适用（它们不 await）。
      // 大于 maxQueueSize 的 batch 会死锁（见 SerialBatchEventUploader 的背压
      // 检查）。因此设得足够高，仅作为内存上限。等调用方改为 await 之后再
      // 在后续工作中接入真正的背压。
      maxQueueSize: 10_000,
      baseDelayMs: 500,
      maxDelayMs: 8000,
      jitterMs: 1000,
      // 可选上限，避免持续失败的服务端把排空循环卡住整个进程生命周期。
      // Undefined = 无限重试。replBridge 会设置此项；1P transportUtils
      // 路径不设置。
      maxConsecutiveFailures,
      onBatchDropped: (batchSize, failures) => {
        logForDiagnosticsNoPII(
          'error',
          'cli_hybrid_batch_dropped_max_failures',
          {
            batchSize,
            failures,
          },
        )
        onBatchDropped?.(batchSize, failures)
      },
      send: batch => this.postOnce(batch),
    })
    logForDebugging(`HybridTransport: POST URL = ${this.postUrl}`)
    logForDiagnosticsNoPII('info', 'cli_hybrid_transport_initialized')
  }

  /**
   * 入队一条消息并等待队列排空。返回 flush() 保留了“`await write()` 在事件
   * 被 POST 之后才 resolve”的契约（被测试和 replBridge 的初始 flush 依赖）。
   * Fire-and-forget 调用方（`void transport.write()`）不受影响 —— 它们不
   * await，因此后续的 resolve 不会增加延迟。
   */
  override async write(message: StdoutMessage): Promise<void> {
    if (message.type === 'stream_event') {
      // 延迟：入队前先短暂累积 stream_event。
      // Promise 立即 resolve —— 调用方不会 await stream_event。
      this.streamEventBuffer.push(message)
      if (!this.streamEventTimer) {
        this.streamEventTimer = setTimeout(
          () => this.flushStreamEvents(),
          BATCH_FLUSH_INTERVAL_MS,
        )
      }
      return
    }
    // 立即：先 flush 已缓冲的 stream_event（保持顺序），再处理本事件。
    await this.uploader.enqueue([...this.takeStreamEvents(), message])
    return this.uploader.flush()
  }

  async writeBatch(messages: StdoutMessage[]): Promise<void> {
    await this.uploader.enqueue([...this.takeStreamEvents(), ...messages])
    return this.uploader.flush()
  }

  /** 在 writeBatch() 前后做快照，用于检测静默丢弃。 */
  get droppedBatchCount(): number {
    return this.uploader.droppedBatchCount
  }

  /**
   * 阻塞直到所有挂起的事件都 POST 完成。bridge 的初始历史 flush 使用它，
   * 使 onStateChange('connected') 在持久化完成之后才触发。
   */
  flush(): Promise<void> {
    void this.uploader.enqueue(this.takeStreamEvents())
    return this.uploader.flush()
  }

  /** 取走已缓冲 stream_event 的所有权并清除延迟定时器。 */
  private takeStreamEvents(): StdoutMessage[] {
    if (this.streamEventTimer) {
      clearTimeout(this.streamEventTimer)
      this.streamEventTimer = null
    }
    const buffered = this.streamEventBuffer
    this.streamEventBuffer = []
    return buffered
  }

  /** 延迟定时器触发 —— 将累积的 stream_event 入队。 */
  private flushStreamEvents(): void {
    this.streamEventTimer = null
    void this.uploader.enqueue(this.takeStreamEvents())
  }

  override close(): void {
    if (this.streamEventTimer) {
      clearTimeout(this.streamEventTimer)
      this.streamEventTimer = null
    }
    this.streamEventBuffer = []
    // 排队写入的宽限期 —— 兜底手段。replBridge 拆卸现在会在 write 与 close
    // 之间 await 归档（见 CLOSE_GRACE_MS），因此归档延迟是主要的排空窗口，
    // 这里是最后手段。保持 close() 同步（立即返回），但延后 uploader.close()
    // 以便剩余队列有机会完成。
    const uploader = this.uploader
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    void Promise.race([
      uploader.flush(),
      new Promise<void>(r => {
        // eslint-disable-next-line no-restricted-syntax -- 需要 timer 引用以便 clearTimeout
        graceTimer = setTimeout(r, CLOSE_GRACE_MS)
      }),
    ]).finally(() => {
      clearTimeout(graceTimer)
      uploader.close()
    })
    super.close()
  }

  /**
   * 单次尝试的 POST。可重试失败（429、5xx、网络错误）时抛出，由
   * SerialBatchEventUploader 重新入队并重试。成功以及永久性失败
   *（非 429 的 4xx、无 token）时返回，以便上传器继续往下处理。
   */
  private async postOnce(events: StdoutMessage[]): Promise<void> {
    const sessionToken = getSessionIngressAuthToken()
    if (!sessionToken) {
      logForDebugging('HybridTransport: No session token available for POST')
      logForDiagnosticsNoPII('warn', 'cli_hybrid_post_no_token')
      return
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${sessionToken}`,
      'Content-Type': 'application/json',
    }

    let response
    try {
      response = await axios.post(
        this.postUrl,
        { events },
        {
          headers,
          validateStatus: () => true,
          timeout: POST_TIMEOUT_MS,
        },
      )
    } catch (error) {
      const axiosError = error as AxiosError
      logForDebugging(`HybridTransport: POST error: ${axiosError.message}`)
      logForDiagnosticsNoPII('warn', 'cli_hybrid_post_network_error')
      throw error
    }

    if (response.status >= 200 && response.status < 300) {
      logForDebugging(`HybridTransport: POST success count=${events.length}`)
      return
    }

    // 4xx（除 429 外）是永久性的 —— 丢弃，不重试。
    if (
      response.status >= 400 &&
      response.status < 500 &&
      response.status !== 429
    ) {
      rcLog(
        `Hybrid POST ${response.status}: url=${this.postUrl.replace(/token=[^&]+/, 'token=***')}` +
          ` events=${events.length} body=${JSON.stringify(response.data).slice(0, 200)}`,
      )
      logForDebugging(
        `HybridTransport: POST returned ${response.status} (permanent), dropping`,
      )
      logForDiagnosticsNoPII('warn', 'cli_hybrid_post_client_error', {
        status: response.status,
      })
      return
    }

    // 429 / 5xx —— 可重试。抛出以便上传器重新入队并退避。
    logForDebugging(
      `HybridTransport: POST returned ${response.status} (retryable)`,
    )
    logForDiagnosticsNoPII('warn', 'cli_hybrid_post_retryable_error', {
      status: response.status,
    })
    throw new Error(`POST failed with ${response.status}`)
  }
}

/**
 * 将 WebSocket URL 转换为 HTTP POST 端点 URL。
 * From: wss://api.example.com/v2/session_ingress/ws/<session_id>
 * To:   https://api.example.com/v2/session_ingress/session/<session_id>/events
 */
function convertWsUrlToPostUrl(wsUrl: URL): string {
  const protocol = wsUrl.protocol === 'wss:' ? 'https:' : 'http:'

  // 把 /ws/ 替换为 /session/ 并追加 /events
  let pathname = wsUrl.pathname
  pathname = pathname.replace('/ws/', '/session/')
  if (!pathname.endsWith('/events')) {
    pathname = pathname.endsWith('/')
      ? pathname + 'events'
      : pathname + '/events'
  }

  return `${protocol}//${wsUrl.host}${pathname}${wsUrl.search}`
}
