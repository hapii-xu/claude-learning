import type { IncomingMessage, ServerResponse } from 'http'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { logEvent } from 'src/services/analytics/index.js'
import { getOauthConfig } from '../../constants/oauth.js'
import { logError } from '../../utils/log.js'
import { shouldUseClaudeAIAuth } from './client.js'

/**
 * 监听 OAuth 授权码重定向的临时本地 HTTP 服务器。
 *
 * 当用户在浏览器中授权时，OAuth 提供者会重定向到：
 * http://localhost:[port]/callback?code=AUTH_CODE&state=STATE
 *
 * 此服务器捕获该重定向并提取授权码。
 * 注意：这不是 OAuth 服务器 —— 它只是一个重定向捕获机制。
 */
export class AuthCodeListener {
  private localServer: Server
  private port: number = 0
  private promiseResolver: ((authorizationCode: string) => void) | null = null
  private promiseRejecter: ((error: Error) => void) | null = null
  private expectedState: string | null = null // 用于 CSRF 保护的状态参数
  private pendingResponse: ServerResponse | null = null // 用于最终重定向的响应对象
  private callbackPath: string // 可配置的回调路径

  constructor(callbackPath: string = '/callback') {
    this.localServer = createServer()
    this.callbackPath = callbackPath
  }

  /**
   * 在操作系统分配的端口上开始监听并返回端口号。
   * 通过保持服务器开放直到被使用来避免竞态条件。
   * @param port 可选的特定端口。如果未提供，使用操作系统分配的端口。
   */
  async start(port?: number): Promise<number> {
    return new Promise((resolve, reject) => {
      this.localServer.once('error', err => {
        reject(
          new Error(`Failed to start OAuth callback server: ${err.message}`),
        )
      })

      // 在指定端口或 0 上监听，让操作系统分配可用端口
      this.localServer.listen(port ?? 0, 'localhost', () => {
        const address = this.localServer.address() as AddressInfo
        this.port = address.port
        resolve(this.port)
      })
    })
  }

  getPort(): number {
    return this.port
  }

  hasPendingResponse(): boolean {
    return this.pendingResponse !== null
  }

  async waitForAuthorization(
    state: string,
    onReady: () => Promise<void>,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.promiseResolver = resolve
      this.promiseRejecter = reject
      this.expectedState = state
      this.startLocalListener(onReady)
    })
  }

  /**
   * 通过将用户浏览器重定向到成功页面来完成 OAuth 流程。
   * 根据授予的范围显示不同的成功页面。
   * @param scopes 已授予的 OAuth 范围
   * @param customHandler 可选的自定义处理器，用于提供响应而不是重定向
   */
  handleSuccessRedirect(
    scopes: string[],
    customHandler?: (res: ServerResponse, scopes: string[]) => void,
  ): void {
    if (!this.pendingResponse) return

    // 如果提供了自定义处理器，使用它而不是默认重定向
    if (customHandler) {
      customHandler(this.pendingResponse, scopes)
      this.pendingResponse = null
      logEvent('tengu_oauth_automatic_redirect', { custom_handler: true })
      return
    }

    // 默认行为：根据授予的权限选择成功页面
    const successUrl = shouldUseClaudeAIAuth(scopes)
      ? getOauthConfig().CLAUDEAI_SUCCESS_URL
      : getOauthConfig().CONSOLE_SUCCESS_URL

    // 将浏览器发送到成功页面
    this.pendingResponse.writeHead(302, { Location: successUrl })
    this.pendingResponse.end()
    this.pendingResponse = null

    logEvent('tengu_oauth_automatic_redirect', {})
  }

  /**
   * 通过重定向到适当的成功页面（带错误指示器）来处理错误情况，
   * 确保浏览器流程正确完成。
   */
  handleErrorRedirect(): void {
    if (!this.pendingResponse) return

    // TODO: 当我们有错误页面时替换为不同的 url
    const errorUrl = getOauthConfig().CLAUDEAI_SUCCESS_URL

    // 将浏览器发送到错误页面
    this.pendingResponse.writeHead(302, { Location: errorUrl })
    this.pendingResponse.end()
    this.pendingResponse = null

    logEvent('tengu_oauth_automatic_redirect_error', {})
  }

  private startLocalListener(onReady: () => Promise<void>): void {
    // 服务器已创建并监听，只需设置处理器
    this.localServer.on('request', this.handleRedirect.bind(this))
    this.localServer.on('error', this.handleError.bind(this))

    // 服务器已经在监听，所以我们可以立即调用 onReady
    void onReady()
  }

  private handleRedirect(req: IncomingMessage, res: ServerResponse): void {
    const parsedUrl = new URL(
      req.url || '',
      `http://${req.headers.host || 'localhost'}`,
    )

    if (parsedUrl.pathname !== this.callbackPath) {
      res.writeHead(404)
      res.end()
      return
    }

    const authCode = parsedUrl.searchParams.get('code') ?? undefined
    const state = parsedUrl.searchParams.get('state') ?? undefined

    this.validateAndRespond(authCode, state, res)
  }

  private validateAndRespond(
    authCode: string | undefined,
    state: string | undefined,
    res: ServerResponse,
  ): void {
    if (!authCode) {
      res.writeHead(400)
      res.end('Authorization code not found')
      this.reject(new Error('No authorization code received'))
      return
    }

    if (state !== this.expectedState) {
      res.writeHead(400)
      res.end('Invalid state parameter')
      this.reject(new Error('Invalid state parameter'))
      return
    }

    // 存储响应以供稍后重定向
    this.pendingResponse = res

    this.resolve(authCode)
  }

  private handleError(err: Error): void {
    logError(err)
    this.close()
    this.reject(err)
  }

  private resolve(authorizationCode: string): void {
    if (this.promiseResolver) {
      this.promiseResolver(authorizationCode)
      this.promiseResolver = null
      this.promiseRejecter = null
    }
  }

  private reject(error: Error): void {
    if (this.promiseRejecter) {
      this.promiseRejecter(error)
      this.promiseResolver = null
      this.promiseRejecter = null
    }
  }

  close(): void {
    // 如果有待处理的响应，在关闭前发送重定向
    if (this.pendingResponse) {
      this.handleErrorRedirect()
    }

    if (this.localServer) {
      // 移除所有监听器以防止内存泄漏
      this.localServer.removeAllListeners()
      this.localServer.close()
    }
  }
}
