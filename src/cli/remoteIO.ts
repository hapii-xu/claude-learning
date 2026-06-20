import type { StdoutMessage } from 'src/entrypoints/sdk/controlTypes.js'
import { PassThrough } from 'stream'
import { URL } from 'url'
import { getSessionId } from '../bootstrap/state.js'
import { getPollIntervalConfig } from '../bridge/pollConfig.js'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import { setCommandLifecycleListener } from '../utils/commandLifecycle.js'
import { isDebugMode, logForDebugging } from '../utils/debug.js'
import { logForDiagnosticsNoPII } from '../utils/diagLogs.js'
import { isEnvTruthy } from '../utils/envUtils.js'
import { errorMessage } from '../utils/errors.js'
import { gracefulShutdown } from '../utils/gracefulShutdown.js'
import { logError } from '../utils/log.js'
import { writeToStdout } from '../utils/process.js'
import { getSessionIngressAuthToken } from '../utils/sessionIngressAuth.js'
import {
  setSessionMetadataChangedListener,
  setSessionStateChangedListener,
} from '../utils/sessionState.js'
import {
  setInternalEventReader,
  setInternalEventWriter,
} from '../utils/sessionStorage.js'
import { ndjsonSafeStringify } from './ndjsonSafeStringify.js'
import { StructuredIO } from './structuredIO.js'
import { CCRClient, CCRInitError } from './transports/ccrClient.js'
import { SSETransport } from './transports/SSETransport.js'
import type { Transport } from './transports/Transport.js'
import { getTransportForUrl } from './transports/transportUtils.js'

/**
 * 用于 SDK 模式并带有会话追踪的双向流
 * 支持 WebSocket 传输
 */
export class RemoteIO extends StructuredIO {
  private url: URL
  private transport: Transport
  private inputStream: PassThrough
  private readonly isBridge: boolean = false
  private readonly isDebug: boolean = false
  private ccrClient: CCRClient | null = null
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    streamUrl: string,
    initialPrompt?: AsyncIterable<string>,
    replayUserMessages?: boolean,
  ) {
    const inputStream = new PassThrough({ encoding: 'utf8' })
    super(inputStream, replayUserMessages)
    this.inputStream = inputStream
    this.url = new URL(streamUrl)

    // 准备 headers，如果存在会话 token 则带上
    const headers: Record<string, string> = {}
    const sessionToken = getSessionIngressAuthToken()
    if (sessionToken) {
      headers['Authorization'] = `Bearer ${sessionToken}`
    } else {
      logForDebugging('[remote-io] No session ingress token available', {
        level: 'error',
      })
    }

    // 如果存在环境 runner 版本则加入 headers（由 Environment Manager 设置）
    const erVersion = process.env.CLAUDE_CODE_ENVIRONMENT_RUNNER_VERSION
    if (erVersion) {
      headers['x-environment-runner-version'] = erVersion
    }

    // 提供一个动态重新读取会话 token 的回调。
    // 当父进程刷新 token（通过 token 文件或环境变量）时，
    // 传输层可以在重连时拿到最新的 token。
    const refreshHeaders = (): Record<string, string> => {
      const h: Record<string, string> = {}
      const freshToken = getSessionIngressAuthToken()
      if (freshToken) {
        h['Authorization'] = `Bearer ${freshToken}`
      }
      const freshErVersion = process.env.CLAUDE_CODE_ENVIRONMENT_RUNNER_VERSION
      if (freshErVersion) {
        h['x-environment-runner-version'] = freshErVersion
      }
      return h
    }

    // 根据 URL 协议获取对应的传输层
    this.transport = getTransportForUrl(
      this.url,
      headers,
      getSessionId(),
      refreshHeaders,
    )

    // 设置数据回调
    this.isBridge = process.env.CLAUDE_CODE_ENVIRONMENT_KIND === 'bridge'
    this.isDebug = isDebugMode()
    this.transport.setOnData((data: string) => {
      this.inputStream.write(data)
      if (this.isBridge && this.isDebug) {
        writeToStdout(data.endsWith('\n') ? data : data + '\n')
      }
    })

    // 设置关闭回调以处理连接失败
    this.transport.setOnClose(() => {
      // 结束输入流以触发优雅关闭
      this.inputStream.end()
    })

    // 初始化 CCR v2 客户端（心跳、epoch、状态上报、事件写入）。
    // CCRClient 构造函数同步地装配 SSE received-ack 处理器，
    // 因此 new CCRClient() 必须在 transport.connect() 之前执行 —
    // 否则早期的 SSE 帧会命中未装配的 onEventCallback，其
    // 'received' 投递确认会被静默丢弃。
    if (isEnvTruthy(process.env.CLAUDE_CODE_USE_CCR_V2)) {
      // CCR v2 按定义就是 SSE+POST。getTransportForUrl 在同一环境变量下
      // 会返回 SSETransport，但这两处检查位于不同文件中 — 在此断言该
      // 不变式，以便未来解耦时在这里显式失败，而不是在 CCRClient 内部
      // 令人困惑地失败。
      if (!(this.transport instanceof SSETransport)) {
        throw new Error(
          'CCR v2 requires SSETransport; check getTransportForUrl',
        )
      }
      this.ccrClient = new CCRClient(this.transport, this.url)
      const init = this.ccrClient.initialize()
      this.restoredWorkerState = init.catch(() => null)
      init.catch((error: unknown) => {
        logForDiagnosticsNoPII('error', 'cli_worker_lifecycle_init_failed', {
          reason: error instanceof CCRInitError ? error.reason : 'unknown',
        })
        logError(
          new Error(`CCRClient initialization failed: ${errorMessage(error)}`),
        )
        void gracefulShutdown(1, 'other')
      })
      registerCleanup(async () => this.ccrClient?.close())

      // 为 transcript 持久化注册内部事件写入器。
      // 设置后，sessionStorage 会把 transcript 消息作为 CCR v2
      // 内部事件写入，而不是 v1 的 Session Ingress。
      setInternalEventWriter((eventType, payload, options) =>
        this.ccrClient!.writeInternalEvent(eventType, payload, options),
      )

      // 为会话恢复注册内部事件读取器。
      // 设置后，hydrateFromCCRv2InternalEvents() 可以拉取前台
      // 和子代理的内部事件来重建会话状态。
      setInternalEventReader(
        () => this.ccrClient!.readInternalEvents(),
        () => this.ccrClient!.readSubagentInternalEvents(),
      )

      const LIFECYCLE_TO_DELIVERY = {
        started: 'processing',
        completed: 'processed',
      } as const
      setCommandLifecycleListener((uuid, state) => {
        this.ccrClient?.reportDelivery(uuid, LIFECYCLE_TO_DELIVERY[state])
      })
      setSessionStateChangedListener((state, details) => {
        this.ccrClient?.reportState(state, details)
      })
      setSessionMetadataChangedListener(
        metadata => {
          this.ccrClient?.reportMetadata(metadata)
        },
        { replayCurrent: true },
      )
    }

    // 只有在所有回调都已装配好之后才发起连接（上方的 setOnData，
    // 以及启用 CCR v2 时 new CCRClient() 内部的 setOnEvent）。
    void this.transport.connect()

    // 以固定间隔推送静默的 keep_alive 帧，使上游代理和 session-ingress 层
    // 不会回收一个原本空闲的 remote control 会话。keep_alive 类型在到达任何
    // 客户端 UI 之前会被过滤掉（Query.ts 会丢弃它；structuredIO.ts 会丢弃它；
    // web/iOS/Android 在其消息循环中永远看不到它）。间隔来自 GrowthBook
    //（tengu_bridge_poll_interval_config 的 session_keepalive_interval_v2_ms，
    // 默认 120s）；0 = 禁用。
    // 仅 Bridge 场景：修复 bridge 拓扑会话上的 Envoy 空闲超时问题
    //（#21931）。byoc workers 在 #21931 之前没有它也能运行，并且不需要 —
    // 网络路径不同。
    const keepAliveIntervalMs =
      getPollIntervalConfig().session_keepalive_interval_v2_ms
    if (this.isBridge && keepAliveIntervalMs > 0) {
      this.keepAliveTimer = setInterval(() => {
        logForDebugging('[remote-io] keep_alive sent')
        void this.write({ type: 'keep_alive' }).catch(err => {
          logForDebugging(
            `[remote-io] keep_alive write failed: ${errorMessage(err)}`,
          )
        })
      }, keepAliveIntervalMs)
      this.keepAliveTimer.unref?.()
    }

    // 注册以进行优雅关闭的清理
    registerCleanup(async () => this.close())

    // 如果提供了初始 prompt，则通过输入流发送
    if (initialPrompt) {
      // 将初始 prompt 转换为输入流格式。
      // 来自 stdin 的块可能已经带有尾随换行，因此在追加我们自己的换行之前
      // 先剥离它们，以避免出现双换行问题，导致 structuredIO 解析出空行。
      // String() 同时处理字符串块以及来自 process.stdin 的 Buffer 对象。
      const stream = this.inputStream
      void (async () => {
        for await (const chunk of initialPrompt) {
          stream.write(String(chunk).replace(/\n$/, '') + '\n')
        }
      })()
    }
  }

  override flushInternalEvents(): Promise<void> {
    return this.ccrClient?.flushInternalEvents() ?? Promise.resolve()
  }

  override get internalEventsPending(): number {
    return this.ccrClient?.internalEventsPending ?? 0
  }

  /**
   * 将输出发送到传输层。
   * 在 bridge 模式下，control_request 消息总是会回显到 stdout，以便
   * bridge 父进程能检测到权限请求。其他消息仅在
   * debug 模式下回显。
   */
  async write(message: StdoutMessage): Promise<void> {
    if (this.ccrClient) {
      await this.ccrClient.writeEvent(message)
    } else {
      await this.transport.write(message)
    }
    if (this.isBridge) {
      if (message.type === 'control_request' || this.isDebug) {
        writeToStdout(ndjsonSafeStringify(message) + '\n')
      }
    }
  }

  /**
   * 优雅地清理连接
   */
  close(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer)
      this.keepAliveTimer = null
    }
    this.transport.close()
    this.inputStream.end()
  }
}
