import { type Options as ExecaOptions, execaSync } from 'execa'
import { getCwd } from '../utils/cwd.js'
import { slowLogging } from './slowOperations.js'

const MS_IN_SECOND = 1000
const SECONDS_IN_MINUTE = 60

type ExecSyncOptions = {
  abortSignal?: AbortSignal
  timeout?: number
  input?: string
  stdio?: ExecaOptions['stdio']
}

/**
 * @deprecated 对非阻塞执行请直接使用 `execa` 并配合 `{ shell: true, reject: false }`。
 * 同步 exec 调用会阻塞事件循环并导致性能问题。
 */
export function execSyncWithDefaults_DEPRECATED(command: string): string | null
/**
 * @deprecated 对非阻塞执行请直接使用 `execa` 并配合 `{ shell: true, reject: false }`。
 * 同步 exec 调用会阻塞事件循环并导致性能问题。
 */
export function execSyncWithDefaults_DEPRECATED(
  command: string,
  options: ExecSyncOptions,
): string | null
/**
 * @deprecated 对非阻塞执行请直接使用 `execa` 并配合 `{ shell: true, reject: false }`。
 * 同步 exec 调用会阻塞事件循环并导致性能问题。
 */
export function execSyncWithDefaults_DEPRECATED(
  command: string,
  abortSignal: AbortSignal,
  timeout?: number,
): string | null
/**
 * @deprecated 对非阻塞执行请直接使用 `execa` 并配合 `{ shell: true, reject: false }`。
 * 同步 exec 调用会阻塞事件循环并导致性能问题。
 */
export function execSyncWithDefaults_DEPRECATED(
  command: string,
  optionsOrAbortSignal?: ExecSyncOptions | AbortSignal,
  timeout = 10 * SECONDS_IN_MINUTE * MS_IN_SECOND,
): string | null {
  let options: ExecSyncOptions

  if (optionsOrAbortSignal === undefined) {
    // 无第二个参数 - 使用默认值
    options = {}
  } else if (optionsOrAbortSignal instanceof AbortSignal) {
    // 旧签名 - 第二个参数是 AbortSignal
    options = {
      abortSignal: optionsOrAbortSignal,
      timeout,
    }
  } else {
    // 新签名 - 第二个参数是 options 对象
    options = optionsOrAbortSignal
  }

  const {
    abortSignal,
    timeout: finalTimeout = 10 * SECONDS_IN_MINUTE * MS_IN_SECOND,
    input,
    stdio = ['ignore', 'pipe', 'pipe'],
  } = options

  abortSignal?.throwIfAborted()
  using _ = slowLogging`exec: ${command.slice(0, 200)}`
  try {
    const result = (execaSync as any)(command, {
      env: process.env,
      maxBuffer: 1_000_000,
      timeout: finalTimeout,
      cwd: getCwd(),
      stdio,
      shell: true, // execSync 通常运行 shell 命令
      reject: false, // 非零退出码不抛出
      input,
    })
    if (!result.stdout) {
      return null
    }
    return result.stdout.trim() || null
  } catch {
    return null
  }
}
