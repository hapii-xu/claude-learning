import { APIUserAbortError } from '@anthropic-ai/sdk'

export class ClaudeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = this.constructor.name
  }
}

export class MalformedCommandError extends Error {}

export class AbortError extends Error {
  constructor(message?: string) {
    super(message)
    this.name = 'AbortError'
  }
}

/**
 * 当且仅当 `e` 是代码库中遇到的任何中断形状错误时为 true：
 * 我们的 AbortError 类、来自 AbortController.abort() 的 DOMException
 *（.name === 'AbortError'），或 SDK 的 APIUserAbortError。SDK 类
 * 通过 instanceof 检查，因为压缩构建会混淆类名 ——
 * constructor.name 会变成类似 'nJT'，且 SDK 从不设置
 * this.name，因此字符串匹配在生产环境中会静默失败。
 */
export function isAbortError(e: unknown): boolean {
  return (
    e instanceof AbortError ||
    e instanceof APIUserAbortError ||
    (e instanceof Error && e.name === 'AbortError')
  )
}

/**
 * 配置文件解析错误的自定义错误类
 * 包含文件路径和应使用的默认配置
 */
export class ConfigParseError extends Error {
  filePath: string
  defaultConfig: unknown

  constructor(message: string, filePath: string, defaultConfig: unknown) {
    super(message)
    this.name = 'ConfigParseError'
    this.filePath = filePath
    this.defaultConfig = defaultConfig
  }
}

export class ShellError extends Error {
  constructor(
    public readonly stdout: string,
    public readonly stderr: string,
    public readonly code: number,
    public readonly interrupted: boolean,
  ) {
    super('Shell command failed')
    this.name = 'ShellError'
  }
}

export class TeleportOperationError extends Error {
  constructor(
    message: string,
    public readonly formattedMessage: string,
  ) {
    super(message)
    this.name = 'TeleportOperationError'
  }
}

/**
 * 带有可安全记录到遥测的消息的错误。
 * 使用长名称以确认你已验证消息不包含
 * 敏感数据（文件路径、URL、代码片段）。
 *
 * 单参数：用户和遥测使用相同消息
 * 双参数：不同消息（如完整消息含文件路径，遥测不含）
 *
 * @example
 * // 两者使用相同消息
 * throw new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
 *   'MCP server "slack" connection timed out'
 * )
 *
 * // 不同消息
 * throw new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
 *   `MCP tool timed out after ${ms}ms`,  // 日志/用户的完整消息
 *   'MCP tool timed out'                  // 遥测消息
 * )
 */
export class TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS extends Error {
  readonly telemetryMessage: string

  constructor(message: string, telemetryMessage?: string) {
    super(message)
    this.name = 'TelemetrySafeError'
    this.telemetryMessage = telemetryMessage ?? message
  }
}

export function hasExactErrorMessage(error: unknown, message: string): boolean {
  return error instanceof Error && error.message === message
}

/**
 * 将未知值规范化为 Error。
 * 在 catch 站点边界需要 Error 实例时使用。
 */
export function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e))
}

/**
 * 从未知错误类值中提取字符串消息。
 * 仅在需要消息时使用（如日志或显示）。
 */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * 从捕获的错误中提取 errno 代码（如 'ENOENT'、'EACCES'）。
 * 若错误无代码或不是 ErrnoException 则返回 undefined。
 * 替代 `(e as NodeJS.ErrnoException).code` 强转模式。
 */
export function getErrnoCode(e: unknown): string | undefined {
  if (e && typeof e === 'object' && 'code' in e && typeof e.code === 'string') {
    return e.code
  }
  return undefined
}

/**
 * 若错误为 ENOENT（文件或目录不存在）则为 true。
 * 替代 `(e as NodeJS.ErrnoException).code === 'ENOENT'`。
 */
export function isENOENT(e: unknown): boolean {
  return getErrnoCode(e) === 'ENOENT'
}

/**
 * 从捕获的错误中提取 errno 路径（触发错误的文件系统路径）。
 * 若错误无路径则返回 undefined。
 * 替代 `(e as NodeJS.ErrnoException).path` 强转模式。
 */
export function getErrnoPath(e: unknown): string | undefined {
  if (e && typeof e === 'object' && 'path' in e && typeof e.path === 'string') {
    return e.path
  }
  return undefined
}

/**
 * 从未知错误中提取错误消息 + 前 N 个栈帧。
 * 当错误作为 tool_result 流入模型时使用 —— 完整栈
 * 追踪约 500-2000 字符的大多无关内部帧，
 * 浪费上下文 token。完整栈应保留在调试日志中。
 */
export function shortErrorStack(e: unknown, maxFrames = 5): string {
  if (!(e instanceof Error)) return String(e)
  if (!e.stack) return e.message
  // V8/Bun 栈格式："Name: message\n    at frame1\n    at frame2..."
  // 第一行是消息；后续的 "    at " 行是帧。
  const lines = e.stack.split('\n')
  const header = lines[0] ?? e.message
  const frames = lines.slice(1).filter(l => l.trim().startsWith('at '))
  if (frames.length <= maxFrames) return e.stack
  return [header, ...frames.slice(0, maxFrames)].join('\n')
}

/**
 * 若错误意味着路径缺失、不可访问或
 * 结构上不可达则为 true —— 在 fs 操作后的 catch 块中
 * 用于区分预期的"不存在/无权限"与意外错误。
 *
 * 覆盖：
 *  ENOENT    —— 路径不存在
 *  EACCES    —— 权限被拒绝
 *  EPERM     —— 操作不允许
 *  ENOTDIR   —— 路径组件不是目录（如预期的目录位置
 *              存在名为 `.hclaude` 的文件）
 *  ELOOP     —— 符号链接层数过多（循环符号链接）
 */
export function isFsInaccessible(e: unknown): e is NodeJS.ErrnoException {
  const code = getErrnoCode(e)
  return (
    code === 'ENOENT' ||
    code === 'EACCES' ||
    code === 'EPERM' ||
    code === 'ENOTDIR' ||
    code === 'ELOOP'
  )
}

export type AxiosErrorKind =
  | 'auth' // 401/403 —— 调用方通常设置 skipRetry
  | 'timeout' // ECONNABORTED
  | 'network' // ECONNREFUSED/ENOTFOUND
  | 'http' // 其他 axios 错误（可能有 status）
  | 'other' // 不是 axios 错误

/**
 * 将 axios 请求中捕获的错误分类到几个桶之一。
 * 替代在同步风格服务（settingsSync、policyLimits、
 * remoteManagedSettings、teamMemorySync）中重复的
 * 约 20 行 isAxiosError → 401/403 → ECONNABORTED → ECONNREFUSED 链。
 *
 * 直接检查 `.isAxiosError` 标记属性（与
 * axios.isAxiosError() 相同）以保持此模块无依赖。
 */
export function classifyAxiosError(e: unknown): {
  kind: AxiosErrorKind
  status?: number
  message: string
} {
  const message = errorMessage(e)
  if (
    !e ||
    typeof e !== 'object' ||
    !('isAxiosError' in e) ||
    !e.isAxiosError
  ) {
    return { kind: 'other', message }
  }
  const err = e as {
    response?: { status?: number }
    code?: string
  }
  const status = err.response?.status
  if (status === 401 || status === 403) return { kind: 'auth', status, message }
  if (err.code === 'ECONNABORTED') return { kind: 'timeout', status, message }
  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
    return { kind: 'network', status, message }
  }
  return { kind: 'http', status, message }
}
