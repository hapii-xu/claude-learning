/**
 * 查询耗时分析工具，用于测量并上报从用户输入到首个 token 到达的整条查询链路耗时。
 * 通过设置 CLAUDE_CODE_PROFILE_QUERY=1 环境变量启用。
 *
 * 基于 Node.js 内置 performance hooks API 进行标准计时。
 * 以详细检查点跟踪每次查询会话，便于定位性能瓶颈。
 *
 * 检查点列表（按顺序）：
 * - query_user_input_received：分析开始
 * - query_context_loading_start/end：加载系统提示词与上下文
 * - query_query_start：REPL 发起 query 调用的入口
 * - query_fn_entry：进入 query() 函数
 * - query_microcompact_start/end：消息微压缩
 * - query_autocompact_start/end：自动压缩检查
 * - query_setup_start/end：StreamingToolExecutor 与模型初始化
 * - query_api_loop_start：API 重试循环开始
 * - query_api_streaming_start：流式 API 调用开始
 * - query_tool_schema_build_start/end：构建工具 schema
 * - query_message_normalization_start/end：消息规范化
 * - query_client_creation_start/end：创建 Anthropic 客户端
 * - query_api_request_sent：HTTP 请求已发出（await 之前，在重试体内）
 * - query_response_headers_received：.withResponse() 已 resolve（响应头已到达）
 * - query_first_chunk_received：收到首个流式 chunk（TTFT）
 * - query_api_streaming_end：流式传输完成
 * - query_tool_execution_start/end：工具执行
 * - query_recursive_call：递归 query 调用前
 * - query_end：查询结束
 */

import { logForDebugging } from './debug.js'
import { isEnvTruthy } from './envUtils.js'
import { formatMs, formatTimelineLine, getPerformance } from './profilerBase.js'

// 模块级状态 —— 模块加载时初始化一次
// eslint-disable-next-line custom-rules/no-process-env-top-level
const ENABLED = isEnvTruthy(process.env.CLAUDE_CODE_PROFILE_QUERY)

// 单独追踪内存快照（perf_hooks 不记录内存）
const memorySnapshots = new Map<string, NodeJS.MemoryUsage>()

// 记录查询次数，用于报告
let queryCount = 0

// 单独追踪首个 token 到达时间，用于汇总统计
let firstTokenTime: number | null = null

/**
 * 开始对新一次查询会话进行性能分析
 */
export function startQueryProfile(): void {
  if (!ENABLED) return

  const perf = getPerformance()

  // 清除上次的标记点和内存快照
  perf.clearMarks()
  memorySnapshots.clear()
  firstTokenTime = null

  queryCount++

  // 记录起始检查点
  queryCheckpoint('query_user_input_received')
}

/**
 * 以指定名称记录一个检查点
 */
export function queryCheckpoint(name: string): void {
  if (!ENABLED) return

  const perf = getPerformance()
  perf.mark(name)
  memorySnapshots.set(name, process.memoryUsage())

  // 单独处理首个 token 的时间戳
  if (name === 'query_first_chunk_received' && firstTokenTime === null) {
    const marks = perf.getEntriesByType('mark')
    if (marks.length > 0) {
      const lastMark = marks[marks.length - 1]
      firstTokenTime = lastMark?.startTime ?? 0
    }
  }
}

/**
 * 结束当前查询的性能分析会话
 */
export function endQueryProfile(): void {
  if (!ENABLED) return

  queryCheckpoint('query_profile_end')
}

/**
 * 识别慢操作（增量 > 100ms）
 */
function getSlowWarning(deltaMs: number, name: string): string {
  // 不将第一个检查点标记为慢 —— 它测量的是从进程启动到此刻的时间，
  // 并非实际处理开销
  if (name === 'query_user_input_received') {
    return ''
  }

  if (deltaMs > 1000) {
    return ` ⚠️  VERY SLOW`
  }
  if (deltaMs > 100) {
    return ` ⚠️  SLOW`
  }

  // 针对已知瓶颈的专项告警
  if (name.includes('git_status') && deltaMs > 50) {
    return ' ⚠️  git status'
  }
  if (name.includes('tool_schema') && deltaMs > 50) {
    return ' ⚠️  tool schemas'
  }
  if (name.includes('client_creation') && deltaMs > 50) {
    return ' ⚠️  client creation'
  }

  return ''
}

/**
 * 获取当前/上次查询所有检查点的格式化报告
 */
function getQueryProfileReport(): string {
  if (!ENABLED) {
    return 'Query profiling not enabled (set CLAUDE_CODE_PROFILE_QUERY=1)'
  }

  const perf = getPerformance()
  const marks = perf.getEntriesByType('mark')
  if (marks.length === 0) {
    return 'No query profiling checkpoints recorded'
  }

  const lines: string[] = []
  lines.push('='.repeat(80))
  lines.push(`QUERY PROFILING REPORT - Query #${queryCount}`)
  lines.push('='.repeat(80))
  lines.push('')

  // 以第一个标记点为基准（查询开始时间），展示相对时间
  const baselineTime = marks[0]?.startTime ?? 0
  let prevTime = baselineTime
  let apiRequestSentTime = 0
  let firstChunkTime = 0

  for (const mark of marks) {
    const relativeTime = mark.startTime - baselineTime
    const deltaMs = mark.startTime - prevTime
    lines.push(
      formatTimelineLine(
        relativeTime,
        deltaMs,
        mark.name,
        memorySnapshots.get(mark.name),
        10,
        9,
        getSlowWarning(deltaMs, mark.name),
      ),
    )

    // 记录关键里程碑用于汇总（使用相对时间）
    if (mark.name === 'query_api_request_sent') {
      apiRequestSentTime = relativeTime
    }
    if (mark.name === 'query_first_chunk_received') {
      firstChunkTime = relativeTime
    }

    prevTime = mark.startTime
  }

  // 计算汇总统计（相对于基准时间）
  const lastMark = marks[marks.length - 1]
  const totalTime = lastMark ? lastMark.startTime - baselineTime : 0

  lines.push('')
  lines.push('-'.repeat(80))

  if (firstChunkTime > 0) {
    const preRequestOverhead = apiRequestSentTime
    const networkLatency = firstChunkTime - apiRequestSentTime
    const preRequestPercent = (
      (preRequestOverhead / firstChunkTime) *
      100
    ).toFixed(1)
    const networkPercent = ((networkLatency / firstChunkTime) * 100).toFixed(1)

    lines.push(`Total TTFT: ${formatMs(firstChunkTime)}ms`)
    lines.push(
      `  - Pre-request overhead: ${formatMs(preRequestOverhead)}ms (${preRequestPercent}%)`,
    )
    lines.push(
      `  - Network latency: ${formatMs(networkLatency)}ms (${networkPercent}%)`,
    )
  } else {
    lines.push(`Total time: ${formatMs(totalTime)}ms`)
  }

  // 追加阶段汇总
  lines.push(getPhaseSummary(marks, baselineTime))

  lines.push('='.repeat(80))

  return lines.join('\n')
}

/**
 * 获取各主要阶段耗时的分阶段汇总
 */
function getPhaseSummary(
  marks: Array<{ name: string; startTime: number }>,
  baselineTime: number,
): string {
  const phases: Array<{ name: string; start: string; end: string }> = [
    {
      name: 'Context loading',
      start: 'query_context_loading_start',
      end: 'query_context_loading_end',
    },
    {
      name: 'Microcompact',
      start: 'query_microcompact_start',
      end: 'query_microcompact_end',
    },
    {
      name: 'Autocompact',
      start: 'query_autocompact_start',
      end: 'query_autocompact_end',
    },
    { name: 'Query setup', start: 'query_setup_start', end: 'query_setup_end' },
    {
      name: 'Tool schemas',
      start: 'query_tool_schema_build_start',
      end: 'query_tool_schema_build_end',
    },
    {
      name: 'Message normalization',
      start: 'query_message_normalization_start',
      end: 'query_message_normalization_end',
    },
    {
      name: 'Client creation',
      start: 'query_client_creation_start',
      end: 'query_client_creation_end',
    },
    {
      name: 'Network TTFB',
      start: 'query_api_request_sent',
      end: 'query_first_chunk_received',
    },
    {
      name: 'Tool execution',
      start: 'query_tool_execution_start',
      end: 'query_tool_execution_end',
    },
  ]

  const markMap = new Map(marks.map(m => [m.name, m.startTime - baselineTime]))

  const lines: string[] = []
  lines.push('')
  lines.push('PHASE BREAKDOWN:')

  for (const phase of phases) {
    const startTime = markMap.get(phase.start)
    const endTime = markMap.get(phase.end)

    if (startTime !== undefined && endTime !== undefined) {
      const duration = endTime - startTime
      const bar = '█'.repeat(Math.min(Math.ceil(duration / 10), 50)) // 每 10ms 一格，最多 50 格
      lines.push(
        `  ${phase.name.padEnd(22)} ${formatMs(duration).padStart(10)}ms ${bar}`,
      )
    }
  }

  // 计算 API 前置开销（api_request_sent 之前的全部耗时）
  const apiRequestSent = markMap.get('query_api_request_sent')
  if (apiRequestSent !== undefined) {
    lines.push('')
    lines.push(
      `  ${'Total pre-API overhead'.padEnd(22)} ${formatMs(apiRequestSent).padStart(10)}ms`,
    )
  }

  return lines.join('\n')
}

/**
 * 将查询性能报告输出到调试日志
 */
export function logQueryProfileReport(): void {
  if (!ENABLED) return
  logForDebugging(getQueryProfileReport())
}
