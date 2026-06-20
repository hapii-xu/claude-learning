/**
 * initBridgeCore 的 REPL 专属包装。负责读取 bootstrap 状态的部分 —— 门控、
 * cwd、session ID、git 上下文、OAuth、标题推导 —— 然后委托给不依赖
 * bootstrap 的 core。
 *
 * 从 replBridge.ts 拆出来是因为 sessionStorage 的 import
 *（getCurrentSessionTitle）会传递性地拉进 src/commands.ts → 整个 slash
 * command + React 组件树（约 1300 个模块）。把 initBridgeCore 留在一个
 * 不碰 sessionStorage 的文件里，daemonBridge.ts 就可以 import core 而
 * 不撑大 Agent SDK bundle。
 *
 * 由 useReplBridge（auto-start）和 print.ts（SDK -p 模式经
 * query.enableRemoteControl）通过 dynamic import 调用。
 */

import { feature } from 'bun:bundle'
import { hostname } from 'os'
import { getOriginalCwd, getSessionId } from '../bootstrap/state.js'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import type { SDKControlResponse } from '../entrypoints/sdk/controlTypes.js'
import { getFeatureValue_CACHED_WITH_REFRESH } from '../services/analytics/growthbook.js'
import { getOrganizationUUID } from '../services/oauth/client.js'
import {
  isPolicyAllowed,
  waitForPolicyLimitsToLoad,
} from '../services/policyLimits/index.js'
import type { Message } from '../types/message.js'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.js'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getClaudeAIOAuthTokens,
  handleOAuth401Error,
} from '../utils/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { logForDebugging } from '../utils/debug.js'
import { stripDisplayTagsAllowEmpty } from '../utils/displayTags.js'
import { errorMessage } from '../utils/errors.js'
import { getBranch, getRemoteUrl } from '../utils/git.js'
import { toSDKMessages } from '../utils/messages/mappers.js'
import {
  getContentText,
  getMessagesAfterCompactBoundary,
  isSyntheticMessage,
} from '../utils/messages.js'
import type { PermissionMode } from '../utils/permissions/PermissionMode.js'
import { getCurrentSessionTitle } from '../utils/sessionStorage.js'
import {
  extractConversationText,
  generateSessionTitle,
} from '../utils/sessionTitle.js'
import { generateShortWordSlug } from '../utils/words.js'
import {
  getBridgeAccessToken,
  getBridgeBaseUrl,
  getBridgeTokenOverride,
  isSelfHostedBridge,
} from './bridgeConfig.js'
import {
  checkBridgeMinVersion,
  isBridgeEnabledBlocking,
  isCseShimEnabled,
  isEnvLessBridgeEnabled,
} from './bridgeEnabled.js'
import {
  archiveBridgeSession,
  createBridgeSession,
  updateBridgeSessionTitle,
} from './createSession.js'
import { logBridgeSkip } from './debugUtils.js'
import { checkEnvLessBridgeMinVersion } from './envLessBridgeConfig.js'
import { getPollIntervalConfig } from './pollConfig.js'
import type { BridgeState, ReplBridgeHandle } from './replBridge.js'
import { initBridgeCore } from './replBridge.js'
import { setCseShimGate } from './sessionIdCompat.js'
import type { BridgeWorkerType } from './types.js'

export type InitBridgeOptions = {
  onInboundMessage?: (msg: SDKMessage) => void | Promise<void>
  onPermissionResponse?: (response: SDKControlResponse) => void
  onInterrupt?: () => void
  onSetModel?: (model: string | undefined) => void
  onSetMaxThinkingTokens?: (maxTokens: number | null) => void
  onSetPermissionMode?: (
    mode: PermissionMode,
  ) => { ok: true } | { ok: false; error: string }
  onStateChange?: (state: BridgeState, detail?: string) => void
  initialMessages?: Message[]
  // 来自 `/remote-control <name>` 的显式 session 名。设置时，覆盖从对话
  // 或 /rename 推导出的标题。
  initialName?: string
  // 调用时拿到的完整对话的新鲜视图。供 onUserMessage 的 count-3 推导使用：
  // 在完整对话上跑 generateSessionTitle。可选 —— print.ts 的 SDK
  // enableRemoteControl 路径没有 REPL message 数组；缺失时 count-3 退化
  // 为只用单条消息文本。
  getMessages?: () => Message[]
  // 之前 bridge session 已经 flush 过的 UUID 集合。初始 flush 会跳过带这些
  // UUID 的消息，避免污染服务器（跨 session 的重复 UUID 会导致 WS 被杀）。
  // 就地修改 —— 每次 flush 之后会加入新 flush 的 UUID。
  previouslyFlushedUUIDs?: Set<string>
  /** 参见 BridgeCoreParams.perpetual。 */
  perpetual?: boolean
  /**
   * 为 true 时，bridge 只转发 outbound 事件（不开 SSE inbound 流）。供
   * CCR mirror 模式使用 —— 本地 session 在 claude.ai 上可见但不启用
   * inbound 控制。
   */
  outboundOnly?: boolean
  tags?: string[]
}

export async function initReplBridge(
  options?: InitBridgeOptions,
): Promise<ReplBridgeHandle | null> {
  const {
    onInboundMessage,
    onPermissionResponse,
    onInterrupt,
    onSetModel,
    onSetMaxThinkingTokens,
    onSetPermissionMode,
    onStateChange,
    initialMessages,
    getMessages,
    previouslyFlushedUUIDs,
    initialName,
    perpetual,
    outboundOnly,
    tags,
  } = options ?? {}

  // 接好 cse_ shim 的 kill switch，让 toCompatSessionId 响应 GrowthBook
  // gate。Daemon/SDK 路径不接 —— shim 默认启用。
  setCseShimGate(isCseShimEnabled)

  // 1. 运行时门控
  if (!(await isBridgeEnabledBlocking())) {
    logBridgeSkip('not_enabled', '[bridge:repl] Skipping: bridge not enabled')
    return null
  }

  // 1b. 最低版本检查 —— 推迟到下面 v1/v2 分支之后，因为两套实现各有自己
  // 的版本下限（v1 走 tengu_bridge_min_version，v2 走
  // tengu_bridge_repl_v2_config.min_version）。

  // 2. OAuth 检查 —— 必须用 claude.ai 登录。放在 policy 检查之前，让
  // console-auth 的用户看到可操作的 "/login" 提示，而不是从陈旧/错误 org
  // 缓存里冒出来的 misleading policy 错误。
  if (!getBridgeAccessToken()) {
    logBridgeSkip('no_oauth', '[bridge:repl] Skipping: no OAuth tokens')
    onStateChange?.('failed', '/login')
    return null
  }

  // 3. 检查组织 policy —— remote control 可能被禁用
  await waitForPolicyLimitsToLoad()
  if (!isPolicyAllowed('allow_remote_control')) {
    logBridgeSkip(
      'policy_denied',
      '[bridge:repl] Skipping: allow_remote_control policy not allowed',
    )
    onStateChange?.('failed', "disabled by your organization's policy")
    return null
  }

  // 设置了 CLAUDE_BRIDGE_OAUTH_TOKEN（ant 专用本地开发）时，bridge 直接
  // 通过 getBridgeAccessToken() 使用该 token —— keychain 状态无关紧要。
  // 跳过 2b/2c 保持这种解耦：keychain 里过期的 token 不应该阻塞一个根本
  // 不用它的 bridge 连接。
  if (!getBridgeTokenOverride()) {
    // 2a. 跨进程退避。如果之前 N 个进程已经见过这个确切的死 token
    //（按 expiresAt 匹配），就静默跳过 —— 不发事件、不尝试刷新。计数
    // 阈值容忍瞬时的刷新失败（auth server 5xx、auth.ts:1437/1444/1485
    // 的 lockfile 错误）：每个进程独立重试，直到连续 3 次失败才认定
    // token 死。与 useReplBridge 进程内的 MAX_CONSECUTIVE_INIT_FAILURES
    // 对应。expiresAt key 是 content-addressed：/login → 新 token → 新
    // expiresAt → 不再匹配，不需要显式清除。
    const cfg = getGlobalConfig()
    if (
      cfg.bridgeOauthDeadExpiresAt != null &&
      (cfg.bridgeOauthDeadFailCount ?? 0) >= 3 &&
      getClaudeAIOAuthTokens()?.expiresAt === cfg.bridgeOauthDeadExpiresAt
    ) {
      logForDebugging(
        `[bridge:repl] Skipping: cross-process backoff (dead token seen ${cfg.bridgeOauthDeadFailCount} times)`,
      )
      return null
    }

    // 2b. 过期时主动刷新。对应 bridgeMain.ts:2096 —— REPL bridge 在
    // useEffect mount 时触发，先于任何 v1/messages 调用，这通常是本次
    // session 第一次 OAuth 请求。不做这一步的话，约 9% 的注册会带
    // >8h 过期的 token 打到服务器 → 401 → withOAuthRetry 会兜住，但
    // 服务器会留一条我们完全可以避免的 401 日志。在 8h TTL 边界上
    // 大量无关用户扎堆时，观测到 VPN 出口 IP 上 401:200 = 30:1。
    //
    // 新鲜 token 的成本：一次 memoize 读 + 一次 Date.now() 比较（约 µs
    // 级）。checkAndRefreshOAuthTokenIfNeeded 在每条涉及 keychain 的路径
    //（刷新成功、lockfile 竞态、抛错）上都会清自己的缓存，所以这里不
    // 显式 clearOAuthTokenCache() —— 否则会让 91%+ 走新鲜 token 的路径
    // 强行 spawn 一次阻塞的 keychain。
    await checkAndRefreshOAuthTokenIfNeeded()

    // 2c. 尝试刷新之后仍过期则跳过。env 变量 / FD token（auth.ts:894-917）
    // 的 expiresAt=null → 永不命中这里。但一个 keychain token，如果它的
    // refresh token 死了（改密码、退出 org、token 被 GC），expiresAt<now
    // 并且 刚才刷新失败 —— 客户端否则会永远 401 循环：withOAuthRetry →
    // handleOAuth401Error → 再次刷新失败 → 用同样陈旧的 token 重试 →
    // 再次 401。Datadog 2026-03-08：单个 IP 一天打 2,879 条这样的 401。
    // 跳过这次注定失败的 API 调用；useReplBridge 负责把失败冒出来。
    //
    // 故意不用 isOAuthTokenExpired —— 它有 5 分钟的 proactive-refresh 缓冲，
    // 用来判断"该刷新了"是对的，但用来判断"已经不能用"是错的。一个
    // 剩 3 分钟的 token + 刷新端点瞬时抖动（5xx/超时/wifi 重连）会误
    // 触发这里的缓冲检查；其实 token 还能用，能正常连上。改成检查
    // 真实过期时间：已经过期 AND 刷新失败 → 真的死了。
    const tokens = getClaudeAIOAuthTokens()
    if (tokens && tokens.expiresAt !== null && tokens.expiresAt <= Date.now()) {
      logBridgeSkip(
        'oauth_expired_unrefreshable',
        '[bridge:repl] Skipping: OAuth token expired and refresh failed (re-login required)',
      )
      onStateChange?.('failed', '/login')
      // 持久化给下一个进程。再次发现同一个死 token（按 expiresAt 匹配）
      // 时自增 failCount；不同 token 则重置为 1。count 一旦到 3，2a 步
      // 的提前 return 就会命中，这里再也不会走到 —— 每个死 token 最多
      // 写 3 次。本地 const 捕获收窄后的类型（闭包会丢掉 !==null 的
      // 类型收窄）。
      const deadExpiresAt = tokens.expiresAt
      saveGlobalConfig(c => ({
        ...c,
        bridgeOauthDeadExpiresAt: deadExpiresAt,
        bridgeOauthDeadFailCount:
          c.bridgeOauthDeadExpiresAt === deadExpiresAt
            ? (c.bridgeOauthDeadFailCount ?? 0) + 1
            : 1,
      }))
      return null
    }
  }

  // 4. 算出 baseUrl —— v1（基于 env）和 v2（env-less）路径都需要。提到
  // v2 gate 之前，让两条路径都能用。
  const baseUrl = getBridgeBaseUrl()

  // 5. 推导 session 标题。优先级：显式 initialName → /rename（session
  // storage）→ 最后一条有意义的 user 消息 → 生成的 slug。仅用于展示
  //（claude.ai session 列表）；模型永远看不到。
  // 两个 flag：`hasExplicitTitle`（initialName 或 /rename —— 永不自动覆盖）
  // vs `hasTitle`（任意标题，包括自动推导的 —— 阻止 count-1 的重新推导，
  // 但不阻止 count-3）。onUserMessage 回调（下面同时绑给 v1 和 v2）在第
  // 1 条 prompt 时推导一次、第 3 条再推导一次，让 mobile/web 能看到反
  // 映更多上下文的标题。slug 回退（例如 "remote-control-graceful-unicorn"）
  // 让自动启动的 session 在首条 prompt 之前就在 claude.ai 列表里能区分开。
  let title = `remote-control-${generateShortWordSlug()}`
  let hasTitle = false
  let hasExplicitTitle = false
  if (initialName) {
    title = initialName
    hasTitle = true
    hasExplicitTitle = true
  } else {
    const sessionId = getSessionId()
    const customTitle = sessionId
      ? getCurrentSessionTitle(sessionId)
      : undefined
    if (customTitle) {
      title = customTitle
      hasTitle = true
      hasExplicitTitle = true
    } else if (initialMessages && initialMessages.length > 0) {
      // 从后往前找最后一条内容有意义的 user 消息。跳过 meta（nudge）、
      // tool result、compact 摘要（"This session is being continued…"）、
      // 非人类 origin（task 通知、channel 推送）以及合成打断
      //（[Request interrupted by user]）—— 它们都不是人类写的。过滤
      // 条件与 extractTitleText + isSyntheticMessage 一致。
      for (let i = initialMessages.length - 1; i >= 0; i--) {
        const msg = initialMessages[i]!
        if (
          msg.type !== 'user' ||
          msg.isMeta ||
          msg.toolUseResult ||
          msg.isCompactSummary ||
          (msg.origin && (msg.origin as { kind?: string }).kind !== 'human') ||
          isSyntheticMessage(msg)
        )
          continue
        const rawContent = getContentText(
          msg.message!.content as string | ContentBlockParam[],
        )
        if (!rawContent) continue
        const derived = deriveTitle(rawContent)
        if (!derived) continue
        title = derived
        hasTitle = true
        break
      }
    }
  }

  // v1 和 v2 共用 —— 每条值得用作标题的 user 消息都会触发，直到它返回
  // true。count 1：立刻用 deriveTitle 占位，然后异步跑 generateSessionTitle
  //（Haiku，句首大写）升级。count 3：在完整对话上重新生成。标题是显式
  //（/remote-control <name> 或 /rename）时全部跳过 —— 调用时再查一次
  // sessionStorage，避免消息之间的 /rename 被覆盖。initialMessages 已经
  // 推导过就跳过 count 1（那个标题是新鲜的）；count 3 仍然刷新。v2 传
  // cse_*；updateBridgeSessionTitle 内部做 retag。
  let userMessageCount = 0
  let lastBridgeSessionId: string | undefined
  let genSeq = 0
  const patch = (
    derived: string,
    bridgeSessionId: string,
    atCount: number,
  ): void => {
    hasTitle = true
    title = derived
    logForDebugging(
      `[bridge:repl] derived title from message ${atCount}: ${derived}`,
    )
    void updateBridgeSessionTitle(bridgeSessionId, derived, {
      baseUrl,
      getAccessToken: getBridgeAccessToken,
    }).catch(() => {})
  }
  // 异步 Haiku 生成，await 之后还有多层守卫。重新检查 /rename
  //（sessionStorage）、v1 env-lost（lastBridgeSessionId）、同 session 乱序
  // resolve（genSeq —— count-1 的 Haiku 比 count-3 晚 resolve 会覆盖掉
  // 更丰富的标题）。generateSessionTitle 不会 reject。
  const generateAndPatch = (input: string, bridgeSessionId: string): void => {
    const gen = ++genSeq
    const atCount = userMessageCount
    void generateSessionTitle(input, AbortSignal.timeout(15_000)).then(
      generated => {
        if (
          generated &&
          gen === genSeq &&
          lastBridgeSessionId === bridgeSessionId &&
          !getCurrentSessionTitle(getSessionId())
        ) {
          patch(generated, bridgeSessionId, atCount)
        }
      },
    )
  }
  const onUserMessage = (text: string, bridgeSessionId: string): boolean => {
    if (hasExplicitTitle || getCurrentSessionTitle(getSessionId())) {
      return true
    }
    // v1 env-lost 会用新 ID 重新创建 session。重置计数，让新 session 拥有
    // 自己的 count-3 推导；hasTitle 保持为 true（新 session 是经
    // getCurrentTitle() 创建的，它会读这个闭包里的 count-1 标题），所以
    // 新周期的 count-1 会正确跳过。
    if (
      lastBridgeSessionId !== undefined &&
      lastBridgeSessionId !== bridgeSessionId
    ) {
      userMessageCount = 0
    }
    lastBridgeSessionId = bridgeSessionId
    userMessageCount++
    if (userMessageCount === 1 && !hasTitle) {
      const placeholder = deriveTitle(text)
      if (placeholder) patch(placeholder, bridgeSessionId, userMessageCount)
      generateAndPatch(text, bridgeSessionId)
    } else if (userMessageCount === 3) {
      const msgs = getMessages?.()
      const input = msgs
        ? extractConversationText(getMessagesAfterCompactBoundary(msgs))
        : text
      generateAndPatch(input, bridgeSessionId)
    }
    // v1 env-lost 把 transport 的 done 标志重置过 3 的话，这里也重新 latch。
    return userMessageCount >= 3
  }

  const initialHistoryCap = getFeatureValue_CACHED_WITH_REFRESH(
    'tengu_bridge_initial_history_cap',
    200,
    5 * 60 * 1000,
  )

  // 在 v1/v2 分支之前先取 orgUUID —— 两条路径都需要。v1 用于 environment
  // 注册；v2 用于 archive（它在 compat 的 /v1/sessions/{id}/archive 而不是
  // /v1/code/sessions）。没这个的话，v2 archive 会 404，session 在 /exit
  // 之后在 CCR 里继续活着。自托管 bridge 跳过这一步 —— 本地 server 不
  // 要求 org 鉴权。
  const orgUUID = isSelfHostedBridge()
    ? 'self-hosted'
    : await getOrganizationUUID()
  if (!orgUUID) {
    logBridgeSkip('no_org_uuid', '[bridge:repl] Skipping: no org UUID')
    onStateChange?.('failed', '/login')
    return null
  }

  // ── GrowthBook gate：env-less bridge ─────────────────────────────────
  // 启用时完全跳过 Environments API 层（不做 register/poll/ack/heartbeat），
  // 直接通过 POST /bridge → worker_jwt 连接。参见 server PR #292605
  //（在 #293280 中改名）。仅 REPL —— daemon/print 仍然走 env-based。
  //
  // 命名："env-less" 与 "CCR v2"（/worker/* transport）是两回事。下面的
  // env-based 路径通过 CLAUDE_CODE_USE_CCR_V2 也能用 CCR v2。
  // tengu_bridge_repl_v2 门控的是 env-less（无 poll 循环），不是 transport
  // 版本。
  //
  // perpetual（assistant 模式下经 bridge-pointer.json 做 session 续接）
  // 与 env 耦合，这里还没实现 —— 设置时回退到 env-based，避免 KAIROS
  // 用户静默丢失跨重启的续接。
  if (isEnvLessBridgeEnabled() && !perpetual) {
    const versionError = await checkEnvLessBridgeMinVersion()
    if (versionError) {
      logBridgeSkip(
        'version_too_old',
        `[bridge:repl] Skipping: ${versionError}`,
        true,
      )
      onStateChange?.('failed', 'run `claude update` to upgrade')
      return null
    }
    logForDebugging(
      '[bridge:repl] Using env-less bridge path (tengu_bridge_repl_v2)',
    )
    const { initEnvLessBridgeCore } = await import('./remoteBridgeCore.js')
    return initEnvLessBridgeCore({
      baseUrl,
      orgUUID,
      title,
      getAccessToken: getBridgeAccessToken,
      onAuth401: handleOAuth401Error,
      toSDKMessages,
      initialHistoryCap,
      initialMessages,
      // v2 永远创建全新的服务器 session（新的 cse_* id），所以不传
      // previouslyFlushedUUIDs —— 没有跨 session UUID 冲突风险，并且
      // 这个 ref 会跨 enable→disable→re-enable 周期保留，导致新 session
      // 收不到任何历史（之前 enable 期间的所有 UUID 都已在集合中）。
      // v1 通过在创建新 session 时调 previouslyFlushedUUIDs.clear() 处理
      //（replBridge.ts:768）；v2 直接跳过这个参数。
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
    })
  }

  // ── v1 路径：基于 env（register/poll/ack/heartbeat）─────────────────

  const versionError = checkBridgeMinVersion()
  if (versionError) {
    logBridgeSkip('version_too_old', `[bridge:repl] Skipping: ${versionError}`)
    onStateChange?.('failed', 'run `claude update` to upgrade')
    return null
  }

  // 收集 git 上下文 —— 这里就是读 bootstrap 的边界。从这里往下，所有
  // 东西都显式传给 bridgeCore。
  const branch = await getBranch()
  const gitRepoUrl = await getRemoteUrl()
  const sessionIngressUrl =
    process.env.CLAUDE_BRIDGE_SESSION_INGRESS_URL || baseUrl

  // assistant 模式 session 声明一个独立的 worker_type，让 web UI 可以把它
  // 们过滤到专属 picker 里。KAIROS 守卫确保 assistant 模块完全不进入外部
  // 构建。
  let workerType: BridgeWorkerType = 'claude_code'
  if (feature('KAIROS')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { isAssistantMode } =
      require('../assistant/index.js') as typeof import('../assistant/index.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    if (isAssistantMode()) {
      workerType = 'claude_code_assistant'
    }
  }

  // 6. 委托。BridgeCoreHandle 是 ReplBridgeHandle 的结构超集（多了
  // REPL 调用方用不上的 writeSdkMessages），所以不需要适配 —— 出去时
  // 用更窄的类型就行。
  return initBridgeCore({
    dir: getOriginalCwd(),
    machineName: hostname(),
    branch,
    gitRepoUrl,
    title,
    baseUrl,
    sessionIngressUrl,
    workerType,
    getAccessToken: getBridgeAccessToken,
    createSession: opts =>
      createBridgeSession({
        ...opts,
        events: [],
        baseUrl,
        getAccessToken: getBridgeAccessToken,
      }),
    archiveSession: sessionId =>
      archiveBridgeSession(sessionId, {
        baseUrl,
        getAccessToken: getBridgeAccessToken,
        // gracefulShutdown.ts:407 让 runCleanupFunctions 与 2s 赛跑。
        // Teardown 还要做 stopWork（并行）+ deregister（串行），所以
        // archive 拿不到全额预算。1.5s 与 v2 的
        // teardown_archive_timeout_ms 默认值一致。
        timeoutMs: 1500,
      }).catch((err: unknown) => {
        // archiveBridgeSession 没有 try/catch —— 5xx/超时/网络错误会直接
        // 抛穿。之前静默吞掉，导致 archive 失败在 BQ 里不可见、从 debug
        // 日志也无法诊断。
        logForDebugging(
          `[bridge:repl] archiveBridgeSession threw: ${errorMessage(err)}`,
          { level: 'error' },
        )
      }),
    // reconnect-after-env-lost 时读 getCurrentTitle 给新 session 起新
    // 标题。/rename 写 session storage；onUserMessage 直接改 `title`
    // —— 两条路在这里都会被收集到。
    getCurrentTitle: () => getCurrentSessionTitle(getSessionId()) ?? title,
    onUserMessage,
    toSDKMessages,
    onAuth401: handleOAuth401Error,
    getPollIntervalConfig,
    initialHistoryCap,
    initialMessages,
    previouslyFlushedUUIDs,
    onInboundMessage,
    onPermissionResponse,
    onInterrupt,
    onSetModel,
    onSetMaxThinkingTokens,
    onSetPermissionMode,
    onStateChange,
    perpetual,
  })
}

const TITLE_MAX_LEN = 50

/**
 * 快速占位标题：剥掉 display tag，取第一句，折叠空白，截断到 50 字符。
 * 结果为空（例如消息全是 <local-command-stdout>）时返回 undefined。等
 * Haiku resolve（约 1-15s）后由 generateSessionTitle 替换。
 */
function deriveTitle(raw: string): string | undefined {
  // 剥掉 <ide_opened_file>、<session-start-hook> 等 —— IDE / hook 注入
  // 上下文时它们会出现在 user 消息里。stripDisplayTagsAllowEmpty 返回
  // ''（而不是原文），这样纯 tag 消息会被跳过。
  const clean = stripDisplayTagsAllowEmpty(raw)
  // 第一句通常是意图；剩下的是上下文/细节。用捕获组而不是 lookbehind
  // —— 让 YARR JIT 保持开心。
  const firstSentence = /^(.*?[.!?])\s/.exec(clean)?.[1] ?? clean
  // 折叠换行/tab —— claude.ai 列表里的标题是单行。
  const flat = firstSentence.replace(/\s+/g, ' ').trim()
  if (!flat) return undefined
  return flat.length > TITLE_MAX_LEN
    ? flat.slice(0, TITLE_MAX_LEN - 1) + '\u2026'
    : flat
}
