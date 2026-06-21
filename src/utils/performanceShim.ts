/**
 * Performance shim —— 替换 globalThis.performance，防止 JSC 的 C++ Vector 无限增长。
 *
 * 在 Bun 中，globalThis.performance 是 JSC 原生的 Performance 对象。它将 marks、
 * measures 和 resource timings 存放在一个 C++ Vector 中，即便调用 clearMarks()
 * 也永不收缩。长时间运行的会话（daemon、/loop）会累积数百 MB 的死容量。
 *
 * 本 shim 将 performance.now() 留在原生对象上（快，无内存成本），但把 mark/measure/
 * getEntries 操作重定向到一个普通 JS Map，GC 可以回收其内存。第三方代码
 * （React reconciler、OTel/Langfuse）使用 performance.now() 计时 —— 那部分保持原生。
 * 累积性操作则落到可被 GC 回收的 JS 内存里。
 *
 * 必须在 React/OTel import 之前安装 —— 见 cli.tsx 的首个 import。
 */

const original = globalThis.performance

// JS 后端存储 —— 完全可被 GC 回收
const marks = new Map<string, number>()
const measures = new Map<
  string,
  { name: string; startTime: number; duration: number }
>()

function now(): number {
  return original.now()
}

function mark(name: string): PerformanceMark {
  marks.set(name, now())
  // 返回一个最小的类 PerformanceMark 对象以满足接口要求。
  // React/OTel 只将 mark() 用于副作用，并不使用其返回值。
  return {
    name,
    entryType: 'mark',
    startTime: marks.get(name)!,
    duration: 0,
  } as PerformanceMark
}

function measure(
  name: string,
  startMarkOrOptions?: string | MeasureOptions,
  endMark?: string,
): void {
  let startTime: number
  let duration: number

  if (typeof startMarkOrOptions === 'string') {
    const start = marks.get(startMarkOrOptions)
    const end = endMark ? marks.get(endMark) : now()
    startTime = start ?? now()
    duration = (end ?? now()) - startTime
  } else if (startMarkOrOptions && typeof startMarkOrOptions === 'object') {
    startTime = startMarkOrOptions.start ?? 0
    duration = (startMarkOrOptions.end ?? now()) - startTime
  } else {
    startTime = 0
    duration = now()
  }

  measures.set(name, { name, startTime, duration })
}

interface MeasureOptions {
  start?: number
  end?: number
  detail?: unknown
}

interface PerformanceEntryLike {
  readonly name: string
  readonly entryType: string
  readonly startTime: number
  readonly duration: number
}

function getEntriesByType(type: string): PerformanceEntryLike[] {
  if (type === 'mark') {
    return [...marks.entries()].map(([name, startTime]) => ({
      name,
      entryType: 'mark',
      startTime,
      duration: 0,
    }))
  }
  if (type === 'measure') {
    return [...measures.values()].map(m => ({
      name: m.name,
      entryType: 'measure',
      startTime: m.startTime,
      duration: m.duration,
    }))
  }
  return []
}

function getEntriesByName(name: string, type?: string): PerformanceEntryLike[] {
  const entries = getEntriesByType(type ?? 'mark').concat(
    type === undefined ? getEntriesByType('measure') : [],
  )
  return entries.filter(e => e.name === name)
}

function clearMarks(name?: string): void {
  if (name !== undefined) {
    marks.delete(name)
  } else {
    marks.clear()
  }
}

function clearMeasures(name?: string): void {
  if (name !== undefined) {
    measures.delete(name)
  } else {
    measures.clear()
  }
}

// 普通对象 shim —— 一定不要继承 Performance.prototype，因为原生 getter
//（onresourcetimingbufferfull、timeOrigin、toJSON）会检查 `this` 是否为真正的
// JSC Performance 实例，否则会抛异常。
const shim = {
  now,
  mark,
  measure: measure as typeof performance.measure,
  getEntriesByType: getEntriesByType as typeof performance.getEntriesByType,
  getEntriesByName: getEntriesByName as typeof performance.getEntriesByName,
  clearMarks: clearMarks as typeof performance.clearMarks,
  clearMeasures: clearMeasures as typeof performance.clearMeasures,
  clearResourceTimings: (() => {}) as typeof performance.clearResourceTimings,
  setResourceTimingBufferSize:
    (() => {}) as typeof performance.setResourceTimingBufferSize,
  // Node.js v22 undici 内部在每次 fetch 后都会调用它 —— 必须存在，
  // 否则会抛 TypeError: markResourceTiming is not a function
  markResourceTiming: (() => {}) as () => void,
  // 只读属性委托给原始对象
  get timeOrigin() {
    return original.timeOrigin
  },
  get onresourcetimingbufferfull() {
    return (original as unknown as typeof performance)
      .onresourcetimingbufferfull
  },
  set onresourcetimingbufferfull(_v: any) {
    // no-op —— 防止累积
  },
  toJSON() {
    return original.toJSON()
  },
} as unknown as typeof performance

/**
 * 将 shim 安装到 globalThis.performance。可安全地多次调用。
 * 必须在 React 和 OTel import 之前运行，防止它们捕获原生 Performance 引用。
 */
export function installPerformanceShim(): void {
  if ((globalThis as Record<string, unknown>).__performanceShimInstalled) {
    console.debug('[Hapii] performanceShim: 已安装（幂等跳过）')
    return
  }
  ;(globalThis as Record<string, unknown>).__performanceShimInstalled = true
  globalThis.performance = shim
  console.debug(
    '[Hapii] performanceShim: 已安装到 globalThis.performance（修复 JSC Vector 内存泄漏）',
  )
}

// import 时自动安装
installPerformanceShim()
