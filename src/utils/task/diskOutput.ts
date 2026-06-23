import { constants as fsConstants } from 'fs'
import {
  type FileHandle,
  mkdir,
  open,
  stat,
  symlink,
  unlink,
} from 'fs/promises'
import { join } from 'path'
import { getSessionId } from '../../bootstrap/state.js'
import { getErrnoCode } from '../errors.js'
import { readFileRange, tailFile } from '../fsOperations.js'
import { logError } from '../log.js'
import { getProjectTempDir } from '../permissions/filesystem.js'

// 安全性：O_NOFOLLOW 防止打开任务输出文件时跟随符号链接。
// 如果没有这个标志，沙箱中的攻击者可以在 tasks 目录中创建指向任意文件的符号链接，
// 导致宿主机上的 Claude Code 写入这些文件。
// O_NOFOLLOW 在 Windows 上不可用，但沙箱攻击向量仅限于 Unix 系统。
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0

const DEFAULT_MAX_READ_BYTES = 8 * 1024 * 1024 // 8MB（默认最大读取字节数）

/**
 * 任务输出文件的磁盘容量上限。在文件模式（bash）下，看门狗会轮询
 * 文件大小并终止进程。在管道模式（hooks）下，DiskTaskOutput
 * 会丢弃超过此限制的数据块。共享此常量以确保两种上限保持一致。
 */
export const MAX_TASK_OUTPUT_BYTES = 5 * 1024 * 1024 * 1024
export const MAX_TASK_OUTPUT_BYTES_DISPLAY = '5GB'

/**
 * 获取当前会话的任务输出目录。
 * 使用项目临时目录，这样 checkReadableInternalPath 会自动允许读取。
 *
 * 路径中包含会话 ID，这样同一项目中的并发会话不会相互覆盖输出文件。
 * 之前一个会话的启动清理会删除其他会话正在使用的输出文件——写入进程的
 * 文件描述符保持 inode 存活，但通过路径读取会返回 ENOENT，getStdout()
 * 返回空字符串（inc-4586 / boris-20260309-060423）。
 *
 * 会话 ID 在首次调用时捕获，而不是每次调用时重新读取。
 * /clear 会调用 regenerateSessionId()，否则会导致 ensureOutputDir()
 * 创建新会话路径，而现有的 TaskOutput 实例仍持有旧会话路径——
 * open() 会返回 ENOENT。在 /clear 后仍需存活的后台 bash 任务
 * 需要其输出文件保持可访问。
 */
let _taskOutputDir: string | undefined
export function getTaskOutputDir(): string {
  if (_taskOutputDir === undefined) {
    _taskOutputDir = join(getProjectTempDir(), getSessionId(), 'tasks')
  }
  return _taskOutputDir
}

/** 测试辅助函数 — 清除已缓存的目录。 */
export function _resetTaskOutputDirForTest(): void {
  _taskOutputDir = undefined
}

/**
 * 确保任务输出目录存在
 */
async function ensureOutputDir(): Promise<void> {
  await mkdir(getTaskOutputDir(), { recursive: true })
}

/**
 * 获取任务的输出文件路径
 */
export function getTaskOutputPath(taskId: string): string {
  return join(getTaskOutputDir(), `${taskId}.output`)
}

// 追踪即发即忘的 Promise（initTaskOutput、initTaskOutputAsSymlink、
// evictTaskOutput、#drain），以便测试在 teardown 前排空。防止
// teardown 后异步 ENOENT 的偶发问题（#24957、#25065）：被 void 的异步
// 操作在 preload 的 afterEach 删除临时目录后恢复 → ENOENT → 未处理的
// rejection → 偶发测试失败。使用 allSettled 确保一个 rejection 不会中断
// 排空流程，导致其他操作与 rmSync 竞争。
const _pendingOps = new Set<Promise<unknown>>()
function track<T>(p: Promise<T>): Promise<T> {
  _pendingOps.add(p)
  void p.finally(() => _pendingOps.delete(p)).catch(() => {})
  return p
}

/**
 * 封装单个任务输出的异步磁盘写入。
 *
 * 使用扁平数组作为写入队列，由单个排空循环处理，
 * 这样每个数据块在写入完成后可以立即被 GC 回收。
 * 这避免了链式 .then() 闭包的内存保留问题，
 * 因为每个反应都会捕获其数据直到整个链完成。
 */
export class DiskTaskOutput {
  #path: string
  #fileHandle: FileHandle | null = null
  #queue: string[] = []
  #bytesWritten = 0
  #capped = false
  #flushPromise: Promise<void> | null = null
  #flushResolve: (() => void) | null = null

  constructor(taskId: string) {
    this.#path = getTaskOutputPath(taskId)
  }

  append(content: string): void {
    if (this.#capped) {
      return
    }
    // content.length（UTF-16 码元）最多低估 UTF-8 字节数约 3 倍。
    // 对于粗略的磁盘填充防护来说可以接受——避免重新扫描每个数据块。
    this.#bytesWritten += content.length
    if (this.#bytesWritten > MAX_TASK_OUTPUT_BYTES) {
      this.#capped = true
      this.#queue.push(
        `\n[output truncated: exceeded ${MAX_TASK_OUTPUT_BYTES_DISPLAY} disk cap]\n`,
      )
    } else {
      this.#queue.push(content)
    }
    if (!this.#flushPromise) {
      this.#flushPromise = new Promise<void>(resolve => {
        this.#flushResolve = resolve
      })
      void track(this.#drain())
    }
  }

  flush(): Promise<void> {
    return this.#flushPromise ?? Promise.resolve()
  }

  cancel(): void {
    this.#queue.length = 0
  }

  async #drainAllChunks(): Promise<void> {
    while (true) {
      try {
        if (!this.#fileHandle) {
          await ensureOutputDir()
          this.#fileHandle = await open(
            this.#path,
            process.platform === 'win32'
              ? 'a'
              : fsConstants.O_WRONLY |
                  fsConstants.O_APPEND |
                  fsConstants.O_CREAT |
                  O_NOFOLLOW,
          )
        }
        while (true) {
          await this.#writeAllChunks()
          if (this.#queue.length === 0) {
            break
          }
        }
      } finally {
        if (this.#fileHandle) {
          const fileHandle = this.#fileHandle
          this.#fileHandle = null
          await fileHandle.close()
        }
      }
      // 在等待文件关闭时可能会有另一个 .append()，所以在完全退出前再次检查队列
      if (this.#queue.length) {
        continue
      }

      break
    }
  }

  #writeAllChunks(): Promise<void> {
    // 这段代码非常精确。
    // 你**绝对不能**在这里添加 await！！这会导致内存随着队列增长而膨胀。
    // 可以在此方法的调用者（例如 #drainAllChunks）中添加 `await`，因为那不会导致 Buffer[] 在内存中保持存活。
    return this.#fileHandle!.appendFile(
      // 这个变量需要尽快被 GC 回收。
      this.#queueToBuffers(),
    )
  }

  /** 将此方法单独分开，这样 GC 不会将其保持存活超过必要的时间。 */
  #queueToBuffers(): Buffer {
    // 使用 .splice 原地修改数组，通知 GC 可以释放它。
    const queue = this.#queue.splice(0, this.#queue.length)

    let totalLength = 0
    for (const str of queue) {
      totalLength += Buffer.byteLength(str, 'utf8')
    }

    const buffer = Buffer.allocUnsafe(totalLength)
    let offset = 0
    for (const str of queue) {
      offset += buffer.write(str, offset, 'utf8')
    }

    return buffer
  }

  async #drain(): Promise<void> {
    try {
      await this.#drainAllChunks()
    } catch (e) {
      // 瞬态文件系统错误（繁忙 CI 上的 EMFILE、Windows 待删除时的 EPERM）
      // 之前会通过 `void this.#drain()` 作为未处理的 rejection 冒泡，
      // 而 flush promise 仍然会解析——调用者看到空文件而没有错误。
      // 对于瞬态情况重试一次（如果 open() 失败，队列仍完整），
      // 然后记录日志并放弃。
      logError(e)
      if (this.#queue.length > 0) {
        try {
          await this.#drainAllChunks()
        } catch (e2) {
          logError(e2)
        }
      }
    } finally {
      const resolve = this.#flushResolve!
      this.#flushPromise = null
      this.#flushResolve = null
      resolve()
    }
  }
}

const outputs = new Map<string, DiskTaskOutput>()

/**
 * 测试辅助函数 — 取消待处理的写入，等待进行中的操作完成，清除映射表。
 * backgroundShells.test.ts 和其他任务测试会生成真实的 shell，
 * 它们通过此模块写入而没有 afterEach 清理；它们的条目
 * 会泄漏到同一分片中的 diskOutput.test.ts。
 *
 * 等待所有追踪的 Promise 直到集合稳定——正在 settled 的 promise
 * 可能会产生另一个（initTaskOutputAsSymlink 的 catch → initTaskOutput）。
 * 在 afterEach 中在 rmSync 之前调用此函数，以避免 teardown 后异步 ENOENT。
 */
export async function _clearOutputsForTest(): Promise<void> {
  for (const output of outputs.values()) {
    output.cancel()
  }
  while (_pendingOps.size > 0) {
    await Promise.allSettled([..._pendingOps])
  }
  outputs.clear()
}

function getOrCreateOutput(taskId: string): DiskTaskOutput {
  let output = outputs.get(taskId)
  if (!output) {
    output = new DiskTaskOutput(taskId)
    outputs.set(taskId, output)
  }
  return output
}

/**
 * 异步追加输出到任务的磁盘文件。
 * 如果文件不存在则创建。
 */
export function appendTaskOutput(taskId: string, content: string): void {
  getOrCreateOutput(taskId).append(content)
}

/**
 * 等待任务的所有待处理写入完成。
 * 在读取输出之前使用此函数以确保所有数据已刷新。
 */
export async function flushTaskOutput(taskId: string): Promise<void> {
  const output = outputs.get(taskId)
  if (output) {
    await output.flush()
  }
}

/**
 * 在刷新后将任务的 DiskTaskOutput 从内存映射表中逐出。
 * 与 cleanupTaskOutput 不同，此函数不会删除磁盘上的输出文件。
 * 当任务完成且其输出已被消费时调用此函数。
 */
export function evictTaskOutput(taskId: string): Promise<void> {
  return track(
    (async () => {
      const output = outputs.get(taskId)
      if (output) {
        await output.flush()
        outputs.delete(taskId)
      }
    })(),
  )
}

/**
 * 获取自上次读取以来的增量（新内容）。
 * 仅从字节偏移处读取，最多读取 maxBytes——永远不会加载整个文件。
 */
export async function getTaskOutputDelta(
  taskId: string,
  fromOffset: number,
  maxBytes: number = DEFAULT_MAX_READ_BYTES,
): Promise<{ content: string; newOffset: number }> {
  try {
    const result = await readFileRange(
      getTaskOutputPath(taskId),
      fromOffset,
      maxBytes,
    )
    if (!result) {
      return { content: '', newOffset: fromOffset }
    }
    return {
      content: result.content,
      newOffset: fromOffset + result.bytesRead,
    }
  } catch (e) {
    const code = getErrnoCode(e)
    if (code === 'ENOENT') {
      return { content: '', newOffset: fromOffset }
    }
    logError(e)
    return { content: '', newOffset: fromOffset }
  }
}

/**
 * 获取任务的输出，读取文件尾部内容。
 * 限制为 maxBytes 以避免将多 GB 文件加载到内存中。
 */
export async function getTaskOutput(
  taskId: string,
  maxBytes: number = DEFAULT_MAX_READ_BYTES,
): Promise<string> {
  try {
    const { content, bytesTotal, bytesRead } = await tailFile(
      getTaskOutputPath(taskId),
      maxBytes,
    )
    if (bytesTotal > bytesRead) {
      return `[${Math.round((bytesTotal - bytesRead) / 1024)}KB of earlier output omitted]\n${content}`
    }
    return content
  } catch (e) {
    const code = getErrnoCode(e)
    if (code === 'ENOENT') {
      return ''
    }
    logError(e)
    return ''
  }
}

/**
 * 获取任务输出文件的当前大小（偏移量）。
 */
export async function getTaskOutputSize(taskId: string): Promise<number> {
  try {
    return (await stat(getTaskOutputPath(taskId))).size
  } catch (e) {
    const code = getErrnoCode(e)
    if (code === 'ENOENT') {
      return 0
    }
    logError(e)
    return 0
  }
}

/**
 * 清理任务的输出文件和写入队列。
 */
export async function cleanupTaskOutput(taskId: string): Promise<void> {
  const output = outputs.get(taskId)
  if (output) {
    output.cancel()
    outputs.delete(taskId)
  }

  try {
    await unlink(getTaskOutputPath(taskId))
  } catch (e) {
    const code = getErrnoCode(e)
    if (code === 'ENOENT') {
      return
    }
    logError(e)
  }
}

/**
 * 初始化新任务的输出文件。
 * 创建空文件以确保路径存在。
 */
export function initTaskOutput(taskId: string): Promise<string> {
  return track(
    (async () => {
      await ensureOutputDir()
      const outputPath = getTaskOutputPath(taskId)
      // 安全性：O_NOFOLLOW 防止沙箱中的符号链接跟随攻击。
      // O_EXCL 确保我们创建新文件，如果此路径已存在文件则失败。
      // 在 Windows 上，使用字符串标志——数字形式的 O_EXCL 通过 libuv 可能产生 EINVAL。
      const fh = await open(
        outputPath,
        process.platform === 'win32'
          ? 'wx'
          : fsConstants.O_WRONLY |
              fsConstants.O_CREAT |
              fsConstants.O_EXCL |
              O_NOFOLLOW,
      )
      await fh.close()
      return outputPath
    })(),
  )
}

/**
 * 将输出文件初始化为指向另一个文件的符号链接（例如 agent 转录）。
 * 首先尝试创建符号链接；如果文件已存在，删除后重试。
 */
export function initTaskOutputAsSymlink(
  taskId: string,
  targetPath: string,
): Promise<string> {
  return track(
    (async () => {
      try {
        await ensureOutputDir()
        const outputPath = getTaskOutputPath(taskId)

        try {
          await symlink(targetPath, outputPath)
        } catch {
          await unlink(outputPath)
          await symlink(targetPath, outputPath)
        }

        return outputPath
      } catch (error) {
        logError(error)
        return initTaskOutput(taskId)
      }
    })(),
  )
}
