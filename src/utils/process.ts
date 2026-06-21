function handleEPIPE(
  stream: NodeJS.WriteStream,
): (err: NodeJS.ErrnoException) => void {
  return (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') {
      stream.destroy()
    }
  }
}

// 防止管道断开时的内存泄露（如 `claude -p | head -1`）
export function registerProcessOutputErrorHandlers(): void {
  process.stdout.on('error', handleEPIPE(process.stdout))
  process.stderr.on('error', handleEPIPE(process.stderr))
}

function writeOut(stream: NodeJS.WriteStream, data: string): void {
  if (stream.destroyed) {
    return
  }

  // 注意：我们不处理背压（write() 返回 false）。
  //
  // 我们应该考虑处理回调以确保等待数据刷新。
  stream.write(data /* callback to handle here */)
}

export function writeToStdout(data: string): void {
  writeOut(process.stdout, data)
}

export function writeToStderr(data: string): void {
  writeOut(process.stderr, data)
}

// 将错误写入 stderr 并以代码 1 退出。合并入口快速路径中使用的
// console.error + process.exit(1) 模式。
export function exitWithError(message: string): never {
  console.error(message)
  // eslint-disable-next-line custom-rules/no-process-exit
  process.exit(1)
}

// 等待一个类似 stdin 的流关闭，但若一直没有数据到达则在 ms 后放弃。
// 首个数据块会取消超时 — 之后无条件等待结束（调用方的累加器需要所有
// 数据块，而不仅仅是第一个）。超时返回 true，结束返回 false。
// 被 -p 模式用于区分真实的管道生产者和继承但空闲的父进程 stdin。
export function peekForStdinData(
  stream: NodeJS.EventEmitter,
  ms: number,
): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    const done = (timedOut: boolean) => {
      clearTimeout(peek)
      stream.off('end', onEnd)
      stream.off('data', onFirstData)
      void resolve(timedOut)
    }
    const onEnd = () => done(false)
    const onFirstData = () => clearTimeout(peek)
    // eslint-disable-next-line no-restricted-syntax -- not a sleep: races timeout against stream end/data events
    const peek = setTimeout(done, ms, true)
    stream.once('end', onEnd)
    stream.once('data', onFirstData)
  })
}
