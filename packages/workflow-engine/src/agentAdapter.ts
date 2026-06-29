// agent 后端适配器抽象。引擎通过 resolve 从注册表取得适配器后调用 run；不关心具体实现
// （Anthropic SDK / 核心 runAgent / OpenAI / 本地模型 / mock 均为适配器实现）。
import type {
  AgentProgressUpdate,
  AgentRunParams,
  AgentRunResult,
} from './types.js'
import type { HostHandle } from './ports.js'

/** 适配器能力声明。引擎/脚本根据此降级（例如后端不支持 schema 时，切换为文本 + 解析模式）。 */
export type AgentAdapterCapabilities = {
  /** 支持 schema 结构化输出（agent(schema) 直接返回对象）。 */
  structuredOutput: boolean
  /** 支持工具调用（只有核心 agent 后端拥有此能力）。 */
  tools?: boolean
  /** 支持流式输出（v1 引擎不消费；保留字段）。 */
  stream?: boolean
}

/** adapter.run 的上下文。 */
export type AgentAdapterContext = {
  /** 透传的不透明宿主句柄（核心适配器使用；独立后端忽略）。 */
  host: HostHandle
  /** 取消信号（与 workflow 信号相同）。 */
  signal: AbortSignal
  /** 当前 workflow 的 runId（用于日志/追踪）。 */
  runId: string
  /**
   * 引擎层 agent 序列号（由 hooks.agentIdSeq 递增；与面板 RunProgress.agents[].id 同源）。
   * 注意：与后端内部创建的核心 AgentId（字符串，用于子 agent 追踪）是不同概念，勿混淆。
   * 此字段是 registerAgentAbort/unregisterAgentAbort 的 key，使 service
   * .kill(runId, agentId) 能精确路由到后端创建的 AbortController。
   */
  agentId: number
  /**
   * 运行中进度上报（后端循环累积 token/tool 数时调用）。可选：独立后端可不实现；
   * 引擎据此发出 agent_progress 事件（闭包携带 agentId/runId 用于关联），面板实时刷新。
   */
  onProgress?: (update: AgentProgressUpdate) => void
  /**
   * 注册 agent 级 AbortController（可选）。后端创建 controller 后调用此方法注入 Map，
   * 使 service.kill(runId, agentId) 能精确中止单个 agent 而不影响其他。
   * 由 hooks.agent 在调用 backend.run 前注入。
   */
  registerAgentAbort?: (agentId: number, ac: AbortController) => void
  /**
   * 注销 agent 级 AbortController（agent 完成或失败时调用；幂等）。
   * 与 registerAgentAbort 配对使用。
   */
  unregisterAgentAbort?: (agentId: number) => void
}

/**
 * agent 后端适配器。引擎仅依赖此接口；具体后端实现并注册到注册表中。
 * initialize/dispose 为可选的生命周期 hook（连接池 / 资源管理），由调用方通过
 * registry.initializeAll/disposeAll 触发。
 */
export interface AgentAdapter {
  /** 唯一标识符（注册表路由 / 日志）。 */
  readonly id: string
  /** 能力声明。 */
  readonly capabilities: AgentAdapterCapabilities
  /** 执行一次 agent 调用。 */
  run(params: AgentRunParams, ctx: AgentAdapterContext): Promise<AgentRunResult>
  /** 初始化（由 registry.initializeAll 触发）。 */
  initialize?(): Promise<void>
  /** 销毁（由 registry.disposeAll 触发）。 */
  dispose?(): Promise<void>
}

/** 路由规则：决定哪些参数路由到哪个适配器。按插入顺序匹配；首次命中即返回。 */
export type AdapterRouteRule =
  | { kind: 'agentType'; agentType: string; adapter: string }
  | { kind: 'model'; pattern: string; adapter: string }
  | {
      kind: 'custom'
      match: (params: AgentRunParams) => boolean
      adapter: string
    }

/** 注册表找不到匹配适配器时抛出。 */
export class AdapterNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AdapterNotFoundError'
  }
}

/**
 * 多后端注册表。register 注册适配器，route/default 配置路由，resolve 按规则顺序挑选适配器。
 * 适配器生命周期（initialize/dispose）通过 initializeAll/disposeAll 统一触发
 * （由调用方在运行前/后调用）。
 */
export class AgentAdapterRegistry {
  private readonly adapters = new Map<string, AgentAdapter>()
  private readonly rules: AdapterRouteRule[] = []
  private defaultId: string | null = null

  /** 注册适配器（重复 id 覆盖）。可链式调用。 */
  register(adapter: AgentAdapter): this {
    this.adapters.set(adapter.id, adapter)
    return this
  }

  /** 设置默认适配器（无规则命中时使用）。可链式调用。 */
  default(adapterId: string): this {
    this.defaultId = adapterId
    return this
  }

  /** 添加路由规则（按插入顺序匹配）。可链式调用。 */
  route(rule: AdapterRouteRule): this {
    this.rules.push(rule)
    return this
  }

  has(id: string): boolean {
    return this.adapters.has(id)
  }

  get(id: string): AgentAdapter | undefined {
    return this.adapters.get(id)
  }

  /** 按规则匹配；返回首次命中；无命中则走默认；两者均无则抛出 AdapterNotFoundError。 */
  resolve(params: AgentRunParams): AgentAdapter {
    for (const rule of this.rules) {
      if (matchRule(rule, params)) {
        const hit = this.adapters.get(rule.adapter)
        if (hit) return hit
      }
    }
    if (this.defaultId) {
      const fallback = this.adapters.get(this.defaultId)
      if (fallback) return fallback
    }
    throw new AdapterNotFoundError(
      `No adapter matched (rules=${this.rules.length}, default=${this.defaultId ?? 'none'})`,
    )
  }

  /** 触发所有适配器的 initialize（跳过未实现的）。 */
  async initializeAll(): Promise<void> {
    for (const a of this.adapters.values()) {
      await a.initialize?.()
    }
  }

  /** 触发所有适配器的 dispose（跳过未实现的）。 */
  async disposeAll(): Promise<void> {
    for (const a of this.adapters.values()) {
      await a.dispose?.()
    }
  }
}

function matchRule(rule: AdapterRouteRule, params: AgentRunParams): boolean {
  if (rule.kind === 'agentType') return params.agentType === rule.agentType
  if (rule.kind === 'model') {
    return (
      typeof params.model === 'string' && params.model.startsWith(rule.pattern)
    )
  }
  return rule.match(params) // 自定义规则
}
