import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import { extractErrorDetail } from './debugUtils.js'
import { toCompatSessionId } from './sessionIdCompat.js'

type GitSource = {
  type: 'git_repository'
  url: string
  revision?: string
}

type GitOutcome = {
  type: 'git_repository'
  git_info: { type: 'github'; repo: string; branches: string[] }
}

// 对 POST /v1/sessions 端点来说，事件必须包在 { type: 'event', data: <sdk_message> }
// 里（discriminated union 格式）。
type SessionEvent = {
  type: 'event'
  data: SDKMessage
}

/**
 * 通过 POST /v1/sessions 在某个 bridge environment 上创建 session。
 *
 * 同时供 `claude remote-control`（建一个空 session，让用户立刻有地方可
 * 输入）和 `/remote-control`（session 预填了对话历史）使用。
 *
 * 成功返回 session ID，失败返回 null（非致命）。
 */
export async function createBridgeSession({
  environmentId,
  title,
  events,
  gitRepoUrl,
  branch,
  signal,
  baseUrl: baseUrlOverride,
  getAccessToken,
  permissionMode,
}: {
  environmentId: string
  title?: string
  events: SessionEvent[]
  gitRepoUrl: string | null
  branch: string
  signal: AbortSignal
  baseUrl?: string
  getAccessToken?: () => string | undefined
  permissionMode?: string
}): Promise<string | null> {
  const { getClaudeAIOAuthTokens } = await import('../utils/auth.js')
  const { getOrganizationUUID } = await import('../services/oauth/client.js')
  const { getOauthConfig } = await import('../constants/oauth.js')
  const { getOAuthHeaders } = await import('../utils/teleport/api.js')
  const { parseGitHubRepository } = await import('../utils/detectRepository.js')
  const { getDefaultBranch } = await import('../utils/git.js')
  const { getMainLoopModel } = await import('../utils/model/model.js')
  const { default: axios } = await import('axios')
  const { isSelfHostedBridge } = await import('./bridgeConfig.js')

  const accessToken =
    getAccessToken?.() ?? getClaudeAIOAuthTokens()?.accessToken
  if (!accessToken) {
    logForDebugging('[bridge] No access token for session creation')
    return null
  }

  // 自托管 bridge 不需要 claude.ai org UUID —— 本地 server 不校验。用
  // 占位符避免阻塞 session 创建。
  const orgUUID = isSelfHostedBridge()
    ? 'self-hosted'
    : await getOrganizationUUID()
  if (!orgUUID) {
    logForDebugging('[bridge] No org UUID for session creation')
    return null
  }

  // 构造 git source 和 outcome 上下文
  let gitSource: GitSource | null = null
  let gitOutcome: GitOutcome | null = null

  if (gitRepoUrl) {
    const { parseGitRemote } = await import('../utils/detectRepository.js')
    const parsed = parseGitRemote(gitRepoUrl)
    if (parsed) {
      const { host, owner, name } = parsed
      const revision = branch || (await getDefaultBranch()) || undefined
      gitSource = {
        type: 'git_repository',
        url: `https://${host}/${owner}/${name}`,
        revision,
      }
      gitOutcome = {
        type: 'git_repository',
        git_info: {
          type: 'github',
          repo: `${owner}/${name}`,
          branches: [`claude/${branch || 'task'}`],
        },
      }
    } else {
      // 回退：用 parseGitHubRepository 尝试 owner/repo 格式
      const ownerRepo = parseGitHubRepository(gitRepoUrl)
      if (ownerRepo) {
        const [owner, name] = ownerRepo.split('/')
        if (owner && name) {
          const revision = branch || (await getDefaultBranch()) || undefined
          gitSource = {
            type: 'git_repository',
            url: `https://github.com/${owner}/${name}`,
            revision,
          }
          gitOutcome = {
            type: 'git_repository',
            git_info: {
              type: 'github',
              repo: `${owner}/${name}`,
              branches: [`claude/${branch || 'task'}`],
            },
          }
        }
      }
    }
  }

  const requestBody = {
    ...(title !== undefined && { title }),
    events,
    session_context: {
      sources: gitSource ? [gitSource] : [],
      outcomes: gitOutcome ? [gitOutcome] : [],
      model: getMainLoopModel(),
    },
    environment_id: environmentId,
    source: 'remote-control',
    ...(permissionMode && { permission_mode: permissionMode }),
  }

  const headers = {
    ...getOAuthHeaders(accessToken),
    'anthropic-beta': 'ccr-byoc-2025-07-29',
    'x-organization-uuid': orgUUID,
  }

  const url = `${baseUrlOverride ?? getOauthConfig().BASE_API_URL}/v1/sessions`
  let response
  try {
    response = await axios.post(url, requestBody, {
      headers,
      signal,
      validateStatus: s => s < 500,
    })
  } catch (err: unknown) {
    logForDebugging(
      `[bridge] Session creation request failed: ${errorMessage(err)}`,
    )
    return null
  }
  const isSuccess = response.status === 200 || response.status === 201

  if (!isSuccess) {
    const detail = extractErrorDetail(response.data)
    logForDebugging(
      `[bridge] Session creation failed with status ${response.status}${detail ? `: ${detail}` : ''}`,
    )
    return null
  }

  const sessionData: unknown = response.data
  if (
    !sessionData ||
    typeof sessionData !== 'object' ||
    !('id' in sessionData) ||
    typeof sessionData.id !== 'string'
  ) {
    logForDebugging('[bridge] No session ID in response')
    return null
  }

  return sessionData.id
}

/**
 * 通过 GET /v1/sessions/{id} 获取某个 bridge session。
 *
 * 返回该 session 的 environment_id（供 `--session-id` resume 使用）和
 * 标题。用的是和 create/archive 相同的 org 作用域 header —— bridgeApi.ts
 * 中的 environment 级 client 用的是另一个 beta header 且不带 org UUID，
 * 会让 Sessions API 返回 404。
 */
export async function getBridgeSession(
  sessionId: string,
  opts?: { baseUrl?: string; getAccessToken?: () => string | undefined },
): Promise<{ environment_id?: string; title?: string } | null> {
  const { getClaudeAIOAuthTokens } = await import('../utils/auth.js')
  const { getOrganizationUUID } = await import('../services/oauth/client.js')
  const { getOauthConfig } = await import('../constants/oauth.js')
  const { getOAuthHeaders } = await import('../utils/teleport/api.js')
  const { default: axios } = await import('axios')
  const { isSelfHostedBridge } = await import('./bridgeConfig.js')

  const accessToken =
    opts?.getAccessToken?.() ?? getClaudeAIOAuthTokens()?.accessToken
  if (!accessToken) {
    logForDebugging('[bridge] No access token for session fetch')
    return null
  }

  const orgUUID = isSelfHostedBridge()
    ? 'self-hosted'
    : await getOrganizationUUID()
  if (!orgUUID) {
    logForDebugging('[bridge] No org UUID for session fetch')
    return null
  }

  const headers = {
    ...getOAuthHeaders(accessToken),
    'anthropic-beta': 'ccr-byoc-2025-07-29',
    'x-organization-uuid': orgUUID,
  }

  const url = `${opts?.baseUrl ?? getOauthConfig().BASE_API_URL}/v1/sessions/${sessionId}`
  logForDebugging(`[bridge] Fetching session ${sessionId}`)

  let response
  try {
    response = await axios.get<{ environment_id?: string; title?: string }>(
      url,
      { headers, timeout: 10_000, validateStatus: s => s < 500 },
    )
  } catch (err: unknown) {
    logForDebugging(
      `[bridge] Session fetch request failed: ${errorMessage(err)}`,
    )
    return null
  }

  if (response.status !== 200) {
    const detail = extractErrorDetail(response.data)
    logForDebugging(
      `[bridge] Session fetch failed with status ${response.status}${detail ? `: ${detail}` : ''}`,
    )
    return null
  }

  return response.data
}

/**
 * 通过 POST /v1/sessions/{id}/archive 归档某个 bridge session。
 *
 * CCR server 永远不会自动归档 session —— 归档始终是客户端的显式动作。
 * `claude remote-control`（standalone bridge）和常驻的 `/remote-control`
 * REPL bridge 在关闭期间都会调它，把仍然存活的 session 归档。
 *
 * archive 端点接受任何状态的 session（running、idle、requires_action、
 * pending），已归档则返回 409，所以即使服务器侧 runner 已经把 session
 * 归档了，调用也是安全的。
 *
 * 调用方必须自己处理错误 —— 这个函数没有 try/catch；5xx、超时、网络
 * 错误都会抛。归档在 cleanup 流程里是 best-effort，调用点应在外层包
 * .catch()。
 */
export async function archiveBridgeSession(
  sessionId: string,
  opts?: {
    baseUrl?: string
    getAccessToken?: () => string | undefined
    timeoutMs?: number
  },
): Promise<void> {
  const { getClaudeAIOAuthTokens } = await import('../utils/auth.js')
  const { getOrganizationUUID } = await import('../services/oauth/client.js')
  const { getOauthConfig } = await import('../constants/oauth.js')
  const { getOAuthHeaders } = await import('../utils/teleport/api.js')
  const { default: axios } = await import('axios')
  const { isSelfHostedBridge } = await import('./bridgeConfig.js')

  const accessToken =
    opts?.getAccessToken?.() ?? getClaudeAIOAuthTokens()?.accessToken
  if (!accessToken) {
    logForDebugging('[bridge] No access token for session archive')
    return
  }

  const orgUUID = isSelfHostedBridge()
    ? 'self-hosted'
    : await getOrganizationUUID()
  if (!orgUUID) {
    logForDebugging('[bridge] No org UUID for session archive')
    return
  }

  const headers = {
    ...getOAuthHeaders(accessToken),
    'anthropic-beta': 'ccr-byoc-2025-07-29',
    'x-organization-uuid': orgUUID,
  }

  const url = `${opts?.baseUrl ?? getOauthConfig().BASE_API_URL}/v1/sessions/${sessionId}/archive`
  logForDebugging(`[bridge] Archiving session ${sessionId}`)

  const response = await axios.post(
    url,
    {},
    {
      headers,
      timeout: opts?.timeoutMs ?? 10_000,
      validateStatus: s => s < 500,
    },
  )

  if (response.status === 200) {
    logForDebugging(`[bridge] Session ${sessionId} archived successfully`)
  } else {
    const detail = extractErrorDetail(response.data)
    logForDebugging(
      `[bridge] Session archive failed with status ${response.status}${detail ? `: ${detail}` : ''}`,
    )
  }
}

/**
 * 通过 PATCH /v1/sessions/{id} 更新某个 bridge session 的标题。
 *
 * 在 bridge 连接活跃期间，用户通过 /rename 重命名 session 时调用，让
 * claude.ai/code 上的标题保持同步。
 *
 * 错误被吞掉 —— 标题同步是 best-effort。
 */
export async function updateBridgeSessionTitle(
  sessionId: string,
  title: string,
  opts?: { baseUrl?: string; getAccessToken?: () => string | undefined },
): Promise<void> {
  const { getClaudeAIOAuthTokens } = await import('../utils/auth.js')
  const { getOrganizationUUID } = await import('../services/oauth/client.js')
  const { getOauthConfig } = await import('../constants/oauth.js')
  const { getOAuthHeaders } = await import('../utils/teleport/api.js')
  const { default: axios } = await import('axios')
  const { isSelfHostedBridge } = await import('./bridgeConfig.js')

  const accessToken =
    opts?.getAccessToken?.() ?? getClaudeAIOAuthTokens()?.accessToken
  if (!accessToken) {
    logForDebugging('[bridge] No access token for session title update')
    return
  }

  const orgUUID = isSelfHostedBridge()
    ? 'self-hosted'
    : await getOrganizationUUID()
  if (!orgUUID) {
    logForDebugging('[bridge] No org UUID for session title update')
    return
  }

  const headers = {
    ...getOAuthHeaders(accessToken),
    'anthropic-beta': 'ccr-byoc-2025-07-29',
    'x-organization-uuid': orgUUID,
  }

  // compat gateway 只接受 session_*（compat/convert.go:27）。v2 调用方
  // 传的是原始 cse_*；这里统一 retag，让所有调用方都能传自己手里的任意
  // 形式。对 v1 的 session_* 和 bridgeMain 已转过的 compatSessionId 都是
  // 幂等的。
  const compatId = toCompatSessionId(sessionId)
  const url = `${opts?.baseUrl ?? getOauthConfig().BASE_API_URL}/v1/sessions/${compatId}`
  logForDebugging(`[bridge] Updating session title: ${compatId} → ${title}`)

  try {
    const response = await axios.patch(
      url,
      { title },
      { headers, timeout: 10_000, validateStatus: s => s < 500 },
    )

    if (response.status === 200) {
      logForDebugging(`[bridge] Session title updated successfully`)
    } else {
      const detail = extractErrorDetail(response.data)
      logForDebugging(
        `[bridge] Session title update failed with status ${response.status}${detail ? `: ${detail}` : ''}`,
      )
    }
  } catch (err: unknown) {
    logForDebugging(
      `[bridge] Session title update request failed: ${errorMessage(err)}`,
    )
  }
}
