/**
 * Claude Code Agent SDK 类型的主入口。
 *
 * 本文件从以下模块再导出公共 SDK API：
 * - sdk/coreTypes.ts —— 常见的可序列化类型（消息、配置）
 * - sdk/runtimeTypes.ts —— 不可序列化的类型（回调、接口）
 *
 * 需要 control protocol 类型的 SDK 构建方应直接从 sdk/controlTypes.ts import。
 */

import type {
  CallToolResult,
  ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js'

// 面向 SDK 构建方的 control protocol 类型（bridge 子路径消费者）
/** @alpha */
export type {
  SDKControlRequest,
  SDKControlResponse,
} from './sdk/controlTypes.js'
// 再导出核心类型（常见可序列化类型）
export * from './sdk/coreTypes.js'
// 再导出运行时类型（回调、带方法的接口）
export * from './sdk/runtimeTypes.js'

// 再导出设置类型（由 settings JSON schema 生成）
export type { Settings } from './sdk/settingsTypes.generated.js'
// 再导出工具类型（在 SDK API 稳定前全部标记 @internal）
export * from './sdk/toolTypes.js'

// ============================================================================
// 函数
// ============================================================================

import type {
  SDKMessage,
  SDKResultMessage,
  SDKSessionInfo,
  SDKUserMessage,
} from './sdk/coreTypes.js'
// 导入函数签名所需的类型
import type {
  AnyZodRawShape,
  ForkSessionOptions,
  ForkSessionResult,
  GetSessionInfoOptions,
  GetSessionMessagesOptions,
  InferShape,
  InternalOptions,
  InternalQuery,
  ListSessionsOptions,
  McpSdkServerConfigWithInstance,
  Options,
  Query,
  SDKSession,
  SDKSessionOptions,
  SdkMcpToolDefinition,
  SessionMessage,
  SessionMutationOptions,
} from './sdk/runtimeTypes.js'
// 与 settings / hooks schema 共用的钩子事件与 SessionEnd 退出原因字面量表
import { EXIT_REASONS, HOOK_EVENTS } from './sdk/coreSchemas.js'

export type {
  ListSessionsOptions,
  GetSessionInfoOptions,
  SessionMutationOptions,
  ForkSessionOptions,
  ForkSessionResult,
  SDKSessionInfo,
}

export function tool<Schema extends AnyZodRawShape>(
  _name: string,
  _description: string,
  _inputSchema: Schema,
  _handler: (
    args: InferShape<Schema>,
    extra: unknown,
  ) => Promise<CallToolResult>,
  _extras?: {
    annotations?: ToolAnnotations
    searchHint?: string
    alwaysLoad?: boolean
  },
): SdkMcpToolDefinition<Schema> {
  throw new Error('not implemented')
}

type CreateSdkMcpServerOptions = {
  name: string
  version?: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools?: Array<SdkMcpToolDefinition<any>>
}

/**
 * 创建一个可配合 SDK transport 使用的 MCP 服务器实例。
 * 让 SDK 用户可以定义在同一进程内运行的自定义工具。
 *
 * 若你的 SDK MCP 调用运行时间会超过 60 秒，请覆盖 CLAUDE_CODE_STREAM_CLOSE_TIMEOUT
 */
export function createSdkMcpServer(
  _options: CreateSdkMcpServerOptions,
): McpSdkServerConfigWithInstance {
  throw new Error('not implemented')
}

export class AbortError extends Error {}

/** @internal */
export function query(_params: {
  prompt: string | AsyncIterable<SDKUserMessage>
  options?: InternalOptions
}): InternalQuery
export function query(_params: {
  prompt: string | AsyncIterable<SDKUserMessage>
  options?: Options
}): Query
export function query(): Query {
  throw new Error('query is not implemented in the SDK')
}

/**
 * V2 API —— 不稳定
 * 创建一个持久化会话用于多轮对话。
 * @alpha
 */
export function unstable_v2_createSession(
  _options: SDKSessionOptions,
): SDKSession {
  throw new Error('unstable_v2_createSession is not implemented in the SDK')
}

/**
 * V2 API —— 不稳定
 * 按 ID 恢复已存在的会话。
 * @alpha
 */
export function unstable_v2_resumeSession(
  _sessionId: string,
  _options: SDKSessionOptions,
): SDKSession {
  throw new Error('unstable_v2_resumeSession is not implemented in the SDK')
}

// @[MODEL LAUNCH]：更新此 docstring 中的示例 model ID。
/**
 * V2 API —— 不稳定
 * 面向单次 prompt 的便捷一次性函数。
 * @alpha
 *
 * @example
 * ```typescript
 * const result = await unstable_v2_prompt("What files are here?", {
 *   model: 'claude-sonnet-4-6'
 * })
 * ```
 */
export async function unstable_v2_prompt(
  _message: string,
  _options: SDKSessionOptions,
): Promise<SDKResultMessage> {
  throw new Error('unstable_v2_prompt is not implemented in the SDK')
}

/**
 * 从会话的 JSONL transcript 文件读取对话消息。
 *
 * 解析 transcript，通过 parentUuid 链接构建对话链，
 * 按时间顺序返回 user/assistant 消息。在 options 中设置
 * `includeSystemMessages: true` 可同时返回 system 消息。
 *
 * @param sessionId - 要读取的会话 UUID
 * @param options - 可选的 dir、limit、offset、includeSystemMessages
 * @returns 消息数组；若会话不存在则返回空数组
 */
export async function getSessionMessages(
  _sessionId: string,
  _options?: GetSessionMessagesOptions,
): Promise<SessionMessage[]> {
  throw new Error('getSessionMessages is not implemented in the SDK')
}

/**
 * 列出带元数据的会话。
 *
 * 若提供 `dir`，则返回该工程目录及其 git worktree 的会话。
 * 若省略，则返回所有工程下的会话。
 *
 * 使用 `limit` 与 `offset` 做分页。
 *
 * @example
 * ```typescript
 * // 列出某个工程下的会话
 * const sessions = await listSessions({ dir: '/path/to/project' })
 *
 * // 分页
 * const page1 = await listSessions({ limit: 50 })
 * const page2 = await listSessions({ limit: 50, offset: 50 })
 * ```
 */
export async function listSessions(
  _options?: ListSessionsOptions,
): Promise<SDKSessionInfo[]> {
  throw new Error('listSessions is not implemented in the SDK')
}

/**
 * 按 ID 读取单个会话的元数据。与 `listSessions` 不同，此函数只读取
 * 目标会话文件，而非工程内每一个会话。
 * 若会话文件不存在、是 sidechain 会话，或无可提取的摘要，则返回 undefined。
 *
 * @param sessionId - 会话 UUID
 * @param options - `{ dir?: string }` 工程路径；省略则在所有工程目录中搜索
 */
export async function getSessionInfo(
  _sessionId: string,
  _options?: GetSessionInfoOptions,
): Promise<SDKSessionInfo | undefined> {
  throw new Error('getSessionInfo is not implemented in the SDK')
}

/**
 * 重命名会话。向会话的 JSONL 文件追加一条 custom-title 条目。
 * @param sessionId - 会话 UUID
 * @param title - 新标题
 * @param options - `{ dir?: string }` 工程路径；省略则在所有工程中搜索
 */
export async function renameSession(
  _sessionId: string,
  _title: string,
  _options?: SessionMutationOptions,
): Promise<void> {
  throw new Error('renameSession is not implemented in the SDK')
}

/**
 * 为会话打标签。传入 null 可清除标签。
 * @param sessionId - 会话 UUID
 * @param tag - 标签字符串，或传入 null 清除
 * @param options - `{ dir?: string }` 工程路径；省略则在所有工程中搜索
 */
export async function tagSession(
  _sessionId: string,
  _tag: string | null,
  _options?: SessionMutationOptions,
): Promise<void> {
  throw new Error('tagSession is not implemented in the SDK')
}

/**
 * 将一个会话 fork 成新分支，生成全新的 UUID。
 *
 * 将源会话的 transcript 消息复制到新会话文件中，
 * 重映射每条消息的 UUID，并保留 parentUuid 链。支持通过
 * `upToMessageId` 从对话中的某个特定点开始分支。
 *
 * fork 出的会话不保留 undo 历史（file-history 快照不会被复制）。
 *
 * @param sessionId - 源会话 UUID
 * @param options - `{ dir?, upToMessageId?, title? }`
 * @returns `{ sessionId }` —— 新 fork 会话的 UUID
 */
export async function forkSession(
  _sessionId: string,
  _options?: ForkSessionOptions,
): Promise<ForkSessionResult> {
  throw new Error('forkSession is not implemented in the SDK')
}

// ============================================================================
// Assistant daemon 基础类型（内部）
// ============================================================================

/**
 * 来自 `<dir>/.hclaude/scheduled_tasks.json` 的定时任务。
 * @internal
 */
export type CronTask = {
  id: string
  cron: string
  prompt: string
  createdAt: number
  recurring?: boolean
}

/**
 * Cron 调度器的调优参数（jitter + 过期）。运行时取自 CLI 会话中的
 * `tengu_kairos_cron_config` GrowthBook 配置；daemon 宿主通过
 * `watchScheduledTasks({ getJitterConfig })` 传入以获得同样的调优。
 * @internal
 */
export type CronJitterConfig = {
  recurringFrac: number
  recurringCapMs: number
  oneShotMaxMs: number
  oneShotFloorMs: number
  oneShotMinuteMod: number
  recurringMaxAgeMs: number
}

/**
 * `watchScheduledTasks()` yield 的事件。
 * @internal
 */
export type ScheduledTaskEvent =
  | { type: 'fire'; task: CronTask }
  | { type: 'missed'; tasks: CronTask[] }

/**
 * `watchScheduledTasks()` 返回的 handle。
 * @internal
 */
export type ScheduledTasksHandle = {
  /** fire/missed 事件的异步流。用 `for await` 消费。 */
  events(): AsyncGenerator<ScheduledTaskEvent>
  /**
   * 所有已加载任务中最近一次将要触发的 epoch 毫秒时间戳；
   * 若无调度则返回 null。可用于决定是拆除空闲的 agent 子进程，
   * 还是为即将到来的触发保持热启动。
   */
  getNextFireTime(): number | null
}

/**
 * 监听 `<dir>/.hclaude/scheduled_tasks.json`，在任务触发时 yield 事件。
 *
 * 获取该目录级别的调度器锁（基于 PID 的存活检测），这样同一目录下的
 * REPL 会话不会重复触发。当 signal 中断时释放锁并关闭文件 watcher。
 *
 * - `fire` —— cron 调度已满足的任务。一次性任务在 yield 时已从文件中
 *   删除；周期性任务会被重新调度（若超龄则删除）。
 * - `missed` —— daemon 宕机期间错过时间窗口的一次性任务。
 *   在初始加载时 yield 一次；后台删除任务会稍后从文件中移除它们。
 *
 * 面向外部拥有调度器、通过 `query()` 派生 agent 的 daemon 架构；
 * agent 子进程（`-p` 模式）本身不运行调度器。
 *
 * @internal
 */
export function watchScheduledTasks(_opts: {
  dir: string
  signal: AbortSignal
  getJitterConfig?: () => CronJitterConfig
}): ScheduledTasksHandle {
  throw new Error('not implemented')
}

/**
 * 将错过的一次性任务格式化为 prompt，要求模型在执行前通过
 * AskUserQuestion 向用户确认。
 * @internal
 */
export function buildMissedTaskNotification(_missed: CronTask[]): string {
  throw new Error('not implemented')
}

/**
 * 用户在 claude.ai 上输入的消息，从 bridge WS 中提取。
 * @internal
 */
export type InboundPrompt = {
  content: string | unknown[]
  uuid?: string
}

/**
 * connectRemoteControl 的选项。
 * @internal
 */
export type ConnectRemoteControlOptions = {
  dir: string
  name?: string
  workerType?: string
  branch?: string
  gitRepoUrl?: string | null
  getAccessToken: () => string | undefined
  baseUrl: string
  orgUUID: string
  model: string
}

/**
 * connectRemoteControl 返回的 handle。向其中 write query() 的 yield，
 * 从中读取 inbound prompt。完整字段说明见 src/assistant/daemonBridge.ts。
 * @internal
 */
export type RemoteControlHandle = {
  sessionUrl: string
  environmentId: string
  bridgeSessionId: string
  write(msg: SDKMessage): void
  sendResult(): void
  sendControlRequest(req: unknown): void
  sendControlResponse(res: unknown): void
  sendControlCancelRequest(requestId: string): void
  inboundPrompts(): AsyncGenerator<InboundPrompt>
  controlRequests(): AsyncGenerator<unknown>
  permissionResponses(): AsyncGenerator<unknown>
  onStateChange(
    cb: (
      state: 'ready' | 'connected' | 'reconnecting' | 'failed',
      detail?: string,
    ) => void,
  ): void
  teardown(): Promise<void>
}

/**
 * 从 daemon 进程持有的 claude.ai remote-control bridge 连接。
 *
 * daemon 在父进程中持有 WebSocket —— 若 agent 子进程（通过 `query()`
 * 派生）崩溃，daemon 会重启它，而 claude.ai 保持同一会话。与之对照，
 * `query.enableRemoteControl` 把 WS 放在子进程中（随 agent 一起消亡）。
 *
 * 通过 `write()` + `sendResult()` 注入 `query()` 的 yield。
 * 从 `inboundPrompts()`（用户在 claude.ai 输入）读取并喂给 `query()`
 * 的输入流。本地处理 `controlRequests()`（interrupt → abort、set_model
 * → 重配置）。
 *
 * 跳过 `tengu_ccr_bridge` gate 与 policy-limits 检查 —— @internal
 * 调用方已预先获得授权。仍需 OAuth（环境变量或 keychain）。
 *
 * 若未 OAuth 或注册失败则返回 null。
 *
 * @internal
 */
export async function connectRemoteControl(
  _opts: ConnectRemoteControlOptions,
): Promise<RemoteControlHandle | null> {
  throw new Error('not implemented')
}

/** 会话钩子事件名（与 `HOOK_EVENTS` / settings schema 一致）。 */
export type HookEvent = (typeof HOOK_EVENTS)[number] // 与 `coreSchemas.HOOK_EVENTS` 逐项对应

/** `SessionEnd` 钩子等使用的进程退出原因枚举。 */
export type ExitReason = (typeof EXIT_REASONS)[number] // 与 `coreSchemas.EXIT_REASONS` 逐项对应
