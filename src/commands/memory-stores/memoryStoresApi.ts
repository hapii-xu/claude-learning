/**
 * /v1/memory_stores 端点的轻量 HTTP 客户端。
 *
 * 关键 spec 事实（来自对 v2.1.123 二进制的逆向工程）：
 *   - list stores:    GET    /v1/memory_stores
 *   - create store:   POST   /v1/memory_stores
 *   - get store:      GET    /v1/memory_stores/{id}
 *   - archive store:  POST   /v1/memory_stores/{id}/archive  ← 是 POST 不是 DELETE
 *   - list memories:  GET    /v1/memory_stores/{id}/memories
 *   - create memory:  POST   /v1/memory_stores/{id}/memories
 *   - get memory:     GET    /v1/memory_stores/{id}/memories/{mid}
 *   - update memory:  PATCH  /v1/memory_stores/{id}/memories/{mid}  ← 是 PATCH 不是 POST
 *   - delete memory:  DELETE /v1/memory_stores/{id}/memories/{mid}
 *   - list versions:  GET    /v1/memory_stores/{id}/memory_versions
 *   - redact version: POST   /v1/memory_stores/{id}/memory_versions/{vid}/redact
 *
 * 关键不变式：updateMemory 使用 PATCH（不是 POST）。
 * 二进制证据："PATCH /v1/memory_stores/{memory_store_id}/memories"
 *
 * 复用与 triggersApi.ts / agentsApi.ts 相同的 base-URL + auth-header 模式。
 */

import axios from 'axios'
import { getOauthConfig } from '../../constants/oauth.js'
import { assertWorkspaceHost } from '../../services/auth/hostGuard.js'
import { prepareWorkspaceApiRequest } from '../../utils/teleport/api.js'

export type MemoryStore = {
  memory_store_id: string
  name: string
  namespace?: string
  archived_at?: string | null
  created_at?: string
}

export type Memory = {
  memory_id: string
  memory_store_id: string
  content: string
  created_at?: string
  updated_at?: string
}

export type MemoryVersion = {
  version_id: string
  memory_store_id: string
  created_at?: string
  redacted_at?: string | null
}

export type CreateStoreBody = {
  name: string
  namespace?: string
}

export type CreateMemoryBody = {
  content: string
}

export type UpdateMemoryBody = {
  content: string
}

type ListStoresResponse = {
  data: MemoryStore[]
}

type ListMemoriesResponse = {
  data: Memory[]
}

type ListVersionsResponse = {
  data: MemoryVersion[]
}

// 服务器要求精确匹配该 beta header —— 来自运行时错误信息确认：
// "this API is in beta: add `managed-agents-2026-04-01`"。Memory stores 与
// /v1/agents 和 /v1/code/triggers 共享同一个 managed-agents beta 大类。
const MEMORY_STORES_BETA_HEADER = 'managed-agents-2026-04-01'
const MAX_RETRIES = 3

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

class MemoryStoresApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message)
    this.name = 'MemoryStoresApiError'
  }
}

async function buildHeaders(): Promise<Record<string, string>> {
  // /v1/memory_stores 需要一个 workspace 级 API key (sk-ant-api03-*)。
  // 服务器会明确返回："memory stores require a workspace-scoped API key or session"
  // (2026-05-03 探测确认)。Subscription OAuth bearer token 在这里始终返回 401。
  // 在发送 key 之前先校验 host，以防止凭证泄漏。
  let apiKey: string
  try {
    const prepared = await prepareWorkspaceApiRequest()
    apiKey = prepared.apiKey
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new MemoryStoresApiError(msg, 501)
  }
  assertWorkspaceHost(memoryStoresBaseUrl())
  return {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': MEMORY_STORES_BETA_HEADER,
    'content-type': 'application/json',
  }
}

function memoryStoresBaseUrl(): string {
  return `${getOauthConfig().BASE_API_URL}/v1/memory_stores`
}

function classifyError(err: unknown): MemoryStoresApiError {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status ?? 0
    if (status === 401) {
      return new MemoryStoresApiError(
        'Authentication failed. Please run /login to re-authenticate.',
        401,
      )
    }
    if (status === 403) {
      return new MemoryStoresApiError(
        'Subscription required. Memory stores require a Claude Pro/Max/Team subscription.',
        403,
      )
    }
    if (status === 404) {
      return new MemoryStoresApiError('Memory store or memory not found.', 404)
    }
    if (status === 429) {
      const retryAfter =
        (err.response?.headers as Record<string, string> | undefined)?.[
          'retry-after'
        ] ?? ''
      const detail = retryAfter ? ` Retry after ${retryAfter}s.` : ''
      return new MemoryStoresApiError(`Rate limit exceeded.${detail}`, 429)
    }
    const msg =
      (err.response?.data as { error?: { message?: string } } | undefined)
        ?.error?.message ?? err.message
    return new MemoryStoresApiError(msg, status)
  }
  if (err instanceof MemoryStoresApiError) return err
  return new MemoryStoresApiError(
    err instanceof Error ? err.message : String(err),
    0,
  )
}

/**
 * 把 Retry-After header 的值解析为毫秒。
 * 同时接受整数秒（例如 "30"）和 HTTP-date 字符串。
 * 当 header 缺失或无法解析时返回 null。
 */
function parseRetryAfterMs(header: string | undefined): number | null {
  if (!header) return null
  const seconds = Number(header)
  if (!Number.isNaN(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(header)
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
  return null
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: MemoryStoresApiError | undefined
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn()
    } catch (err: unknown) {
      const classified = classifyError(err)
      // 仅对 5xx 错误重试
      if (classified.statusCode >= 500) {
        lastErr = classified
        if (attempt < MAX_RETRIES - 1) {
          const retryAfterHeader = axios.isAxiosError(err)
            ? (err.response?.headers as Record<string, string> | undefined)?.[
                'retry-after'
              ]
            : undefined
          const waitMs =
            parseRetryAfterMs(retryAfterHeader) ?? 500 * 2 ** attempt
          await sleep(waitMs)
        }
        continue
      }
      throw classified
    }
  }
  throw lastErr ?? new MemoryStoresApiError('Request failed after retries', 0)
}

// ── Store 增删改查 ─────────────────────────────────────────────────────────────

export async function listStores(): Promise<MemoryStore[]> {
  return withRetry(async () => {
    const headers = await buildHeaders()
    const response = await axios.get<ListStoresResponse>(
      memoryStoresBaseUrl(),
      {
        headers,
      },
    )
    return response.data.data ?? []
  })
}

export async function createStore(
  name: string,
  namespace?: string,
): Promise<MemoryStore> {
  return withRetry(async () => {
    const headers = await buildHeaders()
    const body: CreateStoreBody = { name }
    if (namespace) body.namespace = namespace
    const response = await axios.post<MemoryStore>(
      memoryStoresBaseUrl(),
      body,
      {
        headers,
      },
    )
    return response.data
  })
}

export async function getStore(id: string): Promise<MemoryStore> {
  return withRetry(async () => {
    const headers = await buildHeaders()
    const response = await axios.get<MemoryStore>(
      `${memoryStoresBaseUrl()}/${id}`,
      { headers },
    )
    return response.data
  })
}

/**
 * 归档一个 memory store（软删除）。
 *
 * 重要：上游 API 归档使用 POST（不是 DELETE）。
 * 二进制字面量证据："POST /v1/memory_stores/{memory_store_id}/archive"
 */
export async function archiveStore(id: string): Promise<MemoryStore> {
  return withRetry(async () => {
    const headers = await buildHeaders()
    const response = await axios.post<MemoryStore>(
      `${memoryStoresBaseUrl()}/${id}/archive`,
      {},
      { headers },
    )
    return response.data
  })
}

// ── Memory 增删改查 ────────────────────────────────────────────────────────────

export async function listMemories(storeId: string): Promise<Memory[]> {
  return withRetry(async () => {
    const headers = await buildHeaders()
    const response = await axios.get<ListMemoriesResponse>(
      `${memoryStoresBaseUrl()}/${storeId}/memories`,
      { headers },
    )
    return response.data.data ?? []
  })
}

export async function createMemory(
  storeId: string,
  content: string,
): Promise<Memory> {
  return withRetry(async () => {
    const headers = await buildHeaders()
    const body: CreateMemoryBody = { content }
    const response = await axios.post<Memory>(
      `${memoryStoresBaseUrl()}/${storeId}/memories`,
      body,
      { headers },
    )
    return response.data
  })
}

export async function getMemory(
  storeId: string,
  memoryId: string,
): Promise<Memory> {
  return withRetry(async () => {
    const headers = await buildHeaders()
    const response = await axios.get<Memory>(
      `${memoryStoresBaseUrl()}/${storeId}/memories/${memoryId}`,
      { headers },
    )
    return response.data
  })
}

/**
 * 更新某条 memory 的内容。
 *
 * 关键不变式：此端点使用 PATCH（不是 POST/PUT）。
 * 二进制字面量证据："PATCH /v1/memory_stores/{memory_store_id}/memories"
 * 测试名："updateMemory calls PATCH /v1/memory_stores/{id}/memories/{mid} (not POST)"
 */
export async function updateMemory(
  storeId: string,
  memoryId: string,
  content: string,
): Promise<Memory> {
  return withRetry(async () => {
    const headers = await buildHeaders()
    const body: UpdateMemoryBody = { content }
    const response = await axios.patch<Memory>(
      `${memoryStoresBaseUrl()}/${storeId}/memories/${memoryId}`,
      body,
      { headers },
    )
    return response.data
  })
}

export async function deleteMemory(
  storeId: string,
  memoryId: string,
): Promise<void> {
  return withRetry(async () => {
    const headers = await buildHeaders()
    await axios.delete(
      `${memoryStoresBaseUrl()}/${storeId}/memories/${memoryId}`,
      { headers },
    )
  })
}

// ── 版本 ───────────────────────────────────────────────────────────────

export async function listVersions(storeId: string): Promise<MemoryVersion[]> {
  return withRetry(async () => {
    const headers = await buildHeaders()
    const response = await axios.get<ListVersionsResponse>(
      `${memoryStoresBaseUrl()}/${storeId}/memory_versions`,
      { headers },
    )
    return response.data.data ?? []
  })
}

/**
 * 对某个 memory 版本进行脱敏（移除 PII）。
 *
 * 重要：脱敏使用 POST（不是 DELETE）。
 * 二进制字面量证据："POST /v1/memory_stores/{id}/memory_versions/{vid}/redact"
 */
export async function redactVersion(
  storeId: string,
  versionId: string,
): Promise<MemoryVersion> {
  return withRetry(async () => {
    const headers = await buildHeaders()
    const response = await axios.post<MemoryVersion>(
      `${memoryStoresBaseUrl()}/${storeId}/memory_versions/${versionId}/redact`,
      {},
      { headers },
    )
    return response.data
  })
}
