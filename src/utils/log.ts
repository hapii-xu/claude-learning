import { feature } from 'bun:bundle'
import type { BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { readdir, readFile, stat } from 'fs/promises'
import memoize from 'lodash-es/memoize.js'
import { join } from 'path'
import type { QuerySource } from 'src/constants/querySource.js'
import {
  setLastAPIRequest,
  setLastAPIRequestMessages,
} from '../bootstrap/state.js'
import { TICK_TAG } from '../constants/xml.js'
import {
  type LogOption,
  type SerializedMessage,
  sortLogs,
} from '../types/logs.js'
import { CACHE_PATHS } from './cachePaths.js'
import { stripDisplayTags, stripDisplayTagsAllowEmpty } from './displayTags.js'
import { isEnvTruthy } from './envUtils.js'
import { toError, shortErrorStack } from './errors.js'
import { isEssentialTrafficOnly } from './privacyLevel.js'
import { jsonParse } from './slowOperations.js'

/**
 * 获取日志/会话的显示标题，带回退逻辑。
 * 若 firstPrompt 以 tick/goal 标签开头（自主模式自动提示），则跳过。
 * 过滤掉不适合显示的标签（如 <ide_opened_file>）。
 * 无其他可用标题时回退为截断的会话 ID。
 */
export function getLogDisplayTitle(
  log: LogOption,
  defaultTitle?: string,
): string {
  // 若为 tick/goal 消息（自主模式自动提示），跳过 firstPrompt
  const isAutonomousPrompt = log.firstPrompt?.startsWith(`<${TICK_TAG}>`)
  // 提前过滤不适合显示的标签（command-name、ide_opened_file 等），
  // 使纯命令提示（如 /clear）变为空字符串并落入下一个回退，
  // 而非直接展示原始 XML 标签。
  // 注意：stripDisplayTags 在过滤后为空时返回原值，
  // 因此使用 stripDisplayTagsAllowEmpty 来检测纯命令提示。
  const strippedFirstPrompt = log.firstPrompt
    ? stripDisplayTagsAllowEmpty(log.firstPrompt)
    : ''
  const useFirstPrompt = strippedFirstPrompt && !isAutonomousPrompt
  const title =
    log.agentName ||
    log.customTitle ||
    log.summary ||
    (useFirstPrompt ? strippedFirstPrompt : undefined) ||
    defaultTitle ||
    // 自主会话无其他上下文时，显示有意义的标签
    (isAutonomousPrompt ? '自主会话' : undefined) ||
    // 无元数据的精简日志回退到截断的会话 ID
    (log.sessionId ? log.sessionId.slice(0, 8) : '') ||
    ''
  // 过滤不适合显示的标签（如 <ide_opened_file>）以获得更干净的标题
  return stripDisplayTags(title).trim()
}

export function dateToFilename(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-')
}

// 最近错误的内存日志
// 从 bootstrap/state.ts 移至此处以打破导入循环
const MAX_IN_MEMORY_ERRORS = 100
let inMemoryErrorLog: Array<{ error: string; timestamp: string }> = []

function addToInMemoryErrorLog(errorInfo: {
  error: string
  timestamp: string
}): void {
  if (inMemoryErrorLog.length >= MAX_IN_MEMORY_ERRORS) {
    inMemoryErrorLog.shift() // 移除最旧的错误
  }
  inMemoryErrorLog.push(errorInfo)
}

/**
 * 错误日志后端的 Sink 接口
 */
export type ErrorLogSink = {
  logError: (error: Error) => void
  logMCPError: (serverName: string, error: unknown) => void
  logMCPDebug: (serverName: string, message: string) => void
  getErrorsPath: () => string
  getMCPLogsPath: (serverName: string) => string
}

// Sink 挂载前记录的事件队列
type QueuedErrorEvent =
  | { type: 'error'; error: Error }
  | { type: 'mcpError'; serverName: string; error: unknown }
  | { type: 'mcpDebug'; serverName: string; message: string }

const errorQueue: QueuedErrorEvent[] = []

// Sink —— 在应用启动时初始化
let errorLogSink: ErrorLogSink | null = null

/**
 * 挂载接收所有错误事件的错误日志 Sink。
 * 队列中的事件会立即排空，确保不丢失任何错误。
 *
 * 幂等：若 Sink 已挂载则为空操作，允许从 preAction 钩子（子命令）
 * 和 setup()（默认命令）同时调用而无需协调。
 */
export function attachErrorLogSink(newSink: ErrorLogSink): void {
  if (errorLogSink !== null) {
    return
  }
  errorLogSink = newSink

  // 立即排空队列——错误不应被延迟
  if (errorQueue.length > 0) {
    const queuedEvents = [...errorQueue]
    errorQueue.length = 0

    for (const event of queuedEvents) {
      switch (event.type) {
        case 'error':
          errorLogSink.logError(event.error)
          break
        case 'mcpError':
          errorLogSink.logMCPError(event.serverName, event.error)
          break
        case 'mcpDebug':
          errorLogSink.logMCPDebug(event.serverName, event.message)
          break
      }
    }
  }
}

/**
 * 将错误记录到多个目标，用于调试和监控。
 *
 * 错误写入以下位置：
 * - 调试日志（通过 `claude --debug` 或 `tail -f ~/.hclaude/debug/latest` 查看）
 * - 内存错误日志（通过 `getInMemoryErrors()` 访问，可用于错误报告或展示给用户）
 * - 持久化错误日志文件（仅限内部 'ant' 用户，存储于 ~/.hclaude/errors/）
 *
 * 用法：
 * ```ts
 * logError(new Error('Failed to connect'))
 * ```
 *
 * 查看错误：
 * - 调试：运行 `claude --debug` 或 `tail -f ~/.hclaude/debug/latest`
 * - 内存：调用 `getInMemoryErrors()` 获取当前会话的最近错误
 */
const isHardFailMode = memoize((): boolean => {
  return process.argv.includes('--hard-fail')
})

export function logError(error: unknown): void {
  const err = toError(error)
  if (feature('HARD_FAIL') && isHardFailMode()) {
    console.error('[HARD FAIL] logError called with:', err.stack || err.message)
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(1)
  }
  try {
    // 检查是否应禁用错误上报
    if (
      // 云服务商（Bedrock/Vertex/Foundry）始终禁用该功能
      isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) ||
      isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) ||
      isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY) ||
      process.env.DISABLE_ERROR_REPORTING ||
      isEssentialTrafficOnly()
    ) {
      return
    }

    const errorStr = shortErrorStack(err)

    const errorInfo = {
      error: errorStr,
      timestamp: new Date().toISOString(),
    }

    // 始终写入内存日志（无依赖）
    addToInMemoryErrorLog(errorInfo)

    // Sink 未挂载时将事件加入队列
    if (errorLogSink === null) {
      errorQueue.push({ type: 'error', error: err })
      return
    }

    errorLogSink.logError(err)
  } catch {
    // pass
  }
}

export function getInMemoryErrors(): { error: string; timestamp: string }[] {
  return [...inMemoryErrorLog]
}

/**
 * 加载错误日志列表
 * @returns 按日期排序的错误日志列表
 */
export function loadErrorLogs(): Promise<LogOption[]> {
  return loadLogList(CACHE_PATHS.errors())
}

/**
 * 按索引获取错误日志
 * @param index 排序后日志列表中的索引（从 0 开始）
 * @returns 日志数据，未找到时返回 null
 */
export async function getErrorLogByIndex(
  index: number,
): Promise<LogOption | null> {
  const logs = await loadErrorLogs()
  return logs[index] || null
}

/**
 * 从指定路径加载并处理日志的内部函数
 * @param path 存放日志的目录
 * @returns 按日期排序的日志数组
 * @private
 */
async function loadLogList(path: string): Promise<LogOption[]> {
  let files: Awaited<ReturnType<typeof readdir>>
  try {
    files = (await readdir(path, { withFileTypes: true })) as any
  } catch {
    logError(new Error(`No logs found at ${path}`))
    return []
  }
  const logData = await Promise.all(
    files.map(async (file, i) => {
      const fullPath = join(path, String(file.name))
      const content = await readFile(fullPath, { encoding: 'utf8' })
      const messages = jsonParse(content) as SerializedMessage[]
      const firstMessage = messages[0]
      const lastMessage = messages[messages.length - 1]
      const firstPrompt =
        firstMessage?.type === 'user' &&
        typeof firstMessage?.message?.content === 'string'
          ? firstMessage?.message?.content
          : 'No prompt'

      // 对于随机文件名，从文件本身获取统计信息
      const fileStats = await stat(fullPath)

      // 通过文件名判断是否为 sidechain
      const isSidechain = fullPath.includes('sidechain')

      // 新文件使用文件修改时间作为日期
      const date = dateToFilename(fileStats.mtime)

      return {
        date,
        fullPath,
        messages,
        value: i, // 临时值：排序后立即覆盖（见下方）
        created: parseISOString(firstMessage?.timestamp || date),
        modified: lastMessage?.timestamp
          ? parseISOString(lastMessage.timestamp)
          : parseISOString(date),
        firstPrompt:
          firstPrompt.split('\n')[0]?.slice(0, 50) +
            (firstPrompt.length > 50 ? '…' : '') || 'No prompt',
        messageCount: messages.length,
        isSidechain,
      }
    }),
  )

  return sortLogs(logData.filter(_ => _ !== null)).map((_, i) => ({
    ..._,
    value: i,
  }))
}

function parseISOString(s: string): Date {
  const b = s.split(/\D+/)
  return new Date(
    Date.UTC(
      parseInt(b[0]!, 10),
      parseInt(b[1]!, 10) - 1,
      parseInt(b[2]!, 10),
      parseInt(b[3]!, 10),
      parseInt(b[4]!, 10),
      parseInt(b[5]!, 10),
      parseInt(b[6]!, 10),
    ),
  )
}

export function logMCPError(serverName: string, error: unknown): void {
  try {
    // Sink 未挂载时将事件加入队列
    if (errorLogSink === null) {
      errorQueue.push({ type: 'mcpError', serverName, error })
      return
    }

    errorLogSink.logMCPError(serverName, error)
  } catch {
    // 静默失败
  }
}

export function logMCPDebug(serverName: string, message: string): void {
  try {
    // Sink 未挂载时将事件加入队列
    if (errorLogSink === null) {
      errorQueue.push({ type: 'mcpDebug', serverName, message })
      return
    }

    errorLogSink.logMCPDebug(serverName, message)
  } catch {
    // 静默失败
  }
}

/**
 * 捕获最后一次 API 请求，用于错误报告。
 */
export function captureAPIRequest(
  params: BetaMessageStreamParams,
  querySource?: QuerySource,
): void {
  // 使用 startsWith 而非精确匹配——非默认输出风格的用户会得到
  // 类似 'repl_main_thread:outputStyle:Explanatory' 的变体（见 querySource.ts）。
  if (!querySource || !querySource.startsWith('repl_main_thread')) {
    return
  }

  // 存储不含 messages 的参数，避免为所有用户保留完整对话。
  // messages 已持久化到转录文件，并可通过 React state 访问。
  const { messages, ...paramsWithoutMessages } = params
  setLastAPIRequest(paramsWithoutMessages)
  // 仅限 ant 用户：同时保留最终 messages 数组引用，
  // 使 /share 的 serialized_conversation.json 能捕获 API 收到的
  // 压缩后、注入 CLAUDE.md 的精确载荷。每轮覆盖；
  // dumpPrompts.ts 已为 ant 用户保存 5 份完整请求体，不属于新的保留类别。
  setLastAPIRequestMessages(process.env.USER_TYPE === 'ant' ? messages : null)
}

/**
 * 仅用于测试：重置错误日志状态。
 * @internal
 */
export function _resetErrorLogForTesting(): void {
  errorLogSink = null
  errorQueue.length = 0
  inMemoryErrorLog = []
}
