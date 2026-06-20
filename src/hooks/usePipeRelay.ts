/**
 * usePipeRelay — 用于 slave → master 通信的 Pipe 消息中继工具。
 *
 * 提供 `relayPipeMessage` 和 `pipeReturnHadErrorRef` 用于
 * onQuery 回调。中继函数从 usePipeIpc 的 attach 处理程序设置的
 * 模块级 `getPipeRelay()` 单例读取。
 */
import { useRef, useCallback } from 'react'
import { getPipeRelay, isRelayMuted } from '../utils/pipePermissionRelay.js'
import type { PipeMessage } from '../utils/pipeTransport.js'

export type PipeRelayHandle = {
  /** 向 master 发送中继消息。如果没有活跃的中继则返回 false。 */
  relayPipeMessage: (message: PipeMessage) => boolean
  /** 跟踪此查询回合是否已中继过错误。 */
  pipeReturnHadErrorRef: React.MutableRefObject<boolean>
}

/**
 * 提供 pipe 中继工具的 Hook。可以无条件调用 ——
 * 当 UDS_INBOX 关闭时，中继函数是返回 false 的无操作。
 */
export function usePipeRelay(): PipeRelayHandle {
  const pipeReturnHadErrorRef = useRef(false)

  const relayPipeMessage = useCallback((message: PipeMessage): boolean => {
    const relay = getPipeRelay()
    if (typeof relay !== 'function') {
      return false
    }
    if (isRelayMuted()) {
      return false
    }
    relay(message)
    return true
  }, [])

  return { relayPipeMessage, pipeReturnHadErrorRef }
}
