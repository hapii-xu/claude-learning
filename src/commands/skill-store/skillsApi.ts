/**
 * /v1/skills 端点的轻量 HTTP 客户端。
 *
 * 关键规范事实（来自对 v2.1.123 二进制的逆向工程）：
 *   - list skills:        GET    /v1/skills?beta=true
 *   - get skill:          GET    /v1/skills/{id}?beta=true
 *   - list versions:      GET    /v1/skills/{id}/versions?beta=true
 *   - get version:        GET    /v1/skills/{id}/versions/{v}?beta=true
 *   - create skill:       POST   /v1/skills?beta=true
 *   - delete skill:       DELETE /v1/skills/{id}?beta=true
 *
 * 关键不变式：每个请求都必须包含 ?beta=true 查询参数。
 * 二进制证据：所有 /v1/skills 路径上都有 `?beta=true` 门控。
 *
 * 复用与 memoryStoresApi.ts 相同的 base-URL + auth-header 模式。
 */

import axios from 'axios'
import { getOauthConfig } from '../../constants/oauth.js'
import { assertWorkspaceHost } from '../../services/auth/hostGuard.js'
import { prepareWorkspaceApiRequest } from '../../utils/teleport/api.js'

export type Skill = {
  skill_id: string
  name: string
  owner: string
  owner_symbol?: string
  deprecated: boolean
  allowed_tools?: string[]
  created_at?: string
}

export type SkillVersion = {
  version: string
  skill_id: string
  body: string
  created_at?: string
}

export type CreateSkillBody = {
  name: string
  body: string
}

type ListSkillsResponse = {
  data: Skill[]
}

type ListVersionsResponse = {
  data: SkillVersion[]
}

const MAX_RETRIES = 3

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

class SkillsApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message)
    this.name = 'SkillsApiError'
  }
}

async function buildHeaders(): Promise<Record<string, string>> {
  // /v1/skills 需要一个 workspace 作用域的 API key（sk-ant-api03-*）。
  // 订阅 OAuth bearer token 在这里会返回 404（该端点不在订阅认证层）。
  // 在发送 key 前校验 host，以防凭据泄漏。
  let apiKey: string
  try {
    const prepared = await prepareWorkspaceApiRequest()
    apiKey = prepared.apiKey
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new SkillsApiError(msg, 501)
  }
  assertWorkspaceHost(skillsBaseUrl())
  return {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  }
}

/**
 * 返回 /v1/skills 的 base URL，带有强制的 ?beta=true 查询参数。
 * 关键不变式：始终追加 beta=true。
 */
function skillsBaseUrl(): string {
  return `${getOauthConfig().BASE_API_URL}/v1/skills?beta=true`
}

/**
 * 返回特定 skill 的 URL，带有强制的 ?beta=true 查询参数。
 */
function skillUrl(id: string): string {
  return `${getOauthConfig().BASE_API_URL}/v1/skills/${id}?beta=true`
}

/**
 * 返回 skill versions 的 URL，带有强制的 ?beta=true 查询参数。
 */
function skillVersionsUrl(id: string): string {
  return `${getOauthConfig().BASE_API_URL}/v1/skills/${id}/versions?beta=true`
}

/**
 * 返回特定 skill version 的 URL，带有强制的 ?beta=true 查询参数。
 */
function skillVersionUrl(id: string, version: string): string {
  return `${getOauthConfig().BASE_API_URL}/v1/skills/${id}/versions/${version}?beta=true`
}

function classifyError(err: unknown): SkillsApiError {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status ?? 0
    if (status === 401) {
      return new SkillsApiError(
        'Authentication failed. Please run /login to re-authenticate.',
        401,
      )
    }
    if (status === 403) {
      return new SkillsApiError(
        'Subscription required. Skill store requires a Claude Pro/Max/Team subscription.',
        403,
      )
    }
    if (status === 404) {
      return new SkillsApiError('Skill or version not found.', 404)
    }
    if (status === 429) {
      const retryAfter =
        (err.response?.headers as Record<string, string> | undefined)?.[
          'retry-after'
        ] ?? ''
      const detail = retryAfter ? ` Retry after ${retryAfter}s.` : ''
      return new SkillsApiError(`Rate limit exceeded.${detail}`, 429)
    }
    const msg =
      (err.response?.data as { error?: { message?: string } } | undefined)
        ?.error?.message ?? err.message
    return new SkillsApiError(msg, status)
  }
  if (err instanceof SkillsApiError) return err
  return new SkillsApiError(err instanceof Error ? err.message : String(err), 0)
}

/**
 * 将 Retry-After 头部值解析为毫秒数。
 * 同时接受整数秒（例如 "30"）和 HTTP-date 字符串。
 * 当头部缺失或无法解析时返回 null。
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
  let lastErr: SkillsApiError | undefined
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn()
    } catch (err: unknown) {
      const classified = classifyError(err)
      // 仅对 5xx 错误进行重试
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
  throw lastErr ?? new SkillsApiError('Request failed after retries', 0)
}

// ── Skills CRUD ─────────────────────────────────────────────────────

export async function listSkills(): Promise<Skill[]> {
  return withRetry(async () => {
    const headers = await buildHeaders()
    const response = await axios.get<ListSkillsResponse>(skillsBaseUrl(), {
      headers,
    })
    return response.data.data ?? []
  })
}

export async function getSkill(id: string): Promise<Skill> {
  return withRetry(async () => {
    const headers = await buildHeaders()
    const response = await axios.get<Skill>(skillUrl(id), { headers })
    return response.data
  })
}

export async function getSkillVersions(id: string): Promise<SkillVersion[]> {
  return withRetry(async () => {
    const headers = await buildHeaders()
    const response = await axios.get<ListVersionsResponse>(
      skillVersionsUrl(id),
      { headers },
    )
    return response.data.data ?? []
  })
}

export async function getSkillVersion(
  id: string,
  version: string,
): Promise<SkillVersion> {
  return withRetry(async () => {
    const headers = await buildHeaders()
    const response = await axios.get<SkillVersion>(
      skillVersionUrl(id, version),
      { headers },
    )
    return response.data
  })
}

export async function createSkill(name: string, body: string): Promise<Skill> {
  return withRetry(async () => {
    const headers = await buildHeaders()
    const requestBody: CreateSkillBody = { name, body }
    const response = await axios.post<Skill>(skillsBaseUrl(), requestBody, {
      headers,
    })
    return response.data
  })
}

export async function deleteSkill(id: string): Promise<void> {
  return withRetry(async () => {
    const headers = await buildHeaders()
    await axios.delete(skillUrl(id), { headers })
  })
}
