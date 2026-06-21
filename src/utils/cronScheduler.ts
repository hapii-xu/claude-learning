// .claude/scheduled_tasks.json 的非 React 调度器核心。
// 由 REPL（通过 useScheduledTasks）和 SDK/-p 模式（print.ts）共享。
//
// 生命周期：轮询 getScheduledTasksEnabled() 直到为 true
//（标志在 CronCreate 运行或 skill on: 触发器触发时翻转）→
// 加载任务 + 监视文件 + 启动 1 秒检查定时器 → 触发时调用
// onFire(prompt)。stop() 拆除所有内容。

import type { FSWatcher } from 'chokidar'
import {
  getScheduledTasksEnabled,
  getSessionCronTasks,
  removeSessionCronTasks,
  setScheduledTasksEnabled,
} from '../bootstrap/state.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import { cronToHuman } from './cron.js'
import {
  type CronJitterConfig,
  type CronTask,
  DEFAULT_CRON_JITTER_CONFIG,
  findMissedTasks,
  getCronFilePath,
  hasCronTasksSync,
  jitteredNextCronRunMs,
  markCronTasksFired,
  oneShotJitteredNextCronRunMs,
  readCronTasks,
  removeCronTasks,
} from './cronTasks.js'
import {
  releaseSchedulerLock,
  tryAcquireSchedulerLock,
} from './cronTasksLock.js'
import { logForDebugging } from './debug.js'

const CHECK_INTERVAL_MS = 1000
const FILE_STABILITY_MS = 300
// 非持有者会话重新探测调度器锁的频率。粒度较粗，
// 因为接管仅在持有者会话崩溃时才有意义。
const LOCK_PROBE_INTERVAL_MS = 5000
/**
 * 当循环任务创建于超过 `maxAgeMs` 之前且应在下次触发时
 * 删除时为 true。Permanent 任务永不过期。`maxAgeMs === 0`
 * 表示无限制（永不过期）。在调用时从
 * {@link CronJitterConfig.recurringMaxAgeMs} 获取。
 * 提取出来以便测试 —— 调度器的 check() 隐藏在
 * setInterval/chokidar/lock 机制之下。
 */
export function isRecurringTaskAged(
  t: CronTask,
  nowMs: number,
  maxAgeMs: number,
): boolean {
  if (maxAgeMs === 0) return false
  return Boolean(t.recurring && !t.permanent && nowMs - t.createdAt >= maxAgeMs)
}

type CronSchedulerOptions = {
  /** 任务触发时调用（常规或启动时的错过任务）。 */
  onFire: (prompt: string) => void
  /** 为 true 时，触发改为推迟到下一个 tick。 */
  isLoading: () => boolean
  /**
   * 为 true 时，绕过 check() 中的 isLoading 门控并在不等待
   * setScheduledTasksEnabled() 的情况下自动启用调度器。
   * 自动启用是关键部分 —— assistant 模式在安装时就在
   * scheduled_tasks.json 中有任务，不应等待 loader skill 翻转
   * 标志。isLoading 绕过在 #20425 之后是次要的（assistant 模式
   * 现在像普通 REPL 一样在轮次间空闲）。
   */
  assistantMode?: boolean
  /**
   * 提供时，接收常规触发的完整 CronTask（且该触发不调用 onFire）。
   * 让 daemon 调用方看到任务 id/cron 等，而非仅提示字符串。
   */
  onFireTask?: (task: CronTask) => void
  /**
   * 提供时，在初始加载时接收错过的一次性任务（且 onFire 不被
   * 预格式化的通知调用）。Daemon 决定如何展示它们。
   */
  onMissed?: (tasks: CronTask[]) => void
  /**
   * 包含 .claude/scheduled_tasks.json 的目录。提供时，调度器
   * 永不触及引导状态：不读取 getProjectRoot/getSessionId，
   * 且跳过 getScheduledTasksEnabled() 轮询（enable() 在 start 时
   * 立即运行）。Agent SDK daemon 调用方必需。
   */
  dir?: string
  /**
   * 写入锁文件的所有者密钥。默认为 getSessionId()。
   * Daemon 调用方必须传递稳定的每进程 UUID，因为它们没有
   * 会话。PID 仍然是活性探测。
   */
  lockIdentity?: string
  /**
   * 返回此 tick 要使用的 cron 抖动配置。每个 check() 周期调用
   * 一次。REPL 调用方传入基于 GrowthBook 的实现
   *（见 cronJitterConfig.ts）以便实时调优 —— 运维可以在
   * :00 负载峰值期间加宽抖动窗口而无需重启客户端。
   * Agent SDK daemon 调用方省略此参数并使用
   * DEFAULT_CRON_JITTER_CONFIG，这是安全的，因为 daemon
   * 在配置变更时无论如何都会重启，且 growthbook.ts → config.ts →
   * commands.ts → REPL 链条不会进入 sdk.mjs。
   */
  getJitterConfig?: () => CronJitterConfig
  /**
   * 紧急停止开关：每个 check() tick 轮询一次。为 true 时，
   * check() 在触发任何东西之前退出 —— 现有 cron 在会话中途
   * 完全停止。CLI 调用方注入 `() => !isKairosCronEnabled()`
   * 以便关闭 tengu_kairos_cron 门控时停止已在运行的调度器
   *（不仅是新的）。Daemon 调用方省略此参数，理由与
   * getJitterConfig 相同。
   */
  isKilled?: () => boolean
  /**
   * 每任务门控，在任何副作用之前应用。返回 false 的任务
   * 对此调度器不可见：永不触发、永不标记 `lastFiredAt`、
   * 永不删除、永不出现在错过列表中、不在 `getNextFireTime()`
   * 中。Daemon cron worker 使用 `t => t.permanent` 以便
   * 同一 scheduled_tasks.json 中的非 permanent 任务不受影响。
   */
  filter?: (t: CronTask) => boolean
}

export type CronScheduler = {
  start: () => void
  stop: () => void
  /**
   * 所有已加载任务中最近计划触发的纪元毫秒，若无计划
   *（无任务或所有任务已在进行中）则为 null。Daemon 调用方
   * 使用此值决定是否拆除空闲的代理子进程或为其预热
   * 以应对即将到来的触发。
   */
  getNextFireTime: () => number | null
}

export function createCronScheduler(
  options: CronSchedulerOptions,
): CronScheduler {
  const {
    onFire,
    isLoading,
    assistantMode = false,
    onFireTask,
    onMissed,
    dir,
    lockIdentity,
    getJitterConfig,
    isKilled,
    filter,
  } = options
  const lockOpts = dir || lockIdentity ? { dir, lockIdentity } : undefined

  // 仅文件支持的任务。会话任务（durable: false）不在此加载 ——
  // 它们可以在会话中途添加/移除而无文件事件，因此 check() 在
  // 每个 tick 从引导状态新鲜读取它们。
  let tasks: CronTask[] = []
  // 每任务下次触发时间（纪元毫秒）。
  const nextFireAt = new Map<string, number>()
  // 已入队"错过任务"提示的 id —— 防止在用户回答之前
  // 每次文件变更时重复询问。
  const missedAsked = new Set<string>()
  // 当前已入队但尚未从文件中移除的任务。防止在
  // removeCronTasks 落地前间隔再次 tick 时双重触发。
  const inFlight = new Set<string>()

  let enablePoll: ReturnType<typeof setInterval> | null = null
  let checkTimer: ReturnType<typeof setInterval> | null = null
  let lockProbeTimer: ReturnType<typeof setInterval> | null = null
  let watcher: FSWatcher | null = null
  let stopped = false
  let isOwner = false

  async function load(initial: boolean) {
    const next = await readCronTasks(dir)
    if (stopped) return
    tasks = next

    // 仅在初始加载时展示错过任务。Chokidar 触发的重新加载
    // 将逾期任务留给 check()（从 createdAt 锚定并立即触发）。
    // 这避免了对会话中途逾期的任务显示误导性的
    // "Claude 未运行时错过"提示。
    //
    // 循环任务不被展示或删除 —— check() 正确处理它们
    //（在首个 tick 触发，向前重新调度）。仅一次性错过任务
    // 需要用户输入（立即运行一次，或永远丢弃）。
    if (!initial) return

    const now = Date.now()
    const missed = findMissedTasks(next, now).filter(
      t => !t.recurring && !missedAsked.has(t.id) && (!filter || filter(t)),
    )
    if (missed.length > 0) {
      for (const t of missed) {
        missedAsked.add(t.id)
        // 防止 check() 在异步 removeCronTasks + chokidar 重新加载
        // 链进行期间重新触发原始提示。
        nextFireAt.set(t.id, Infinity)
      }
      logEvent('tengu_scheduled_task_missed', {
        count: missed.length,
        taskIds: missed
          .map(t => t.id)
          .join(
            ',',
          ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      if (onMissed) {
        onMissed(missed)
      } else {
        onFire(buildMissedTaskNotification(missed))
      }
      void removeCronTasks(
        missed.map(t => t.id),
        dir,
      ).catch(e =>
        logForDebugging(`[ScheduledTasks] failed to remove missed tasks: ${e}`),
      )
      logForDebugging(
        `[ScheduledTasks] surfaced ${missed.length} missed one-shot task(s)`,
      )
    }
  }

  function check() {
    if (isKilled?.()) return
    if (isLoading() && !assistantMode) return
    const now = Date.now()
    const seen = new Set<string>()
    // 本 tick 触发的文件支持循环任务。循环后批量合并到一次
    // markCronTasksFired 调用，使 N 次触发 = 一次写入。会话任务
    // 排除 —— 它们随进程终止，无需持久化。
    const firedFileRecurring: string[] = []
    // 每个 tick 读取一次。REPL 调用方传入基于 GrowthBook 的
    // getJitterConfig，以便配置推送无需重启即可生效。Daemon 和
    // SDK 调用方省略并使用 DEFAULT_CRON_JITTER_CONFIG（安全 ——
    // 抖动是 REPL 集群负载卸除的运维杠杆，非 daemon 关注点）。
    const jitterCfg = getJitterConfig?.() ?? DEFAULT_CRON_JITTER_CONFIG

    // 共享循环体。`isSession` 路由一次性清理路径：
    // 会话任务从内存同步移除，文件任务通过异步
    // removeCronTasks + chokidar 重新加载。
    function process(t: CronTask, isSession: boolean) {
      if (filter && !filter(t)) return
      seen.add(t.id)
      if (inFlight.has(t.id)) return

      let next = nextFireAt.get(t.id)
      if (next === undefined) {
        // 首次出现 —— 从 lastFiredAt（循环）或 createdAt 锚定。
        // 从未触发的循环任务使用 createdAt：如果 isLoading 延迟
        // 此 tick 超过触发时间，从 `now` 锚定会为固定 cron
        //（`30 14 27 2 *`）计算明年。已触发过的任务使用
        // lastFiredAt：下方重新调度将 `now` 写回磁盘，因此下次
        // 进程启动时首次出现计算与我们在内存中设置的相同 newNext。
        // 否则，在空闲时终止的 daemon 子进程会丢失 nextFireAt，
        // 下次启动从 10 天前的 createdAt 重新锚定 → 每个周期
        // 触发每个任务。
        next = t.recurring
          ? (jitteredNextCronRunMs(
              t.cron,
              t.lastFiredAt ?? t.createdAt,
              t.id,
              jitterCfg,
            ) ?? Infinity)
          : (oneShotJitteredNextCronRunMs(
              t.cron,
              t.createdAt,
              t.id,
              jitterCfg,
            ) ?? Infinity)
        nextFireAt.set(t.id, next)
        logForDebugging(
          `[ScheduledTasks] scheduled ${t.id} for ${next === Infinity ? 'never' : new Date(next).toISOString()}`,
        )
      }

      if (now < next) return

      logForDebugging(
        `[ScheduledTasks] firing ${t.id}${t.recurring ? ' (recurring)' : ''}`,
      )
      logEvent('tengu_scheduled_task_fire', {
        recurring: t.recurring ?? false,
        taskId:
          t.id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      if (onFireTask) {
        onFireTask(t)
      } else {
        onFire(t.prompt)
      }

      // 过期的循环任务落入下方的一次性删除路径
      //（会话任务同步移除；文件任务走异步
      // inFlight/chokidar 路径）。最后一次触发，然后被移除。
      const aged = isRecurringTaskAged(t, now, jitterCfg.recurringMaxAgeMs)
      if (aged) {
        const ageHours = Math.floor((now - t.createdAt) / 1000 / 60 / 60)
        logForDebugging(
          `[ScheduledTasks] recurring task ${t.id} aged out (${ageHours}h since creation), deleting after final fire`,
        )
        logEvent('tengu_scheduled_task_expired', {
          taskId:
            t.id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          ageHours,
        })
      }

      if (t.recurring && !aged) {
        // 循环：从现在（而非从 next）重新调度，以避免会话
        // 被阻塞时的快速追赶。抖动使我们每个周期远离
        // 整点挂钟边界。
        const newNext =
          jitteredNextCronRunMs(t.cron, now, t.id, jitterCfg) ?? Infinity
        nextFireAt.set(t.id, newNext)
        // 持久化 lastFiredAt=now，以便下次进程启动在首次出现时
        // 重建相同的 newNext。会话任务跳过 —— 进程本地。
        if (!isSession) firedFileRecurring.push(t.id)
      } else if (isSession) {
        // 一次性（或过期循环）会话任务：同步内存移除。
        // 无 inFlight 窗口 —— 下一个 tick 将读取不包含
        // 此 id 的会话存储。
        removeSessionCronTasks([t.id])
        nextFireAt.delete(t.id)
      } else {
        // 一次性（或过期循环）文件任务：从磁盘删除。
        // inFlight 防止异步 removeCronTasks + chokidar 重新加载
        // 期间的双重触发。
        inFlight.add(t.id)
        void removeCronTasks([t.id], dir)
          .catch(e =>
            logForDebugging(
              `[ScheduledTasks] failed to remove task ${t.id}: ${e}`,
            ),
          )
          .finally(() => inFlight.delete(t.id))
        nextFireAt.delete(t.id)
      }
    }

    // 文件支持的任务：仅当我们持有调度器锁时。锁的存在
    // 是阻止同一 cwd 中的两个 Claude 会话双重触发同一
    // 磁盘任务。
    if (isOwner) {
      for (const t of tasks) process(t, false)
      // 批量 lastFiredAt 写入。inFlight 防止 chokidar 触发的
      // 重新加载期间的双重触发（与下方 removeCronTasks 相同
      // 模式）—— 重新加载用刚写入的 lastFiredAt 重新播种
      // `tasks`，首次出现产生与我们已在内存中设置的相同
      // newNext，因此即使没有 inFlight 也是幂等的。无论如何
      // 添加守卫使语义更清晰。
      if (firedFileRecurring.length > 0) {
        for (const id of firedFileRecurring) inFlight.add(id)
        void markCronTasksFired(firedFileRecurring, now, dir)
          .catch(e =>
            logForDebugging(
              `[ScheduledTasks] failed to persist lastFiredAt: ${e}`,
            ),
          )
          .finally(() => {
            for (const id of firedFileRecurring) inFlight.delete(id)
          })
      }
    }
    // 仅会话任务：进程私有，锁不适用 —— 另一个会话看不到
    // 它们且没有双重触发风险。每个 tick 从引导状态新鲜读取
    //（无 chokidar，无 load()）。在 daemon 路径上跳过
    //（`dir !== undefined`），它永不触及引导状态。
    if (dir === undefined) {
      for (const t of getSessionCronTasks()) process(t, true)
    }

    if (seen.size === 0) {
      // 本 tick 无存活任务 —— 清除整个计划以便
      // getNextFireTime() 返回 null。下方驱逐循环在此不可达
      //（seen 为空），否则陈旧条目会无限期存活并保持
      // daemon 代理预热。
      nextFireAt.clear()
      return
    }
    // 驱逐不再存在的任务的计划条目。当 !isOwner 时，
    // 文件任务 id 不在 `seen` 中并被驱逐 —— 无害：它们
    // 在首个持有 tick 时从 createdAt 重新锚定。
    for (const id of nextFireAt.keys()) {
      if (!seen.has(id)) nextFireAt.delete(id)
    }
  }

  async function enable() {
    if (stopped) return
    if (enablePoll) {
      clearInterval(enablePoll)
      enablePoll = null
    }

    const { default: chokidar } = await import('chokidar')
    if (stopped) return

    // 获取每项目调度器锁。仅持有者会话运行 check()。其他
    // 会话定期探测以在持有者死亡时接管。防止多个 Claude
    // 共享 cwd 时的双重触发。
    isOwner = await tryAcquireSchedulerLock(lockOpts).catch(() => false)
    if (stopped) {
      if (isOwner) {
        isOwner = false
        void releaseSchedulerLock(lockOpts)
      }
      return
    }
    if (!isOwner) {
      lockProbeTimer = setInterval(() => {
        void tryAcquireSchedulerLock(lockOpts)
          .then(owned => {
            if (stopped) {
              if (owned) void releaseSchedulerLock(lockOpts)
              return
            }
            if (owned) {
              isOwner = true
              if (lockProbeTimer) {
                clearInterval(lockProbeTimer)
                lockProbeTimer = null
              }
            }
          })
          .catch(e => logForDebugging(String(e), { level: 'error' }))
      }, LOCK_PROBE_INTERVAL_MS)
      lockProbeTimer.unref?.()
    }

    void load(true)

    const path = getCronFilePath(dir)
    watcher = chokidar.watch(path, {
      persistent: false,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: FILE_STABILITY_MS },
      ignorePermissionErrors: true,
    })
    watcher.on('add', () => void load(false))
    watcher.on('change', () => void load(false))
    watcher.on('unlink', () => {
      if (!stopped) {
        tasks = []
        nextFireAt.clear()
      }
    })

    checkTimer = setInterval(check, CHECK_INTERVAL_MS)
    // 不单独为调度器保持进程存活 —— 在 -p 文本模式中，
    // 即使创建了 cron，进程也应在单轮后退出。
    checkTimer.unref?.()
  }

  return {
    start() {
      stopped = false
      // Daemon 路径（显式给定 dir）：不触及引导状态 ——
      // getScheduledTasksEnabled() 会读取未初始化的标志。
      // Daemon 在请求调度；直接启用。
      if (dir !== undefined) {
        logForDebugging(
          `[ScheduledTasks] scheduler start() — dir=${dir}, hasTasks=${hasCronTasksSync(dir)}`,
        )
        void enable()
        return
      }
      logForDebugging(
        `[ScheduledTasks] scheduler start() — enabled=${getScheduledTasksEnabled()}, hasTasks=${hasCronTasksSync()}`,
      )
      // 当 scheduled_tasks.json 有条目时自动启用。CronCreateTool
      // 在会话中途创建任务时也会设置此值。
      if (
        !getScheduledTasksEnabled() &&
        (assistantMode || hasCronTasksSync())
      ) {
        setScheduledTasksEnabled(true)
      }
      if (getScheduledTasksEnabled()) {
        void enable()
        return
      }
      enablePoll = setInterval(
        en => {
          if (getScheduledTasksEnabled()) void en()
        },
        CHECK_INTERVAL_MS,
        enable,
      )
      enablePoll.unref?.()
    },
    stop() {
      stopped = true
      if (enablePoll) {
        clearInterval(enablePoll)
        enablePoll = null
      }
      if (checkTimer) {
        clearInterval(checkTimer)
        checkTimer = null
      }
      if (lockProbeTimer) {
        clearInterval(lockProbeTimer)
        lockProbeTimer = null
      }
      void watcher?.close()
      watcher = null
      if (isOwner) {
        isOwner = false
        void releaseSchedulerLock(lockOpts)
      }
    },
    getNextFireTime() {
      // nextFireAt 对"永不"使用 Infinity（进行中的一次性任务、
      // 错误的 cron 字符串）。过滤掉这些以便调用方区分
      // "即将触发"和"无待处理"。
      let min = Infinity
      for (const t of nextFireAt.values()) {
        if (t < min) min = t
      }
      return min === Infinity ? null : min
    },
  }
}

/**
 * 构建错过任务的通知文本。指导在任务列表之前，列表包裹在
 * 代码围栏中，以便多行祈使提示不被解释为立即指令，
 * 避免自我提示注入。完整提示体被保留 —— 此路径确实需要
 * 模型在用户确认后执行提示，且任务在模型看到此通知之前
 * 已从 JSON 中删除。
 */
export function buildMissedTaskNotification(missed: CronTask[]): string {
  const plural = missed.length > 1
  const header =
    `The following one-shot scheduled task${plural ? 's were' : ' was'} missed while Claude was not running. ` +
    `${plural ? 'They have' : 'It has'} already been removed from .claude/scheduled_tasks.json.\n\n` +
    `Do NOT execute ${plural ? 'these prompts' : 'this prompt'} yet. ` +
    `First use the AskUserQuestion tool to ask whether to run ${plural ? 'each one' : 'it'} now. ` +
    `Only execute if the user confirms.`

  const blocks = missed.map(t => {
    const meta = `[${cronToHuman(t.cron)}, created ${new Date(t.createdAt).toLocaleString()}]`
    // 使用比提示中任何反引号运行更长一个的围栏，
    // 这样包含 ``` 的提示无法提前关闭围栏并拆开
    // 尾部文本（CommonMark 围栏匹配规则）。
    const longestRun = (t.prompt.match(/`+/g) ?? ([] as string[])).reduce(
      (max: number, run: string) => Math.max(max, run.length),
      0,
    )
    const fence = '`'.repeat(Math.max(3, longestRun + 1))
    return `${meta}\n${fence}\n${t.prompt}\n${fence}`
  })

  return `${header}\n\n${blocks.join('\n\n')}`
}
