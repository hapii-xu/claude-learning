/** Debug event types sent from the CLI to RCS for the browser debug panel. */

export interface DebugLogEvent {
  type: 'debug_log'
  payload: {
    level: 'verbose' | 'debug' | 'info' | 'warn' | 'error'
    message: string
    timestamp: string
  }
}

export interface SdkRawEvent {
  type: 'sdk_raw'
  payload: unknown
}

export type ToolTracePhase =
  | { phase: 'start'; toolName: string; toolUseId: string; input: unknown }
  | {
      phase: 'end'
      toolName: string
      toolUseId: string
      durationMs: number
      isError: boolean
    }

export interface ToolTraceEvent {
  type: 'tool_trace'
  payload: ToolTracePhase
}

export interface UsageEvent {
  type: 'usage'
  payload: {
    usage: {
      input_tokens: number
      output_tokens: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    }
    model: string
  }
}

export type DebugEvent =
  | DebugLogEvent
  | SdkRawEvent
  | ToolTraceEvent
  | UsageEvent

export interface BatchedDebugEvent {
  id: string
  type: string
  payload: unknown
  ts: number
}

export interface DebugEventsBatch {
  sessionId: string
  events: BatchedDebugEvent[]
}
