/**
 * 在 Claude 工作期间防止 macOS 进入睡眠。
 *
 * 使用内置的 `caffeinate` 命令创建阻止空闲睡眠的电源断言。
 * 这会在 API 请求和工具执行期间保持 Mac 唤醒，使长时间运行的操作不会被中断。
 *
 * caffeinate 进程使用超时启动并定期重启。
 * 这提供了自愈行为：如果 Node 进程被 SIGKILL 终止
 * （不会运行清理处理器），孤立的 caffeinate 会在超时到期后自动退出。
 *
 * 仅在 macOS 上运行 —— 在其他平台上为空操作。
 */
import { type ChildProcess, spawn } from 'child_process'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import { logForDebugging } from '../utils/debug.js'

// caffeinate 超时时间（秒）。进程在此持续时间后自动退出。
// 我们在到期前重启它以保持持续的睡眠阻止。
const CAFFEINATE_TIMEOUT_SECONDS = 300 // 5 分钟

// 重启间隔 —— 在 caffeinate 到期前重启。
// 使用 4 分钟，为 5 分钟超时提供充足的缓冲。
const RESTART_INTERVAL_MS = 4 * 60 * 1000

let caffeinateProcess: ChildProcess | null = null
let restartInterval: ReturnType<typeof setInterval> | null = null
let refCount = 0
let cleanupRegistered = false

/**
 * 递增引用计数，如果需要则开始阻止睡眠。
 * 在开始应保持 Mac 唤醒的工作时调用此方法。
 */
export function startPreventSleep(): void {
  refCount++

  if (refCount === 1) {
    spawnCaffeinate()
    startRestartInterval()
  }
}

/**
 * 递减引用计数，如果没有更多待处理工作则允许睡眠。
 * 在工作完成时调用此方法。
 */
export function stopPreventSleep(): void {
  if (refCount > 0) {
    refCount--
  }

  if (refCount === 0) {
    stopRestartInterval()
    killCaffeinate()
  }
}

/**
 * 强制停止阻止睡眠，不管引用计数。
 * 用于退出时的清理。
 */
export function forceStopPreventSleep(): void {
  refCount = 0
  stopRestartInterval()
  killCaffeinate()
}

function startRestartInterval(): void {
  // 仅在 macOS 上运行
  if (process.platform !== 'darwin') {
    return
  }

  // 已在运行
  if (restartInterval !== null) {
    return
  }

  restartInterval = setInterval(() => {
    // 仅在我们仍需要阻止睡眠时重启
    if (refCount > 0) {
      logForDebugging('Restarting caffeinate to maintain sleep prevention')
      killCaffeinate()
      spawnCaffeinate()
    }
  }, RESTART_INTERVAL_MS)

  // 不要让 interval 保持 Node 进程存活
  restartInterval.unref()
}

function stopRestartInterval(): void {
  if (restartInterval !== null) {
    clearInterval(restartInterval)
    restartInterval = null
  }
}

function spawnCaffeinate(): void {
  // 仅在 macOS 上运行
  if (process.platform !== 'darwin') {
    return
  }

  // 已在运行
  if (caffeinateProcess !== null) {
    return
  }

  // 在首次使用时注册清理，以确保退出时终止 caffeinate
  if (!cleanupRegistered) {
    cleanupRegistered = true
    registerCleanup(async () => {
      forceStopPreventSleep()
    })
  }

  try {
    // -i: 创建阻止空闲睡眠的断言
    //     这是最温和的选项 —— 显示器仍可睡眠
    // -t: 超时（秒）—— caffeinate 在此时间后自动退出
    //     如果 Node 被 SIGKILL 终止，这提供了自愈能力
    caffeinateProcess = spawn(
      'caffeinate',
      ['-i', '-t', String(CAFFEINATE_TIMEOUT_SECONDS)],
      {
        stdio: 'ignore',
      },
    )

    // 不要让 caffeinate 保持 Node 进程存活
    caffeinateProcess.unref()

    const thisProc = caffeinateProcess
    caffeinateProcess.on('error', err => {
      logForDebugging(`caffeinate spawn error: ${err.message}`)
      if (caffeinateProcess === thisProc) caffeinateProcess = null
    })

    caffeinateProcess.on('exit', () => {
      if (caffeinateProcess === thisProc) caffeinateProcess = null
    })

    logForDebugging('Started caffeinate to prevent sleep')
  } catch {
    // 静默失败 —— caffeinate 不可用或 spawn 失败
    caffeinateProcess = null
  }
}

function killCaffeinate(): void {
  if (caffeinateProcess !== null) {
    const proc = caffeinateProcess
    caffeinateProcess = null
    try {
      // 使用 SIGKILL 立即终止 —— SIGTERM 可能会延迟
      proc.kill('SIGKILL')
      logForDebugging('Stopped caffeinate, allowing sleep')
    } catch {
      // 进程可能已经退出
    }
  }
}
