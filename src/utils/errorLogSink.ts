/**
 * 错误日志接收器实现
 *
 * 本模块包含错误日志的重量级实现，应在应用启动时初始化。
 * 它处理基于文件的错误日志写入磁盘。
 *
 * 用法：在应用启动时调用 initializeErrorLogSink() 以挂载接收器。
 *
 * 设计：此模块与 log.ts 分离以避免导入循环。
 * log.ts 无重量级依赖 —— 事件会排队直到此接收器被挂载。
 */

import axios from 'axios'
import { dirname, join } from 'path'
import { getSessionId } from '../bootstrap/state.js'
import { createBufferedWriter } from './bufferedWriter.js'
import { CACHE_PATHS } from './cachePaths.js'
import { registerCleanup } from './cleanupRegistry.js'
import { logForDebugging } from './debug.js'
import { getFsImplementation } from './fsOperations.js'
import { attachErrorLogSink, dateToFilename } from './log.js'
import { jsonStringify } from './slowOperations.js'
import { captureException } from './sentry.js'

const DATE = dateToFilename(new Date())

/**
 * 获取错误日志文件路径。
 */
export function getErrorsPath(): string {
  return join(CACHE_PATHS.errors(), DATE + '.jsonl')
}

/**
 * 获取指定服务器的 MCP 日志路径。
 */
export function getMCPLogsPath(serverName: string): string {
  return join(CACHE_PATHS.mcpLogs(serverName), DATE + '.jsonl')
}

type JsonlWriter = {
  write: (obj: object) => void
  flush: () => void
  dispose: () => void
}

function createJsonlWriter(options: {
  writeFn: (content: string) => void
  flushIntervalMs?: number
  maxBufferSize?: number
}): JsonlWriter {
  const writer = createBufferedWriter(options)
  return {
    write(obj: object): void {
      writer.write(jsonStringify(obj) + '\n')
    },
    flush: writer.flush,
    dispose: writer.dispose,
  }
}

// JSONL 日志文件的缓冲写入器，按路径索引
const logWriters = new Map<string, JsonlWriter>()

/**
 * 刷新所有缓冲的日志写入器。用于测试。
 * @internal
 */
export function _flushLogWritersForTesting(): void {
  for (const writer of logWriters.values()) {
    writer.flush()
  }
}

/**
 * 清空所有缓冲的日志写入器。用于测试。
 * @internal
 */
export function _clearLogWritersForTesting(): void {
  for (const writer of logWriters.values()) {
    writer.dispose()
  }
  logWriters.clear()
}

function getLogWriter(path: string): JsonlWriter {
  let writer = logWriters.get(path)
  if (!writer) {
    const dir = dirname(path)
    writer = createJsonlWriter({
      // 同步 IO：从同步上下文调用
      writeFn: (content: string) => {
        try {
          // 正常路径：目录已存在
          getFsImplementation().appendFileSync(path, content)
        } catch {
          // 若发生任何错误，假定是目录缺失导致
          getFsImplementation().mkdirSync(dir)
          // 重试追加
          getFsImplementation().appendFileSync(path, content)
        }
      },
      flushIntervalMs: 1000,
      maxBufferSize: 50,
    })
    logWriters.set(path, writer)
    registerCleanup(async () => writer?.dispose())
  }
  return writer
}

function appendToLog(path: string, message: object): void {
  if (process.env.USER_TYPE !== 'ant') {
    return
  }

  const messageWithTimestamp = {
    timestamp: new Date().toISOString(),
    ...message,
    cwd: getFsImplementation().cwd(),
    userType: process.env.USER_TYPE,
    sessionId: getSessionId(),
    version: MACRO.VERSION,
  }

  getLogWriter(path).write(messageWithTimestamp)
}

function extractServerMessage(data: unknown): string | undefined {
  if (typeof data === 'string') {
    return data
  }
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>
    if (typeof obj.message === 'string') {
      return obj.message
    }
    if (
      typeof obj.error === 'object' &&
      obj.error &&
      'message' in obj.error &&
      typeof (obj.error as Record<string, unknown>).message === 'string'
    ) {
      return (obj.error as Record<string, unknown>).message as string
    }
  }
  return undefined
}

/**
 * logError 的实现 - 将错误写入调试日志和文件。
 */
function logErrorImpl(error: Error): void {
  const errorStr = error.stack || error.message

  // 为 axios 错误补充请求 URL、状态码和服务器消息以便调试
  let context = ''
  if (axios.isAxiosError(error) && error.config?.url) {
    const parts = [`url=${error.config.url}`]
    if (error.response?.status !== undefined) {
      parts.push(`status=${error.response.status}`)
    }
    const serverMessage = extractServerMessage(error.response?.data)
    if (serverMessage) {
      parts.push(`body=${serverMessage}`)
    }
    context = `[${parts.join(',')}] `
  }

  logForDebugging(`${error.name}: ${context}${errorStr}`, { level: 'error' })

  appendToLog(getErrorsPath(), {
    error: `${context}${errorStr}`,
  })

  // 同时报告给 Sentry（若未初始化则为无操作）
  captureException(error)
}

/**
 * logMCPError 的实现 - 将 MCP 错误写入调试日志和文件。
 */
function logMCPErrorImpl(serverName: string, error: unknown): void {
  // 未做主题化，以避免需要将主题一路传递下来
  logForDebugging(`MCP server "${serverName}" ${error}`, { level: 'error' })

  const logFile = getMCPLogsPath(serverName)
  const errorStr =
    error instanceof Error ? error.stack || error.message : String(error)

  const errorInfo = {
    error: errorStr,
    timestamp: new Date().toISOString(),
    sessionId: getSessionId(),
    cwd: getFsImplementation().cwd(),
  }

  getLogWriter(logFile).write(errorInfo)
}

/**
 * logMCPDebug 的实现 - 将 MCP 调试消息写入日志文件。
 */
function logMCPDebugImpl(serverName: string, message: string): void {
  logForDebugging(`MCP server "${serverName}": ${message}`)

  const logFile = getMCPLogsPath(serverName)

  const debugInfo = {
    debug: message,
    timestamp: new Date().toISOString(),
    sessionId: getSessionId(),
    cwd: getFsImplementation().cwd(),
  }

  getLogWriter(logFile).write(debugInfo)
}

/**
 * 初始化错误日志接收器。
 *
 * 在应用启动期间调用以挂载错误日志后端。
 * 在此调用之前记录的任何错误都会被排队并排空。
 *
 * 应在启动序列中 initializeAnalyticsSink() 之前调用。
 *
 * 幂等：可安全多次调用（后续调用为无操作）。
 */
export function initializeErrorLogSink(): void {
  attachErrorLogSink({
    logError: logErrorImpl,
    logMCPError: logMCPErrorImpl,
    logMCPDebug: logMCPDebugImpl,
    getErrorsPath,
    getMCPLogsPath,
  })

  logForDebugging('Error log sink initialized')
}
