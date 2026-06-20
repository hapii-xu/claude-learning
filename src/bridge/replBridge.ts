// biome-ignore-all assist/source/organizeImports: ANT-ONLY 导入标记不可重排
import { randomUUID } from 'crypto'
import {
  createBridgeApiClient,
  BridgeFatalError,
  isExpiredErrorType,
  isSuppressible403,
} from './bridgeApi.js'
import type { BridgeConfig, BridgeApiClient } from './types.js'
import { logForDebugging } from '../utils/debug.js'
import { rcLog } from './rcDebugLog.js'
import { logForDiagnosticsNoPII } from '../utils/diagLogs.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import {
  handleIngressMessage,
  handleServerControlRequest,
  makeResultMessage,
  isEligibleBridgeMessage,
  extractTitleText,
  BoundedUUIDSet,
} from './bridgeMessaging.js'
import {
  decodeWorkSecret,
  buildSdkUrl,
  buildCCRv2SdkUrl,
  sameSessionId,
} from './workSecret.js'
import { toCompatSessionId, toInfraSessionId } from './sessionIdCompat.js'
import { updateSessionBridgeId } from '../utils/concurrentSessions.js'
import { getTrustedDeviceToken } from './trustedDevice.js'
import { HybridTransport } from '../cli/transports/HybridTransport.js'
import {
  type ReplBridgeTransport,
  createV1ReplTransport,
  createV2ReplTransport,
} from './replBridgeTransport.js'
import { updateSessionIngressAuthToken } from '../utils/sessionIngressAuth.js'
import { setSessionMetadataChangedListener } from '../utils/sessionState.js'
import { isEnvTruthy, isInProtectedNamespace } from '../utils/envUtils.js'
import { validateBridgeId } from './bridgeApi.js'
import {
  describeAxiosError,
  extractHttpStatus,
  logBridgeSkip,
} from './debugUtils.js'
import type { Message } from '../types/message.js'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import type { PermissionMode } from '../utils/permissions/PermissionMode.js'
import type {
  SDKControlRequest,
  SDKControlResponse,
} from '../entrypoints/sdk/controlTypes.js'
import type { StdoutMessage } from '../entrypoints/sdk/controlTypes.js'

/**
 * 带可选 session_id 的 StdoutMessage。transport 层接收 StdoutMessage，
 * 但我们在运行时给它加上 session_id。用 optional 是因为类型系统无法
 * 验证给 union 类型加 session_id 永远合法，尽管运行时确实如此。
 *
 * 传给 transport 时需要用 'as StdoutMessage'，因为 TypeScript 无法
 * 验证带 session_id 的对象是合法的 StdoutMessage。
 */
type TransportMessage = StdoutMessage & { session_id?: string }
import { createCapacityWake, type CapacitySignal } from './capacityWake.js'
import { FlushGate } from './flushGate.js'
import {
  DEFAULT_POLL_CONFIG,
  type PollIntervalConfig,
} from './pollConfigDefaults.js'
import { errorMessage } from '../utils/errors.js'
import { sleep } from '../utils/sleep.js'
import {
  wrapApiForFaultInjection,
  registerBridgeDebugHandle,
  clearBridgeDebugHandle,
  injectBridgeFault,
} from './bridgeDebug.js'

export type ReplBridgeHandle = {
  bridgeSessionId: string
  environmentId: string
  sessionIngressUrl: string
  writeMessages(messages: Message[]): void
  writeSdkMessages(messages: SDKMessage[]): void
  markTranscriptReset?(): void
  sendControlRequest(request: SDKControlRequest): void
  sendControlResponse(response: SDKControlResponse): void
  sendControlCancelRequest(requestId: string): void
  sendResult(): void
  teardown(): Promise<void>
}

export type BridgeState = 'ready' | 'connected' | 'reconnecting' | 'failed'

/**
 * initBridgeCore 的显式参数输入。initReplBridge 之前从 bootstrap state
 * 读取的所有内容（cwd、session ID、git、OAuth）都变成这里的字段。
 * 从不运行 main.tsx 的 daemon 调用方（Agent SDK，PR 4）自行填入。
 */
export type BridgeCoreParams = {
  dir: string
  machineName: string
  branch: string
  gitRepoUrl: string | null
  title: string
  baseUrl: string
  sessionIngressUrl: string
  /**
   * 作为 metadata.worker_type 下发的字符串。两个 CLI 来源值请用
   * BridgeWorkerType；daemon 调用方可下发后端认可的任意字符串
   *（这只是 web 端的一个过滤 key）。
   */
  workerType: string
  getAccessToken: () => string | undefined
  /**
   * POST /v1/sessions。注入是因为 `createSession.ts` 会 lazy-load
   * `auth.ts`/`model.ts`/`oauth/client.ts`，而 `bun --outfile` 会内联
   * 动态导入 —— lazy-load 没用，整个 REPL 树最终都进到了 Agent SDK 包。
   *
   * REPL 包装器传 `createSession.ts` 里的 `createBridgeSession`。
   * Daemon 包装器传 `sessionApi.ts` 里的 `createBridgeSessionLean`
   *（纯 HTTP，orgUUID+model 由 daemon 调用方提供）。
   *
   * 带 `gitRepoUrl`+`branch` 是为了让 REPL 包装器能给 claude.ai 的
   * session 卡片构造 git source/outcome。Daemon 会忽略它们。
   */
  createSession: (opts: {
    environmentId: string
    title: string
    gitRepoUrl: string | null
    branch: string
    signal: AbortSignal
  }) => Promise<string | null>
  /**
   * POST /v1/sessions/{id}/archive。注入理由同上。尽力而为；
   * 回调绝对不能抛异常。
   */
  archiveSession: (sessionId: string) => Promise<void>
  /**
   * 在 env-lost 后重连时调用以刷新 title。REPL 包装器读 session storage
   *（感知 /rename）；daemon 返回静态 title。默认 () => title。
   */
  getCurrentTitle?: () => string
  /**
   * 把内部 Message[] 转成 SDKMessage[]，供 writeMessages() 和
   * initial-flush/drain 路径使用。REPL 包装器传 utils/messages/mappers.ts
   * 里的真实 toSDKMessages。只用 writeSdkMessages() 且不传 initialMessages
   * 的 daemon 调用方可省略 —— 这些代码路径走不到。
   *
   * 注入而非直接 import，是因为 mappers.ts 会通过 messages.ts → api.ts →
   * prompts.ts 传递性地拉入 src/commands.ts，把整个 command registry 和
   * React 树都拖进 Agent SDK 包。
   */
  toSDKMessages?: (messages: Message[]) => SDKMessage[]
  /**
   * 传给 createBridgeApiClient 的 OAuth 401 刷新处理器。REPL 包装器传
   * handleOAuth401Error；daemon 传其 AuthManager 的处理器。注入是因为
   * utils/auth.ts 会通过 config.ts → file.ts → permissions/filesystem.ts →
   * sessionStorage.ts → commands.ts 传递性地拉入 command registry。
   */
  onAuth401?: (staleAccessToken: string) => Promise<boolean>
  /**
   * work-poll heartbeat 循环用的 poll interval 配置 getter。REPL 包装器
   * 传 GrowthBook 支持的 getPollIntervalConfig（允许 ops 全集群实时调
   * poll 频率）。Daemon 传静态配置，60s heartbeat（300s work-lease TTL
   * 的 5 倍余量）。注入是因为 growthbook.ts 也会通过同样的 config.ts
   * 链路传递性拉入 command registry。
   */
  getPollIntervalConfig?: () => PollIntervalConfig
  /**
   * connect 时重放的最大 initial messages 数量。REPL 包装器从
   * tengu_bridge_initial_history_cap GrowthBook flag 读取。Daemon 不传
   * initialMessages，所以这个值不会被读到。默认 200，与 flag 默认一致。
   */
  initialHistoryCap?: number
  // 与 InitBridgeOptions 同样的 REPL-flush 机制 —— daemon 省略这些。
  initialMessages?: Message[]
  previouslyFlushedUUIDs?: Set<string>
  onInboundMessage?: (msg: SDKMessage) => void
  onPermissionResponse?: (response: SDKControlResponse) => void
  onInterrupt?: () => void
  onSetModel?: (model: string | undefined) => void
  onSetMaxThinkingTokens?: (maxTokens: number | null) => void
  /**
   * 返回一个 policy verdict，让本模块在不自行 import policy 校验的情况下
   *（bootstrap 隔离约束）发送 error control_response。回调必须在调用
   * transitionPermissionMode 之前先校验 `auto`（isAutoModeGateEnabled）和
   * `bypassPermissions`（isBypassPermissionsModeDisabled 与
   * isBypassPermissionsModeAvailable）—— 该函数内部的 auto-gate 校验
   * 是防御性抛错，不是优雅的守卫，且副作用顺序是先
   * setAutoModeActive(true) 再抛错，一旦这里让异常逃出，就会破坏
   * src/CLAUDE.md 里描述的三态不变量。
   */
  onSetPermissionMode?: (
    mode: PermissionMode,
  ) => { ok: true } | { ok: false; error: string }
  onStateChange?: (state: BridgeState, detail?: string) => void
  /**
   * 每条流经 writeMessages() 的真实 user 消息都会触发，直到回调返回
   * true（结束）。对应 remoteBridgeCore.ts 的 onUserMessage，让 REPL
   * bridge 能在 init 时没设 title 的情况下从早期 prompt 推导 session 标题
   *（例如用户在一个空对话里运行 /remote-control 再输入）。tool-result
   * 包裹、meta 消息、纯 display-tag 消息都会跳过。传入 currentSessionId
   * 让包装器能 PATCH 标题，不必通过闭包去够那个尚未返回的 handle。
   * 调用方自负"count 1 和 3 时推导"的策略；transport 只是一直调用直到
   * 被叫停。writeSdkMessages 的 daemon 路径不触发（daemon 在 init 时自定
   * 标题）。与 SessionSpawnOpts 的 onFirstUserMessage（spawn-bridge，
   * PR #21250）不同 —— 那个是只触发一次。
   */
  onUserMessage?: (text: string, sessionId: string) => boolean
  /** 见 InitBridgeOptions.perpetual。 */
  perpetual?: boolean
  /**
   * 用于初始化 lastTransportSequenceNum —— SSE 事件流的高水位线，
   * 跨一个进程内的多次 transport 切换保留。Daemon 调用方传它们在关闭时
   * 持久化的值，让新进程第一次 SSE connect 时带上 from_sequence_num，
   * 服务器就不会重放完整历史。REPL 调用方省略（每次运行都是新 session
   * → 0 才是对的）。
   */
  initialSSESequenceNum?: number
}

/**
 * ReplBridgeHandle 的超集。新增 getSSESequenceNum，供跨进程重启持久化
 * SSE seq-num 并在下次启动时作为 initialSSESequenceNum 回传的 daemon
 * 调用方使用。
 */
export type BridgeCoreHandle = ReplBridgeHandle & {
  /**
   * 当前的 SSE sequence-number 高水位线。随 transport 切换而更新。
   * Daemon 调用方在关闭时持久化此值，下次启动时作为
   * initialSSESequenceNum 回传。
   */
  getSSESequenceNum(): number
}

/**
 * Poll 错误恢复常量。当 work poll 开始失败（例如服务器 500）时，
 * 我们用指数退避，超过这个时长就放弃。这里故意设得很长 —— 服务器才
 * 是判定 session 是否真死的权威。只要服务器还接受我们的 poll，我们
 * 就一直等它重新派发 work item。
 */
const POLL_ERROR_INITIAL_DELAY_MS = 2_000
const POLL_ERROR_MAX_DELAY_MS = 60_000
const POLL_ERROR_GIVE_UP_MS = 15 * 60 * 1000

// 单调递增的计数器，用于在日志中区分不同的 init 调用
let initSequence = 0

/**
 * 不依赖 bootstrap 的核心流程：env 注册 → session 创建 → poll 循环 →
 * ingress WS → teardown。不从 bootstrap/state 或 sessionStorage 读任何
 * 东西 —— 所有上下文都来自参数。调用方（下面的 initReplBridge，或
 * PR 4 里的 daemon）已经过了 entitlement 门禁并准备好 git/auth/title。
 *
 * 注册或 session 创建失败时返回 null。
 */
export async function initBridgeCore(
  params: BridgeCoreParams,
): Promise<BridgeCoreHandle | null> {
  const {
    dir,
    machineName,
    branch,
    gitRepoUrl,
    title,
    baseUrl,
    sessionIngressUrl,
    workerType,
    getAccessToken,
    createSession,
    archiveSession,
    getCurrentTitle = () => title,
    toSDKMessages = () => {
      throw new Error(
        'BridgeCoreParams.toSDKMessages not provided. Pass it if you use writeMessages() or initialMessages — daemon callers that only use writeSdkMessages() never hit this path.',
      )
    },
    onAuth401,
    getPollIntervalConfig = () => DEFAULT_POLL_CONFIG,
    initialHistoryCap = 200,
    initialMessages,
    previouslyFlushedUUIDs,
    onInboundMessage,
    onPermissionResponse,
    onInterrupt,
    onSetModel,
    onSetMaxThinkingTokens,
    onSetPermissionMode,
    onStateChange,
    onUserMessage,
    perpetual,
    initialSSESequenceNum = 0,
  } = params

  const seq = ++initSequence

  // bridgePointer 导入前置：perpetual 模式在 register 之前读取；
  // 非 perpetual 在 session create 之后写入；两者都在 teardown 时 clear。
  const { writeBridgePointer, clearBridgePointer, readBridgePointer } =
    await import('./bridgePointer.js')

  // Perpetual 模式：读取崩溃恢复指针并当作前置状态。指针在 session
  // create 之后无条件写入（为所有 session 做崩溃恢复）；perpetual 模式
  // 只是跳过 teardown 的 clear，让它在干净退出后也留存。只复用 'repl'
  // 指针 —— 崩溃的 standalone bridge（`claude remote-control`）写入的是
  // source:'standalone'，对应的 workerType 不同。
  const rawPrior = perpetual ? await readBridgePointer(dir) : null
  const prior = rawPrior?.source === 'repl' ? rawPrior : null

  logForDebugging(
    `[bridge:repl] initBridgeCore #${seq} starting (initialMessages=${initialMessages?.length ?? 0}${prior ? ` perpetual prior=env:${prior.environmentId}` : ''})`,
  )

  // 5. 注册 bridge environment
  const rawApi = createBridgeApiClient({
    baseUrl,
    getAccessToken,
    runnerVersion: MACRO.VERSION,
    onDebug: logForDebugging,
    onAuth401,
    getTrustedDeviceToken,
  })
  // 仅 ant：在 API 层前包一层，让 /bridge-kick 能注入 poll/register/
  // heartbeat 失败。外部构建零开销（rawApi 透传不变）。
  const api =
    process.env.USER_TYPE === 'ant' ? wrapApiForFaultInjection(rawApi) : rawApi

  const bridgeConfig: BridgeConfig = {
    dir,
    machineName,
    branch,
    gitRepoUrl,
    maxSessions: 1,
    spawnMode: 'single-session',
    verbose: false,
    sandbox: false,
    bridgeId: randomUUID(),
    workerType,
    environmentId: randomUUID(),
    reuseEnvironmentId: prior?.environmentId,
    apiBaseUrl: baseUrl,
    sessionIngressUrl,
  }

  let environmentId: string
  let environmentSecret: string
  try {
    const reg = await api.registerBridgeEnvironment(bridgeConfig)
    environmentId = reg.environment_id
    environmentSecret = reg.environment_secret
  } catch (err) {
    logBridgeSkip(
      'registration_failed',
      `[bridge:repl] Environment registration failed: ${errorMessage(err)}`,
    )
    // 指针过期可能是原因（env 过期或被删） —— 清掉它，避免下次启动
    // 又去试这个已经失效的 ID。
    if (prior) {
      await clearBridgePointer(dir)
    }
    onStateChange?.('failed', errorMessage(err))
    return null
  }

  logForDebugging(`[bridge:repl] Environment registered: ${environmentId}`)
  logForDiagnosticsNoPII('info', 'bridge_repl_env_registered')
  logEvent('tengu_bridge_repl_env_registered', {})

  /**
   * 原地重连：如果刚注册的 environmentId 与请求一致，就调用
   * reconnectSession 强制停掉残留 worker 并把 session 重新入队。
   * 用于 init（perpetual 模式 —— env 还活着但干净 teardown 后空闲）和
   * doReconnect() 的 Strategy 1（env 丢失后又复活）。成功返回 true；
   * 失败时调用方回退到全新 session 创建。
   */
  async function tryReconnectInPlace(
    requestedEnvId: string,
    sessionId: string,
  ): Promise<boolean> {
    if (environmentId !== requestedEnvId) {
      logForDebugging(
        `[bridge:repl] Env mismatch (requested ${requestedEnvId}, got ${environmentId}) — cannot reconnect in place`,
      )
      return false
    }
    // 指针里存的是 createBridgeSession 的返回值（session_*，
    // compat/convert.go:41）。/bridge/reconnect 是 environments 层的
    // endpoint —— 一旦服务器的 ccr_v2_compat_enabled gate 打开，它会按
    // infra tag（cse_*）查找 session，对 session_* 的外衣返回 "Session
    // not found"。poll 之前我们不知道 gate 状态，所以两种都试一遍；
    // 如果 ID 已经是 cse_*，重新打 tag 是 no-op（doReconnect Strategy 1
    // 路径 —— currentSessionId 不会变更为 cse_*，但这里为将来留余地）。
    const infraId = toInfraSessionId(sessionId)
    const candidates =
      infraId === sessionId ? [sessionId] : [sessionId, infraId]
    for (const id of candidates) {
      try {
        await api.reconnectSession(environmentId, id)
        logForDebugging(
          `[bridge:repl] Reconnected session ${id} in place on env ${environmentId}`,
        )
        return true
      } catch (err) {
        logForDebugging(
          `[bridge:repl] reconnectSession(${id}) failed: ${errorMessage(err)}`,
        )
      }
    }
    logForDebugging(
      '[bridge:repl] reconnectSession exhausted — falling through to fresh session',
    )
    return false
  }

  // Perpetual init：env 还活着，但干净 teardown 之后没有排队 work。
  // reconnectSession 会把它重新入队。doReconnect() 里有相同的调用，
  // 但只在 poll 404（env 死了）时触发；这里 env 活着但空闲。
  const reusedPriorSession = prior
    ? await tryReconnectInPlace(prior.environmentId, prior.sessionId)
    : false
  if (prior && !reusedPriorSession) {
    await clearBridgePointer(dir)
  }

  // 6. 在 bridge 上创建 session。Initial messages 不作为 session creation
  // 事件提交，因为那些用的是 STREAM_ONLY 持久化，会在 CCR UI 订阅之前
  // 就发布，导致丢失。改用 ingress WebSocket 连上之后通过它 flush。

  // 可变的 session ID —— 当 env+session 对在连接丢失后被重建时会更新。
  let currentSessionId: string

  if (reusedPriorSession && prior) {
    currentSessionId = prior.sessionId
    logForDebugging(
      `[bridge:repl] Perpetual session reused: ${currentSessionId}`,
    )
    // 服务器已经持有上一次 CLI 运行所有 initialMessages。把它们标记为
    // previously-flushed，让 initial flush 过滤掉它们
    //（previouslyFlushedUUIDs 是每次 CLI 启动时新建的 Set）。重复的
    // UUID 会让服务器杀掉 WebSocket。
    if (initialMessages && previouslyFlushedUUIDs) {
      for (const msg of initialMessages) {
        previouslyFlushedUUIDs.add(msg.uuid)
      }
    }
  } else {
    const createdSessionId = await createSession({
      environmentId,
      title,
      gitRepoUrl,
      branch,
      signal: AbortSignal.timeout(15_000),
    })

    if (!createdSessionId) {
      logForDebugging(
        '[bridge:repl] Session creation failed, deregistering environment',
      )
      logEvent('tengu_bridge_repl_session_failed', {})
      await api.deregisterEnvironment(environmentId).catch(() => {})
      onStateChange?.('failed', 'Session creation failed')
      return null
    }

    currentSessionId = createdSessionId
    logForDebugging(`[bridge:repl] Session created: ${currentSessionId}`)
  }

  // 崩溃恢复指针：现在就写入，这样此后任何时刻发生 kill -9 都留有可恢复
  // 的痕迹。teardown 时清掉（非 perpetual），或不动它（perpetual 模式 ——
  // 指针在干净退出后也留存）。从同一目录运行
  // `claude remote-control --continue` 会检测到并提示恢复。
  await writeBridgePointer(dir, {
    sessionId: currentSessionId,
    environmentId,
    source: 'repl',
  })
  logForDiagnosticsNoPII('info', 'bridge_repl_session_created')
  logEvent('tengu_bridge_repl_started', {
    has_initial_messages: !!(initialMessages && initialMessages.length > 0),
    inProtectedNamespace: isInProtectedNamespace(),
  })

  // initial messages 的 UUID 集合。用于 writeMessages 中去重，避免重复
  // 发送 WebSocket 打开时已经 flush 过的消息。
  const initialMessageUUIDs = new Set<string>()
  if (initialMessages) {
    for (const msg of initialMessages) {
      initialMessageUUIDs.add(msg.uuid)
    }
  }

  // 有界环形缓冲，存放已经通过 ingress WebSocket 发给服务器的消息 UUID。
  // 两个用途：
  //  1. Echo 过滤 —— 忽略我们自己发出、在 WS 上回弹回来的消息。
  //  2. writeMessages 的二级去重 —— 兜底 hook 基于索引追踪不够用的竞态。
  //
  // 用 initialMessageUUIDs 作为种子，这样服务器在 ingress WebSocket 上
  // 把初始对话上下文回弹回来时，这些消息会被识别为 echo，不会再次注入
  // REPL。
  //
  // 容量 2000 足够覆盖任何现实的 echo 窗口（echo 在毫秒内到达）以及
  // compact 后可能再次遇到的任何消息。hook 的 lastWrittenIndexRef 是
  // 主去重；这里是安全网。
  const recentPostedUUIDs = new BoundedUUIDSet(2000)
  for (const uuid of initialMessageUUIDs) {
    recentPostedUUIDs.add(uuid)
  }

  // 有界集合，存放已转发到 REPL 的 INBOUND prompt UUID。当服务器重新
  // 投递 prompt 时（seq-num 协商失败、服务器边缘场景、transport 切换
  // 竞态）的防御性去重。下面的 seq-num 携带是主要修复；这是安全网。
  const recentInboundUUIDs = new BoundedUUIDSet(2000)

  // 7. 启动 work item 的 poll 循环 —— 这才让 session 在 claude.ai 上
  // "活"起来。用户在那边输入时，后端给我们环境派发一个 work item。我们
  // 把它 poll 出来，拿到 ingress token，并连上 ingress WebSocket。
  //
  // poll 循环会持续运行：work 到达时连 ingress WebSocket，而如果
  // WebSocket 意外断开（code != 1000），它会恢复 polling 以拿到新的
  // ingress token 并重连。
  const pollController = new AbortController()
  // 适配 HybridTransport（v1：WS 读 + POST 写到 Session-Ingress）或
  // SSETransport+CCRClient（v2：SSE 读 + POST 写到 CCR /worker/*）。
  // v1/v2 的选择在 onWorkReceived 里做：由服务器的
  // secret.use_code_sessions 驱动，CLAUDE_BRIDGE_USE_CCR_V2 作为 ant
  // 开发覆盖。
  let transport: ReplBridgeTransport | null = null
  // 把当前 REPL 的 external metadata 更新镜像到当前持有 remote-control
  // session 的 transport。v1 会忽略该调用；v2 会转发到 CCR /worker 的
  // external_metadata，让 standby/sleeping 等会话元数据在 web/mobile 上
  // 留存。
  setSessionMetadataChangedListener(
    metadata => {
      if (pollController.signal.aborted) return
      transport?.reportMetadata(metadata)
    },
    { replayCurrent: true },
  )
  // 每次 onWorkReceived 都自增。被 createV2ReplTransport 的 .then()
  // 闭包捕获，用于检测过期的解析结果：如果两次调用在 transport 为 null
  // 时竞态，两者都会 registerWorker()（让服务器 epoch 自增），而第二个
  // resolve 的才是对的 —— 但 transport !== null 检查会判断反（先 resolve
  // 的安装，后 resolve 的丢弃）。generation 计数器能在不依赖 transport
  // 状态的情况下抓住这种情况。
  let v2Generation = 0
  // 跨 transport 切换保留的 SSE sequence-number 高水位线。没这个的话，
  // 每个新 SSETransport 都从 0 开始，第一次 connect 不带
  // from_sequence_num / Last-Event-ID，服务器就会重放整个 session 事件
  // 历史 —— 每次发过的 prompt 都会在每次 onWorkReceived 时当作新 inbound
  // 消息再下发一遍。
  //
  // 只有真的复用了上一个 session 才 seed。若 `reusedPriorSession` 为
  // false，我们会落到 `createSession()` —— 调用方持久化的 seq-num 属于
  // 一个已死的 session，套到新流（从 1 开始）会静默丢事件。与
  // doReconnect Strategy 2 同样的风险；同样的修复（在那里重置）。
  let lastTransportSequenceNum = reusedPriorSession ? initialSSESequenceNum : 0
  // 记录当前 work ID，以便 teardown 时调用 stopWork
  let currentWorkId: string | null = null
  // 当前 work item 的 session ingress JWT —— 用于 heartbeat 认证。
  let currentIngressToken: string | null = null
  // transport 丢失时提前唤醒 at-capacity sleep 的信号，让 poll 循环
  // 立刻切回快速轮询寻找新 work。
  const capacityWake = createCapacityWake(pollController.signal)
  const wakePollLoop = capacityWake.wake
  const capacitySignal = capacityWake.signal
  // initial flush 期间门控消息写入，避免新消息与历史交错到达服务器产生
  // 顺序竞态。
  const flushGate = new FlushGate<Message>()

  // onUserMessage 的闩锁 —— 回调返回 true（策略认为"推导完"）时翻为
  // true。若无回调，直接跳过扫描（daemon 路径 —— 不需要推导标题）。
  let userMessageCallbackDone = !onUserMessage

  // env 重建的共享计数器，onEnvironmentLost 和异常关闭处理器都会用到。
  const MAX_ENVIRONMENT_RECREATIONS = 3
  let environmentRecreations = 0
  let reconnectPromise: Promise<boolean> | null = null

  /**
   * 从 onEnvironmentLost（poll 返回 404 —— env 在服务器侧被回收）中恢复。
   * 按顺序尝试两种策略：
   *
   *   1. 原地重连：带 reuseEnvironmentId 做幂等 re-register，如果后端
   *      返回相同的 env ID，就调用 reconnectSession() 把现有 session
   *      重新入队。currentSessionId 保持不变；用户手机上的 URL 继续可用；
   *      previouslyFlushedUUIDs 保留，历史不会被重发。
   *
   *   2. 全新 session 兜底：如果后端返回不同的 env ID（原 TTL 过期，
   *      例如笔记本睡眠超过 4 小时）或 reconnectSession() 抛异常，归档
   *      旧 session 并在刚注册的 env 上创建新 session。#20460 基础设施
   *      落地之前的旧行为。
   *
   * 使用 promise 实现的重入保护，让并发调用方共享同一次重连尝试。
   */
  async function reconnectEnvironmentWithSession(): Promise<boolean> {
    if (reconnectPromise) {
      return reconnectPromise
    }
    reconnectPromise = doReconnect()
    try {
      return await reconnectPromise
    } finally {
      reconnectPromise = null
    }
  }

  async function doReconnect(): Promise<boolean> {
    environmentRecreations++
    rcLog(
      `doReconnect: attempt=${environmentRecreations}/${MAX_ENVIRONMENT_RECREATIONS}` +
        ` envId=${environmentId}` +
        ` sessionId=${currentSessionId}` +
        ` workId=${currentWorkId}`,
    )
    // 让在途的 v2 握手失效 —— env 正在被重建，重连后到达的过期 transport
    // 会指向一个已死的 session。
    v2Generation++
    logForDebugging(
      `[bridge:repl] Reconnecting after env lost (attempt ${environmentRecreations}/${MAX_ENVIRONMENT_RECREATIONS})`,
    )

    if (environmentRecreations > MAX_ENVIRONMENT_RECREATIONS) {
      logForDebugging(
        `[bridge:repl] Environment reconnect limit reached (${MAX_ENVIRONMENT_RECREATIONS}), giving up`,
      )
      return false
    }

    // 关闭过期 transport。close 之前先捕获 seq —— 如果 Strategy 1
    //（tryReconnectInPlace）成功，我们保留同一个 session，下一个 transport
    // 必须从这个 transport 停下的位置继续，而不是从上一次 transport 切换
    // 的检查点重放。
    if (transport) {
      const seq = transport.getLastSequenceNum()
      if (seq > lastTransportSequenceNum) {
        lastTransportSequenceNum = seq
      }
      transport.close()
      transport = null
    }
    // transport 已经没了 —— 把 poll 循环从 at-capacity heartbeat sleep 中
    // 唤醒，让它能快速 poll 寻找重新派发的 work。
    wakePollLoop()
    // 重置 flush gate，让 writeMessages() 命中 !transport 守卫，而不是静默
    // 地把消息塞进一个死缓冲。
    flushGate.drop()

    // 释放当前 work item（force=false —— 我们可能还想要这个 session）。
    // 尽力而为：env 多半已经没了，所以这个请求很可能会 404。
    if (currentWorkId) {
      const workIdBeingCleared = currentWorkId
      await api
        .stopWork(environmentId, workIdBeingCleared, false)
        .catch(() => {})
      // 当 doReconnect 与 poll 循环并发执行时（ws_closed 处理器的情况 ——
      // void 调用，不像 onEnvironmentLost 路径那样 await），onWorkReceived
      // 可能在 stopWork await 期间触发并设置新的 currentWorkId。如果发生
      // 了，说明 poll 循环已经自行恢复了 —— 让位给它，而不是继续去
      // archiveSession，那会把它新 transport 连着的 session 毁掉。
      if (currentWorkId !== workIdBeingCleared) {
        logForDebugging(
          '[bridge:repl] Poll loop recovered during stopWork await — deferring to it',
        )
        environmentRecreations = 0
        return true
      }
      currentWorkId = null
      currentIngressToken = null
    }

    // 如果在 await 期间开始了 teardown，就退出
    if (pollController.signal.aborted) {
      logForDebugging('[bridge:repl] Reconnect aborted by teardown')
      return false
    }

    // Strategy 1：用服务器下发的 env ID 做幂等 re-register。
    // 如果后端复活了同一个 env（新 secret），我们就能重连已有 session。
    // 如果它换了个不同的 ID，说明原 env 真没了，落到全新 session 分支。
    const requestedEnvId = environmentId
    bridgeConfig.reuseEnvironmentId = requestedEnvId
    try {
      const reg = await api.registerBridgeEnvironment(bridgeConfig)
      environmentId = reg.environment_id
      environmentSecret = reg.environment_secret
    } catch (err) {
      bridgeConfig.reuseEnvironmentId = undefined
      logForDebugging(
        `[bridge:repl] Environment re-registration failed: ${errorMessage(err)}`,
      )
      return false
    }
    // 任何 await 之前先清掉 —— 如果 doReconnect 再跑一次，残留值会污染
    // 下一次全新注册。
    bridgeConfig.reuseEnvironmentId = undefined

    logForDebugging(
      `[bridge:repl] Re-registered: requested=${requestedEnvId} got=${environmentId}`,
    )

    // 如果在注册期间开始了 teardown，就退出
    if (pollController.signal.aborted) {
      logForDebugging(
        '[bridge:repl] Reconnect aborted after env registration, cleaning up',
      )
      await api.deregisterEnvironment(environmentId).catch(() => {})
      return false
    }

    // 与上面相同的竞态，窗口更窄：poll 循环可能在 registerBridgeEnvironment
    // 的 await 期间就建好了 transport。在 tryReconnectInPlace/archiveSession
    // 把它在服务器侧杀掉之前先退出。
    if (transport !== null) {
      logForDebugging(
        '[bridge:repl] Poll loop recovered during registerBridgeEnvironment await — deferring to it',
      )
      environmentRecreations = 0
      return true
    }

    // Strategy 1：与 perpetual init 同一个辅助函数。成功时
    // currentSessionId 不变；mobile/web 上的 URL 仍然有效；
    // previouslyFlushedUUIDs 保留（不重新 flush）。
    if (await tryReconnectInPlace(requestedEnvId, currentSessionId)) {
      logEvent('tengu_bridge_repl_reconnected_in_place', {})
      environmentRecreations = 0
      return true
    }
    // Env 不同 → TTL 过期/被回收；或重连失败。
    // 不 deregister —— 不管怎样我们都拿到了这个 env 的新 secret。
    if (environmentId !== requestedEnvId) {
      logEvent('tengu_bridge_repl_env_expired_fresh_session', {})
    }

    // Strategy 2：在刚注册的 env 上创建全新 session。
    // 先归档旧 session —— 它已成孤儿（绑定到已死的 env，或 reconnectSession
    // 拒绝了它）。不要 deregister env —— 我们刚拿到新 secret，马上要用。
    await archiveSession(currentSessionId)

    // 如果在归档期间开始了 teardown，就退出
    if (pollController.signal.aborted) {
      logForDebugging(
        '[bridge:repl] Reconnect aborted after archive, cleaning up',
      )
      await api.deregisterEnvironment(environmentId).catch(() => {})
      return false
    }

    // 重新读取当前 title，以防用户给 session 改过名。
    // REPL 包装器读 session storage；daemon 包装器返回原始 title
    //（没什么可刷新的）。
    const currentTitle = getCurrentTitle()

    // 在刚注册的 env 上创建新 session
    const newSessionId = await createSession({
      environmentId,
      title: currentTitle,
      gitRepoUrl,
      branch,
      signal: AbortSignal.timeout(15_000),
    })

    if (!newSessionId) {
      logForDebugging(
        '[bridge:repl] Session creation failed during reconnection',
      )
      return false
    }

    // session 创建期间（最长 15s）若开始了 teardown，就退出
    if (pollController.signal.aborted) {
      logForDebugging(
        '[bridge:repl] Reconnect aborted after session creation, cleaning up',
      )
      await archiveSession(newSessionId)
      return false
    }

    currentSessionId = newSessionId
    // 重新发布到 PID 文件，让 peer 去重（peerRegistry.ts）拿到新 ID ——
    // setReplBridgeHandle 只在 init/teardown 时触发，重连不触发。
    void updateSessionBridgeId(toCompatSessionId(newSessionId)).catch(() => {})
    // session 切换之后立即重置 per-session transport 状态，在任何 await 之前。
    // 如果放到下面 `await writeBridgePointer` 之后，会出现一个窗口：
    // handle.bridgeSessionId 已经返回 session B，但 getSSESequenceNum() 还在
    // 返回 session A 的 seq —— 此时 daemon 的 persistState() 会写入
    // {bridgeSessionId: B, seq: OLD_A}，该数据能通过 session-ID 校验，
    // 使该校验完全失效。
    //
    // SSE seq-num 是 session 事件流范围内的 —— 把它带过来会让 transport
    // 的 lastSequenceNum 卡在高位（seq 仅在 received > last 时前进），下一
    // 次内部重连会带着 from_sequence_num=OLD_SEQ 去连一个从 1 开始的流 →
    // 中间的事件全部静默丢弃。Inbound UUID 去重也是 session 范围的。
    lastTransportSequenceNum = 0
    recentInboundUUIDs.clear()
    // 标题推导也是 session 范围的：如果用户在 createSession 的 await 期间
    // 输入了内容，回调针对的是旧归档 session ID（PATCH 丢失），而新
    // session 拿到的是他们输入之前捕获的 `currentTitle`。重置以让下一次
    // prompt 可以重新推导。自我修正：如果调用方的策略已经完成
    //（显式标题或 count ≥ 3），它在重置后的第一次调用会返回 true 并重新
    // 锁定。
    userMessageCallbackDone = !onUserMessage
    logForDebugging(`[bridge:repl] Re-created session: ${currentSessionId}`)

    // 用新 ID 重写崩溃恢复指针，这样此后的崩溃能恢复到正确的 session。
    //（上方的原地重连路径不动指针 —— 同一个 session、同一个 env。）
    await writeBridgePointer(dir, {
      sessionId: currentSessionId,
      environmentId,
      source: 'repl',
    })

    // 清掉已 flush 的 UUID，让 initial messages 重新发到新 session。
    // UUID 在服务器侧按 session 划分，重新 flush 是安全的。
    previouslyFlushedUUIDs?.clear()

    // 重置计数器，让相隔数小时的独立重连不会耗尽限制 —— 它防的是连续
    // 快速失败，而不是生命周期总数。
    environmentRecreations = 0

    return true
  }

  // 辅助：获取当前 OAuth access token 用于 session ingress 认证。
  // 与 JWT 路径不同，OAuth token 由标准 OAuth 流程刷新 —— 不需要主动
  // 调度器。
  function getOAuthToken(): string | undefined {
    return getAccessToken()
  }

  // 排空在 initial flush 期间排队的消息。在 writeBatch 完成（或失败）后
  // 调用，让排队消息按顺序排到历史消息之后。
  function drainFlushGate(): void {
    const msgs = flushGate.end()
    if (msgs.length === 0) return
    if (!transport) {
      logForDebugging(
        `[bridge:repl] Cannot drain ${msgs.length} pending message(s): no transport`,
      )
      return
    }
    for (const msg of msgs) {
      recentPostedUUIDs.add(msg.uuid)
    }
    const sdkMessages = toSDKMessages(msgs)
    const events: TransportMessage[] = sdkMessages.map(sdkMsg => ({
      ...sdkMsg,
      session_id: currentSessionId,
    })) as TransportMessage[]
    logForDebugging(
      `[bridge:repl] Drained ${msgs.length} pending message(s) after flush`,
    )
    void transport.writeBatch(events as StdoutMessage[])
  }

  // Teardown 引用 —— 在下面的定义之后赋值。所有调用方都是在赋值之后
  // 运行的 async 回调，所以引用总是有效。
  let doTeardownImpl: (() => Promise<void>) | null = null
  function triggerTeardown(): void {
    void doTeardownImpl?.()
  }

  /**
   * transport setOnClose 回调的主体，提升到 initBridgeCore 作用域，
   * 以便 /bridge-kick 能直接触发。setOnClose 用过期 transport 守卫包裹
   * 它；debugFireClose 直接裸调。
   *
   * autoReconnect:true 时，只在以下情况触发：干净关闭（1000）、永久
   * 服务器拒绝（4001/1002/4003）、或 10 分钟预算耗尽。瞬时断开由
   * transport 内部重试。
   */
  function handleTransportPermanentClose(closeCode: number | undefined): void {
    rcLog(
      `handleTransportPermanentClose: code=${closeCode}` +
        ` transport=${transport ? 'exists' : 'null'}` +
        ` pollAborted=${pollController.signal.aborted}`,
    )
    logForDebugging(
      `[bridge:repl] Transport permanently closed: code=${closeCode}`,
    )
    logEvent('tengu_bridge_repl_ws_closed', {
      code: closeCode,
    })
    // 置空之前捕获 SSE seq 高水位线。从 setOnClose 调用时，守卫保证
    // transport !== null；从 /bridge-kick 触发时它可能已经是 null
    //（例如被触发两次）—— 跳过。
    if (transport) {
      const closedSeq = transport.getLastSequenceNum()
      if (closedSeq > lastTransportSequenceNum) {
        lastTransportSequenceNum = closedSeq
      }
      transport = null
    }
    // transport 没了 —— 把 poll 循环从 at-capacity heartbeat sleep 中
    // 唤醒，让它在下面的重连完成、服务器重新派发 work 之前就开始快速
    // poll。
    wakePollLoop()
    // 重置 flush 状态，让 writeMessages() 命中 !transport 守卫
    //（带一条警告日志），而不是静默地把消息塞进一个永远不会被排空的
    // 缓冲。与 onWorkReceived（会为新 transport 保留 pending 消息）不同，
    // onClose 是永久关闭 —— 没有新 transport 来排空这些消息。
    const dropped = flushGate.drop()
    if (dropped > 0) {
      logForDebugging(
        `[bridge:repl] Dropping ${dropped} pending message(s) on transport close (code=${closeCode})`,
        { level: 'warn' },
      )
    }

    if (closeCode === 1000) {
      // 干净关闭 —— session 正常结束。Teardown 掉 bridge。
      onStateChange?.('failed', 'session ended')
      pollController.abort()
      triggerTeardown()
      return
    }

    // transport 重连预算耗尽或服务器永久拒绝。到这一步 env 通常已经被
    // 服务器回收（BQ 2026-03-12：约 98% 的 ws_closed 永远无法只靠 poll
    // 恢复）。stopWork(force=false) 无法从已归档 env 重新派发 work；
    // reconnectEnvironmentWithSession 能通过 POST /bridge/reconnect 重新
    // 激活它，或在 env 真没了时落到全新 session。poll 循环（上面已唤醒）
    // 在 doReconnect 完成后会把重新入队的 work 接走。
    onStateChange?.(
      'reconnecting',
      `Remote Control connection lost (code ${closeCode})`,
    )
    logForDebugging(
      `[bridge:repl] Transport reconnect budget exhausted (code=${closeCode}), attempting env reconnect`,
    )
    void reconnectEnvironmentWithSession().then(success => {
      if (success) return
      // doReconnect 有四个"teardown 进行中"导致的 abort-check
      // return-false 位置。用户刚退出时不要污染 BQ 失败信号，也不要重复
      // teardown。
      if (pollController.signal.aborted) return
      // doReconnect 在真实失败时返回 false（从不抛异常）。危险的场景是：
      // registerBridgeEnvironment 成功了（environmentId 已指向一个全新有效
      // env），但 createSession 失败 —— poll 循环会在一个无 session 的 env
      // 上 poll 到 null work，没有错误，永远走不到任何 give-up 路径。
      // 显式 teardown。
      logForDebugging(
        '[bridge:repl] reconnectEnvironmentWithSession resolved false — tearing down',
      )
      logEvent('tengu_bridge_repl_reconnect_failed', {
        close_code: closeCode,
      })
      onStateChange?.('failed', 'reconnection failed')
      triggerTeardown()
    })
  }

  // 仅 ant：SIGUSR2 → 强制 doReconnect()，用于手动测试。跳过约 30s 的
  // poll 等待 —— 立即触发并在 debug 日志里观察。Windows 没有 USR 信号；
  // 在那里 `process.on` 会抛异常。
  let sigusr2Handler: (() => void) | undefined
  if (process.env.USER_TYPE === 'ant' && process.platform !== 'win32') {
    sigusr2Handler = () => {
      logForDebugging(
        '[bridge:repl] SIGUSR2 received — forcing doReconnect() for testing',
      )
      void reconnectEnvironmentWithSession()
    }
    process.on('SIGUSR2', sigusr2Handler)
  }

  // 仅 ant：/bridge-kick 故障注入。handleTransportPermanentClose 在下方
  // 定义，并被赋到这个槽里，让 slash command 能直接触发 —— 真正的
  // setOnClose 回调深埋在 wireTransport 里，而 wireTransport 本身又嵌在
  // onWorkReceived 里。
  let debugFireClose: ((code: number) => void) | null = null
  if (process.env.USER_TYPE === 'ant') {
    registerBridgeDebugHandle({
      fireClose: code => {
        if (!debugFireClose) {
          logForDebugging('[bridge:debug] fireClose: no transport wired yet')
          return
        }
        logForDebugging(`[bridge:debug] fireClose(${code}) — injecting`)
        debugFireClose(code)
      },
      forceReconnect: () => {
        logForDebugging('[bridge:debug] forceReconnect — injecting')
        void reconnectEnvironmentWithSession()
      },
      injectFault: injectBridgeFault,
      wakePollLoop,
      describe: () =>
        `env=${environmentId} session=${currentSessionId} transport=${transport?.getStateLabel() ?? 'null'} workId=${currentWorkId ?? 'null'}`,
    })
  }

  const pollOpts = {
    api,
    getCredentials: () => ({ environmentId, environmentSecret }),
    signal: pollController.signal,
    getPollIntervalConfig,
    onStateChange,
    getWsState: () => transport?.getStateLabel() ?? 'null',
    // REPL bridge 是单 session：只要有 transport 就是 at capacity。
    // 没必要检查 isConnectedStatus() —— 即使 transport 正在内部自动重连
    //（最长 10 分钟），poll 也只是心跳。
    isAtCapacity: () => transport !== null,
    capacitySignal,
    onFatalError: triggerTeardown,
    getHeartbeatInfo: () => {
      if (!currentWorkId || !currentIngressToken) {
        return null
      }
      return {
        environmentId,
        workId: currentWorkId,
        sessionToken: currentIngressToken,
      }
    },
    // Work-item JWT 过期（或 work 没了）。transport 无用 —— SSE 重连和
    // CCR 写入用的都是同一个过期 token。没这个回调的话，poll 循环会做
    // 一次 10 分钟的 at-capacity 退避，期间 work lease（300s TTL）过期，
    // 服务器不再转发 prompt → daemon 日志里观察到约 25 分钟的死窗口。
    // 杀掉 transport 和 work 状态，让 isAtCapacity()=false；循环快速
    // poll，几秒内拿到服务器重新派发的 work。
    onHeartbeatFatal: (err: BridgeFatalError) => {
      logForDebugging(
        `[bridge:repl] heartbeatWork fatal (status=${err.status}) — tearing down work item for fast re-dispatch`,
      )
      if (transport) {
        const seq = transport.getLastSequenceNum()
        if (seq > lastTransportSequenceNum) {
          lastTransportSequenceNum = seq
        }
        transport.close()
        transport = null
      }
      flushGate.drop()
      // force=false → 服务器重新入队。多半已过期，但这是幂等的，
      // 如果没过期则能让重新派发立即生效。
      if (currentWorkId) {
        void api
          .stopWork(environmentId, currentWorkId, false)
          .catch((e: unknown) => {
            logForDebugging(
              `[bridge:repl] stopWork after heartbeat fatal: ${errorMessage(e)}`,
            )
          })
      }
      currentWorkId = null
      currentIngressToken = null
      wakePollLoop()
      onStateChange?.(
        'reconnecting',
        'Work item lease expired, fetching fresh token',
      )
    },
    async onEnvironmentLost() {
      const success = await reconnectEnvironmentWithSession()
      if (!success) {
        return null
      }
      return { environmentId, environmentSecret }
    },
    onWorkReceived: (
      workSessionId: string,
      ingressToken: string,
      workId: string,
      serverUseCcrV2: boolean,
    ) => {
      // 当 transport 已打开时又来新 work，说明服务器决定重新派发
      //（例如 token 轮换、服务器重启）。关闭现有 transport 并重连 ——
      // 丢弃 work 会在旧 WS 随后挂掉时陷入卡死的 'reconnecting' 状态
      //（服务器不会重新派发它已经投递过的 work item）。
      // ingressToken（JWT）用于 heartbeat 认证（v1 和 v2 都用）。
      // transport 认证不同 —— 见下文 v1/v2 分支。
      if (transport?.isConnectedStatus()) {
        logForDebugging(
          `[bridge:repl] Work received while transport connected, replacing with fresh token (workId=${workId})`,
        )
      }

      logForDebugging(
        `[bridge:repl] Work received: workId=${workId} workSessionId=${workSessionId} currentSessionId=${currentSessionId} match=${sameSessionId(workSessionId, currentSessionId)}`,
      )

      // 刷新崩溃恢复指针的 mtime。过期检查看的是文件 mtime（不是嵌入的
      // 时间戳），所以这次重写会刷新时钟 —— 一个 5 小时以上又崩溃的
      // session 仍然有新鲜指针。每次 work 派发触发一次（不频繁 —— 受用户
      // 消息速率限制）。
      void writeBridgePointer(dir, {
        sessionId: currentSessionId,
        environmentId,
        source: 'repl',
      })

      // 拒绝外部 session ID —— 服务器不应该把其他 env 的 session 派发
      // 给我们。因为我们总是成对创建 env+session，不匹配说明服务器侧
      // 出现了意外的重新指派。
      //
      // 按底层 UUID 比较，而不是带 tag 的前缀。当 CCR v2 的 compat 层
      // 服务该 session 时，createBridgeSession 从面向 v1 的 API 拿到
      // session_*（compat/convert.go:41），但基础设施层在 work 队列里
      // 投递 cse_*（container_manager.go:129）。同一个 UUID，不同 tag。
      if (!sameSessionId(workSessionId, currentSessionId)) {
        logForDebugging(
          `[bridge:repl] Rejecting foreign session: expected=${currentSessionId} got=${workSessionId}`,
        )
        return
      }

      currentWorkId = workId
      currentIngressToken = ingressToken

      // 服务器按 session 决定（work secret 里的 secret.use_code_sessions，
      // 通过 runWorkPollLoop 透传）。环境变量是 ant 开发覆盖，用于在
      // 服务器 flag 对你打开之前强制 v2 —— 需要服务器侧 ccr_v2_compat_enabled
      // 打开，否则 registerWorker 会 404。
      //
      // 与 CLAUDE_CODE_USE_CCR_V2（sessionRunner/environment-manager 设置
      // 的子 SDK transport 选择器）保持独立，避免 spawn 模式下的继承风险：
      // 父进程的 orchestrator 变量会泄漏到 v1 子进程。
      const useCcrV2 =
        serverUseCcrV2 || isEnvTruthy(process.env.CLAUDE_BRIDGE_USE_CCR_V2)

      // 认证是 v1 和 v2 唯一严重分歧的地方：
      //
      // - v1（Session-Ingress）：接受 OAuth 或 JWT。我们优先用 OAuth，
      //   因为标准 OAuth 刷新流程能处理过期 —— 不需要独立的 JWT 刷新
      //   调度器。
      //
      // - v2（CCR /worker/*）：必须用 JWT。register_worker.go:32 会校验
      //   session_id claim，OAuth token 不带这个 claim。work secret 里的
      //   JWT 同时带这个 claim 和 worker 角色
      //   （environment_auth.py:856）。JWT 刷新：过期时服务器会带着
      //   新的 JWT 重新派发 work，onWorkReceived 再次触发。
      //   createV2ReplTransport 在接触网络之前通过
      //   updateSessionIngressAuthToken() 把它存起来。
      let v1OauthToken: string | undefined
      if (!useCcrV2) {
        v1OauthToken = getOAuthToken()
        if (!v1OauthToken) {
          logForDebugging(
            '[bridge:repl] No OAuth token available for session ingress, skipping work',
          )
          return
        }
        updateSessionIngressAuthToken(v1OauthToken)
      }
      logEvent('tengu_bridge_repl_work_received', {})

      // 关闭上一个 transport。close() 之前先置空，让 close 回调不会把
      // 编程式关闭当成"session 正常结束"而触发完整 teardown。
      if (transport) {
        const oldTransport = transport
        transport = null
        // 捕获 SSE 序列高水位线，让下一个 transport 能从流的位置继续，
        // 而不是从 seq 0 重放。用 max() —— 一个早夭的 transport
        //（从未收到任何 frame）会让一个非零水位线被重置回 0。
        const oldSeq = oldTransport.getLastSequenceNum()
        if (oldSeq > lastTransportSequenceNum) {
          lastTransportSequenceNum = oldSeq
        }
        oldTransport.close()
      }
      // 重置 flush 状态 —— 旧的 flush（如果有）不再相关。保留 pending
      // 消息，让它们在新 transport 的 flush 完成后排空（hook 已经推进
      // lastWrittenIndex，不会重发它们）。
      flushGate.deactivate()

      // 对共享的 handleServerControlRequest 的闭包适配 —— 捕获
      // transport/currentSessionId，让下面的 transport.setOnData 回调
      // 不必把它们透传进去。
      const onServerControlRequest = (request: SDKControlRequest): void =>
        handleServerControlRequest(request, {
          transport,
          sessionId: currentSessionId,
          onInterrupt,
          onSetModel,
          onSetMaxThinkingTokens,
          onSetPermissionMode,
        })

      let initialFlushDone = false

      // 在新构造的 transport 上接好回调并连接。抽出来是为了让（同步的）
      // v1 和（异步的）v2 构造路径共用同一套回调和 flush 机制。
      const wireTransport = (newTransport: ReplBridgeTransport): void => {
        transport = newTransport

        newTransport.setOnConnect(() => {
          // 守卫：如果 WS 正在连接时 transport 被更新的 onWorkReceived
          // 调用替换掉了，忽略这个过期回调。
          if (transport !== newTransport) return

          logForDebugging('[bridge:repl] Ingress transport connected')
          logEvent('tengu_bridge_repl_ws_connected', {})

          // 用最新的 OAuth token 更新环境变量，让 POST 写入
          //（通过 getSessionIngressAuthToken() 读取）用上新鲜的 token。
          // v2 跳过这步 —— createV2ReplTransport 已经把 JWT 存好了，
          // 用 OAuth 覆盖会破坏后续 /worker/* 请求（session_id claim
          // 校验）。
          if (!useCcrV2) {
            const freshToken = getOAuthToken()
            if (freshToken) {
              updateSessionIngressAuthToken(freshToken)
            }
          }

          // 重置 teardownStarted，让后续 teardown 不被阻塞。
          teardownStarted = false

          // 只在第一次 connect 时 flush initial messages，不是每次 WS
          // 重连都 flush。重复 flush 会导致消息重复。
          // 重要：onStateChange('connected') 延迟到 flush 完成才触发。
          // 这能防止 writeMessages() 发送的新消息在服务器上与历史消息
          // 交错，并延迟 web UI 显示 session 活跃直到历史落库。
          if (
            !initialFlushDone &&
            initialMessages &&
            initialMessages.length > 0
          ) {
            initialFlushDone = true

            // 把 initial flush 限制到最近 N 条。完整历史只用于 UI
            //（模型看不到），大量重放会让 session-ingress 持久化变慢
            //（每个事件都是一次 threadstore 写入），并加大 Firestore
            // 压力。cap 为 0 或负数则禁用该限制。
            const historyCap = initialHistoryCap
            const eligibleMessages = initialMessages.filter(
              m =>
                isEligibleBridgeMessage(m) &&
                !previouslyFlushedUUIDs?.has(m.uuid),
            )
            const cappedMessages =
              historyCap > 0 && eligibleMessages.length > historyCap
                ? eligibleMessages.slice(-historyCap)
                : eligibleMessages
            if (cappedMessages.length < eligibleMessages.length) {
              logForDebugging(
                `[bridge:repl] Capped initial flush: ${eligibleMessages.length} -> ${cappedMessages.length} (cap=${historyCap})`,
              )
              logEvent('tengu_bridge_repl_history_capped', {
                eligible_count: eligibleMessages.length,
                capped_count: cappedMessages.length,
              })
            }
            const sdkMessages = toSDKMessages(cappedMessages)
            if (sdkMessages.length > 0) {
              logForDebugging(
                `[bridge:repl] Flushing ${sdkMessages.length} initial message(s) via transport`,
              )
              const events: TransportMessage[] = sdkMessages.map(sdkMsg => ({
                ...sdkMsg,
                session_id: currentSessionId,
              })) as TransportMessage[]
              const dropsBefore = newTransport.droppedBatchCount
              void newTransport
                .writeBatch(events as StdoutMessage[])
                .then(() => {
                  // 如果 flush 期间有批次被丢弃（SI 宕机达到
                  // maxConsecutiveFailures 次数），flush() 仍会正常 resolve，
                  // 但事件实际没送达。不要把 UUID 标记为 flushed —— 让它们
                  // 在下次 onWorkReceived 时仍可重发（JWT 刷新重新派发，
                  // 约在 1144 行）。
                  if (newTransport.droppedBatchCount > dropsBefore) {
                    logForDebugging(
                      `[bridge:repl] Initial flush dropped ${newTransport.droppedBatchCount - dropsBefore} batch(es) — not marking ${sdkMessages.length} UUID(s) as flushed`,
                    )
                    return
                  }
                  if (previouslyFlushedUUIDs) {
                    for (const sdkMsg of sdkMessages) {
                      if (sdkMsg.uuid) {
                        previouslyFlushedUUIDs.add(sdkMsg.uuid as string)
                      }
                    }
                  }
                })
                .catch(e =>
                  logForDebugging(`[bridge:repl] Initial flush failed: ${e}`),
                )
                .finally(() => {
                  // 守卫：如果 flush 期间 transport 被替换，不要发
                  // connected 信号也不要排空 —— 新 transport 接管生命
                  // 周期。
                  if (transport !== newTransport) return
                  drainFlushGate()
                  onStateChange?.('connected')
                })
            } else {
              // 所有 initial messages 已经 flush 过（被 previouslyFlushedUUIDs
              // 过滤掉）。不需要 flush POST —— 清标志并立即发 connected 信号。
              // 这是该 transport 的首次连接（在 !initialFlushDone 内），
              // 所以没有在途的 flush POST —— 标志在 connect() 之前设置，
              // 必须在这里清掉。
              drainFlushGate()
              onStateChange?.('connected')
            }
          } else if (!flushGate.active) {
            // 无 initial messages，或首次连接时已 flush。WS 自动重连路径
            // —— 只在没有在途 flush POST 时发 connected 信号。如果有，
            // .finally() 接管生命周期。
            onStateChange?.('connected')
          }
        })

        newTransport.setOnData(data => {
          try {
            const parsed = JSON.parse(data)
            rcLog(
              `ingress: type=${parsed.type}` +
                `${parsed.type === 'control_request' ? ` subtype=${(parsed.request as Record<string, unknown>)?.subtype} request_id=${parsed.request_id}` : ''}` +
                `${parsed.type === 'control_response' ? ` subtype=${(parsed.response as Record<string, unknown>)?.subtype} request_id=${(parsed.response as Record<string, unknown>)?.request_id}` : ''}` +
                `${parsed.type === 'user' ? ` uuid=${parsed.uuid}` : ''}` +
                `${parsed.type === 'keep_alive' ? '' : ` len=${data.length}`}`,
            )
          } catch {
            rcLog(`ingress (non-JSON): ${String(data).slice(0, 200)}`)
          }
          handleIngressMessage(
            data,
            recentPostedUUIDs,
            recentInboundUUIDs,
            onInboundMessage,
            onPermissionResponse,
            onServerControlRequest,
          )
        })

        // 主体位于 initBridgeCore 作用域，让 /bridge-kick 能通过
        // debugFireClose 直接调用。所有被引用的闭包（transport、
        // wakePollLoop、flushGate、reconnectEnvironmentWithSession 等）都
        // 已在该作用域。对 wireTransport 仅有的词法依赖是
        // `newTransport.getLastSequenceNum()` —— 但下面的守卫通过后
        // 我们知道 transport === newTransport。
        debugFireClose = handleTransportPermanentClose
        newTransport.setOnClose(closeCode => {
          // 守卫：如果 transport 被替换，忽略过期 close。
          if (transport !== newTransport) return
          rcLog(
            `transport onClose: code=${closeCode}` +
              ` connected=${newTransport.isConnectedStatus()}` +
              ` state=${newTransport.getStateLabel()}` +
              ` seq=${newTransport.getLastSequenceNum()}`,
          )
          handleTransportPermanentClose(closeCode)
        })

        // 在 connect() 之前启动 flush gate，覆盖 WS 握手窗口。在 transport
        // 赋值与 setOnConnect 触发之间，writeMessages() 可能在 initial
        // flush 开始之前就通过 HTTP POST 发送消息。在这里启动 gate 能确保
        // 这些调用被排队。如果没有 initial messages，gate 保持非激活。
        if (
          !initialFlushDone &&
          initialMessages &&
          initialMessages.length > 0
        ) {
          flushGate.start()
        }

        newTransport.connect()
      } // wireTransport 结束

      // 无条件自增 —— 任何新 transport（v1 或 v2）都会让在途的 v2 握手
      // 失效。doReconnect() 里也会自增。
      v2Generation++

      if (useCcrV2) {
        // workSessionId 是 cse_* 形式（来自 work 队列的基础设施层 ID），
        // 正是 /v1/code/sessions/{id}/worker/* 想要的。
        // session_* 形式（currentSessionId）在这里不能用 ——
        // handler/convert.go:30 会校验 TagCodeSession。
        const sessionUrl = buildCCRv2SdkUrl(baseUrl, workSessionId)
        const thisGen = v2Generation
        logForDebugging(
          `[bridge:repl] CCR v2: sessionUrl=${sessionUrl} session=${workSessionId} gen=${thisGen}`,
        )
        void createV2ReplTransport({
          sessionUrl,
          ingressToken,
          sessionId: workSessionId,
          initialSequenceNum: lastTransportSequenceNum,
        }).then(
          t => {
            // registerWorker 在途期间开始了 teardown。Teardown 看到
            // transport === null 就跳过了 close()；这里安装会泄漏
            // CCRClient heartbeat 定时器，并通过 wireTransport 的副作用
            // 重置 teardownStarted。
            if (pollController.signal.aborted) {
              t.close()
              return
            }
            // registerWorker() 在途期间 onWorkReceived 可能再次触发
            //（服务器用新 JWT 重新派发）。transport !== null 单独判断会
            // 出竞态错误：两次尝试都看到 transport === null 时，它会保留
            // 第一个 resolver（过期 epoch），丢弃第二个（正确 epoch）。
            // generation 检查能不依赖 transport 状态抓到这种情况。
            if (thisGen !== v2Generation) {
              logForDebugging(
                `[bridge:repl] CCR v2: discarding stale handshake gen=${thisGen} current=${v2Generation}`,
              )
              t.close()
              return
            }
            wireTransport(t)
          },
          (err: unknown) => {
            logForDebugging(
              `[bridge:repl] CCR v2: createV2ReplTransport failed: ${errorMessage(err)}`,
              { level: 'error' },
            )
            logEvent('tengu_bridge_repl_ccr_v2_init_failed', {})
            // 如果更新的尝试在途或已成功，不要碰它的 work item ——
            // 我们的失败无关紧要。
            if (thisGen !== v2Generation) return
            // 释放 work item，让服务器立即重新派发，而不是等自己的超时。
            // currentWorkId 上面已设；不这样做的话，用户看 session 会卡住。
            if (currentWorkId) {
              void api
                .stopWork(environmentId, currentWorkId, false)
                .catch((e: unknown) => {
                  logForDebugging(
                    `[bridge:repl] stopWork after v2 init failure: ${errorMessage(e)}`,
                  )
                })
              currentWorkId = null
              currentIngressToken = null
            }
            wakePollLoop()
          },
        )
      } else {
        // v1：HybridTransport（WS 读 + POST 写到 Session-Ingress）。
        // autoReconnect 为 true（默认）—— WS 死掉时，transport 用指数退避
        // 自动重连。重连期间 POST 写入继续（它用
        // getSessionIngressAuthToken()，独立于 WS 状态）。如果重连预算
        // 耗尽（10 分钟），poll 循环作为二级兜底。
        //
        // 认证：直接用 OAuth token，而不是 work secret 里的 JWT。
        // refreshHeaders 会在每次 WS 重连尝试时取最新 OAuth token。
        const wsUrl = buildSdkUrl(sessionIngressUrl, workSessionId)
        logForDebugging(`[bridge:repl] Ingress URL: ${wsUrl}`)
        logForDebugging(
          `[bridge:repl] Creating HybridTransport: session=${workSessionId}`,
        )
        // v1OauthToken 上面已校验非空（否则早就 return 了）。
        const oauthToken = v1OauthToken ?? ''
        wireTransport(
          createV1ReplTransport(
            new HybridTransport(
              new URL(wsUrl),
              {
                Authorization: `Bearer ${oauthToken}`,
                'anthropic-version': '2023-06-01',
              },
              workSessionId,
              () => ({
                Authorization: `Bearer ${getOAuthToken() ?? oauthToken}`,
                'anthropic-version': '2023-06-01',
              }),
              // 给重试次数封顶，避免一个持续失败的 session-ingress 把
              // uploader 排空循环钉死在 bridge 的整个生命周期上。
              // 50 次 ≈ 20 分钟（稳态下每轮 15s POST 超时 + 8s 退避 +
              // 抖动）。仅 bridge —— 1P 保持无限重试。
              {
                maxConsecutiveFailures: 50,
                isBridge: true,
                onBatchDropped: () => {
                  onStateChange?.(
                    'reconnecting',
                    'Lost sync with Remote Control — events could not be delivered',
                  )
                  // SI 已经宕机约 20 分钟。唤醒 poll 循环，让 SI 恢复后：
                  // 下一次 poll → onWorkReceived → 全新 transport →
                  // initial flush 成功 → 约 1420 行 onStateChange('connected')。
                  // 不做这步，SI 恢复后状态仍是 'reconnecting' ——
                  // daemon.ts:437 拒绝所有权限，useReplBridge.ts:311 保持
                  // replBridgeSessionActive=false。如果宕机期间 env 被归档，
                  // poll 404 → onEnvironmentLost 恢复路径会处理。
                  wakePollLoop()
                },
              },
            ),
          ),
        )
      }
    },
  }
  void startWorkPollLoop(pollOpts)

  // Perpetual 模式：每小时刷新崩溃恢复指针的 mtime。onWorkReceived 的
  // 刷新只按用户 prompt 触发 —— 一个空闲超过 4 小时的 daemon 指针会过期，
  // 下次重启会清掉它（readBridgePointer TTL 检查）→ 全新 session。
  // Standalone bridge（bridgeMain.ts）也有相同的每小时定时器。
  const pointerRefreshTimer = perpetual
    ? setInterval(() => {
        // doReconnect() 非原子地重新赋值 currentSessionId/environmentId
        //（env 在约 :634，session 在约 :719，中间有 await）。如果这个
        // 定时器在那个窗口里触发，它的 fire-and-forget 写入可能与
        // doReconnect 自己在约 :740 的指针写入竞态（并覆盖），让指针停在
        // 现在已归档的旧 session 上。doReconnect 自己会写指针，这里跳过
        // 零成本。
        if (reconnectPromise) return
        void writeBridgePointer(dir, {
          sessionId: currentSessionId,
          environmentId,
          source: 'repl',
        })
      }, 60 * 60_000)
    : null
  pointerRefreshTimer?.unref?.()

  // 按固定间隔推一个静默 keep_alive 帧，避免上游代理和 session-ingress
  // 层把一个本来空闲的 remote control session GC 掉。keep_alive 类型在
  // 到达任何客户端 UI 之前就被过滤掉（Query.ts 丢弃它；
  // web/iOS/Android 的消息循环里永远看不到）。间隔来自 GrowthBook
  //（tengu_bridge_poll_interval_config 的
  // session_keepalive_interval_v2_ms，默认 120s）；0 = 禁用。
  const keepAliveIntervalMs =
    getPollIntervalConfig().session_keepalive_interval_v2_ms
  const keepAliveTimer =
    keepAliveIntervalMs > 0
      ? setInterval(() => {
          if (!transport) return
          logForDebugging('[bridge:repl] keep_alive sent')
          void transport.write({ type: 'keep_alive' }).catch((err: unknown) => {
            logForDebugging(
              `[bridge:repl] keep_alive write failed: ${errorMessage(err)}`,
            )
          })
        }, keepAliveIntervalMs)
      : null
  keepAliveTimer?.unref?.()

  // cleanup 注册和返回 handle 上的显式 teardown() 方法共用的 teardown
  // 序列。
  let teardownStarted = false
  doTeardownImpl = async (): Promise<void> => {
    if (teardownStarted) {
      logForDebugging(
        `[bridge:repl] Teardown already in progress, skipping duplicate call env=${environmentId} session=${currentSessionId}`,
      )
      return
    }
    teardownStarted = true
    const teardownStart = Date.now()
    logForDebugging(
      `[bridge:repl] Teardown starting: env=${environmentId} session=${currentSessionId} workId=${currentWorkId ?? 'none'} transportState=${transport?.getStateLabel() ?? 'null'}`,
    )

    if (pointerRefreshTimer !== null) {
      clearInterval(pointerRefreshTimer)
    }
    if (keepAliveTimer !== null) {
      clearInterval(keepAliveTimer)
    }
    if (sigusr2Handler) {
      process.off('SIGUSR2', sigusr2Handler)
    }
    if (process.env.USER_TYPE === 'ant') {
      clearBridgeDebugHandle()
      debugFireClose = null
    }
    pollController.abort()
    logForDebugging('[bridge:repl] Teardown: poll loop aborted')

    // 在 close() 之前抓取活 transport 的 seq —— close() 是同步的
    //（只是 abort SSE fetch），不会触发 onClose，所以 setOnClose 的抓取
    // 路径在显式 teardown 时永远跑不到。不做这步的话，teardown 之后
    // getSSESequenceNum() 会返回 stale 的 lastTransportSequenceNum（上一次
    // transport 切换时抓的），持久化这个值的 daemon 调用方会丢失从那以后
    // 的所有事件。
    if (transport) {
      const finalSeq = transport.getLastSequenceNum()
      if (finalSeq > lastTransportSequenceNum) {
        lastTransportSequenceNum = finalSeq
      }
    }

    if (perpetual) {
      // Perpetual 的 teardown 是纯本地的 —— 不发 result，不调 stopWork，
      // 不关 transport。这些都意味着向服务器（以及 mobile/attach 订阅方）
      // 发"session 即将结束"的信号。改为：停止 polling，让 socket 随进程
      // 退出而死；后端会自行把 work-item lease 超时回到 pending
      //（TTL 300s）。下次 daemon 启动读指针，reconnectSession 把 work 重新
      // 入队。
      transport = null
      flushGate.drop()
      // 刷新指针 mtime，让超过 BRIDGE_POINTER_TTL_MS（4h）的 session 在
      // 下次启动时不显示为过期。
      await writeBridgePointer(dir, {
        sessionId: currentSessionId,
        environmentId,
        source: 'repl',
      })
      logForDebugging(
        `[bridge:repl] Teardown (perpetual): leaving env=${environmentId} session=${currentSessionId} alive on server, duration=${Date.now() - teardownStart}ms`,
      )
      return
    }

    // 先发 result 消息，再 archive，最后 close。transport.write() 只是入队
    //（SerialBatchEventUploader 在 buffer-add 时就 resolve）；stopWork/archive
    // 的延迟（约 200-500ms）就是 result POST 的排空窗口。先 archive 再
    // close 等于依赖 HybridTransport 那个 void 的 3s 宽限期，但没人 await
    // 它 —— forceExit 可能在 POST 中途杀掉 socket。与 remoteBridgeCore.ts
    // 的 teardown（#22803）同样的重排序。
    const teardownTransport = transport
    transport = null
    flushGate.drop()
    if (teardownTransport) {
      const resultMsg = {
        ...makeResultMessage(currentSessionId),
        session_id: currentSessionId,
      } as unknown as TransportMessage
      void teardownTransport.write(resultMsg as StdoutMessage)
    }

    const stopWorkP = currentWorkId
      ? api
          .stopWork(environmentId, currentWorkId, true)
          .then(() => {
            logForDebugging('[bridge:repl] Teardown: stopWork completed')
          })
          .catch((err: unknown) => {
            logForDebugging(
              `[bridge:repl] Teardown stopWork failed: ${errorMessage(err)}`,
            )
          })
      : Promise.resolve()

    // 并行运行 stopWork 和 archiveSession。gracefulShutdown.ts:407 让
    // runCleanupFunctions() 与 2s 赛跑（不是 5s 外层保险），所以 archive 在
    // 注入点被钳到 1.5s 以保持在预算内。archiveSession 契约上 no-throw；
    // 注入的实现自己记成功/失败日志。
    await Promise.all([stopWorkP, archiveSession(currentSessionId)])

    teardownTransport?.close()
    logForDebugging('[bridge:repl] Teardown: transport closed')

    await api.deregisterEnvironment(environmentId).catch((err: unknown) => {
      logForDebugging(
        `[bridge:repl] Teardown deregister failed: ${errorMessage(err)}`,
      )
    })

    // 清掉崩溃恢复指针 —— 显式断开或干净 REPL 退出意味着用户已经结束
    // 这个 session。崩溃/kill-9 永远到不了这一行，把指针留给下次启动恢复。
    await clearBridgePointer(dir)

    logForDebugging(
      `[bridge:repl] Teardown complete: env=${environmentId} duration=${Date.now() - teardownStart}ms`,
    )
  }

  // 8. 为优雅关闭注册 cleanup
  const unregister = registerCleanup(() => doTeardownImpl?.())

  logForDebugging(
    `[bridge:repl] Ready: env=${environmentId} session=${currentSessionId}`,
  )
  onStateChange?.('ready')

  return {
    get bridgeSessionId() {
      return currentSessionId
    },
    get environmentId() {
      return environmentId
    },
    getSSESequenceNum() {
      // lastTransportSequenceNum 只在 transport 被关闭时（切换/onClose 时
      // 捕获）才更新。正常运行期间，当前 transport 的实时 seq 不会反映
      // 到这里。把两者合并，让调用方（如 daemon 的 persistState()）拿到
      // 真正的高水位线。
      const live = transport?.getLastSequenceNum() ?? 0
      return Math.max(lastTransportSequenceNum, live)
    },
    sessionIngressUrl,
    writeMessages(messages) {
      // 过滤出尚未发送过的 user/assistant 消息。两层去重：
      //  - initialMessageUUIDs：作为 session creation 事件发送过的消息
      //  - recentPostedUUIDs：最近通过 POST 发送过的消息
      const filtered = messages.filter(
        m =>
          isEligibleBridgeMessage(m) &&
          !initialMessageUUIDs.has(m.uuid) &&
          !recentPostedUUIDs.has(m.uuid),
      )
      if (filtered.length === 0) return

      // 触发 onUserMessage 推导标题。在 flushGate 检查之前扫描 —— 即使
      // prompt 排在 initial 历史 flush 之后，它仍然有资格当标题。对每条
      // 有资格当标题的消息都调，直到回调返回 true；策略由调用方决定。
      if (!userMessageCallbackDone) {
        for (const m of filtered) {
          const text = extractTitleText(m)
          if (text !== undefined && onUserMessage?.(text, currentSessionId)) {
            userMessageCallbackDone = true
            break
          }
        }
      }

      // initial flush 进行期间把消息排队，避免它们在服务器上与历史消息
      // 交错到达。
      if (flushGate.enqueue(...filtered)) {
        logForDebugging(
          `[bridge:repl] Queued ${filtered.length} message(s) during initial flush`,
        )
        return
      }

      if (!transport) {
        const types = filtered.map(m => m.type).join(',')
        logForDebugging(
          `[bridge:repl] Transport not configured, dropping ${filtered.length} message(s) [${types}] for session=${currentSessionId}`,
          { level: 'warn' },
        )
        return
      }

      // 在有界环形缓冲中追踪，用于 echo 过滤和去重。
      for (const msg of filtered) {
        recentPostedUUIDs.add(msg.uuid)
      }

      logForDebugging(
        `[bridge:repl] Sending ${filtered.length} message(s) via transport`,
      )

      // 转成 SDK 格式并通过 HTTP POST 发送（HybridTransport）。
      // web UI 通过 subscribe WebSocket 接收。
      const sdkMessages = toSDKMessages(filtered)
      const events: TransportMessage[] = sdkMessages.map(sdkMsg => ({
        ...sdkMsg,
        session_id: currentSessionId,
      })) as TransportMessage[]
      void transport.writeBatch(events as StdoutMessage[])
    },
    writeSdkMessages(messages) {
      // Daemon 路径：query() 已经产出 SDKMessage，跳过转换。
      // 仍然做 echo 去重（服务器会在 WS 上把写入回弹回来）。
      // 没有 initialMessageUUIDs 过滤 —— daemon 没有 initial messages。
      // 没有 flushGate —— daemon 从不启动它（没有 initial flush）。
      const filtered = messages.filter(
        m => !m.uuid || !recentPostedUUIDs.has(m.uuid as string),
      )
      if (filtered.length === 0) return
      if (!transport) {
        logForDebugging(
          `[bridge:repl] Transport not configured, dropping ${filtered.length} SDK message(s) for session=${currentSessionId}`,
          { level: 'warn' },
        )
        return
      }
      for (const msg of filtered) {
        if (msg.uuid) recentPostedUUIDs.add(msg.uuid as string)
      }
      const events: TransportMessage[] = filtered.map(m => ({
        ...m,
        session_id: currentSessionId,
      })) as TransportMessage[]
      void transport.writeBatch(events as StdoutMessage[])
    },
    sendControlRequest(request: SDKControlRequest) {
      if (!transport) {
        logForDebugging(
          '[bridge:repl] Transport not configured, skipping control_request',
        )
        return
      }
      const event: TransportMessage = {
        ...request,
        session_id: currentSessionId,
      } as TransportMessage
      void transport.write(event as StdoutMessage)
      logForDebugging(
        `[bridge:repl] Sent control_request request_id=${request.request_id}`,
      )
    },
    sendControlResponse(response: SDKControlResponse) {
      if (!transport) {
        logForDebugging(
          '[bridge:repl] Transport not configured, skipping control_response',
        )
        return
      }
      const event: TransportMessage = {
        ...response,
        session_id: currentSessionId,
      } as TransportMessage
      void transport.write(event as StdoutMessage)
      logForDebugging('[bridge:repl] Sent control_response')
    },
    sendControlCancelRequest(requestId: string) {
      if (!transport) {
        logForDebugging(
          '[bridge:repl] Transport not configured, skipping control_cancel_request',
        )
        return
      }
      const event: TransportMessage = {
        type: 'control_cancel_request' as const,
        request_id: requestId,
        session_id: currentSessionId,
      } as TransportMessage
      void transport.write(event as StdoutMessage)
      logForDebugging(
        `[bridge:repl] Sent control_cancel_request request_id=${requestId}`,
      )
    },
    sendResult() {
      if (!transport) {
        logForDebugging(
          `[bridge:repl] sendResult: skipping, transport not configured session=${currentSessionId}`,
        )
        return
      }
      transport.reportState('idle')
      const resultMsg = {
        ...makeResultMessage(currentSessionId),
        session_id: currentSessionId,
      } as unknown as TransportMessage
      void transport.write(resultMsg as StdoutMessage)
      logForDebugging(
        `[bridge:repl] Sent result for session=${currentSessionId}`,
      )
    },
    async teardown() {
      unregister()
      await doTeardownImpl?.()
      logForDebugging('[bridge:repl] Torn down')
      logEvent('tengu_bridge_repl_teardown', {})
    },
  }
}

/**
 * 持续轮询 work item 的循环。在 bridge 连接的整个生命周期内后台运行。
 *
 * work item 到达时，对其 ack 并调用 onWorkReceived，传入 session ID 和
 * ingress token（后者用于连接 ingress WebSocket）。之后继续 polling ——
 * 如果 ingress WebSocket 断开，服务器会派发新的 work item，让我们能
 * 自动重连而不必 teardown bridge。
 */
async function startWorkPollLoop({
  api,
  getCredentials,
  signal,
  onStateChange,
  onWorkReceived,
  onEnvironmentLost,
  getWsState,
  isAtCapacity,
  capacitySignal,
  onFatalError,
  getPollIntervalConfig = () => DEFAULT_POLL_CONFIG,
  getHeartbeatInfo,
  onHeartbeatFatal,
}: {
  api: BridgeApiClient
  getCredentials: () => { environmentId: string; environmentSecret: string }
  signal: AbortSignal
  onStateChange?: (state: BridgeState, detail?: string) => void
  onWorkReceived: (
    sessionId: string,
    ingressToken: string,
    workId: string,
    useCodeSessions: boolean,
  ) => void
  /** env 被删除时调用。返回新的凭据，或 null。 */
  onEnvironmentLost?: () => Promise<{
    environmentId: string
    environmentSecret: string
  } | null>
  /** 返回当前 WebSocket readyState 标签，用于诊断日志。 */
  getWsState?: () => string
  /**
   * 当调用方无法接新 work（transport 已连接）时返回 true。为 true 时，
   * 循环只按配置的 at-capacity interval 做心跳式 poll。服务器侧
   * BRIDGE_LAST_POLL_TTL 为 4 小时 —— 只要短于它就足以维持存活。
   */
  isAtCapacity?: () => boolean
  /**
   * 生成一个在容量释放（transport 丢失）时 abort 的信号，与循环信号合并。
   * 用于中断 at-capacity sleep，让恢复性 poll 立即开始。
   */
  capacitySignal?: () => CapacitySignal
  /** 出现不可恢复错误（例如服务器侧过期）时调用，触发完整 teardown。 */
  onFatalError?: () => void
  /** Poll interval 配置 getter —— 默认 DEFAULT_POLL_CONFIG。 */
  getPollIntervalConfig?: () => PollIntervalConfig
  /**
   * 返回当前 work ID 和 session ingress token 用于 heartbeat。
   * 为 null 时无法 heartbeat（没有活跃 work item）。
   */
  getHeartbeatInfo?: () => {
    environmentId: string
    workId: string
    sessionToken: string
  } | null
  /**
   * 当 heartbeatWork 抛出 BridgeFatalError（401/403/404/410 —— JWT 过期
   * 或 work item 没了）时调用。调用方应当 teardown transport 和 work 状态，
   * 让 isAtCapacity() 变回 false，循环快速 poll 寻找服务器重新派发的
   * work item。提供时，循环会跳过 at-capacity 退避 sleep（否则会造一个
   * 约 10 分钟的死窗口才能恢复）。省略时，回落到退避 sleep，避免紧密的
   * poll+heartbeat 循环。
   */
  onHeartbeatFatal?: (err: BridgeFatalError) => void
}): Promise<void> {
  const MAX_ENVIRONMENT_RECREATIONS = 3

  logForDebugging(
    `[bridge:repl] Starting work poll loop for env=${getCredentials().environmentId}`,
  )

  let consecutiveErrors = 0
  let firstErrorTime: number | null = null
  let lastPollErrorTime: number | null = null
  let environmentRecreations = 0
  // at-capacity sleep 超出截止时间很多（进程被挂起）时置位。在下一次迭代
  // 顶部消费，强制走一次快速 poll —— isAtCapacity() 是
  // `transport !== null`，transport 自动重连时它仍是 true，否则循环会
  // 直接回到 10 分钟 sleep，而 transport 可能连着一个死 socket。
  let suspensionDetected = false

  while (!signal.aborted) {
    // 在 try 外面捕获凭据，让 catch 块能检测并发重连是否替换了 env。
    const { environmentId: envId, environmentSecret: envSecret } =
      getCredentials()
    const pollConfig = getPollIntervalConfig()
    try {
      const work = await api.pollForWork(
        envId,
        envSecret,
        signal,
        pollConfig.reclaim_older_than_ms,
      )

      // 一次成功的 poll 证明 env 是真健康的 —— 重置 env-loss 计数器，让
      // 相隔数小时的事件各自重新开始。放在下面的 state-change 守卫之外，
      // 因为 onEnvLost 的成功路径已经发了 'ready'；这里再发就是重复。
      //（onEnvLost 返回凭据不会重置它 —— 否则新 env 立即死掉时会破坏
      // 振荡保护。）
      environmentRecreations = 0

      // 成功 poll 时重置错误追踪
      if (consecutiveErrors > 0) {
        logForDebugging(
          `[bridge:repl] Poll recovered after ${consecutiveErrors} consecutive error(s)`,
        )
        consecutiveErrors = 0
        firstErrorTime = null
        lastPollErrorTime = null
        onStateChange?.('ready')
      }

      if (!work) {
        // 读后清：检测到挂起后，只跳过 at-capacity 分支一次。上面的
        // pollForWork 已经刷新了服务器侧的 BRIDGE_LAST_POLL_TTL；这次
        // 快速循环让任何重新派发的 work item 在我们再次进入睡眠前有机会
        // 落地。
        const skipAtCapacityOnce = suspensionDetected
        suspensionDetected = false
        if (isAtCapacity?.() && capacitySignal && !skipAtCapacityOnce) {
          const atCapMs = pollConfig.poll_interval_ms_at_capacity
          // 无 poll 的 heartbeat 循环。当 at-capacity poll 也启用
          //（atCapMs > 0）时，循环追踪一个截止时间，到点就跳出来 poll ——
          // heartbeat 和 poll 组合而非相互压制。跳出条件：
          //   - Poll 截止时间到（仅 atCapMs > 0 时）
          //   - 认证失败（JWT 过期 → poll 刷新 token）
          //   - 容量唤醒触发（transport 丢失 → poll 寻找新 work）
          //   - Heartbeat 配置禁用（GrowthBook 更新）
          //   - 循环 abort（关闭）
          if (
            pollConfig.non_exclusive_heartbeat_interval_ms > 0 &&
            getHeartbeatInfo
          ) {
            logEvent('tengu_bridge_heartbeat_mode_entered', {
              heartbeat_interval_ms:
                pollConfig.non_exclusive_heartbeat_interval_ms,
            })
            // 进入时一次性计算截止时间 —— GB 对 atCapMs 的更新不会改变
            // 在途截止时间（下一次进入取新值）。
            const pollDeadline = atCapMs > 0 ? Date.now() + atCapMs : null
            let needsBackoff = false
            let hbCycles = 0
            while (
              !signal.aborted &&
              isAtCapacity() &&
              (pollDeadline === null || Date.now() < pollDeadline)
            ) {
              const hbConfig = getPollIntervalConfig()
              if (hbConfig.non_exclusive_heartbeat_interval_ms <= 0) break

              const info = getHeartbeatInfo()
              if (!info) break

              // 在 async heartbeat 调用之前捕获 capacity signal，让 HTTP
              // 请求期间的 transport 丢失能被随后的 sleep 抓到。
              const cap = capacitySignal()

              try {
                await api.heartbeatWork(
                  info.environmentId,
                  info.workId,
                  info.sessionToken,
                )
              } catch (err) {
                logForDebugging(
                  `[bridge:repl:heartbeat] Failed: ${errorMessage(err)}`,
                )
                if (err instanceof BridgeFatalError) {
                  cap.cleanup()
                  logEvent('tengu_bridge_heartbeat_error', {
                    status:
                      err.status as unknown as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    error_type: (err.status === 401 || err.status === 403
                      ? 'auth_failed'
                      : 'fatal') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                  })
                  // JWT 过期（401/403）或 work item 没了（404/410）。
                  // 无论哪种，当前 transport 都已死 —— SSE 重连和 CCR 写入
                  // 在同一个过期 token 上会失败。如果调用方给了恢复钩子，
                  // teardown work 状态并跳过退避：isAtCapacity() 变回 false，
                  // 下一次外循环迭代快速 poll 寻找服务器重新派发的 work
                  // item。没钩子则退避，避免紧密的 poll+heartbeat 循环。
                  if (onHeartbeatFatal) {
                    onHeartbeatFatal(err)
                    logForDebugging(
                      `[bridge:repl:heartbeat] Fatal (status=${err.status}), work state cleared — fast-polling for re-dispatch`,
                    )
                  } else {
                    needsBackoff = true
                  }
                  break
                }
              }

              hbCycles++
              await sleep(
                hbConfig.non_exclusive_heartbeat_interval_ms,
                cap.signal,
              )
              cap.cleanup()
            }

            const exitReason = needsBackoff
              ? 'error'
              : signal.aborted
                ? 'shutdown'
                : !isAtCapacity()
                  ? 'capacity_changed'
                  : pollDeadline !== null && Date.now() >= pollDeadline
                    ? 'poll_due'
                    : 'config_disabled'
            logEvent('tengu_bridge_heartbeat_mode_exited', {
              reason:
                exitReason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              heartbeat_cycles: hbCycles,
            })

            // auth_failed 或 fatal 时，在 poll 之前退避，避免紧密的
            // poll+heartbeat 循环。落到下面共享的 sleep —— 它和 legacy
            // 路径用的是同一个 capacitySignal 包装的 sleep，两者都需要
            // 挂起超限检查。
            if (!needsBackoff) {
              if (exitReason === 'poll_due') {
                // bridgeApi 对 empty-poll 日志做了节流
                //（EMPTY_POLL_LOG_INTERVAL=100），所以每 10 分钟一次的
                // poll_due poll 在 counter=2 时是看不到的。在这里记一条，
                // 让验证运行在 debug 日志里能看到两端。
                logForDebugging(
                  `[bridge:repl] Heartbeat poll_due after ${hbCycles} cycles — falling through to pollForWork`,
                )
              }
              continue
            }
          }
          // At-capacity sleep —— legacy 路径（heartbeat 禁用）和
          // heartbeat-backoff 路径（needsBackoff=true）都走到这里。合并
          // 起来让挂起检测覆盖两者；以前 backoff 路径没有超限检查，笔记本
          // 唤醒后可能直接回到 10 分钟睡眠。启用时用 atCapMs，否则用
          // heartbeat interval 作为下限（backoff 路径上保证 > 0），避免
          // 只配 heartbeat 的配置紧密循环。
          const sleepMs =
            atCapMs > 0
              ? atCapMs
              : pollConfig.non_exclusive_heartbeat_interval_ms
          if (sleepMs > 0) {
            const cap = capacitySignal()
            const sleepStart = Date.now()
            await sleep(sleepMs, cap.signal)
            cap.cleanup()
            // 进程挂起检测器。一个 setTimeout 超过其截止时间 60s 意味着
            // 进程被挂起过（笔记本合盖、SIGSTOP、VM 暂停）—— 即使是病态
            // GC 停顿也是秒级，不是分钟级。提前 abort
            //（wakePollLoop → cap.signal）会产生 overrun < 0 并落空。注意：
            // 这里只捕获超过截止时间的 sleep；WebSocketTransport 的 ping
            // 间隔（10s 粒度）是更短挂起的主要检测器。这里是在那个检测器
            // 没跑时（transport 重连中、interval 停了）的兜底。
            const overrun = Date.now() - sleepStart - sleepMs
            if (overrun > 60_000) {
              logForDebugging(
                `[bridge:repl] At-capacity sleep overran by ${Math.round(overrun / 1000)}s — process suspension detected, forcing one fast-poll cycle`,
              )
              logEvent('tengu_bridge_repl_suspension_detected', {
                overrun_ms: overrun,
              })
              suspensionDetected = true
            }
          }
        } else {
          await sleep(pollConfig.poll_interval_ms_not_at_capacity, signal)
        }
        continue
      }

      // 在按类型派发之前先解码 —— 显式 ack 需要 JWT。
      let secret
      try {
        secret = decodeWorkSecret(work.secret)
      } catch (err) {
        logForDebugging(
          `[bridge:repl] Failed to decode work secret: ${errorMessage(err)}`,
        )
        logEvent('tengu_bridge_repl_work_secret_failed', {})
        // 无法 ack（ack 需要我们刚解码失败的 JWT）。stopWork 用 OAuth。
        // 防止 XAUTOCLAIM 把这个毒丸每轮重新投递一次。
        await api.stopWork(envId, work.id, false).catch(() => {})
        continue
      }

      // 显式 ack 以防重复投递。失败不致命：服务器会重新投递，
      // onWorkReceived 回调负责去重。
      logForDebugging(`[bridge:repl] Acknowledging workId=${work.id}`)
      try {
        await api.acknowledgeWork(envId, work.id, secret.session_ingress_token)
      } catch (err) {
        logForDebugging(
          `[bridge:repl] Acknowledge failed workId=${work.id}: ${errorMessage(err)}`,
        )
      }

      if (work.data.type === 'healthcheck') {
        logForDebugging('[bridge:repl] Healthcheck received')
        continue
      }

      if (work.data.type === 'session') {
        const workSessionId = work.data.id
        try {
          validateBridgeId(workSessionId, 'session_id')
        } catch {
          logForDebugging(
            `[bridge:repl] Invalid session_id in work: ${workSessionId}`,
          )
          continue
        }

        onWorkReceived(
          workSessionId,
          secret.session_ingress_token,
          work.id,
          secret.use_code_sessions === true,
        )
        logForDebugging('[bridge:repl] Work accepted, continuing poll loop')
      }
    } catch (err) {
      if (signal.aborted) break

      // 检测永久的"environment 已删除"错误 —— 再多重试也救不回来。
      // 改为重新注册一个新 env。先于通用 BridgeFatalError 退出之前检查。
      // pollForWork 使用 validateStatus: s => s < 500，所以 404 总是被
      // handleErrorStatus() 包装成 BridgeFatalError —— 绝不会是 axios 形状
      // 的错误。poll endpoint 唯一的路径参数是 env ID；404 明确表示
      // env-gone（无 work 是 200 + null body）。服务器发送
      // error.type='not_found_error'（标准 Anthropic API 形状），不是
      // bridge 专属字符串 —— 但 status===404 才是真正的信号，能挺过
      // body 形状变更。
      if (
        err instanceof BridgeFatalError &&
        err.status === 404 &&
        onEnvironmentLost
      ) {
        // 如果凭据已经被并发重连刷新（例如 WS close 处理器），这次过期
        // poll 的错误是预期内的 —— 跳过 onEnvironmentLost 并用新凭据重试。
        const currentEnvId = getCredentials().environmentId
        if (envId !== currentEnvId) {
          logForDebugging(
            `[bridge:repl] Stale poll error for old env=${envId}, current env=${currentEnvId} — skipping onEnvironmentLost`,
          )
          consecutiveErrors = 0
          firstErrorTime = null
          continue
        }

        environmentRecreations++
        logForDebugging(
          `[bridge:repl] Environment deleted, attempting re-registration (attempt ${environmentRecreations}/${MAX_ENVIRONMENT_RECREATIONS})`,
        )
        logEvent('tengu_bridge_repl_env_lost', {
          attempt: environmentRecreations,
        } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)

        if (environmentRecreations > MAX_ENVIRONMENT_RECREATIONS) {
          logForDebugging(
            `[bridge:repl] Environment re-registration limit reached (${MAX_ENVIRONMENT_RECREATIONS}), giving up`,
          )
          onStateChange?.(
            'failed',
            'Environment deleted and re-registration limit reached',
          )
          onFatalError?.()
          break
        }

        onStateChange?.('reconnecting', 'environment lost, recreating session')
        const newCreds = await onEnvironmentLost()
        // doReconnect() 会做多次顺序网络调用（1-5s）。如果用户在这个窗口
        // 里触发了 teardown，它内部的 abort 检查会返回 false —— 但我们要
        // 在这里再检查一次，避免在优雅关闭期间发出虚假 'failed' +
        // onFatalError()。
        if (signal.aborted) break
        if (newCreds) {
          // 凭据通过 reconnectEnvironmentWithSession 在外层作用域更新 ——
          // 下一次 poll 迭代时 getCredentials() 返回新值。
          // 不要在这里重置 environmentRecreations —— onEnvLost 返回凭据
          // 只说明我们试过修，不说明 env 健康。成功的 poll（上面）才是
          // 重置点；如果新 env 立即死掉，我们仍然希望限制能触发。
          consecutiveErrors = 0
          firstErrorTime = null
          onStateChange?.('ready')
          logForDebugging(
            `[bridge:repl] Re-registered environment: ${newCreds.environmentId}`,
          )
          continue
        }

        onStateChange?.(
          'failed',
          'Environment deleted and re-registration failed',
        )
        onFatalError?.()
        break
      }

      // 致命错误（401/403/404/410）—— 重试无意义
      if (err instanceof BridgeFatalError) {
        const isExpiry = isExpiredErrorType(err.errorType)
        const isSuppressible = isSuppressible403(err)
        logForDebugging(
          `[bridge:repl] Fatal poll error: ${err.message} (status=${err.status}, type=${err.errorType ?? 'unknown'})${isSuppressible ? ' (suppressed)' : ''}`,
        )
        logEvent('tengu_bridge_repl_fatal_error', {
          status: err.status,
          error_type:
            err.errorType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        logForDiagnosticsNoPII(
          isExpiry ? 'info' : 'error',
          'bridge_repl_fatal_error',
          { status: err.status, error_type: err.errorType },
        )
        // 装饰性 403 错误（例如 external_poll_sessions scope、
        // environments:manage 权限）—— 抑制用户可见错误，但总是触发
        // teardown 以保证 cleanup 执行。
        if (!isSuppressible) {
          onStateChange?.(
            'failed',
            isExpiry
              ? 'session expired · /remote-control to reconnect'
              : err.message,
          )
        }
        // 总是触发 teardown —— 与 bridgeMain.ts 一致，那里
        // fatalExit=true 是无条件的，循环后 cleanup 总会跑。
        onFatalError?.()
        break
      }

      const now = Date.now()

      // 检测系统 sleep/wake：如果距离上次 poll 错误的间隔远大于最大退避
      // 延迟，机器多半睡过了。重置错误追踪，让我们用新的预算重试，而非
      // 立即放弃。
      if (
        lastPollErrorTime !== null &&
        now - lastPollErrorTime > POLL_ERROR_MAX_DELAY_MS * 2
      ) {
        logForDebugging(
          `[bridge:repl] Detected system sleep (${Math.round((now - lastPollErrorTime) / 1000)}s gap), resetting poll error budget`,
        )
        logForDiagnosticsNoPII('info', 'bridge_repl_poll_sleep_detected', {
          gapMs: now - lastPollErrorTime,
        })
        consecutiveErrors = 0
        firstErrorTime = null
      }
      lastPollErrorTime = now

      consecutiveErrors++
      if (firstErrorTime === null) {
        firstErrorTime = now
      }
      const elapsed = now - firstErrorTime
      const httpStatus = extractHttpStatus(err)
      const errMsg = describeAxiosError(err)
      const wsLabel = getWsState?.() ?? 'unknown'

      logForDebugging(
        `[bridge:repl] Poll error (attempt ${consecutiveErrors}, elapsed ${Math.round(elapsed / 1000)}s, ws=${wsLabel}): ${errMsg}`,
      )
      logEvent('tengu_bridge_repl_poll_error', {
        status: httpStatus,
        consecutiveErrors,
        elapsedMs: elapsed,
      } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)

      // 只在第一次错误时转为 'reconnecting' —— 在成功 poll 之前保持
      // 该状态（避免 UI 状态闪烁）。
      if (consecutiveErrors === 1) {
        onStateChange?.('reconnecting', errMsg)
      }

      // 持续失败超过阈值就放弃
      if (elapsed >= POLL_ERROR_GIVE_UP_MS) {
        logForDebugging(
          `[bridge:repl] Poll failures exceeded ${POLL_ERROR_GIVE_UP_MS / 1000}s (${consecutiveErrors} errors), giving up`,
        )
        logForDiagnosticsNoPII('info', 'bridge_repl_poll_give_up')
        logEvent('tengu_bridge_repl_poll_give_up', {
          consecutiveErrors,
          elapsedMs: elapsed,
          lastStatus: httpStatus,
        } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
        onStateChange?.('failed', 'connection to server lost')
        break
      }

      // 指数退避：2s → 4s → 8s → 16s → 32s → 60s（上限）
      const backoff = Math.min(
        POLL_ERROR_INITIAL_DELAY_MS * 2 ** (consecutiveErrors - 1),
        POLL_ERROR_MAX_DELAY_MS,
      )
      // poll_due 的 heartbeat 循环退出把一个健康的 lease 暴露给了这条
      // 退避路径。每次 sleep 之前先 heartbeat，让 /poll 宕机
      //（heartbeat 被引入就是为了避免那个 VerifyEnvironmentSecretAuth
      // DB 路径）不至于干掉 300s 的 lease TTL。
      if (getPollIntervalConfig().non_exclusive_heartbeat_interval_ms > 0) {
        const info = getHeartbeatInfo?.()
        if (info) {
          try {
            await api.heartbeatWork(
              info.environmentId,
              info.workId,
              info.sessionToken,
            )
          } catch {
            // 尽力而为 —— 如果 heartbeat 也失败，lease 就死了，与
            // pre-poll_due 行为一致（那时 heartbeat 循环退出的唯一情况
            // 就是 lease 已经在死）。
          }
        }
      }
      await sleep(backoff, signal)
    }
  }

  logForDebugging(
    `[bridge:repl] Work poll loop ended (aborted=${signal.aborted}) env=${getCredentials().environmentId}`,
  )
}

// 仅为测试导出
export {
  startWorkPollLoop as _startWorkPollLoopForTesting,
  POLL_ERROR_INITIAL_DELAY_MS as _POLL_ERROR_INITIAL_DELAY_MS_ForTesting,
  POLL_ERROR_MAX_DELAY_MS as _POLL_ERROR_MAX_DELAY_MS_ForTesting,
  POLL_ERROR_GIVE_UP_MS as _POLL_ERROR_GIVE_UP_MS_ForTesting,
}
