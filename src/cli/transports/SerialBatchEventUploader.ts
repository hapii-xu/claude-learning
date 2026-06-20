import { jsonStringify } from '../../utils/slowOperations.js'

/**
 * 串行有序的事件上传器，支持批量、重试与背压。
 *
 * - enqueue() 把事件加入 pending 缓冲区
 * - 同时最多只有 1 个 POST 在途
 * - 每次 POST 排空至多 maxBatchSize 条
 * - 在途期间到达的新事件会累积
 * - 失败时：指数退避（有上限），无限重试直到成功或 close()
 *   —— 除非设置了 maxConsecutiveFailures，此时会丢弃失败批次并继续推进
 * - flush() 阻塞到 pending 为空，必要时触发 drain
 * - 背压：达到 maxQueueSize 时 enqueue() 会阻塞
 */

/**
 * 在 config.send() 中抛出，让上传器在重试前等待服务端给出的时长
 *（例如 429 附带 Retry-After）。当设置了 retryAfterMs 时，它会覆盖本次
 * 尝试的指数退避 —— 先 clamp 到 [baseDelayMs, maxDelayMs] 再加抖动，
 * 使得行为异常的服务端既无法热循环也无法卡死客户端，且共享同一限流的
 * 多个会话不会在同一瞬间集中重试。若未设置 retryAfterMs，则与其它抛出
 * 的错误一样（指数退避）。
 */
export class RetryableError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message)
  }
}

type SerialBatchEventUploaderConfig<T> = {
  /** 每次 POST 的最大条数（1 = 不批量） */
  maxBatchSize: number
  /**
   * 每次 POST 的最大序列化字节数。第一条总是无条件进入；后续条目只有在
   * 累计 JSON 字节数低于此值时才加入。Undefined = 不限字节（仅按条数批量）。
   */
  maxBatchBytes?: number
  /** 触发 enqueue() 阻塞前的最大挂起条数 */
  maxQueueSize: number
  /** 真正的 HTTP 调用 —— 由调用方控制 payload 格式 */
  send: (batch: T[]) => Promise<void>
  /** 指数退避的基准延迟（ms） */
  baseDelayMs: number
  /** 最大延迟上限（ms） */
  maxDelayMs: number
  /** 加到重试延迟上的随机抖动范围（ms） */
  jitterMs: number
  /**
   * 连续 send() 失败达到此次数后，丢弃失败批次，并以全新的失败预算继续
   * 处理下一条挂起条目。Undefined = 无限重试（默认）。
   */
  maxConsecutiveFailures?: number
  /** 当某批次因达到 maxConsecutiveFailures 而被丢弃时调用。 */
  onBatchDropped?: (batchSize: number, failures: number) => void
}

export class SerialBatchEventUploader<T> {
  private pending: T[] = []
  private pendingAtClose = 0
  private draining = false
  private closed = false
  private backpressureResolvers: Array<() => void> = []
  private sleepResolve: (() => void) | null = null
  private flushResolvers: Array<() => void> = []
  private droppedBatches = 0
  private readonly config: SerialBatchEventUploaderConfig<T>

  constructor(config: SerialBatchEventUploaderConfig<T>) {
    this.config = config
  }

  /**
   * 通过 maxConsecutiveFailures 丢弃的批次计数（单调）。调用方可以在
   * flush() 之前快照、之后比较，以检测静默丢弃（即使有批次被丢弃，
   * flush() 也会正常 resolve）。
   */
  get droppedBatchCount(): number {
    return this.droppedBatches
  }

  /**
   * 挂起队列深度。close() 之后返回关闭那一刻的计数 —— close() 会清空队列，
   * 但关闭诊断可能会在此之后读取它。
   */
  get pendingCount(): number {
    return this.closed ? this.pendingAtClose : this.pending.length
  }

  /**
   * 将事件加入 pending 缓冲区。若有空间则立即返回。缓冲区满时阻塞
   *（await）—— 调用方暂停，直到 drain 释放出空间。
   */
  async enqueue(events: T | T[]): Promise<void> {
    if (this.closed) return
    const items = Array.isArray(events) ? events : [events]
    if (items.length === 0) return

    // 背压：等待直到有空间
    while (
      this.pending.length + items.length > this.config.maxQueueSize &&
      !this.closed
    ) {
      await new Promise<void>(resolve => {
        this.backpressureResolvers.push(resolve)
      })
    }

    if (this.closed) return
    this.pending.push(...items)
    void this.drain()
  }

  /**
   * 阻塞直到所有挂起事件都已发送。
   * 在轮次边界和优雅关闭时使用。
   */
  flush(): Promise<void> {
    if (this.pending.length === 0 && !this.draining) {
      return Promise.resolve()
    }
    void this.drain()
    return new Promise<void>(resolve => {
      this.flushResolvers.push(resolve)
    })
  }

  /**
   * 丢弃挂起事件并停止处理。
   * resolve 所有被阻塞的 enqueue() 和 flush() 调用方。
   */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.pendingAtClose = this.pending.length
    this.pending = []
    this.sleepResolve?.()
    this.sleepResolve = null
    for (const resolve of this.backpressureResolvers) resolve()
    this.backpressureResolvers = []
    for (const resolve of this.flushResolvers) resolve()
    this.flushResolvers = []
  }

  /**
   * 排空循环。同一时刻最多只有一个实例在运行（由 this.draining 守卫）。
   * 串行发送批次。失败时退避并无限重试。
   */
  private async drain(): Promise<void> {
    if (this.draining || this.closed) return
    this.draining = true
    let failures = 0

    try {
      while (this.pending.length > 0 && !this.closed) {
        const batch = this.takeBatch()
        if (batch.length === 0) continue

        try {
          await this.config.send(batch)
          failures = 0
        } catch (err) {
          failures++
          if (
            this.config.maxConsecutiveFailures !== undefined &&
            failures >= this.config.maxConsecutiveFailures
          ) {
            this.droppedBatches++
            this.config.onBatchDropped?.(batch.length, failures)
            failures = 0
            this.releaseBackpressure()
            continue
          }
          // 把失败批次重新放回队首。使用 concat（单次分配），而不是
          // unshift(...batch)，后者会把每个挂起条目移动 batch.length 次。
          // 只在失败路径上走到这里。
          this.pending = batch.concat(this.pending)
          const retryAfterMs =
            err instanceof RetryableError ? err.retryAfterMs : undefined
          await this.sleep(this.retryDelay(failures, retryAfterMs))
          continue
        }

        // 若腾出了空间，则释放背压等待者
        this.releaseBackpressure()
      }
    } finally {
      this.draining = false
      // 若队列已空，通知 flush 等待者
      if (this.pending.length === 0) {
        for (const resolve of this.flushResolvers) resolve()
        this.flushResolvers = []
      }
    }
  }

  /**
   * 从 pending 中取下一批。同时遵守 maxBatchSize 和 maxBatchBytes。
   * 第一条总是被取走；后续条目只有在加入后累计 JSON 大小仍小于
   * maxBatchBytes 时才被取走。
   *
   * 无法序列化的条目（BigInt、循环引用、抛出的 toJSON）会被原地丢弃
   * —— 它们永远无法被发送，留在 pending[0] 会污染队列并让 flush()
   * 永远挂起。
   */
  private takeBatch(): T[] {
    const { maxBatchSize, maxBatchBytes } = this.config
    if (maxBatchBytes === undefined) {
      return this.pending.splice(0, maxBatchSize)
    }
    let bytes = 0
    let count = 0
    while (count < this.pending.length && count < maxBatchSize) {
      let itemBytes: number
      try {
        itemBytes = Buffer.byteLength(jsonStringify(this.pending[count]))
      } catch {
        this.pending.splice(count, 1)
        continue
      }
      if (count > 0 && bytes + itemBytes > maxBatchBytes) break
      bytes += itemBytes
      count++
    }
    return this.pending.splice(0, count)
  }

  private retryDelay(failures: number, retryAfterMs?: number): number {
    const jitter = Math.random() * this.config.jitterMs
    if (retryAfterMs !== undefined) {
      // 在服务端提示之上再加抖动，可避免多个会话共享同一限流、收到相同
      // Retry-After 时出现惊群。先 clamp 再扩散 —— 与指数路径形状一致
      //（有效上限为 maxDelayMs + jitterMs）。
      const clamped = Math.max(
        this.config.baseDelayMs,
        Math.min(retryAfterMs, this.config.maxDelayMs),
      )
      return clamped + jitter
    }
    const exponential = Math.min(
      this.config.baseDelayMs * 2 ** (failures - 1),
      this.config.maxDelayMs,
    )
    return exponential + jitter
  }

  private releaseBackpressure(): void {
    const resolvers = this.backpressureResolvers
    this.backpressureResolvers = []
    for (const resolve of resolvers) resolve()
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      this.sleepResolve = resolve
      setTimeout(
        (self, resolve) => {
          self.sleepResolve = null
          resolve()
        },
        ms,
        this,
        resolve,
      )
    })
  }
}
