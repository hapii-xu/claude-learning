type QueueItem<T extends unknown[], R> = {
  args: T
  resolve: (value: R) => void
  reject: (reason?: unknown) => void
  context: unknown
}

/**
 * 为异步函数创建顺序执行包装器，以防止竞态条件。
 * 确保对包装函数的并发调用按接收顺序逐个执行，
 * 同时保留正确的返回值。
 *
 * 适用于必须顺序执行的操作，例如文件写入或数据库更新，
 * 这些操作如果并发执行可能会导致冲突。
 *
 * @param fn - 要用顺序执行包装的异步函数
 * @returns 按顺序执行调用的函数包装版本
 */
export function sequential<T extends unknown[], R>(
  fn: (...args: T) => Promise<R>,
): (...args: T) => Promise<R> {
  const queue: QueueItem<T, R>[] = []
  let processing = false

  async function processQueue(): Promise<void> {
    if (processing) return
    if (queue.length === 0) return

    processing = true

    while (queue.length > 0) {
      const { args, resolve, reject, context } = queue.shift()!

      try {
        const result = await fn.apply(context, args)
        resolve(result)
      } catch (error) {
        reject(error)
      }
    }

    processing = false

    // 检查在处理期间是否有新项被添加
    if (queue.length > 0) {
      void processQueue()
    }
  }

  return function (this: unknown, ...args: T): Promise<R> {
    return new Promise((resolve, reject) => {
      queue.push({ args, resolve, reject, context: this })
      void processQueue()
    })
  }
}
