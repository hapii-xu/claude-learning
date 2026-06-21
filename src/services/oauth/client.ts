// 用于处理 Claude 服务认证流程的 OAuth 客户端
import axios from 'axios'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import {
  ALL_OAUTH_SCOPES,
  CLAUDE_AI_INFERENCE_SCOPE,
  CLAUDE_AI_OAUTH_SCOPES,
  getOauthConfig,
} from '../../constants/oauth.js'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getClaudeAIOAuthTokens,
  hasProfileScope,
  isClaudeAISubscriber,
  saveApiKey,
} from '../../utils/auth.js'
import type { AccountInfo } from '../../utils/config.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { getOauthProfileFromOauthToken } from './getOauthProfile.js'
import type {
  BillingType,
  OAuthProfileResponse,
  OAuthTokenExchangeResponse,
  OAuthTokens,
  RateLimitTier,
  SubscriptionType,
  UserRolesResponse,
} from './types.js'

/**
 * 检查用户是否具有 Claude.ai 认证范围
 * @private 仅在你处于 OAuth/认证相关代码时调用！
 */
export function shouldUseClaudeAIAuth(scopes: string[] | undefined): boolean {
  return Boolean(scopes?.includes(CLAUDE_AI_INFERENCE_SCOPE))
}

export function parseScopes(scopeString?: string): string[] {
  return scopeString?.split(' ').filter(Boolean) ?? []
}

export function buildAuthUrl({
  codeChallenge,
  state,
  port,
  isManual,
  loginWithClaudeAi,
  inferenceOnly,
  orgUUID,
  loginHint,
  loginMethod,
}: {
  codeChallenge: string
  state: string
  port: number
  isManual: boolean
  loginWithClaudeAi?: boolean
  inferenceOnly?: boolean
  orgUUID?: string
  loginHint?: string
  loginMethod?: string
}): string {
  const authUrlBase = loginWithClaudeAi
    ? getOauthConfig().CLAUDE_AI_AUTHORIZE_URL
    : getOauthConfig().CONSOLE_AUTHORIZE_URL

  const authUrl = new URL(authUrlBase)
  authUrl.searchParams.append('code', 'true') // 这告诉登录页面显示 Claude Max 升级推荐
  authUrl.searchParams.append('client_id', getOauthConfig().CLIENT_ID)
  authUrl.searchParams.append('response_type', 'code')
  authUrl.searchParams.append(
    'redirect_uri',
    isManual
      ? getOauthConfig().MANUAL_REDIRECT_URL
      : `http://localhost:${port}/callback`,
  )
  const scopesToUse = inferenceOnly
    ? [CLAUDE_AI_INFERENCE_SCOPE] // 长期仅推理令牌
    : ALL_OAUTH_SCOPES
  authUrl.searchParams.append('scope', scopesToUse.join(' '))
  authUrl.searchParams.append('code_challenge', codeChallenge)
  authUrl.searchParams.append('code_challenge_method', 'S256')
  authUrl.searchParams.append('state', state)

  // 如果提供了 orgUUID，将其添加为 URL 参数
  if (orgUUID) {
    authUrl.searchParams.append('orgUUID', orgUUID)
  }

  // 在登录表单上预填充邮箱（标准 OIDC 参数）
  if (loginHint) {
    authUrl.searchParams.append('login_hint', loginHint)
  }

  // 请求特定的登录方法（例如 'sso'、'magic_link'、'google'）
  if (loginMethod) {
    authUrl.searchParams.append('login_method', loginMethod)
  }

  return authUrl.toString()
}

export async function exchangeCodeForTokens(
  authorizationCode: string,
  state: string,
  codeVerifier: string,
  port: number,
  useManualRedirect: boolean = false,
  expiresIn?: number,
): Promise<OAuthTokenExchangeResponse> {
  const requestBody: Record<string, string | number> = {
    grant_type: 'authorization_code',
    code: authorizationCode,
    redirect_uri: useManualRedirect
      ? getOauthConfig().MANUAL_REDIRECT_URL
      : `http://localhost:${port}/callback`,
    client_id: getOauthConfig().CLIENT_ID,
    code_verifier: codeVerifier,
    state,
  }

  if (expiresIn !== undefined) {
    requestBody.expires_in = expiresIn
  }

  const response = await axios.post(getOauthConfig().TOKEN_URL, requestBody, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000,
  })

  if (response.status !== 200) {
    throw new Error(
      response.status === 401
        ? 'Authentication failed: Invalid authorization code'
        : `Token exchange failed (${response.status}): ${response.statusText}`,
    )
  }
  logEvent('tengu_oauth_token_exchange_success', {})
  return response.data
}

export async function refreshOAuthToken(
  refreshToken: string,
  { scopes: requestedScopes }: { scopes?: string[] } = {},
): Promise<OAuthTokens> {
  const requestBody = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: getOauthConfig().CLIENT_ID,
    // 请求特定范围，默认为完整的 Claude AI 集合。
    // 后端的 refresh-token 授权允许范围扩展超出初始 authorize
    // 授予的范围（见 ALLOWED_SCOPE_EXPANSIONS），因此即使对于在范围添加到应用
    // 注册 oauth_scope 之前颁发的令牌也是安全的。
    scope: (requestedScopes?.length
      ? requestedScopes
      : CLAUDE_AI_OAUTH_SCOPES
    ).join(' '),
  }

  try {
    const response = await axios.post(getOauthConfig().TOKEN_URL, requestBody, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    })

    if (response.status !== 200) {
      throw new Error(`Token refresh failed: ${response.statusText}`)
    }

    const data = response.data as OAuthTokenExchangeResponse
    const {
      access_token: accessToken,
      refresh_token: newRefreshToken = refreshToken,
      expires_in: expiresIn,
    } = data

    const expiresAt = Date.now() + expiresIn * 1000
    const scopes = parseScopes(data.scope)

    logEvent('tengu_oauth_token_refresh_success', {})

    // 当我们同时拥有 global-config 的 profile 字段和安全存储的订阅数据时，
    // 跳过额外的 /api/oauth/profile 往返。常规刷新满足两者，
    // 因此我们整个集群每天减少约 7M 次请求。
    //
    // 检查安全存储（不仅仅是 config）对
    // CLAUDE_CODE_OAUTH_REFRESH_TOKEN 重新登录路径很重要：installOAuthTokens
    // 在我们返回后运行 performLogout()，清除安全存储。如果这里
    // 对 subscriptionType 返回 null，saveOAuthTokensIfNeeded 会持久化
    // null ?? (已清除) ?? null = null，并且未来每次刷新都会看到
    // config 守卫字段已满足并再次跳过，永久丢失付费用户的
    // 订阅类型。通过传递现有值，
    // 重新登录路径写入 cached ?? 已清除 ?? null = cached；如果安全
    // 存储已经为空，我们回退到 fetch。
    const config = getGlobalConfig()
    const existing = getClaudeAIOAuthTokens()
    const haveProfileAlready =
      config.oauthAccount?.billingType !== undefined &&
      config.oauthAccount?.accountCreatedAt !== undefined &&
      config.oauthAccount?.subscriptionCreatedAt !== undefined &&
      existing?.subscriptionType != null &&
      existing?.rateLimitTier != null

    const profileInfo = haveProfileAlready
      ? null
      : await fetchProfileInfo(accessToken)

    // 如果存储的属性已更改，则更新
    if (profileInfo && config.oauthAccount) {
      const updates: Partial<AccountInfo> = {}
      if (profileInfo.displayName !== undefined) {
        updates.displayName = profileInfo.displayName
      }
      if (typeof profileInfo.hasExtraUsageEnabled === 'boolean') {
        updates.hasExtraUsageEnabled = profileInfo.hasExtraUsageEnabled
      }
      if (profileInfo.billingType !== null) {
        updates.billingType = profileInfo.billingType
      }
      if (profileInfo.accountCreatedAt !== undefined) {
        updates.accountCreatedAt = profileInfo.accountCreatedAt
      }
      if (profileInfo.subscriptionCreatedAt !== undefined) {
        updates.subscriptionCreatedAt = profileInfo.subscriptionCreatedAt
      }
      if (Object.keys(updates).length > 0) {
        saveGlobalConfig(current => ({
          ...current,
          oauthAccount: current.oauthAccount
            ? { ...current.oauthAccount, ...updates }
            : current.oauthAccount,
        }))
      }
    }

    return {
      accessToken,
      refreshToken: newRefreshToken,
      expiresAt,
      scopes,
      subscriptionType:
        profileInfo?.subscriptionType ?? existing?.subscriptionType ?? null,
      rateLimitTier:
        profileInfo?.rateLimitTier ?? existing?.rateLimitTier ?? null,
      profile: profileInfo?.rawProfile,
      tokenAccount: data.account
        ? {
            uuid: data.account.uuid,
            emailAddress: data.account.email_address,
            organizationUuid: data.organization?.uuid,
          }
        : undefined,
    }
  } catch (error) {
    const responseBody =
      axios.isAxiosError(error) && error.response?.data
        ? JSON.stringify(error.response.data)
        : undefined
    logEvent('tengu_oauth_token_refresh_failure', {
      error: (error as Error)
        .message as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...(responseBody && {
        responseBody:
          responseBody as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
    })
    throw error
  }
}

export async function fetchAndStoreUserRoles(
  accessToken: string,
): Promise<void> {
  const response = await axios.get(getOauthConfig().ROLES_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  if (response.status !== 200) {
    throw new Error(`Failed to fetch user roles: ${response.statusText}`)
  }
  const data = response.data as UserRolesResponse
  const config = getGlobalConfig()

  if (!config.oauthAccount) {
    throw new Error('OAuth account information not found in config')
  }

  saveGlobalConfig(current => ({
    ...current,
    oauthAccount: current.oauthAccount
      ? {
          ...current.oauthAccount,
          organizationRole: data.organization_role,
          workspaceRole: data.workspace_role,
          organizationName: data.organization_name,
        }
      : current.oauthAccount,
  }))

  logEvent('tengu_oauth_roles_stored', {
    org_role:
      data.organization_role as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
}

export async function createAndStoreApiKey(
  accessToken: string,
): Promise<string | null> {
  try {
    const response = await axios.post(getOauthConfig().API_KEY_URL, null, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })

    const apiKey = response.data?.raw_key
    if (apiKey) {
      await saveApiKey(apiKey)
      logEvent('tengu_oauth_api_key', {
        status:
          'success' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        statusCode: response.status,
      })
      return apiKey
    }
    return null
  } catch (error) {
    logEvent('tengu_oauth_api_key', {
      status:
        'failure' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      error: (error instanceof Error
        ? error.message
        : String(
            error,
          )) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    throw error
  }
}

export function isOAuthTokenExpired(expiresAt: number | null): boolean {
  if (expiresAt === null) {
    return false
  }

  const bufferTime = 5 * 60 * 1000
  const now = Date.now()
  const expiresWithBuffer = now + bufferTime
  return expiresWithBuffer >= expiresAt
}

export async function fetchProfileInfo(accessToken: string): Promise<{
  subscriptionType: SubscriptionType | null
  displayName?: string
  rateLimitTier: RateLimitTier | null
  hasExtraUsageEnabled: boolean | null
  billingType: BillingType | null
  accountCreatedAt?: string
  subscriptionCreatedAt?: string
  rawProfile?: OAuthProfileResponse
}> {
  const profile = await getOauthProfileFromOauthToken(accessToken)
  const orgType = profile?.organization?.organization_type

  // 复用 fetchSubscriptionType 的逻辑
  let subscriptionType: SubscriptionType | null = null
  switch (orgType) {
    case 'claude_max':
      subscriptionType = 'max'
      break
    case 'claude_pro':
      subscriptionType = 'pro'
      break
    case 'claude_enterprise':
      subscriptionType = 'enterprise'
      break
    case 'claude_team':
      subscriptionType = 'team'
      break
    default:
      // 对未知组织类型返回 null
      subscriptionType = null
      break
  }

  const result: {
    subscriptionType: SubscriptionType | null
    displayName?: string
    rateLimitTier: RateLimitTier | null
    hasExtraUsageEnabled: boolean | null
    billingType: BillingType | null
    accountCreatedAt?: string
    subscriptionCreatedAt?: string
  } = {
    subscriptionType,
    rateLimitTier: profile?.organization?.rate_limit_tier ?? null,
    hasExtraUsageEnabled:
      profile?.organization?.has_extra_usage_enabled ?? null,
    billingType: profile?.organization?.billing_type ?? null,
  }

  if (profile?.account?.display_name) {
    result.displayName = profile.account.display_name
  }

  if (profile?.account?.created_at) {
    result.accountCreatedAt = profile.account.created_at
  }

  if (profile?.organization?.subscription_created_at) {
    result.subscriptionCreatedAt = profile.organization.subscription_created_at
  }

  logEvent('tengu_oauth_profile_fetch_success', {})

  return { ...result, rawProfile: profile }
}

/**
 * 从 OAuth 访问令牌获取组织 UUID
 * @returns 组织 UUID，如果未认证则返回 null
 */
export async function getOrganizationUUID(): Promise<string | null> {
  // 先检查全局配置以避免不必要的 API 调用
  const globalConfig = getGlobalConfig()
  const orgUUID = globalConfig.oauthAccount?.organizationUuid
  if (orgUUID) {
    return orgUUID
  }

  // 回退到从 profile 获取（需要 user:profile 范围）
  const accessToken = getClaudeAIOAuthTokens()?.accessToken
  if (accessToken === undefined || !hasProfileScope()) {
    return null
  }
  const profile = await getOauthProfileFromOauthToken(accessToken)
  const profileOrgUUID = profile?.organization?.uuid
  if (!profileOrgUUID) {
    return null
  }
  return profileOrgUUID
}

/**
 * 如果 OAuth 账户信息尚未缓存到 config，则填充它。
 * @returns 是否填充了 oauth 账户信息。
 */
export async function populateOAuthAccountInfoIfNeeded(): Promise<boolean> {
  // 先检查环境变量（同步，无需网络调用）。
  // 像 Cowork 这样的 SDK 调用者可以直接提供账户信息，这也
  // 消除了早期遥测事件缺少账户信息的竞态条件。
  // 注意：如果/当添加需要_其他_ OAuth 账户属性的额外 SDK 相关功能时，
  // 请联系 #proj-cowork 以便团队可以添加额外的环境变量回退。
  const envAccountUuid = process.env.CLAUDE_CODE_ACCOUNT_UUID
  const envUserEmail = process.env.CLAUDE_CODE_USER_EMAIL
  const envOrganizationUuid = process.env.CLAUDE_CODE_ORGANIZATION_UUID
  const hasEnvVars = Boolean(
    envAccountUuid && envUserEmail && envOrganizationUuid,
  )
  if (envAccountUuid && envUserEmail && envOrganizationUuid) {
    if (!getGlobalConfig().oauthAccount) {
      storeOAuthAccountInfo({
        accountUuid: envAccountUuid,
        emailAddress: envUserEmail,
        organizationUuid: envOrganizationUuid,
      })
    }
  }

  // 先等待任何进行中的令牌刷新完成，因为
  // refreshOAuthToken 已经获取并存储了 profile 信息
  await checkAndRefreshOAuthTokenIfNeeded()

  const config = getGlobalConfig()
  if (
    (config.oauthAccount &&
      config.oauthAccount.billingType !== undefined &&
      config.oauthAccount.accountCreatedAt !== undefined &&
      config.oauthAccount.subscriptionCreatedAt !== undefined) ||
    !isClaudeAISubscriber() ||
    !hasProfileScope()
  ) {
    return false
  }

  const tokens = getClaudeAIOAuthTokens()
  if (tokens?.accessToken) {
    const profile = await getOauthProfileFromOauthToken(tokens.accessToken)
    if (profile) {
      if (hasEnvVars) {
        logForDebugging(
          'OAuth profile fetch succeeded, overriding env var account info',
          { level: 'info' },
        )
      }
      storeOAuthAccountInfo({
        accountUuid: profile.account.uuid,
        emailAddress: profile.account.email,
        organizationUuid: profile.organization.uuid,
        displayName: profile.account.display_name || undefined,
        hasExtraUsageEnabled:
          profile.organization.has_extra_usage_enabled ?? false,
        billingType: profile.organization.billing_type ?? undefined,
        accountCreatedAt: profile.account.created_at,
        subscriptionCreatedAt:
          profile.organization.subscription_created_at ?? undefined,
      })
      return true
    }
  }
  return false
}

export function storeOAuthAccountInfo({
  accountUuid,
  emailAddress,
  organizationUuid,
  displayName,
  hasExtraUsageEnabled,
  billingType,
  accountCreatedAt,
  subscriptionCreatedAt,
}: {
  accountUuid: string
  emailAddress: string
  organizationUuid: string | undefined
  displayName?: string
  hasExtraUsageEnabled?: boolean
  billingType?: BillingType
  accountCreatedAt?: string
  subscriptionCreatedAt?: string
}): void {
  const accountInfo: AccountInfo = {
    accountUuid,
    emailAddress,
    organizationUuid,
    hasExtraUsageEnabled,
    billingType,
    accountCreatedAt,
    subscriptionCreatedAt,
  }
  if (displayName) {
    accountInfo.displayName = displayName
  }
  saveGlobalConfig(current => {
    // 对于 oauthAccount，我们需要比较内容，因为它是一个对象
    if (
      current.oauthAccount?.accountUuid === accountInfo.accountUuid &&
      current.oauthAccount?.emailAddress === accountInfo.emailAddress &&
      current.oauthAccount?.organizationUuid === accountInfo.organizationUuid &&
      current.oauthAccount?.displayName === accountInfo.displayName &&
      current.oauthAccount?.hasExtraUsageEnabled ===
        accountInfo.hasExtraUsageEnabled &&
      current.oauthAccount?.billingType === accountInfo.billingType &&
      current.oauthAccount?.accountCreatedAt === accountInfo.accountCreatedAt &&
      current.oauthAccount?.subscriptionCreatedAt ===
        accountInfo.subscriptionCreatedAt
    ) {
      return current
    }
    return { ...current, oauthAccount: accountInfo }
  })
}
