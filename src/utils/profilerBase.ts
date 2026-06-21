/**
 * profiler 模块（startupProfiler、queryProfiler、
 * headlessProfiler）的共享基础设施。
 *
 * 使用 process.hrtime.bigint() 计时而非 perf_hooks.performance，
 * 以避免 Bun/JSC 内存泄露：JSC 的 Performance 对象将 marks 存储在
 * 一个 C++ Vector 中，即使调用 clearMarks() 也不会收缩。长时间运行的
 * 会话（daemon、/loop）会累积数百 MB 的死容量。
 *
 * LightweightPerf 类提供 profiler 所需的相同接口
 * （mark、getEntriesByType、clearMarks、now），底层使用普通 JS Map。
 */

import { formatFileSize } from './format.js'

/** profiler 使用的最小 PerformanceEntry 类似对象 */
export interface CheckpointEntry {
  readonly name: string
  readonly startTime: number
  readonly entryType: 'mark'
}

/**
 * perf_hooks.performance 的轻量替代品，将 marks 存储在
 * 普通 JavaScript Map 中而非 JSC 的 C++ Vector。这避免了
 * clearMarks() 将计数设为 0 但永不释放 Vector 容量的内存泄露。
 */
class LightweightPerf {
  private marks = new Map<string, number>()
  private _origin: number

  constructor() {
    this._origin = Number(process.hrtime.bigint() / 1000n) / 1000
  }

  mark(name: string): void {
    this.marks.set(name, this.now())
  }

  getEntriesByType(type: 'mark'): CheckpointEntry[] {
    if (type !== 'mark') return []
    const entries: CheckpointEntry[] = []
    for (const [name, startTime] of this.marks) {
      entries.push({ name, startTime, entryType: 'mark' })
    }
    return entries
  }

  clearMarks(name?: string): void {
    if (name !== undefined) {
      this.marks.delete(name)
    } else {
      this.marks.clear()
    }
  }

  now(): number {
    return Number(process.hrtime.bigint() / 1000n) / 1000 - this._origin
  }
}

// 单例 — 所有 profiler 共享（与旧的 perf_hooks 单例相同）
const perf = new LightweightPerf()

export function getPerformance(): LightweightPerf {
  return perf
}

export function formatMs(ms: number): string {
  return ms.toFixed(3)
}

/**
 * 以共享 profiler 报告格式渲染单行时间线：
 *   [+  total.ms] (+  delta.ms) name [extra] [| RSS: .., Heap: ..]
 *
 * totalPad/deltaPad 控制 padStart 宽度，以便调用方可根据
 * 预期量级对齐列（startup 使用 8/7，query 使用 10/9）。
 */
export function formatTimelineLine(
  totalMs: number,
  deltaMs: number,
  name: string,
  memory: NodeJS.MemoryUsage | undefined,
  totalPad: number,
  deltaPad: number,
  extra = '',
): string {
  const memInfo = memory
    ? ` | RSS: ${formatFileSize(memory.rss)}, Heap: ${formatFileSize(memory.heapUsed)}`
    : ''
  return `[+${formatMs(totalMs).padStart(totalPad)}ms] (+${formatMs(deltaMs).padStart(deltaPad)}ms) ${name}${extra}${memInfo}`
}
