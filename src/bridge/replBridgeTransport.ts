import type { StdoutMessage } from 'src/entrypoints/sdk/controlTypes.js'
import { CCRClient } from '../cli/transports/ccrClient.js'
import type { HybridTransport } from '../cli/transports/HybridTransport.js'
import { SSETransport } from '../cli/transports/SSETransport.js'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import { updateSessionIngressAuthToken } from '../utils/sessionIngressAuth.js'
import type { SessionState } from '../utils/sessionState.js'
import { registerWorker } from './workSecret.js'

/**
 * replBridge 的 transport 抽象。覆盖 replBridge.ts 对 HybridTransport 用到的
 * 全部接口面，把 v1/v2 的选择限制在构造点。
 *
 * - v1：HybridTransport（WS 读 + POST 写到 Session-Ingress）
 * - v2：SSETransport（读）+ CCRClient（写到 CCR v2 /worker/*）
 *
 * v2 写路径走的是 CCRClient.writeEvent → SerialBatchEventUploader，
 * 不走 SSETransport.write() —— SSETransport.write() 打的是 Session-Ingress
 * 的 POST URL，对 CCR v2 来说是错的。
 */
export type ReplBridgeTransport = {
  write(message: StdoutMessage): Promise<void>
  writeBatch(messages: StdoutMessage[]): Promise<void>
  close(): void
  isConnectedStatus(): boolean
  getStateLabel(): string
  setOnData(callback: (data: string) => void): void
  setOnClose(callback: (closeCode?: number) => void): void
  setOnConnect(callback: () => void): void
  connect(): void
  /**
   * 底层读流的事件 seq number 高水位。replBridge 在换 transport 之前读
   * 这个值，让新 transport 从旧 transport 停下的地方继续（否则服务器
   * 会从 seq 0 重放整个 session 历史）。
   *
   * v1 永远返回 0 —— Session-Ingress WS 不用 SSE seq number；重连重放
   * 由服务器侧的 message cursor 处理。
   */
  getLastSequenceNum(): number
  /**
   * 因 maxConsecutiveFailures 被丢弃的 batch 计数（单调递增）。在
   * writeBatch() 之前快照一份、之后对比，用来发现静默丢弃
   *（被丢弃时 writeBatch() 仍会正常 resolve）。v2 永远返回 0 —— v2
   * 写路径不会设置 maxConsecutiveFailures。
   */
  readonly droppedBatchCount: number
  /**
   * PUT /worker 状态（仅 v2；v1 是 no-op）。`requires_action` 告诉后端
   * 有权限提示待处理 —— claude.ai 会显示 "waiting for input" 指示。REPL/
   * daemon 调用方不需要这个（用户本地看 REPL）；多 session worker 调用方
   * 需要。
   */
  reportState(state: SessionState): void
  /** PUT /worker external_metadata（仅 v2；v1 是 no-op）。 */
  reportMetadata(metadata: Record<string, unknown>): void
  /**
   * POST /worker/events/{id}/delivery（仅 v2；v1 是 no-op）。填充 CCR 的
   * processing_at/processed_at 列。`received` 由 CCRClient 在每帧 SSE 上
   * 自动触发，不在此暴露。
   */
  reportDelivery(eventId: string, status: 'processing' | 'processed'): void
  /**
   * close() 之前把写队列 drain 掉（仅 v2；v1 立刻 resolve —— HybridTransport
   * 的 POST 每次写入都是 await 过的）。
   */
  flush(): Promise<void>
}

/**
 * v1 适配器：HybridTransport 已经有完整的接口面（它 extends 了
 * WebSocketTransport，后者已经有 setOnConnect + getStateLabel）。这个
 * 包装是 no-op，存在只是为了让 replBridge 的 `transport` 变量有统一类型。
 */
export function createV1ReplTransport(
  hybrid: HybridTransport,
): ReplBridgeTransport {
  return {
    write: msg => hybrid.write(msg),
    writeBatch: msgs => hybrid.writeBatch(msgs),
    close: () => hybrid.close(),
    isConnectedStatus: () => hybrid.isConnectedStatus(),
    getStateLabel: () => hybrid.getStateLabel(),
    setOnData: cb => hybrid.setOnData(cb),
    setOnClose: cb => hybrid.setOnClose(cb),
    setOnConnect: cb => hybrid.setOnConnect(cb),
    connect: () => void hybrid.connect(),
    // v1 Session-Ingress WS 不用 SSE seq number；重放语义不同。永远返回 0，
    // 让 replBridge 中的 seq number 续传逻辑在 v1 上是 no-op。
    getLastSequenceNum: () => 0,
    get droppedBatchCount() {
      return hybrid.droppedBatchCount
    },
    reportState: () => {},
    reportMetadata: () => {},
    reportDelivery: () => {},
    flush: () => Promise.resolve(),
  }
}

/**
 * v2 适配器：包装 SSETransport（读）+ CCRClient（写、heartbeat、state、
 * delivery 追踪）。
 *
 * 鉴权：v2 端点会校验 JWT 里的 session_id claim（register_worker.go:32）
 * 以及 worker role（environment_auth.py:856）。OAuth token 两个都没有。
 * 这与 v1 replBridge 路径恰好相反 —— v1 故意使用 OAuth。JWT 在 poll
 * 循环重新派发 work 时刷新 —— 调用方拿到新 token 后会再次调用
 * createV2ReplTransport。
 *
 * 注册在这里做（而不是在调用方），让整个 v2 握手就是一个 async 步骤。
 * registerWorker 失败会向上抛 —— replBridge 会捕获并继续留在 poll 循环上。
 */
export async function createV2ReplTransport(opts: {
  sessionUrl: string
  ingressToken: string
  sessionId: string
  /**
   * 上一个 transport 留下的 SSE seq number 高水位。传给新的
   * SSETransport，让它第一次 connect() 时发 from_sequence_num /
   * Last-Event-ID，服务器就能从旧流停下的地方续传。不传这个的话，每次
   * 换 transport 都会让服务器从 seq 0 重放整段 session 历史。
   */
  initialSequenceNum?: number
  /**
   * 来自 POST /bridge 响应的 worker epoch。提供时，服务器已经 bump 过
   * epoch（/bridge 调用本身就是注册 —— 见 server PR #293280）。省略时
   *（replBridge.ts poll 循环走的 v1 CCR-v2 路径），和以前一样调
   * registerWorker。
   */
  epoch?: number
  /** CCRClient heartbeat 间隔。省略时默认 20s。 */
  heartbeatIntervalMs?: number
  /** 每拍 ±fraction 抖动。省略时默认 0（无抖动）。 */
  heartbeatJitterFraction?: number
  /**
   * 为 true 时跳过 SSE 读流 —— 只启用 CCRClient 写路径。用于只转发
   * 事件但从不接收 inbound prompt / control request 的 mirror-mode 挂件。
   */
  outboundOnly?: boolean
  /**
   * 本实例专属的 auth header 来源。提供时，CCRClient + SSETransport 从
   * 这个闭包读 auth，而不是读进程级的 CLAUDE_CODE_SESSION_ACCESS_TOKEN
   * env 变量。需要管理多个并发 session 的调用方必须提供这个 —— 走 env
   * 变量的路径会在多个 session 之间相互覆盖。省略时回退到 env 变量
   *（单 session 调用方）。
   */
  getAuthToken?: () => string | undefined
}): Promise<ReplBridgeTransport> {
  const {
    sessionUrl,
    ingressToken,
    sessionId,
    initialSequenceNum,
    getAuthToken,
  } = opts

  // auth header 构造器。提供 getAuthToken 时从它读取（per-instance，
  // 多 session 安全）。否则把 ingressToken 写到进程级 env 变量（旧的单
  // session 路径 —— CCRClient 默认的 getAuthHeaders 通过
  // getSessionIngressAuthHeaders 读它）。
  let getAuthHeaders: (() => Record<string, string>) | undefined
  if (getAuthToken) {
    getAuthHeaders = (): Record<string, string> => {
      const token = getAuthToken()
      if (!token) return {}
      return { Authorization: `Bearer ${token}` }
    }
  } else {
    // CCRClient.request() 和 SSETransport.connect() 都通过
    // getSessionIngressAuthHeaders() → 这个 env 变量读 auth。二者触网
    // 之前必须先设好。
    updateSessionIngressAuthToken(ingressToken)
  }

  const epoch = opts.epoch ?? (await registerWorker(sessionUrl, ingressToken))
  logForDebugging(
    `[bridge:repl] CCR v2: worker sessionId=${sessionId} epoch=${epoch}${opts.epoch !== undefined ? ' (from /bridge)' : ' (via registerWorker)'}`,
  )

  // 推导 SSE 流 URL。与 transportUtils.ts:26-33 同样的逻辑，但起点是
  // http(s) base，而不是可能是 ws:// 的 --sdk-url。
  const sseUrl = new URL(sessionUrl)
  sseUrl.pathname = sseUrl.pathname.replace(/\/$/, '') + '/worker/events/stream'

  const sse = new SSETransport(
    sseUrl,
    {},
    sessionId,
    undefined,
    initialSequenceNum,
    getAuthHeaders,
  )
  let onCloseCb: ((closeCode?: number) => void) | undefined
  const ccr = new CCRClient(sse, new URL(sessionUrl), {
    getAuthHeaders,
    heartbeatIntervalMs: opts.heartbeatIntervalMs,
    heartbeatJitterFraction: opts.heartbeatJitterFraction,
    // 默认是 process.exit(1) —— 对 spawn-mode 子进程是对的。进程内的
    // 话，这会杀掉 REPL。改成 close：replBridge 的 onClose 会唤醒 poll
    // 循环，由它接住服务器侧的重新派发（带新的 epoch）。
    onEpochMismatch: () => {
      logForDebugging(
        '[bridge:repl] CCR v2: epoch superseded (409) — closing for poll-loop recovery',
      )
      // 资源 close 放在 try 里，保证 throw 一定执行。如果 ccr.close()
      // 或 sse.close() 抛错，我们仍然需要把调用方（request()）展开 ——
      // 否则 handleEpochMismatch 的 `never` 返回类型在运行时就被违反，
      // 控制流会继续往下落。
      try {
        ccr.close()
        sse.close()
        onCloseCb?.(4090)
      } catch (closeErr: unknown) {
        logForDebugging(
          `[bridge:repl] CCR v2: error during epoch-mismatch cleanup: ${errorMessage(closeErr)}`,
          { level: 'error' },
        )
      }
      // 不要 return —— 调用方的 request() 代码在 409 分支之后还会继续，
      // 这样调用方能看到日志和 false 返回值。这里用 throw 展开；uploader
      // 会把它当作发送失败捕获。
      throw new Error('epoch superseded')
    },
  })

  // CCRClient 构造器已经把 sse.setOnEvent 接到 reportDelivery('received')。
  // remoteIO.ts 额外通过 setCommandLifecycleListener 发 'processing'/'processed'，
  // 这是由进程内 query 循环触发的。本 transport 的唯一调用方
  //（replBridge/daemonBridge）没有这种接线 —— daemon 的 agent 子进程是
  // 独立进程（ProcessTransport），它的 notifyCommandLifecycle 调用在
  // 自己的模块作用域里以 listener=null 触发。所以事件永远停在 'received'，
  // reconnectSession 在每次 daemon 重启时都把这些事件重新入队（观测到：
  // 21→24→25 个幻影 prompt，以 "user sent a new message while you were working"
  // system-reminder 的形式出现）。
  //
  // 修复：在 'received' 旁边立即 ACK 'processed'。从 SSE 接收到写入
  // transcript 的窗口很窄（queue → SDK → 子进程 stdin → model）；那里
  // 崩溃会丢一个 prompt，相比观测到的"每次重启都涌出 N 个 prompt"已经
  // 好太多。覆盖构造器的接线，同时做两件事 —— setOnEvent 是替换而不是
  // 追加（SSETransport.ts:658）。
  sse.setOnEvent(event => {
    ccr.reportDelivery(event.event_id, 'received')
    ccr.reportDelivery(event.event_id, 'processed')
  })

  // sse.connect() 和 ccr.initialize() 都延迟到下面的 connect() 里。
  // replBridge 的调用顺序是 newTransport → setOnConnect → setOnData →
  // setOnClose → connect()，两个调用都需要先接好这些回调：
  // sse.connect() 会打开流（事件立刻流向 onData/onClose），
  // ccr.initialize().then() 会触发 onConnectCb。
  //
  // onConnect 在 ccr.initialize() resolve 后触发。写走的是 CCRClient HTTP
  // POST（SerialBatchEventUploader），不走 SSE，所以 workerEpoch 一设好
  // 写路径就 ready。SSE.connect() 会 await 它的读循环，永不 resolve ——
  // 不要 gate 在它上面。SSE 流会并行打开（约 30ms），开始通过 setOnData
  // 投递 inbound 事件；outbound 不需要等它。
  let onConnectCb: (() => void) | undefined
  let ccrInitialized = false
  let closed = false

  return {
    write(msg) {
      return ccr.writeEvent(msg)
    },
    async writeBatch(msgs) {
      // SerialBatchEventUploader 内部已经会 batch（maxBatchSize=100）；
      // 顺序入队能保留顺序，uploader 会合并。每次写之间检查 closed，
      // 避免 transport 拆除（epoch 不匹配、SSE 掉线）后还发出半截 batch。
      for (const m of msgs) {
        if (closed) break
        await ccr.writeEvent(m)
      }
    },
    close() {
      closed = true
      ccr.close()
      sse.close()
    },
    isConnectedStatus() {
      // 是写就绪，不是读就绪 —— replBridge 在调 writeBatch 之前检查它。
      // SSE 的 open 状态与之正交。
      return ccrInitialized
    },
    getStateLabel() {
      // SSETransport 不暴露状态字符串；根据我们能看到的信息合成一个。
      // replBridge 只在 debug 日志里用它。
      if (sse.isClosedStatus()) return 'closed'
      if (sse.isConnectedStatus()) return ccrInitialized ? 'connected' : 'init'
      return 'connecting'
    },
    setOnData(cb) {
      sse.setOnData(cb)
    },
    setOnClose(cb) {
      onCloseCb = cb
      // SSE 重连预算耗尽时以 onClose(undefined) 触发 —— 映射为 4092，
      // 让 ws_closed 埋点能把它和 HTTP 状态关闭区分开
      //（SSETransport:280 传的是 response.status）。通知 replBridge 之前
      // 先停掉 CCRClient 的 heartbeat 定时器。（sse.close() 不会触发它，
      // 所以上面 epoch 不匹配的路径不会重入。）
      sse.setOnClose(code => {
        ccr.close()
        cb(code ?? 4092)
      })
    },
    setOnConnect(cb) {
      onConnectCb = cb
    },
    getLastSequenceNum() {
      return sse.getLastSequenceNum()
    },
    // v2 写路径（CCRClient）不设置 maxConsecutiveFailures —— 没有丢弃。
    droppedBatchCount: 0,
    reportState(state) {
      ccr.reportState(state)
    },
    reportMetadata(metadata) {
      ccr.reportMetadata(metadata)
    },
    reportDelivery(eventId, status) {
      ccr.reportDelivery(eventId, status)
    },
    flush() {
      return ccr.flush()
    },
    connect() {
      // 仅出站：完全跳过 SSE 读流 —— 没有 inbound 事件要收，没有 delivery
      // ACK 要发。只需要 CCRClient 写路径（POST /worker/events）和
      // heartbeat。
      if (!opts.outboundOnly) {
        // fire-and-forget —— SSETransport.connect() 会 await readStream()
        //（读循环），只在流关闭/出错时才 resolve。remoteIO.ts 中的
        // spawn-mode 路径也是同样地 void 丢弃。
        void sse.connect()
      }
      void ccr.initialize(epoch).then(
        () => {
          ccrInitialized = true
          logForDebugging(
            `[bridge:repl] v2 transport ready for writes (epoch=${epoch}, sse=${sse.isConnectedStatus() ? 'open' : 'opening'})`,
          )
          onConnectCb?.()
        },
        (err: unknown) => {
          logForDebugging(
            `[bridge:repl] CCR v2 initialize failed: ${errorMessage(err)}`,
            { level: 'error' },
          )
          // 关闭 transport 资源并通过 onClose 通知 replBridge，
          // 让 poll 循环在下一次 work 派发时重试。不发这个回调的话，
          // replBridge 永远不知道 transport 初始化失败，会一直停在
          // transport === null。
          ccr.close()
          sse.close()
          onCloseCb?.(4091) // 4091 = init 失败，与 4090 epoch 不匹配区分开
        },
      )
    },
  }
}
