import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getProjectRoot } from '../bootstrap/state.js'
import { logForDebugging } from '../utils/debug.js'
import type { ProgressBus } from './progress/bus.js'
import type { ProgressStore, RunProgress } from './progress/store.js'
import { CLAUDE_DIR_NAME } from 'src/constants/claudeDirName.js'

/** state.json 当前的 schema 版本；升级时引入迁移链。 */
const SCHEMA_VERSION = 1
const STATE_FILE = 'state.json'
const STATE_TMP = 'state.json.tmp'

/**
 * runsDir 的唯一来源：与 ports.ts journalStore 共享同一根（${projectRoot}/.hclaude/workflow-runs）。
 * 抽成函数：消除 ports.ts 与持久化逻辑之间的重复路径拼接，进入 worktree/子目录时仍留在同一根下。
 * 测试中 monkey-patch 该函数指向 tmpdir。
 */
export function getRunsDir(): string {
  return join(getProjectRoot(), CLAUDE_DIR_NAME, 'workflow-runs')
}

type StateFile = {
  schemaVersion: number
  run: RunProgress
}

/**
 * 原子地把终态 RunProgress 覆盖写入 <runsDir>/<runId>/state.json。
 * 原子性：writeFile(tmp) → rename(tmp, target)，rename 是原子的；最坏情况下留下 tmp，下次写入覆盖它。
 * 失败 best-effort：IO 异常只记 warn，不抛出（workflow 已经成功；持久化失败只意味着重启后无法取回）。
 */
export async function writeRunState(
  runsDir: string,
  run: RunProgress,
): Promise<void> {
  const dir = join(runsDir, run.runId)
  const target = join(dir, STATE_FILE)
  const tmp = join(dir, STATE_TMP)
  const payload: StateFile = { schemaVersion: SCHEMA_VERSION, run }
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(tmp, JSON.stringify(payload), 'utf-8')
    await rename(tmp, target)
  } catch (e) {
    logForDebugging(
      `[workflow warn] writeRunState failed for ${run.runId}: ${(e as Error).message}`,
    )
  }
}

/**
 * 容错读取 <runsDir>/<runId>/state.json：
 * - 文件不存在 → null（调用方视为未命中）
 * - JSON 解析失败 / schema 结构不匹配 / schemaVersion 不匹配 → null（记 warn，不崩溃）
 */
export async function readRunState(
  runsDir: string,
  runId: string,
): Promise<RunProgress | null> {
  const target = join(runsDir, runId, STATE_FILE)
  let raw: string
  try {
    raw = await readFile(target, 'utf-8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StateFile>
    if (parsed.schemaVersion !== SCHEMA_VERSION) return null
    const run = parsed.run
    if (!run || typeof run !== 'object') return null
    if (typeof run.runId !== 'string') return null
    if (typeof run.status !== 'string') return null
    return run as RunProgress
  } catch (e) {
    logForDebugging(
      `[workflow warn] readRunState parse failed for ${runId}: ${(e as Error).message}`,
    )
    return null
  }
}

/**
 * 扫描 runsDir 下所有子目录，读取每个 state.json，返回非空 RunProgress 列表。
 * - runsDir 不存在 → 空数组
 * - 没有 state.json 的子目录（写了一半的 run）→ 跳过
 * - state.json 损坏的子目录 → 跳过那一个，继续扫描其余
 * - 按 updatedAt 倒序排序（与 store.list() 的顺序一致）
 */
export async function listPersistedRuns(
  runsDir: string,
): Promise<RunProgress[]> {
  let entries: string[]
  try {
    entries = await readdir(runsDir)
  } catch {
    return []
  }
  const runs: RunProgress[] = []
  for (const name of entries) {
    const run = await readRunState(runsDir, name)
    if (run) runs.push(run)
  }
  return runs.sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * 订阅 bus 的 run_done 事件，把终态 RunProgress 写到磁盘 state.json。
 * 覆盖全部三种终态（completed/failed/killed；shutdown-kill 也路由到 run_done killed）。
 * store 比该订阅先注册到 bus，所以 listener 触发时 store.get(runId) 已是终态。
 * 返回取消订阅函数（用于测试清理）。
 *
 * 磁盘写入是 best-effort：writeRunState 吞掉 IO 异常只记日志，不向外传播 ——
 * 因此其他 bus 订阅者（store 等）不受持久化失败影响。
 *
 * @param runsDirProvider 可选的 runsDir 解析器（默认为 getRunsDir）。
 *   生产路径用默认值；测试注入 tmpdir 以避免写入真实项目目录（Bun ESM 模块命名空间只读，
 *   无法 monkey-patch getRunsDir 本身）。
 */
export function attachRunStatePersistence(
  bus: ProgressBus,
  store: ProgressStore,
  runsDirProvider: () => string = getRunsDir,
): () => void {
  return bus.subscribe(event => {
    if (event.type !== 'run_done') return
    const run = store.get(event.runId)
    if (!run) return
    void writeRunState(runsDirProvider(), run)
  })
}
