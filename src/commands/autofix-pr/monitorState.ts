type MonitorState = {
  taskId: string
  owner: string
  repo: string
  prNumber: number
  abortController: AbortController
  startedAt: number
}

let active: MonitorState | null = null

export function getActiveMonitor(): Readonly<MonitorState> | null {
  return active
}

/**
 * 原子地「检查并设置」。获得锁返回 true，已有 monitor 处于活跃状态则返回 false。
 * 用它替代 getActiveMonitor + setActiveMonitor 的组合 ——
 * 后两者之间存在竞态：调用方可能在它们之间 await。
 */
export function trySetActiveMonitor(state: MonitorState): boolean {
  if (active) return false
  active = state
  return true
}

/**
 * 无条件设置活跃 monitor。若已有活跃 monitor 则抛错。
 * 如需无竞态获取锁，优先使用 trySetActiveMonitor。
 */
export function setActiveMonitor(state: MonitorState): void {
  if (active)
    throw new Error(`Monitor already active: ${active.repo}#${active.prNumber}`)
  active = state
}

/**
 * 释放活跃 monitor。若传入 `taskId`，则仅当活跃 monitor 的 taskId
 * 匹配时才释放 —— 防止迟到的清理逻辑覆盖掉刚被另一个任务获取的锁。
 */
export function clearActiveMonitor(taskId?: string): void {
  if (!active) return
  if (taskId && active.taskId !== taskId) return
  active.abortController.abort()
  active = null
}

/**
 * 将部分更新原子地合并进活跃 monitor。应用成功返回 true，无活跃 monitor 返回 false。
 * 当框架实际分配的 taskId 与调用方获取锁时使用的「暂行」taskId 不一致时，
 * 调用方需要改写锁的 taskId —— 没有这个方法，框架清理逻辑
 * （用框架 taskId 调用 clearActiveMonitor）会对以调用方暂行 id 为 key 的锁无操作。
 */
export function updateActiveMonitor(partial: Partial<MonitorState>): boolean {
  if (!active) return false
  active = { ...active, ...partial }
  return true
}

export function isMonitoring(
  owner: string,
  repo: string,
  prNumber: number,
): boolean {
  return (
    active?.owner === owner &&
    active?.repo === repo &&
    active?.prNumber === prNumber
  )
}
