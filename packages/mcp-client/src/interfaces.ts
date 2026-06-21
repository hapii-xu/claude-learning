// 宿主依赖注入接口
// MCP 客户端包使用这些接口与宿主基础设施解耦。

/** 日志接口 */
export interface Logger {
  debug(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

/** 分析/遥测回调 */
export interface AnalyticsSink {
  trackEvent(event: string, metadata: Record<string, unknown>): void
}

/** 特性标志检查 */
export interface FeatureGate {
  isEnabled(flag: string): boolean
}

/** OAuth 令牌提供者 */
export interface AuthProvider {
  getTokens(): Promise<{ accessToken: string } | null>
  refreshTokens(): Promise<void>
  handleOAuthError?(error: unknown): Promise<void>
}

/** HTTP/WebSocket 代理配置 */
export interface ProxyConfig {
  getFetchOptions?(): Record<string, unknown>
  getWebSocketAgent?(url: string): unknown
  getWebSocketUrl?(url: string): string | undefined
  getTLSOptions?(): Record<string, unknown> | undefined
}

/** 二进制/图片内容持久化 */
export interface ContentStorage {
  persistBinaryContent(data: Buffer, ext: string): Promise<string>
  persistToolResult?(toolUseId: string, content: unknown): Promise<void>
}

/** 图片处理（调整大小、降采样） */
export interface ImageProcessor {
  resizeAndDownsample?(buffer: Buffer): Promise<Buffer>
}

/** HTTP 配置（用户代理、会话 ID） */
export interface HttpConfig {
  getUserAgent(): string
  getSessionId?(): string
}

/** 子进程环境变量提供者 */
export interface SubprocessEnvProvider {
  getEnv(additional?: Record<string, string>): Record<string, string>
}

/**
 * MCP 客户端所需的完整宿主依赖集合。
 * 除 `logger` 和 `httpConfig` 外所有字段均为可选 —
 * 客户端在缺少它们时能优雅降级。
 */
export interface McpClientDependencies {
  logger: Logger
  analytics?: AnalyticsSink
  featureGate?: FeatureGate
  auth?: AuthProvider
  proxy?: ProxyConfig
  storage?: ContentStorage
  imageProcessor?: ImageProcessor
  httpConfig: HttpConfig
  subprocessEnv?: SubprocessEnvProvider
}
