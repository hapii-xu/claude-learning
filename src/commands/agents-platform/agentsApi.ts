/**
 * /v1/agents 端点的轻量 HTTP 客户端。
 *
 * 复用代码库其他部分相同的 base-URL + auth-header 模式：
 *   getOauthConfig().BASE_API_URL → 基址
 *   getClaudeAIOAuthTokens()?.accessToken → Bearer token
 *   getOAuthHeaders(token) → Authorization + anthropic-version 头
 *   getOrganizationUUID() → x-organization-uuid 头
 */

import axios from 'axios'
import { getOauthConfig } from '../../constants/oauth.js'
import { assertWorkspaceHost } from '../../services/auth/hostGuard.js'
import { prepareWorkspaceApiRequest } from '../../utils/teleport/api.js'

export type AgentTrigger = {
  id: string
  cron_expr: string
  prompt: string
  status: string
  timezone: string
  next_run?: string | null
  created_at?: string
}

type ListAgentsResponse = {
  data: AgentTrigger[]
}

type AgentRunResponse = {
  run_id: string
}

// 服务器要求携带 managed-agents 的 umbrella beta 头。
const AGENTS_BETA_HEADER = 'managed-agents-2026-04-01'
const MAX_RETRIES = 3

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

class AgentsApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message)
    this.name = 'AgentsApiError'
  }
}

async function buildHeaders(): Promise<Record<string, string>> {
  // /v1/agents 需要带 workspace 作用域的 API key（sk-ant-api03-*）。
  // 订阅型 OAuth bearer token 在这里始终返回 401（服务器层面的 plane 分离）。
  // 发送 key 之前先校验 host，避免凭证泄漏。
  let apiKey: string
  try {
    const prepared = await prepareWorkspaceApiRequest()
    apiKey = prepared.apiKey
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new AgentsApiError(msg, 501)
  }
  assertWorkspaceHost(agentsBaseUrl())
  return {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': AGENTS_BETA_HEADER,
    'content-type': 'application/json',
  }
}

function agentsBaseUrl(): string {
  return `${getOauthConfig().BASE_API_URL}/v1/agents`
}

function classifyError(err: unknown): AgentsApiError {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status ?? 0
    if (status === 401) {
      return new AgentsApiError(
        'Authentication failed. Please run /login to re-authenticate.',
        401,
      )
    }
    if (status === 403) {
      return new AgentsApiError(
        'Subscription required. Scheduled agents require a Claude Pro/Max/Team subscription.',
        403,
      )
    }
    if (status === 404) {
      return new AgentsApiError('Agent not found.', 404)
    }
    // G2：新增 429 处理（此前缺失；其他 P2 客户端有）
    if (status === 429) {
      const retryAfter =
        (err.response?.headers as Record<string, string> | undefined)?.[
          'retry-after'
        ] ?? ''
      const detail = retryAfter ? ` Retry after ${retryAfter}s.` : ''
      return new AgentsApiError(`Rate limit exceeded.${detail}`, 429)
    }
    const msg =
      (err.response?.data as { error?: { message?: string } } | undefined)
        ?.error?.message ?? err.message
    return new AgentsApiError(msg, status)
  }
  if (err instanceof AgentsApiError) return err
  return new AgentsApiError(err instanceof Error ? err.message : String(err), 0)
}

/**
 * 将 Retry-After 头的值解析为毫秒。
 * 同时接受整数秒（例如 "30"）和 HTTP-date 字符串。
 * 头部缺失或无法解析时返回 null。
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
  let lastErr: AgentsApiError | undefined
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn()
    } catch (err: unknown) {
      const classified = classifyError(err)
      // 仅对 5xx 错误进行重试
      if (classified.statusCode >= 500) {
        lastErr = classified
        if (attempt < MAX_RETRIES - 1) {
          // 如有 Retry-After 则遵守；否则使用指数退避。
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
  throw lastErr ?? new AgentsApiError('Request failed after retries', 0)
}

export async function listAgents(): Promise<AgentTrigger[]> {
  return withRetry(async () => {
    const headers = await buildHeaders()
    const response = await axios.get<ListAgentsResponse>(agentsBaseUrl(), {
      headers,
    })
    return response.data.data ?? []
  })
}

export async function createAgent(
  cron: string,
  prompt: string,
): Promise<AgentTrigger> {
  return withRetry(async () => {
    const headers = await buildHeaders()
    const response = await axios.post<AgentTrigger>(
      agentsBaseUrl(),
      {
        cron_expr: cron,
        prompt,
        // 服务器端的 agent 执行始终以 UTC 运行；timezone 字段用于告诉服务器
        // 如何解读 cron 表达式。这里使用系统时区，使「每周一早 9 点」就是本地 9 点。
        // 用户可通过 parseArgs.ts 中解析的 --tz 参数覆盖。
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
      },
      { headers },
    )
    return response.data
  })
}

export async function deleteAgent(id: string): Promise<void> {
  return withRetry(async () => {
    const headers = await buildHeaders()
    await axios.delete(`${agentsBaseUrl()}/${id}`, { headers })
  })
}

export async function runAgent(id: string): Promise<AgentRunResponse> {
  return withRetry(async () => {
    const headers = await buildHeaders()
    const response = await axios.post<AgentRunResponse>(
      `${agentsBaseUrl()}/${id}/run`,
      {},
      { headers },
    )
    return response.data
  })
}
