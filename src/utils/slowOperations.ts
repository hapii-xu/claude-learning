import { feature } from 'bun:bundle'
import type { WriteFileOptions } from 'fs'
import {
  closeSync,
  writeFileSync as fsWriteFileSync,
  fsyncSync,
  openSync,
} from 'fs'
import lodashCloneDeep from 'lodash-es/cloneDeep.js'
import { addSlowOperation } from '../bootstrap/state.js'
import { logForDebugging } from './debug.js'

// 扩展的 WriteFileOptions，包含在 Node.js 20.1.0+ 中可用
// 但尚未在 @types/node 中的 'flush'
type WriteFileOptionsWithFlush =
  | WriteFileOptions
  | (WriteFileOptions & { flush?: boolean })

// --- 慢操作日志基础设施 ---

/**
 * 记录慢 JSON/clone 操作的阈值（毫秒）。
 * 超过此阈值的操作将被记录以便调试。
 * - 覆盖：设置 CLAUDE_CODE_SLOW_OPERATION_THRESHOLD_MS 为数字
 * - Dev 构建：20ms（较低的开发阈值）
 * - Ant 用户：300ms（为所有内部用户启用）
 */
const SLOW_OPERATION_THRESHOLD_MS = (() => {
  const envValue = process.env.CLAUDE_CODE_SLOW_OPERATION_THRESHOLD_MS
  if (envValue !== undefined) {
    const parsed = Number(envValue)
    if (!Number.isNaN(parsed) && parsed >= 0) {
      return parsed
    }
  }
  if (process.env.NODE_ENV === 'development') {
    return 20
  }
  if (process.env.USER_TYPE === 'ant') {
    return 300
  }
  return Infinity
})()

// 为仍需要直接访问阈值值的调用方再导出
export { SLOW_OPERATION_THRESHOLD_MS }

// 模块级重入保护。logForDebugging 通过 appendFileSync 写入调试文件，
// 该调用再次经过 slowLogging。没有此保护，慢 appendFileSync → dispose →
// logForDebugging → appendFileSync → dispose → ... 会无限循环。
let isLogging = false

/**
 * 提取此文件之外的第一个栈帧，使 DevBar 警告指向实际调用方
 * 而非无用的 `Object{N keys}`。
 * 仅在操作确实很慢时调用 — 不在快速路径上。
 */
export function callerFrame(stack: string | undefined): string {
  if (!stack) return ''
  for (const line of stack.split('\n')) {
    if (line.includes('slowOperations')) continue
    const m = line.match(/([^/\\]+?):(\d+):\d+\)?$/)
    if (m) return ` @ ${m[1]}:${m[2]}`
  }
  return ''
}

/**
 * 从带标签的模板参数构建人类可读的描述。
 * 仅在操作确实很慢时调用 — 不在快速路径上。
 *
 * args[0] = TemplateStringsArray，args[1..n] = 插值值
 */
function buildDescription(args: IArguments): string {
  const strings = args[0] as TemplateStringsArray
  let result = ''
  for (let i = 0; i < strings.length; i++) {
    result += strings[i]
    if (i + 1 < args.length) {
      const v = args[i + 1]
      if (Array.isArray(v)) {
        result += `Array[${(v as unknown[]).length}]`
      } else if (v !== null && typeof v === 'object') {
        result += `Object{${Object.keys(v as Record<string, unknown>).length} keys}`
      } else if (typeof v === 'string') {
        result += v.length > 80 ? `${v.slice(0, 80)}…` : v
      } else {
        result += String(v)
      }
    }
  }
  return result
}

class AntSlowLogger {
  startTime: number
  args: IArguments
  err: Error

  constructor(args: IArguments) {
    this.startTime = performance.now()
    this.args = args
    // V8/JSC 在构造时捕获栈但延迟昂贵的字符串格式化
    // 直到读取 .stack — 因此这保持在快速路径之外。
    this.err = new Error()
  }

  [Symbol.dispose](): void {
    const duration = performance.now() - this.startTime
    if (duration > SLOW_OPERATION_THRESHOLD_MS && !isLogging) {
      isLogging = true
      try {
        const description =
          buildDescription(this.args) + callerFrame(this.err.stack)
        logForDebugging(
          `[SLOW OPERATION DETECTED] ${description} (${duration.toFixed(1)}ms)`,
        )
        addSlowOperation(description, duration)
      } finally {
        isLogging = false
      }
    }
  }
}

const NOOP_LOGGER: Disposable = { [Symbol.dispose]() {} }

// 必须是普通函数（非箭头函数）以访问 `arguments`
function slowLoggingAnt(
  _strings: TemplateStringsArray,
  ..._values: unknown[]
): AntSlowLogger {
  // eslint-disable-next-line prefer-rest-params
  // biome-ignore lint/complexity/noArguments: 有意使用 arguments 对象传给 AntSlowLogger
  return new AntSlowLogger(arguments)
}

function slowLoggingExternal(): Disposable {
  return NOOP_LOGGER
}

/**
 * 慢操作日志的带标签模板。
 *
 * 在 ANT 构建中：创建 AntSlowLogger，计时操作，超过阈值时记录。
 * 描述仅在操作确实很慢时延迟构建。
 *
 * 在外部构建中：返回单例空操作 disposable。零分配，零计时。
 * AntSlowLogger 和 buildDescription 被死代码消除。
 *
 * @example
 * using _ = slowLogging`structuredClone(${value})`
 * const result = structuredClone(value)
 */
export const slowLogging: (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Disposable = feature('SLOW_OPERATION_LOGGING')
  ? slowLoggingAnt
  : slowLoggingExternal

// --- 包装的操作 ---

/**
 * 带慢操作日志的包装 JSON.stringify。
 * 使用此函数而非直接使用 JSON.stringify 以检测性能问题。
 *
 * @example
 * import { jsonStringify } from './slowOperations.js'
 * const json = jsonStringify(data)
 * const prettyJson = jsonStringify(data, null, 2)
 */
export function jsonStringify(
  value: unknown,
  replacer?: (this: unknown, key: string, value: unknown) => unknown,
  space?: string | number,
): string
export function jsonStringify(
  value: unknown,
  replacer?: (number | string)[] | null,
  space?: string | number,
): string
export function jsonStringify(
  value: unknown,
  replacer?:
    | ((this: unknown, key: string, value: unknown) => unknown)
    | (number | string)[]
    | null,
  space?: string | number,
): string {
  using _ = slowLogging`JSON.stringify(${value})`
  return JSON.stringify(
    value,
    replacer as Parameters<typeof JSON.stringify>[1],
    space,
  )
}

/**
 * 带慢操作日志的包装 JSON.parse。
 * 使用此函数而非直接使用 JSON.parse 以检测性能问题。
 *
 * @example
 * import { jsonParse } from './slowOperations.js'
 * const data = jsonParse(jsonString)
 */
export const jsonParse: typeof JSON.parse = (text, reviver) => {
  using _ = slowLogging`JSON.parse(${text})`
  // V8 在传递第二个参数时会对 JSON.parse 进行去优化，即使它是 undefined。
  // 显式分支以使常见（无 reviver）路径保持在快速路径上。
  return typeof reviver === 'undefined'
    ? JSON.parse(text)
    : JSON.parse(text, reviver)
}

/**
 * 带慢操作日志的包装 structuredClone。
 * 使用此函数而非直接使用 structuredClone 以检测性能问题。
 *
 * @example
 * import { clone } from './slowOperations.js'
 * const copy = clone(originalObject)
 */
export function clone<T>(value: T, options?: StructuredSerializeOptions): T {
  using _ = slowLogging`structuredClone(${value})`
  return structuredClone(value, options)
}

/**
 * 带慢操作日志的包装 cloneDeep。
 * 使用此函数而非直接使用 lodash cloneDeep 以检测性能问题。
 *
 * @example
 * import { cloneDeep } from './slowOperations.js'
 * const copy = cloneDeep(originalObject)
 */
export function cloneDeep<T>(value: T): T {
  using _ = slowLogging`cloneDeep(${value})`
  return lodashCloneDeep(value)
}

/**
 * 带慢操作日志的 fs.writeFileSync 包装。
 * 支持 flush 选项以确保数据在返回前写入磁盘。
 * @param filePath 要写入的文件路径
 * @param data 要写入的数据（字符串或 Buffer）
 * @param options 可选的写入选项（encoding、mode、flag、flush）
 * @deprecated 使用 `fs.promises.writeFile` 代替以实现非阻塞写入。
 * 同步文件写入会阻塞事件循环并导致性能问题。
 */
export function writeFileSync_DEPRECATED(
  filePath: string,
  data: string | NodeJS.ArrayBufferView,
  options?: WriteFileOptionsWithFlush,
): void {
  using _ = slowLogging`fs.writeFileSync(${filePath}, ${data})`

  // 检查是否请求了 flush（对于对象样式选项）
  const needsFlush =
    options !== null &&
    typeof options === 'object' &&
    'flush' in options &&
    options.flush === true

  if (needsFlush) {
    // 手动 flush：打开文件、写入、fsync、关闭
    const encoding =
      typeof options === 'object' && 'encoding' in options
        ? options.encoding
        : undefined
    const mode =
      typeof options === 'object' && 'mode' in options
        ? options.mode
        : undefined
    let fd: number | undefined
    try {
      fd = openSync(filePath, 'w', mode)
      fsWriteFileSync(fd, data, { encoding: encoding ?? undefined })
      fsyncSync(fd)
    } finally {
      if (fd !== undefined) {
        closeSync(fd)
      }
    }
  } else {
    // 无需 flush，使用标准 writeFileSync
    fsWriteFileSync(filePath, data, options as WriteFileOptions)
  }
}
