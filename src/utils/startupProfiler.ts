/**
 * 启动性能分析工具，用于测量并汇报各初始化阶段耗时。
 *
 * 两种模式：
 * 1. 采样日志：100% 的 ant 用户、0.1% 的外部用户 —— 将各阶段日志上报到 Statsig
 * 2. 详细 profiling：CLAUDE_CODE_PROFILE_STARTUP=1 —— 输出完整报告，含内存快照
 *
 * 使用 Node.js 内置的 performance hooks API 进行标准计时。
 */

import { dirname, join } from 'path'
import { getSessionId } from 'src/bootstrap/state.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import { logForDebugging } from './debug.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from './envUtils.js'
import { getFsImplementation } from './fsOperations.js'
import { formatMs, formatTimelineLine, getPerformance } from './profilerBase.js'
import { writeFileSync_DEPRECATED } from './slowOperations.js'

// 模块级状态 —— 在模块加载时一次性决定
// eslint-disable-next-line custom-rules/no-process-env-top-level
const DETAILED_PROFILING = isEnvTruthy(process.env.CLAUDE_CODE_PROFILE_STARTUP)

// 用于 Statsig 日志的采样：100% ant，0.5% 外部
// 在启动时一次性决定 —— 未被采样的用户无需承担 profiling 成本
const STATSIG_SAMPLE_RATE = 0.005
// eslint-disable-next-line custom-rules/no-process-env-top-level
const STATSIG_LOGGING_SAMPLED =
  process.env.USER_TYPE === 'ant' || Math.random() < STATSIG_SAMPLE_RATE

// 只要开启了详细模式或被 Statsig 采样，就启用 profiling
const SHOULD_PROFILE = DETAILED_PROFILING || STATSIG_LOGGING_SAMPLED

// 单独跟踪内存快照（perf_hooks 不跟踪内存）。
// 仅在 DETAILED_PROFILING 启用时使用。
// 以数组形式存储，追加顺序与 perf.mark() 调用顺序一致，因此
// memorySnapshots[i] 对应 getEntriesByType('mark')[i]。用 Map 按 checkpoint
// 名称做 key 是错误的，因为某些 checkpoint 会触发多次（例如
// loadSettingsFromDisk_start 会在 init 期间触发一次，在 plugins 重置 settings
// 缓存后再触发一次），第二次调用会覆盖第一次的内存快照。
const memorySnapshots: NodeJS.MemoryUsage[] = []

// 用于 Statsig 日志的阶段定义：[startCheckpoint, endCheckpoint]
const PHASE_DEFINITIONS = {
  import_time: ['cli_entry', 'main_tsx_imports_loaded'],
  init_time: ['init_function_start', 'init_function_end'],
  settings_time: ['eagerLoadSettings_start', 'eagerLoadSettings_end'],
  total_time: ['cli_entry', 'main_after_run'],
} as const

// 若启用 profiling，则记录初始 checkpoint
if (SHOULD_PROFILE) {
  // eslint-disable-next-line custom-rules/no-top-level-side-effects
  profileCheckpoint('profiler_initialized')
}

/**
 * 以给定名称记录一个 checkpoint
 */
export function profileCheckpoint(name: string): void {
  if (!SHOULD_PROFILE) return

  const perf = getPerformance()
  perf.mark(name)

  // 仅在启用详细 profiling（环境变量）时捕获内存
  if (DETAILED_PROFILING) {
    memorySnapshots.push(process.memoryUsage())
  }
}

/**
 * 生成所有 checkpoint 的格式化报告。
 * 仅在 DETAILED_PROFILING 启用时可用
 */
function getReport(): string {
  if (!DETAILED_PROFILING) {
    return 'Startup profiling 未启用'
  }

  const perf = getPerformance()
  const marks = perf.getEntriesByType('mark')
  if (marks.length === 0) {
    return '未记录任何 profiling checkpoint'
  }

  const lines: string[] = []
  lines.push('='.repeat(80))
  lines.push('STARTUP PROFILING REPORT')
  lines.push('='.repeat(80))
  lines.push('')

  let prevTime = 0
  for (const [i, mark] of marks.entries()) {
    lines.push(
      formatTimelineLine(
        mark.startTime,
        mark.startTime - prevTime,
        mark.name,
        memorySnapshots[i],
        8,
        7,
      ),
    )
    prevTime = mark.startTime
  }

  const lastMark = marks[marks.length - 1]
  lines.push('')
  lines.push(`Total startup time: ${formatMs(lastMark?.startTime ?? 0)}ms`)
  lines.push('='.repeat(80))

  return lines.join('\n')
}

let reported = false

export function profileReport(): void {
  if (reported) return
  reported = true

  // 上报到 Statsig（采样：100% ant，0.1% 外部）
  logStartupPerf()

  // 若 CLAUDE_CODE_PROFILE_STARTUP=1，则输出详细报告
  if (DETAILED_PROFILING) {
    // 写入文件
    const path = getStartupPerfLogPath()
    const dir = dirname(path)
    const fs = getFsImplementation()
    fs.mkdirSync(dir)
    writeFileSync_DEPRECATED(path, getReport(), {
      encoding: 'utf8',
      flush: true,
    })

    logForDebugging('Startup profiling 报告：')
    logForDebugging(getReport())
  }

  // 清理 startup mark，防止长期运行的进程（daemon、cron）中 PerformanceMark 不断累积。
  // 到这一步之后 startup mark 已不再需要 —— 报告已写入、Statsig 事件已上报。
  const perf = getPerformance()
  perf.clearMarks()
  memorySnapshots.length = 0
}

export function isDetailedProfilingEnabled(): boolean {
  return DETAILED_PROFILING
}

export function getStartupPerfLogPath(): string {
  return join(getClaudeConfigHomeDir(), 'startup-perf', `${getSessionId()}.txt`)
}

/**
 * 将启动性能阶段日志上报到 Statsig。
 * 仅在本次会话启动时被采样的情况下才上报。
 */
export function logStartupPerf(): void {
  // 仅在已被采样时上报（决策在模块加载时做出）
  if (!STATSIG_LOGGING_SAMPLED) return

  const perf = getPerformance()
  const marks = perf.getEntriesByType('mark')
  if (marks.length === 0) return

  // 构建 checkpoint 查询表
  const checkpointTimes = new Map<string, number>()
  for (const mark of marks) {
    checkpointTimes.set(mark.name, mark.startTime)
  }

  // 计算各阶段时长
  const metadata: Record<string, number | undefined> = {}

  for (const [phaseName, [startCheckpoint, endCheckpoint]] of Object.entries(
    PHASE_DEFINITIONS,
  )) {
    const startTime = checkpointTimes.get(startCheckpoint)
    const endTime = checkpointTimes.get(endCheckpoint)

    if (startTime !== undefined && endTime !== undefined) {
      metadata[`${phaseName}_ms`] = Math.round(endTime - startTime)
    }
  }

  // 添加 checkpoint 总数用于调试
  metadata.checkpoint_count = marks.length

  logEvent(
    'tengu_startup_perf',
    metadata as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  )
}
