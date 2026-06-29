import type { AgentAdapterRegistry } from './agentAdapter.js'
import type {
  AgentRunParams,
  AgentRunResult,
  JournalEntry,
  ProgressEvent,
} from './types.js'

/**
 * 不透明的宿主句柄。核心层为每次工具调用构造一个，包含 toolUseContext/
 * canUseTool/parentMessage 等。本包从不检查其内部结构，仅将其透传给 AgentRunner。
 * 这是本包与核心层之间唯一的耦合接缝，且该接缝是不透明的。
 */
const HOST_HANDLE = Symbol('workflow.hostHandle')

export type HostBundle = unknown

export type HostHandle = { readonly [HOST_HANDLE]: HostBundle }

/** 由核心层 hostFactory 使用：将任意 bundle 包装成不透明句柄。 */
export function createHostHandle(bundle: HostBundle): HostHandle {
  return { [HOST_HANDLE]: bundle } as HostHandle
}

/** 类型守卫。 */
export function isHostHandle(value: unknown): value is HostHandle {
  return (
    typeof value === 'object' &&
    value !== null &&
    HOST_HANDLE in (value as object)
  )
}

/** 由核心层适配器使用：解包（只有适配器应调用此函数）。 */
export function unwrapHostHandle(handle: HostHandle): HostBundle {
  return (handle as { [k: symbol]: HostBundle })[HOST_HANDLE]
}

/** agent() hook 的后端。 */
export type AgentRunner = {
  runAgentToResult(
    params: AgentRunParams,
    host: HostHandle,
  ): Promise<AgentRunResult>
}

/** 进度事件发射器。 */
export type ProgressEmitter = {
  emit(event: ProgressEvent): void
}

/** 后台任务生命周期管理。 */
export type TaskRegistrar = {
  /**
   * 注册后台任务。适配器创建 AbortController 并将其存入任务状态，
   * 返回 runId 和 signal（引擎用于脱离式执行 + kill 时中止）。
   */
  register(
    opts: {
      workflowName: string
      workflowFile?: string
      summary?: string
      toolUseId?: string
      /** 恢复时，复用现有 runId（读取其 journal）。省略则生成新 id。 */
      runId?: string
    },
    host: HostHandle,
  ): { runId: string; signal: AbortSignal }
  complete(runId: string, summary?: string): void
  fail(runId: string, error: string): void
  kill(runId: string): void
  /**
   * 注册 agent 级 AbortController。后端在启动 agent 时调用，使 service
   * .kill(runId, agentId) 能精确中止单个 agent（不影响同一运行中的其他 agent）。
   * 幂等：以相同 agentId 重复注册会覆盖。
   */
  registerAgentAbort?(runId: string, agentId: number, ac: AbortController): void
  /**
   * 注销 agent 级 AbortController（agent 完成/失败时调用；幂等）。
   */
  unregisterAgentAbort?(runId: string, agentId: number): void
  /**
   * 中止单个 agent。返回是否命中（false = agent 已完成/不存在）。
   * 不影响同一运行中的其他 agent；workflow 继续执行（被中止的 agent 返回 dead → null）。
   */
  killAgent?(runId: string, agentId: number): boolean
  /** 返回当前待处理的 skip/retry 动作，或 null。 */
  pendingAction(runId: string): { kind: 'skip' | 'retry' } | null
}

/** journal 持久化。 */
export type JournalStore = {
  read(runId: string): Promise<JournalEntry[]>
  append(runId: string, entry: JournalEntry): Promise<void>
  truncate(runId: string): Promise<void>
}

/** 取消 / 权限门控。 */
export type PermissionGate = {
  isAborted(host: HostHandle): boolean
}

/** 日志 + 遥测。 */
export type Logger = {
  debug(msg: string): void
  event(name: string, metadata?: Record<string, unknown>): void
  /**
   * 警告级日志（例如单个 parallel/pipeline 条目失败时被吞掉的错误）。
   * 可选：旧版 ports 实现可省略；hooks 通过 `?.()` 兼容。
   */
  warn?(msg: string): void
}

/** 引擎从宿主提取的即用上下文（句柄 + 基本字段）。 */
export type WorkflowHostContext = {
  /** 透传给 AgentRunner 的不透明句柄（含 toolUseContext/canUseTool/parentMessage）。 */
  handle: HostHandle
  cwd: string
  /** token 预算上限；null 表示不限。 */
  budgetTotal: number | null
  /** 核心层的工具使用 id（透传给任务注册）。 */
  toolUseId?: string
}

/**
 * 由核心层提供：从工具调用的核心上下文构造 WorkflowHostContext。
 * 参数对本包不透明（unknown）；核心层的 hostFactory 知道真实类型。
 */
export type HostFactory = (args: {
  context: unknown
  canUseTool: unknown
  parentMessage: unknown
}) => WorkflowHostContext

/** 所有 port 的聚合。注入到 createWorkflowTool(ports) 中。 */
export type WorkflowPorts = {
  agentRunner: AgentRunner
  /**
   * 多后端适配器注册表。提供时优先于 agentRunner——hooks.agent 通过注册表路由到 adapter.run；
   * 省略时回退到 agentRunner（向后兼容）。
   */
  agentAdapterRegistry?: AgentAdapterRegistry
  progressEmitter: ProgressEmitter
  taskRegistrar: TaskRegistrar
  journalStore: JournalStore
  permissionGate: PermissionGate
  logger: Logger
  hostFactory: HostFactory
}
