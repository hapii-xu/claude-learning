/**
 * POST /web/debug/events — CLI 调试 sink 的 HTTP 接收端。
 *
 * CLI 的 debugSinks.ts 批量 POST 来自 logForDebugging、API 流、工具执行和
 * usage 的事件到这里。收到后发布到该 session 的 EventBus，浏览器 Debug 面板
 * 通过现有的 SSE 端点消费。
 *
 * 鉴权：API key（Bearer header）。仅自托管 RCS 场景使用，与 CLAUDE_BRIDGE_OAUTH_TOKEN 共用同一个 key。
 */
import { Hono } from 'hono'
import { validateApiKey } from '../../auth/api-key'
import { extractBearerToken } from '../../auth/middleware'
import { getEventBus } from '../../transport/event-bus'
import { randomUUID } from 'node:crypto'
import type {
  BatchedDebugEvent,
  DebugEventsBatch,
} from '../../types/debug-events'

const app = new Hono()

app.post('/events', async c => {
  const token = extractBearerToken(c)
  if (!validateApiKey(token)) {
    return c.json({ error: 'unauthorized' }, 401)
  }

  let body: DebugEventsBatch
  try {
    body = await c.req.json<DebugEventsBatch>()
  } catch {
    return c.json({ error: 'invalid json' }, 400)
  }

  const { sessionId, events } = body
  if (!sessionId || !Array.isArray(events)) {
    return c.json({ error: 'missing sessionId or events' }, 400)
  }

  const bus = getEventBus(sessionId)

  for (const ev of events as BatchedDebugEvent[]) {
    try {
      bus.publish({
        id: ev.id ?? randomUUID(),
        sessionId,
        type: ev.type,
        payload: ev.payload,
        direction: 'outbound',
      })
    } catch {
      // EventBus may be closed; ignore
    }
  }

  return c.json({ ok: true, received: events.length })
})

export default app
