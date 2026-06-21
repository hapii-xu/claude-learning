/**
 * 优雅关闭期间应运行的清理函数的全局注册表。
 * 本模块与 gracefulShutdown.ts 分离，以避免循环依赖。
 */

// 清理函数全局注册表
const cleanupFunctions = new Set<() => Promise<void>>()

/**
 * 注册一个在优雅关闭期间运行的清理函数。
 * @param cleanupFn - 清理期间运行的函数（可同步或异步）
 * @returns 取消注册函数，用于移除清理处理器
 */
export function registerCleanup(cleanupFn: () => Promise<void>): () => void {
  cleanupFunctions.add(cleanupFn)
  return () => cleanupFunctions.delete(cleanupFn) // 返回取消注册函数
}

/**
 * 运行所有已注册的清理函数。
 * 由 gracefulShutdown 内部使用。
 */
export async function runCleanupFunctions(): Promise<void> {
  await Promise.all(Array.from(cleanupFunctions).map(fn => fn()))
}
