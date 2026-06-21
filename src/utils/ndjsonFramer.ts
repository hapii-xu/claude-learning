/**
 * 共享 NDJSON（Newline-Delimited JSON）socket 分帧。
 *
 * 累积传入数据块，按换行分割，并发出
 * 解析后的 JSON 对象。被 pipeTransport（UDS+TCP）和
 * udsMessaging 使用，以避免重复相同的缓冲逻辑。
 */
import type { Socket } from 'net'

export type NdjsonFramerOptions = {
  maxFrameBytes?: number
  onFrameError?: (error: Error) => void
  destroyOnFrameError?: boolean
  onInvalidFrame?: (error: Error) => void
  destroyOnInvalidFrame?: boolean
}

/**
 * 将 NDJSON 分帧器附加到 socket。每接收到一条
 * 完整的 JSON 行时调用 `onMessage`。默认跳过格式错误的行；
 * 调用方可选择启用错误回调或 socket 销毁。
 *
 * @param parse - 可选的自定义 JSON 解析器（默认为 JSON.parse）。
 *                当调用方使用包装解析器（如 slowOperations 的
 *                jsonParse）时很有用。
 */
export function attachNdjsonFramer<T = unknown>(
  socket: Socket,
  onMessage: (msg: T) => void,
  parse: (text: string) => T = text => JSON.parse(text) as T,
  options: NdjsonFramerOptions = {},
): void {
  let buffer = ''
  let bufferBytes = 0
  const maxFrameBytes = options.maxFrameBytes ?? Number.POSITIVE_INFINITY

  const rejectOversizedFrame = (bytes: number): void => {
    const error = new Error(
      `NDJSON frame exceeded ${maxFrameBytes} bytes (${bytes})`,
    )
    options.onFrameError?.(error)
    if (options.destroyOnFrameError ?? true) {
      socket.destroy(error)
    }
  }

  const rejectInvalidFrame = (error: unknown): void => {
    const frameError =
      error instanceof Error ? error : new Error('Invalid NDJSON frame')
    options.onInvalidFrame?.(frameError)
    if (options.destroyOnInvalidFrame ?? false) {
      socket.destroy(frameError)
    }
  }

  const emitLine = (line: string): void => {
    if (!line.trim()) return
    try {
      onMessage(parse(line))
    } catch (error) {
      rejectInvalidFrame(error)
    }
  }

  socket.on('data', (chunk: Buffer) => {
    let start = 0
    for (let index = 0; index < chunk.length; index++) {
      if (chunk[index] !== 0x0a) continue

      const segmentBytes = index - start
      if (
        Number.isFinite(maxFrameBytes) &&
        bufferBytes + segmentBytes > maxFrameBytes
      ) {
        rejectOversizedFrame(bufferBytes + segmentBytes)
        return
      }

      buffer += chunk.subarray(start, index).toString('utf8')
      emitLine(buffer)
      buffer = ''
      bufferBytes = 0
      start = index + 1
    }

    const tailBytes = chunk.length - start
    if (
      Number.isFinite(maxFrameBytes) &&
      bufferBytes + tailBytes > maxFrameBytes
    ) {
      rejectOversizedFrame(bufferBytes + tailBytes)
      return
    }

    if (tailBytes > 0) {
      buffer += chunk.subarray(start).toString('utf8')
      bufferBytes += tailBytes
    }
  })
}
