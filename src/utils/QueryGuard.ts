/**
 * 查询生命周期的同步状态机，兼容 React 的 `useSyncExternalStore`。
 *
 * 三种状态：
 *   idle        → 无查询，可安全出队并处理
 *   dispatching → 某项已出队，异步链尚未到达 onQuery
 *   running     → onQuery 调用了 tryStart()，查询正在执行
 *
 * 转换：
 *   idle → dispatching  (reserve)
 *   dispatching → running  (tryStart)
 *   idle → running  (tryStart，用于直接用户提交)
 *   running → idle  (end / forceEnd)
 *   dispatching → idle  (cancelReservation，当 processQueueIfReady 无内容处理时)
 *
 * `isActive` 对 dispatching 和 running 均返回 true，
 * 防止在异步间隙期间从队列处理器重入。
 *
 * React 中的用法：
 *   const queryGuard = useRef(new QueryGuard()).current
 *   const isQueryActive = useSyncExternalStore(
 *     queryGuard.subscribe,
 *     queryGuard.getSnapshot,
 *   )
 */
import { createSignal } from './signal.js'

export class QueryGuard {
  private _status: 'idle' | 'dispatching' | 'running' = 'idle'
  private _generation = 0
  private _changed = createSignal()

  /**
   * 为队列处理保留 guard。从 idle 转换到 dispatching。
   * 若非 idle 则返回 false（另一个查询或派发进行中）。
   */
  reserve(): boolean {
    if (this._status !== 'idle') return false
    this._status = 'dispatching'
    this._notify()
    return true
  }

  /**
   * 当 processQueueIfReady 无内容处理时取消保留。
   * 从 dispatching 转换到 idle。
   */
  cancelReservation(): void {
    if (this._status !== 'dispatching') return
    this._status = 'idle'
    this._notify()
  }

  /**
   * 启动查询。成功时返回 generation 号，
   * 若查询已在运行则返回 null（并发 guard）。
   * 接受从 idle（直接用户提交）和 dispatching（队列处理器路径）的转换。
   */
  tryStart(): number | null {
    if (this._status === 'running') return null
    this._status = 'running'
    ++this._generation
    this._notify()
    return this._generation
  }

  /**
   * 结束查询。若此 generation 仍为当前则返回 true
   * （表示调用方应执行清理）。若已有更新的查询开始则返回 false
   * （已取消查询的过时 finally 块）。
   */
  end(generation: number): boolean {
    if (this._generation !== generation) return false
    if (this._status !== 'running') return false
    this._status = 'idle'
    this._notify()
    return true
  }

  /**
   * 无视 generation 强制结束当前查询。
   * 被 onCancel 使用，任何运行中的查询都应被终止。
   * 递增 generation，使已取消查询 promise rejection 中的
   * 过时 finally 块会看到不匹配并跳过清理。
   */
  forceEnd(): void {
    if (this._status === 'idle') return
    this._status = 'idle'
    ++this._generation
    this._notify()
  }

  /**
   * guard 是否处于活动状态（dispatching 或 running）？
   * 始终同步 — 不受 React 状态批处理延迟影响。
   */
  get isActive(): boolean {
    return this._status !== 'idle'
  }

  get generation(): number {
    return this._generation
  }

  // --
  // useSyncExternalStore 接口

  /** 订阅状态变化。稳定引用 — 可安全用作 useEffect 依赖。 */
  subscribe = this._changed.subscribe

  /** useSyncExternalStore 的快照。返回 `isActive`。 */
  getSnapshot = (): boolean => {
    return this._status !== 'idle'
  }

  private _notify(): void {
    this._changed.emit()
  }
}
