import { logEvent } from 'src/services/analytics/index.js'
import { openBrowser } from '../../utils/browser.js'
import { AuthCodeListener } from './auth-code-listener.js'
import * as client from './client.js'
import * as crypto from './crypto.js'
import type {
  OAuthProfileResponse,
  OAuthTokenExchangeResponse,
  OAuthTokens,
  RateLimitTier,
  SubscriptionType,
} from './types.js'

/**
 * 处理带 PKCE 的 OAuth 2.0 授权码流程的 OAuth 服务。
 *
 * 支持两种获取授权码的方式：
 * 1. 自动：打开浏览器，重定向到 localhost，我们在此捕获代码
 * 2. 手动：用户手动复制并粘贴代码（用于非浏览器环境）
 */
export class OAuthService {
  private codeVerifier: string
  private authCodeListener: AuthCodeListener | null = null
  private port: number | null = null
  private manualAuthCodeResolver: ((authorizationCode: string) => void) | null =
    null

  constructor() {
    this.codeVerifier = crypto.generateCodeVerifier()
  }

  async startOAuthFlow(
    authURLHandler: (url: string, automaticUrl?: string) => Promise<void>,
    options?: {
      loginWithClaudeAi?: boolean
      inferenceOnly?: boolean
      expiresIn?: number
      orgUUID?: string
      loginHint?: string
      loginMethod?: string
      /**
       * 不要调用 openBrowser()。调用者通过 authURLHandler 接收两个 URL
       * 并决定如何/在哪里打开它们。由 SDK 控制协议
       *（claude_authenticate）使用，其中 SDK 客户端拥有用户的显示，
       * 而非此进程。
       */
      skipBrowserOpen?: boolean
    },
  ): Promise<OAuthTokens> {
    // 创建 OAuth 回调监听器并启动它
    this.authCodeListener = new AuthCodeListener()
    this.port = await this.authCodeListener.start()

    // 生成 PKCE 值和状态
    const codeChallenge = crypto.generateCodeChallenge(this.codeVerifier)
    const state = crypto.generateState()

    // 为自动和手动流程构建认证 URL
    const opts = {
      codeChallenge,
      state,
      port: this.port,
      loginWithClaudeAi: options?.loginWithClaudeAi,
      inferenceOnly: options?.inferenceOnly,
      orgUUID: options?.orgUUID,
      loginHint: options?.loginHint,
      loginMethod: options?.loginMethod,
    }
    const manualFlowUrl = client.buildAuthUrl({ ...opts, isManual: true })
    const automaticFlowUrl = client.buildAuthUrl({ ...opts, isManual: false })

    // 等待自动或手动授权码
    const authorizationCode = await this.waitForAuthorizationCode(
      state,
      async () => {
        if (options?.skipBrowserOpen) {
          // 将两个 URL 交给调用方。如果调用方在
          // 同一主机上打开自动 URL 仍然有效（localhost 监听器
          // 正在运行）；手动 URL 可以从任何地方工作。
          await authURLHandler(manualFlowUrl, automaticFlowUrl)
        } else {
          await authURLHandler(manualFlowUrl) // 向用户显示手动选项
          await openBrowser(automaticFlowUrl) // 尝试自动流程
        }
      },
    )

    // 检查自动流程是否仍然活跃（有待处理响应）
    const isAutomaticFlow = this.authCodeListener?.hasPendingResponse() ?? false
    logEvent('tengu_oauth_auth_code_received', { automatic: isAutomaticFlow })

    try {
      // 交换授权码获取令牌
      const tokenResponse = await client.exchangeCodeForTokens(
        authorizationCode,
        state,
        this.codeVerifier,
        this.port!,
        !isAutomaticFlow, // 如果不是自动流程，传递 isManual=true
        options?.expiresIn,
      )

      // 为返回的 OAuthTokens 获取 profile 信息（订阅类型和速率限制层级）。
      // 登出和账户存储由调用方处理（auth.ts 中的 installOAuthTokens）。
      const profileInfo = await client.fetchProfileInfo(
        tokenResponse.access_token,
      )

      // 为自动流程处理成功重定向
      if (isAutomaticFlow) {
        const scopes = client.parseScopes(tokenResponse.scope)
        this.authCodeListener?.handleSuccessRedirect(scopes)
      }

      return this.formatTokens(
        tokenResponse,
        profileInfo.subscriptionType,
        profileInfo.rateLimitTier,
        profileInfo.rawProfile,
      )
    } catch (error) {
      // 如果有待处理响应，在关闭前发送错误重定向
      if (isAutomaticFlow) {
        this.authCodeListener?.handleErrorRedirect()
      }
      throw error
    } finally {
      // 总是清理
      this.authCodeListener?.close()
    }
  }

  private async waitForAuthorizationCode(
    state: string,
    onReady: () => Promise<void>,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      // 设置手动授权码解析器
      this.manualAuthCodeResolver = resolve

      // 启动自动流程
      this.authCodeListener
        ?.waitForAuthorization(state, onReady)
        .then(authorizationCode => {
          this.manualAuthCodeResolver = null
          resolve(authorizationCode)
        })
        .catch(error => {
          this.manualAuthCodeResolver = null
          reject(error)
        })
    })
  }

  // 处理用户粘贴授权码时的手动流程回调
  handleManualAuthCodeInput(params: {
    authorizationCode: string
    state: string
  }): void {
    if (this.manualAuthCodeResolver) {
      this.manualAuthCodeResolver(params.authorizationCode)
      this.manualAuthCodeResolver = null
      // 由于使用了手动输入，关闭授权码监听器
      this.authCodeListener?.close()
    }
  }

  private formatTokens(
    response: OAuthTokenExchangeResponse,
    subscriptionType: SubscriptionType | null,
    rateLimitTier: RateLimitTier | null,
    profile?: OAuthProfileResponse,
  ): OAuthTokens {
    return {
      accessToken: response.access_token,
      refreshToken: response.refresh_token,
      expiresAt: Date.now() + response.expires_in * 1000,
      scopes: client.parseScopes(response.scope),
      subscriptionType,
      rateLimitTier,
      profile,
      tokenAccount: response.account
        ? {
            uuid: response.account.uuid,
            emailAddress: response.account.email_address,
            organizationUuid: response.organization?.uuid,
          }
        : undefined,
    }
  }

  // 清理任何资源（如本地服务器）
  cleanup(): void {
    this.authCodeListener?.close()
    this.manualAuthCodeResolver = null
  }
}
