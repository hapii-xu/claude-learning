import axios, { type AxiosRequestConfig, type AxiosResponse } from 'axios'
import { randomUUID } from 'crypto'
import { getOauthConfig } from 'src/constants/oauth.js'
import { getOrganizationUUID } from 'src/services/oauth/client.js'
import z from 'zod/v4'
import { getClaudeAIOAuthTokens } from '../auth.js'
import { getGlobalConfig } from '../config.js'
import { logForDebugging } from '../debug.js'
import { parseGitHubRepository } from '../detectRepository.js'
import { errorMessage, toError } from '../errors.js'
import { lazySchema } from '../lazySchema.js'
import { logError } from '../log.js'
import { sleep } from '../sleep.js'
import { jsonStringify } from '../slowOperations.js'

// Teleport API 请求重试配置
const TELEPORT_RETRY_DELAYS = [2000, 4000, 8000, 16000] // 4 次重试，指数退避
const MAX_TELEPORT_RETRIES = TELEPORT_RETRY_DELAYS.length

export const CCR_BYOC_BETA = 'ccr-byoc-2025-07-29'

/**
 * 检查 axios 错误是否为应重试的瞬时网络错误
 */
export function isTransientNetworkError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) {
    return false
  }

  // 网络错误时重试（未收到响应）
  if (!error.response) {
    return true
  }

  // 服务器错误时重试（5xx）
  if (error.response.status >= 500) {
    return true
  }

  // 客户端错误不重试（4xx）— 它们不是瞬时错误
  return false
}

/**
 * 发送带自动重试的 axios GET 请求（针对瞬时网络错误）
 * 使用指数退避策略：2s、4s、8s、16s（4 次重试 = 共 5 次尝试）
 */
export async function axiosGetWithRetry<T>(
  url: string,
  config?: AxiosRequestConfig,
): Promise<AxiosResponse<T>> {
  let lastError: unknown

  for (let attempt = 0; attempt <= MAX_TELEPORT_RETRIES; attempt++) {
    try {
      return await axios.get<T>(url, config)
    } catch (error) {
      lastError = error

      // 如果这不是瞬时错误，则不重试
      if (!isTransientNetworkError(error)) {
        throw error
      }

      // 如果已用尽所有重试次数，则不重试
      if (attempt >= MAX_TELEPORT_RETRIES) {
        logForDebugging(
          `Teleport request failed after ${attempt + 1} attempts: ${errorMessage(error)}`,
        )
        throw error
      }

      const delay = TELEPORT_RETRY_DELAYS[attempt] ?? 2000
      logForDebugging(
        `Teleport request failed (attempt ${attempt + 1}/${MAX_TELEPORT_RETRIES + 1}), retrying in ${delay}ms: ${errorMessage(error)}`,
      )
      await sleep(delay)
    }
  }

  throw lastError
}

// 类型与 api/schemas/sessions/sessions.py 中实际的 Sessions API 响应匹配
export type SessionStatus = 'requires_action' | 'running' | 'idle' | 'archived'

export type GitSource = {
  type: 'git_repository'
  url: string
  revision?: string | null
  allow_unrestricted_git_push?: boolean
}

export type KnowledgeBaseSource = {
  type: 'knowledge_base'
  knowledge_base_id: string
}

export type SessionContextSource = GitSource | KnowledgeBaseSource

// 来自 api/schemas/sandbox.py 的结果类型
export type OutcomeGitInfo = {
  type: 'github'
  repo: string
  branches: string[]
}

export type GitRepositoryOutcome = {
  type: 'git_repository'
  git_info: OutcomeGitInfo
}

export type Outcome = GitRepositoryOutcome

export type SessionContext = {
  sources: SessionContextSource[]
  cwd: string
  outcomes: Outcome[] | null
  custom_system_prompt: string | null
  append_system_prompt: string | null
  model: string | null
  // 在 Files API 上用 git bundle 初始化文件系统
  seed_bundle_file_id?: string
  github_pr?: { owner: string; repo: string; number: number }
  reuse_outcome_branches?: boolean
}

export type SessionResource = {
  type: 'session'
  id: string
  title: string | null
  session_status: SessionStatus
  environment_id: string
  created_at: string
  updated_at: string
  session_context: SessionContext
}

export type ListSessionsResponse = {
  data: SessionResource[]
  has_more: boolean
  first_id: string | null
  last_id: string | null
}

export const CodeSessionSchema = lazySchema(() =>
  z.object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    status: z.enum([
      'idle',
      'working',
      'waiting',
      'completed',
      'archived',
      'cancelled',
      'rejected',
    ]),
    repo: z
      .object({
        name: z.string(),
        owner: z.object({
          login: z.string(),
        }),
        default_branch: z.string().optional(),
      })
      .nullable(),
    turns: z.array(z.string()),
    created_at: z.string(),
    updated_at: z.string(),
  }),
)

// 从 Zod schema 导出推断类型
export type CodeSession = z.infer<ReturnType<typeof CodeSessionSchema>>

/**
 * L2 修复（codecov-100 审计 #12）：判断"工作区 API 密钥是否已被显式清除"与"是否从未设置"的谓词。
 * 将 workspaceApiKey 存在但为假值（null、''、空白）视为已清除，将不存在（undefined、字段缺失）视为从未设置。
 * TypeScript 类型为 `string | undefined`，但 JSON 文件可以合法地包含 null（如果用户手动编辑过），
 * 因此我们通过运行时检查来防御性地处理 null。
 *
 * 其他类型（number、boolean、object 等）会保守地回退到"未清除" — 底层状态已损坏，
 * 标准的"required"消息比声称用户清除了他们从未设置的值更少误导性。
 *
 * 导出此函数以便单元测试可以直接固定谓词，而无需绕过同级测试文件中
 * 针对 `src/utils/teleport/api.js` 的进程级 mock.module() 注册。
 */
export function isWorkspaceKeyCleared(rawValue: unknown): boolean {
  return (
    rawValue === null ||
    (typeof rawValue === 'string' && rawValue.trim() === '')
  )
}

/**
 * 验证并准备工作区 API 密钥请求（agents、vaults、memory_stores、skills）。
 *
 * 按优先级从两个来源读取工作区 API 密钥：
 *   1. ANTHROPIC_API_KEY 环境变量（优先）
 *   2. ~/.claude.json 中的 workspaceApiKey 字段（通过 /login UI 设置，无需重启）
 *
 * 验证 sk-ant-api03-* 前缀并返回密钥以供 `x-api-key` 请求头使用。
 * 配置错误（缺失或前缀错误的密钥）会以抛出错误的方式暴露，以便调用者将其转换为 501。
 *
 * @throws {Error} 当在环境变量或设置中未找到工作区密钥，或密钥不以 sk-ant-api03- 开头时抛出
 */
export async function prepareWorkspaceApiRequest(): Promise<{
  apiKey: string
}> {
  // 双来源：环境变量优先，其次是设置（通过 /login UI 保存）
  const config = getGlobalConfig()
  const apiKey =
    process.env['ANTHROPIC_API_KEY']?.trim() || config.workspaceApiKey?.trim()

  if (!apiKey) {
    // L2 修复（codecov-100 审计 #12）：当用户之前拥有工作区密钥并显式清除（设置为 null/空）时，
    // 通用的"required"错误无法告知用户发生了什么变化。检测"已清除"与"从未设置"的区别，
    // 使提示信息更具可操作性。
    const rawValue = (config as { workspaceApiKey?: string | null })
      .workspaceApiKey
    const wasCleared = isWorkspaceKeyCleared(rawValue)
    const preface = wasCleared
      ? 'Your workspace API key was cleared. '
      : 'A workspace API key (sk-ant-api03-*) is required to use workspace endpoints ' +
        '(/v1/agents, /v1/vaults, /v1/memory_stores, /v1/skills). '
    throw new Error(
      preface +
        'Press W in /login to save your key directly (no restart needed), or ' +
        'set ANTHROPIC_API_KEY=<key> and restart. ' +
        'Obtain a key from https://console.anthropic.com/settings/keys. ' +
        'Subscription OAuth (claude.ai login) cannot reach these endpoints.',
    )
  }
  if (!apiKey.startsWith('sk-ant-api03-')) {
    // D5：最多暴露前 4 个字符，避免将高熵密钥片段泄露到错误日志/报告中
    throw new Error(
      `Workspace API key must start with sk-ant-api03-, got prefix "${apiKey.slice(0, 4)}...". ` +
        'Obtain a workspace API key from https://console.anthropic.com/settings/keys. ' +
        'Press W in /login to save your key, or set ANTHROPIC_API_KEY.',
    )
  }
  return { apiKey }
}

/**
 * 验证并准备 API 请求
 * @returns 包含访问令牌和组织 UUID 的对象
 */
export async function prepareApiRequest(): Promise<{
  accessToken: string
  orgUUID: string
}> {
  const accessToken = getClaudeAIOAuthTokens()?.accessToken
  if (accessToken === undefined) {
    throw new Error(
      'Claude Code web sessions require authentication with a Claude.ai account. API key authentication is not sufficient. Please run /login to authenticate, or check your authentication status with /status.',
    )
  }

  const orgUUID = await getOrganizationUUID()
  if (!orgUUID) {
    throw new Error('Unable to get organization UUID')
  }

  return { accessToken, orgUUID }
}

/**
 * 从新的 Sessions API（/v1/sessions）获取代码会话
 * @returns 代码会话数组
 */
export async function fetchCodeSessionsFromSessionsAPI(): Promise<
  CodeSession[]
> {
  const { accessToken, orgUUID } = await prepareApiRequest()

  const url = `${getOauthConfig().BASE_API_URL}/v1/sessions`

  try {
    const headers = {
      ...getOAuthHeaders(accessToken),
      'anthropic-beta': 'ccr-byoc-2025-07-29',
      'x-organization-uuid': orgUUID,
    }

    const response = await axiosGetWithRetry<ListSessionsResponse>(url, {
      headers,
    })

    if (response.status !== 200) {
      throw new Error(`Failed to fetch code sessions: ${response.statusText}`)
    }

    // 将 SessionResource[] 转换为 CodeSession[] 格式
    const sessions: CodeSession[] = response.data.data.map(session => {
      // 从 git sources 中提取仓库信息
      const gitSource = session.session_context.sources.find(
        (source): source is GitSource => source.type === 'git_repository',
      )

      let repo: CodeSession['repo'] = null
      if (gitSource?.url) {
        // 使用现有的工具函数解析 GitHub URL
        const repoPath = parseGitHubRepository(gitSource.url)
        if (repoPath) {
          const [owner, name] = repoPath.split('/')
          if (owner && name) {
            repo = {
              name,
              owner: {
                login: owner,
              },
              default_branch: gitSource.revision || undefined,
            }
          }
        }
      }

      return {
        id: session.id,
        title: session.title || 'Untitled',
        description: '', // SessionResource 没有 description 字段
        status: session.session_status as CodeSession['status'], // 将 session_status 映射为 status
        repo,
        turns: [], // SessionResource 没有 turns 字段
        created_at: session.created_at,
        updated_at: session.updated_at,
      }
    })

    return sessions
  } catch (error) {
    const err = toError(error)
    logError(err)
    throw error
  }
}

/**
 * 为 API 请求创建 OAuth 请求头
 * @param accessToken OAuth 访问令牌
 * @returns 包含 Authorization、Content-Type 和 anthropic-version 的请求头对象
 */
export function getOAuthHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  }
}

/**
 * 通过 Sessions API 按 ID 获取单个会话
 * @param sessionId 要获取的会话 ID
 * @returns 会话资源
 */
export async function fetchSession(
  sessionId: string,
): Promise<SessionResource> {
  const { accessToken, orgUUID } = await prepareApiRequest()

  const url = `${getOauthConfig().BASE_API_URL}/v1/sessions/${sessionId}`
  const headers = {
    ...getOAuthHeaders(accessToken),
    'anthropic-beta': 'ccr-byoc-2025-07-29',
    'x-organization-uuid': orgUUID,
  }

  const response = await axios.get<SessionResource>(url, {
    headers,
    timeout: 15000,
    validateStatus: status => status < 500,
  })

  if (response.status !== 200) {
    // 如果可用，从响应中提取错误消息
    const errorData = response.data as { error?: { message?: string } }
    const apiMessage = errorData?.error?.message

    if (response.status === 404) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    if (response.status === 401) {
      throw new Error('Session expired. Please run /login to sign in again.')
    }

    throw new Error(
      apiMessage ||
        `Failed to fetch session: ${response.status} ${response.statusText}`,
    )
  }

  return response.data
}

/**
 * 从会话的 git 仓库结果中提取第一个分支名称
 * @param session 要提取的会话资源
 * @returns 第一个分支名称，如果未找到则返回 undefined
 */
export function getBranchFromSession(
  session: SessionResource,
): string | undefined {
  const gitOutcome = session.session_context.outcomes?.find(
    (outcome): outcome is GitRepositoryOutcome =>
      outcome.type === 'git_repository',
  )
  return gitOutcome?.git_info?.branches[0]
}

/**
 * 远程会话消息的内容。
 * 接受纯字符串或遵循 Anthropic API 消息规范的内容块数组（文本、图像等）。
 */
export type RemoteMessageContent =
  | string
  | Array<{ type: string; [key: string]: unknown }>

/**
 * 通过 Sessions API 向现有远程会话发送用户消息事件
 * @param sessionId 要发送事件的会话 ID
 * @param messageContent 用户消息内容（字符串或内容块）
 * @param opts.uuid 事件的可选 UUID — 已添加本地 UserMessage 的调用者应传递其 UUID，
 *   以便回声过滤可以进行去重
 * @returns Promise<boolean> 成功返回 true，否则返回 false
 */
export async function sendEventToRemoteSession(
  sessionId: string,
  messageContent: RemoteMessageContent,
  opts?: { uuid?: string },
): Promise<boolean> {
  try {
    const { accessToken, orgUUID } = await prepareApiRequest()

    const url = `${getOauthConfig().BASE_API_URL}/v1/sessions/${sessionId}/events`
    const headers = {
      ...getOAuthHeaders(accessToken),
      'anthropic-beta': 'ccr-byoc-2025-07-29',
      'x-organization-uuid': orgUUID,
    }

    const userEvent = {
      uuid: opts?.uuid ?? randomUUID(),
      session_id: sessionId,
      type: 'user',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: messageContent,
      },
    }

    const requestBody = {
      events: [userEvent],
    }

    logForDebugging(
      `[sendEventToRemoteSession] Sending event to session ${sessionId}`,
    )
    // 该端点可能会阻塞，直到 CCR worker 就绪。正常情况下观察到约 2.6s；
    // 为冷启动容器预留充足的超时时间。
    const response = await axios.post(url, requestBody, {
      headers,
      validateStatus: status => status < 500,
      timeout: 30000,
    })

    if (response.status === 200 || response.status === 201) {
      logForDebugging(
        `[sendEventToRemoteSession] Successfully sent event to session ${sessionId}`,
      )
      return true
    }

    logForDebugging(
      `[sendEventToRemoteSession] Failed with status ${response.status}: ${jsonStringify(response.data)}`,
    )
    return false
  } catch (error) {
    logForDebugging(`[sendEventToRemoteSession] Error: ${errorMessage(error)}`)
    return false
  }
}

/**
 * 通过 Sessions API 更新现有远程会话的标题
 * @param sessionId 要更新的会话 ID
 * @param title 会话的新标题
 * @returns Promise<boolean> 成功返回 true，否则返回 false
 */
export async function updateSessionTitle(
  sessionId: string,
  title: string,
): Promise<boolean> {
  try {
    const { accessToken, orgUUID } = await prepareApiRequest()

    const url = `${getOauthConfig().BASE_API_URL}/v1/sessions/${sessionId}`
    const headers = {
      ...getOAuthHeaders(accessToken),
      'anthropic-beta': 'ccr-byoc-2025-07-29',
      'x-organization-uuid': orgUUID,
    }

    logForDebugging(
      `[updateSessionTitle] Updating title for session ${sessionId}: "${title}"`,
    )
    const response = await axios.patch(
      url,
      { title },
      {
        headers,
        validateStatus: status => status < 500,
      },
    )

    if (response.status === 200) {
      logForDebugging(
        `[updateSessionTitle] Successfully updated title for session ${sessionId}`,
      )
      return true
    }

    logForDebugging(
      `[updateSessionTitle] Failed with status ${response.status}: ${jsonStringify(response.data)}`,
    )
    return false
  } catch (error) {
    logForDebugging(`[updateSessionTitle] Error: ${errorMessage(error)}`)
    return false
  }
}
