import { DEFAULT_MAX_CONCURRENCY, MAX_CONCURRENCY_CAP } from '../constants.js'

/**
 * 异步信号量。acquire() 返回一个释放函数；释放时许可直接转移给下一个等待者
 * （available 保持不变），只有无等待者时才归还。许可总数保持守恒。
 *
 * acquire(signal?) 支持取消：信号已中止或等待期间中止时立即 reject，
 * 等待者从队列中移除，不消耗许可（避免已取消的 agent 占据并发槽）。
 */
export class Semaphore {
  private available: number
  private readonly waiters: Array<{
    wake: () => void
    cleanup: () => void
  }> = []

  constructor(permits: number) {
    this.available = Math.max(1, Math.floor(permits))
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      throw new Error('Semaphore.acquire aborted (signal already aborted)')
    }
    if (this.available > 0) {
      this.available -= 1
      return () => this.release()
    }
    return new Promise<() => void>((resolve, reject) => {
      const onAbort = () => {
        const idx = this.waiters.indexOf(entry)
        if (idx >= 0) this.waiters.splice(idx, 1)
        reject(new Error('Semaphore.acquire aborted'))
      }
      const wake = () => {
        signal?.removeEventListener('abort', onAbort)
        resolve(() => this.release())
      }
      const entry = {
        wake,
        cleanup: () => signal?.removeEventListener('abort', onAbort),
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(entry)
    })
  }

  private release(): void {
    const next = this.waiters.shift()
    if (next) {
      next.wake() // 直接将许可转移给等待者
    } else {
      this.available += 1
    }
  }
}

/** 当前进程的默认并发数（向后兼容入口；针对具体运行请使用 clampMaxConcurrency 处理用户输入）。 */
export function maxConcurrency(): number {
  return DEFAULT_MAX_CONCURRENCY
}

/**
 * 将"用户指定的 maxConcurrency"规范化为合法的许可数。
 * - undefined / NaN → DEFAULT_MAX_CONCURRENCY
 * - <1 → 1（至少一个并发槽，否则 workflow 无法推进）
 * - >MAX_CONCURRENCY_CAP → MAX_CONCURRENCY_CAP
 * - 其他情况：截断后的原始值
 */
export function clampMaxConcurrency(n: number | undefined): number {
  if (n === undefined || Number.isNaN(n)) return DEFAULT_MAX_CONCURRENCY
  return Math.max(1, Math.min(Math.trunc(n), MAX_CONCURRENCY_CAP))
}
