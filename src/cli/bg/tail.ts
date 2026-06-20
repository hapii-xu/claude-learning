import {
  openSync,
  readSync,
  closeSync,
  statSync,
  watchFile,
  unwatchFile,
  createReadStream,
} from 'fs'
import { createInterface } from 'readline'

/**
 * 跨平台实时日志输出。Ctrl+C 可退出 tail 而不会终止后台进程。
 *
 * 策略：
 *  1. 读取现有内容并输出到 stdout
 *  2. 使用 fs.watchFile()（基于轮询 — 在所有平台上都能工作，包括 Windows）
 *  3. 文件变化时从上次已知位置读取新增字节
 *  4. SIGINT 干净退出
 */
export async function tailLog(logPath: string): Promise<void> {
  let position = 0

  // 输出已有内容
  try {
    const stat = statSync(logPath)
    position = stat.size
    if (position > 0) {
      const stream = createReadStream(logPath, { start: 0, end: position - 1 })
      const rl = createInterface({ input: stream })
      for await (const line of rl) {
        process.stdout.write(line + '\n')
      }
    }
  } catch {
    // 文件可能还不存在 — 这没关系
  }

  console.log('\n[tail] Watching for new output... (Ctrl+C to detach)\n')

  return new Promise<void>(resolve => {
    const onSignal = (): void => {
      unwatchFile(logPath)
      process.removeListener('SIGINT', onSignal)
      console.log('\n[tail] Detached from session.')
      resolve()
    }
    process.on('SIGINT', onSignal)

    watchFile(logPath, { interval: 300 }, () => {
      try {
        const stat = statSync(logPath)
        if (stat.size <= position) return

        const fd = openSync(logPath, 'r')
        try {
          const buf = Buffer.alloc(stat.size - position)
          readSync(fd, buf, 0, buf.length, position)
          process.stdout.write(buf)
          position = stat.size
        } finally {
          closeSync(fd)
        }
      } catch {
        // 文件可能已被删除或被截断
      }
    })
  })
}
