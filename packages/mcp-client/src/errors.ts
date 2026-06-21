// MCP 类型化错误层级

/**
 * 所有 MCP 相关错误的基类。
 */
export class McpError extends Error {
  constructor(
    message: string,
    public readonly serverName: string,
    public readonly code: string,
  ) {
    super(message)
    this.name = 'McpError'
  }
}

/**
 * 当连接到 MCP 服务器失败时抛出的错误。
 */
export class McpConnectionError extends McpError {
  constructor(
    serverName: string,
    message: string,
    public readonly cause?: Error,
  ) {
    super(message, serverName, 'CONNECTION_FAILED')
    this.name = 'McpConnectionError'
  }
}

/**
 * 当需要认证但不可用时抛出的错误。
 */
export class McpAuthError extends McpError {
  constructor(serverName: string, message: string) {
    super(message, serverName, 'AUTH_REQUIRED')
    this.name = 'McpAuthError'
  }
}

/**
 * 当连接或请求超时时抛出的错误。
 */
export class McpTimeoutError extends McpError {
  constructor(
    serverName: string,
    public readonly timeoutMs: number,
  ) {
    super(
      `Connection to ${serverName} timed out after ${timeoutMs}ms`,
      serverName,
      'TIMEOUT',
    )
    this.name = 'McpTimeoutError'
  }
}

/**
 * 当 MCP 工具调用失败时抛出的错误。
 */
export class McpToolCallError extends McpError {
  constructor(
    serverName: string,
    public readonly toolName: string,
    message: string,
  ) {
    super(message, serverName, 'TOOL_CALL_FAILED')
    this.name = 'McpToolCallError'
  }
}

/**
 * 当 MCP 会话已过期时抛出的错误。
 */
export class McpSessionExpiredError extends McpError {
  constructor(serverName: string) {
    super(`Session expired for ${serverName}`, serverName, 'SESSION_EXPIRED')
    this.name = 'McpSessionExpiredError'
  }
}
