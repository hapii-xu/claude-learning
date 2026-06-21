import { appendFile, mkdir, symlink, unlink } from 'fs/promises'
import memoize from 'lodash-es/memoize.js'
import { dirname, join } from 'path'
import { getSessionId } from 'src/bootstrap/state.js'

import { type BufferedWriter, createBufferedWriter } from './bufferedWriter.js'
import { registerCleanup } from './cleanupRegistry.js'
import {
  type DebugFilter,
  parseDebugFilter,
  shouldShowDebugMessage,
} from './debugFilter.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from './envUtils.js'
import { getFsImplementation } from './fsOperations.js'
import { writeToStderr } from './process.js'
import { jsonStringify } from './slowOperations.js'

export type DebugLogLevel = 'verbose' | 'debug' | 'info' | 'warn' | 'error'

type DebugLogSink = (
  level: DebugLogLevel,
  message: string,
  timestamp: string,
) => void
let _debugLogSink: DebugLogSink | null = null
export function setDebugLogSink(sink: DebugLogSink | null): void {
  _debugLogSink = sink
}

const LEVEL_ORDER: Record<DebugLogLevel, number> = {
  verbose: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
}

/**
 * 调试输出的最低日志级别，默认为 'debug'（过滤掉 'verbose' 消息）。
 * 设置 CLAUDE_CODE_DEBUG_LOG_LEVEL=verbose 可包含高频诊断信息
 * （如完整的 statusLine 命令、shell、cwd、stdout/stderr），
 * 否则这些信息会淹没有用的调试输出。
 */
export const getMinDebugLogLevel = memoize((): DebugLogLevel => {
  const raw = process.env.CLAUDE_CODE_DEBUG_LOG_LEVEL?.toLowerCase().trim()
  if (raw && Object.hasOwn(LEVEL_ORDER, raw)) {
    return raw as DebugLogLevel
  }
  return 'debug'
})

let runtimeDebugEnabled = false

export const isDebugMode = memoize((): boolean => {
  return (
    runtimeDebugEnabled ||
    isEnvTruthy(process.env.DEBUG) ||
    isEnvTruthy(process.env.DEBUG_SDK) ||
    process.argv.includes('--debug') ||
    process.argv.includes('-d') ||
    isDebugToStdErr() ||
    // Also check for --debug=pattern syntax
    process.argv.some(arg => arg.startsWith('--debug=')) ||
    // --debug-file implicitly enables debug mode
    getDebugFilePath() !== null
  )
})

/**
 * 在会话中途启用调试日志（如通过 /debug）。非 ant 用户默认不写调试日志，
 * 此函数允许他们无需重启并加 --debug 即可开始捕获日志。
 * 若日志已处于活跃状态则返回 true。
 */
export function enableDebugLogging(): boolean {
  const wasActive = isDebugMode() || process.env.USER_TYPE === 'ant'
  runtimeDebugEnabled = true
  isDebugMode.cache.clear?.()
  return wasActive
}

// 从命令行参数中提取并解析调试过滤器
// 导出供测试使用
export const getDebugFilter = memoize((): DebugFilter | null => {
  // Look for --debug=pattern in argv
  const debugArg = process.argv.find(arg => arg.startsWith('--debug='))
  if (!debugArg) {
    return null
  }

  // Extract the pattern after the equals sign
  const filterPattern = debugArg.substring('--debug='.length)
  return parseDebugFilter(filterPattern)
})

export const isDebugToStdErr = memoize((): boolean => {
  return process.argv.includes('--debug-to-stderr')
})

export const getDebugFilePath = memoize((): string | null => {
  for (let i = 0; i < process.argv.length; i++) {
    const arg = process.argv[i]!
    if (arg.startsWith('--debug-file=')) {
      return arg.substring('--debug-file='.length)
    }
    if (arg === '--debug-file' && i + 1 < process.argv.length) {
      return process.argv[i + 1]!
    }
  }
  return null
})

function shouldLogDebugMessage(message: string): boolean {
  if (process.env.NODE_ENV === 'test' && !isDebugToStdErr()) {
    return false
  }

  // 非 ant 用户仅在调试模式激活时（启动时加 --debug 或会话中 /debug）写调试日志。
  // ant 用户始终记录日志，用于 /share 和错误报告。
  if (process.env.USER_TYPE !== 'ant' && !isDebugMode()) {
    return false
  }

  if (
    typeof process === 'undefined' ||
    typeof process.versions === 'undefined' ||
    typeof process.versions.node === 'undefined'
  ) {
    return false
  }

  const filter = getDebugFilter()
  return shouldShowDebugMessage(message, filter)
}

let hasFormattedOutput = false
export function setHasFormattedOutput(value: boolean): void {
  hasFormattedOutput = value
}
export function getHasFormattedOutput(): boolean {
  return hasFormattedOutput
}

let debugWriter: BufferedWriter | null = null
let pendingWrite: Promise<void> = Promise.resolve()

// 模块级函数，使 .bind 仅捕获显式参数，而非 writeFn 闭包的父作用域（Jarred, #22257）。
async function appendAsync(
  needMkdir: boolean,
  dir: string,
  path: string,
  content: string,
): Promise<void> {
  if (needMkdir) {
    await mkdir(dir, { recursive: true }).catch(() => {})
  }
  await appendFile(path, content)
  void updateLatestDebugLogSymlink()
}

function noop(): void {}

function getDebugWriter(): BufferedWriter {
  if (!debugWriter) {
    let ensuredDir: string | null = null
    debugWriter = createBufferedWriter({
      writeFn: content => {
        const path = getDebugLogPath()
        const dir = dirname(path)
        const needMkdir = ensuredDir !== dir
        ensuredDir = dir
        if (isDebugMode()) {
          // immediateMode：必须保持同步。异步写入在 process.exit() 直接退出时会丢失，
          // 且会在 beforeExit 处理器中保持事件循环存活（Perfetto 追踪无限循环）。见 #22257。
          if (needMkdir) {
            try {
              getFsImplementation().mkdirSync(dir)
            } catch {
              // 目录已存在
            }
          }
          getFsImplementation().appendFileSync(path, content)
          void updateLatestDebugLogSymlink()
          return
        }
        // 缓冲路径（无 --debug 的 ant 用户）：约 1 秒刷新一次，保持链深度约为 1。
        // 使用 .bind 替代闭包，确保只保留绑定参数，不持有当前作用域。
        pendingWrite = pendingWrite
          .then(appendAsync.bind(null, needMkdir, dir, path, content))
          .catch(noop)
      },
      flushIntervalMs: 1000,
      maxBufferSize: 100,
      immediateMode: isDebugMode(),
    })
    registerCleanup(async () => {
      debugWriter?.dispose()
      await pendingWrite
    })
  }
  return debugWriter
}

export async function flushDebugLogs(): Promise<void> {
  debugWriter?.flush()
  await pendingWrite
}

export function logForDebugging(
  message: string,
  { level }: { level: DebugLogLevel } = {
    level: 'debug',
  },
): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[getMinDebugLogLevel()]) {
    return
  }
  // 通知 bridge 调试面板 sink（在 shouldLogDebugMessage 之前，确保 bridge
  // 模式下即使未启用文件日志也能看到日志）。sink 内部不能再调用 logForDebugging。
  try {
    _debugLogSink?.(level, message, new Date().toISOString())
  } catch {}
  if (!shouldLogDebugMessage(message)) {
    return
  }

  // 多行消息会破坏 jsonl 输出格式，因此将多行消息转为 JSON。
  if (hasFormattedOutput && message.includes('\n')) {
    message = jsonStringify(message)
  }
  const timestamp = new Date().toISOString()
  const output = `${timestamp} [${level.toUpperCase()}] ${message.trim()}\n`
  if (isDebugToStdErr()) {
    writeToStderr(output)
    return
  }

  console.info(output.trim())
  getDebugWriter().write(output)
}

export function getDebugLogPath(): string {
  return (
    getDebugFilePath() ??
    process.env.CLAUDE_CODE_DEBUG_LOGS_DIR ??
    join(getClaudeConfigHomeDir(), 'debug', `${getSessionId()}.txt`)
  )
}

/**
 * 更新最新调试日志软链接，使其指向当前调试日志文件。
 * 在 ~/.hclaude/debug/latest 处创建或更新软链接。
 */
const updateLatestDebugLogSymlink = memoize(async (): Promise<void> => {
  try {
    const debugLogPath = getDebugLogPath()
    const debugLogsDir = dirname(debugLogPath)
    const latestSymlinkPath = join(debugLogsDir, 'latest')

    await unlink(latestSymlinkPath).catch(() => {})
    await symlink(debugLogPath, latestSymlinkPath)
  } catch {
    // 软链接创建失败时静默忽略
  }
})

/**
 * 仅限 ant 用户的错误日志，在生产环境中始终可见。
 */
export function logAntError(context: string, error: unknown): void {
  if (process.env.USER_TYPE !== 'ant') {
    return
  }

  if (error instanceof Error && error.stack) {
    logForDebugging(`[ANT-ONLY] ${context} stack trace:\n${error.stack}`, {
      level: 'error',
    })
  }
}
