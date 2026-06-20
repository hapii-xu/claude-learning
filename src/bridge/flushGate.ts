/**
 * 在初始 flush 期间为消息写入把关的状态机。
 *
 * bridge session 启动时，历史消息会通过一次 HTTP POST 整体 flush 到服务
 * 器。flush 期间，新消息必须排队，防止它们与历史消息交错到达服务器。
 *
 * 生命周期：
 *   start() → enqueue() 返回 true，元素入队
 *   end()   → 返回排队的元素供 drain，enqueue() 返回 false
 *   drop()  → 丢弃排队的元素（transport 永久关闭）
 *   deactivate() → 清除 active 标志但不丢弃元素
 *                   （transport 替换 —— 新 transport 会负责 drain）
 */
export class FlushGate<T> {
  private _active = false
  private _pending: T[] = []

  get active(): boolean {
    return this._active
  }

  get pendingCount(): number {
    return this._pending.length
  }

  /** 标记 flush 进行中。enqueue() 会开始把元素入队。 */
  start(): void {
    this._active = true
  }

  /**
   * 结束 flush，返回排队中的元素供 drain。调用方负责把返回的元素
   * 发送出去。
   */
  end(): T[] {
    this._active = false
    return this._pending.splice(0)
  }

  /**
   * 如果 flush 处于 active，把元素入队并返回 true。
   * 如果 flush 非 active，返回 false（调用方应直接发送）。
   */
  enqueue(...items: T[]): boolean {
    if (!this._active) return false
    this._pending.push(...items)
    return true
  }

  /**
   * 丢弃所有排队元素（transport 永久关闭）。返回被丢弃的元素数量。
   */
  drop(): number {
    this._active = false
    const count = this._pending.length
    this._pending.length = 0
    return count
  }

  /**
   * 清除 active 标志但不丢弃排队元素。用于 transport 被替换的场景
   *（onWorkReceived）—— 新 transport 的 flush 会把待处理元素 drain 掉。
   */
  deactivate(): void {
    this._active = false
  }
}
