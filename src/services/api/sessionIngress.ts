import axios, { type AxiosError } from 'axios'
import type { UUID } from 'crypto'
import { getOauthConfig } from '../../constants/oauth.js'
import type { Entry, TranscriptMessage } from '../../types/logs.js'
import { logForDebugging } from '../../utils/debug.js'
import { logForDiagnosticsNoPII } from '../../utils/diagLogs.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { logError } from '../../utils/log.js'
import { sequential } from '../../utils/sequential.js'
import { getSessionIngressAuthToken } from '../../utils/sessionIngressAuth.js'
import { sleep } from '../../utils/sleep.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { getOAuthHeaders } from '../../utils/teleport/api.js'

interface SessionIngressError {
  error?: {
    message?: string
    type?: string
  }
}

// 模块级状态
const lastUuidMap: Map<string, UUID> = new Map()

const MAX_RETRIES = 10
const BASE_DELAY_MS = 500

// 按 session 的串行 wrapper，防止并发写入日志
const sequentialAppendBySession: Map<
  string,
  (
    entry: TranscriptMessage,
    url: string,
    headers: Record<string, string>,
  ) => Promise<boolean>
> = new Map()

/**
 * 获取或创建一个 session 的串行 wrapper
 * 确保 session 的日志追加是逐条处理的
 */
function getOrCreateSequentialAppend(sessionId: string) {
  let sequentialAppend = sequentialAppendBySession.get(sessionId)
  if (!sequentialAppend) {
    sequentialAppend = sequential(
      async (
        entry: TranscriptMessage,
        url: string,
        headers: Record<string, string>,
      ) => await appendSessionLogImpl(sessionId, entry, url, headers),
    )
    sequentialAppendBySession.set(sessionId, sequentialAppend)
  }
  return sequentialAppend
}

/**
 * appendSessionLog 的内部实现，带重试逻辑
 * 在瞬时错误（网络、5xx、429）时重试。409 时采用服务端的 last UUID
 * 并重试（处理被 kill 进程的进行中请求造成的陈旧状态）。401 立即失败。
 */
async function appendSessionLogImpl(
  sessionId: string,
  entry: TranscriptMessage,
  url: string,
  headers: Record<string, string>,
): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const lastUuid = lastUuidMap.get(sessionId)
      const requestHeaders = { ...headers }
      if (lastUuid) {
        requestHeaders['Last-Uuid'] = lastUuid
      }

      const response = await axios.put(url, entry, {
        headers: requestHeaders,
        validateStatus: status => status < 500,
      })

      if (response.status === 200 || response.status === 201) {
        lastUuidMap.set(sessionId, entry.uuid)
        logForDebugging(
          `Successfully persisted session log entry for session ${sessionId}`,
        )
        return true
      }

      if (response.status === 409) {
        // 检查我们的条目是否其实已经被存储（服务端返回 409 但条目已存在）
        // 这处理了条目已存储但客户端收到错误响应、导致 lastUuidMap 陈旧的场景
        const serverLastUuid = response.headers['x-last-uuid']
        if (serverLastUuid === entry.uuid) {
          // 我们的条目就是服务端的最后一条 —— 此前已成功存储
          lastUuidMap.set(sessionId, entry.uuid)
          logForDebugging(
            `Session entry ${entry.uuid} already present on server, recovering from stale state`,
          )
          logForDiagnosticsNoPII('info', 'session_persist_recovered_from_409')
          return true
        }

        // 另一个写入方（例如被 kill 进程的进行中请求）推进了服务端的链。
        // 尝试从响应头采用服务端的 last UUID，或重新拉取 session 来发现它。
        if (serverLastUuid) {
          lastUuidMap.set(sessionId, serverLastUuid as UUID)
          logForDebugging(
            `Session 409: adopting server lastUuid=${serverLastUuid} from header, retrying entry ${entry.uuid}`,
          )
        } else {
          // 服务端没有返回 x-last-uuid（例如 v1 endpoint）。重新拉取
          // session 以发现追加链的当前 head。
          const logs = await fetchSessionLogsFromUrl(sessionId, url, headers)
          const adoptedUuid = findLastUuid(logs)
          if (adoptedUuid) {
            lastUuidMap.set(sessionId, adoptedUuid)
            logForDebugging(
              `Session 409: re-fetched ${logs!.length} entries, adopting lastUuid=${adoptedUuid}, retrying entry ${entry.uuid}`,
            )
          } else {
            // 无法确定服务端状态 —— 放弃
            const errorData = response.data as SessionIngressError
            const errorMessage =
              errorData.error?.message || 'Concurrent modification detected'
            logError(
              new Error(
                `Session persistence conflict: UUID mismatch for session ${sessionId}, entry ${entry.uuid}. ${errorMessage}`,
              ),
            )
            logForDiagnosticsNoPII(
              'error',
              'session_persist_fail_concurrent_modification',
            )
            return false
          }
        }
        logForDiagnosticsNoPII('info', 'session_persist_409_adopt_server_uuid')
        continue // 用更新后的 lastUuid 重试
      }

      if (response.status === 401) {
        logForDebugging('Session token expired or invalid')
        logForDiagnosticsNoPII('error', 'session_persist_fail_bad_token')
        return false // 不可重试
      }

      // 其他 4xx（429 等）—— 可重试
      logForDebugging(
        `Failed to persist session log: ${response.status} ${response.statusText}`,
      )
      logForDiagnosticsNoPII('error', 'session_persist_fail_status', {
        status: response.status,
        attempt,
      })
    } catch (error) {
      // 网络错误、5xx —— 可重试
      const axiosError = error as AxiosError<SessionIngressError>
      logError(new Error(`Error persisting session log: ${axiosError.message}`))
      logForDiagnosticsNoPII('error', 'session_persist_fail_status', {
        status: axiosError.status,
        attempt,
      })
    }

    if (attempt === MAX_RETRIES) {
      logForDebugging(`Remote persistence failed after ${MAX_RETRIES} attempts`)
      logForDiagnosticsNoPII(
        'error',
        'session_persist_error_retries_exhausted',
        { attempt },
      )
      return false
    }

    const delayMs = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), 8000)
    logForDebugging(
      `Remote persistence attempt ${attempt}/${MAX_RETRIES} failed, retrying in ${delayMs}ms…`,
    )
    await sleep(delayMs)
  }

  return false
}

/**
 * 使用 JWT token 向 session 追加一条日志条目
 * 使用 Last-Uuid header 做乐观并发控制
 * 按 session 串行执行，防止竞态条件
 */
export async function appendSessionLog(
  sessionId: string,
  entry: TranscriptMessage,
  url: string,
): Promise<boolean> {
  const sessionToken = getSessionIngressAuthToken()
  if (!sessionToken) {
    logForDebugging('No session token available for session persistence')
    logForDiagnosticsNoPII('error', 'session_persist_fail_jwt_no_token')
    return false
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${sessionToken}`,
    'Content-Type': 'application/json',
  }

  const sequentialAppend = getOrCreateSequentialAppend(sessionId)
  return sequentialAppend(entry, url, headers)
}

/**
 * 获取所有 session 日志用于 hydration
 */
export async function getSessionLogs(
  sessionId: string,
  url: string,
): Promise<Entry[] | null> {
  const sessionToken = getSessionIngressAuthToken()
  if (!sessionToken) {
    logForDebugging('No session token available for fetching session logs')
    logForDiagnosticsNoPII('error', 'session_get_fail_no_token')
    return null
  }

  const headers = { Authorization: `Bearer ${sessionToken}` }
  const logs = await fetchSessionLogsFromUrl(sessionId, url, headers)

  if (logs && logs.length > 0) {
    // Update our lastUuid to the last entry's UUID
    const lastEntry = logs.at(-1)
    if (lastEntry && 'uuid' in lastEntry && lastEntry.uuid) {
      lastUuidMap.set(sessionId, lastEntry.uuid as UUID)
    }
  }

  return logs
}

/**
 * 通过 OAuth 获取所有 session 日志用于 hydration
 * 用于从 Sessions API teleport 进来的 session
 */
export async function getSessionLogsViaOAuth(
  sessionId: string,
  accessToken: string,
  orgUUID: string,
): Promise<Entry[] | null> {
  const url = `${getOauthConfig().BASE_API_URL}/v1/session_ingress/session/${sessionId}`
  logForDebugging(`[session-ingress] Fetching session logs from: ${url}`)
  const headers = {
    ...getOAuthHeaders(accessToken),
    'x-organization-uuid': orgUUID,
  }
  const result = await fetchSessionLogsFromUrl(sessionId, url, headers)
  return result
}

/**
 * GET /v1/code/sessions/{id}/teleport-events 的响应结构。
 * WorkerEvent.payload 就是 Entry（TranscriptMessage 结构）—— CLI 通过
 * AddWorkerEvent 写入，服务端按不透明存储，我们在这里读出来。
 */
type TeleportEventsResponse = {
  data: Array<{
    event_id: string
    event_type: string
    is_compaction: boolean
    payload: Entry | null
    created_at: string
  }>
  // 没有更多页时不设置 —— 这就是流结束的信号
  // （没有单独的 has_more 字段）。
  next_cursor?: string
}

/**
 * 通过 CCR v2 Sessions API 获取 worker 事件（transcript）。在
 * session-ingress 退役后替换 getSessionLogsViaOAuth。
 *
 * 服务端按 session 分发：v2 原生 session 走 Spanner，
 * backfill 之前的 session_* ID 走 threadstore。游标对我们是不透明的 ——
 * 不断回传，直到 next_cursor 不再设置。
 *
 * 分页（默认 500/页，服务端上限 1000）。session-ingress 的一次性 50k
 * 没有了；我们改为循环。
 */
export async function getTeleportEvents(
  sessionId: string,
  accessToken: string,
  orgUUID: string,
): Promise<Entry[] | null> {
  const baseUrl = `${getOauthConfig().BASE_API_URL}/v1/code/sessions/${sessionId}/teleport-events`
  const headers = {
    ...getOAuthHeaders(accessToken),
    'x-organization-uuid': orgUUID,
  }

  logForDebugging(`[teleport] Fetching events from: ${baseUrl}`)

  const all: Entry[] = []
  let cursor: string | undefined
  let pages = 0

  // 无限循环保护：1000/页 × 100 页 = 10 万事件。比 session-ingress 的一次性
  // 5 万要大。如果命中此上限，说明出问题了（服务端没有推进游标）——
  // 直接退出而不是挂死。
  const maxPages = 100

  while (pages < maxPages) {
    const params: Record<string, string | number> = { limit: 1000 }
    if (cursor !== undefined) {
      params.cursor = cursor
    }

    let response
    try {
      response = await axios.get<TeleportEventsResponse>(baseUrl, {
        headers,
        params,
        timeout: 20000,
        validateStatus: status => status < 500,
      })
    } catch (e) {
      const err = e as AxiosError
      logError(new Error(`Teleport events fetch failed: ${err.message}`))
      logForDiagnosticsNoPII('error', 'teleport_events_fetch_fail')
      return null
    }

    if (response.status === 404) {
      // 迁移窗口期，第 0 页的 404 含义不明确：
      //   (a) session 确实找不到（既不在 Spanner 也不在 threadstore）
      //       —— 没什么可拉取。
      //   (b) 路由级 404：endpoint 尚未部署，或 session 是一个尚未
      //       回填到 Spanner 的 threadstore session。
      // 仅从响应无法区分两者。返回 null 让调用方回退到 session-ingress，
      // 它会在 (a) 情况下正确返回空、在 (b) 情况下返回数据。一旦回填完成、
      // session-ingress 被移除，fallback 也会返回 null → 与今天相同的
      // "Failed to fetch session logs" 错误。
      //
      // 分页中途（pages > 0）出现 404 意味着 session 在两页之间被删除 ——
      // 返回我们已有的内容。
      logForDebugging(
        `[teleport] Session ${sessionId} not found (page ${pages})`,
      )
      logForDiagnosticsNoPII('warn', 'teleport_events_not_found')
      return pages === 0 ? null : all
    }

    if (response.status === 401) {
      logForDiagnosticsNoPII('error', 'teleport_events_bad_token')
      throw new Error(
        'Your session has expired. Please run /login to sign in again.',
      )
    }

    if (response.status !== 200) {
      logError(
        new Error(
          `Teleport events returned ${response.status}: ${jsonStringify(response.data)}`,
        ),
      )
      logForDiagnosticsNoPII('error', 'teleport_events_bad_status')
      return null
    }

    const { data, next_cursor } = response.data
    if (!Array.isArray(data)) {
      logError(
        new Error(
          `Teleport events invalid response shape: ${jsonStringify(response.data)}`,
        ),
      )
      logForDiagnosticsNoPII('error', 'teleport_events_invalid_shape')
      return null
    }

    // payload 就是 Entry。null payload 出现在 threadstore 非 generic 事件
    // （服务端跳过它们）或加密失败时 —— 这里也跳过。
    for (const ev of data) {
      if (ev.payload !== null) {
        all.push(ev.payload)
      }
    }

    pages++
    // == null 同时覆盖 `null` 和 `undefined` —— proto 在流结束时省略该字段，
    // 但有些序列化器会发出 `null`。严格的 `=== undefined` 会在 `null` 上
    // 死循环（query 参数中的 cursor=null 会被序列化为 "null"，
    // 服务端会拒绝或回传）。
    if (next_cursor == null) {
      break
    }
    cursor = next_cursor
  }

  if (pages >= maxPages) {
    // 不算失败 —— 返回我们已有的。带截断的 transcript 做 teleport，
    // 比完全不 teleport 要好。
    logError(
      new Error(`Teleport events hit page cap (${maxPages}) for ${sessionId}`),
    )
    logForDiagnosticsNoPII('warn', 'teleport_events_page_cap')
  }

  logForDebugging(
    `[teleport] Fetched ${all.length} events over ${pages} page(s) for ${sessionId}`,
  )
  return all
}

/**
 * 从 URL 拉取 session 日志的共享实现
 */
async function fetchSessionLogsFromUrl(
  sessionId: string,
  url: string,
  headers: Record<string, string>,
): Promise<Entry[] | null> {
  try {
    const response = await axios.get(url, {
      headers,
      timeout: 20000,
      validateStatus: status => status < 500,
      params: isEnvTruthy(process.env.CLAUDE_AFTER_LAST_COMPACT)
        ? { after_last_compact: true }
        : undefined,
    })

    if (response.status === 200) {
      const data = response.data

      // 校验响应结构
      if (!data || typeof data !== 'object' || !Array.isArray(data.loglines)) {
        logError(
          new Error(
            `Invalid session logs response format: ${jsonStringify(data)}`,
          ),
        )
        logForDiagnosticsNoPII('error', 'session_get_fail_invalid_response')
        return null
      }

      const logs = data.loglines as Entry[]
      logForDebugging(
        `Fetched ${logs.length} session logs for session ${sessionId}`,
      )
      return logs
    }

    if (response.status === 404) {
      logForDebugging(`No existing logs for session ${sessionId}`)
      logForDiagnosticsNoPII('warn', 'session_get_no_logs_for_session')
      return []
    }

    if (response.status === 401) {
      logForDebugging('Auth token expired or invalid')
      logForDiagnosticsNoPII('error', 'session_get_fail_bad_token')
      throw new Error(
        'Your session has expired. Please run /login to sign in again.',
      )
    }

    logForDebugging(
      `Failed to fetch session logs: ${response.status} ${response.statusText}`,
    )
    logForDiagnosticsNoPII('error', 'session_get_fail_status', {
      status: response.status,
    })
    return null
  } catch (error) {
    const axiosError = error as AxiosError<SessionIngressError>
    logError(new Error(`Error fetching session logs: ${axiosError.message}`))
    logForDiagnosticsNoPII('error', 'session_get_fail_status', {
      status: axiosError.status,
    })
    return null
  }
}

/**
 * 从后往前遍历条目，找到最后一个带 uuid 的。
 * 某些条目类型（SummaryMessage、TagMessage）没有 uuid。
 */
function findLastUuid(logs: Entry[] | null): UUID | undefined {
  if (!logs) {
    return undefined
  }
  const entry = logs.findLast(e => 'uuid' in e && e.uuid)
  return entry && 'uuid' in entry ? (entry.uuid as UUID) : undefined
}

/**
 * 清空某个 session 的缓存状态
 */
export function clearSession(sessionId: string): void {
  lastUuidMap.delete(sessionId)
  sequentialAppendBySession.delete(sessionId)
}

/**
 * 清空所有 session 的缓存状态（全部 session）。
 * 在 /clear 时使用以释放 sub-agent 的 session 条目。
 */
export function clearAllSessions(): void {
  lastUuidMap.clear()
  sequentialAppendBySession.clear()
}
