import {
  listNamedWorkflows,
  parseScript,
  persistInlineScript,
  resolveNamedWorkflow,
  runWorkflow,
  WORKFLOW_DIR_NAME,
  type WorkflowHostContext,
  type WorkflowInput,
  type WorkflowPorts,
} from '@claude-code-best/workflow-engine'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getProjectRoot } from '../bootstrap/state.js'
import { logForDebugging } from '../utils/debug.js'
import { buildHostBundle, makeHostHandle } from './hostHandle.js'
import { installWorkflowNotifications } from './notifications.js'
import {
  attachRunStatePersistence,
  getRunsDir,
  listPersistedRuns,
  readRunState,
} from './persistence.js'
import { createProgressBus } from './progress/bus.js'
import {
  createProgressStoreFromBus,
  type ProgressStore,
  type RunProgress,
} from './progress/store.js'
import { createWorkflowPorts } from './ports.js'
import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import type { ToolUseContext } from '../Tool.js'

/**
 * WorkflowService：工具（U7）和面板（U9）共用的单一入口。
 *
 * - `ports`：共享的 WorkflowPorts；工具描述符透传给引擎。
 * - `launch`：解析 script → parseScript 快速校验 → taskRegistrar.register（拿到 runId+signal）
 *   → 分离式 runWorkflow → 完成时路由到 complete/fail/kill。
 * - `kill/listRuns/getRun/subscribe/listNamed`：面板和工具的辅助查询。
 */
export type WorkflowService = {
  /** 共享 ports（被工具描述符使用）。 */
  ports: WorkflowPorts
  /** 面板/工具启动 workflow：解析 script → 注册 → 分离式 runWorkflow。 */
  launch(
    input: Pick<
      WorkflowInput,
      | 'script'
      | 'name'
      | 'scriptPath'
      | 'args'
      | 'description'
      | 'resumeFromRunId'
      | 'title'
      | 'maxConcurrency'
    >,
    toolUseContext: ToolUseContext,
    canUseTool: CanUseToolFn,
  ): Promise<{ runId: string; scriptPath?: string }>
  kill(runId: string): void
  /**
   * 中止单个 agent（不影响同一 run 中的其他 agent；workflow 继续运行）。
   * 返回是否命中（false = agent 已结束/不存在）。被中止的 agent 返回 dead → null。
   */
  killAgent(runId: string, agentId: number): boolean
  /**
   * 进程退出 / 配置卸载时的清理：杀掉所有运行中的 run，避免孤儿任务。
   * 已完成/失败的 run 不受影响。幂等 —— 可安全多次调用。
   */
  shutdown(): void
  listRuns(): RunProgress[]
  getRun(runId: string): RunProgress | undefined
  /**
   * 按 runId 异步查询：内存命中则返回；未命中则从磁盘读取 state.json（不注入到内存）。
   * 用于"按 runId 获取历史返回"的场景；面板展示请用 loadPersistedRuns + listRuns。
   */
  getRunAsync(runId: string): Promise<RunProgress | undefined>
  /**
   * 扫描磁盘，把所有历史 run 的 state.json 补水进 store（跳过已存在的 runId）。
   * 进程单例仅扫描磁盘一次（persistedLoaded 标志）；重复调用立即返回。
   */
  loadPersistedRuns(): Promise<void>
  subscribe(listener: () => void): () => void
  listNamed(workflowDir?: string): Promise<string[]>
}

let cached: WorkflowService | null = null

/** 进程单例。工具和面板共用同一份 ports/registry/store。 */
export function getWorkflowService(): WorkflowService {
  if (cached) return cached
  const bus = createProgressBus()
  const store = createProgressStoreFromBus(bus)
  const ports = createWorkflowPorts({ bus, store })
  const service = makeService(ports, store)
  // 订阅 run_done，把终态快照写盘（completed/failed/killed 共用入口；shutdown-kill 也路由到这里）。
  // store 比该订阅先注册到 bus，所以 listener 触发时 store.get(runId) 已是终态。
  attachRunStatePersistence(bus, store)
  // 安装状态变化通知桥（commit 0768d4dc 承诺"完成时自动通知"，但旧实现没兑现）
  installWorkflowNotifications(service)
  cached = service
  return cached
}

/**
 * 构造 service（注入 ports + store）。
 *
 * 生产路径走 {@link getWorkflowService}；测试用本函数直接注入 fake ports，
 * 避免触碰到真实的 getProjectRoot/getCwd/analytics 等模块级副作用。
 *
 * @param cwdOverride 仅用于测试：注入临时目录（避免 inline persistence 写入真实项目目录）。
 * @param runsDirProvider 仅用于测试：注入 tmpdir（Bun ESM 模块命名空间只读，无法 monkey-patch getRunsDir）。
 */
export function makeService(
  ports: WorkflowPorts,
  store: ProgressStore,
  cwdOverride?: string,
  runsDirProvider: () => string = getRunsDir,
): WorkflowService {
  const buildHost = (
    toolUseContext: ToolUseContext,
    canUseTool: CanUseToolFn,
  ): WorkflowHostContext => ({
    handle: makeHostHandle(buildHostBundle(toolUseContext, canUseTool)),
    // 使用 projectRoot 以与 ports.ts 的 hostFactory / journalStore 保持同步；
    // 进入 worktree/子目录不会让具名 workflow 解析与 journal 持久化失去同步。
    // cwdOverride 仅用于测试：注入临时目录（避免 inline persistence 写入真实项目目录）。
    cwd: cwdOverride ?? getProjectRoot(),
    budgetTotal: null, // 回合级预算注入点（未来从 settings 读取）
    toolUseId: toolUseContext.toolUseId,
  })

  async function resolveSource(input: {
    script?: string
    name?: string
    scriptPath?: string
  }): Promise<{
    script: string
    workflowFile?: string
    workflowName: string
  }> {
    if (input.script) {
      return { script: input.script, workflowName: 'workflow' }
    }
    if (input.scriptPath) {
      return {
        script: await readFile(input.scriptPath, 'utf-8'),
        workflowFile: input.scriptPath,
        workflowName: 'workflow',
      }
    }
    if (input.name) {
      const dir = join(getProjectRoot(), WORKFLOW_DIR_NAME)
      const found = await resolveNamedWorkflow(dir, input.name)
      if (!found) {
        throw new Error(
          `Named workflow "${input.name}" not found (looked in ${WORKFLOW_DIR_NAME}/)`,
        )
      }
      return {
        script: found.content,
        workflowFile: found.path,
        workflowName: input.name,
      }
    }
    throw new Error('One of script, name, or scriptPath must be provided')
  }

  // loadPersistedRuns 的进程单例标志：首次调用置 true，后续调用立即返回。
  // 扫描失败时重置以允许下次重试。每次 makeService 调用都有自己的闭包变量（测试构建新 service 时重置）。
  let persistedLoaded = false

  return {
    ports,

    async launch(input, toolUseContext, canUseTool) {
      const { script, workflowFile, workflowName } = await resolveSource(input)
      try {
        parseScript(script)
      } catch (e) {
        throw new Error(`Script validation failed: ${(e as Error).message}`)
      }

      const host = buildHost(toolUseContext, canUseTool)
      const { runId, signal } = ports.taskRegistrar.register(
        {
          workflowName,
          ...(workflowFile ? { workflowFile } : {}),
          ...(input.description ? { summary: input.description } : {}),
          ...(host.toolUseId ? { toolUseId: host.toolUseId } : {}),
          ...(input.resumeFromRunId ? { runId: input.resumeFromRunId } : {}),
        },
        host.handle,
      )

      // inline 入口：把 script 持久化到 run 目录（与 WorkflowTool 对称），返回可复用的路径。
      // 写入失败降级（记日志），不阻塞 run（script 已在内存中）。
      let persistedScriptPath: string | undefined
      if (!workflowFile && input.script) {
        try {
          persistedScriptPath = await persistInlineScript(
            input.script,
            runId,
            host.cwd,
          )
        } catch (e) {
          logForDebugging(
            `workflow inline script persist failed: ${(e as Error).message}`,
          )
        }
      }

      // detached：不要 await，让调用方立即拿到 runId；完成时路由给 registrar。
      void runWorkflow({
        script,
        ...(input.args !== undefined ? { args: input.args } : {}),
        runId,
        workflowName,
        ports,
        host: host.handle,
        signal,
        cwd: host.cwd,
        budgetTotal: host.budgetTotal,
        ...(input.maxConcurrency !== undefined
          ? { maxConcurrency: input.maxConcurrency }
          : {}),
        ...(input.resumeFromRunId ? { resume: true } : {}),
      })
        .then(result => {
          if (result.status === 'completed') {
            ports.taskRegistrar.complete(runId)
          } else if (result.status === 'failed') {
            ports.taskRegistrar.fail(runId, result.error ?? 'failed')
          } else {
            ports.taskRegistrar.kill(runId)
          }
        })
        .catch(e => ports.taskRegistrar.fail(runId, (e as Error).message))

      logForDebugging(`workflow launched: ${runId} (${workflowName})`)
      return {
        runId,
        ...(persistedScriptPath ? { scriptPath: persistedScriptPath } : {}),
      }
    },

    kill(runId) {
      ports.taskRegistrar.kill(runId)
    },
    killAgent(runId, agentId) {
      return ports.taskRegistrar.killAgent?.(runId, agentId) ?? false
    },

    shutdown() {
      // 只杀运行中的：已完成/失败的 run taskRegistrar 已回收绑定，kill 是 no-op。
      // taskRegistrar.kill 对未知 runId 是安全 no-op，因此幂等 —— 多次 shutdown 不会反复抛错。
      // 每个 kill 都包裹独立的 try/catch：kill 内部会路由到 setAppState，进程退出阶段触发 React 重渲染
      // 可能抛错（render 已卸载等）；单个失败不应阻塞其他 run 的清理。
      for (const run of store.list()) {
        if (run.status !== 'running') continue
        try {
          ports.taskRegistrar.kill(run.runId)
        } catch (e) {
          logForDebugging(
            `workflow shutdown: kill ${run.runId} failed: ${(e as Error).message}`,
          )
        }
      }
    },

    listRuns: () => store.list(),
    getRun: id => store.get(id),
    async getRunAsync(id) {
      const mem = store.get(id)
      if (mem) return mem
      return (await readRunState(runsDirProvider(), id)) ?? undefined
    },
    async loadPersistedRuns() {
      if (persistedLoaded) return
      persistedLoaded = true
      try {
        const runs = await listPersistedRuns(runsDirProvider())
        for (const run of runs) store.hydrate(run)
      } catch (e) {
        // 扫描失败不阻塞面板：记日志 + 重置标志以允许下次重试
        logForDebugging(
          `[workflow warn] loadPersistedRuns failed: ${(e as Error).message}`,
        )
        persistedLoaded = false
      }
    },
    subscribe: fn => store.subscribe(fn),

    async listNamed(workflowDir) {
      return listNamedWorkflows(
        workflowDir ?? join(getProjectRoot(), WORKFLOW_DIR_NAME),
      )
    },
  }
}

/** 供测试使用：重置单例（避免用例间互相污染）。 */
export function __resetWorkflowServiceForTests(): void {
  cached = null
}

/**
 * 返回已实例化的 service（不会创建）。用于进程退出 / 配置卸载时 peek；
 * 如果 workflow 从未被使用，cached 仍为 null —— 避免在 exit hook 中副作用性地创建 bus/ports。
 */
export function peekWorkflowService(): WorkflowService | null {
  return cached
}
