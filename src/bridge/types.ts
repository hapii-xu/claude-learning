/** 默认的 per-session 超时（24 小时）。 */
export const DEFAULT_SESSION_TIMEOUT_MS = 24 * 60 * 60 * 1000

/** 追加到 bridge 鉴权错误后面的登录指引文案。 */
export const BRIDGE_LOGIN_INSTRUCTION =
  'Remote Control is only available with claude.ai subscriptions. Please use `/login` to sign in with your claude.ai account.'

/** 未鉴权运行 `claude remote-control` 时打印的完整错误信息。 */
export const BRIDGE_LOGIN_ERROR =
  'Error: You must be logged in to use Remote Control.\n\n' +
  BRIDGE_LOGIN_INSTRUCTION

/** 用户断开 Remote Control 时显示的文案（通过 /remote-control 或 ultraplan 启动）。 */
export const REMOTE_CONTROL_DISCONNECTED_MSG = 'Remote Control disconnected.'

// --- environments API 的协议类型 ---

export type WorkData = {
  type: 'session' | 'healthcheck'
  id: string
}

export type WorkResponse = {
  id: string
  type: 'work'
  environment_id: string
  state: string
  data: WorkData
  secret: string // base64url 编码的 JSON
  created_at: string
}

export type WorkSecret = {
  version: number
  session_ingress_token: string
  api_base_url: string
  sources: Array<{
    type: string
    git_info?: { type: string; repo: string; ref?: string; token?: string }
  }>
  auth: Array<{ type: string; token: string }>
  claude_code_args?: Record<string, string> | null
  mcp_config?: unknown | null
  environment_variables?: Record<string, string> | null
  /**
   * 服务器驱动的 CCR v2 选择器。当 session 通过 v2 compat 层
   *（ccr_v2_compat_enabled）创建时，由 prepare_work_secret() 设置。
   * BYOC runner 在 environment-runner/sessionExecutor.ts 中读的是同一个字段。
   */
  use_code_sessions?: boolean
}

export type SessionDoneStatus = 'completed' | 'failed' | 'interrupted'

export type SessionActivityType = 'tool_start' | 'text' | 'result' | 'error'

export type SessionActivity = {
  type: SessionActivityType
  summary: string // 例如 "Editing src/foo.ts"、"Reading package.json"
  timestamp: number
}

/**
 * `claude remote-control` 选择 session 工作目录的方式。
 * - `single-session`：cwd 中单个 session，结束后 bridge 拆除
 * - `worktree`：常驻 server，每个 session 拿到独立的 git worktree
 * - `same-dir`：常驻 server，每个 session 共享 cwd（可能互相踩）
 */
export type SpawnMode = 'single-session' | 'worktree' | 'same-dir'

/**
 * 本代码库产生的 well-known worker_type 取值。注册 environment 时作为
 * `metadata.worker_type` 发出去，让 claude.ai 能按来源过滤 session 选择器
 *（例如 assistant tab 只显示 assistant worker）。后端把它当成不透明字符
 * 串 —— 桌面 cowork 发的是 `"cowork"`，不在这个联合里。REPL 代码用这个
 * 窄类型做自己的穷尽性检查；线上字段接受任意字符串。
 */
export type BridgeWorkerType = 'claude_code' | 'claude_code_assistant'

export type BridgeConfig = {
  dir: string
  machineName: string
  branch: string
  gitRepoUrl: string | null
  maxSessions: number
  spawnMode: SpawnMode
  verbose: boolean
  sandbox: boolean
  /** 本客户端生成的 UUID，用于标识这个 bridge 实例。 */
  bridgeId: string
  /**
   * 作为 metadata.worker_type 发送，让 web 客户端可以按来源过滤。后端
   * 当成不透明字符串 —— 任意字符串都可以，不限于 BridgeWorkerType。
   */
  workerType: string
  /** 本客户端生成的 UUID，用于幂等的 environment 注册。 */
  environmentId: string
  /**
   * 再注册时复用的后端下发 environment_id。设置后，后端把注册当作对
   * 现有 environment 的重连，而不是创建新 environment。供 `claude
   * remote-control --session-id` resume 使用。必须是后端格式的 ID ——
   * 客户端 UUID 会被 400 拒绝。
   */
  reuseEnvironmentId?: string
  /** bridge 连接的 API base URL（用于轮询）。 */
  apiBaseUrl: string
  /** WebSocket 连接的 session ingress base URL（本地可能与 apiBaseUrl 不同）。 */
  sessionIngressUrl: string
  /** 通过 --debug-file 传入的 debug 文件路径。 */
  debugFile?: string
  /** per-session 的超时（毫秒）。超过会被 kill。 */
  sessionTimeoutMs?: number
}

// --- 依赖接口（便于测试） ---

/**
 * 发回 session 的 control_response 事件（例如权限决策）。按 SDK 协议
 * `subtype` 为 `'success'`；内层 `response` 携带权限决策载荷
 *（例如 `{ behavior: 'allow' }`）。
 */
export type PermissionResponseEvent = {
  type: 'control_response'
  response: {
    subtype: 'success'
    request_id: string
    response: Record<string, unknown>
  }
}

export type BridgeApiClient = {
  registerBridgeEnvironment(config: BridgeConfig): Promise<{
    environment_id: string
    environment_secret: string
  }>
  pollForWork(
    environmentId: string,
    environmentSecret: string,
    signal?: AbortSignal,
    reclaimOlderThanMs?: number,
  ): Promise<WorkResponse | null>
  acknowledgeWork(
    environmentId: string,
    workId: string,
    sessionToken: string,
  ): Promise<void>
  /** 通过 environments API 停止一个 work item。 */
  stopWork(environmentId: string, workId: string, force: boolean): Promise<void>
  /** 优雅关闭时，deregister / 删除 bridge environment。 */
  deregisterEnvironment(environmentId: string): Promise<void>
  /** 通过 session events API 把权限响应（control_response）发给 session。 */
  sendPermissionResponseEvent(
    sessionId: string,
    event: PermissionResponseEvent,
    sessionToken: string,
  ): Promise<void>
  /** 归档 session，使其不再在服务器侧显示为活跃。 */
  archiveSession(sessionId: string): Promise<void>
  /**
   * 强制停止陈旧的 worker 实例，并在某个 environment 上把 session 重新
   * 入队。供 `--session-id` 使用，在原 bridge 死亡后恢复 session。
   */
  reconnectSession(environmentId: string, sessionId: string): Promise<void>
  /**
   * 为活跃的 work item 发送一次轻量 heartbeat，延长它的租约。使用
   * SessionIngressAuth（JWT，不碰 DB）而不是 EnvironmentSecretAuth。
   * 返回服务器响应中的租约状态。
   */
  heartbeatWork(
    environmentId: string,
    workId: string,
    sessionToken: string,
  ): Promise<{ lease_extended: boolean; state: string }>
}

export type SessionHandle = {
  sessionId: string
  done: Promise<SessionDoneStatus>
  kill(): void
  forceKill(): void
  activities: SessionActivity[] // 最近活动的环形缓冲（约最近 10 条）
  currentActivity: SessionActivity | null // 最近一条
  accessToken: string // 用于 API 调用的 session_ingress_token
  lastStderr: string[] // 最近 stderr 行的环形缓冲
  writeStdin(data: string): void // 直接写子进程 stdin
  /** 更新运行中 session 的 access token（例如 token 刷新之后）。 */
  updateAccessToken(token: string): void
}

export type SessionSpawnOpts = {
  sessionId: string
  sdkUrl: string
  accessToken: string
  /** 为 true 时，用 CCR v2 的 env 变量派生子进程（SSE transport + CCRClient）。 */
  useCcrV2?: boolean
  /** useCcrV2 为 true 时必填。从 POST /worker/register 拿到。 */
  workerEpoch?: number
  /**
   * 当子进程 stdout（通过 --replay-user-messages）上出现第一条真实用户
   * 消息时触发一次，回调拿到消息文本。让调用方在没有 session 标题时
   * 能据此生成一个。tool-result 和合成 user 消息会被跳过。
   */
  onFirstUserMessage?: (text: string) => void
}

export type SessionSpawner = {
  spawn(opts: SessionSpawnOpts, dir: string): SessionHandle
}

export type BridgeLogger = {
  printBanner(config: BridgeConfig, environmentId: string): void
  logSessionStart(sessionId: string, prompt: string): void
  logSessionComplete(sessionId: string, durationMs: number): void
  logSessionFailed(sessionId: string, error: string): void
  logStatus(message: string): void
  logVerbose(message: string): void
  logError(message: string): void
  /** 从连接错误中恢复后，记录一次重连成功事件。 */
  logReconnected(disconnectedMs: number): void
  /** 显示带 repo/branch 信息和 shimmer 动画的 idle 状态。 */
  updateIdleStatus(): void
  /** 在实时显示中展示 reconnecting 状态。 */
  updateReconnectingStatus(delayStr: string, elapsedStr: string): void
  updateSessionStatus(
    sessionId: string,
    elapsed: string,
    activity: SessionActivity,
    trail: string[],
  ): void
  clearStatus(): void
  /** 设置状态栏展示所需的 repo 信息。 */
  setRepoInfo(repoName: string, branch: string): void
  /** 设置状态栏上方展示的 debug 日志 glob（ant 用户专用）。 */
  setDebugLogPath(path: string): void
  /** session 启动时切换到 "Attached" 状态。 */
  setAttached(sessionId: string): void
  /** 在实时显示中展示 failed 状态。 */
  updateFailedStatus(error: string): void
  /** 切换 QR 码可见性。 */
  toggleQr(): void
  /** 更新 "<n> of <m> sessions" 指示以及 spawn 模式提示。 */
  updateSessionCount(active: number, max: number, mode: SpawnMode): void
  /** 更新 session-count 行展示的 spawn 模式。传 null 表示隐藏（single-session 或 toggle 不可用）。 */
  setSpawnModeDisplay(mode: 'same-dir' | 'worktree' | null): void
  /** 多 session 展示中，注册一个新 session（spawn 成功后调用）。 */
  addSession(sessionId: string, url: string): void
  /** 多 session 列表中，更新某个 session 的活动摘要（正在跑的 tool）。 */
  updateSessionActivity(sessionId: string, activity: SessionActivity): void
  /**
   * 设置某个 session 的展示标题。多 session 模式下更新 bullet list 条目；
   * 单 session 模式下也会在主状态栏显示该标题。会触发一次重渲染
   *（reconnecting/failed 状态下会被忽略）。
   */
  setSessionTitle(sessionId: string, title: string): void
  /** 多 session 展示中某个 session 结束时，把它移除。 */
  removeSession(sessionId: string): void
  /** 强制状态显示重渲染（用于多 session 活动刷新）。 */
  refreshDisplay(): void
}
