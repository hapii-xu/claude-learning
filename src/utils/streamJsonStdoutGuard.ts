import { registerCleanup } from './cleanupRegistry.js'
import { logForDebugging } from './debug.js'

/**
 * 在任何转移的非 JSON 行之前写入 stderr 的哨兵值，以便日志
 * 抓取器和测试可以通过 grep 查找守护活动。
 */
export const STDOUT_GUARD_MARKER = '[stdout-guard]'

let installed = false
let buffer = ''
let originalWrite: typeof process.stdout.write | null = null

function isJsonLine(line: string): boolean {
  // 空行在 NDJSON 流中被容忍 — 将它们视为有效，以便尾部
  // 换行或空分隔符不会触发守护。
  if (line.length === 0) {
    return true
  }
  try {
    JSON.parse(line)
    return true
  } catch {
    return false
  }
}

/**
 * 为 --output-format=stream-json 安装 process.stdout.write 的运行时守护。
 *
 * 消费 stream-json 的 SDK 客户端逐行将 stdout 解析为 NDJSON。任何
 * 杂乱的写入 — 来自依赖的 console.log、逃逸审查的调试打印、库横幅 —
 * 都会在流中途破坏客户端的解析器且无法恢复。
 *
 * 此守护在与 asciicast 记录器相同的层级包装 process.stdout.write
 *（见 asciicast.ts）。写入被缓冲直到换行到达，然后每行完整行
 * 被 JSON 解析。可解析的行被转发到真实 stdout；不可解析的行
 * 被转移到 stderr 并带有 STDOUT_GUARD_MARKER 标记，以便它们保持
 * 可见而不破坏 JSON 流。
 *
 * 受祝福的 JSON 路径（structuredIO.write → writeToStdout → stdout.write）
 * 始终发射 `ndjsonSafeStringify(msg) + '\n'`，因此直接通过。
 * 只有带外写入被转移。
 *
 * 安装两次是空操作。在任何 stream-json 输出发射之前调用。
 */
export function installStreamJsonStdoutGuard(): void {
  if (installed) {
    return
  }
  installed = true

  originalWrite = process.stdout.write.bind(
    process.stdout,
  ) as typeof process.stdout.write

  process.stdout.write = function (
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error) => void),
    cb?: (err?: Error) => void,
  ): boolean {
    const text =
      typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8')

    buffer += text
    let newlineIdx: number
    let wrote = true
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx)
      buffer = buffer.slice(newlineIdx + 1)
      if (isJsonLine(line)) {
        wrote = originalWrite!(line + '\n')
      } else {
        process.stderr.write(`${STDOUT_GUARD_MARKER} ${line}\n`)
        logForDebugging(
          `streamJsonStdoutGuard diverted non-JSON stdout line: ${line.slice(0, 200)}`,
        )
      }
    }

    // 在缓冲完成后触发回调。即使一行被转移我们也报告成功 —
    // 调用方的意图（发射文本）已被遵守，只是在不同的 fd 上。
    const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb
    if (callback) {
      queueMicrotask(() => callback())
    }
    return wrote
  } as typeof process.stdout.write

  registerCleanup(async () => {
    // 在关闭时刷新缓冲区中剩余的任何不完整行。如果它是 JSON
    // 片段则不会解析 — 转移它而非悄悄丢弃。
    if (buffer.length > 0) {
      if (originalWrite && isJsonLine(buffer)) {
        originalWrite(buffer + '\n')
      } else {
        process.stderr.write(`${STDOUT_GUARD_MARKER} ${buffer}\n`)
      }
      buffer = ''
    }
    if (originalWrite) {
      process.stdout.write = originalWrite
      originalWrite = null
    }
    installed = false
  })
}

/**
 * 仅测试用重置。恢复真实 stdout.write 并清除行缓冲区，
 * 以便后续测试从干净状态开始。
 */
export function _resetStreamJsonStdoutGuardForTesting(): void {
  if (originalWrite) {
    process.stdout.write = originalWrite
    originalWrite = null
  }
  buffer = ''
  installed = false
}
