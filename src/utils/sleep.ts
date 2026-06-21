/**
 * 可响应中止的 sleep。在 `ms` 毫秒后解析，或在 `signal` 中止时
 * 立即解析（以便退避循环不会阻塞关闭）。
 *
 * 默认情况下，中止会静默解析；调用方应在 await 后检查
 * `signal.aborted`。传递 `throwOnAbort: true` 使中止 reject —
 * 当 sleep 深层嵌套在重试循环中且你希望 reject 冒泡并取消
 * 整个操作时很有用。
 *
 * 传递 `abortError` 以自定义 reject 错误（隐含 `throwOnAbort: true`）。
 * 对于捕获特定错误类（例如 `APIUserAbortError`）的重试循环很有用。
 */
export function sleep(
  ms: number,
  signal?: AbortSignal,
  opts?: { throwOnAbort?: boolean; abortError?: () => Error; unref?: boolean },
): Promise<void> {
  return new Promise((resolve, reject) => {
    // 在设置计时器之前检查 aborted 状态。如果我们先定义
    // onAbort 并在此处同步调用它，它将引用仍处于暂时性死区
    // 的 `timer`。
    if (signal?.aborted) {
      if (opts?.throwOnAbort || opts?.abortError) {
        void reject(opts.abortError?.() ?? new Error('aborted'))
      } else {
        void resolve()
      }
      return
    }
    const timer = setTimeout(
      (signal, onAbort, resolve) => {
        signal?.removeEventListener('abort', onAbort)
        void resolve()
      },
      ms,
      signal,
      onAbort,
      resolve,
    )
    function onAbort(): void {
      clearTimeout(timer)
      if (opts?.throwOnAbort || opts?.abortError) {
        void reject(opts.abortError?.() ?? new Error('aborted'))
      } else {
        void resolve()
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (opts?.unref) {
      timer.unref()
    }
  })
}

function rejectWithTimeout(reject: (e: Error) => void, message: string): void {
  reject(new Error(message))
}

/**
 * 将 promise 与超时竞争。如果 promise 在 `ms` 内未解决，
 * 则用 `Error(message)` reject。当 promise 解决时超时计时器
 * 被清除（无悬空计时器）并被 unref 以便不阻塞进程退出。
 *
 * 注意：这不会取消底层工作 — 如果 promise 由失控的异步操作
 * 支持，该操作会继续运行。这只是将控制权返回给调用方。
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    // eslint-disable-next-line no-restricted-syntax -- 非 sleep：在 ms 后 REJECT（超时守卫）
    timer = setTimeout(rejectWithTimeout, ms, reject, message)
    if (typeof timer === 'object') timer.unref?.()
  })
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}
