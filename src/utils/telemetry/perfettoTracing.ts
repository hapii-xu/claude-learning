/**
 * Claude Code 的 Perfetto 追踪（仅限 Anthropic 内部）
 *
 * 本模块生成 Chrome Trace Event 格式的追踪数据，可在
 * ui.perfetto.dev 或 Chrome 的 chrome://tracing 中查看。
 *
 * 注意：此功能仅限 Anthropic 内部，外部构建中会被消除。
 *
 * 追踪文件包括：
 * - Agent 层级关系（swarm 中的父子关系）
 * - API 请求（含 TTFT、TTLT、提示长度、缓存统计、消息 ID、推测标记）
 * - 工具执行（含名称、耗时和 token 使用量）
 * - 用户输入等待时间
 *
 * 用法：
 * 1. 通过 CLAUDE_CODE_PERFETTO_TRACE=1 或 CLAUDE_CODE_PERFETTO_TRACE=<路径> 启用
 * 2. 可选设置 CLAUDE_CODE_PERFETTO_WRITE_INTERVAL_S=<正整数> 以周期性写入
 *    追踪文件（默认：仅在退出时写入）。
 * 3. 正常运行 Claude Code
 * 4. 追踪文件写入 ~/.claude/traces/trace-<session-id>.json
 *    或指定路径
 * 5. 在 ui.perfetto.dev 中打开以可视化
 */

import { feature } from 'bun:bundle'
import { mkdirSync, writeFileSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { getSessionId } from '../../bootstrap/state.js'
import { registerCleanup } from '../cleanupRegistry.js'
import { logForDebugging } from '../debug.js'
import {
  getClaudeConfigHomeDir,
  isEnvDefinedFalsy,
  isEnvTruthy,
} from '../envUtils.js'
import { errorMessage } from '../errors.js'
import { djb2Hash } from '../hash.js'
import { jsonStringify } from '../slowOperations.js'
import { getAgentId, getAgentName, getParentSessionId } from '../teammate.js'

/**
 * Chrome Trace Event 格式类型
 * 参见：https://docs.google.com/document/d/1CvAClvFfyA5R-PhYUmn5OOQtYMH4h6I0nSsKchNAySU
 */

export type TraceEventPhase =
  | 'B' // 开始持续时间事件
  | 'E' // 结束持续时间事件
  | 'X' // 完成事件（含持续时间）
  | 'i' // 即时事件
  | 'C' // 计数器事件
  | 'b' // 异步开始
  | 'n' // 异步即时
  | 'e' // 异步结束
  | 'M' // 元数据事件

export type TraceEvent = {
  name: string
  cat: string
  ph: TraceEventPhase
  ts: number // 时间戳（微秒）
  pid: number // 进程 ID（主进程用 1，子 agent 用 agent ID）
  tid: number // 线程 ID（使用 agent 名称的数字哈希或主进程用 1）
  dur?: number // 持续时间（微秒，用于 'X' 事件）
  args?: Record<string, unknown>
  id?: string // 用于异步事件
  scope?: string
}

/**
 * 用于追踪层级关系的 Agent 信息
 */
type AgentInfo = {
  agentId: string
  agentName: string
  parentAgentId?: string
  processId: number
  threadId: number
}

/**
 * 用于追踪开始/结束对的待定 span
 */
type PendingSpan = {
  name: string
  category: string
  startTime: number
  agentInfo: AgentInfo
  args: Record<string, unknown>
}

// Perfetto 追踪器的全局状态
let isEnabled = false
let tracePath: string | null = null
// 元数据事件（ph: 'M' — 进程/线程名称、父级链接）单独存放，
// 以便在驱逐后仍能保留 — Perfetto UI 需要它们来标记轨道。
// 受 agent 数量限制（每个 agent 约 3 个事件）。
const metadataEvents: TraceEvent[] = []
const events: TraceEvent[] = []
// events[] 上限。Cron 驱动的会话可能运行数天；22 个推送点 × 多轮
// 对话否则会无限增长（periodicWrite 刷新到磁盘但不会截断 —
// 它写入完整快照）。每个事件约 300B，总计约 30MB，足以覆盖
// 任何调试会话的追踪历史。驱逐时丢弃最旧的一半，摊还 O(1)。
const MAX_EVENTS = 100_000
const pendingSpans = new Map<string, PendingSpan>()
const agentRegistry = new Map<string, AgentInfo>()
let totalAgentCount = 0
let startTimeMs = 0
let spanIdCounter = 0
let traceWritten = false // 避免重复写入的标志

// 将 agent ID 映射为数字进程 ID（Perfetto 需要数字 ID）
let processIdCounter = 1
const agentIdToProcessId = new Map<string, number>()

// 周期性写入间隔句柄
let writeIntervalId: ReturnType<typeof setInterval> | null = null

const STALE_SPAN_TTL_MS = 30 * 60 * 1000 // 30 分钟
const STALE_SPAN_CLEANUP_INTERVAL_MS = 60 * 1000 // 1 分钟
let staleSpanCleanupId: ReturnType<typeof setInterval> | null = null

/**
 * 将字符串转换为数字哈希，用作线程 ID
 */
function stringToNumericHash(str: string): number {
  return Math.abs(djb2Hash(str)) || 1 // 确保非零
}

/**
 * 获取或创建 agent 的数字进程 ID
 */
function getProcessIdForAgent(agentId: string): number {
  const existing = agentIdToProcessId.get(agentId)
  if (existing !== undefined) return existing

  processIdCounter++
  agentIdToProcessId.set(agentId, processIdCounter)
  return processIdCounter
}

/**
 * 获取当前 agent 信息
 */
function getCurrentAgentInfo(): AgentInfo {
  const agentId = getAgentId() ?? getSessionId()
  const agentName = getAgentName() ?? 'main'
  const parentSessionId = getParentSessionId()

  // 检查是否已注册此 agent
  const existing = agentRegistry.get(agentId)
  if (existing) return existing

  const info: AgentInfo = {
    agentId,
    agentName,
    parentAgentId: parentSessionId,
    processId: agentId === getSessionId() ? 1 : getProcessIdForAgent(agentId),
    threadId: stringToNumericHash(agentName),
  }

  agentRegistry.set(agentId, info)
  totalAgentCount++
  return info
}

/**
 * 获取相对于追踪起始时间的微秒级时间戳
 */
function getTimestamp(): number {
  return (Date.now() - startTimeMs) * 1000
}

/**
 * 生成唯一的 span ID
 */
function generateSpanId(): string {
  return `span_${++spanIdCounter}`
}

/**
 * 驱逐超过 STALE_SPAN_TTL_MS 的待定 span。
 * 镜像 sessionTracing.ts 中的 TTL 清理模式。
 */
function evictStaleSpans(): void {
  const now = getTimestamp()
  const ttlUs = STALE_SPAN_TTL_MS * 1000 // 将毫秒转换为微秒
  for (const [spanId, span] of pendingSpans) {
    if (now - span.startTime > ttlUs) {
      // 发送结束事件使 span 在追踪中显示为不完整
      events.push({
        name: span.name,
        cat: span.category,
        ph: 'E',
        ts: now,
        pid: span.agentInfo.processId,
        tid: span.agentInfo.threadId,
        args: {
          ...span.args,
          evicted: true,
          duration_ms: (now - span.startTime) / 1000,
        },
      })
      pendingSpans.delete(spanId)
    }
  }
}

/**
 * 构建完整的追踪文档（Chrome Trace JSON 格式）。
 */
function buildTraceDocument(): string {
  return jsonStringify({
    traceEvents: [...metadataEvents, ...events],
    metadata: {
      session_id: getSessionId(),
      trace_start_time: new Date(startTimeMs).toISOString(),
      agent_count: totalAgentCount,
      total_event_count: metadataEvents.length + events.length,
    },
  })
}

/**
 * 当 events[] 超过 MAX_EVENTS 时丢弃最旧的一半。
 * 从 stale-span 清理间隔（60 秒）调用。半批量 splice
 * 保持摊还 O(1) — 不需要每次 push 都付出 splice 开销。
 * 插入一个合成标记使间隙在 ui.perfetto.dev 中可见。
 */
function evictOldestEvents(): void {
  if (events.length < MAX_EVENTS) return
  const dropped = events.splice(0, MAX_EVENTS / 2)
  events.unshift({
    name: 'trace_truncated',
    cat: '__metadata',
    ph: 'i',
    ts: dropped[dropped.length - 1]?.ts ?? 0,
    pid: 1,
    tid: 0,
    args: { dropped_events: dropped.length },
  })
  logForDebugging(
    `[Perfetto] 已驱逐 ${dropped.length} 个最旧事件（上限 ${MAX_EVENTS}）`,
  )
}

/**
 * 初始化 Perfetto 追踪
 * 在应用生命周期早期调用
 */
export function initializePerfettoTracing(): void {
  const envValue = process.env.CLAUDE_CODE_PERFETTO_TRACE
  logForDebugging(
    `[Perfetto] initializePerfettoTracing 已调用，环境变量值：${envValue}`,
  )

  // 用 feature() 包裹以实现死代码消除 — 整个代码块在外部构建中移除
  if (feature('PERFETTO_TRACING')) {
    if (!envValue || isEnvDefinedFalsy(envValue)) {
      logForDebugging('[Perfetto] 追踪已禁用（环境变量未设置或已禁用）')
      return
    }

    isEnabled = true
    startTimeMs = Date.now()

    // 确定追踪文件路径
    if (isEnvTruthy(envValue)) {
      const tracesDir = join(getClaudeConfigHomeDir(), 'traces')
      tracePath = join(tracesDir, `trace-${getSessionId()}.json`)
    } else {
      // 使用提供的路径
      tracePath = envValue
    }

    logForDebugging(
      `[Perfetto] 追踪已启用，将写入：${tracePath}，isEnabled=${isEnabled}`,
    )

    // 如果 CLAUDE_CODE_PERFETTO_WRITE_INTERVAL_S 为正整数，启动周期性全量追踪写入
    const intervalSec = parseInt(
      process.env.CLAUDE_CODE_PERFETTO_WRITE_INTERVAL_S ?? '',
      10,
    )
    if (intervalSec > 0) {
      writeIntervalId = setInterval(() => {
        void periodicWrite()
      }, intervalSec * 1000)
      // 不让间隔定时器单独阻止进程退出
      if (writeIntervalId.unref) writeIntervalId.unref()
      logForDebugging(`[Perfetto] 周期性写入已启用，间隔：${intervalSec}秒`)
    }

    // 启动过期 span 清理间隔
    staleSpanCleanupId = setInterval(() => {
      evictStaleSpans()
      evictOldestEvents()
    }, STALE_SPAN_CLEANUP_INTERVAL_MS)
    if (staleSpanCleanupId.unref) staleSpanCleanupId.unref()

    // 注册清理回调以在退出时写入最终追踪
    registerCleanup(async () => {
      logForDebugging('[Perfetto] 清理回调已触发')
      await writePerfettoTrace()
    })

    // 同时注册 beforeExit 处理器作为后备
    // 确保即使清理注册表未被调用也能写入追踪
    process.on('beforeExit', () => {
      logForDebugging('[Perfetto] beforeExit 处理器已触发')
      void writePerfettoTrace()
    })

    // 注册同步退出处理器作为最后手段
    // 这是确保在进程退出前写入追踪的最终后备
    process.on('exit', () => {
      if (!traceWritten) {
        logForDebugging('[Perfetto] exit 处理器已触发，同步写入追踪')
        writePerfettoTraceSync()
      }
    })

    // 为主进程发送元数据事件
    const mainAgent = getCurrentAgentInfo()
    emitProcessMetadata(mainAgent)
  }
}

/**
 * 为进程/agent 发送元数据事件
 */
function emitProcessMetadata(agentInfo: AgentInfo): void {
  if (!isEnabled) return

  // 进程名称
  metadataEvents.push({
    name: 'process_name',
    cat: '__metadata',
    ph: 'M',
    ts: 0,
    pid: agentInfo.processId,
    tid: 0,
    args: { name: agentInfo.agentName },
  })

  // 线程名称（暂时与进程名相同）
  metadataEvents.push({
    name: 'thread_name',
    cat: '__metadata',
    ph: 'M',
    ts: 0,
    pid: agentInfo.processId,
    tid: agentInfo.threadId,
    args: { name: agentInfo.agentName },
  })

  // 如果可用，添加父级信息
  if (agentInfo.parentAgentId) {
    metadataEvents.push({
      name: 'parent_agent',
      cat: '__metadata',
      ph: 'M',
      ts: 0,
      pid: agentInfo.processId,
      tid: 0,
      args: {
        parent_agent_id: agentInfo.parentAgentId,
      },
    })
  }
}

/**
 * 检查 Perfetto 追踪是否已启用
 */
export function isPerfettoTracingEnabled(): boolean {
  return isEnabled
}

/**
 * 在追踪中注册新 agent
 * 在子 agent/团队成员被创建时调用
 */
export function registerAgent(
  agentId: string,
  agentName: string,
  parentAgentId?: string,
): void {
  if (!isEnabled) return

  const info: AgentInfo = {
    agentId,
    agentName,
    parentAgentId,
    processId: getProcessIdForAgent(agentId),
    threadId: stringToNumericHash(agentName),
  }

  agentRegistry.set(agentId, info)
  totalAgentCount++
  emitProcessMetadata(info)
}

/**
 * 从追踪中注销 agent。
 * 在 agent 完成、失败或被中止时调用以释放内存。
 */
export function unregisterAgent(agentId: string): void {
  if (!isEnabled) return
  agentRegistry.delete(agentId)
  agentIdToProcessId.delete(agentId)
}

/**
 * 开始 API 调用 span
 */
export function startLLMRequestPerfettoSpan(args: {
  model: string
  promptTokens?: number
  messageId?: string
  isSpeculative?: boolean
  querySource?: string
}): string {
  if (!isEnabled) return ''

  const spanId = generateSpanId()
  const agentInfo = getCurrentAgentInfo()

  pendingSpans.set(spanId, {
    name: 'API Call',
    category: 'api',
    startTime: getTimestamp(),
    agentInfo,
    args: {
      model: args.model,
      prompt_tokens: args.promptTokens,
      message_id: args.messageId,
      is_speculative: args.isSpeculative ?? false,
      query_source: args.querySource,
    },
  })

  // 发送开始事件
  events.push({
    name: 'API Call',
    cat: 'api',
    ph: 'B',
    ts: pendingSpans.get(spanId)!.startTime,
    pid: agentInfo.processId,
    tid: agentInfo.threadId,
    args: pendingSpans.get(spanId)!.args,
  })

  return spanId
}

/**
 * 结束 API 调用 span 并附带响应元数据
 */
export function endLLMRequestPerfettoSpan(
  spanId: string,
  metadata: {
    ttftMs?: number
    ttltMs?: number
    promptTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
    messageId?: string
    success?: boolean
    error?: string
    /** 成功请求前的预请求准备耗时（客户端创建、重试） */
    requestSetupMs?: number
    /** 每次尝试开始的时间戳（Date.now()）— 用于发送重试子 span */
    attemptStartTimes?: number[]
  },
): void {
  if (!isEnabled || !spanId) return

  const pending = pendingSpans.get(spanId)
  if (!pending) return

  const endTime = getTimestamp()
  const duration = endTime - pending.startTime

  const promptTokens =
    metadata.promptTokens ?? (pending.args.prompt_tokens as number | undefined)
  const ttftMs = metadata.ttftMs
  const ttltMs = metadata.ttltMs
  const outputTokens = metadata.outputTokens
  const cacheReadTokens = metadata.cacheReadTokens

  // 计算派生指标
  // ITPS：每秒输入 token 数（提示处理速度）
  const itps =
    ttftMs !== undefined && promptTokens !== undefined && ttftMs > 0
      ? Math.round((promptTokens / (ttftMs / 1000)) * 100) / 100
      : undefined

  // OTPS：每秒输出 token 数（采样速度）
  const samplingMs =
    ttltMs !== undefined && ttftMs !== undefined ? ttltMs - ttftMs : undefined
  const otps =
    samplingMs !== undefined && outputTokens !== undefined && samplingMs > 0
      ? Math.round((outputTokens / (samplingMs / 1000)) * 100) / 100
      : undefined

  // 缓存命中率：提示 token 中来自缓存的百分比
  const cacheHitRate =
    cacheReadTokens !== undefined &&
    promptTokens !== undefined &&
    promptTokens > 0
      ? Math.round((cacheReadTokens / promptTokens) * 10000) / 100
      : undefined

  const requestSetupMs = metadata.requestSetupMs
  const attemptStartTimes = metadata.attemptStartTimes

  // 合并元数据与原始参数
  const args = {
    ...pending.args,
    ttft_ms: ttftMs,
    ttlt_ms: ttltMs,
    prompt_tokens: promptTokens,
    output_tokens: outputTokens,
    cache_read_tokens: cacheReadTokens,
    cache_creation_tokens: metadata.cacheCreationTokens,
    message_id: metadata.messageId ?? pending.args.message_id,
    success: metadata.success ?? true,
    error: metadata.error,
    duration_ms: duration / 1000,
    request_setup_ms: requestSetupMs,
    // 派生指标
    itps,
    otps,
    cache_hit_rate_pct: cacheHitRate,
  }

  // 当存在可测量的准备时间时发送请求准备子 span
  // （客户端创建、参数构建、成功尝试前的重试）
  const setupUs =
    requestSetupMs !== undefined && requestSetupMs > 0
      ? requestSetupMs * 1000
      : 0
  if (setupUs > 0) {
    const setupEndTs = pending.startTime + setupUs

    events.push({
      name: 'Request Setup',
      cat: 'api,setup',
      ph: 'B',
      ts: pending.startTime,
      pid: pending.agentInfo.processId,
      tid: pending.agentInfo.threadId,
      args: {
        request_setup_ms: requestSetupMs,
        attempt_count: attemptStartTimes?.length ?? 1,
      },
    })

    // 在请求准备内发送重试尝试子 span。
    // 每次失败尝试从其开始运行到下一次尝试的开始。
    if (attemptStartTimes && attemptStartTimes.length > 1) {
      // attemptStartTimes[0] 是参考点（第一次尝试）。
      // 将挂钟时间差转换为 Perfetto 相对微秒。
      const baseWallMs = attemptStartTimes[0]!
      for (let i = 0; i < attemptStartTimes.length - 1; i++) {
        const attemptStartUs =
          pending.startTime + (attemptStartTimes[i]! - baseWallMs) * 1000
        const attemptEndUs =
          pending.startTime + (attemptStartTimes[i + 1]! - baseWallMs) * 1000

        events.push({
          name: `Attempt ${i + 1} (retry)`,
          cat: 'api,retry',
          ph: 'B',
          ts: attemptStartUs,
          pid: pending.agentInfo.processId,
          tid: pending.agentInfo.threadId,
          args: { attempt: i + 1 },
        })
        events.push({
          name: `Attempt ${i + 1} (retry)`,
          cat: 'api,retry',
          ph: 'E',
          ts: attemptEndUs,
          pid: pending.agentInfo.processId,
          tid: pending.agentInfo.threadId,
        })
      }
    }

    events.push({
      name: 'Request Setup',
      cat: 'api,setup',
      ph: 'E',
      ts: setupEndTs,
      pid: pending.agentInfo.processId,
      tid: pending.agentInfo.threadId,
    })
  }

  // 发送首 Token 和采样阶段的子 span（在 API Call 结束之前）
  // 使用 B/E 对按正确的嵌套顺序以获得正确的 Perfetto 可视化
  if (ttftMs !== undefined) {
    // 首 Token 在请求准备之后开始（如果有）
    const firstTokenStartTs = pending.startTime + setupUs
    const firstTokenEndTs = firstTokenStartTs + ttftMs * 1000

    // 首 Token 阶段：从成功尝试开始到首个 token
    events.push({
      name: 'First Token',
      cat: 'api,ttft',
      ph: 'B',
      ts: firstTokenStartTs,
      pid: pending.agentInfo.processId,
      tid: pending.agentInfo.threadId,
      args: {
        ttft_ms: ttftMs,
        prompt_tokens: promptTokens,
        itps,
        cache_hit_rate_pct: cacheHitRate,
      },
    })
    events.push({
      name: 'First Token',
      cat: 'api,ttft',
      ph: 'E',
      ts: firstTokenEndTs,
      pid: pending.agentInfo.processId,
      tid: pending.agentInfo.threadId,
    })

    // 采样阶段：从首 token 到末 token
    // 注意：samplingMs = ttltMs - ttftMs 仍包含 ttltMs 中的准备时间，
    // 因此我们将 span 的实际采样持续时间计算为从首 token 到
    // API 调用结束（endTime）的时间，而不是直接使用 samplingMs。
    const actualSamplingMs =
      ttltMs !== undefined ? ttltMs - ttftMs - setupUs / 1000 : undefined
    if (actualSamplingMs !== undefined && actualSamplingMs > 0) {
      events.push({
        name: 'Sampling',
        cat: 'api,sampling',
        ph: 'B',
        ts: firstTokenEndTs,
        pid: pending.agentInfo.processId,
        tid: pending.agentInfo.threadId,
        args: {
          sampling_ms: actualSamplingMs,
          output_tokens: outputTokens,
          otps,
        },
      })
      events.push({
        name: 'Sampling',
        cat: 'api,sampling',
        ph: 'E',
        ts: firstTokenEndTs + actualSamplingMs * 1000,
        pid: pending.agentInfo.processId,
        tid: pending.agentInfo.threadId,
      })
    }
  }

  // 发送 API Call 结束事件（在子 span 之后）
  events.push({
    name: pending.name,
    cat: pending.category,
    ph: 'E',
    ts: endTime,
    pid: pending.agentInfo.processId,
    tid: pending.agentInfo.threadId,
    args,
  })

  pendingSpans.delete(spanId)
}

/**
 * 开始工具执行 span
 */
export function startToolPerfettoSpan(
  toolName: string,
  args?: Record<string, unknown>,
): string {
  if (!isEnabled) return ''

  const spanId = generateSpanId()
  const agentInfo = getCurrentAgentInfo()

  pendingSpans.set(spanId, {
    name: `Tool: ${toolName}`,
    category: 'tool',
    startTime: getTimestamp(),
    agentInfo,
    args: {
      tool_name: toolName,
      ...args,
    },
  })

  // 发送开始事件
  events.push({
    name: `Tool: ${toolName}`,
    cat: 'tool',
    ph: 'B',
    ts: pendingSpans.get(spanId)!.startTime,
    pid: agentInfo.processId,
    tid: agentInfo.threadId,
    args: pendingSpans.get(spanId)!.args,
  })

  return spanId
}

/**
 * 结束工具执行 span
 */
export function endToolPerfettoSpan(
  spanId: string,
  metadata?: {
    success?: boolean
    error?: string
    resultTokens?: number
  },
): void {
  if (!isEnabled || !spanId) return

  const pending = pendingSpans.get(spanId)
  if (!pending) return

  const endTime = getTimestamp()
  const duration = endTime - pending.startTime

  const args = {
    ...pending.args,
    success: metadata?.success ?? true,
    error: metadata?.error,
    result_tokens: metadata?.resultTokens,
    duration_ms: duration / 1000,
  }

  // 发送结束事件
  events.push({
    name: pending.name,
    cat: pending.category,
    ph: 'E',
    ts: endTime,
    pid: pending.agentInfo.processId,
    tid: pending.agentInfo.threadId,
    args,
  })

  pendingSpans.delete(spanId)
}

/**
 * 开始用户输入等待 span
 */
export function startUserInputPerfettoSpan(context?: string): string {
  if (!isEnabled) return ''

  const spanId = generateSpanId()
  const agentInfo = getCurrentAgentInfo()

  pendingSpans.set(spanId, {
    name: 'Waiting for User Input',
    category: 'user_input',
    startTime: getTimestamp(),
    agentInfo,
    args: {
      context,
    },
  })

  // 发送开始事件
  events.push({
    name: 'Waiting for User Input',
    cat: 'user_input',
    ph: 'B',
    ts: pendingSpans.get(spanId)!.startTime,
    pid: agentInfo.processId,
    tid: agentInfo.threadId,
    args: pendingSpans.get(spanId)!.args,
  })

  return spanId
}

/**
 * 结束用户输入等待 span
 */
export function endUserInputPerfettoSpan(
  spanId: string,
  metadata?: {
    decision?: string
    source?: string
  },
): void {
  if (!isEnabled || !spanId) return

  const pending = pendingSpans.get(spanId)
  if (!pending) return

  const endTime = getTimestamp()
  const duration = endTime - pending.startTime

  const args = {
    ...pending.args,
    decision: metadata?.decision,
    source: metadata?.source,
    duration_ms: duration / 1000,
  }

  // 发送结束事件
  events.push({
    name: pending.name,
    cat: pending.category,
    ph: 'E',
    ts: endTime,
    pid: pending.agentInfo.processId,
    tid: pending.agentInfo.threadId,
    args,
  })

  pendingSpans.delete(spanId)
}

/**
 * 发送即时事件（标记）
 */
export function emitPerfettoInstant(
  name: string,
  category: string,
  args?: Record<string, unknown>,
): void {
  if (!isEnabled) return

  const agentInfo = getCurrentAgentInfo()

  events.push({
    name,
    cat: category,
    ph: 'i',
    ts: getTimestamp(),
    pid: agentInfo.processId,
    tid: agentInfo.threadId,
    args,
  })
}

/**
 * 发送计数器事件以跟踪指标随时间的变化
 */
export function emitPerfettoCounter(
  name: string,
  values: Record<string, number>,
): void {
  if (!isEnabled) return

  const agentInfo = getCurrentAgentInfo()

  events.push({
    name,
    cat: 'counter',
    ph: 'C',
    ts: getTimestamp(),
    pid: agentInfo.processId,
    tid: agentInfo.threadId,
    args: values,
  })
}

/**
 * 开始交互 span（包装完整的用户请求周期）
 */
export function startInteractionPerfettoSpan(userPrompt?: string): string {
  if (!isEnabled) return ''

  const spanId = generateSpanId()
  const agentInfo = getCurrentAgentInfo()

  pendingSpans.set(spanId, {
    name: 'Interaction',
    category: 'interaction',
    startTime: getTimestamp(),
    agentInfo,
    args: {
      user_prompt_length: userPrompt?.length,
    },
  })

  // 发送开始事件
  events.push({
    name: 'Interaction',
    cat: 'interaction',
    ph: 'B',
    ts: pendingSpans.get(spanId)!.startTime,
    pid: agentInfo.processId,
    tid: agentInfo.threadId,
    args: pendingSpans.get(spanId)!.args,
  })

  return spanId
}

/**
 * 结束交互 span
 */
export function endInteractionPerfettoSpan(spanId: string): void {
  if (!isEnabled || !spanId) return

  const pending = pendingSpans.get(spanId)
  if (!pending) return

  const endTime = getTimestamp()
  const duration = endTime - pending.startTime

  // 发送结束事件
  events.push({
    name: pending.name,
    cat: pending.category,
    ph: 'E',
    ts: endTime,
    pid: pending.agentInfo.processId,
    tid: pending.agentInfo.threadId,
    args: {
      ...pending.args,
      duration_ms: duration / 1000,
    },
  })

  pendingSpans.delete(spanId)
}

// ---------------------------------------------------------------------------
// 周期性写入辅助函数
// ---------------------------------------------------------------------------

/**
 * 停止周期性写入定时器。
 */
function stopWriteInterval(): void {
  if (staleSpanCleanupId) {
    clearInterval(staleSpanCleanupId)
    staleSpanCleanupId = null
  }
  if (writeIntervalId) {
    clearInterval(writeIntervalId)
    writeIntervalId = null
  }
}

/**
 * 在会话结束时强制关闭所有剩余的未关闭 span。
 */
function closeOpenSpans(): void {
  for (const [spanId, pending] of pendingSpans) {
    const endTime = getTimestamp()
    events.push({
      name: pending.name,
      cat: pending.category,
      ph: 'E',
      ts: endTime,
      pid: pending.agentInfo.processId,
      tid: pending.agentInfo.threadId,
      args: {
        ...pending.args,
        incomplete: true,
        duration_ms: (endTime - pending.startTime) / 1000,
      },
    })
    pendingSpans.delete(spanId)
  }
}

/**
 * 将完整追踪写入磁盘。错误会被记录但吞掉，
 * 以免临时 I/O 问题导致会话崩溃 — 下一次周期性 tick
 * （或最终退出写入）会用完整快照重试。
 */
async function periodicWrite(): Promise<void> {
  if (!isEnabled || !tracePath || traceWritten) return

  try {
    await mkdir(dirname(tracePath), { recursive: true })
    await writeFile(tracePath, buildTraceDocument())
    logForDebugging(
      `[Perfetto] 周期性写入：${events.length} 个事件到 ${tracePath}`,
    )
  } catch (error) {
    logForDebugging(`[Perfetto] 周期性写入失败：${errorMessage(error)}`, {
      level: 'error',
    })
  }
}

/**
 * 最终异步写入：关闭未完成的 span 并写入完整追踪。
 * 幂等 — 成功时设置 `traceWritten` 使后续调用为空操作。
 */
async function writePerfettoTrace(): Promise<void> {
  if (!isEnabled || !tracePath || traceWritten) {
    logForDebugging(
      `[Perfetto] 跳过最终写入：isEnabled=${isEnabled}, tracePath=${tracePath}, traceWritten=${traceWritten}`,
    )
    return
  }

  stopWriteInterval()
  closeOpenSpans()

  logForDebugging(
    `[Perfetto] writePerfettoTrace 已调用：events=${events.length}`,
  )

  try {
    await mkdir(dirname(tracePath), { recursive: true })
    await writeFile(tracePath, buildTraceDocument())
    traceWritten = true
    logForDebugging(`[Perfetto] 追踪已最终化于：${tracePath}`)
  } catch (error) {
    logForDebugging(`[Perfetto] 最终追踪写入失败：${errorMessage(error)}`, {
      level: 'error',
    })
  }
}

/**
 * 最终同步写入（用于进程 'exit' 处理器的后备，该处理器不允许异步操作）。
 */
function writePerfettoTraceSync(): void {
  if (!isEnabled || !tracePath || traceWritten) {
    logForDebugging(
      `[Perfetto] 跳过最终同步写入：isEnabled=${isEnabled}, tracePath=${tracePath}, traceWritten=${traceWritten}`,
    )
    return
  }

  stopWriteInterval()
  closeOpenSpans()

  logForDebugging(
    `[Perfetto] writePerfettoTraceSync 已调用：events=${events.length}`,
  )

  try {
    const dir = dirname(tracePath)
    // eslint-disable-next-line custom-rules/no-sync-fs -- 仅在 process.on('exit') 处理器中调用
    mkdirSync(dir, { recursive: true })
    // eslint-disable-next-line custom-rules/no-sync-fs, eslint-plugin-n/no-sync -- 进程 'exit' 处理器不支持异步，必须使用同步写入
    writeFileSync(tracePath, buildTraceDocument())
    traceWritten = true
    logForDebugging(`[Perfetto] 追踪已同步最终化于：${tracePath}`)
  } catch (error) {
    logForDebugging(`[Perfetto] 同步最终追踪写入失败：${errorMessage(error)}`, {
      level: 'error',
    })
  }
}

/**
 * 获取所有已记录的事件（用于测试）
 */
export function getPerfettoEvents(): TraceEvent[] {
  return [...metadataEvents, ...events]
}

/**
 * 重置追踪器状态（用于测试）
 */
export function resetPerfettoTracer(): void {
  if (staleSpanCleanupId) {
    clearInterval(staleSpanCleanupId)
    staleSpanCleanupId = null
  }
  stopWriteInterval()
  metadataEvents.length = 0
  events.length = 0
  pendingSpans.clear()
  agentRegistry.clear()
  agentIdToProcessId.clear()
  totalAgentCount = 0
  processIdCounter = 1
  spanIdCounter = 0
  isEnabled = false
  tracePath = null
  startTimeMs = 0
  traceWritten = false
}

/**
 * 立即触发周期性写入（用于测试）
 */
export async function triggerPeriodicWriteForTesting(): Promise<void> {
  await periodicWrite()
}

/**
 * 立即驱逐过期 span（用于测试）
 */
export function evictStaleSpansForTesting(): void {
  evictStaleSpans()
}

export const MAX_EVENTS_FOR_TESTING = MAX_EVENTS
export function evictOldestEventsForTesting(): void {
  evictOldestEvents()
}
