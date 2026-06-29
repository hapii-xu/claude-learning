// 纯类型定义。无运行时依赖。
// WorkflowInput 已迁移至 tool/schema.ts，通过 z.infer 派生，避免与 schema 产生漂移。

/** 脚本中 `export const meta = {...}` 的结构（必须为纯字面量对象）。 */
export type WorkflowMeta = {
  name: string
  description: string
  whenToUse?: string
  phases?: Array<{ title: string; detail?: string }>
}

/** agent() 传递给 AgentRunner 的参数。 */
export type AgentRunParams = {
  prompt: string
  /** JSON Schema；提供时，agent 返回已校验的对象而非文本。 */
  schema?: object
  model?: string
  /** 输出 token 上限（透传给 agent 后端，例如 LLM 的 max_tokens）。 */
  maxTokens?: number
  /** 自定义子 agent 类型（从注册表解析）。 */
  agentType?: string
  isolation?: 'worktree'
  allowedTools?: string[]
  /** 仅用于展示；不计入 journal key。 */
  label?: string
  /** 仅用于展示；不计入 journal key。 */
  phase?: string
}

/** agent 运行中的进度快照（onProgress 回调负载；后端循环累积 token/tool 数）。 */
export type AgentProgressUpdate = {
  tokenCount: number
  toolCount: number
}

/**
 * AgentRunner 的返回值。ok 变体携带 model/toolCount 供面板展示（可选；独立后端可留空）。
 *
 * dead 携带可选的 reason/detail：journal 历史仅记录 `{kind:"dead"}` 而无附加信息，
 * 因此调试时无法区分"agent 执行完毕但未产生 StructuredOutput"与"runAgent 抛出异常"。
 * reason 使 hooks 重试日志、面板及事后审计可立即看到失败原因。
 */
export type AgentRunResult =
  | {
      kind: 'ok'
      output: string | object
      usage: { outputTokens: number }
      /** 实际解析到的 model id（仅展示）。 */
      model?: string
      /** agent 运行期间的工具调用次数。 */
      toolCount?: number
      /** 完成时的上下文总 token 数（仅展示；与实时 agent_progress 口径一致）。 */
      tokenCount?: number
    }
  | { kind: 'skipped' }
  | {
      kind: 'dead'
      /**
       * 死亡原因分类，用于日志聚合/事后审计。为兼容旧 journal 为可选字段。
       * - no-structured-output：agent 执行完毕但最终内容中没有 StructuredOutput（既未调用工具，也未在文本中产出 JSON）
       * - runagent-threw：runAgent 抛出了非中止错误（API 失败 / 上下文溢出 / 运行时错误）
       * - worktree-failed：isolation:'worktree' 创建失败（失败关闭降级）
       * - unknown：未分类（兼容旧后端 / 第三方适配器）
       */
      reason?:
        | 'no-structured-output'
        | 'runagent-threw'
        | 'worktree-failed'
        | 'unknown'
      /** 供日志使用的详情（错误消息 / 文本预览）；不面向最终用户展示。 */
      detail?: string
    }

/** journal 中的单条记录。seq = agent() 调用序号；read() 按此重排以稳定恢复（resume）顺序。 */
export type JournalEntry = {
  key: string
  /** agent() 调用顺序（来自 agentIdSeq；跨子 workflow 单调递增）。 */
  seq: number
  result: AgentRunResult
}

/** 进度事件。所有变体均携带 runId，使适配器能将事件路由到对应的任务（支持多 workflow 并发）。 */
export type ProgressEvent =
  | {
      type: 'run_started'
      runId: string
      workflowName: string
      meta: WorkflowMeta | null
    }
  | { type: 'phase_started'; runId: string; phase: string }
  | { type: 'phase_done'; runId: string; phase: string }
  | {
      type: 'agent_started'
      runId: string
      agentId: number
      label?: string
      phase?: string
    }
  | {
      type: 'agent_done'
      runId: string
      agentId: number
      label?: string
      phase?: string
      result: AgentRunResult
    }
  | {
      type: 'agent_progress'
      runId: string
      agentId: number
      label?: string
      phase?: string
      tokenCount: number
      toolCount: number
    }
  | { type: 'log'; runId: string; message: string }
  | {
      type: 'run_done'
      runId: string
      status: 'completed' | 'failed' | 'killed'
      returnValue?: unknown
      error?: string
    }

/** 引擎运行结果。 */
export type WorkflowRunResult = {
  status: 'completed' | 'failed' | 'killed'
  returnValue?: unknown
  error?: string
}
