/**
 * Debug 事件订阅 hook
 * 从全局 sseBus 中过滤出调试相关的事件
 */

import { useEffect, useState, useRef } from 'react'
import { sseBus } from '../lib/rcs-chat-adapter'
import type { SessionEvent } from '../types'

export type DebugEventType = 'debug_log' | 'sdk_raw' | 'tool_trace' | 'usage'

export interface DebugEvent {
  type: DebugEventType
  payload: unknown
  timestamp: number
  seqNum?: number
}

const DEBUG_EVENT_TYPES: Set<string> = new Set([
  'debug_log',
  'sdk_raw',
  'tool_trace',
  'usage',
])

/**
 * Hook to subscribe to debug events from SSE stream
 */
export function useDebugEvents(sessionId: string): DebugEvent[] {
  const [events, setEvents] = useState<DebugEvent[]>([])
  const eventsRef = useRef<DebugEvent[]>([])

  useEffect(() => {
    const unsubscribe = sseBus.onEvent((event: SessionEvent) => {
      if (DEBUG_EVENT_TYPES.has(event.type)) {
        const debugEvent: DebugEvent = {
          type: event.type as DebugEventType,
          payload: event.payload,
          timestamp: Date.now(),
          seqNum: event.seqNum,
        }

        eventsRef.current = [...eventsRef.current, debugEvent]

        // 限制最大事件数量，避免内存溢出
        if (eventsRef.current.length > 1000) {
          eventsRef.current = eventsRef.current.slice(-500)
        }

        setEvents(eventsRef.current)
      }
    })

    return unsubscribe
  }, [sessionId])

  return events
}
