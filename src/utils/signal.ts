/**
 * 轻量级监听器集合原语，用于纯事件信号（无存储状态）。
 *
 * 将约 8 行的 `const listeners = new Set(); function subscribe(){…};
 * function notify(){for(const l of listeners) l()}` 样板代码
 * （在代码库中重复了约 15 次）压缩为一行调用。
 *
 * 与 store（AppState、createStore）不同 — 没有快照，没有 getState。
 * 当订阅者只需知道"发生了某事"（可选携带事件参数），
 * 而非"当前值是什么"时，使用此原语。
 *
 * 用法：
 *   const changed = createSignal<[SettingSource]>()
 *   export const subscribe = changed.subscribe
 *   // 稍后：changed.emit('userSettings')
 */

export type Signal<Args extends unknown[] = []> = {
  /** 订阅监听器。返回取消订阅函数。 */
  subscribe: (listener: (...args: Args) => void) => () => void
  /** 使用给定参数调用所有已订阅的监听器。 */
  emit: (...args: Args) => void
  /** 移除所有监听器。用于 dispose/reset 路径。 */
  clear: () => void
}

export function createSignal<Args extends unknown[] = []>(): Signal<Args> {
  const listeners = new Set<(...args: Args) => void>()
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    emit(...args) {
      for (const listener of listeners) listener(...args)
    },
    clear() {
      listeners.clear()
    },
  }
}
