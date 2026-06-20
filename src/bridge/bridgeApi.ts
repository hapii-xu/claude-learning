import axios from 'axios'

import { debugBody, extractErrorDetail } from './debugUtils.js'
import { rcLog } from './rcDebugLog.js'
import {
  BRIDGE_LOGIN_INSTRUCTION,
  type BridgeApiClient,
  type BridgeConfig,
  type PermissionResponseEvent,
  type WorkResponse,
} from './types.js'

type BridgeApiDeps = {
  baseUrl: string
  getAccessToken: () => string | undefined
  runnerVersion: string
  onDebug?: (msg: string) => void
  /**
   * 收到 401 时调用以尝试 OAuth token 刷新。刷新成功返回 true，调用方
   * 会重试一次请求。通过依赖注入是因为 utils/auth.ts 中的
   * handleOAuth401Error 会传递性地拉入 config.ts → file.ts →
   * permissions/filesystem.ts → sessionStorage.ts → commands.ts
   *（约 1300 个模块）。使用 env-var token 的 daemon 调用方不需要这个
   * —— 它们的 token 不会刷新，401 直接升级为 BridgeFatalError。
   */
  onAuth401?: (staleAccessToken: string) => Promise<boolean>
  /**
   * 返回要作为 X-Trusted-Device-Token 发送给 bridge API 的 trusted
   * device token。bridge session 在服务器端（CCR v2）的 SecurityTier=
   * ELEVATED；当服务器侧的强制开关打开时，ConnectBridgeWorker 在签发
   * JWT 时要求 trusted device。可选 —— 缺失或返回 undefined 时，请求
   * 不带这个 header，服务器回退到"开关关闭/无操作"分支。CLI 端的门控
   * 是 tengu_sessions_elevated_auth_enforcement（见 trustedDevice.ts）。
   */
  getTrustedDeviceToken?: () => string | undefined
}

const BETA_HEADER = 'environments-2025-11-01'

/** 用于 URL 路径段、由服务器下发 ID 的白名单模式。 */
const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/

/**
 * 校验服务器下发的 ID 是否能安全地插入 URL 路径。防止路径穿越（例如
 * `../../admin`）以及通过包含斜杠、点或其他特殊字符的 ID 进行注入。
 */
export function validateBridgeId(id: string, label: string): string {
  if (!id || !SAFE_ID_PATTERN.test(id)) {
    throw new Error(`Invalid ${label}: contains unsafe characters`)
  }
  return id
}

/** 不可重试的致命 bridge 错误（例如鉴权失败）。 */
export class BridgeFatalError extends Error {
  readonly status: number
  /** 服务器下发的错误类型，例如 "environment_expired"。 */
  readonly errorType: string | undefined
  constructor(message: string, status: number, errorType?: string) {
    super(message)
    this.name = 'BridgeFatalError'
    this.status = status
    this.errorType = errorType
  }
}

export function createBridgeApiClient(deps: BridgeApiDeps): BridgeApiClient {
  function debug(msg: string): void {
    deps.onDebug?.(msg)
  }

  let consecutiveEmptyPolls = 0
  const EMPTY_POLL_LOG_INTERVAL = 100

  function getHeaders(accessToken: string): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': BETA_HEADER,
      'x-environment-runner-version': deps.runnerVersion,
    }
    const deviceToken = deps.getTrustedDeviceToken?.()
    if (deviceToken) {
      headers['X-Trusted-Device-Token'] = deviceToken
    }
    return headers
  }

  function resolveAuth(): string {
    const accessToken = deps.getAccessToken()
    if (!accessToken) {
      throw new Error(BRIDGE_LOGIN_INSTRUCTION)
    }
    return accessToken
  }

  /**
   * 执行一个 OAuth 鉴权的请求，401 时重试一次。收到 401 时通过
   * handleOAuth401Error 尝试 token 刷新（与 withRetry.ts 对 v1/messages
   * 的处理模式一致）。刷新成功则用新 token 重试一次。刷新失败或重试
   * 仍然 401 时，把 401 响应返回，交给 handleErrorStatus 抛出
   * BridgeFatalError。
   */
  async function withOAuthRetry<T>(
    fn: (accessToken: string) => Promise<{ status: number; data: T }>,
    context: string,
  ): Promise<{ status: number; data: T }> {
    const accessToken = resolveAuth()
    const response = await fn(accessToken)

    if (response.status !== 401) {
      return response
    }

    if (!deps.onAuth401) {
      debug(`[bridge:api] ${context}: 401 received, no refresh handler`)
      return response
    }

    // 尝试 token 刷新 —— 与 withRetry.ts 的模式一致
    debug(`[bridge:api] ${context}: 401 received, attempting token refresh`)
    const refreshed = await deps.onAuth401(accessToken)
    if (refreshed) {
      debug(`[bridge:api] ${context}: Token refreshed, retrying request`)
      const newToken = resolveAuth()
      const retryResponse = await fn(newToken)
      if (retryResponse.status !== 401) {
        return retryResponse
      }
      debug(`[bridge:api] ${context}: Retry after refresh also got 401`)
    } else {
      debug(`[bridge:api] ${context}: Token refresh failed`)
    }

    // 刷新失败 —— 返回 401，交给 handleErrorStatus 抛错
    return response
  }

  return {
    async registerBridgeEnvironment(
      config: BridgeConfig,
    ): Promise<{ environment_id: string; environment_secret: string }> {
      debug(
        `[bridge:api] POST /v1/environments/bridge bridgeId=${config.bridgeId}`,
      )

      const response = await withOAuthRetry(
        (token: string) =>
          axios.post<{
            environment_id: string
            environment_secret: string
          }>(
            `${deps.baseUrl}/v1/environments/bridge`,
            {
              machine_name: config.machineName,
              directory: config.dir,
              branch: config.branch,
              git_repo_url: config.gitRepoUrl,
              // 声明 session 容量，这样 claude.ai/code 就能显示
              // "2/4 sessions" 角标，只在真正满载时才禁用选择器。
              // 暂不接受该字段的后端会静默忽略。
              max_sessions: config.maxSessions,
              // worker_type 让 claude.ai 按来源筛选 environment
              //（例如 assistant picker 只显示 assistant 模式 worker）。
              // 桌面 cowork 应用发的是 "cowork"；我们发一个独立的值。
              metadata: { worker_type: config.workerType },
              // 幂等再注册：如果我们在之前的 session 中拿到了后端下发的
              // environment_id（--session-id resume），就把它发回去，让
              // 后端重新挂接而不是创建新 env。后端仍可能在旧 ID 已过期
              // 时回传新 ID —— 调用方必须对比响应。
              ...(config.reuseEnvironmentId && {
                environment_id: config.reuseEnvironmentId,
              }),
            },
            {
              headers: getHeaders(token),
              timeout: 15_000,
              validateStatus: status => status < 500,
            },
          ),
        'Registration',
      )

      handleErrorStatus(response.status, response.data, 'Registration')
      debug(
        `[bridge:api] POST /v1/environments/bridge -> ${response.status} environment_id=${response.data.environment_id}`,
      )
      debug(
        `[bridge:api] >>> ${debugBody({ machine_name: config.machineName, directory: config.dir, branch: config.branch, git_repo_url: config.gitRepoUrl, max_sessions: config.maxSessions, metadata: { worker_type: config.workerType } })}`,
      )
      debug(`[bridge:api] <<< ${debugBody(response.data)}`)
      return response.data
    },

    async pollForWork(
      environmentId: string,
      environmentSecret: string,
      signal?: AbortSignal,
      reclaimOlderThanMs?: number,
    ): Promise<WorkResponse | null> {
      validateBridgeId(environmentId, 'environmentId')

      // 先保存再重置，这样错误能打断"连续空轮询"计数。
      // 当响应真的是空的时候，下面会把它恢复回来。
      const prevEmptyPolls = consecutiveEmptyPolls
      consecutiveEmptyPolls = 0

      const response = await axios.get<WorkResponse | null>(
        `${deps.baseUrl}/v1/environments/${environmentId}/work/poll`,
        {
          headers: getHeaders(environmentSecret),
          params:
            reclaimOlderThanMs !== undefined
              ? { reclaim_older_than_ms: reclaimOlderThanMs }
              : undefined,
          timeout: 10_000,
          signal,
          validateStatus: status => status < 500,
        },
      )

      handleErrorStatus(response.status, response.data, 'Poll')
      rcLog(
        `poll response: status=${response.status} hasData=${!!response.data} url=${deps.baseUrl}`,
      )

      // 空响应体或 null = 没有可用 work
      if (!response.data) {
        consecutiveEmptyPolls = prevEmptyPolls + 1
        if (
          consecutiveEmptyPolls === 1 ||
          consecutiveEmptyPolls % EMPTY_POLL_LOG_INTERVAL === 0
        ) {
          debug(
            `[bridge:api] GET .../work/poll -> ${response.status} (no work, ${consecutiveEmptyPolls} consecutive empty polls)`,
          )
        }
        return null
      }

      debug(
        `[bridge:api] GET .../work/poll -> ${response.status} workId=${response.data.id} type=${response.data.data?.type}${response.data.data?.id ? ` sessionId=${response.data.data.id}` : ''}`,
      )
      debug(`[bridge:api] <<< ${debugBody(response.data)}`)
      return response.data
    },

    async acknowledgeWork(
      environmentId: string,
      workId: string,
      sessionToken: string,
    ): Promise<void> {
      validateBridgeId(environmentId, 'environmentId')
      validateBridgeId(workId, 'workId')

      debug(`[bridge:api] POST .../work/${workId}/ack`)

      const response = await axios.post(
        `${deps.baseUrl}/v1/environments/${environmentId}/work/${workId}/ack`,
        {},
        {
          headers: getHeaders(sessionToken),
          timeout: 10_000,
          validateStatus: s => s < 500,
        },
      )

      handleErrorStatus(response.status, response.data, 'Acknowledge')
      debug(`[bridge:api] POST .../work/${workId}/ack -> ${response.status}`)
    },

    async stopWork(
      environmentId: string,
      workId: string,
      force: boolean,
    ): Promise<void> {
      validateBridgeId(environmentId, 'environmentId')
      validateBridgeId(workId, 'workId')

      debug(`[bridge:api] POST .../work/${workId}/stop force=${force}`)

      const response = await withOAuthRetry(
        (token: string) =>
          axios.post(
            `${deps.baseUrl}/v1/environments/${environmentId}/work/${workId}/stop`,
            { force },
            {
              headers: getHeaders(token),
              timeout: 10_000,
              validateStatus: s => s < 500,
            },
          ),
        'StopWork',
      )

      handleErrorStatus(response.status, response.data, 'StopWork')
      debug(`[bridge:api] POST .../work/${workId}/stop -> ${response.status}`)
    },

    async deregisterEnvironment(environmentId: string): Promise<void> {
      validateBridgeId(environmentId, 'environmentId')

      debug(`[bridge:api] DELETE /v1/environments/bridge/${environmentId}`)

      const response = await withOAuthRetry(
        (token: string) =>
          axios.delete(
            `${deps.baseUrl}/v1/environments/bridge/${environmentId}`,
            {
              headers: getHeaders(token),
              timeout: 10_000,
              validateStatus: s => s < 500,
            },
          ),
        'Deregister',
      )

      handleErrorStatus(response.status, response.data, 'Deregister')
      debug(
        `[bridge:api] DELETE /v1/environments/bridge/${environmentId} -> ${response.status}`,
      )
    },

    async archiveSession(sessionId: string): Promise<void> {
      validateBridgeId(sessionId, 'sessionId')

      debug(`[bridge:api] POST /v1/sessions/${sessionId}/archive`)

      const response = await withOAuthRetry(
        (token: string) =>
          axios.post(
            `${deps.baseUrl}/v1/sessions/${sessionId}/archive`,
            {},
            {
              headers: getHeaders(token),
              timeout: 10_000,
              validateStatus: s => s < 500,
            },
          ),
        'ArchiveSession',
      )

      // 409 = 已经归档过（幂等，不是错误）
      if (response.status === 409) {
        debug(
          `[bridge:api] POST /v1/sessions/${sessionId}/archive -> 409 (already archived)`,
        )
        return
      }

      handleErrorStatus(response.status, response.data, 'ArchiveSession')
      debug(
        `[bridge:api] POST /v1/sessions/${sessionId}/archive -> ${response.status}`,
      )
    },

    async reconnectSession(
      environmentId: string,
      sessionId: string,
    ): Promise<void> {
      validateBridgeId(environmentId, 'environmentId')
      validateBridgeId(sessionId, 'sessionId')

      debug(
        `[bridge:api] POST /v1/environments/${environmentId}/bridge/reconnect session_id=${sessionId}`,
      )

      const response = await withOAuthRetry(
        (token: string) =>
          axios.post(
            `${deps.baseUrl}/v1/environments/${environmentId}/bridge/reconnect`,
            { session_id: sessionId },
            {
              headers: getHeaders(token),
              timeout: 10_000,
              validateStatus: s => s < 500,
            },
          ),
        'ReconnectSession',
      )

      handleErrorStatus(response.status, response.data, 'ReconnectSession')
      debug(`[bridge:api] POST .../bridge/reconnect -> ${response.status}`)
    },

    async heartbeatWork(
      environmentId: string,
      workId: string,
      sessionToken: string,
    ): Promise<{ lease_extended: boolean; state: string }> {
      validateBridgeId(environmentId, 'environmentId')
      validateBridgeId(workId, 'workId')

      debug(`[bridge:api] POST .../work/${workId}/heartbeat`)

      const response = await axios.post<{
        lease_extended: boolean
        state: string
        last_heartbeat: string
        ttl_seconds: number
      }>(
        `${deps.baseUrl}/v1/environments/${environmentId}/work/${workId}/heartbeat`,
        {},
        {
          headers: getHeaders(sessionToken),
          timeout: 10_000,
          validateStatus: s => s < 500,
        },
      )

      handleErrorStatus(response.status, response.data, 'Heartbeat')
      debug(
        `[bridge:api] POST .../work/${workId}/heartbeat -> ${response.status} lease_extended=${response.data.lease_extended} state=${response.data.state}`,
      )
      return response.data
    },

    async sendPermissionResponseEvent(
      sessionId: string,
      event: PermissionResponseEvent,
      sessionToken: string,
    ): Promise<void> {
      validateBridgeId(sessionId, 'sessionId')

      debug(
        `[bridge:api] POST /v1/sessions/${sessionId}/events type=${event.type}`,
      )

      const response = await axios.post(
        `${deps.baseUrl}/v1/sessions/${sessionId}/events`,
        { events: [event] },
        {
          headers: getHeaders(sessionToken),
          timeout: 10_000,
          validateStatus: s => s < 500,
        },
      )

      handleErrorStatus(
        response.status,
        response.data,
        'SendPermissionResponseEvent',
      )
      debug(
        `[bridge:api] POST /v1/sessions/${sessionId}/events -> ${response.status}`,
      )
      debug(`[bridge:api] >>> ${debugBody({ events: [event] })}`)
      debug(`[bridge:api] <<< ${debugBody(response.data)}`)
    },
  }
}

function handleErrorStatus(
  status: number,
  data: unknown,
  context: string,
): void {
  if (status === 200 || status === 204) {
    return
  }
  const detail = extractErrorDetail(data)
  const errorType = extractErrorTypeFromData(data)
  switch (status) {
    case 401:
      throw new BridgeFatalError(
        `${context}: Authentication failed (401)${detail ? `: ${detail}` : ''}. ${BRIDGE_LOGIN_INSTRUCTION}`,
        401,
        errorType,
      )
    case 403:
      throw new BridgeFatalError(
        isExpiredErrorType(errorType)
          ? 'Remote Control session has expired. Please restart with `claude remote-control` or /remote-control.'
          : `${context}: Access denied (403)${detail ? `: ${detail}` : ''}. Check your organization permissions.`,
        403,
        errorType,
      )
    case 404:
      throw new BridgeFatalError(
        detail ??
          `${context}: Not found (404). Remote Control may not be available for this organization.`,
        404,
        errorType,
      )
    case 410:
      throw new BridgeFatalError(
        detail ??
          'Remote Control session has expired. Please restart with `claude remote-control` or /remote-control.',
        410,
        errorType ?? 'environment_expired',
      )
    case 429:
      throw new Error(`${context}: Rate limited (429). Polling too frequently.`)
    default:
      throw new Error(
        `${context}: Failed with status ${status}${detail ? `: ${detail}` : ''}`,
      )
  }
}

/** 判断错误类型字符串是否表示 session/environment 已过期。 */
export function isExpiredErrorType(errorType: string | undefined): boolean {
  if (!errorType) {
    return false
  }
  return errorType.includes('expired') || errorType.includes('lifetime')
}

/**
 * 判断 BridgeFatalError 是否属于可忽略的 403 权限错误。这些是针对
 * 'external_poll_sessions' 等 scope 或 StopWork 等操作的 403 错误，
 * 失败原因是用户角色缺少 'environments:manage'。它们不影响核心功能，
 * 不应该展示给用户。
 */
export function isSuppressible403(err: BridgeFatalError): boolean {
  if (err.status !== 403) {
    return false
  }
  return (
    err.message.includes('external_poll_sessions') ||
    err.message.includes('environments:manage')
  )
}

function extractErrorTypeFromData(data: unknown): string | undefined {
  if (data && typeof data === 'object') {
    if (
      'error' in data &&
      data.error &&
      typeof data.error === 'object' &&
      'type' in data.error &&
      typeof data.error.type === 'string'
    ) {
      return data.error.type
    }
  }
  return undefined
}
