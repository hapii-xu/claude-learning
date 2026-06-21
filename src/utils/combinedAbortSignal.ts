import { createAbortController } from './abortController.js'

/**
 * 创建一个组合的 AbortSignal，当输入 signal 中止、
 * 可选的第二个 signal 中止或可选的超时时间到达时触发中止。
 * 同时返回 signal 和一个清理函数，用于移除事件监听器
 * 并清除内部的超时计时器。
 *
 * 请使用 `timeoutMs` 而非传递 `AbortSignal.timeout(ms)` 作为 signal ——
 * 在 Bun 下，`AbortSignal.timeout` 的定时器被延迟 finalize 并会在原生内存中累积，
 * 直到它们触发（测量约 2.4KB/次，在整个超时期间持有）。
 * 本实现使用 `setTimeout` + `clearTimeout`，以便在清理时立即释放计时器。
 */
export function createCombinedAbortSignal(
  signal: AbortSignal | undefined,
  opts?: { signalB?: AbortSignal; timeoutMs?: number },
): { signal: AbortSignal; cleanup: () => void } {
  const { signalB, timeoutMs } = opts ?? {}
  const combined = createAbortController()

  if (signal?.aborted || signalB?.aborted) {
    combined.abort()
    return { signal: combined.signal, cleanup: () => {} }
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const abortCombined = () => {
    if (timer !== undefined) clearTimeout(timer)
    combined.abort()
  }

  if (timeoutMs !== undefined) {
    timer = setTimeout(abortCombined, timeoutMs)
    timer.unref?.()
  }
  signal?.addEventListener('abort', abortCombined)
  signalB?.addEventListener('abort', abortCombined)

  const cleanup = () => {
    if (timer !== undefined) clearTimeout(timer)
    signal?.removeEventListener('abort', abortCombined)
    signalB?.removeEventListener('abort', abortCombined)
  }

  return { signal: combined.signal, cleanup }
}
