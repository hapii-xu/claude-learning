import { unlink } from 'fs/promises'
import { CircularBuffer } from '../CircularBuffer.js'
import { logForDebugging } from '../debug.js'
import { readFileRange, tailFile } from '../fsOperations.js'
import { getMaxOutputLength } from '../shell/outputLimits.js'
import { safeJoinLines } from '../stringUtils.js'
import { DiskTaskOutput, getTaskOutputPath } from './diskOutput.js'

const DEFAULT_MAX_MEMORY = 8 * 1024 * 1024 // 8MB
const POLL_INTERVAL_MS = 1000
const PROGRESS_TAIL_BYTES = 4096

type ProgressCallback = (
  lastLines: string,
  allLines: string,
  totalLines: number,
  totalBytes: number,
  isIncomplete: boolean,
) => void

/**
 * Shell 命令输出的唯一真实来源。
 *
 * 对于 bash 命令（文件模式）：stdout 和 stderr 都通过 stdio fd 直接写入
 * 文件 —— 两者都不经过 JS。进度通过轮询文件尾部来提取。
 * getStderr() 返回 ''，因为 stderr 已交织在输出文件中。
 *
 * 对于 hooks（管道模式）：数据通过 writeStdout()/writeStderr() 流入，
 * 在内存中缓冲，超出限制时会溢出到磁盘。
 */
export class TaskOutput {
  readonly taskId: string
  readonly path: string
  /** stdout 是否写入文件 fd（绕过 JS）。管道模式（hooks）下为 false。 */
  readonly stdoutToFile: boolean
  #stdoutBuffer = ''
  #stderrBuffer = ''
  #disk: DiskTaskOutput | null = null
  #recentLines = new CircularBuffer<string>(1000)
  #totalLines = 0
  #totalBytes = 0
  #maxMemory: number
  #onProgress: ProgressCallback | null
  /** 由 getStdout() 设置 —— 文件被完整读取时为 true（≤ maxOutputLength）。 */
  #outputFileRedundant = false
  /** 由 getStdout() 设置 —— 文件总大小（字节）。 */
  #outputFileSize = 0

  // --- 共享轮询器状态 ---

  /** 所有文件模式 TaskOutput 实例的注册表，带有 onProgress 回调。 */
  static #registry = new Map<string, TaskOutput>()
  /** #registry 中当前正在轮询的子集（由 React 根据可见性驱动）。 */
  static #activePolling = new Map<string, TaskOutput>()
  static #pollInterval: ReturnType<typeof setInterval> | null = null

  constructor(
    taskId: string,
    onProgress: ProgressCallback | null,
    stdoutToFile = false,
    maxMemory: number = DEFAULT_MAX_MEMORY,
  ) {
    this.taskId = taskId
    this.path = getTaskOutputPath(taskId)
    this.stdoutToFile = stdoutToFile
    this.#maxMemory = maxMemory
    this.#onProgress = onProgress

    // 当 stdout 写入文件且需要进度回调时注册轮询。
    // 实际轮询由 React 通过 startPolling/stopPolling 启停。
    if (stdoutToFile && onProgress) {
      TaskOutput.#registry.set(taskId, this)
    }
  }

  /**
   * 开始轮询输出文件以获取进度。由 React
   * useEffect 在进度组件挂载时调用。
   */
  static startPolling(taskId: string): void {
    const instance = TaskOutput.#registry.get(taskId)
    if (!instance || !instance.#onProgress) {
      return
    }
    TaskOutput.#activePolling.set(taskId, instance)
    if (!TaskOutput.#pollInterval) {
      TaskOutput.#pollInterval = setInterval(TaskOutput.#tick, POLL_INTERVAL_MS)
      TaskOutput.#pollInterval.unref()
    }
  }

  /**
   * 停止轮询输出文件。由 React useEffect cleanup
   * 在进度组件卸载时调用。
   */
  static stopPolling(taskId: string): void {
    TaskOutput.#activePolling.delete(taskId)
    if (TaskOutput.#activePolling.size === 0 && TaskOutput.#pollInterval) {
      clearInterval(TaskOutput.#pollInterval)
      TaskOutput.#pollInterval = null
    }
  }

  /**
   * 共享 tick：为每个正在活跃轮询的任务读取文件尾部。
   * 使用非 async 的 body（.then）以避免 I/O 缓慢时堆叠。
   */
  static #tick(): void {
    for (const [, entry] of TaskOutput.#activePolling) {
      if (!entry.#onProgress) {
        continue
      }
      void tailFile(entry.path, PROGRESS_TAIL_BYTES).then(
        ({ content, bytesRead, bytesTotal }) => {
          if (!entry.#onProgress) {
            return
          }
          // 即使 content 为空也要调用 onProgress，这样进度
          // 循环才能唤醒并检查是否转入后台。
          // 像 `git log -S` 这样的命令会长时间无输出。
          if (!content) {
            entry.#onProgress('', '', entry.#totalLines, bytesTotal, false)
            return
          }
          // 统计尾部所有换行符，并捕获最后 5 行和最后 100 行的
          // 切片位置。不设上限以便密集输出时外推保持准确
          // （短行 → 4KB 内超过 100 个换行）。
          let pos = content.length
          let n5 = 0
          let n100 = 0
          let lineCount = 0
          while (pos > 0) {
            pos = content.lastIndexOf('\n', pos - 1)
            lineCount++
            if (lineCount === 5) n5 = pos <= 0 ? 0 : pos + 1
            if (lineCount === 100) n100 = pos <= 0 ? 0 : pos + 1
          }
          // 当整个文件在 PROGRESS_TAIL_BYTES 内时 lineCount 是精确值。
          // 否则从尾部样本外推；单调最大值可防止某次 tick 尾部行较长时计数器回退。
          const totalLines =
            bytesRead >= bytesTotal
              ? lineCount
              : Math.max(
                  entry.#totalLines,
                  Math.round((bytesTotal / bytesRead) * lineCount),
                )
          entry.#totalLines = totalLines
          entry.#totalBytes = bytesTotal
          entry.#onProgress(
            content.slice(n5),
            content.slice(n100),
            totalLines,
            bytesTotal,
            bytesRead < bytesTotal,
          )
        },
        () => {
          // 文件可能尚未创建
        },
      )
    }
  }

  /** 写入 stdout 数据（仅管道模式 —— 供 hooks 使用）。 */
  writeStdout(data: string): void {
    this.#writeBuffered(data, false)
  }

  /** 写入 stderr 数据（始终通过管道）。 */
  writeStderr(data: string): void {
    this.#writeBuffered(data, true)
  }

  #writeBuffered(data: string, isStderr: boolean): void {
    this.#totalBytes += data.length

    this.#updateProgress(data)

    // 如果已经溢出则写入磁盘
    if (this.#disk) {
      this.#disk.append(isStderr ? `[stderr] ${data}` : data)
      return
    }

    // 检查此数据块是否会超出内存限制
    const totalMem =
      this.#stdoutBuffer.length + this.#stderrBuffer.length + data.length
    if (totalMem > this.#maxMemory) {
      this.#spillToDisk(isStderr ? data : null, isStderr ? null : data)
      return
    }

    if (isStderr) {
      this.#stderrBuffer += data
    } else {
      this.#stdoutBuffer += data
    }
  }

  /**
   * 单次反向遍历：统计所有换行符（用于 totalLines）并提取
   * 最后几行作为平面副本（用于 CircularBuffer / 进度）。
   * 仅在管道模式（hooks）下使用。文件模式使用共享轮询器。
   */
  #updateProgress(data: string): void {
    const MAX_PROGRESS_BYTES = 4096
    const MAX_PROGRESS_LINES = 100

    let lineCount = 0
    const lines: string[] = []
    let extractedBytes = 0
    let pos = data.length

    while (pos > 0) {
      const prev = data.lastIndexOf('\n', pos - 1)
      if (prev === -1) {
        break
      }
      lineCount++
      if (
        lines.length < MAX_PROGRESS_LINES &&
        extractedBytes < MAX_PROGRESS_BYTES
      ) {
        const lineLen = pos - prev - 1
        if (lineLen > 0 && lineLen <= MAX_PROGRESS_BYTES - extractedBytes) {
          const line = data.slice(prev + 1, pos)
          if (line.trim()) {
            lines.push(Buffer.from(line).toString())
            extractedBytes += lineLen
          }
        }
      }
      pos = prev
    }

    this.#totalLines += lineCount

    for (let i = lines.length - 1; i >= 0; i--) {
      this.#recentLines.add(lines[i]!)
    }

    if (this.#onProgress && lines.length > 0) {
      const recent = this.#recentLines.getRecent(5)
      this.#onProgress(
        safeJoinLines(recent, '\n'),
        safeJoinLines(this.#recentLines.getRecent(100), '\n'),
        this.#totalLines,
        this.#totalBytes,
        this.#disk !== null,
      )
    }
  }

  #spillToDisk(stderrChunk: string | null, stdoutChunk: string | null): void {
    this.#disk = new DiskTaskOutput(this.taskId)

    // 刷新已有缓冲区
    if (this.#stdoutBuffer) {
      this.#disk.append(this.#stdoutBuffer)
      this.#stdoutBuffer = ''
    }
    if (this.#stderrBuffer) {
      this.#disk.append(`[stderr] ${this.#stderrBuffer}`)
      this.#stderrBuffer = ''
    }

    // 写入触发溢出的数据块
    if (stdoutChunk) {
      this.#disk.append(stdoutChunk)
    }
    if (stderrChunk) {
      this.#disk.append(`[stderr] ${stderrChunk}`)
    }
  }

  /**
   * 获取 stdout。文件模式下从输出文件读取。
   * 管道模式下返回内存缓冲区或 CircularBuffer 的尾部。
   */
  async getStdout(): Promise<string> {
    if (this.stdoutToFile) {
      return this.#readStdoutFromFile()
    }
    // 管道模式（hooks）—— 使用内存中的数据
    if (this.#disk) {
      const recent = this.#recentLines.getRecent(5)
      const tail = safeJoinLines(recent, '\n')
      const sizeKB = Math.round(this.#totalBytes / 1024)
      const notice = `\nOutput truncated (${sizeKB}KB total). Full output saved to: ${this.path}`
      return tail ? tail + notice : notice.trimStart()
    }
    return this.#stdoutBuffer
  }

  async #readStdoutFromFile(): Promise<string> {
    const maxBytes = getMaxOutputLength()
    try {
      const result = await readFileRange(this.path, 0, maxBytes)
      if (!result) {
        this.#outputFileRedundant = true
        return ''
      }
      const { content, bytesRead, bytesTotal } = result
      // 如果文件完整装入则已完全内联捕获，可以删除。
      // 否则返回已读取的内容 —— processToolResultBlock 会在下游处理
      // <persisted-output> 格式化和持久化。
      this.#outputFileSize = bytesTotal
      this.#outputFileRedundant = bytesTotal <= bytesRead
      return content
    } catch (err) {
      // 上抛错误而非静默返回空。这里的 ENOENT 意味着
      // 输出文件在命令运行期间被删除了
      // （历史原因：同一项目目录的跨会话启动清理）。
      // 返回诊断信息使 tool_result 非空，这避免了下游
      // 仅在尾部提示的困惑，并告知模型（以及通过记录中的我们）实际发生了什么。
      const code =
        err instanceof Error && 'code' in err ? String(err.code) : 'unknown'
      logForDebugging(
        `TaskOutput.#readStdoutFromFile: failed to read ${this.path} (${code}): ${err}`,
      )
      return `<bash output unavailable: output file ${this.path} could not be read (${code}). This usually means another Claude Code process in the same project deleted it during startup cleanup.>`
    }
  }

  /** 同步获取 ExecResult.stderr */
  getStderr(): string {
    if (this.#disk) {
      return ''
    }
    return this.#stderrBuffer
  }

  get isOverflowed(): boolean {
    return this.#disk !== null
  }

  get totalLines(): number {
    return this.#totalLines
  }

  get totalBytes(): number {
    return this.#totalBytes
  }

  /**
   * 在 getStdout() 调用后为 true，表示输出文件已被完整读取。
   * 文件内容已冗余（完全包含在 ExecResult.stdout 中），可以删除。
   */
  get outputFileRedundant(): boolean {
    return this.#outputFileRedundant
  }

  /** 文件总大小（字节），在 getStdout() 读取文件后设置。 */
  get outputFileSize(): number {
    return this.#outputFileSize
  }

  /** 将所有缓冲内容强制写入磁盘。转入后台时调用。 */
  spillToDisk(): void {
    if (!this.#disk) {
      this.#spillToDisk(null, null)
    }
  }

  async flush(): Promise<void> {
    await this.#disk?.flush()
  }

  /** 删除输出文件（可安全即发即弃）。 */
  async deleteOutputFile(): Promise<void> {
    try {
      await unlink(this.path)
    } catch {
      // 文件可能已被删除或不存在
    }
  }

  clear(): void {
    this.#stdoutBuffer = ''
    this.#stderrBuffer = ''
    this.#recentLines.clear()
    this.#onProgress = null
    this.#disk?.cancel()
    TaskOutput.stopPolling(this.taskId)
    TaskOutput.#registry.delete(this.taskId)
  }
}
