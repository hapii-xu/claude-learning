/**
 * /v1/vaults 接口的轻量 HTTP 客户端。
 *
 * 关键规约要点（来自对 v2.1.123 二进制的逆向）：
 *   - 列出 vault：         GET    /v1/vaults
 *   - 创建 vault：         POST   /v1/vaults
 *   - 查询 vault：         GET    /v1/vaults/{id}
 *   - 归档 vault：         POST   /v1/vaults/{id}/archive      ← 是 POST，不是 DELETE
 *   - 列出凭据：           GET    /v1/vaults/{id}/credentials
 *   - 添加凭据：           POST   /v1/vaults/{id}/credentials  （推断）
 *   - 归档凭据：           POST   /v1/vaults/{id}/credentials/{cid}/archive  ← 是 POST，不是 DELETE
 *
 * 安全不变式：
 *   - credential 的 `secret` 值绝不记录日志，也绝不出现在 URL 中
 *   - 错误消息只暴露 vault/credential ID 的前 8 个字符
 *   - 不打任何 tengu_vault_* 遥测（与上游一致：敏感路径）
 *
 * 复用与 memoryStoresApi.ts / triggersApi.ts 相同的 base-URL + auth-header 模式。
 */

import axios from 'axios'
import { getOauthConfig } from '../../constants/oauth.js'
import { assertWorkspaceHost } from '../../services/auth/hostGuard.js'
import { prepareWorkspaceApiRequest } from '../../utils/teleport/api.js'
import { sanitizeId } from '../../utils/sanitizeId.js'

export type Vault = {
  vault_id: string
  name: string
  archived_at?: string | null
  created_at?: string
}

export type Credential = {
  credential_id: string
  vault_id: string
  kind?: string
  archived_at?: string | null
  created_at?: string
  // 注意：故意不定义 'secret' 字段 —— 服务器从不在响应中返回 secret
}

export type CreateVaultBody = {
  name: string
}

export type AddCredentialBody = {
  key: string
  secret: string
  kind?: string
}

type ListVaultsResponse = {
  data: Vault[]
}

type ListCredentialsResponse = {
  data: Credential[]
}

// Vault 共用 managed-agents 这把统一的 beta header。
const VAULTS_BETA_HEADER = 'managed-agents-2026-04-01'
const MAX_RETRIES = 3

// sanitizeId 从 ../../utils/sanitizeId.js 导入（H3：单一可信源）

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

class VaultsApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message)
    this.name = 'VaultsApiError'
  }
}

async function buildHeaders(): Promise<Record<string, string>> {
  // /v1/vaults 需要一个 workspace 作用域的 API key（sk-ant-api03-*）。
  // 订阅型 OAuth bearer token 在这里必然 401（服务端强制隔离不同平面）。
  // 在发送 key 之前先校验 host，以防止凭据泄漏。
  let apiKey: string
  try {
    const prepared = await prepareWorkspaceApiRequest()
    apiKey = prepared.apiKey
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new VaultsApiError(msg, 501)
  }
  assertWorkspaceHost(vaultsBaseUrl())
  return {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': VAULTS_BETA_HEADER,
    'content-type': 'application/json',
  }
}

function vaultsBaseUrl(): string {
  return `${getOauthConfig().BASE_API_URL}/v1/vaults`
}

function classifyError(err: unknown, id?: string): VaultsApiError {
  const safeId = id ? ` (${sanitizeId(id)})` : ''
  if (axios.isAxiosError(err)) {
    const status = err.response?.status ?? 0
    if (status === 401) {
      return new VaultsApiError(
        'Authentication failed. Please run /login to re-authenticate.',
        401,
      )
    }
    if (status === 403) {
      return new VaultsApiError(
        'Subscription required. Vault management requires a Claude Pro/Max/Team subscription.',
        403,
      )
    }
    if (status === 404) {
      return new VaultsApiError(`Vault or credential not found${safeId}.`, 404)
    }
    if (status === 429) {
      const retryAfter =
        (err.response?.headers as Record<string, string> | undefined)?.[
          'retry-after'
        ] ?? ''
      const detail = retryAfter ? ` Retry after ${retryAfter}s.` : ''
      return new VaultsApiError(`Rate limit exceeded.${detail}`, 429)
    }
    const msg =
      (err.response?.data as { error?: { message?: string } } | undefined)
        ?.error?.message ?? err.message
    return new VaultsApiError(msg, status)
  }
  if (err instanceof VaultsApiError) return err
  return new VaultsApiError(err instanceof Error ? err.message : String(err), 0)
}

/**
 * 将 Retry-After 头的值解析为毫秒。
 * 同时接受整数秒（例如 "30"）和 HTTP 日期字符串。
 * 当头缺失或无法解析时返回 null。
 */
function parseRetryAfterMs(header: string | undefined): number | null {
  if (!header) return null
  const seconds = Number(header)
  if (!Number.isNaN(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(header)
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
  return null
}

async function withRetry<T>(fn: () => Promise<T>, id?: string): Promise<T> {
  let lastErr: VaultsApiError | undefined
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn()
    } catch (err: unknown) {
      const classified = classifyError(err, id)
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
  throw lastErr ?? new VaultsApiError('Request failed after retries', 0)
}

// ── Vault 增删改查 ───────────────────────────────────────────────────────────

export async function listVaults(): Promise<Vault[]> {
  return withRetry(async () => {
    const headers = await buildHeaders()
    const response = await axios.get<ListVaultsResponse>(vaultsBaseUrl(), {
      headers,
    })
    return response.data.data ?? []
  })
}

export async function createVault(name: string): Promise<Vault> {
  return withRetry(async () => {
    const headers = await buildHeaders()
    const body: CreateVaultBody = { name }
    const response = await axios.post<Vault>(vaultsBaseUrl(), body, {
      headers,
    })
    return response.data
  })
}

export async function getVault(id: string): Promise<Vault> {
  return withRetry(async () => {
    const headers = await buildHeaders()
    const response = await axios.get<Vault>(`${vaultsBaseUrl()}/${id}`, {
      headers,
    })
    return response.data
  }, id)
}

/**
 * 归档一个 vault（软删除）。
 *
 * 重要：上游 API 使用 POST（而非 DELETE）进行归档。
 * 二进制字面量证据："POST /v1/vaults/{vault_id}/archive"
 */
export async function archiveVault(id: string): Promise<Vault> {
  return withRetry(async () => {
    const headers = await buildHeaders()
    const response = await axios.post<Vault>(
      `${vaultsBaseUrl()}/${id}/archive`,
      {},
      { headers },
    )
    return response.data
  }, id)
}

// ── Credential 增删改查 ──────────────────────────────────────────────────────

export async function listCredentials(vaultId: string): Promise<Credential[]> {
  return withRetry(async () => {
    const headers = await buildHeaders()
    const response = await axios.get<ListCredentialsResponse>(
      `${vaultsBaseUrl()}/${vaultId}/credentials`,
      { headers },
    )
    return response.data.data ?? []
  }, vaultId)
}

/**
 * 向某个 vault 添加一个 credential。
 *
 * 安全：`secret` 值仅出现在请求体中，
 * 绝不放入 URL 参数，也绝不记录日志。
 */
export async function addCredential(
  vaultId: string,
  key: string,
  secret: string,
): Promise<Credential> {
  return withRetry(async () => {
    const headers = await buildHeaders()
    const body: AddCredentialBody = { key, secret }
    const response = await axios.post<Credential>(
      `${vaultsBaseUrl()}/${vaultId}/credentials`,
      body,
      { headers },
    )
    return response.data
  }, vaultId)
}

/**
 * 归档一个 credential（软删除）。
 *
 * 重要：归档使用 POST（而非 DELETE）。
 * 二进制字面量证据："POST /v1/vaults/{vault_id}/credentials/{credential_id}/archive"
 */
export async function archiveCredential(
  vaultId: string,
  credentialId: string,
): Promise<Credential> {
  return withRetry(async () => {
    const headers = await buildHeaders()
    const response = await axios.post<Credential>(
      `${vaultsBaseUrl()}/${vaultId}/credentials/${credentialId}/archive`,
      {},
      { headers },
    )
    return response.data
  }, vaultId)
}
