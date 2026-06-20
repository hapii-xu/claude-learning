import { sleep } from '../../utils/sleep.js'

/**
 * 面向 PUT /worker 的合并式上传器（session 状态 + 元数据）。
 *
 * - 1 个在途 PUT + 1 个挂起 patch
 * - 新调用会合并进挂起项（不会超过 1 个槽位）
 * - 成功时：若存在挂起项则发送
 * - 失败时：指数退避（有上限），无限重试直到成功或 close()。
 *   每次重试前吸收所有挂起的 patch。
 * - 无需背压 —— 天然被限制在 2 个槽位
 *
 * 合并规则：
 * - 顶层 key（worker_status、external_metadata）—— 后值优先
 * - external_metadata / internal_metadata 内部 —— RFC 7396 合并：
 *   key 被新增/覆盖，null 值保留（服务端据此删除）
 */

type WorkerStateUploaderConfig = {
  send: (body: Record<string, unknown>) => Promise<boolean>
  /** 指数退避的基准延迟（ms） */
  baseDelayMs: number
  /** 最大延迟上限（ms） */
  maxDelayMs: number
  /** 加到重试延迟上的随机抖动范围（ms） */
  jitterMs: number
}

export class WorkerStateUploader {
  private inflight: Promise<void> | null = null
  private pending: Record<string, unknown> | null = null
  private closed = false
  private readonly config: WorkerStateUploaderConfig

  constructor(config: WorkerStateUploaderConfig) {
    this.config = config
  }

  /**
   * 入队一个发往 PUT /worker 的 patch。会与任何已存在的挂起 patch 合并。
   * Fire-and-forget —— 调用方无需 await。
   */
  enqueue(patch: Record<string, unknown>): void {
    if (this.closed) return
    this.pending = this.pending ? coalescePatches(this.pending, patch) : patch
    void this.drain()
  }

  close(): void {
    this.closed = true
    this.pending = null
  }

  private async drain(): Promise<void> {
    if (this.inflight || this.closed) return
    if (!this.pending) return

    const payload = this.pending
    this.pending = null

    this.inflight = this.sendWithRetry(payload).then(() => {
      this.inflight = null
      if (this.pending && !this.closed) {
        void this.drain()
      }
    })
  }

  /** 以指数退避无限重试，直到成功或 close()。 */
  private async sendWithRetry(payload: Record<string, unknown>): Promise<void> {
    let current = payload
    let failures = 0
    while (!this.closed) {
      const ok = await this.config.send(current)
      if (ok) return

      failures++
      await sleep(this.retryDelay(failures))

      // 吸收重试期间到达的任何 patch
      if (this.pending && !this.closed) {
        current = coalescePatches(current, this.pending)
        this.pending = null
      }
    }
  }

  private retryDelay(failures: number): number {
    const exponential = Math.min(
      this.config.baseDelayMs * 2 ** (failures - 1),
      this.config.maxDelayMs,
    )
    const jitter = Math.random() * this.config.jitterMs
    return exponential + jitter
  }
}

/**
 * 合并两个发往 PUT /worker 的 patch。
 *
 * 顶层 key：overlay 覆盖 base（后值优先）。
 * 元数据 key（external_metadata、internal_metadata）：RFC 7396 合并一层
 * —— overlay 的 key 被新增/覆盖，null 值保留以便服务端删除。
 */
function coalescePatches(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...base }

  for (const [key, value] of Object.entries(overlay)) {
    if (
      (key === 'external_metadata' || key === 'internal_metadata') &&
      merged[key] &&
      typeof merged[key] === 'object' &&
      typeof value === 'object' &&
      value !== null
    ) {
      // RFC 7396 合并 —— overlay 的 key 优先，null 保留以便服务端删除
      merged[key] = {
        ...(merged[key] as Record<string, unknown>),
        ...(value as Record<string, unknown>),
      }
    } else {
      merged[key] = value
    }
  }

  return merged
}
