import { useCallback, useEffect, useRef } from 'react'
import type { HookResultMessage, Message } from '../types/message.js'

/**
 * 管理延迟的 SessionStart hook 消息，以便 REPL 可以立即渲染
 * 而不是阻塞在 hook 执行上（约 500ms）。
 *
 * Hook 消息在 promise 解析时异步注入。
 * 返回一个回调，onSubmit 应在第一次 API
 * 请求之前调用，以确保模型始终看到 hook 上下文。
 */
export function useDeferredHookMessages(
  pendingHookMessages: Promise<HookResultMessage[]> | undefined,
  setMessages: (action: React.SetStateAction<Message[]>) => void,
): () => Promise<void> {
  const pendingRef = useRef(pendingHookMessages ?? null)
  const resolvedRef = useRef(!pendingHookMessages)

  useEffect(() => {
    const promise = pendingRef.current
    if (!promise) return
    let cancelled = false
    promise.then(msgs => {
      if (cancelled) return
      resolvedRef.current = true
      pendingRef.current = null
      if (msgs.length > 0) {
        setMessages(prev => [...msgs, ...prev])
      }
    })
    return () => {
      cancelled = true
    }
  }, [setMessages])

  return useCallback(async () => {
    if (resolvedRef.current || !pendingRef.current) return
    const msgs = await pendingRef.current
    if (resolvedRef.current) return
    resolvedRef.current = true
    pendingRef.current = null
    if (msgs.length > 0) {
      setMessages(prev => [...msgs, ...prev])
    }
  }, [setMessages])
}
