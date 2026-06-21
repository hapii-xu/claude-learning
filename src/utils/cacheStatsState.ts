/**
 * 内存单例，追踪当前会话的缓存命中率状态。
 *
 * 每当新的 API 响应到达时调用 `onResponse(usage)`。
 * 单例将新响应的 token 签名与之前看到的签名进行比较。
 * 当签名变化（= 新的 API 调用完成）时，将 `lastResetAt` 重置为
 * Date.now() 并异步持久化状态，以便未来会话可以在启动时
 * 立即显示 TTL 倒计时。
 */

import type { CacheUsage, CacheStatsState } from './cacheStats.js'
import {
  computeHitRate,
  tokenSignature,
  getStateFilePath,
  readState,
  writeStateAtomic,
} from './cacheStats.js'

interface MemState {
  signature: string | null
  lastResetAt: number | null
  lastHitRate: number | null
}

let memState: MemState = {
  signature: null,
  lastResetAt: null,
  lastHitRate: null,
}

let sessionId: string | null = null

/**
 * 必须在会话启动时调用一次，以便单例知道持久化到哪个状态文件
 * 并可以预加载上次已知的状态。
 */
export async function initCacheStatsState(sid: string): Promise<void> {
  sessionId = sid
  const filePath = getStateFilePath(sid)
  const persisted = await readState(filePath)
  // 预加载持久化值以便 UI 可以立即显示回退
  memState = {
    signature: persisted.signature,
    lastResetAt: persisted.lastResetAt,
    lastHitRate: persisted.lastHitRate,
  }
}

/**
 * 每当收到带有使用数据的新助手响应时调用。
 * 返回更新后的内存状态。
 */
export function onResponse(usage: CacheUsage): MemState {
  const sig = tokenSignature(usage)
  const hitRate = computeHitRate(usage)

  if (sig !== memState.signature) {
    // 新 API 响应 —— 重置 TTL 时钟
    memState = {
      signature: sig,
      lastResetAt: Date.now(),
      lastHitRate: hitRate,
    }
    // 异步持久化；故意即发即弃
    if (sessionId !== null) {
      const filePath = getStateFilePath(sessionId)
      const toWrite: CacheStatsState = {
        version: 1,
        signature: sig,
        lastResetAt: memState.lastResetAt,
        lastHitRate: hitRate,
      }
      void writeStateAtomic(filePath, toWrite)
    }
  }

  return { ...memState }
}

/** 读取当前内存状态而不触发响应更新。 */
export function getCacheStatsState(): MemState {
  return { ...memState }
}

/**
 * 重置单例 —— 用于测试中隔离测试运行。
 */
export function _resetCacheStatsStateForTest(): void {
  memState = { signature: null, lastResetAt: null, lastHitRate: null }
  sessionId = null
}
