import { useState } from 'react'
import { useInterval } from 'usehooks-ts'

export type MemoryUsageStatus = 'normal' | 'high' | 'critical'

export type MemoryUsageInfo = {
  heapUsed: number
  status: MemoryUsageStatus
}

const HIGH_MEMORY_THRESHOLD = 1.5 * 1024 * 1024 * 1024 // 1.5GB in bytes
const CRITICAL_MEMORY_THRESHOLD = 2.5 * 1024 * 1024 * 1024 // 2.5GB in bytes

/**
 * 监控 Node.js 进程内存使用的 Hook。
 * 每 10 秒轮询；状态为 'normal' 时返回 null。
 */
export function useMemoryUsage(): MemoryUsageInfo | null {
  const [memoryUsage, setMemoryUsage] = useState<MemoryUsageInfo | null>(null)

  useInterval(() => {
    const heapUsed = process.memoryUsage().heapUsed
    const status: MemoryUsageStatus =
      heapUsed >= CRITICAL_MEMORY_THRESHOLD
        ? 'critical'
        : heapUsed >= HIGH_MEMORY_THRESHOLD
          ? 'high'
          : 'normal'
    setMemoryUsage(prev => {
      // 当状态为 'normal' 时退出 —— 不显示任何内容，所以 heapUsed
      // 无关紧要，并且我们避免每 10 秒重新渲染整个
      // Notifications 子树，这对 99%+ 从未达到 1.5GB 的用户来说。
      if (status === 'normal') return prev === null ? prev : null
      return { heapUsed, status }
    })
  }, 10_000)

  return memoryUsage
}
