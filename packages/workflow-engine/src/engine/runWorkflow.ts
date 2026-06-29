import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { WORKFLOW_DIR_NAME } from '../constants.js'
import type { HostHandle, WorkflowPorts } from '../ports.js'
import type { JournalEntry, WorkflowRunResult } from '../types.js'
import { createEngineContext } from './context.js'
import { WorkflowAbortedError, WorkflowError } from './errors.js'
import { makeHooks, type SubWorkflowRunner } from './hooks.js'
import { resolveNamedWorkflow } from './namedWorkflows.js'
import { parseScript, type ParsedScript } from './script.js'

export type RunWorkflowOptions = {
  /** 已解析的脚本源代码。 */
  script: string
  args?: unknown
  runId: string
  workflowName?: string
  ports: WorkflowPorts
  host: HostHandle
  signal: AbortSignal
  cwd: string
  budgetTotal: number | null
  /** 单次运行的并发槽数；undefined → DEFAULT_MAX_CONCURRENCY。 */
  maxConcurrency?: number
  /** resume: true 时加载现有 journal 并重放。 */
  resume?: boolean
  /** 恢复时脚本源 hash 是否变化。true 时忽略 journal 并全部重新运行。 */
  scriptChanged?: boolean
}

export async function runWorkflow(
  opts: RunWorkflowOptions,
): Promise<WorkflowRunResult> {
  const { ports } = opts

  let parsed: ParsedScript
  try {
    parsed = parseScript(opts.script)
  } catch (e) {
    const error = (e as Error).message
    ports.progressEmitter.emit({
      type: 'run_done',
      runId: opts.runId,
      status: 'failed',
      error,
    })
    return { status: 'failed', error }
  }

  const workflowName = opts.workflowName ?? parsed.meta?.name ?? 'workflow'

  // 加载 journal（仅在恢复且脚本未变时）
  let journal: JournalEntry[] = []
  let journalInvalidated = false
  if (opts.resume && !opts.scriptChanged) {
    journal = await ports.journalStore.read(opts.runId)
  } else if (opts.scriptChanged) {
    await ports.journalStore.truncate(opts.runId)
    journalInvalidated = true
  }

  const ctx = createEngineContext({
    ports,
    host: opts.host,
    signal: opts.signal,
    runId: opts.runId,
    workflowName,
    cwd: opts.cwd,
    budgetTotal: opts.budgetTotal,
    maxConcurrency: opts.maxConcurrency,
    journal,
  })
  if (journalInvalidated) ctx.journalInvalidated = true

  ports.progressEmitter.emit({
    type: 'run_started',
    runId: opts.runId,
    workflowName,
    meta: parsed.meta,
  })

  // 子 workflow 执行器：复用同一 ctx（共享 journal/并发/预算/计数器），临时 depth +1
  const runSubWorkflow: SubWorkflowRunner = async sub => {
    const script = await resolveSubScript(sub, opts.cwd)
    let subParsed: ParsedScript
    try {
      subParsed = parseScript(script)
    } catch (e) {
      throw new WorkflowError(
        `Sub-workflow script error: ${(e as Error).message}`,
      )
    }
    const prevDepth = ctx.resources.depth
    ctx.resources.depth += 1
    try {
      const subHooks = makeHooks(ctx, runSubWorkflow)
      return await subParsed.execute(subHooks, sub.args, ctx.resources.budget)
    } finally {
      ctx.resources.depth = prevDepth
    }
  }

  const hooks = makeHooks(ctx, runSubWorkflow)

  // hook.phase 仅在切换阶段时为上一阶段发出 phase_done；脚本结束时，
  // currentPhase 是最后阶段，无后续 phase() 触发其 phase_done → UI 左侧面板会永远显示运行中
  // （agent 列表已显示 ✓ 完成）。在终态前统一发出一次 —— 所有路径共享。
  const emitTerminalPhaseDone = (): void => {
    if (!ctx.currentPhase) return
    ports.progressEmitter.emit({
      type: 'phase_done',
      runId: opts.runId,
      phase: ctx.currentPhase,
    })
  }

  let result: WorkflowRunResult
  try {
    const returnValue = await parsed.execute(
      hooks,
      opts.args,
      ctx.resources.budget,
    )
    result = { status: 'completed', returnValue }
  } catch (e) {
    if (e instanceof WorkflowAbortedError) {
      result = { status: 'killed' }
    } else {
      result = { status: 'failed', error: (e as Error).message }
    }
  }
  emitTerminalPhaseDone()
  ports.progressEmitter.emit({
    type: 'run_done',
    runId: opts.runId,
    ...result,
  })
  return result
}

async function resolveSubScript(
  sub: { name?: string; scriptPath?: string; script?: string },
  cwd: string,
): Promise<string> {
  if (sub.script) return sub.script
  if (sub.scriptPath) return await readFile(sub.scriptPath, 'utf-8')
  if (sub.name) {
    const found = await resolveNamedWorkflow(
      join(cwd, WORKFLOW_DIR_NAME),
      sub.name,
    )
    if (!found) throw new WorkflowError(`Sub-workflow "${sub.name}" not found`)
    return found.content
  }
  throw new WorkflowError('workflow() requires name or scriptPath')
}
