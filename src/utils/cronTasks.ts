// 计划提示，存储在 <project>/.claude/scheduled_tasks.json 中。
//
// 任务有两种类型：
//   - 一次性（recurring: false/undefined）—— 触发一次，然后自动删除。
//   - 循环（recurring: true）—— 按计划触发，从现在重新调度，
//     持续存在直到通过 CronDelete 显式删除或在可配置限制后自动过期
//     （DEFAULT_CRON_JITTER_CONFIG.recurringMaxAgeMs）。
//
// 文件格式：
//   { "tasks": [{ id, cron, prompt, createdAt, recurring?, permanent? }] }

import { randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import {
  addSessionCronTask,
  getProjectRoot,
  getSessionCronTasks,
  removeSessionCronTasks,
} from '../bootstrap/state.js'
import { computeNextCronRun, parseCronExpression } from './cron.js'
import { logForDebugging } from './debug.js'
import { isFsInaccessible } from './errors.js'
import { getFsImplementation } from './fsOperations.js'
import { safeParseJSON } from './json.js'
import { logError } from './log.js'
import { jsonStringify } from './slowOperations.js'

export type CronTask = {
  id: string
  /** 5 字段 cron 字符串（本地时间）—— 写入时验证，读取时重新验证。 */
  cron: string
  /** 任务触发时要入队的提示。 */
  prompt: string
  /** 任务创建时的纪元毫秒。用于错过任务检测的锚点。 */
  createdAt: number
  /**
   * 最近一次触发的纪元毫秒。由调度器在每次循环触发后回写，
   * 以便下次触发计算能在进程重启后存活。调度器以
   * `lastFiredAt ?? createdAt` 为锚点首次计算 —— 从未触发的任务
   * 使用 createdAt（对于 `30 14 27 2 *` 这类固定 cron 是正确的，
   * 因为从现在算起下次是明年）；已触发过的任务重建与上次进程
   * 内存中相同的 `nextFireAt`。一次性任务永不设置（触发即删除）。
   */
  lastFiredAt?: number
  /** 为 true 时，任务触发后重新调度而非删除。 */
  recurring?: boolean
  /**
   * 为 true 时，任务不受 recurringMaxAgeMs 自动过期约束。
   * 系统逃逸口，用于 assistant 模式的内置任务（catch-up/
   * morning-checkin/dream）—— 安装器的 writeIfMissing() 跳过
   * 已存在的文件，因此重新安装无法重建它们。不可通过
   * CronCreateTool 设置；仅由 src/assistant/install.ts 直接
   * 写入 scheduled_tasks.json。
   */
  permanent?: boolean
  /**
   * 仅运行时标志。false → 会话范围（永不写入磁盘）。
   * 文件支持的任务将此字段保持为 undefined；writeCronTasks
   * 剥离它，使磁盘上的格式保持为
   * { id, cron, prompt, createdAt, lastFiredAt?, recurring?, permanent? }。
   */
  durable?: boolean
  /**
   * 仅运行时。设置时，表示任务由进程内 teammate 创建。
   * 调度器将触发路由到该 teammate 的队列而非主 REPL。
   * 永不写入磁盘（teammate cron 始终为会话范围）。
   */
  agentId?: string
}

type CronFile = { tasks: CronTask[] }

const CRON_FILE_REL = join('.claude', 'scheduled_tasks.json')

/**
 * cron 文件的路径。`dir` 默认为 getProjectRoot() ——
 * 从不经过 main.tsx 运行的上下文（如 Agent SDK daemon，
 * 无引导状态）需显式传入。
 */
export function getCronFilePath(dir?: string): string {
  return join(dir ?? getProjectRoot(), CRON_FILE_REL)
}

/**
 * 读取并解析 .claude/scheduled_tasks.json。若文件缺失、为空
 * 或格式错误则返回空任务列表。cron 字符串无效的任务会被静默
 * 丢弃（在 debug 级别记录），这样单个错误条目不会阻塞整个文件。
 */
export async function readCronTasks(dir?: string): Promise<CronTask[]> {
  const fs = getFsImplementation()
  let raw: string
  try {
    raw = await fs.readFile(getCronFilePath(dir), { encoding: 'utf-8' })
  } catch (e: unknown) {
    if (isFsInaccessible(e)) return []
    logError(e)
    return []
  }

  const parsed = safeParseJSON(raw, false)
  if (!parsed || typeof parsed !== 'object') return []
  const file = parsed as Partial<CronFile>
  if (!Array.isArray(file.tasks)) return []

  const out: CronTask[] = []
  for (const t of file.tasks) {
    if (
      !t ||
      typeof t.id !== 'string' ||
      typeof t.cron !== 'string' ||
      typeof t.prompt !== 'string' ||
      typeof t.createdAt !== 'number'
    ) {
      logForDebugging(
        `[ScheduledTasks] skipping malformed task: ${jsonStringify(t)}`,
      )
      continue
    }
    if (!parseCronExpression(t.cron)) {
      logForDebugging(
        `[ScheduledTasks] skipping task ${t.id} with invalid cron '${t.cron}'`,
      )
      continue
    }
    out.push({
      id: t.id,
      cron: t.cron,
      prompt: t.prompt,
      createdAt: t.createdAt,
      ...(typeof t.lastFiredAt === 'number'
        ? { lastFiredAt: t.lastFiredAt }
        : {}),
      ...(t.recurring ? { recurring: true } : {}),
      ...(t.permanent ? { permanent: true } : {}),
    })
  }
  return out
}

/**
 * 同步检查 cron 文件是否有有效任务。由 cronScheduler.start() 使用
 * 以决定是否自动启用。一次文件读取。
 */
export function hasCronTasksSync(dir?: string): boolean {
  let raw: string
  try {
    // eslint-disable-next-line custom-rules/no-sync-fs -- 从 cronScheduler.start() 调用一次
    raw = readFileSync(getCronFilePath(dir), 'utf-8')
  } catch {
    return false
  }
  const parsed = safeParseJSON(raw, false)
  if (!parsed || typeof parsed !== 'object') return false
  const tasks = (parsed as Partial<CronFile>).tasks
  return Array.isArray(tasks) && tasks.length > 0
}

/**
 * 用给定任务覆盖 .claude/scheduled_tasks.json。若 .claude/ 不存在则创建。
 * 空任务列表会写入空文件（而非删除），这样文件监视器能在
 * 最后一个任务被移除时看到变更事件。
 */
export async function writeCronTasks(
  tasks: CronTask[],
  dir?: string,
): Promise<void> {
  const root = dir ?? getProjectRoot()
  await mkdir(join(root, '.claude'), { recursive: true })
  // 剥离仅运行时的 `durable` 标志 —— 磁盘上的内容按定义
  // 都是持久的，保留该标志意味着 readCronTasks() 会自然地
  // 得到 durable: undefined，无需显式设置。
  const body: CronFile = {
    tasks: tasks.map(({ durable: _durable, ...rest }) => rest),
  }
  await writeFile(
    getCronFilePath(root),
    jsonStringify(body, null, 2) + '\n',
    'utf-8',
  )
}

/**
 * 追加任务。返回生成的 id。调用方负责已验证 cron 字符串
 *（工具通过 validateInput 完成）。
 *
 * 当 `durable` 为 false 时，任务仅保存在进程内存中
 *（bootstrap/state.ts）—— 它会在本次会话中按计划触发，
 * 但永不写入 .claude/scheduled_tasks.json，并随进程终止。
 * 调度器将任务直接合并到其 tick 循环中，因此不需要文件
 * 变更事件。
 */
export async function addCronTask(
  cron: string,
  prompt: string,
  recurring: boolean,
  durable: boolean,
  agentId?: string,
): Promise<string> {
  // 短 ID —— 8 位十六进制对于 MAX_JOBS=50 足够，避免在
  // 工具层（显示短 ID）和磁盘之间进行 slice/prefix 操作。
  const id = randomUUID().slice(0, 8)
  const task = {
    id,
    cron,
    prompt,
    createdAt: Date.now(),
    ...(recurring ? { recurring: true } : {}),
  }
  if (!durable) {
    addSessionCronTask({ ...task, ...(agentId ? { agentId } : {}) })
    return id
  }
  const tasks = await readCronTasks()
  tasks.push(task)
  await writeCronTasks(tasks)
  return id
}

/**
 * 按 id 移除任务。若无匹配则为无操作（如另一个会话抢先）。
 * 用于一次性清理和显式 CronDelete。
 *
 * 当 `dir` 为 undefined（REPL 路径）时，还会清理内存中的
 * 会话存储 —— 调用方不知道 id 存在于哪个存储。Daemon 调用方
 * 显式传入 `dir`；它们没有会话，且 `dir !== undefined` 守卫
 * 阻止此函数在该路径上触及引导状态（测试强制此约束）。
 */
export async function removeCronTasks(
  ids: string[],
  dir?: string,
): Promise<void> {
  if (ids.length === 0) return
  // 先清理会话存储。如果所有 id 都在那里被找到，则完成 ——
  // 完全跳过文件读取。removeSessionCronTasks 在未命中时
  // 是无操作（返回 0），因此预先存在的一次性删除路径会在
  // 不分配的情况下通过。
  if (dir === undefined && removeSessionCronTasks(ids) === ids.length) {
    return
  }
  const idSet = new Set(ids)
  const tasks = await readCronTasks(dir)
  const remaining = tasks.filter(t => !idSet.has(t.id))
  if (remaining.length === tasks.length) return
  await writeCronTasks(remaining, dir)
}

/**
 * 在给定循环任务上标记 `lastFiredAt` 并回写。批量处理
 * 以便一个调度器 tick 中的 N 次触发 = 一次读写修改，而非 N 次。
 * 仅触及文件支持的任务 —— 会话任务随进程终止，无需持久化
 * 其触发时间。若 id 都不匹配则为无操作（任务在触发和写入之间
 * 被删除 —— 如用户在 tick 期间运行了 CronDelete）。
 *
 * 调度器锁意味着最多一个进程调用此函数；chokidar 获取写入
 * 并触发重新加载，从刚写入的 `lastFiredAt` 重新播种
 * `nextFireAt` —— 幂等（相同计算，相同结果）。
 */
export async function markCronTasksFired(
  ids: string[],
  firedAt: number,
  dir?: string,
): Promise<void> {
  if (ids.length === 0) return
  const idSet = new Set(ids)
  const tasks = await readCronTasks(dir)
  let changed = false
  for (const t of tasks) {
    if (idSet.has(t.id)) {
      t.lastFiredAt = firedAt
      changed = true
    }
  }
  if (!changed) return
  await writeCronTasks(tasks, dir)
}

/**
 * 文件支持的任务 + 仅会话的任务，合并。会话任务标记为
 * `durable: false` 以便调用方区分。文件任务按原样返回
 *（durable undefined → 真值）。
 *
 * 仅当 `dir` 为 undefined 时合并 —— daemon 调用方（显式 `dir`）
 * 没有可合并的会话存储。
 */
export async function listAllCronTasks(dir?: string): Promise<CronTask[]> {
  const fileTasks = await readCronTasks(dir)
  if (dir !== undefined) return fileTasks
  const sessionTasks = getSessionCronTasks().map(t => ({
    ...t,
    durable: false as const,
  }))
  return [...fileTasks, ...sessionTasks]
}

/**
 * cron 字符串在 `fromMs` 之后的下次触发时间（纪元毫秒）。
 * 无效或未来 366 天内无匹配时返回 null。
 */
export function nextCronRunMs(cron: string, fromMs: number): number | null {
  const fields = parseCronExpression(cron)
  if (!fields) return null
  const next = computeNextCronRun(fields, new Date(fromMs))
  return next ? next.getTime() : null
}

/**
 * Cron 调度器调优旋钮。运行时从 `tengu_kairos_cron_config`
 * GrowthBook JSON 配置获取（见 cronJitterConfig.ts），
 * 以便运维可以在不发布客户端构建的情况下全集群调整行为。
 * 此处的默认值精确保持预配置行为。
 */
export type CronJitterConfig = {
  /** 循环任务的前向延迟，表示为触发间隔的分数。 */
  recurringFrac: number
  /** 循环任务前向延迟的上限，与间隔长度无关。 */
  recurringCapMs: number
  /** 一次性任务的后向提前量：任务最多可提前触发的毫秒数。 */
  oneShotMaxMs: number
  /**
   * 一次性任务的后向提前量：当 minute-mod 门控匹配时
   * 任务提前触发的最小毫秒数。0 = taskId 哈希接近零的任务
   * 在整点触发。提高此值可保证没有人落在挂钟边界上。
   */
  oneShotFloorMs: number
  /**
   * 抖动触发落在 `minute % N === 0` 的分钟。30 → :00/:30
   *（人类取整热点）。15 → :00/:15/:30/:45。1 → 每分钟。
   */
  oneShotMinuteMod: number
  /**
   * 循环任务在创建后此毫秒数自动过期（除非标记为
   * `permanent`）。Cron 是multi-day会话的主要驱动力
   *（p99 正常运行时间 61 分钟 → #19931 后 53 小时），
   * 无限制的循环让 Tier-1 堆泄漏无限累积。默认值
   *（7 天）覆盖"本周每小时检查我的 PR"的工作流，
   * 同时限制最坏情况的会话生命周期。Permanent 任务
   *（assistant 模式的 catch-up/morning-checkin/dream）
   * 永不过期 —— 它们无法被重建，因为 install.ts 的
   * writeIfMissing() 跳过已存在的文件。
   *
   * `0` = 无限制（任务永不过期）。
   */
  recurringMaxAgeMs: number
}

export const DEFAULT_CRON_JITTER_CONFIG: CronJitterConfig = {
  recurringFrac: 0.1,
  recurringCapMs: 15 * 60 * 1000,
  oneShotMaxMs: 90 * 1000,
  oneShotFloorMs: 0,
  oneShotMinuteMod: 30,
  recurringMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
}

/**
 * taskId 是 8 位十六进制 UUID 切片（见 {@link addCronTask}）→
 * 解析为 u32 → [0, 1)。重启间稳定，在集群中均匀分布。
 * 非十六进制 id（手动编辑的 JSON）回退到 0 = 无抖动。
 */
function jitterFrac(taskId: string): number {
  const frac = parseInt(taskId.slice(0, 8), 16) / 0x1_0000_0000
  return Number.isFinite(frac) ? frac : 0
}

/**
 * 与 {@link nextCronRunMs} 相同，加上确定性每任务延迟，
 * 避免当多个会话调度相同 cron 字符串时出现惊群效应
 *（如 `0 * * * *` → 所有人都在 :00 触发推理）。
 *
 * 延迟与当前触发间隔成正比（{@link CronJitterConfig.recurringFrac}，
 * 上限为 {@link CronJitterConfig.recurringCapMs}），因此在默认值下，
 * 每小时任务分布在 [:00, :06)，但每分钟任务仅分散几秒。
 *
 * 仅用于循环任务。一次性任务使用
 * {@link oneShotJitteredNextCronRunMs}（后向抖动，分钟门控）。
 */
export function jitteredNextCronRunMs(
  cron: string,
  fromMs: number,
  taskId: string,
  cfg: CronJitterConfig = DEFAULT_CRON_JITTER_CONFIG,
): number | null {
  const t1 = nextCronRunMs(cron, fromMs)
  if (t1 === null) return null
  const t2 = nextCronRunMs(cron, t1)
  // 未来一年内无第二次匹配（如固定日期）→ 无比例基准，
  // 且几乎不可能是惊群风险。在 t1 触发。
  if (t2 === null) return t1
  const jitter = Math.min(
    jitterFrac(taskId) * cfg.recurringFrac * (t2 - t1),
    cfg.recurringCapMs,
  )
  return t1 + jitter
}

/**
 * 与 {@link nextCronRunMs} 相同，减去确定性每任务提前量
 *（当触发时间落在匹配 {@link CronJitterConfig.oneShotMinuteMod}
 * 的分钟边界时）。
 *
 * 一次性任务是用户固定的（"下午 3 点提醒我"），因此延迟会
 * 破坏约定 —— 但略微提前触发是无感知的，且能分散所有人
 * 选择相同整点挂钟时间导致的推理峰值。在默认值下
 *（mod 30，最大 90 秒，floor 0），仅 :00 和 :30 被抖动，
 * 因为人类取整到半小时。
 *
 * 在事故期间，运维可以推送 `tengu_kairos_cron_config`，
 * 如 `{oneShotMinuteMod: 15, oneShotMaxMs: 300000, oneShotFloorMs: 30000}`
 * 以将 :00/:15/:30/:45 的触发分散到 [t-5min, t-30s] 窗口 ——
 * 每个任务至少有 30 秒的提前量，因此没有人落在整点上。
 *
 * 检查计算出的触发时间而非 cron 字符串，因此 `0 15 * * *`、
 * 步进表达式和 `0,30 9 * * *` 在落在匹配分钟时都会抖动。
 * 限制到 `fromMs`，以便在自身抖动窗口内创建的任务不会
 * 在创建之前触发。
 */
export function oneShotJitteredNextCronRunMs(
  cron: string,
  fromMs: number,
  taskId: string,
  cfg: CronJitterConfig = DEFAULT_CRON_JITTER_CONFIG,
): number | null {
  const t1 = nextCronRunMs(cron, fromMs)
  if (t1 === null) return null
  // Cron 分辨率为 1 分钟 → 计算时间始终有 :00 秒，
  // 因此分钟字段检查足以识别热点时刻。
  // getMinutes()（本地），而非 getUTCMinutes()：cron 在本地时间
  // 中计算，"用户选择了整点时间"意味着在*他们的*时区中是整点。
  // 在半小时偏移的时区（印度 UTC+5:30）中，本地 :00 是 UTC :30 ——
  // UTC 检查会抖动错误的时刻。
  if (new Date(t1).getMinutes() % cfg.oneShotMinuteMod !== 0) return t1
  // floor + frac * (max - floor) → 在 [floor, max) 上均匀分布。
  // floor=0 时退化为原始的 frac * max。floor>0 时，即使 taskId
  // 哈希为 0 也有 `floor` 毫秒的提前量 —— 没有人落在整点上。
  const lead =
    cfg.oneShotFloorMs +
    jitterFrac(taskId) * (cfg.oneShotMaxMs - cfg.oneShotFloorMs)
  // t1 > fromMs 由 nextCronRunMs 保证（严格之后），因此 max()
  // 仅在任务在自身提前窗口内创建时生效。
  return Math.max(t1 - lead, fromMs)
}

/**
 * 当下次计划运行（从 createdAt 计算）在过去时，任务被视为"错过"。
 * 在启动时展示给用户。适用于一次性和循环任务 —— 循环任务
 * 在 Claude 关闭期间窗口已过期仍被视为"错过"。
 */
export function findMissedTasks(tasks: CronTask[], nowMs: number): CronTask[] {
  return tasks.filter(t => {
    const next = nextCronRunMs(t.cron, t.createdAt)
    return next !== null && next < nowMs
  })
}
