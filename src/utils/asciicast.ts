import { appendFile, rename } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { getOriginalCwd, getSessionId } from '../bootstrap/state.js'
import { createBufferedWriter } from './bufferedWriter.js'
import { registerCleanup } from './cleanupRegistry.js'
import { logForDebugging } from './debug.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from './envUtils.js'
import { getFsImplementation } from './fsOperations.js'
import { sanitizePath } from './path.js'
import { jsonStringify } from './slowOperations.js'

// 可变录制状态 —— filePath 在会话 ID 变更时更新（例如 --resume）
const recordingState: { filePath: string | null; timestamp: number } = {
  filePath: null,
  timestamp: 0,
}

/**
 * 获取 asciicast 录制文件路径。
 * 对于设置了 CLAUDE_CODE_TERMINAL_RECORDING=1 的 ant 用户：返回路径。
 * 否则：返回 null。
 * 路径只计算一次并缓存在 recordingState 中。
 */
export function getRecordFilePath(): string | null {
  if (recordingState.filePath !== null) {
    return recordingState.filePath
  }
  if (process.env.USER_TYPE !== 'ant') {
    return null
  }
  if (!isEnvTruthy(process.env.CLAUDE_CODE_TERMINAL_RECORDING)) {
    return null
  }
  // 与转录一起录制。
  // 每次启动都会生成自己的文件，因此 --continue 会产生多个录制。
  const projectsDir = join(getClaudeConfigHomeDir(), 'projects')
  const projectDir = join(projectsDir, sanitizePath(getOriginalCwd()))
  recordingState.timestamp = Date.now()
  recordingState.filePath = join(
    projectDir,
    `${getSessionId()}-${recordingState.timestamp}.cast`,
  )
  return recordingState.filePath
}

export function _resetRecordingStateForTesting(): void {
  recordingState.filePath = null
  recordingState.timestamp = 0
}

/**
 * 重命名录制文件以匹配当前会话 ID。
 * 在 --resume/--continue 通过 switchSession() 更改会话 ID 后调用。
 * 录制器安装时使用的是初始（随机的）会话 ID；此处重命名文件
 * 以便 getSessionRecordingPaths() 能通过恢复后的会话 ID 找到它。
 */
export async function renameRecordingForSession(): Promise<void> {
  const oldPath = recordingState.filePath
  if (!oldPath || recordingState.timestamp === 0) {
    return
  }
  const projectsDir = join(getClaudeConfigHomeDir(), 'projects')
  const projectDir = join(projectsDir, sanitizePath(getOriginalCwd()))
  const newPath = join(
    projectDir,
    `${getSessionId()}-${recordingState.timestamp}.cast`,
  )
  if (oldPath === newPath) {
    return
  }
  // 重命名前刷新待写入的数据
  await recorder?.flush()
  const oldName = basename(oldPath)
  const newName = basename(newPath)
  try {
    await rename(oldPath, newPath)
    recordingState.filePath = newPath
    logForDebugging(`[asciicast] Renamed recording: ${oldName} → ${newName}`)
  } catch {
    logForDebugging(
      `[asciicast] Failed to rename recording from ${oldName} to ${newName}`,
    )
  }
}

type AsciicastRecorder = {
  flush(): Promise<void>
  dispose(): Promise<void>
}

let recorder: AsciicastRecorder | null = null

function getTerminalSize(): { cols: number; rows: number } {
  // 直接访问 stdout 尺寸 —— 不在 React 组件中
  // eslint-disable-next-line custom-rules/prefer-use-terminal-size
  const cols = process.stdout.columns || 80
  // eslint-disable-next-line custom-rules/prefer-use-terminal-size
  const rows = process.stdout.rows || 24
  return { cols, rows }
}

/**
 * 安装 asciicast 录制器。
 * 包装 process.stdout.write 以带时间戳捕获所有终端输出。
 * 必须在 Ink 挂载前调用。
 */
export function installAsciicastRecorder(): void {
  const filePath = getRecordFilePath()
  if (!filePath) {
    return
  }

  const { cols, rows } = getTerminalSize()
  const startTime = performance.now()

  // 写入 asciicast v2 头部
  const header = jsonStringify({
    version: 2,
    width: cols,
    height: rows,
    timestamp: Math.floor(Date.now() / 1000),
    env: {
      SHELL: process.env.SHELL || '',
      TERM: process.env.TERM || '',
    },
  })

  try {
    // eslint-disable-next-line custom-rules/no-sync-fs -- one-time init before Ink mounts
    getFsImplementation().mkdirSync(dirname(filePath))
  } catch {
    // 目录可能已存在
  }
  // eslint-disable-next-line custom-rules/no-sync-fs -- one-time init before Ink mounts
  getFsImplementation().appendFileSync(filePath, header + '\n', { mode: 0o600 })

  let pendingWrite: Promise<void> = Promise.resolve()

  const writer = createBufferedWriter({
    writeFn(content: string) {
      // 使用可变的 recordingState.filePath 以便写入跟随 --resume 的重命名
      const currentPath = recordingState.filePath
      if (!currentPath) {
        return
      }
      pendingWrite = pendingWrite
        .then(() => appendFile(currentPath, content))
        .catch(() => {
          // 静默忽略写入错误 —— 不要中断会话
        })
    },
    flushIntervalMs: 500,
    maxBufferSize: 50,
    maxBufferBytes: 10 * 1024 * 1024, // 10MB
  })

  // 包装 process.stdout.write 以捕获输出
  const originalWrite = process.stdout.write.bind(
    process.stdout,
  ) as typeof process.stdout.write
  process.stdout.write = function (
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean {
    // 记录输出事件
    const elapsed = (performance.now() - startTime) / 1000
    const text =
      typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8')
    writer.write(jsonStringify([elapsed, 'o', text]) + '\n')

    // 传递到真实的 stdout
    if (typeof encodingOrCb === 'function') {
      return originalWrite(chunk, encodingOrCb)
    }
    return originalWrite(chunk, encodingOrCb, cb)
  } as typeof process.stdout.write

  // 处理终端尺寸调整事件
  function onResize(): void {
    const elapsed = (performance.now() - startTime) / 1000
    const { cols: newCols, rows: newRows } = getTerminalSize()
    writer.write(jsonStringify([elapsed, 'r', `${newCols}x${newRows}`]) + '\n')
  }
  process.stdout.on('resize', onResize)

  recorder = {
    async flush(): Promise<void> {
      writer.flush()
      await pendingWrite
    },
    async dispose(): Promise<void> {
      writer.dispose()
      await pendingWrite
      process.stdout.removeListener('resize', onResize)
      process.stdout.write = originalWrite
    },
  }

  registerCleanup(async () => {
    await recorder?.dispose()
    recorder = null
  })

  logForDebugging(`[asciicast] Recording to ${filePath}`)
}
