/* eslint-disable eslint-plugin-n/no-unsupported-features/node-builtins */
/**
 * CCR upstreamproxy 的 CONNECT-over-WebSocket 中继。
 *
 * 在 localhost TCP 上监听，接受来自 curl/gh/kubectl 等的 HTTP CONNECT 请求，
 * 并通过 WebSocket 将字节数据隧道传输到 CCR upstreamproxy 端点。
 * CCR 服务端终止隧道，执行 MITM TLS，注入组织配置的凭据
 * （例如 DD-API-KEY），然后转发到真正的上游服务器。
 *
 * 为什么用 WebSocket 而非原生 CONNECT：CCR 入口是 GKE L7 加路径前缀
 * 路由；cdk-constructs 中没有 connect_matcher。会话入口隧道
 * （sessions/tunnel/v1alpha/tunnel.proto）已经使用了这种模式。
 *
 * 协议：字节数据被封装在 UpstreamProxyChunk protobuf 消息中
 * （`message UpstreamProxyChunk { bytes data = 1; }`），以兼容
 * 服务端的 gateway.NewWebSocketStreamAdapter。
 */

import { createServer, type Socket as NodeSocket } from 'node:net'
import { logForDebugging } from '../utils/debug.js'
import { getWebSocketTLSOptions } from '../utils/mtls.js'
import { getWebSocketProxyAgent, getWebSocketProxyUrl } from '../utils/proxy.js'

// CCR 容器位于出口网关之后 — 直接外连被阻止，因此 WS 升级必须
// 通过其他所有流量使用的同一个 HTTP CONNECT 代理。undici 的
// globalThis.WebSocket 在升级时不查询全局 dispatcher，因此在 Node
// 下我们使用 ws 包并显式指定 agent（与 SessionsWebSocket 相同模式）。
// Bun 的原生 WebSocket 直接接受代理 URL。在 startNodeRelay 中预加载，
// 使 openTunnel 保持同步，避免 CONNECT 状态机产生竞态。
type WSCtor = typeof import('ws').default
let nodeWSCtor: WSCtor | undefined

// openTunnel 触及的表面方法的交集。undici 的 globalThis.WebSocket
// 和 ws 包都通过属性风格的 onX 处理器满足此接口。
type WebSocketLike = Pick<
  WebSocket,
  | 'onopen'
  | 'onmessage'
  | 'onerror'
  | 'onclose'
  | 'send'
  | 'close'
  | 'readyState'
  | 'binaryType'
>

// Envoy 每请求缓冲区上限。第一周的 Datadog 负载不会达到此限制，
// 但提前设计以便 git-push 不需要重写中继。
const MAX_CHUNK_BYTES = 512 * 1024

// Sidecar 空闲超时为 50 秒；ping 间隔远小于此。
const PING_INTERVAL_MS = 30_000

/**
 * 手动编码 UpstreamProxyChunk protobuf 消息。
 *
 * 对于 `message UpstreamProxyChunk { bytes data = 1; }`，wire 格式为：
 *   tag = (field_number << 3) | wire_type = (1 << 3) | 2 = 0x0a
 *   后跟 varint 长度，再后跟字节数据。
 *
 * 通用方案是 protobufjs；但对于单字段 bytes 消息，手动编码
 * 只需 10 行，避免了热路径中的运行时依赖。
 */
export function encodeChunk(data: Uint8Array): Uint8Array {
  const len = data.length
  // 长度的 varint 编码 —— 大多数块适合 1-3 个长度字节
  const varint: number[] = []
  let n = len
  while (n > 0x7f) {
    varint.push((n & 0x7f) | 0x80)
    n >>>= 7
  }
  varint.push(n)
  const out = new Uint8Array(1 + varint.length + len)
  out[0] = 0x0a
  out.set(varint, 1)
  out.set(data, 1 + varint.length)
  return out
}

/**
 * 解码 UpstreamProxyChunk。返回 data 字段，如果格式错误则返回 null。
 * 容忍服务器发送零长度块（保活语义）。
 */
export function decodeChunk(buf: Uint8Array): Uint8Array | null {
  if (buf.length === 0) return new Uint8Array(0)
  if (buf[0] !== 0x0a) return null
  let len = 0
  let shift = 0
  let i = 1
  while (i < buf.length) {
    const b = buf[i]!
    len |= (b & 0x7f) << shift
    i++
    if ((b & 0x80) === 0) break
    shift += 7
    if (shift > 28) return null
  }
  if (i + len > buf.length) return null
  return buf.subarray(i, i + len)
}

export type UpstreamProxyRelay = {
  port: number
  stop: () => void
}

type ConnState = {
  ws?: WebSocketLike
  connectBuf: Buffer
  pinger?: ReturnType<typeof setInterval>
  // CONNECT 头之后但在 ws.onopen 触发之前到达的字节。TCP 可以将
  // CONNECT + ClientHello 合并到一个数据包中，并且 socket 的 data 回调
  // 可以在 WS 握手仍在进行时再次触发。没有此缓冲区，两种情况都会
  // 静默丢弃字节。
  pending: Buffer[]
  wsOpen: boolean
  // 一旦服务器的 200 Connection Established 被转发且隧道承载 TLS，
  // 则设置此标志。之后写入明文 502 会破坏客户端的 TLS 流 —— 改为直接关闭。
  established: boolean
  // WS onerror 总是跟随 onclose；没有防护的话，第二个处理器会对
  // 已经结束的 socket 调用 sock.end()。第一个调用者胜出。
  closed: boolean
}

/**
 * 最小 socket 抽象，使 CONNECT 解析器和 WS 隧道管道与运行时无关。
 * 实现在内部处理写入背压：Bun 的 sock.write() 执行部分写入，
 * 需要显式尾部队列；Node 的 net.Socket 无条件缓冲，从不丢弃字节。
 */
type ClientSocket = {
  write: (data: Uint8Array | string) => void
  end: () => void
}

function newConnState(): ConnState {
  return {
    connectBuf: Buffer.alloc(0),
    pending: [],
    wsOpen: false,
    established: false,
    closed: false,
  }
}

/**
 * Start the relay. Returns the ephemeral port it bound and a stop function.
 * Uses Bun.listen when available, otherwise Node's net.createServer — the CCR
 * container runs the CLI under Node, not Bun.
 */
export async function startUpstreamProxyRelay(opts: {
  wsUrl: string
  sessionId: string
  token: string
}): Promise<UpstreamProxyRelay> {
  const authHeader =
    'Basic ' + Buffer.from(`${opts.sessionId}:${opts.token}`).toString('base64')
  // WS 升级本身是受认证门控的（proto authn：PRIVATE_API）—— 网关
  // 在升级请求上需要 session-ingress JWT，与在隧道 CONNECT 内携带的
  // Proxy-Authorization 分开。
  const wsAuthHeader = `Bearer ${opts.token}`

  const relay =
    typeof Bun !== 'undefined'
      ? startBunRelay(opts.wsUrl, authHeader, wsAuthHeader)
      : await startNodeRelay(opts.wsUrl, authHeader, wsAuthHeader)

  logForDebugging(`[upstreamproxy] relay listening on 127.0.0.1:${relay.port}`)
  return relay
}

function startBunRelay(
  wsUrl: string,
  authHeader: string,
  wsAuthHeader: string,
): UpstreamProxyRelay {
  // Bun TCP socket 不自动缓冲部分写入：sock.write() 返回实际交给内核的
  // 字节数，剩余部分被静默丢弃。当内核缓冲区满时，我们将尾部排队并
  // 让 drain 处理器刷新它。按 socket 存储是因为适配器闭包比单个处理器
  // 调用存活更久。
  type BunState = ConnState & { writeBuf: Uint8Array[] }

  // eslint-disable-next-line custom-rules/require-bun-typeof-guard -- caller dispatches on typeof Bun
  const server = Bun.listen<BunState>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(sock) {
        sock.data = { ...newConnState(), writeBuf: [] }
      },
      data(sock, data) {
        const st = sock.data
        const adapter: ClientSocket = {
          write: payload => {
            const bytes =
              typeof payload === 'string'
                ? Buffer.from(payload, 'utf8')
                : payload
            if (st.writeBuf.length > 0) {
              st.writeBuf.push(bytes)
              return
            }
            const n = sock.write(bytes)
            if (n < bytes.length) st.writeBuf.push(bytes.subarray(n))
          },
          end: () => sock.end(),
        }
        handleData(adapter, st, data, wsUrl, authHeader, wsAuthHeader)
      },
      drain(sock) {
        const st = sock.data
        while (st.writeBuf.length > 0) {
          const chunk = st.writeBuf[0]!
          const n = sock.write(chunk)
          if (n < chunk.length) {
            st.writeBuf[0] = chunk.subarray(n)
            return
          }
          st.writeBuf.shift()
        }
      },
      close(sock) {
        cleanupConn(sock.data)
      },
      error(sock, err) {
        logForDebugging(`[upstreamproxy] client socket error: ${err.message}`)
        cleanupConn(sock.data)
      },
    },
  })

  return {
    port: server.port,
    stop: () => server.stop(true),
  }
}

// 导出以便测试可以直接练习 Node 路径 —— 测试运行器是 Bun，
// 所以 startUpstreamProxyRelay 中的运行时调度总是选择 Bun。
export async function startNodeRelay(
  wsUrl: string,
  authHeader: string,
  wsAuthHeader: string,
): Promise<UpstreamProxyRelay> {
  nodeWSCtor = (await import('ws')).default
  const states = new WeakMap<NodeSocket, ConnState>()

  const server = createServer(sock => {
    const st = newConnState()
    states.set(sock, st)
    // Node 的 sock.write() 在内部缓冲 —— 返回 false 表示背压但字节已排队，
    // 所以不需要尾部跟踪来保证正确性。第一周的负载不会对缓冲区造成压力。
    const adapter: ClientSocket = {
      write: payload => {
        sock.write(typeof payload === 'string' ? payload : Buffer.from(payload))
      },
      end: () => sock.end(),
    }
    sock.on('data', (data: Buffer) =>
      handleData(adapter, st, data, wsUrl, authHeader, wsAuthHeader),
    )
    sock.on('close', () => cleanupConn(states.get(sock)))
    sock.on('error', err => {
      logForDebugging(`[upstreamproxy] client socket error: ${err.message}`)
      cleanupConn(states.get(sock))
    })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr === null || typeof addr === 'string') {
        reject(new Error('upstreamproxy: server has no TCP address'))
        return
      }
      resolve({
        port: addr.port,
        stop: () => server.close(),
      })
    })
  })
}

/**
 * 每个连接的共享数据处理器。阶段 1 累积 CONNECT 请求；阶段 2 通过
 * WS 隧道转发客户端字节。
 */
function handleData(
  sock: ClientSocket,
  st: ConnState,
  data: Buffer,
  wsUrl: string,
  authHeader: string,
  wsAuthHeader: string,
): void {
  // 阶段 1：累积直到我们看到完整的 CONNECT 请求（以 CRLF CRLF 终止）。
  // curl/gh 在一个数据包中发送这个，但不要假设这样。
  if (!st.ws) {
    st.connectBuf = Buffer.concat([st.connectBuf, data])
    const headerEnd = st.connectBuf.indexOf('\r\n\r\n')
    if (headerEnd === -1) {
      // 防护从不发送 CRLFCRLF 的客户端。
      if (st.connectBuf.length > 8192) {
        sock.write('HTTP/1.1 400 Bad Request\r\n\r\n')
        sock.end()
      }
      return
    }
    const reqHead = st.connectBuf.subarray(0, headerEnd).toString('utf8')
    const firstLine = reqHead.split('\r\n')[0] ?? ''
    const m = firstLine.match(/^CONNECT\s+(\S+)\s+HTTP\/1\.[01]$/i)
    if (!m) {
      sock.write('HTTP/1.1 405 Method Not Allowed\r\n\r\n')
      sock.end()
      return
    }
    // 暂存在 CONNECT 头之后到达的任何字节，以便 openTunnel 可以在
    // WS 打开后刷新它们。
    const trailing = st.connectBuf.subarray(headerEnd + 4)
    if (trailing.length > 0) {
      st.pending.push(Buffer.from(trailing))
    }
    st.connectBuf = Buffer.alloc(0)
    openTunnel(sock, st, firstLine, wsUrl, authHeader, wsAuthHeader)
    return
  }
  // 阶段 2：WS 存在。如果还没 OPEN，缓冲；ws.onopen 会刷新。一旦打开，
  // 将客户端字节分块泵送到 WS。
  if (!st.wsOpen) {
    st.pending.push(Buffer.from(data))
    return
  }
  forwardToWs(st.ws, data)
}

function openTunnel(
  sock: ClientSocket,
  st: ConnState,
  connectLine: string,
  wsUrl: string,
  authHeader: string,
  wsAuthHeader: string,
): void {
  // core/websocket/stream.go 从升级请求的 Content-Type 头中选择 JSON
  // 还是 binary-proto（默认 JSON）。没有 application/proto，服务器会
  // protojson.Unmarshal 我们手动编码的二进制块并以 EOF 静默失败。
  const headers = {
    'Content-Type': 'application/proto',
    Authorization: wsAuthHeader,
  }
  let ws: WebSocketLike
  if (nodeWSCtor) {
    ws = new nodeWSCtor(wsUrl, {
      headers,
      agent: getWebSocketProxyAgent(wsUrl),
      ...getWebSocketTLSOptions(),
    }) as unknown as WebSocketLike
  } else {
    ws = new globalThis.WebSocket(wsUrl, {
      // @ts-expect-error — Bun extension; not in lib.dom WebSocket types
      headers,
      proxy: getWebSocketProxyUrl(wsUrl),
      tls: getWebSocketTLSOptions() || undefined,
    })
  }
  ws.binaryType = 'arraybuffer'
  st.ws = ws

  ws.onopen = () => {
    // 第一个块携带 CONNECT 行加上 Proxy-Authorization，以便服务器可以
    // 认证隧道并知道目标 host:port。服务器通过隧道用自己的 "HTTP/1.1 200"
    // 响应；我们直接管道传输它。
    const head =
      `${connectLine}\r\n` + `Proxy-Authorization: ${authHeader}\r\n` + `\r\n`
    ws.send(encodeChunk(new Uint8Array(Buffer.from(head, 'utf8'))) as any)
    // 刷新在 WS 握手进行时到达的任何内容 —— 来自 CONNECT 数据包的尾部字节
    // 和在 onopen 之前触发的任何 data() 回调。
    st.wsOpen = true
    for (const buf of st.pending) {
      forwardToWs(ws, buf)
    }
    st.pending = []
    // 并非所有 WS 实现都暴露 ping()；空块作为服务器可以忽略的应用层保活。
    st.pinger = setInterval(sendKeepalive, PING_INTERVAL_MS, ws)
  }

  ws.onmessage = ev => {
    const raw =
      ev.data instanceof ArrayBuffer
        ? new Uint8Array(ev.data)
        : new Uint8Array(Buffer.from(ev.data))
    const payload = decodeChunk(raw)
    if (payload && payload.length > 0) {
      st.established = true
      sock.write(payload)
    }
  }

  ws.onerror = ev => {
    const msg = 'message' in ev ? String(ev.message) : 'websocket error'
    logForDebugging(`[upstreamproxy] ws error: ${msg}`)
    if (st.closed) return
    st.closed = true
    if (!st.established) {
      sock.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
    }
    sock.end()
    cleanupConn(st)
  }

  ws.onclose = () => {
    if (st.closed) return
    st.closed = true
    sock.end()
    cleanupConn(st)
  }
}

function sendKeepalive(ws: WebSocketLike): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(encodeChunk(new Uint8Array(0)) as any)
  }
}

function forwardToWs(ws: WebSocketLike, data: Buffer): void {
  if (ws.readyState !== WebSocket.OPEN) return
  for (let off = 0; off < data.length; off += MAX_CHUNK_BYTES) {
    const slice = new Uint8Array(data.subarray(off, off + MAX_CHUNK_BYTES))
    ws.send(encodeChunk(slice) as any)
  }
}

function cleanupConn(st: ConnState | undefined): void {
  if (!st) return
  if (st.pinger) clearInterval(st.pinger)
  if (st.ws && st.ws.readyState <= WebSocket.OPEN) {
    try {
      st.ws.close()
    } catch {
      // 已在关闭中
    }
  }
  st.ws = undefined
}
