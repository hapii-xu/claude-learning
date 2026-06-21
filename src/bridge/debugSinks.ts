/**
 * 调试 sink 协调中心：bridge 启动时注册，关闭时卸载。
 *
 * 每个数据源（logForDebugging、API 流、工具执行、usage）在自己的模块里
 * 维护一个 null 的 sink 变量。本模块在 bridge 连接后把这些 sink 全部接上，
 * 把数据批量 POST 到 RCS 的 /web/debug/events 端点，RCS 再发布到 EventBus
 * 供浏览器 Debug 面板消费。bridge 断开时 uninstall，所有 sink 归 null，
 * 终端独立运行时零开销。
 */
import { randomUUID } from 'node:crypto'
import { setDebugLogSink } from '../utils/debug.js'
import { setApiRawSink } from '../services/api/claude.js'
import { setToolTraceSink } from '../services/tools/toolExecution.js'
import { setUsageSink } from '../QueryEngine.js'

interface BatchedDebugEvent {
  id: string
  type: string
  payload: unknown
  ts: number
}

let batchBuffer: BatchedDebugEvent[] = []
let flushTimer: ReturnType<typeof setInterval> | null = null
let installConfig: {
  baseUrl: string
  token: string
  sessionId: string
} | null = null

function pushEvent(type: string, payload: unknown): void {
  batchBuffer.push({ id: randomUUID(), type, payload, ts: Date.now() })
  if (batchBuffer.length >= 50) {
    void doFlush()
  }
}

async function doFlush(): Promise<void> {
  if (batchBuffer.length === 0 || !installConfig) return
  const events = batchBuffer.splice(0, batchBuffer.length)
  const { baseUrl, token, sessionId } = installConfig
  try {
    await fetch(`${baseUrl}/web/debug/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ sessionId, events }),
    })
  } catch {
    // fire-and-forget: bridge debug panel 是尽力而为，绝不影响主流程
  }
}

export function installDebugSinks(
  baseUrl: string,
  token: string,
  sessionId: string,
): void {
  installConfig = { baseUrl, token, sessionId }

  setDebugLogSink((level, message, timestamp) => {
    try {
      pushEvent('debug_log', { level, message, timestamp })
    } catch {}
  })

  setApiRawSink(event => {
    try {
      pushEvent('sdk_raw', event)
    } catch {}
  })

  setToolTraceSink(event => {
    try {
      pushEvent('tool_trace', event)
    } catch {}
  })

  setUsageSink((usage, model) => {
    try {
      pushEvent('usage', { usage, model })
    } catch {}
  })

  flushTimer = setInterval(() => {
    void doFlush()
  }, 200)
}

export function uninstallDebugSinks(): void {
  setDebugLogSink(null)
  setApiRawSink(null)
  setToolTraceSink(null)
  setUsageSink(null)

  if (flushTimer !== null) {
    clearInterval(flushTimer)
    flushTimer = null
  }
  void doFlush().catch(() => {})
  batchBuffer = []
  installConfig = null
}
