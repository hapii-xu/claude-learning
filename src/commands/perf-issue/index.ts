import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  getOriginalCwd,
  getSessionId,
  getSessionProjectDir,
} from '../../bootstrap/state.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { sanitizePath } from '../../utils/path.js'
import type { Command, LocalCommandResult } from '../../types/command.js'
import { CLAUDE_DIR_NAME } from 'src/constants/claudeDirName.js'

/**
 * 以每 100 万 token 多少美元计价的费率，按模型 ID 前缀索引。
 * 费率来源于 Anthropic 定价页面（2026-04）。
 * 未识别的模型会得到一个 '~$ unknown' 标签，而不是一个过时的估算。
 */
const MODEL_COST_RATES: Record<
  string,
  { input: number; output: number; cache_creation: number; cache_read: number }
> = {
  // Claude Sonnet 4.6 / claude-sonnet-4 系列
  'claude-sonnet-4': {
    input: 3.0,
    output: 15.0,
    cache_creation: 3.75,
    cache_read: 0.3,
  },
  // Claude Opus 4.5 / claude-opus-4 系列
  'claude-opus-4': {
    input: 15.0,
    output: 75.0,
    cache_creation: 18.75,
    cache_read: 1.5,
  },
  // Claude Haiku 4.5 / claude-haiku-4 系列
  'claude-haiku-4': {
    input: 0.8,
    output: 4.0,
    cache_creation: 1.0,
    cache_read: 0.08,
  },
  // Claude 3.7 Sonnet
  'claude-3-7-sonnet': {
    input: 3.0,
    output: 15.0,
    cache_creation: 3.75,
    cache_read: 0.3,
  },
  // Claude 3.5 Sonnet
  'claude-3-5-sonnet': {
    input: 3.0,
    output: 15.0,
    cache_creation: 3.75,
    cache_read: 0.3,
  },
  // Claude 3.5 Haiku
  'claude-3-5-haiku': {
    input: 0.8,
    output: 4.0,
    cache_creation: 1.0,
    cache_read: 0.08,
  },
  // Claude 3 Opus
  'claude-3-opus': {
    input: 15.0,
    output: 75.0,
    cache_creation: 18.75,
    cache_read: 1.5,
  },
}

type CostRates = {
  input: number
  output: number
  cache_creation: number
  cache_read: number
}

function lookupCostRates(model: string | null | undefined): CostRates | null {
  if (!model) return null
  for (const [prefix, rates] of Object.entries(MODEL_COST_RATES)) {
    if (model.startsWith(prefix)) return rates
  }
  return null
}

/**
 * 在向用户展示之前对错误信息进行净化：
 * - 将家目录路径替换为 "~"，避免泄露绝对路径。
 * - 截断到 200 个字符，避免泄露大段堆栈跟踪或 token 片段。
 */
function sanitizeErrorMessage(msg: string): string {
  const home = homedir()
  let sanitized = msg.replace(
    new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
    '~',
  )
  if (sanitized.length > 200) sanitized = sanitized.slice(0, 200) + '…'
  return sanitized
}

function getPerfReportDir(): string {
  return join(homedir(), CLAUDE_DIR_NAME, 'perf-reports')
}

function getTranscriptPath(): string {
  const sessionId = getSessionId()
  const projectDir = getSessionProjectDir()
  if (projectDir) return join(projectDir, `${sessionId}.jsonl`)
  return join(
    getClaudeConfigHomeDir(),
    'projects',
    sanitizePath(getOriginalCwd()),
    `${sessionId}.jsonl`,
  )
}

interface UsageTotals {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
}

interface LogEntry {
  role?: string
  type?: string
  content?: unknown
  usage?: Record<string, number>
  timestamp?: string | number
  model?: string
}

interface ToolUseBlock {
  type: 'tool_use'
  name?: string
  id?: string
}

interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id?: string
}

interface ToolTiming {
  name: string
  /** 来自日志条目的时间戳（毫秒）。null 表示未出现时间戳。 */
  logTimestampMs: number | null
  durationMs?: number
}

interface AnalyzedLog {
  usage: UsageTotals
  toolCounts: Record<string, number>
  /** 从日志时间戳计算出的毫秒耗时。仅当 tool_use 和 tool_result
   *  条目都带有时间戳时存在。 */
  toolDurations: Record<string, number[]>
  turnCount: number
  messageCount: number
  cacheHitRate: number
  estimatedCostUsd: number | null
  /** 从日志中检测到的模型（第一条带 model 字段的 assistant 消息）。 */
  detectedModel: string | null
  firstTimestampMs: number | null
  lastTimestampMs: number | null
  wallClockSeconds: number | null
}

function parseTimestampMs(tsRaw: string | number | undefined): number | null {
  if (tsRaw === undefined) return null
  const tsMs =
    typeof tsRaw === 'number'
      ? tsRaw
      : typeof tsRaw === 'string'
        ? Date.parse(tsRaw)
        : null
  if (tsMs === null || Number.isNaN(tsMs)) return null
  return tsMs
}

/**
 * 从日志文件读取的 JSONL 行数默认上限。
 * 防止会话转录超过几百 MB 时发生 OOM。
 * 使用最后 MAX_LOG_LINES 行，这样最近的活动总能被反映出来。
 */
const MAX_LOG_LINES = 20_000

function analyzeLog(logPath: string, maxLines = MAX_LOG_LINES): AnalyzedLog {
  const usage: UsageTotals = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  }
  const toolCounts: Record<string, number> = {}
  const toolDurations: Record<string, number[]> = {}
  const pendingToolUses = new Map<string, ToolTiming>()
  let turnCount = 0
  let messageCount = 0
  let firstTimestampMs: number | null = null
  let lastTimestampMs: number | null = null
  let detectedModel: string | null = null

  const allLines = readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
  // 应用行数上限：使用最后 maxLines 条记录，这样最近的对话轮次总会被包含。
  const lines =
    allLines.length > maxLines ? allLines.slice(-maxLines) : allLines

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as LogEntry
      messageCount++

      if (entry.role === 'user') turnCount++

      // 从任意条目捕获第一个观察到的模型名
      if (entry.model && detectedModel === null) {
        detectedModel = entry.model
      }

      // 从日志条目时间戳追踪真实时间窗口
      const entryTsMs = parseTimestampMs(entry.timestamp)
      if (entryTsMs !== null) {
        if (firstTimestampMs === null) firstTimestampMs = entryTsMs
        lastTimestampMs = entryTsMs
      }

      if (entry.usage) {
        for (const key of Object.keys(usage) as Array<keyof UsageTotals>) {
          const val = entry.usage[key]
          if (typeof val === 'number') usage[key] += val
        }
      }

      if (Array.isArray(entry.content)) {
        for (const block of entry.content as Array<Record<string, unknown>>) {
          if (block.type === 'tool_use') {
            const b = block as unknown as ToolUseBlock
            const name = b.name ?? 'unknown'
            toolCounts[name] = (toolCounts[name] ?? 0) + 1
            if (b.id) {
              // 记录此 tool_use 的日志条目时间戳；不存在则为 null。
              pendingToolUses.set(b.id, { name, logTimestampMs: entryTsMs })
            }
          } else if (block.type === 'tool_result') {
            const b = block as unknown as ToolResultBlock
            if (b.tool_use_id) {
              const pending = pendingToolUses.get(b.tool_use_id)
              if (pending) {
                // 仅当两端都有真实时间戳时才记录耗时。
                if (pending.logTimestampMs !== null && entryTsMs !== null) {
                  const durationMs = entryTsMs - pending.logTimestampMs
                  toolDurations[pending.name] =
                    toolDurations[pending.name] ?? []
                  toolDurations[pending.name].push(durationMs)
                }
                pendingToolUses.delete(b.tool_use_id)
              }
            }
          }
        }
      }
    } catch {
      // 跳过格式错误的行
    }
  }

  // 缓存命中率：命中的缓存相关 token 占比（非创建）
  const cacheTotal =
    usage.cache_creation_input_tokens + usage.cache_read_input_tokens
  const cacheHitRate =
    cacheTotal > 0 ? usage.cache_read_input_tokens / cacheTotal : 0

  // 成本估算 —— 仅当我们能查到检测到的模型的费率时才计算。
  const rates = lookupCostRates(detectedModel)
  const estimatedCostUsd = rates
    ? (usage.input_tokens / 1_000_000) * rates.input +
      (usage.output_tokens / 1_000_000) * rates.output +
      (usage.cache_creation_input_tokens / 1_000_000) * rates.cache_creation +
      (usage.cache_read_input_tokens / 1_000_000) * rates.cache_read
    : null

  const wallClockSeconds =
    firstTimestampMs !== null && lastTimestampMs !== null
      ? (lastTimestampMs - firstTimestampMs) / 1000
      : null

  return {
    usage,
    toolCounts,
    toolDurations,
    turnCount,
    messageCount,
    cacheHitRate,
    estimatedCostUsd,
    detectedModel,
    firstTimestampMs,
    lastTimestampMs,
    wallClockSeconds,
  }
}

function top10Tools(toolCounts: Record<string, number>): string[] {
  return Object.entries(toolCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => `  ${name.padEnd(40)} ${count}`)
}

function avgMs(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((a, b) => a + b, 0) / values.length
}

function formatReportMarkdown(
  sessionId: string,
  logPath: string,
  analyzed: AnalyzedLog,
): string {
  const {
    usage,
    toolCounts,
    toolDurations,
    turnCount,
    messageCount,
    cacheHitRate,
    estimatedCostUsd,
    detectedModel,
    wallClockSeconds,
  } = analyzed
  const m = process.memoryUsage()
  const cpu = process.cpuUsage()
  const totalTokens =
    usage.input_tokens +
    usage.output_tokens +
    usage.cache_creation_input_tokens +
    usage.cache_read_input_tokens
  const toolLines = top10Tools(toolCounts)

  const toolAvgLines = Object.entries(toolDurations)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 10)
    .map(
      ([name, durs]) =>
        `  ${name.padEnd(40)} avg ${avgMs(durs).toFixed(0)} ms  (${durs.length} calls)`,
    )

  return [
    '# Claude Code Performance Snapshot',
    '',
    `- timestamp: ${new Date().toISOString()}`,
    `- session:   ${sessionId}`,
    `- pid:       ${process.pid}`,
    `- platform:  ${process.platform} ${process.arch}`,
    `- bun:       ${typeof Bun !== 'undefined' ? Bun.version : 'n/a'}`,
    `- node:      ${process.version}`,
    `- uptime:    ${process.uptime().toFixed(1)}s`,
    '',
    '## Memory',
    `- rss:           ${m.rss}`,
    `- heap used:     ${m.heapUsed}`,
    `- heap total:    ${m.heapTotal}`,
    `- external:      ${m.external}`,
    `- array buffers: ${m.arrayBuffers ?? 0}`,
    '',
    '## CPU (process.cpuUsage, microseconds)',
    `- user:   ${cpu.user}`,
    `- system: ${cpu.system}`,
    '',
    '## Session Token Usage',
    `- total_tokens:          ${totalTokens.toLocaleString()}`,
    `- input_tokens:          ${usage.input_tokens.toLocaleString()}`,
    `- output_tokens:         ${usage.output_tokens.toLocaleString()}`,
    `- cache_creation:        ${usage.cache_creation_input_tokens.toLocaleString()}`,
    `- cache_read:            ${usage.cache_read_input_tokens.toLocaleString()}`,
    `- turns (user messages): ${turnCount}`,
    `- total log entries:     ${messageCount}`,
    wallClockSeconds !== null
      ? `- wall_clock_seconds:    ${wallClockSeconds.toFixed(1)}`
      : '',
    '',
    '## Cost Estimate (approximate)',
    detectedModel
      ? `- model: ${detectedModel}`
      : '- model: (unknown — not present in log)',
    estimatedCostUsd !== null
      ? `- estimated_usd: $${estimatedCostUsd.toFixed(4)}`
      : '- estimated_usd: ~$ unknown (unrecognized model)',
    `- cache_hit_rate: ${(cacheHitRate * 100).toFixed(1)}%`,
    '',
    '## Tool Call Counts (top 10)',
    toolLines.length > 0 ? toolLines.join('\n') : '  (no tool calls)',
    '',
    '## Tool Average Execution Time (top 10 by call count)',
    toolAvgLines.length > 0
      ? toolAvgLines.join('\n')
      : '  (no timing data — tool_result/tool_use pairs not found)',
    '',
    '## Notes',
    '',
    'Add a description of what you were doing when the perf issue surfaced:',
    '',
    '- ___',
    '',
    "_(File this report in your repo's issue tracker. No network call was made._",
    '_The fork does not transmit perf reports to Anthropic.)_',
  ]
    .filter(line => line !== '')
    .join('\n')
}

function formatReportJSON(sessionId: string, analyzed: AnalyzedLog): string {
  const m = process.memoryUsage()
  const cpu = process.cpuUsage()
  const totalTokens =
    analyzed.usage.input_tokens +
    analyzed.usage.output_tokens +
    analyzed.usage.cache_creation_input_tokens +
    analyzed.usage.cache_read_input_tokens

  return JSON.stringify(
    {
      timestamp: new Date().toISOString(),
      session: sessionId,
      pid: process.pid,
      platform: process.platform,
      arch: process.arch,
      uptime: process.uptime(),
      memory: { ...m },
      cpu: { ...cpu },
      tokens: {
        total: totalTokens,
        input: analyzed.usage.input_tokens,
        output: analyzed.usage.output_tokens,
        cache_creation: analyzed.usage.cache_creation_input_tokens,
        cache_read: analyzed.usage.cache_read_input_tokens,
      },
      turns: analyzed.turnCount,
      messages: analyzed.messageCount,
      cache_hit_rate: analyzed.cacheHitRate,
      detected_model: analyzed.detectedModel,
      estimated_cost_usd: analyzed.estimatedCostUsd,
      wall_clock_seconds: analyzed.wallClockSeconds,
      tool_counts: analyzed.toolCounts,
      tool_avg_ms: Object.fromEntries(
        Object.entries(analyzed.toolDurations).map(([k, v]) => [k, avgMs(v)]),
      ),
    },
    null,
    2,
  )
}

function formatReportCSV(analyzed: AnalyzedLog): string {
  const rows: string[] = [
    'metric,value',
    `timestamp,${new Date().toISOString()}`,
    `input_tokens,${analyzed.usage.input_tokens}`,
    `output_tokens,${analyzed.usage.output_tokens}`,
    `cache_creation_tokens,${analyzed.usage.cache_creation_input_tokens}`,
    `cache_read_tokens,${analyzed.usage.cache_read_input_tokens}`,
    `turns,${analyzed.turnCount}`,
    `cache_hit_rate,${analyzed.cacheHitRate.toFixed(4)}`,
    `estimated_cost_usd,${analyzed.estimatedCostUsd !== null ? analyzed.estimatedCostUsd.toFixed(6) : 'unknown'}`,
    `wall_clock_seconds,${analyzed.wallClockSeconds ?? ''}`,
    ...Object.entries(analyzed.toolCounts).map(
      ([name, count]) => `tool_count_${name},${count}`,
    ),
  ]
  return rows.join('\n')
}

const perfIssue: Command = {
  type: 'local',
  name: 'perf-issue',
  description:
    'Capture a performance + token-usage snapshot. Flags: --format=json|csv|md (default md)',
  isHidden: false,
  isEnabled: () => true,
  supportsNonInteractive: true,
  bridgeSafe: true,
  load: async () => ({
    call: async (args: string): Promise<LocalCommandResult> => {
      try {
        // 解析 --format 标志
        const formatMatch = args.match(/--format[= ](json|csv|md)/)
        const format: 'md' | 'json' | 'csv' = formatMatch
          ? (formatMatch[1] as 'md' | 'json' | 'csv')
          : 'md'

        // 解析 --limit N（读取的最大 JSONL 行数；防止大日志导致 OOM）
        const limitMatch = args.match(/--limit[= ](\d+)/)
        const lineLimit = limitMatch
          ? Math.max(1, parseInt(limitMatch[1], 10))
          : MAX_LOG_LINES

        const dir = getPerfReportDir()
        mkdirSync(dir, { recursive: true })
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const sessionId = getSessionId()
        const ext = format === 'json' ? 'json' : format === 'csv' ? 'csv' : 'md'
        const reportPath = join(
          dir,
          `perf-${stamp}-${sessionId.slice(0, 8)}.${ext}`,
        )

        const logPath = getTranscriptPath()
        const hasLog = existsSync(logPath)

        let analyzed: AnalyzedLog | null = null
        if (hasLog) {
          try {
            analyzed = analyzeLog(logPath, lineLimit)
          } catch {
            analyzed = null
          }
        }

        // 当日志不可用时构造空的 analyzed 统计
        const safeAnalyzed: AnalyzedLog = analyzed ?? {
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          toolCounts: {},
          toolDurations: {},
          turnCount: 0,
          messageCount: 0,
          cacheHitRate: 0,
          estimatedCostUsd: null,
          detectedModel: null,
          firstTimestampMs: null,
          lastTimestampMs: null,
          wallClockSeconds: null,
        }

        let reportContent: string
        if (format === 'json') {
          reportContent = formatReportJSON(sessionId, safeAnalyzed)
        } else if (format === 'csv') {
          reportContent = formatReportCSV(safeAnalyzed)
        } else {
          reportContent = formatReportMarkdown(sessionId, logPath, safeAnalyzed)
          if (!hasLog) {
            reportContent += `\n\n## Session Log\n(log not found at \`${logPath}\`)`
          }
        }

        writeFileSync(reportPath, reportContent, 'utf8')
        return {
          type: 'text',
          value: `Perf snapshot written to:\n  \`${reportPath}\`\n\nFormat: ${format}\nEdit it to add notes, then attach to your bug report.`,
        }
      } catch (err: unknown) {
        const msg = sanitizeErrorMessage(
          err instanceof Error ? err.message : String(err),
        )
        return { type: 'text', value: `Failed to write perf report: ${msg}` }
      }
    },
  }),
}

export default perfIssue
