/**
 * bridge poll 循环共享的 capacity-wake 原语。
 *
 * replBridge.ts 和 bridgeMain.ts 都需要在"满载"时睡眠，但要能提前醒来：
 *（a）外层循环 signal 中止（关停），或（b）腾出容量（session 结束 /
 * transport 丢失）。这个模块把可变的 wake-controller + 双 signal 合并
 * 封装起来 —— 此前两个 poll 循环里有逐字节重复的实现。
 */

export type CapacitySignal = { signal: AbortSignal; cleanup: () => void }

export type CapacityWake = {
  /**
   * 构造一个 signal：当外层循环 signal 或 capacity-wake controller 任一
   * 触发时中止。返回合并后的 signal 以及一个 cleanup 函数 —— 当 sleep
   * 正常结束（未中止）时，用它摘掉监听器。
   */
  signal(): CapacitySignal
  /**
   * 中止当前 at-capacity 睡眠，并换上新的 controller，让 poll 循环
   * 立刻重新检查是否有新 work。
   */
  wake(): void
}

export function createCapacityWake(outerSignal: AbortSignal): CapacityWake {
  let wakeController = new AbortController()

  function wake(): void {
    wakeController.abort()
    wakeController = new AbortController()
  }

  function signal(): CapacitySignal {
    const merged = new AbortController()
    const abort = (): void => merged.abort()
    if (outerSignal.aborted || wakeController.signal.aborted) {
      merged.abort()
      return { signal: merged.signal, cleanup: () => {} }
    }
    outerSignal.addEventListener('abort', abort, { once: true })
    const capSig = wakeController.signal
    capSig.addEventListener('abort', abort, { once: true })
    return {
      signal: merged.signal,
      cleanup: () => {
        outerSignal.removeEventListener('abort', abort)
        capSig.removeEventListener('abort', abort)
      },
    }
  }

  return { signal, wake }
}
