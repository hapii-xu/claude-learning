import chalk from 'chalk'
import { exec } from 'child_process'
import { execa } from 'execa'
import { mkdir, stat } from 'fs/promises'
import memoize from 'lodash-es/memoize.js'
import { join } from 'path'
import { CLAUDE_AI_PROFILE_SCOPE } from 'src/constants/oauth.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { getModelStrings } from 'src/utils/model/modelStrings.js'
import { getAPIProvider } from 'src/utils/model/providers.js'
import {
  getIsNonInteractiveSession,
  preferThirdPartyAuthentication,
} from '../bootstrap/state.js'
import {
  getMockSubscriptionType,
  shouldUseMockSubscription,
} from '../services/mockRateLimits.js'
import {
  isOAuthTokenExpired,
  refreshOAuthToken,
  shouldUseClaudeAIAuth,
} from '../services/oauth/client.js'
import { getOauthProfileFromOauthToken } from '../services/oauth/getOauthProfile.js'
import type { OAuthTokens, SubscriptionType } from '../services/oauth/types.js'
import {
  getApiKeyFromFileDescriptor,
  getOAuthTokenFromFileDescriptor,
} from './authFileDescriptor.js'
import {
  maybeRemoveApiKeyFromMacOSKeychainThrows,
  normalizeApiKeyForConfig,
} from './authPortable.js'
import {
  checkStsCallerIdentity,
  clearAwsIniCache,
  isValidAwsStsOutput,
} from './aws.js'
import { AwsAuthStatusManager } from './awsAuthStatusManager.js'
import { clearBetasCaches } from './betas.js'
import {
  type AccountInfo,
  checkHasTrustDialogAccepted,
  getGlobalConfig,
  saveGlobalConfig,
} from './config.js'
import { logAntError, logForDebugging } from './debug.js'
import {
  getClaudeConfigHomeDir,
  isBareMode,
  isEnvTruthy,
  isRunningOnHomespace,
} from './envUtils.js'
import { errorMessage } from './errors.js'
import { execSyncWithDefaults_DEPRECATED } from './execFileNoThrow.js'
import * as lockfile from './lockfile.js'
import { logError } from './log.js'
import { memoizeWithTTLAsync } from './memoize.js'
import { getSecureStorage } from './secureStorage/index.js'
import {
  clearLegacyApiKeyPrefetch,
  getLegacyApiKeyPrefetchResult,
} from './secureStorage/keychainPrefetch.js'
import {
  clearKeychainCache,
  getMacOsKeychainStorageServiceName,
  getUsername,
} from './secureStorage/macOsKeychainHelpers.js'
import {
  getSettings_DEPRECATED,
  getSettingsForSource,
} from './settings/settings.js'
import { sleep } from './sleep.js'
import { jsonParse } from './slowOperations.js'
import { clearToolSchemaCache } from './toolSchemaCache.js'

/** API key helper 缓存的默认 TTL（毫秒，5 分钟） */
const DEFAULT_API_KEY_HELPER_TTL = 5 * 60 * 1000

/**
 * CCR 和 Claude Desktop 通过 OAuth 启动 CLI，永远不应该回退到
 * 用户 ~/.hclaude/settings.json 中的 API key 配置（apiKeyHelper、
 * env.ANTHROPIC_API_KEY、env.ANTHROPIC_AUTH_TOKEN）。这些设置是为
 * 用户的终端 CLI 准备的，不适用于托管会话。若没有此守卫，在终端用
 * API key 运行 `claude` 的用户会导致每个 CCD 会话也使用该 key，
 * 若 key 过期或组织不匹配则会失败。
 */
function isManagedOAuthContext(): boolean {
  return (
    isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) ||
    process.env.CLAUDE_CODE_ENTRYPOINT === 'claude-desktop'
  )
}

/** 是否支持直连 1P（Anthropic 官方）鉴权。 */
// 此代码与 getAuthTokenSource 紧密关联
export function isAnthropicAuthEnabled(): boolean {
  // --bare 模式：仅 API key，永不使用 OAuth。
  if (isBareMode()) return false

  // `claude ssh` 远程模式：ANTHROPIC_UNIX_SOCKET 通过本地注入鉴权的代理隧道
  // 传递 API 调用。启动器在本地侧为订阅用户时将 CLAUDE_CODE_OAUTH_TOKEN 设为
  // 占位符（使远端包含 oauth-2025 beta 头，与代理注入的头匹配）。远端的
  // ~/.hclaude 配置（apiKeyHelper、settings.env.ANTHROPIC_API_KEY）绝不能
  // 改变此行为——否则会导致与代理的头不匹配，并从 API 收到虚假的
  // "invalid x-api-key"。参见 src/ssh/sshAuthProxy.ts。
  if (process.env.ANTHROPIC_UNIX_SOCKET) {
    return !!process.env.CLAUDE_CODE_OAUTH_TOKEN
  }

  const settings = getSettings_DEPRECATED() || {}
  const is3P =
    isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY) ||
    settings.modelType === 'openai' ||
    settings.modelType === 'gemini' ||
    !!process.env.OPENAI_BASE_URL ||
    !!process.env.GEMINI_BASE_URL
  const apiKeyHelper = settings.apiKeyHelper
  const hasExternalAuthToken =
    process.env.ANTHROPIC_AUTH_TOKEN ||
    apiKeyHelper ||
    process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR

  // 检查 API key 是否来自外部来源（非 /login 管理）
  const { source: apiKeySource } = getAnthropicApiKeyWithSource({
    skipRetrievingKeyFromApiKeyHelper: true,
  })
  const hasExternalApiKey =
    apiKeySource === 'ANTHROPIC_API_KEY' || apiKeySource === 'apiKeyHelper'

  // 在以下情况下禁用 Anthropic 鉴权：
  // 1. 使用第三方服务（Bedrock/Vertex/Foundry）
  // 2. 用户有外部 API key（无论代理配置如何）
  // 3. 用户有外部认证令牌（无论代理配置如何）
  // 若用户有复杂的代理/网关"客户端凭证"场景（如用网关 key 作 X-Api-Key
  // 但用 Anthropic OAuth 作 Authorization），可能会有问题。
  // 如果收到此类反馈，应考虑添加环境变量强制启用 OAuth。
  const shouldDisableAuth =
    is3P ||
    (hasExternalAuthToken && !isManagedOAuthContext()) ||
    (hasExternalApiKey && !isManagedOAuthContext())

  return !shouldDisableAuth
}

/** 当前认证 token 的来源（如有）。 */
// 此代码与 isAnthropicAuthEnabled 紧密关联
export function getAuthTokenSource() {
  // --bare 模式：仅 API key。唯一允许的 bearer token 来源是
  // apiKeyHelper（来自 --settings）。OAuth 环境变量、FD token
  // 和密钥链均被忽略。
  if (isBareMode()) {
    if (getConfiguredApiKeyHelper()) {
      return { source: 'apiKeyHelper' as const, hasToken: true }
    }
    return { source: 'none' as const, hasToken: false }
  }

  if (process.env.ANTHROPIC_AUTH_TOKEN && !isManagedOAuthContext()) {
    return { source: 'ANTHROPIC_AUTH_TOKEN' as const, hasToken: true }
  }

  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { source: 'CLAUDE_CODE_OAUTH_TOKEN' as const, hasToken: true }
  }

  // 检查来自文件描述符的 OAuth token（或其 CCR 磁盘回退）
  const oauthTokenFromFd = getOAuthTokenFromFileDescriptor()
  if (oauthTokenFromFd) {
    // getOAuthTokenFromFileDescriptor 为无法继承管道 FD 的 CCR 子进程
    // 提供磁盘回退。通过环境变量是否存在来区分来源，避免组织不匹配的
    // 错误信息要求用户取消一个不存在的变量。调用方正常穿透——新来源
    // !== 'none'（cli/handlers/auth.ts → oauth_token），且不在
    // isEnvVarToken 集合中（auth.ts:1844 → 通用重登录消息）。
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR) {
      return {
        source: 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR' as const,
        hasToken: true,
      }
    }
    return {
      source: 'CCR_OAUTH_TOKEN_FILE' as const,
      hasToken: true,
    }
  }

  // 检查是否配置了 apiKeyHelper 但不执行它
  // 这可防止在信任建立前执行任意代码的安全问题
  const apiKeyHelper = getConfiguredApiKeyHelper()
  if (apiKeyHelper && !isManagedOAuthContext()) {
    return { source: 'apiKeyHelper' as const, hasToken: true }
  }

  const oauthTokens = getClaudeAIOAuthTokens()
  if (shouldUseClaudeAIAuth(oauthTokens?.scopes) && oauthTokens?.accessToken) {
    return { source: 'claude.ai' as const, hasToken: true }
  }

  return { source: 'none' as const, hasToken: false }
}

export type ApiKeySource =
  | 'ANTHROPIC_API_KEY'
  | 'apiKeyHelper'
  | '/login managed key'
  | 'none'

export function getAnthropicApiKey(): null | string {
  const { key } = getAnthropicApiKeyWithSource()
  return key
}

export function hasAnthropicApiKeyAuth(): boolean {
  const { key, source } = getAnthropicApiKeyWithSource({
    skipRetrievingKeyFromApiKeyHelper: true,
  })
  return key !== null && source !== 'none'
}

export function getAnthropicApiKeyWithSource(
  opts: { skipRetrievingKeyFromApiKeyHelper?: boolean } = {},
): {
  key: null | string
  source: ApiKeySource
} {
  // --bare 模式：封闭鉴权。只使用 ANTHROPIC_API_KEY 环境变量或
  // --settings 中的 apiKeyHelper。不访问密钥链、配置文件或审批列表。
  // 3P（Bedrock/Vertex/Foundry）使用各自的 provider 凭证，不走此路径。
  if (isBareMode()) {
    if (process.env.ANTHROPIC_API_KEY) {
      return { key: process.env.ANTHROPIC_API_KEY, source: 'ANTHROPIC_API_KEY' }
    }
    if (getConfiguredApiKeyHelper()) {
      return {
        key: opts.skipRetrievingKeyFromApiKeyHelper
          ? null
          : getApiKeyFromApiKeyHelperCached(),
        source: 'apiKeyHelper',
      }
    }
    return { key: null, source: 'none' }
  }

  // 在 homespace 上不使用 ANTHROPIC_API_KEY（改用 Console key）
  // https://anthropic.slack.com/archives/C08428WSLKV/p1747331773214779
  const apiKeyEnv = isRunningOnHomespace()
    ? undefined
    : process.env.ANTHROPIC_API_KEY

  // 用户以 claude --print 运行时，始终检查直接设置的环境变量。
  // 这在 CI 等场景中很有用。
  if (preferThirdPartyAuthentication() && apiKeyEnv) {
    return {
      key: apiKeyEnv,
      source: 'ANTHROPIC_API_KEY',
    }
  }

  if (isEnvTruthy(process.env.CI) || process.env.NODE_ENV === 'test') {
    // 优先从文件描述符获取 API key
    const apiKeyFromFd = getApiKeyFromFileDescriptor()
    if (apiKeyFromFd) {
      return {
        key: apiKeyFromFd,
        source: 'ANTHROPIC_API_KEY',
      }
    }

    if (
      !apiKeyEnv &&
      !process.env.CLAUDE_CODE_OAUTH_TOKEN &&
      !process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
    ) {
      throw new Error(
        'ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN env var is required',
      )
    }

    if (apiKeyEnv) {
      return {
        key: apiKeyEnv,
        source: 'ANTHROPIC_API_KEY',
      }
    }

    // OAuth token 存在，但此函数只返回 API key
    return {
      key: null,
      source: 'none',
    }
  }
  // 在检查 apiKeyHelper 或 /login 管理的 key 之前，先检查 ANTHROPIC_API_KEY
  if (
    apiKeyEnv &&
    getGlobalConfig().customApiKeyResponses?.approved?.includes(
      normalizeApiKeyForConfig(apiKeyEnv),
    )
  ) {
    return {
      key: apiKeyEnv,
      source: 'ANTHROPIC_API_KEY',
    }
  }

  // 从文件描述符检查 API key
  const apiKeyFromFd = getApiKeyFromFileDescriptor()
  if (apiKeyFromFd) {
    return {
      key: apiKeyFromFd,
      source: 'ANTHROPIC_API_KEY',
    }
  }

  // 检查 apiKeyHelper——使用同步缓存，永不阻塞
  const apiKeyHelperCommand = getConfiguredApiKeyHelper()
  if (apiKeyHelperCommand) {
    if (opts.skipRetrievingKeyFromApiKeyHelper) {
      return {
        key: null,
        source: 'apiKeyHelper',
      }
    }
    // 缓存可能是冷的（helper 尚未完成）。返回 null 并将
    // source 设为 'apiKeyHelper'，而不是穿透到密钥链——
    // apiKeyHelper 必须优先。需要实际 key 的调用方必须先
    // await getApiKeyFromApiKeyHelper()（client.ts、useApiKeyVerification 均如此）。
    return {
      key: getApiKeyFromApiKeyHelperCached(),
      source: 'apiKeyHelper',
    }
  }

  const apiKeyFromConfigOrMacOSKeychain = getApiKeyFromConfigOrMacOSKeychain()
  if (apiKeyFromConfigOrMacOSKeychain) {
    return apiKeyFromConfigOrMacOSKeychain
  }

  return {
    key: null,
    source: 'none',
  }
}

/**
 * 从设置中获取已配置的 apiKeyHelper。
 * 在 bare 模式下，只查询 --settings 标志来源——
 * ~/.hclaude/settings.json 或项目设置中的 apiKeyHelper 会被忽略。
 */
export function getConfiguredApiKeyHelper(): string | undefined {
  if (isBareMode()) {
    return getSettingsForSource('flagSettings')?.apiKeyHelper
  }
  const mergedSettings = getSettings_DEPRECATED() || {}
  return mergedSettings.apiKeyHelper
}

/**
 * 检查已配置的 apiKeyHelper 是否来自项目设置（projectSettings 或 localSettings）
 */
function isApiKeyHelperFromProjectOrLocalSettings(): boolean {
  const apiKeyHelper = getConfiguredApiKeyHelper()
  if (!apiKeyHelper) {
    return false
  }

  const projectSettings = getSettingsForSource('projectSettings')
  const localSettings = getSettingsForSource('localSettings')
  return (
    projectSettings?.apiKeyHelper === apiKeyHelper ||
    localSettings?.apiKeyHelper === apiKeyHelper
  )
}

/**
 * 从设置中获取已配置的 awsAuthRefresh
 */
function getConfiguredAwsAuthRefresh(): string | undefined {
  const mergedSettings = getSettings_DEPRECATED() || {}
  return mergedSettings.awsAuthRefresh
}

/**
 * 检查已配置的 awsAuthRefresh 是否来自项目设置
 */
export function isAwsAuthRefreshFromProjectSettings(): boolean {
  const awsAuthRefresh = getConfiguredAwsAuthRefresh()
  if (!awsAuthRefresh) {
    return false
  }

  const projectSettings = getSettingsForSource('projectSettings')
  const localSettings = getSettingsForSource('localSettings')
  return (
    projectSettings?.awsAuthRefresh === awsAuthRefresh ||
    localSettings?.awsAuthRefresh === awsAuthRefresh
  )
}

/**
 * 从设置中获取已配置的 awsCredentialExport
 */
function getConfiguredAwsCredentialExport(): string | undefined {
  const mergedSettings = getSettings_DEPRECATED() || {}
  return mergedSettings.awsCredentialExport
}

/**
 * 检查已配置的 awsCredentialExport 是否来自项目设置
 */
export function isAwsCredentialExportFromProjectSettings(): boolean {
  const awsCredentialExport = getConfiguredAwsCredentialExport()
  if (!awsCredentialExport) {
    return false
  }

  const projectSettings = getSettingsForSource('projectSettings')
  const localSettings = getSettingsForSource('localSettings')
  return (
    projectSettings?.awsCredentialExport === awsCredentialExport ||
    localSettings?.awsCredentialExport === awsCredentialExport
  )
}

/**
 * 计算 API key helper 缓存的 TTL（毫秒）。
 * 若 CLAUDE_CODE_API_KEY_HELPER_TTL_MS 环境变量已设置且有效则使用它，
 * 否则默认 5 分钟。
 */
export function calculateApiKeyHelperTTL(): number {
  const envTtl = process.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS

  if (envTtl) {
    const parsed = parseInt(envTtl, 10)
    if (!Number.isNaN(parsed) && parsed >= 0) {
      return parsed
    }
    logForDebugging(
      `Found CLAUDE_CODE_API_KEY_HELPER_TTL_MS env var, but it was not a valid number. Got ${envTtl}`,
      { level: 'error' },
    )
  }

  return DEFAULT_API_KEY_HELPER_TTL
}

// 带同步缓存的异步 API key helper，用于非阻塞读取。
// clearApiKeyHelperCache() 时 epoch 递增——孤立的执行在修改模块状态前
// 会检查其捕获的 epoch，防止设置变更或 401 重试时覆盖更新的缓存/飞行中请求。
let _apiKeyHelperCache: { value: string; timestamp: number } | null = null
let _apiKeyHelperInflight: {
  promise: Promise<string | null>
  // Only set on cold launches (user is waiting); null for SWR background refreshes.
  startedAt: number | null
} | null = null
let _apiKeyHelperEpoch = 0

export function getApiKeyHelperElapsedMs(): number {
  const startedAt = _apiKeyHelperInflight?.startedAt
  return startedAt ? Date.now() - startedAt : 0
}

export async function getApiKeyFromApiKeyHelper(
  isNonInteractiveSession: boolean,
): Promise<string | null> {
  if (!getConfiguredApiKeyHelper()) return null
  const ttl = calculateApiKeyHelperTTL()
  if (_apiKeyHelperCache) {
    if (Date.now() - _apiKeyHelperCache.timestamp < ttl) {
      return _apiKeyHelperCache.value
    }
    // 已过期——立即返回旧值，在后台刷新。
    // `??=` 因 eslint no-nullish-assign-object-call（bun bug）在此禁用。
    if (!_apiKeyHelperInflight) {
      _apiKeyHelperInflight = {
        promise: _runAndCache(
          isNonInteractiveSession,
          false,
          _apiKeyHelperEpoch,
        ),
        startedAt: null,
      }
    }
    return _apiKeyHelperCache.value
  }
  // 缓存为空——对并发调用去重
  if (_apiKeyHelperInflight) return _apiKeyHelperInflight.promise
  _apiKeyHelperInflight = {
    promise: _runAndCache(isNonInteractiveSession, true, _apiKeyHelperEpoch),
    startedAt: Date.now(),
  }
  return _apiKeyHelperInflight.promise
}

async function _runAndCache(
  isNonInteractiveSession: boolean,
  isCold: boolean,
  epoch: number,
): Promise<string | null> {
  try {
    const value = await _executeApiKeyHelper(isNonInteractiveSession)
    if (epoch !== _apiKeyHelperEpoch) return value
    if (value !== null) {
      _apiKeyHelperCache = { value, timestamp: Date.now() }
    }
    return value
  } catch (e) {
    if (epoch !== _apiKeyHelperEpoch) return ' '
    const detail = e instanceof Error ? e.message : String(e)
    console.error(chalk.red(`apiKeyHelper failed: ${detail}`))
    logForDebugging(`Error getting API key from apiKeyHelper: ${detail}`, {
      level: 'error',
    })
    // SWR 路径：瞬时失败不应将可用 key 替换为 ' ' 哨兵值——
    // 继续提供旧值并更新时间戳，避免每次调用都重试。
    if (!isCold && _apiKeyHelperCache && _apiKeyHelperCache.value !== ' ') {
      _apiKeyHelperCache = { ..._apiKeyHelperCache, timestamp: Date.now() }
      return _apiKeyHelperCache.value
    }
    // 缓存为空或先前出错——缓存 ' ' 使调用方不回退到 OAuth
    _apiKeyHelperCache = { value: ' ', timestamp: Date.now() }
    return ' '
  } finally {
    if (epoch === _apiKeyHelperEpoch) {
      _apiKeyHelperInflight = null
    }
  }
}

async function _executeApiKeyHelper(
  isNonInteractiveSession: boolean,
): Promise<string | null> {
  const apiKeyHelper = getConfiguredApiKeyHelper()
  if (!apiKeyHelper) {
    return null
  }

  if (isApiKeyHelperFromProjectOrLocalSettings()) {
    const hasTrust = checkHasTrustDialogAccepted()
    if (!hasTrust && !isNonInteractiveSession) {
      const error = new Error(
        `Security: apiKeyHelper executed before workspace trust is confirmed. If you see this message, post in ${MACRO.FEEDBACK_CHANNEL}.`,
      )
      logAntError('apiKeyHelper invoked before trust check', error)
      logEvent('tengu_apiKeyHelper_missing_trust11', {})
      return null
    }
  }

  const result = await execa(apiKeyHelper, {
    shell: true,
    timeout: 10 * 60 * 1000,
    reject: false,
  })
  if (result.failed) {
    // reject:false — execa resolves on exit≠0/timeout, stderr is on result
    const why = result.timedOut ? 'timed out' : `exited ${result.exitCode}`
    const stderr = result.stderr?.trim()
    throw new Error(stderr ? `${why}: ${stderr}` : why)
  }
  const stdout = result.stdout?.trim()
  if (!stdout) {
    throw new Error('did not return a value')
  }
  return stdout
}

/**
 * 同步缓存读取器——返回上次获取的 apiKeyHelper 值而不执行命令。
 * 返回旧值以匹配异步读取器的 SWR 语义。
 * 仅在异步获取尚未完成时返回 null。
 */
export function getApiKeyFromApiKeyHelperCached(): string | null {
  return _apiKeyHelperCache?.value ?? null
}

export function clearApiKeyHelperCache(): void {
  _apiKeyHelperEpoch++
  _apiKeyHelperCache = null
  _apiKeyHelperInflight = null
}

export function prefetchApiKeyFromApiKeyHelperIfSafe(
  isNonInteractiveSession: boolean,
): void {
  // 若信任尚未确认则跳过——内部 _executeApiKeyHelper 检查也会拦截，
  // 但会触发一个误报的分析事件。
  if (
    isApiKeyHelperFromProjectOrLocalSettings() &&
    !checkHasTrustDialogAccepted()
  ) {
    return
  }
  void getApiKeyFromApiKeyHelper(isNonInteractiveSession)
}

/** STS 凭证默认有效期一小时。我们手动管理失效，所以不太担心精确性。 */
const DEFAULT_AWS_STS_TTL = 60 * 60 * 1000

/**
 * 运行 awsAuthRefresh 执行交互式认证（如 aws sso login）
 * 实时流式输出，供用户查看
 */
async function runAwsAuthRefresh(): Promise<boolean> {
  const awsAuthRefresh = getConfiguredAwsAuthRefresh()

  if (!awsAuthRefresh) {
    return false // 未配置，视为成功
  }

  // 安全检查：确认 awsAuthRefresh 是否来自项目设置
  if (isAwsAuthRefreshFromProjectSettings()) {
    // 检查该项目是否已建立信任
    const hasTrust = checkHasTrustDialogAccepted()
    if (!hasTrust && !getIsNonInteractiveSession()) {
      const error = new Error(
        `Security: awsAuthRefresh executed before workspace trust is confirmed. If you see this message, post in ${MACRO.FEEDBACK_CHANNEL}.`,
      )
      logAntError('awsAuthRefresh invoked before trust check', error)
      logEvent('tengu_awsAuthRefresh_missing_trust', {})
      return false
    }
  }

  try {
    logForDebugging('获取 AWS caller identity 以判断是否需要 AWS auth 刷新')
    await checkStsCallerIdentity()
    logForDebugging('AWS caller identity 获取成功，跳过 AWS auth 刷新命令')
    return false
  } catch {
    // 仅在 caller-identity 调用失败时才实际执行刷新
    return refreshAwsAuth(awsAuthRefresh)
  }
}

// AWS auth 刷新命令超时时间（3 分钟）。
// 足够浏览器 SSO 流程完成，同时避免无限挂起。
const AWS_AUTH_REFRESH_TIMEOUT_MS = 3 * 60 * 1000

export function refreshAwsAuth(awsAuthRefresh: string): Promise<boolean> {
  logForDebugging('运行 AWS auth 刷新命令')
  // 开始跟踪认证状态
  const authStatusManager = AwsAuthStatusManager.getInstance()
  authStatusManager.startAuthentication()

  return new Promise(resolve => {
    const refreshProc = exec(awsAuthRefresh, {
      timeout: AWS_AUTH_REFRESH_TIMEOUT_MS,
    })
    refreshProc.stdout!.on('data', data => {
      const output = data.toString().trim()
      if (output) {
        // 将输出添加到状态管理器供 UI 显示
        authStatusManager.addOutput(output)
        // 同时记录调试日志
        logForDebugging(output, { level: 'debug' })
      }
    })

    refreshProc.stderr!.on('data', data => {
      const error = data.toString().trim()
      if (error) {
        authStatusManager.setError(error)
        logForDebugging(error, { level: 'error' })
      }
    })

    refreshProc.on('close', (code, signal) => {
      if (code === 0) {
        logForDebugging('AWS auth 刷新成功完成')
        authStatusManager.endAuthentication(true)
        void resolve(true)
      } else {
        const timedOut = signal === 'SIGTERM'
        const message = timedOut
          ? chalk.red(
              'AWS auth refresh timed out after 3 minutes. Run your auth command manually in a separate terminal.',
            )
          : chalk.red(
              'Error running awsAuthRefresh (in settings or ~/.hclaude.json):',
            )
        console.error(message)
        authStatusManager.endAuthentication(false)
        void resolve(false)
      }
    })
  })
}

/**
 * 运行 awsCredentialExport 获取凭证并设置环境变量。
 * 期望输出包含 AWS 凭证的 JSON。
 */
async function getAwsCredsFromCredentialExport(): Promise<{
  accessKeyId: string
  secretAccessKey: string
  sessionToken: string
} | null> {
  const awsCredentialExport = getConfiguredAwsCredentialExport()

  if (!awsCredentialExport) {
    return null
  }

  // 安全检查：确认 awsCredentialExport 是否来自项目设置
  if (isAwsCredentialExportFromProjectSettings()) {
    // 检查该项目是否已建立信任
    const hasTrust = checkHasTrustDialogAccepted()
    if (!hasTrust && !getIsNonInteractiveSession()) {
      const error = new Error(
        `Security: awsCredentialExport executed before workspace trust is confirmed. If you see this message, post in ${MACRO.FEEDBACK_CHANNEL}.`,
      )
      logAntError('awsCredentialExport invoked before trust check', error)
      logEvent('tengu_awsCredentialExport_missing_trust', {})
      return null
    }
  }

  try {
    logForDebugging('获取 AWS caller identity 以判断是否需要凭证导出')
    await checkStsCallerIdentity()
    logForDebugging('AWS caller identity 获取成功，跳过 AWS 凭证导出命令')
    return null
  } catch {
    // 仅在 caller-identity 调用失败时才实际执行导出
    try {
      logForDebugging('运行 AWS 凭证导出命令')
      const result = await execa(awsCredentialExport, {
        shell: true,
        reject: false,
      })
      if (result.exitCode !== 0 || !result.stdout) {
        throw new Error('awsCredentialExport did not return a valid value')
      }

      // 解析 aws sts 命令的 JSON 输出
      const awsOutput = jsonParse(result.stdout.trim())

      if (!isValidAwsStsOutput(awsOutput)) {
        throw new Error(
          'awsCredentialExport did not return valid AWS STS output structure',
        )
      }

      logForDebugging('已从 awsCredentialExport 获取 AWS 凭证')
      return {
        accessKeyId: awsOutput.Credentials.AccessKeyId,
        secretAccessKey: awsOutput.Credentials.SecretAccessKey,
        sessionToken: awsOutput.Credentials.SessionToken,
      }
    } catch (e) {
      const message = chalk.red(
        'Error getting AWS credentials from awsCredentialExport (in settings or ~/.hclaude.json):',
      )
      if (e instanceof Error) {
        console.error(message, e.message)
      } else {
        console.error(message, e)
      }
      return null
    }
  }
}

/**
 * 刷新 AWS 认证并获取凭证，同时清除缓存。
 * 组合了 runAwsAuthRefresh、getAwsCredsFromCredentialExport 和 clearAwsIniCache，
 * 确保始终使用最新凭证。
 */
export const refreshAndGetAwsCredentials = memoizeWithTTLAsync(
  async (): Promise<{
    accessKeyId: string
    secretAccessKey: string
    sessionToken: string
  } | null> => {
    // 如有必要，先执行 auth 刷新
    const refreshed = await runAwsAuthRefresh()

    // 从导出命令获取凭证
    const credentials = await getAwsCredsFromCredentialExport()

    // 清除 AWS INI 缓存，确保使用最新凭证
    if (refreshed || credentials) {
      await clearAwsIniCache()
    }

    return credentials
  },
  DEFAULT_AWS_STS_TTL,
)

export function clearAwsCredentialsCache(): void {
  refreshAndGetAwsCredentials.cache.clear()
}

/**
 * 从设置中获取已配置的 gcpAuthRefresh
 */
function getConfiguredGcpAuthRefresh(): string | undefined {
  const mergedSettings = getSettings_DEPRECATED() || {}
  return mergedSettings.gcpAuthRefresh
}

/**
 * 检查已配置的 gcpAuthRefresh 是否来自项目设置
 */
export function isGcpAuthRefreshFromProjectSettings(): boolean {
  const gcpAuthRefresh = getConfiguredGcpAuthRefresh()
  if (!gcpAuthRefresh) {
    return false
  }

  const projectSettings = getSettingsForSource('projectSettings')
  const localSettings = getSettingsForSource('localSettings')
  return (
    projectSettings?.gcpAuthRefresh === gcpAuthRefresh ||
    localSettings?.gcpAuthRefresh === gcpAuthRefresh
  )
}

/** GCP 凭证探测的短超时。若无此设置，当没有本地凭证来源（无 ADC 文件、
 *  无环境变量）时，google-auth-library 会穿透到 GCE 元数据服务器，
 *  在 GCP 外部会挂起约 12 秒。 */
const GCP_CREDENTIALS_CHECK_TIMEOUT_MS = 5_000

/**
 * 通过尝试获取 access token 来检查 GCP 凭证是否有效。
 * 使用与 Vertex SDK 相同的认证链。
 */
export async function checkGcpCredentialsValid(): Promise<boolean> {
  try {
    // 动态导入，避免不必要地加载 google-auth-library
    const { GoogleAuth } = await import('google-auth-library')
    const auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    })
    const probe = (async () => {
      const client = await auth.getClient()
      await client.getAccessToken()
    })()
    const timeout = sleep(GCP_CREDENTIALS_CHECK_TIMEOUT_MS).then(() => {
      throw new GcpCredentialsTimeoutError('GCP credentials check timed out')
    })
    await Promise.race([probe, timeout])
    return true
  } catch {
    return false
  }
}

/** GCP 凭证默认 TTL——1 小时，与典型 ADC token 有效期匹配 */
const DEFAULT_GCP_CREDENTIAL_TTL = 60 * 60 * 1000

/**
 * 运行 gcpAuthRefresh 执行交互式认证（如 gcloud auth application-default login）。
 * 实时流式输出，供用户查看。
 */
async function runGcpAuthRefresh(): Promise<boolean> {
  const gcpAuthRefresh = getConfiguredGcpAuthRefresh()

  if (!gcpAuthRefresh) {
    return false // 未配置，视为成功
  }

  // 安全检查：确认 gcpAuthRefresh 是否来自项目设置
  if (isGcpAuthRefreshFromProjectSettings()) {
    // 检查该项目是否已建立信任
    // 传 true 表示这是需要信任的危险功能
    const hasTrust = checkHasTrustDialogAccepted()
    if (!hasTrust && !getIsNonInteractiveSession()) {
      const error = new Error(
        `Security: gcpAuthRefresh executed before workspace trust is confirmed. If you see this message, post in ${MACRO.FEEDBACK_CHANNEL}.`,
      )
      logAntError('gcpAuthRefresh invoked before trust check', error)
      logEvent('tengu_gcpAuthRefresh_missing_trust', {})
      return false
    }
  }

  try {
    logForDebugging('检查 GCP 凭证有效性以决定是否刷新')
    const isValid = await checkGcpCredentialsValid()
    if (isValid) {
      logForDebugging('GCP 凭证有效，跳过 auth 刷新命令')
      return false
    }
  } catch {
    // 凭证检查失败，继续执行刷新
  }

  return refreshGcpAuth(gcpAuthRefresh)
}

// GCP auth 刷新命令超时时间（3 分钟）。
// 足够浏览器认证流程完成，同时避免无限挂起。
const GCP_AUTH_REFRESH_TIMEOUT_MS = 3 * 60 * 1000

export function refreshGcpAuth(gcpAuthRefresh: string): Promise<boolean> {
  logForDebugging('运行 GCP auth 刷新命令')
  // 开始跟踪认证状态。AwsAuthStatusManager 虽名称如此，但与云提供商无关——
  // print.ts 将其更新作为通用 SDK 'auth_status' 消息发出。
  const authStatusManager = AwsAuthStatusManager.getInstance()
  authStatusManager.startAuthentication()

  return new Promise(resolve => {
    const refreshProc = exec(gcpAuthRefresh, {
      timeout: GCP_AUTH_REFRESH_TIMEOUT_MS,
    })
    refreshProc.stdout!.on('data', data => {
      const output = data.toString().trim()
      if (output) {
        // 将输出添加到状态管理器供 UI 显示
        authStatusManager.addOutput(output)
        // 同时记录调试日志
        logForDebugging(output, { level: 'debug' })
      }
    })

    refreshProc.stderr!.on('data', data => {
      const error = data.toString().trim()
      if (error) {
        authStatusManager.setError(error)
        logForDebugging(error, { level: 'error' })
      }
    })

    refreshProc.on('close', (code, signal) => {
      if (code === 0) {
        logForDebugging('GCP auth 刷新成功完成')
        authStatusManager.endAuthentication(true)
        void resolve(true)
      } else {
        const timedOut = signal === 'SIGTERM'
        const message = timedOut
          ? chalk.red(
              'GCP auth refresh timed out after 3 minutes. Run your auth command manually in a separate terminal.',
            )
          : chalk.red(
              'Error running gcpAuthRefresh (in settings or ~/.hclaude.json):',
            )
        console.error(message)
        authStatusManager.endAuthentication(false)
        void resolve(false)
      }
    })
  })
}

/**
 * 如有必要，刷新 GCP 认证。
 * 此函数检查凭证是否有效，若无效则运行刷新命令。
 * 带 TTL 的 memoize，避免过度刷新。
 */
export const refreshGcpCredentialsIfNeeded = memoizeWithTTLAsync(
  async (): Promise<boolean> => {
    // 如有必要，执行 auth 刷新
    const refreshed = await runGcpAuthRefresh()
    return refreshed
  },
  DEFAULT_GCP_CREDENTIAL_TTL,
)

export function clearGcpCredentialsCache(): void {
  refreshGcpCredentialsIfNeeded.cache.clear()
}

/**
 * 仅在工作区信任已建立时预获取 GCP 凭证。
 * 允许对受信任的工作区提前启动可能较慢的 GCP 命令，
 * 同时对不受信任的工作区保持安全性。
 *
 * 返回 void 防止误用——实际刷新请使用 refreshGcpCredentialsIfNeeded()。
 */
export function prefetchGcpCredentialsIfSafe(): void {
  // 检查是否配置了 gcpAuthRefresh
  const gcpAuthRefresh = getConfiguredGcpAuthRefresh()

  if (!gcpAuthRefresh) {
    return
  }

  // 检查 gcpAuthRefresh 是否来自项目设置
  if (isGcpAuthRefreshFromProjectSettings()) {
    // 仅在信任已建立时预获取
    const hasTrust = checkHasTrustDialogAccepted()
    if (!hasTrust && !getIsNonInteractiveSession()) {
      // 不预获取——等待信任先建立
      return
    }
  }

  // 安全可预获取——要么不来自项目设置，要么信任已建立
  void refreshGcpCredentialsIfNeeded()
}

/**
 * 仅在工作区信任已建立时预获取 AWS 凭证。
 * 允许对受信任的工作区提前启动可能较慢的 AWS 命令，
 * 同时对不受信任的工作区保持安全性。
 *
 * 返回 void 防止误用——实际获取凭证请使用 refreshAndGetAwsCredentials()。
 */
export function prefetchAwsCredentialsAndBedRockInfoIfSafe(): void {
  // 检查是否配置了任一 AWS 命令
  const awsAuthRefresh = getConfiguredAwsAuthRefresh()
  const awsCredentialExport = getConfiguredAwsCredentialExport()

  if (!awsAuthRefresh && !awsCredentialExport) {
    return
  }

  // 检查任一命令是否来自项目设置
  if (
    isAwsAuthRefreshFromProjectSettings() ||
    isAwsCredentialExportFromProjectSettings()
  ) {
    // 仅在信任已建立时预获取
    const hasTrust = checkHasTrustDialogAccepted()
    if (!hasTrust && !getIsNonInteractiveSession()) {
      // 不预获取——等待信任先建立
      return
    }
  }

  // 安全可预获取——要么不来自项目设置，要么信任已建立
  void refreshAndGetAwsCredentials()
  getModelStrings()
}

/** @private 请使用 {@link getAnthropicApiKey} 或 {@link getAnthropicApiKeyWithSource} */
export const getApiKeyFromConfigOrMacOSKeychain = memoize(
  (): { key: string; source: ApiKeySource } | null => {
    if (isBareMode()) return null
    // TODO: 迁移到 SecureStorage
    if (process.platform === 'darwin') {
      // keychainPrefetch.ts 在 main.tsx 顶层与模块导入并行触发此读取。
      // 若已完成，直接使用结果而不是在此处启动同步 `security` 子进程（约 33ms）。
      const prefetch = getLegacyApiKeyPrefetchResult()
      if (prefetch) {
        if (prefetch.stdout) {
          return { key: prefetch.stdout, source: '/login managed key' }
        }
        // 预获取完成但无 key——穿透到配置，而非密钥链。
      } else {
        const storageServiceName = getMacOsKeychainStorageServiceName()
        try {
          const result = execSyncWithDefaults_DEPRECATED(
            `security find-generic-password -a $USER -w -s "${storageServiceName}"`,
          )
          if (result) {
            return { key: result, source: '/login managed key' }
          }
        } catch (e) {
          logError(e)
        }
      }
    }

    const config = getGlobalConfig()
    if (!config.primaryApiKey) {
      return null
    }

    return { key: config.primaryApiKey, source: '/login managed key' }
  },
)

function isValidApiKey(apiKey: string): boolean {
  // 只允许字母数字、连字符和下划线
  return /^[a-zA-Z0-9-_]+$/.test(apiKey)
}

export async function saveApiKey(apiKey: string): Promise<void> {
  if (!isValidApiKey(apiKey)) {
    throw new Error(
      'Invalid API key format. API key must contain only alphanumeric characters, dashes, and underscores.',
    )
  }

  // 保存为主 API key
  await maybeRemoveApiKeyFromMacOSKeychain()
  let savedToKeychain = false
  if (process.platform === 'darwin') {
    try {
      // TODO: 迁移到 SecureStorage
      const storageServiceName = getMacOsKeychainStorageServiceName()
      const username = getUsername()

      // 转为十六进制避免任何转义问题
      const hexValue = Buffer.from(apiKey, 'utf-8').toString('hex')

      // 使用 security 的交互模式（-i）配合 -X（十六进制）选项。
      // 确保凭证不出现在进程命令行参数中。
      // 进程监控器只能看到 "security -i"，看不到密码。
      const command = `add-generic-password -U -a "${username}" -s "${storageServiceName}" -X "${hexValue}"\n`

      await execa('security', ['-i'], {
        input: command,
        reject: false,
      })

      logEvent('tengu_api_key_saved_to_keychain', {})
      savedToKeychain = true
    } catch (e) {
      logError(e)
      logEvent('tengu_api_key_keychain_error', {
        error: errorMessage(
          e,
        ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      logEvent('tengu_api_key_saved_to_config', {})
    }
  } else {
    logEvent('tengu_api_key_saved_to_config', {})
  }

  const normalizedKey = normalizeApiKeyForConfig(apiKey)

  // 保存所有更新到配置
  saveGlobalConfig(current => {
    const approved = current.customApiKeyResponses?.approved ?? []
    return {
      ...current,
      // 仅在密钥链保存失败或非 darwin 平台时才保存到配置文件
      primaryApiKey: savedToKeychain ? current.primaryApiKey : apiKey,
      customApiKeyResponses: {
        ...current.customApiKeyResponses,
        approved: approved.includes(normalizedKey)
          ? approved
          : [...approved, normalizedKey],
        rejected: current.customApiKeyResponses?.rejected ?? [],
      },
    }
  })

  // 清除 memoize 缓存
  getApiKeyFromConfigOrMacOSKeychain.cache.clear?.()
  clearLegacyApiKeyPrefetch()
}

export function isCustomApiKeyApproved(apiKey: string): boolean {
  const config = getGlobalConfig()
  const normalizedKey = normalizeApiKeyForConfig(apiKey)
  return (
    config.customApiKeyResponses?.approved?.includes(normalizedKey) ?? false
  )
}

export async function removeApiKey(): Promise<void> {
  await maybeRemoveApiKeyFromMacOSKeychain()

  // 也从配置中删除，而不是提前返回——兼容在支持密钥链之前设置了 key 的旧客户端。
  saveGlobalConfig(current => ({
    ...current,
    primaryApiKey: undefined,
  }))

  // 清除 memoize 缓存
  getApiKeyFromConfigOrMacOSKeychain.cache.clear?.()
  clearLegacyApiKeyPrefetch()
}

async function maybeRemoveApiKeyFromMacOSKeychain(): Promise<void> {
  try {
    await maybeRemoveApiKeyFromMacOSKeychainThrows()
  } catch (e) {
    logError(e)
  }
}

// 将 OAuth token 存储到安全存储的函数
export function saveOAuthTokensIfNeeded(tokens: OAuthTokens): {
  success: boolean
  warning?: string
} {
  if (!shouldUseClaudeAIAuth(tokens.scopes)) {
    logEvent('tengu_oauth_tokens_not_claude_ai', {})
    return { success: true }
  }

  // 跳过仅推理 token 的保存（它们来自环境变量）
  if (!tokens.refreshToken || !tokens.expiresAt) {
    logEvent('tengu_oauth_tokens_inference_only', {})
    return { success: true }
  }

  const secureStorage = getSecureStorage()
  const storageBackend =
    secureStorage.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS

  try {
    const storageData = secureStorage.read() || {}
    const existingOauth = storageData.claudeAiOauth

    storageData.claudeAiOauth = {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scopes: tokens.scopes,
      // refreshOAuthToken 中的 profile 获取会吞掉错误，在瞬时失败（网络、
      // 5xx、限速）时返回 null。不要用 null 覆盖有效的已存订阅——
      // 回退到现有值。
      subscriptionType:
        tokens.subscriptionType ?? existingOauth?.subscriptionType ?? null,
      rateLimitTier:
        tokens.rateLimitTier ?? existingOauth?.rateLimitTier ?? null,
    }

    const updateStatus = secureStorage.update(storageData)

    if (updateStatus.success) {
      logEvent('tengu_oauth_tokens_saved', { storageBackend })
    } else {
      logEvent('tengu_oauth_tokens_save_failed', { storageBackend })
    }

    getClaudeAIOAuthTokens.cache?.clear?.()
    clearBetasCaches()
    clearToolSchemaCache()
    return updateStatus
  } catch (error) {
    logError(error)
    logEvent('tengu_oauth_tokens_save_exception', {
      storageBackend,
      error: errorMessage(
        error,
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return { success: false, warning: 'Failed to save OAuth tokens' }
  }
}

export const getClaudeAIOAuthTokens = memoize((): OAuthTokens | null => {
  // --bare 模式：仅 API key。不使用 OAuth 环境变量、密钥链或凭证文件。
  if (isBareMode()) return null

  // 检查环境变量中强制设置的 OAuth token
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    // 返回仅推理 token（refresh 和过期时间未知）
    return {
      accessToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
      refreshToken: null,
      expiresAt: null,
      scopes: ['user:inference'],
      subscriptionType: null,
      rateLimitTier: null,
    }
  }

  // 检查来自文件描述符的 OAuth token
  const oauthTokenFromFd = getOAuthTokenFromFileDescriptor()
  if (oauthTokenFromFd) {
    // 返回仅推理 token（refresh 和过期时间未知）
    return {
      accessToken: oauthTokenFromFd,
      refreshToken: null,
      expiresAt: null,
      scopes: ['user:inference'],
      subscriptionType: null,
      rateLimitTier: null,
    }
  }

  try {
    const secureStorage = getSecureStorage()
    const storageData = secureStorage.read()
    const oauthData = storageData?.claudeAiOauth

    if (!oauthData?.accessToken) {
      return null
    }

    return oauthData
  } catch (error) {
    logError(error)
    return null
  }
})

/**
 * 清除所有 OAuth token 缓存。在 401 错误时调用，确保下次读取
 * token 来自安全存储而非过期的内存缓存。
 * 处理本地过期检查与服务器不一致的情况（如 token 签发后的时钟校正）。
 */
export function clearOAuthTokenCache(): void {
  getClaudeAIOAuthTokens.cache?.clear?.()
  clearKeychainCache()
}

let lastCredentialsMtimeMs = 0

// 跨进程过期问题：另一个 CC 实例可能将新 token 写入磁盘（刷新或 /login），
// 但本进程的 memoize 永久缓存。若无此机制，终端 1 的 /login 修复终端 1；
// 终端 2 的 /login 在服务端吊销终端 1 的 token，而终端 1 的 memoize
// 永不重读——导致无限 /login 循环（CC-1096, GH#24317）。
async function invalidateOAuthCacheIfDiskChanged(): Promise<void> {
  try {
    const { mtimeMs } = await stat(
      join(getClaudeConfigHomeDir(), '.credentials.json'),
    )
    if (mtimeMs !== lastCredentialsMtimeMs) {
      lastCredentialsMtimeMs = mtimeMs
      clearOAuthTokenCache()
    }
  } catch {
    // ENOENT——macOS 密钥链路径（迁移时文件被删除）。只清除 memoize
    // 使其委托给密钥链缓存的 30s TTL，而不是在其上永久缓存。
    // `security find-generic-password` 约 15ms；密钥链缓存限制为每 30s 一次。
    getClaudeAIOAuthTokens.cache?.clear?.()
  }
}

// 飞行中去重：当 N 个 claude.ai 代理连接器同时以相同 token 收到 401 时
//（启动时常见——#20930），只有一个应清除缓存并重读密钥链。否则，每次调用的
// clearOAuthTokenCache() 都会销毁 macOsKeychainStorage 中的 readInFlight
// 并触发新的子进程——同步子进程堆叠导致 800ms+ 的渲染帧阻塞。
const pending401Handlers = new Map<string, Promise<boolean>>()

/**
 * 处理 API 返回的 401 "OAuth token 已过期" 错误。
 *
 * 当服务器表示 token 已过期时，此函数强制刷新 token，
 * 即使本地过期检查不同意（token 签发时的时钟问题可能导致此情况）。
 *
 * 安全性：将失败的 token 与密钥链中的 token 对比。若另一个标签页
 * 已刷新（密钥链中有不同 token），则使用该 token 而非再次刷新。
 * 使用相同 failedAccessToken 的并发调用被去重为单次密钥链读取。
 *
 * @param failedAccessToken - 被 401 拒绝的 access token
 * @returns 若现在拥有有效 token 则返回 true，否则返回 false
 */
export function handleOAuth401Error(
  failedAccessToken: string,
): Promise<boolean> {
  const pending = pending401Handlers.get(failedAccessToken)
  if (pending) return pending

  const promise = handleOAuth401ErrorImpl(failedAccessToken).finally(() => {
    pending401Handlers.delete(failedAccessToken)
  })
  pending401Handlers.set(failedAccessToken, promise)
  return promise
}

async function handleOAuth401ErrorImpl(
  failedAccessToken: string,
): Promise<boolean> {
  // 清除缓存并从密钥链重读（异步——同步读取每次阻塞约 100ms）
  clearOAuthTokenCache()
  const currentTokens = await getClaudeAIOAuthTokensAsync()

  if (!currentTokens?.refreshToken) {
    return false
  }

  // 若密钥链中有不同 token，说明另一个标签页已刷新——使用它
  if (currentTokens.accessToken !== failedAccessToken) {
    logEvent('tengu_oauth_401_recovered_from_keychain', {})
    return true
  }

  // 是同一个失败的 token——强制刷新，绕过本地过期检查
  return checkAndRefreshOAuthTokenIfNeeded(0, true)
}

/**
 * 异步读取 OAuth token，避免阻塞密钥链读取。
 * 对环境变量 / 文件描述符 token（不访问密钥链）委托给同步 memoize 版本，
 * 仅对存储读取使用异步。
 */
export async function getClaudeAIOAuthTokensAsync(): Promise<OAuthTokens | null> {
  if (isBareMode()) return null

  // 环境变量和 FD token 是同步的，不访问密钥链
  if (
    process.env.CLAUDE_CODE_OAUTH_TOKEN ||
    getOAuthTokenFromFileDescriptor()
  ) {
    return getClaudeAIOAuthTokens()
  }

  try {
    const secureStorage = getSecureStorage()
    const storageData = await secureStorage.readAsync()
    const oauthData = storageData?.claudeAiOauth
    if (!oauthData?.accessToken) {
      return null
    }
    return oauthData
  } catch (error) {
    logError(error)
    return null
  }
}

// 飞行中 promise，用于对并发调用去重
let pendingRefreshCheck: Promise<boolean> | null = null

export function checkAndRefreshOAuthTokenIfNeeded(
  retryCount = 0,
  force = false,
): Promise<boolean> {
  // 对并发的非重试、非强制调用去重
  if (retryCount === 0 && !force) {
    if (pendingRefreshCheck) {
      return pendingRefreshCheck
    }

    const promise = checkAndRefreshOAuthTokenIfNeededImpl(retryCount, force)
    pendingRefreshCheck = promise.finally(() => {
      pendingRefreshCheck = null
    })
    return pendingRefreshCheck
  }

  return checkAndRefreshOAuthTokenIfNeededImpl(retryCount, force)
}

async function checkAndRefreshOAuthTokenIfNeededImpl(
  retryCount: number,
  force: boolean,
): Promise<boolean> {
  const MAX_RETRIES = 5

  await invalidateOAuthCacheIfDiskChanged()

  // 先用缓存值检查 token 是否过期
  // 若 force=true 则跳过此检查（服务器已告知 token 无效）
  const tokens = getClaudeAIOAuthTokens()
  if (!force) {
    if (!tokens?.refreshToken || !isOAuthTokenExpired(tokens.expiresAt)) {
      return false
    }
  }

  if (!tokens?.refreshToken) {
    return false
  }

  if (!shouldUseClaudeAIAuth(tokens.scopes)) {
    return false
  }

  // 异步重读 token 检查是否仍然过期
  // 另一个进程可能已经刷新了它们
  getClaudeAIOAuthTokens.cache?.clear?.()
  clearKeychainCache()
  const freshTokens = await getClaudeAIOAuthTokensAsync()
  if (
    !freshTokens?.refreshToken ||
    !isOAuthTokenExpired(freshTokens.expiresAt)
  ) {
    return false
  }

  // Token 仍然过期，尝试获取锁并刷新
  const claudeDir = getClaudeConfigHomeDir()
  await mkdir(claudeDir, { recursive: true })

  let release
  try {
    logEvent('tengu_oauth_token_refresh_lock_acquiring', {})
    release = await lockfile.lock(claudeDir)
    logEvent('tengu_oauth_token_refresh_lock_acquired', {})
  } catch (err) {
    if ((err as { code?: string }).code === 'ELOCKED') {
      // 另一个进程持有锁，若未超过最大重试次数则重试
      if (retryCount < MAX_RETRIES) {
        logEvent('tengu_oauth_token_refresh_lock_retry', {
          retryCount: retryCount + 1,
        })
        // 稍等后重试
        await sleep(1000 + Math.random() * 1000)
        return checkAndRefreshOAuthTokenIfNeededImpl(retryCount + 1, force)
      }
      logEvent('tengu_oauth_token_refresh_lock_retry_limit_reached', {
        maxRetries: MAX_RETRIES,
      })
      return false
    }
    logError(err)
    logEvent('tengu_oauth_token_refresh_lock_error', {
      error: errorMessage(
        err,
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return false
  }
  try {
    // 获取锁后再检查一次
    getClaudeAIOAuthTokens.cache?.clear?.()
    clearKeychainCache()
    const lockedTokens = await getClaudeAIOAuthTokensAsync()
    if (
      !lockedTokens?.refreshToken ||
      !isOAuthTokenExpired(lockedTokens.expiresAt)
    ) {
      logEvent('tengu_oauth_token_refresh_race_resolved', {})
      return false
    }

    logEvent('tengu_oauth_token_refresh_starting', {})
    const refreshedTokens = await refreshOAuthToken(lockedTokens.refreshToken, {
      // 对 Claude.ai 订阅用户，省略 scopes 使默认 CLAUDE_AI_OAUTH_SCOPES 生效——
      // 允许在刷新时扩展 scope（如添加 user:file_upload）而无需重新登录。
      scopes: shouldUseClaudeAIAuth(lockedTokens.scopes)
        ? undefined
        : lockedTokens.scopes,
    })
    saveOAuthTokensIfNeeded(refreshedTokens)

    // 刷新 token 后清除缓存
    getClaudeAIOAuthTokens.cache?.clear?.()
    clearKeychainCache()
    return true
  } catch (error) {
    logError(error)

    getClaudeAIOAuthTokens.cache?.clear?.()
    clearKeychainCache()
    const currentTokens = await getClaudeAIOAuthTokensAsync()
    if (currentTokens && !isOAuthTokenExpired(currentTokens.expiresAt)) {
      logEvent('tengu_oauth_token_refresh_race_recovered', {})
      return true
    }

    return false
  } finally {
    logEvent('tengu_oauth_token_refresh_lock_releasing', {})
    await release()
    logEvent('tengu_oauth_token_refresh_lock_released', {})
  }
}

export function isClaudeAISubscriber(): boolean {
  if (!isAnthropicAuthEnabled()) {
    return false
  }

  return shouldUseClaudeAIAuth(getClaudeAIOAuthTokens()?.scopes)
}

/**
 * 检查当前 OAuth token 是否包含 user:profile scope。
 *
 * 真实的 /login token 始终包含此 scope。环境变量和文件描述符 token
 * （服务 key）将 scopes 硬编码为仅 ['user:inference']。
 * 使用此函数对 profile 范围的接口调用设门控，防止服务 key 会话
 * 对 /api/oauth/profile、bootstrap 等产生 403 风暴。
 */
export function hasProfileScope(): boolean {
  return (
    getClaudeAIOAuthTokens()?.scopes?.includes(CLAUDE_AI_PROFILE_SCOPE) ?? false
  )
}

export function is1PApiCustomer(): boolean {
  // 1P API 客户是指不属于以下类别的用户：
  // 1. Claude.ai 订阅用户（Max、Pro、Enterprise、Team）
  // 2. Vertex AI 用户
  // 3. AWS Bedrock 用户
  // 4. Foundry 用户

  // 排除 Vertex、Bedrock 和 Foundry 客户
  if (
    isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)
  ) {
    return false
  }

  // 排除 Claude.ai 订阅用户
  if (isClaudeAISubscriber()) {
    return false
  }

  // 其他所有人均为 API 客户（OAuth API 客户、直接 API key 用户等）
  return true
}

/**
 * 在 Anthropic 鉴权启用时获取 OAuth 账户信息。
 * 使用外部 API key 或第三方服务时返回 undefined。
 */
export function getOauthAccountInfo(): AccountInfo | undefined {
  return isAnthropicAuthEnabled() ? getGlobalConfig().oauthAccount : undefined
}

/**
 * 检查该组织是否允许超额/额外用量配额。
 * 尽量镜像 apps/claude-ai 中 `useIsOverageProvisioningAllowed` hook 的逻辑。
 */
export function isOverageProvisioningAllowed(): boolean {
  const accountInfo = getOauthAccountInfo()
  const billingType = accountInfo?.billingType

  // Must be a Claude subscriber with a supported subscription type
  if (!isClaudeAISubscriber() || !billingType) {
    return false
  }

  // 只允许 Stripe 和移动端计费类型购买额外用量
  if (
    billingType !== 'stripe_subscription' &&
    billingType !== 'stripe_subscription_contracted' &&
    billingType !== 'apple_subscription' &&
    billingType !== 'google_play_subscription'
  ) {
    return false
  }

  return true
}

// 返回用户是否拥有 Opus 访问权限，无论是订阅用户还是按量付费用户。
export function hasOpusAccess(): boolean {
  const subscriptionType = getSubscriptionType()

  return (
    subscriptionType === 'max' ||
    subscriptionType === 'enterprise' ||
    subscriptionType === 'team' ||
    subscriptionType === 'pro' ||
    // subscriptionType === null 涵盖 API 用户以及订阅类型未填充的订阅用户。
    // 对于这些订阅用户，有疑问时不应限制其 Opus 访问。
    subscriptionType === null
  )
}

export function getSubscriptionType(): SubscriptionType | null {
  // 优先检查模拟订阅类型（仅 ANT 内部测试用）
  if (shouldUseMockSubscription()) {
    return getMockSubscriptionType()
  }

  if (!isAnthropicAuthEnabled()) {
    return null
  }
  const oauthTokens = getClaudeAIOAuthTokens()
  if (!oauthTokens) {
    return null
  }

  return oauthTokens.subscriptionType ?? null
}

export function isMaxSubscriber(): boolean {
  return getSubscriptionType() === 'max'
}

export function isTeamSubscriber(): boolean {
  return getSubscriptionType() === 'team'
}

export function isTeamPremiumSubscriber(): boolean {
  return (
    getSubscriptionType() === 'team' &&
    getRateLimitTier() === 'default_claude_max_5x'
  )
}

export function isEnterpriseSubscriber(): boolean {
  return getSubscriptionType() === 'enterprise'
}

export function isProSubscriber(): boolean {
  return getSubscriptionType() === 'pro'
}

export function getRateLimitTier(): string | null {
  if (!isAnthropicAuthEnabled()) {
    return null
  }
  const oauthTokens = getClaudeAIOAuthTokens()
  if (!oauthTokens) {
    return null
  }

  return oauthTokens.rateLimitTier ?? null
}

export function getSubscriptionName(): string {
  const subscriptionType = getSubscriptionType()

  switch (subscriptionType) {
    case 'enterprise':
      return 'Claude Enterprise'
    case 'team':
      return 'Claude Team'
    case 'max':
      return 'Claude Max'
    case 'pro':
      return 'Claude Pro'
    default:
      return 'Claude API'
  }
}

/**
 * 检查是否正在使用第三方服务（非 Anthropic provider）。
 *
 * 此函数为以下仅适用于非直连 Anthropic 官方 API 场景的行为设置门控：
 *  - 鉴权状态显示（authStatus handler）
 *  - 命令可见性（非 3P 时显示 login/logout）
 *  - 命令可用性检查（meetsAvailabilityRequirement）
 *
 * 需与 providers.ts 保持同步——每当 getAPIProvider() 中新增
 * CLAUDE_CODE_USE_* 环境变量时，此处必须同步添加对应检查。
 * 仅通过 settings.modelType 控制（而非环境变量）的 provider 不在此函数覆盖范围内，
 * 可能需要在上方调用方单独处理。
 */
export function isUsing3PServices(): boolean {
  return !!(
    isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_OPENAI) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_GEMINI) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_GROK)
  )
}

/**
 * 从设置中获取已配置的 otelHeadersHelper
 */
function getConfiguredOtelHeadersHelper(): string | undefined {
  const mergedSettings = getSettings_DEPRECATED() || {}
  return mergedSettings.otelHeadersHelper
}

/**
 * 检查已配置的 otelHeadersHelper 是否来自项目设置（projectSettings 或 localSettings）
 */
export function isOtelHeadersHelperFromProjectOrLocalSettings(): boolean {
  const otelHeadersHelper = getConfiguredOtelHeadersHelper()
  if (!otelHeadersHelper) {
    return false
  }

  const projectSettings = getSettingsForSource('projectSettings')
  const localSettings = getSettingsForSource('localSettings')
  return (
    projectSettings?.otelHeadersHelper === otelHeadersHelper ||
    localSettings?.otelHeadersHelper === otelHeadersHelper
  )
}

// otelHeadersHelper 调用防抖缓存
let cachedOtelHeaders: Record<string, string> | null = null
let cachedOtelHeadersTimestamp = 0
const DEFAULT_OTEL_HEADERS_DEBOUNCE_MS = 29 * 60 * 1000 // 29 分钟

export function getOtelHeadersFromHelper(): Record<string, string> {
  const otelHeadersHelper = getConfiguredOtelHeadersHelper()

  if (!otelHeadersHelper) {
    return {}
  }

  // 若缓存仍有效则返回（防抖）
  const debounceMs = parseInt(
    process.env.CLAUDE_CODE_OTEL_HEADERS_HELPER_DEBOUNCE_MS ||
      DEFAULT_OTEL_HEADERS_DEBOUNCE_MS.toString(),
    10,
  )
  if (
    cachedOtelHeaders &&
    Date.now() - cachedOtelHeadersTimestamp < debounceMs
  ) {
    return cachedOtelHeaders
  }

  if (isOtelHeadersHelperFromProjectOrLocalSettings()) {
    // Check if trust has been established for this project
    const hasTrust = checkHasTrustDialogAccepted()
    if (!hasTrust) {
      return {}
    }
  }

  try {
    const result = execSyncWithDefaults_DEPRECATED(otelHeadersHelper, {
      timeout: 30000, // 30 秒——允许认证服务延迟
    })
      ?.toString()
      .trim()
    if (!result) {
      throw new Error('otelHeadersHelper did not return a valid value')
    }

    const headers = jsonParse(result)
    if (
      typeof headers !== 'object' ||
      headers === null ||
      Array.isArray(headers)
    ) {
      throw new Error(
        'otelHeadersHelper must return a JSON object with string key-value pairs',
      )
    }

    // Validate all values are strings
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value !== 'string') {
        throw new Error(
          `otelHeadersHelper returned non-string value for key "${key}": ${typeof value}`,
        )
      }
    }

    // 缓存结果
    cachedOtelHeaders = headers as Record<string, string>
    cachedOtelHeadersTimestamp = Date.now()

    return cachedOtelHeaders
  } catch (error) {
    logError(
      new Error(
        `Error getting OpenTelemetry headers from otelHeadersHelper (in settings): ${errorMessage(error)}`,
      ),
    )
    throw error
  }
}

function isConsumerPlan(plan: SubscriptionType): plan is 'max' | 'pro' {
  return plan === 'max' || plan === 'pro'
}

export function isConsumerSubscriber(): boolean {
  const subscriptionType = getSubscriptionType()
  return (
    isClaudeAISubscriber() &&
    subscriptionType !== null &&
    isConsumerPlan(subscriptionType)
  )
}

export type UserAccountInfo = {
  subscription?: string
  tokenSource?: string
  apiKeySource?: ApiKeySource
  organization?: string
  email?: string
}

export function getAccountInformation() {
  const apiProvider = getAPIProvider()
  // 仅为 Anthropic 官方 API 提供账户信息
  if (apiProvider !== 'firstParty') {
    return undefined
  }
  const { source: authTokenSource } = getAuthTokenSource()
  const accountInfo: UserAccountInfo = {}
  if (
    authTokenSource === 'CLAUDE_CODE_OAUTH_TOKEN' ||
    authTokenSource === 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR'
  ) {
    accountInfo.tokenSource = authTokenSource
  } else if (isClaudeAISubscriber()) {
    accountInfo.subscription = getSubscriptionName()
  } else {
    accountInfo.tokenSource = authTokenSource
  }
  const { key: apiKey, source: apiKeySource } = getAnthropicApiKeyWithSource()
  if (apiKey) {
    accountInfo.apiKeySource = apiKeySource
  }

  // 如果我们依赖外部 API 密钥或认证令牌，则不知道组织
  if (
    authTokenSource === 'claude.ai' ||
    apiKeySource === '/login managed key'
  ) {
    // 从 OAuth 账户信息获取组织名称
    const orgName = getOauthAccountInfo()?.organizationName
    if (orgName) {
      accountInfo.organization = orgName
    }
  }
  const email = getOauthAccountInfo()?.emailAddress
  if (
    (authTokenSource === 'claude.ai' ||
      apiKeySource === '/login managed key') &&
    email
  ) {
    accountInfo.email = email
  }
  return accountInfo
}

/**
 * 组织验证结果——成功或带描述的错误。
 */
export type OrgValidationResult =
  | { valid: true }
  | { valid: false; message: string }

/**
 * 验证当前 OAuth token 是否属于托管设置中 `forceLoginOrgUUID` 要求的组织。
 * 返回结果对象而非抛出异常，让调用方决定如何呈现错误。
 *
 * 失败关闭：若 `forceLoginOrgUUID` 已设置但无法确定 token 的组织
 * （网络错误、缺少 profile 数据），验证失败。
 */
export async function validateForceLoginOrg(): Promise<OrgValidationResult> {
  // `claude ssh` 远程模式：真实鉴权在本地机器上，由代理注入。
  // 占位符 token 无法在 profile 接口验证。本地侧已在建立会话前完成此检查。
  if (process.env.ANTHROPIC_UNIX_SOCKET) {
    return { valid: true }
  }

  if (!isAnthropicAuthEnabled()) {
    return { valid: true }
  }

  const requiredOrgUuid =
    getSettingsForSource('policySettings')?.forceLoginOrgUUID
  if (!requiredOrgUuid) {
    return { valid: true }
  }

  // 访问 profile 接口前确保 access token 是新鲜的。
  // 对环境变量 token 无操作（refreshToken 为 null）。
  await checkAndRefreshOAuthTokenIfNeeded()

  const tokens = getClaudeAIOAuthTokens()
  if (!tokens) {
    return { valid: true }
  }

  // 始终从 profile 接口获取权威组织 UUID。
  // 即使是密钥链来源的 token 也需要服务端验证：
  // ~/.hclaude.json 中缓存的组织 UUID 可被用户修改，不可信任。
  const { source } = getAuthTokenSource()
  const isEnvVarToken =
    source === 'CLAUDE_CODE_OAUTH_TOKEN' ||
    source === 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR'

  const profile = await getOauthProfileFromOauthToken(tokens.accessToken)
  if (!profile) {
    // Fail closed — we can't verify the org
    return {
      valid: false,
      message:
        `Unable to verify organization for the current authentication token.\n` +
        `This machine requires organization ${requiredOrgUuid} but the profile could not be fetched.\n` +
        `This may be a network error, or the token may lack the user:profile scope required for\n` +
        `verification (tokens from 'claude setup-token' do not include this scope).\n` +
        `Try again, or obtain a full-scope token via 'claude auth login'.`,
    }
  }

  const tokenOrgUuid = profile.organization.uuid
  if (tokenOrgUuid === requiredOrgUuid) {
    return { valid: true }
  }

  if (isEnvVarToken) {
    const envVarName =
      source === 'CLAUDE_CODE_OAUTH_TOKEN'
        ? 'CLAUDE_CODE_OAUTH_TOKEN'
        : 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR'
    return {
      valid: false,
      message:
        `The ${envVarName} environment variable provides a token for a\n` +
        `different organization than required by this machine's managed settings.\n\n` +
        `Required organization: ${requiredOrgUuid}\n` +
        `Token organization:   ${tokenOrgUuid}\n\n` +
        `Remove the environment variable or obtain a token for the correct organization.`,
    }
  }

  return {
    valid: false,
    message:
      `Your authentication token belongs to organization ${tokenOrgUuid},\n` +
      `but this machine requires organization ${requiredOrgUuid}.\n\n` +
      `Please log in with the correct organization: claude auth login`,
  }
}

class GcpCredentialsTimeoutError extends Error {}
