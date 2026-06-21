// 用于按键通话的 Anthropic voice_stream 语音转文字客户端。
//
// 仅在 ant 构建中可达（由 useVoice.ts 导入中的 feature('VOICE_MODE') 控制）。
//
// 使用与 Claude Code 相同的 OAuth 凭证连接到 Anthropic 的 voice_stream
// WebSocket 端点。该端点使用 conversation_engine
// 支持的模型进行语音转文字。专为按住说话设计：按住
// 键绑定进行录制，松开停止并提交。
//
// 通信协议使用 JSON 控制消息（KeepAlive、CloseStream）和
// 二进制音频帧。服务器以 TranscriptText 和
// TranscriptEndpoint JSON 消息响应。

import type { ClientRequest, IncomingMessage } from 'http'
import WebSocket from 'ws'
import { getOauthConfig } from '../constants/oauth.js'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getClaudeAIOAuthTokens,
  isAnthropicAuthEnabled,
} from '../utils/auth.js'
import { logForDebugging } from '../utils/debug.js'
import { getUserAgent } from '../utils/http.js'
import { logError } from '../utils/log.js'
import { getWebSocketTLSOptions } from '../utils/mtls.js'
import { getWebSocketProxyAgent, getWebSocketProxyUrl } from '../utils/proxy.js'
import { jsonParse, jsonStringify } from '../utils/slowOperations.js'

const KEEPALIVE_MSG = '{"type":"KeepAlive"}'
const CLOSE_STREAM_MSG = '{"type":"CloseStream"}'

import { getFeatureValue_CACHED_MAY_BE_STALE } from './analytics/growthbook.js'

// ─── 常量 ───────────────────────────────────────────────────────

const VOICE_STREAM_PATH = '/api/ws/speech_to_text/voice_stream'

const KEEPALIVE_INTERVAL_MS = 8_000

// finalize() 解析计时器。`noData` 在 CloseStream 后没有 TranscriptText
// 到达时触发 —— 服务器无内容；不要等待
// 完整的约 3-5 秒 WS 拆除来确认空。`safety` 是 WS
// 挂起时的最后手段上限。导出以便测试可以缩短它们。
export const FINALIZE_TIMEOUTS_MS = {
  safety: 5_000,
  noData: 1_500,
}

// ─── 类型 ──────────────────────────────────────────────────────────

export type VoiceStreamCallbacks = {
  onTranscript: (text: string, isFinal: boolean) => void
  onError: (error: string, opts?: { fatal?: boolean }) => void
  onClose: () => void
  onReady: (connection: VoiceStreamConnection) => void
}

// finalize() 如何解析。`no_data_timeout` 表示 CloseStream 后零服务器消息
// —— 静默丢弃的特征（anthropics/anthropic#287008）。
export type FinalizeSource =
  | 'post_closestream_endpoint'
  | 'no_data_timeout'
  | 'safety_timeout'
  | 'ws_close'
  | 'ws_already_closed'

export type VoiceStreamConnection = {
  send: (audioChunk: Buffer) => void
  finalize: () => Promise<FinalizeSource>
  close: () => void
  isConnected: () => boolean
}

// voice_stream 端点返回转录块和端点标记。
type VoiceStreamTranscriptText = {
  type: 'TranscriptText'
  data: string
}

type VoiceStreamTranscriptEndpoint = {
  type: 'TranscriptEndpoint'
}

type VoiceStreamTranscriptError = {
  type: 'TranscriptError'
  error_code?: string
  description?: string
}

type VoiceStreamMessage =
  | VoiceStreamTranscriptText
  | VoiceStreamTranscriptEndpoint
  | VoiceStreamTranscriptError
  | { type: 'error'; message?: string }

// ─── 可用性 ──────────────────────────────────────────────────────

export function isVoiceStreamAvailable(): boolean {
  // voice_stream 使用与 Claude Code 相同的 OAuth —— 当
  // 用户通过 Anthropic 认证（Claude.ai 订阅者或具有
  // 有效的 OAuth 令牌）时可用。
  if (!isAnthropicAuthEnabled()) {
    return false
  }
  const tokens = getClaudeAIOAuthTokens()
  return tokens !== null && tokens.accessToken !== null
}

// ─── 连接 ────────────────────────────────────────────────────────

export async function connectVoiceStream(
  callbacks: VoiceStreamCallbacks,
  options?: { language?: string; keyterms?: string[] },
): Promise<VoiceStreamConnection | null> {
  // 连接前确保 OAuth 令牌是最新的
  await checkAndRefreshOAuthTokenIfNeeded()

  const tokens = getClaudeAIOAuthTokens()
  if (!tokens?.accessToken) {
    logForDebugging('[voice_stream] No OAuth token available')
    return null
  }

  // voice_stream 是 private_api 路由，但 /api/ws/ 也暴露在
  // api.anthropic.com 监听器上（service_definitions.yaml private-api:
  // visibility.external: true）。我们针对该主机而不是 claude.ai，
  // 因为 claude.ai CF 区域使用 TLS 指纹识别并挑战
  // 非浏览器客户端（anthropics/claude-code#34094）。相同的 private-api
  // pod，相同的 OAuth Bearer 认证 —— 只是 CF 区域不阻止我们。
  // 桌面听写仍使用 claude.ai（Swift URLSession 具有
  // 浏览器级 JA3 指纹，因此 CF 让它通过）。
  const wsBaseUrl =
    process.env.VOICE_STREAM_BASE_URL ||
    getOauthConfig()
      .BASE_API_URL.replace('https://', 'wss://')
      .replace('http://', 'ws://')

  if (process.env.VOICE_STREAM_BASE_URL) {
    logForDebugging(
      `[voice_stream] Using VOICE_STREAM_BASE_URL override: ${process.env.VOICE_STREAM_BASE_URL}`,
    )
  }

  const params = new URLSearchParams({
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
    endpointing_ms: '300',
    utterance_end_ms: '1000',
    language: options?.language ?? 'en',
  })

  // 通过 conversation-engine 路由并使用 Deepgram Nova 3（绕过
  // 服务器的 project_bell_v2_config GrowthBook 门控）。服务器
  // 端是 anthropics/anthropic#278327 + #281372；这让我们可以
  // 独立地推进客户端。
  const isNova3 = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_cobalt_frost',
    false,
  )
  if (isNova3) {
    params.set('use_conversation_engine', 'true')
    params.set('stt_provider', 'deepgram-nova3')
    logForDebugging('[voice_stream] Nova 3 gate enabled (tengu_cobalt_frost)')
  }

  // 将 keyterms 作为查询参数附加 —— voice_stream 代理将其
  // 转发给 STT 服务，后者应用适当的提升。
  if (options?.keyterms?.length) {
    for (const term of options.keyterms) {
      params.append('keyterms', term)
    }
  }

  const url = `${wsBaseUrl}${VOICE_STREAM_PATH}?${params.toString()}`

  logForDebugging(`[voice_stream] Connecting to ${url}`)

  const headers: Record<string, string> = {
    Authorization: `Bearer ${tokens.accessToken}`,
    'User-Agent': getUserAgent(),
    'x-app': 'cli',
  }

  const tlsOptions = getWebSocketTLSOptions()
  const wsOptions =
    typeof Bun !== 'undefined'
      ? {
          headers,
          proxy: getWebSocketProxyUrl(url),
          tls: tlsOptions || undefined,
        }
      : { headers, agent: getWebSocketProxyAgent(url), ...tlsOptions }

  const ws = new WebSocket(url, wsOptions)

  let keepaliveTimer: ReturnType<typeof setInterval> | null = null
  let connected = false
  // 一旦 CloseStream 已发送（或 ws 已关闭）就设为 true。
  // 此后，进一步的音频发送会被丢弃。
  let finalized = false
  // 首次调用 finalize() 时设为 true，以防止重复触发。
  let finalizing = false
  // 当 HTTP 升级被拒绝（unexpected-response）时设置。随后的
  // close 事件（来自我们的 req.destroy() 的 1006）只是
  // 机械拆除；升级处理器已经报告了错误。
  let upgradeRejected = false
  // 解析 finalize()。四个触发器：CloseStream 后的 TranscriptEndpoint
  //（约 300ms）；无数据计时器（1.5s）；WS 关闭（约 3-5s）；安全计时器（5s）。
  let resolveFinalize: ((source: FinalizeSource) => void) | null = null
  let cancelNoDataTimer: (() => void) | null = null

  // 在事件处理器之前定义连接对象，以便 WebSocket 打开时可以传给 onReady。
  const connection: VoiceStreamConnection = {
    send(audioChunk: Buffer): void {
      if (ws.readyState !== WebSocket.OPEN) {
        return
      }
      if (finalized) {
        // CloseStream 发送后，服务器拒绝进一步音频。
        // 丢弃数据块以避免协议错误。
        logForDebugging(
          `[voice_stream] Dropping audio chunk after CloseStream: ${String(audioChunk.length)} bytes`,
        )
        return
      }
      logForDebugging(
        `[voice_stream] Sending audio chunk: ${String(audioChunk.length)} bytes`,
      )
      // 发送前复制 buffer：来自原生模块的 NAPI Buffer 对象可能
      // 共享池化 ArrayBuffer。使用
      // `new Uint8Array(buf.buffer, offset, len)` 创建视图可能引用陈旧或
      // 重叠的内存（当 ws 库读取它时）。
      // `Buffer.from()` 创建一个 ws 库可以安全
      // 消费为二进制 WebSocket 帧的拥有副本。
      ws.send(Buffer.from(audioChunk))
    },
    finalize(): Promise<FinalizeSource> {
      if (finalizing || finalized) {
        // 已经 finalize 或 WebSocket 已经关闭 —— 立即解析。
        return Promise.resolve('ws_already_closed')
      }
      finalizing = true

      return new Promise<FinalizeSource>(resolve => {
        const safetyTimer = setTimeout(
          () => resolveFinalize?.('safety_timeout'),
          FINALIZE_TIMEOUTS_MS.safety,
        )
        const noDataTimer = setTimeout(
          () => resolveFinalize?.('no_data_timeout'),
          FINALIZE_TIMEOUTS_MS.noData,
        )
        cancelNoDataTimer = () => {
          clearTimeout(noDataTimer)
          cancelNoDataTimer = null
        }

        resolveFinalize = (source: FinalizeSource) => {
          clearTimeout(safetyTimer)
          clearTimeout(noDataTimer)
          resolveFinalize = null
          cancelNoDataTimer = null
          // 旧版 Deepgram 可能将中间结果留在 lastTranscriptText
          // 而没有 TranscriptEndpoint（websocket_manager.py 将
          // TranscriptChunk 和 TranscriptEndpoint 作为独立
          // 通道项发送）。所有解析触发器都必须提升它；
          // 在此集中处理。close 处理器已经做过时为空操作。
          if (lastTranscriptText) {
            logForDebugging(
              `[voice_stream] Promoting unreported interim before ${source} resolve`,
            )
            const t = lastTranscriptText
            lastTranscriptText = ''
            callbacks.onTranscript(t, true)
          }
          logForDebugging(`[voice_stream] Finalize resolved via ${source}`)
          resolve(source)
        }

        // 如果 WebSocket 已经关闭，立即解析。
        if (
          ws.readyState === WebSocket.CLOSED ||
          ws.readyState === WebSocket.CLOSING
        ) {
          resolveFinalize('ws_already_closed')
          return
        }

        // 将 CloseStream 推迟到下一次事件循环迭代，以便原生录制模块
        // 已排队的任何音频回调在服务器被告知停止接受音频之前
        // 刷新到 WebSocket。没有这个，stopRecording() 可以同步返回，而
        // 原生模块仍在事件队列中有待处理的 onData 回调，
        // 导致音频在 CloseStream 之后到达。
        setTimeout(() => {
          finalized = true
          if (ws.readyState === WebSocket.OPEN) {
            logForDebugging('[voice_stream] Sending CloseStream (finalize)')
            ws.send(CLOSE_STREAM_MSG)
          }
        }, 0)
      })
    },
    close(): void {
      finalized = true
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer)
        keepaliveTimer = null
      }
      connected = false
      if (ws.readyState === WebSocket.OPEN) {
        ws.close()
      }
    },
    isConnected(): boolean {
      return connected && ws.readyState === WebSocket.OPEN
    },
  }

  ws.on('open', () => {
    logForDebugging('[voice_stream] WebSocket connected')
    connected = true

    // 立即发送 KeepAlive，让服务器知道客户端活跃。
    // 音频硬件初始化可能需要 >1 秒，因此这防止
    // 服务器在音频捕获开始前关闭连接。
    logForDebugging('[voice_stream] Sending initial KeepAlive')
    ws.send(KEEPALIVE_MSG)

    // 发送周期性 keepalive 以防止空闲超时
    keepaliveTimer = setInterval(
      ws => {
        if (ws.readyState === WebSocket.OPEN) {
          logForDebugging('[voice_stream] Sending periodic KeepAlive')
          ws.send(KEEPALIVE_MSG)
        }
      },
      KEEPALIVE_INTERVAL_MS,
      ws,
    )

    // 将连接传给调用方，以便它可以开始发送音频。
    // 这仅在 WebSocket 真正打开后触发，保证
    // send() 调用不会被静默丢弃。
    callbacks.onReady(connection)
  })

  // 跟踪最后的 TranscriptText，以便 TranscriptEndpoint 到达时
  // 我们可以将其作为最终转录发出。服务器有时
  // 发送多个非累积的 TranscriptText 消息而中间没有端点；
  // TranscriptText 处理器在检测到文本非累积变化时
  // 自动 finalize 之前的段。
  let lastTranscriptText = ''

  ws.on('message', (raw: Buffer | string) => {
    const text = raw.toString()
    logForDebugging(
      `[voice_stream] Message received (${String(text.length)} chars): ${text.slice(0, 200)}`,
    )
    let msg: VoiceStreamMessage
    try {
      msg = jsonParse(text) as VoiceStreamMessage
    } catch {
      return
    }

    switch (msg.type) {
      case 'TranscriptText': {
        const transcript = msg.data
        logForDebugging(`[voice_stream] TranscriptText: "${transcript ?? ''}"`)
        // CloseStream 后数据到达 —— 解除无数据计时器，以便
        // 慢但真实的刷新不被切断。仅在 finalized 后
        //（CloseStream 已发送）解除；CloseStream 前数据竞争延迟
        // 发送会过早取消计时器，回退到
        // 更慢的 5 秒安全超时而不是 1.5 秒无数据计时器。
        if (finalized) {
          cancelNoDataTimer?.()
        }
        if (transcript) {
          // 检测服务器何时移动到新的语音段。
          // 渐进式细化扩展或缩短之前的文本
          //（例如 "hello" → "hello world"，或 "hello wor" → "hello wo"）。
          // 新段以完全不同的文本开始（彼此
          // 都不是前缀）。检测到时，将之前的
          // 文本作为最终文本发出，以便调用方可以累积它，防止
          // 新段覆盖并丢失旧段。
          //
          // Nova 3 的中间结果跨段累积且可以
          // 修订早期文本（"Hello?" → "Hello."）。修订破坏
          // 前缀检查，导致错误的自动 finalize → 同一
          // 文本提交一次又重新出现在累积
          // 中间结果中 = 重复。Nova 3 仅在最终
          // 刷新时端点化，因此自动 finalize 对它永远不正确。
          if (!isNova3 && lastTranscriptText) {
            const prev = lastTranscriptText.trimStart()
            const next = transcript.trimStart()
            if (
              prev &&
              next &&
              !next.startsWith(prev) &&
              !prev.startsWith(next)
            ) {
              logForDebugging(
                `[voice_stream] Auto-finalizing previous segment (new segment detected): "${lastTranscriptText}"`,
              )
              callbacks.onTranscript(lastTranscriptText, true)
            }
          }
          lastTranscriptText = transcript
          // 作为中间结果发出，以便调用方可以显示实时预览。
          callbacks.onTranscript(transcript, false)
        }
        break
      }
      case 'TranscriptEndpoint': {
        logForDebugging(
          `[voice_stream] TranscriptEndpoint received, lastTranscriptText="${lastTranscriptText}"`,
        )
        // 服务器发出一个话语结束的信号。将最后的
        // TranscriptText 作为最终转录发出，以便调用方可以提交它。
        const finalText = lastTranscriptText
        lastTranscriptText = ''
        if (finalText) {
          callbacks.onTranscript(finalText, true)
        }
        // 当 TranscriptEndpoint 在 CloseStream 发送后到达时，
        // 服务器已经刷新了其最终转录 —— 不会再有更多内容。
        // 现在解析 finalize，以便调用方立即读取
        // 累积缓冲区（约 300ms），而不是等待
        // WebSocket close 事件（约 3-5 秒的服务器拆除）。
        // `finalized`（不是 `finalizing`）是正确的门控：它在
        // 实际发送 CloseStream 的 setTimeout(0) 内翻转，因此
        // 竞争延迟发送的 TranscriptEndpoint 仍需等待。
        if (finalized) {
          resolveFinalize?.('post_closestream_endpoint')
        }
        break
      }
      case 'TranscriptError': {
        const desc =
          msg.description ?? msg.error_code ?? 'unknown transcription error'
        logForDebugging(`[voice_stream] TranscriptError: ${desc}`)
        if (!finalizing) {
          callbacks.onError(desc)
        }
        break
      }
      case 'error': {
        const errorDetail = msg.message ?? jsonStringify(msg)
        logForDebugging(`[voice_stream] Server error: ${errorDetail}`)
        if (!finalizing) {
          callbacks.onError(errorDetail)
        }
        break
      }
      default:
        break
    }
  })

  ws.on('close', (code, reason) => {
    const reasonStr = reason?.toString() ?? ''
    logForDebugging(
      `[voice_stream] WebSocket closed: code=${String(code)} reason="${reasonStr}"`,
    )
    connected = false
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer)
      keepaliveTimer = null
    }
    // 如果服务器在发送 TranscriptEndpoint 前关闭了连接，
    // 将最后的中间转录提升为最终，以免丢失文本。
    if (lastTranscriptText) {
      logForDebugging(
        '[voice_stream] Promoting unreported interim transcript to final on close',
      )
      const finalText = lastTranscriptText
      lastTranscriptText = ''
      callbacks.onTranscript(finalText, true)
    }
    // finalize 期间抑制 onError —— 会话已经传递了
    // 它拥有的内容。useVoice 的 onError 路径会清除 accumulatedRef，
    // 这会破坏 finalize .then() 读取之前的转录。
    // `finalizing`（不是 resolveFinalize）是门控：在
    // finalize() 入口设置一次，永不清除，因此在
    // 快速路径或计时器已经解析后仍保持准确。
    resolveFinalize?.('ws_close')
    if (!finalizing && !upgradeRejected && code !== 1000 && code !== 1005) {
      callbacks.onError(
        `Connection closed: code ${String(code)}${reasonStr ? ` — ${reasonStr}` : ''}`,
      )
    }
    callbacks.onClose()
  })

  // ws 库在 HTTP 升级返回非 101 状态时触发 'unexpected-response'。
  // 监听让我们可以呈现实际状态
  // 并将 4xx 标记为致命（相同的令牌/TLS 指纹在
  // 重试时不会改变）。注册了监听器后，ws 不会代表我们中止 ——
  // 我们销毁请求；'error' 不会触发，'close' 会触发（通过上面的
  // upgradeRejected 抑制）。
  //
  // Bun 的 ws 垫片历史上没有实现此事件（注册时
  // 会记录一次警告）。在 Bun 下，非 101 升级会
  // 落到通用的 'error' + 'close' 1002 路径，没有可恢复的
  // 状态；useVoice.ts 中的 attemptGenRef 守卫仍然会呈现
  // 重试失败，用户只是看到"Expected 101 status code"
  // 而不是"HTTP 503"。无害 —— gen 修复是承重部分。
  ws.on('unexpected-response', (req: ClientRequest, res: IncomingMessage) => {
    const status = res.statusCode ?? 0
    // Bun 在 Windows 上的 ws 实现可能为
    // 成功的 101 Switching Protocols 响应触发此事件（anthropics/claude-code#40510）。
    // 101 永远不是拒绝 —— 在销毁工作升级之前退出。
    if (status === 101) {
      logForDebugging(
        '[voice_stream] unexpected-response fired with 101; ignoring',
      )
      return
    }
    logForDebugging(
      `[voice_stream] Upgrade rejected: status=${String(status)} cf-mitigated=${String(res.headers['cf-mitigated'])} cf-ray=${String(res.headers['cf-ray'])}`,
    )
    upgradeRejected = true
    res.resume()
    req.destroy()
    if (finalizing) return
    callbacks.onError(
      `WebSocket upgrade rejected with HTTP ${String(status)}`,
      { fatal: status >= 400 && status < 500 },
    )
  })

  ws.on('error', (err: Error) => {
    logError(err)
    logForDebugging(`[voice_stream] WebSocket error: ${err.message}`)
    if (!finalizing) {
      callbacks.onError(`Voice stream connection error: ${err.message}`)
    }
  })

  return connection
}
