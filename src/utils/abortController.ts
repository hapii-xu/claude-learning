import { setMaxListeners } from 'events'

/**
 * 标准操作的最大监听器数量
 */
const DEFAULT_MAX_LISTENERS = 50

/**
 * 创建一个设置了适当事件监听器限制的 AbortController。
 * 这可以防止当多个监听器附加到 abort signal 时出现 MaxListenersExceededWarning。
 *
 * @param maxListeners - 最大监听器数量（默认：50）
 * @returns 配置了监听器限制的 AbortController
 */
export function createAbortController(
  maxListeners: number = DEFAULT_MAX_LISTENERS,
): AbortController {
  const controller = new AbortController()
  setMaxListeners(maxListeners, controller.signal)
  return controller
}

/**
 * 将 abort 从父级传播到弱引用的子控制器。
 * 父级和子级都是弱引用持有 —— 两个方向都不会创建
 * 可能阻止 GC 的强引用。
 * 模块级函数避免每次调用时分配闭包。
 */
function propagateAbort(
  this: WeakRef<AbortController>,
  weakChild: WeakRef<AbortController>,
): void {
  const parent = this.deref()
  weakChild.deref()?.abort(parent?.signal.reason)
}

/**
 * 从弱引用的父级 signal 中移除 abort 处理器。
 * 父级和处理器都是弱引用持有 —— 如果任一个已被 GC 回收
 * 或父级已经 abort（{once: true}），则这是一个空操作。
 * 模块级函数避免每次调用时分配闭包。
 */
function removeAbortHandler(
  this: WeakRef<AbortController>,
  weakHandler: WeakRef<(...args: unknown[]) => void>,
): void {
  const parent = this.deref()
  const handler = weakHandler.deref()
  if (parent && handler) {
    parent.signal.removeEventListener('abort', handler)
  }
}

/**
 * 创建一个子 AbortController，当其父级 abort 时也会 abort。
 * 子级 abort 不会影响父级。
 *
 * 内存安全：使用 WeakRef 所以父级不会保留被遗弃的子级。
 * 如果子级在没有 abort 的情况下被丢弃，仍然可以被 GC 回收。
 * 当子级被 abort 时，父级监听器会被移除以防止
 * 死处理器的累积。
 *
 * @param parent - 父 AbortController
 * @param maxListeners - 最大监听器数量（默认：50）
 * @returns 子 AbortController
 */
export function createChildAbortController(
  parent: AbortController,
  maxListeners?: number,
): AbortController {
  const child = createAbortController(maxListeners)

  // 快速路径：父级已经 abort，无需设置监听器
  if (parent.signal.aborted) {
    child.abort(parent.signal.reason)
    return child
  }

  // WeakRef 防止父级保留被遗弃的子级存活。
  // 如果子级的所有强引用都被丢弃而没有 abort，
  // 子级仍然可以被 GC 回收 —— 父级只持有一个死的 WeakRef。
  const weakChild = new WeakRef(child)
  const weakParent = new WeakRef(parent)
  const handler = propagateAbort.bind(weakParent, weakChild)

  parent.signal.addEventListener('abort', handler, { once: true })

  // 自动清理：当子级 abort 时（从任何来源），移除父级监听器。
  // 父级和处理器都是弱引用持有 —— 如果任一个已被 GC 回收或
  // 父级已经 abort（{once: true}），清理是一个无害的空操作。
  child.signal.addEventListener(
    'abort',
    removeAbortHandler.bind(weakParent, new WeakRef(handler)),
    { once: true },
  )

  return child
}
