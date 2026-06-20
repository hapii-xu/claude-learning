import { useEffect, useRef, useCallback, useState } from 'react'

interface UseSseOptions {
  /** 是否在 hook 挂载时自动连接 */
  autoConnect?: boolean
}

interface UseSseResult {
  /** SSE 事件日志 */
  lines: Array<{ type: string; data: string; timestamp: number }>
  /** 连接状态 */
  connected: boolean
  /** 连接 SSE */
  connect: (url: string) => void
  /** 断开连接 */
  disconnect: () => void
  /** 清空日志 */
  clear: () => void
  /** 最新的 exit code（如果有） */
  exitCode: number | null
}

/**
 * 通用 SSE 连接 hook
 * 用于 /api/exec/stream 和 /api/logs/tail
 */
export function useSse(options: UseSseOptions = {}): UseSseResult {
  const { autoConnect = false } = options
  const [lines, setLines] = useState<
    Array<{ type: string; data: string; timestamp: number }>
  >([])
  const [connected, setConnected] = useState(false)
  const [exitCode, setExitCode] = useState<number | null>(null)
  const sourceRef = useRef<EventSource | null>(null)

  const disconnect = useCallback(() => {
    sourceRef.current?.close()
    sourceRef.current = null
    setConnected(false)
  }, [])

  const connect = useCallback((url: string) => {
    // 关闭已有连接
    sourceRef.current?.close()

    const source = new EventSource(url)
    sourceRef.current = source
    setConnected(true)
    setExitCode(null)

    const addLine = (type: string) => (event: MessageEvent) => {
      const data = typeof event.data === 'string' ? event.data : ''
      // 尝试解析 JSON 字符串
      let parsed = data
      try {
        parsed = JSON.parse(data)
      } catch {
        // not JSON, use raw
      }
      setLines(prev => [
        ...prev,
        { type, data: String(parsed), timestamp: Date.now() },
      ])

      if (type === 'exit') {
        try {
          const exitData = JSON.parse(data)
          setExitCode(exitData.code ?? null)
        } catch {
          // ignore
        }
      }
    }

    source.addEventListener('stdout', addLine('stdout') as EventListener)
    source.addEventListener('stderr', addLine('stderr') as EventListener)
    source.addEventListener('exit', addLine('exit') as EventListener)
    source.addEventListener('line', addLine('line') as EventListener)
    source.addEventListener('ready', addLine('ready') as EventListener)
    source.addEventListener('rotated', addLine('rotated') as EventListener)
    source.addEventListener('error', addLine('error') as EventListener)
    source.addEventListener('timeout', addLine('timeout') as EventListener)

    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) {
        setConnected(false)
      }
    }
  }, [])

  const clear = useCallback(() => {
    setLines([])
    setExitCode(null)
  }, [])

  useEffect(() => {
    return () => {
      sourceRef.current?.close()
    }
  }, [])

  return { lines, connected, connect, disconnect, clear, exitCode }
}
