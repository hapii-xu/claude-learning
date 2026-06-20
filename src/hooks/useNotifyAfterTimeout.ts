import { useEffect } from 'react'
import {
  getLastInteractionTime,
  updateLastInteractionTime,
} from '../bootstrap/state.js'
import { useTerminalNotification } from '@anthropic/ink'
import { sendNotification } from '../services/notifier.js'
// 将交互视为 "最近" 的时间阈值（毫秒）（6 秒）
export const DEFAULT_INTERACTION_THRESHOLD_MS = 6000

function getTimeSinceLastInteraction(): number {
  return Date.now() - getLastInteractionTime()
}

function hasRecentInteraction(threshold: number): boolean {
  return getTimeSinceLastInteraction() < threshold
}

function shouldNotify(threshold: number): boolean {
  return process.env.NODE_ENV !== 'test' && !hasRecentInteraction(threshold)
}

// 注意：用户交互跟踪现在在 App.tsx 的 processKeysInBatch
// 函数中完成，该函数在收到任何输入时调用 updateLastInteractionTime()。
// 这避免了会有一个与主 'readable' 监听器竞争并导致
// 输入字符丢失的单独 stdin 'data' 监听器。

/**
 * 在超时时期后管理桌面通知的 Hook。
 *
 * 在两种情况下显示通知：
 * 1. 如果应用程序空闲时间超过阈值则立即显示
 * 2. 如果用户在该时间内未交互则在指定超时后显示
 *
 * @param message - 要显示的通知消息
 * @param timeout - 超时时间（毫秒）（默认 6000ms）
 */
export function useNotifyAfterTimeout(
  message: string,
  notificationType: string,
): void {
  const terminal = useTerminalNotification()

  // 在调用 hook 时重置交互时间，以确保
  // 花费很长时间完成的请求不会立即弹出通知。
  // 必须是立即的，因为 useEffect 在 Ink 的渲染周期
  // 已刷新后运行；否则时间戳保持过时，
  // 并且如果用户空闲（没有后续渲染刷新）会触发过早通知。
  useEffect(() => {
    updateLastInteractionTime(true)
  }, [])

  useEffect(() => {
    let hasNotified = false
    const timer = setInterval(() => {
      if (shouldNotify(DEFAULT_INTERACTION_THRESHOLD_MS) && !hasNotified) {
        hasNotified = true
        clearInterval(timer)
        void sendNotification({ message, notificationType }, terminal)
      }
    }, DEFAULT_INTERACTION_THRESHOLD_MS)

    return () => clearInterval(timer)
  }, [message, notificationType, terminal])
}
