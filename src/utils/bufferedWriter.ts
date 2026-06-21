type WriteFn = (content: string) => void

export type BufferedWriter = {
  write: (content: string) => void
  flush: () => void
  dispose: () => void
}

export function createBufferedWriter({
  writeFn,
  flushIntervalMs = 1000,
  maxBufferSize = 100,
  maxBufferBytes = Infinity,
  immediateMode = false,
}: {
  writeFn: WriteFn
  flushIntervalMs?: number
  maxBufferSize?: number
  maxBufferBytes?: number
  immediateMode?: boolean
}): BufferedWriter {
  let buffer: string[] = []
  let bufferBytes = 0
  let flushTimer: NodeJS.Timeout | null = null
  // 因溢出而分离但尚未写入的批次。跟踪它以便
  // flush()/dispose() 可以在进程在 setImmediate 触发前退出时
  // 同步排空它。
  let pendingOverflow: string[] | null = null

  function clearTimer(): void {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
  }

  function flush(): void {
    if (pendingOverflow) {
      writeFn(pendingOverflow.join(''))
      pendingOverflow = null
    }
    if (buffer.length === 0) return
    writeFn(buffer.join(''))
    buffer = []
    bufferBytes = 0
    clearTimer()
  }

  function scheduleFlush(): void {
    if (!flushTimer) {
      flushTimer = setTimeout(flush, flushIntervalMs)
    }
  }

  // 同步分离缓冲区，使调用者永远不会等待 writeFn。
  // writeFn 可能会阻塞（例如 errorLogSink.ts 的 appendFileSync）——
  // 如果溢出在渲染中或按键时发生，延迟写入可保持当前 tick 短。
  // 基于定时器的刷新已在用户代码路径之外运行，因此保持同步。
  function flushDeferred(): void {
    if (pendingOverflow) {
      // 之前的溢出写入仍在排队中。合并到其中以保持
      // 顺序 —— 写入落入单个 setImmediate 排序的批次。
      pendingOverflow.push(...buffer)
      buffer = []
      bufferBytes = 0
      clearTimer()
      return
    }
    const detached = buffer
    buffer = []
    bufferBytes = 0
    clearTimer()
    pendingOverflow = detached
    setImmediate(() => {
      const toWrite = pendingOverflow
      pendingOverflow = null
      if (toWrite) writeFn(toWrite.join(''))
    })
  }

  return {
    write(content: string): void {
      if (immediateMode) {
        writeFn(content)
        return
      }
      buffer.push(content)
      bufferBytes += content.length
      scheduleFlush()
      if (buffer.length >= maxBufferSize || bufferBytes >= maxBufferBytes) {
        flushDeferred()
      }
    },
    flush,
    dispose(): void {
      flush()
    },
  }
}
