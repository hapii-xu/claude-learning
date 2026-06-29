import { MAX_ITEMS_PER_CALL, MAX_TOTAL_AGENTS } from '../constants.js'
import type {
  AgentProgressUpdate,
  AgentRunParams,
  AgentRunResult,
  JournalEntry,
  ProgressEvent,
} from '../types.js'
import type { EngineContext } from './context.js'
import { WorkflowAbortedError, WorkflowError } from './errors.js'
import { agentCallKey } from './journal.js'
import type { WorkflowHooks } from './script.js'

/** workflow() hook 的子 workflow 执行器（由 runWorkflow 注入，以避免循环依赖）。 */
export type SubWorkflowRunner = (opts: {
  name?: string
  scriptPath?: string
  script?: string
  args?: unknown
}) => Promise<unknown>

type HookProgressInit =
  | { type: 'phase_started'; phase: string }
  | { type: 'phase_done'; phase: string }
  | { type: 'agent_started'; agentId: number; label?: string; phase?: string }
  | {
      type: 'agent_done'
      agentId: number
      label?: string
      phase?: string
      result: AgentRunResult
    }
  | {
      type: 'agent_progress'
      agentId: number
      label?: string
      phase?: string
      tokenCount: number
      toolCount: number
    }
  | { type: 'log'; message: string }

export function makeHooks(
  ctx: EngineContext,
  runSubWorkflow: SubWorkflowRunner,
): WorkflowHooks {
  // 所有进度事件自动注入 runId，使适配器能将其路由到对应任务（支持多 workflow 并发）
  const emit = (init: HookProgressInit): void => {
    ctx.ports.progressEmitter.emit({
      runId: ctx.runId,
      ...init,
    } as ProgressEvent)
  }

  const agent: WorkflowHooks['agent'] = async (prompt, opts = {}) => {
    const r = ctx.resources
    if (r.agentCountBox.value >= MAX_TOTAL_AGENTS) {
      throw new WorkflowError(
        `workflow exceeds total agent cap (${MAX_TOTAL_AGENTS})`,
      )
    }

    // 为每次 agent() 调用（含 journal 命中）分配唯一 id；打上 started/done 戳使 reducer 能精确关联
    const agentId = r.agentIdSeq.value++

    const params: AgentRunParams = { prompt, ...opts }
    const key = agentCallKey(prompt, params)
    const label = opts.label as string | undefined
    const phase =
      (opts.phase as string | undefined) ?? ctx.currentPhase ?? undefined

    // journal 命中 → 直接返回缓存结果
    if (!ctx.journalInvalidated && ctx.journalIndex < ctx.journal.length) {
      const entry = ctx.journal[ctx.journalIndex]!
      if (entry.key === key) {
        ctx.journalIndex++
        emit({
          type: 'agent_done',
          agentId,
          label,
          phase,
          result: entry.result,
        })
        return resultToOutput(entry.result)
      }
      // 发生分歧：丢弃后续 journal 条目；从此处起全部实时运行
      ctx.journalInvalidated = true
      ctx.journal = ctx.journal.slice(0, ctx.journalIndex)
      await ctx.ports.journalStore.truncate(ctx.runId)
    }

    let release: () => void
    try {
      release = await ctx.resources.semaphore.acquire(ctx.signal)
    } catch {
      // 中止期间的等待队列：信号量已移除等待者且未消耗许可
      throw new WorkflowAbortedError()
    }
    try {
      if (ctx.signal.aborted) throw new WorkflowAbortedError()
      // 预算检查在信号量临界区内执行：排队等待者唤醒时看到最新的已消耗值，
      // 否则 N 个在 spent=0 时入队的等待者全部通过检查，唤醒后无需重检即超支。
      // journal 命中路径不计费预算，无需检查。
      r.budget.assertCanSpend()

      const pending = ctx.ports.taskRegistrar.pendingAction(ctx.runId)
      if (pending?.kind === 'skip') {
        const result: AgentRunResult = { kind: 'skipped' }
        emit({ type: 'agent_done', agentId, label, phase, result })
        return null
      }

      ctx.resources.agentCountBox.value++
      emit({ type: 'agent_started', agentId, label, phase })
      const registry = ctx.ports.agentAdapterRegistry
      // onProgress 闭包：后端循环累积 token/tool 计数 → 发出 agent_progress 事件（携带 agentId 用于关联）
      const onProgress = (update: AgentProgressUpdate): void => {
        emit({ type: 'agent_progress', agentId, label, phase, ...update })
      }
      // 注入 agent 级 AbortController 的 register/unregister：后端创建 controller 后调用
      // registerAgentAbort 注入 ports 层绑定；service.kill(runId, agentId) 据此精确中止单个 agent。
      // 注册表不存在时（agentRunner 回退路径），没有后端中间层，
      // ports 层的 agentAbortControllers 始终为空——单 agent kill 在此路径退化为空操作。
      const adapterCtx = registry
        ? {
            host: ctx.host,
            signal: ctx.signal,
            runId: ctx.runId,
            agentId,
            onProgress,
            ...(ctx.ports.taskRegistrar.registerAgentAbort
              ? {
                  registerAgentAbort: (
                    id: number,
                    ac: AbortController,
                  ): void => {
                    ctx.ports.taskRegistrar.registerAgentAbort?.(
                      ctx.runId,
                      id,
                      ac,
                    )
                  },
                }
              : {}),
            ...(ctx.ports.taskRegistrar.unregisterAgentAbort
              ? {
                  unregisterAgentAbort: (id: number): void => {
                    ctx.ports.taskRegistrar.unregisterAgentAbort?.(
                      ctx.runId,
                      id,
                    )
                  },
                }
              : {}),
          }
        : null
      // resolve 在 try 外执行：配置错误（如 AdapterNotFoundError）直接传播，不重试——
      // 这是 workflow 配置问题而非暂时的后端故障；重试无意义且会掩盖 bug。
      const adapter = registry ? registry.resolve(params) : null
      const invokeBackend = (): Promise<AgentRunResult> =>
        adapter
          ? adapter.run(params, adapterCtx!)
          : ctx.ports.agentRunner.runAgentToResult(params, ctx.host)

      // 失败时自动重试一次：dead（多次重试后的终态 API 错误）或非中止抛出均可获得一次重试机会；
      // WorkflowAbortedError（kill）不重试——这是用户意图。
      // 重试仍失败：dead 保持 dead；抛出降级为 dead（单个 agent 不应拖垮 workflow）。
      // 预算不会双重计费：dead 不调用 addOutputTokens；重试成功只在最终 ok 时计费一次。
      // dead.reason 传递给日志：no-structured-output（agent 最终文本块未产出纯对象 JSON）
      // 是高频死亡原因；记录 detail 可立即看到 agent 最后说了什么。
      // detail 防御性地用 String() 包装：旧 journal 或第三方适配器可能写入非字符串（数据损坏），
      // 直接调用 .slice 会抛出 TypeError 并穿透日志路径。
      let result: AgentRunResult
      try {
        result = await invokeBackend()
        if (result.kind === 'dead') {
          const detailStr =
            typeof result.detail === 'string' ? result.detail : ''
          ctx.ports.logger.warn?.(
            `agent "${label ?? `#${agentId}`}" returned dead` +
              (result.reason ? ` (${result.reason})` : '') +
              (detailStr ? `: ${detailStr.slice(0, 150)}` : '') +
              '; retrying once',
          )
          result = await invokeBackend()
        }
      } catch (e) {
        if (e instanceof WorkflowAbortedError) throw e
        const eMsg = e instanceof Error ? e.message : String(e)
        ctx.ports.logger.warn?.(
          `agent "${label ?? `#${agentId}`}" threw (${eMsg}); retrying once`,
        )
        try {
          result = await invokeBackend()
        } catch (e2) {
          if (e2 instanceof WorkflowAbortedError) throw e2
          // 重试仍抛出：降级为 dead（保持 workflow 继续运行；hooks.agent 返回 null）
          result = {
            kind: 'dead',
            reason: 'runagent-threw',
            detail: e2 instanceof Error ? e2.message : String(e2),
          }
        }
      }
      if (result.kind === 'ok') {
        ctx.resources.budget.addOutputTokens(result.usage.outputTokens)
      }
      emit({ type: 'agent_done', agentId, label, phase, result })

      const entry: JournalEntry = { key, seq: agentId, result }
      // 关键：push 顺序 = 完成顺序（非调用顺序）；read() 已按 seq 重排，
      // 因此恢复时调用顺序与 journal 顺序对齐，key 索引保持稳定。
      ctx.journal.push(entry)
      ctx.journalIndex++
      await ctx.ports.journalStore.append(ctx.runId, entry)
      return resultToOutput(result)
    } finally {
      release()
    }
  }

  const parallel: WorkflowHooks['parallel'] = async thunks => {
    if (thunks.length > MAX_ITEMS_PER_CALL) {
      throw new WorkflowError(
        `parallel exceeds the per-call items cap (${MAX_ITEMS_PER_CALL})`,
      )
    }
    return Promise.all(
      thunks.map(async (t, i) => {
        try {
          return await t()
        } catch (e) {
          // "出错返回 null"的约定不变，但应记录日志——否则 workflow 作者无法定位 agent 失败的原因
          ctx.ports.logger.warn?.(
            `parallel thunk #${i} failed: ${(e as Error).message}`,
          )
          return null
        }
      }),
    )
  }

  const pipeline: WorkflowHooks['pipeline'] = async <T, R>(
    items: readonly T[],
    ...stages: Array<
      (prev: unknown, item: T, index: number) => Promise<unknown>
    >
  ): Promise<Array<R | null>> => {
    if (items.length > MAX_ITEMS_PER_CALL) {
      throw new WorkflowError(
        `pipeline exceeds the per-call items cap (${MAX_ITEMS_PER_CALL})`,
      )
    }
    return Promise.all(
      items.map(async (item, index): Promise<R | null> => {
        try {
          let prev: unknown = item
          for (const stage of stages) {
            prev = await stage(prev, item, index)
          }
          return prev as R
        } catch (e) {
          ctx.ports.logger.warn?.(
            `pipeline item #${index} failed: ${(e as Error).message}`,
          )
          return null
        }
      }),
    )
  }

  const phase: WorkflowHooks['phase'] = title => {
    if (ctx.currentPhase) {
      emit({ type: 'phase_done', phase: ctx.currentPhase })
    }
    ctx.currentPhase = title
    emit({ type: 'phase_started', phase: title })
  }

  const log: WorkflowHooks['log'] = message => {
    emit({ type: 'log', message })
  }

  const workflow: WorkflowHooks['workflow'] = async (nameOrRef, args) => {
    if (ctx.resources.depth >= 1) {
      throw new WorkflowError('workflow() nesting allows only one level')
    }
    const sub: Parameters<SubWorkflowRunner>[0] =
      typeof nameOrRef === 'string'
        ? { name: nameOrRef }
        : { scriptPath: nameOrRef.scriptPath }
    return runSubWorkflow({ ...sub, args })
  }

  return { agent, parallel, pipeline, phase, log, workflow }
}

function resultToOutput(result: AgentRunResult): unknown {
  return result.kind === 'ok' ? result.output : null
}
