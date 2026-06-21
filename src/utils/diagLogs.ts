import { dirname } from 'path'
import { getFsImplementation } from './fsOperations.js'
import { jsonStringify } from './slowOperations.js'

type DiagnosticLogLevel = 'debug' | 'info' | 'warn' | 'error'

type DiagnosticLogEntry = {
  timestamp: string
  level: DiagnosticLogLevel
  event: string
  data: Record<string, unknown>
}

/**
 * 将诊断信息记录到日志文件。此信息会通过环境管理器
 * 发送到 session-ingress 以监控容器内的问题。
 *
 * *重要* - 此函数绝不能包含任何 PII（个人身份信息），
 * 包括文件路径、项目名、仓库名、提示词等。
 *
 * @param level    日志级别。仅用于信息记录，不用于过滤
 * @param event    特定事件："started"、"mcp_connected" 等
 * @param data     可选的附加日志数据
 */
// 同步 IO：从同步上下文调用
export function logForDiagnosticsNoPII(
  level: DiagnosticLogLevel,
  event: string,
  data?: Record<string, unknown>,
): void {
  const logFile = getDiagnosticLogFile()
  if (!logFile) {
    return
  }

  const entry: DiagnosticLogEntry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    data: data ?? {},
  }

  const fs = getFsImplementation()
  const line = jsonStringify(entry) + '\n'
  try {
    fs.appendFileSync(logFile, line)
  } catch {
    // 若追加失败，先尝试创建目录
    try {
      fs.mkdirSync(dirname(logFile))
      fs.appendFileSync(logFile, line)
    } catch {
      // 若日志记录失败则静默忽略
    }
  }
}

function getDiagnosticLogFile(): string | undefined {
  return process.env.CLAUDE_CODE_DIAGNOSTICS_FILE
}

/**
 * 用诊断计时日志包装异步函数。
 * 执行前记录 `{event}_started`，执行后记录 `{event}_completed` 及 duration_ms。
 *
 * @param event   事件名前缀（如 "git_status" -> 记录 "git_status_started" 和 "git_status_completed"）
 * @param fn      要执行和计时的异步函数
 * @param getData 可选函数，从结果中提取附加数据以记录到完成日志
 * @returns       被包装函数的结果
 */
export async function withDiagnosticsTiming<T>(
  event: string,
  fn: () => Promise<T>,
  getData?: (result: T) => Record<string, unknown>,
): Promise<T> {
  const startTime = Date.now()
  logForDiagnosticsNoPII('info', `${event}_started`)

  try {
    const result = await fn()
    const additionalData = getData ? getData(result) : {}
    logForDiagnosticsNoPII('info', `${event}_completed`, {
      duration_ms: Date.now() - startTime,
      ...additionalData,
    })
    return result
  } catch (error) {
    logForDiagnosticsNoPII('error', `${event}_failed`, {
      duration_ms: Date.now() - startTime,
    })
    throw error
  }
}
