import { logForDebugging } from './debug.js'
import { gracefulShutdownSync } from './gracefulShutdown.js'

/**
 * 为 SDK 模式创建空闲超时管理器。
 * 在指定的空闲时长后自动退出进程。
 *
 * @param isIdle 返回当前系统是否空闲的函数
 * @returns 包含 start/stop 方法以控制空闲计时器的对象
 */
export function createIdleTimeoutManager(isIdle: () => boolean): {
  start: () => void
  stop: () => void
} {
  // 解析 CLAUDE_CODE_EXIT_AFTER_STOP_DELAY 环境变量
  const exitAfterStopDelay = process.env.CLAUDE_CODE_EXIT_AFTER_STOP_DELAY
  const delayMs = exitAfterStopDelay ? parseInt(exitAfterStopDelay, 10) : null
  const isValidDelay = delayMs && !isNaN(delayMs) && delayMs > 0

  let timer: NodeJS.Timeout | null = null
  let lastIdleTime = 0

  return {
    start() {
      // 清除任何已有计时器
      if (timer) {
        clearTimeout(timer)
        timer = null
      }

      // 仅在延迟已配置且有效时启动计时器
      if (isValidDelay) {
        lastIdleTime = Date.now()

        timer = setTimeout(() => {
          // 检查是否已连续空闲满整个时长
          const idleDuration = Date.now() - lastIdleTime
          if (isIdle() && idleDuration >= delayMs) {
            logForDebugging(`Exiting after ${delayMs}ms of idle time`)
            gracefulShutdownSync()
          }
        }, delayMs)
      }
    },

    stop() {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    },
  }
}
