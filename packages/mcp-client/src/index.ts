// mcp-client — MCP 协议客户端
// 严格协议层：连接、传输、工具发现、执行

// 类型与 Schema
export {
  ConfigScope,
  TransportType,
  McpStdioServerConfigSchema,
  McpSSEServerConfigSchema,
  McpHTTPServerConfigSchema,
  McpWebSocketServerConfigSchema,
  McpSdkServerConfigSchema,
  McpClaudeAIProxyServerConfigSchema,
  McpServerConfigSchema,
  McpJsonConfigSchema,
} from './types.js'

export type {
  ConfigScope as ConfigScopeType,
  Transport,
  McpStdioServerConfig,
  McpSSEServerConfig,
  McpSSEIDEServerConfig,
  McpWebSocketIDEServerConfig,
  McpHTTPServerConfig,
  McpWebSocketServerConfig,
  McpSdkServerConfig,
  McpClaudeAIProxyServerConfig,
  McpServerConfig,
  ScopedMcpServerConfig,
  McpJsonConfig,
  MCPServerConnection,
  ConnectedMCPServer,
  FailedMCPServer,
  NeedsAuthMCPServer,
  PendingMCPServer,
  DisabledMCPServer,
  ServerResource,
  SerializedTool,
  SerializedClient,
  MCPCliState,
} from './types.js'

// 错误类
export {
  McpError,
  McpConnectionError,
  McpAuthError,
  McpTimeoutError,
  McpToolCallError,
  McpSessionExpiredError,
} from './errors.js'

// 接口（宿主依赖注入）
export type {
  Logger,
  AnalyticsSink,
  FeatureGate,
  AuthProvider,
  ProxyConfig,
  ContentStorage,
  ImageProcessor,
  HttpConfig,
  SubprocessEnvProvider,
  McpClientDependencies,
} from './interfaces.js'

// 传输层
export { createLinkedTransportPair } from './transport/InProcessTransport.js'

// 字符串工具函数
export {
  buildMcpToolName,
  normalizeNameForMCP,
  mcpInfoFromString,
  getMcpPrefix,
  getToolNameForPermissionCheck,
  getMcpDisplayName,
  extractMcpToolDisplayName,
} from './strings.js'

// 缓存
export { memoizeWithLRU } from './cache.js'

// Unicode 清理
export { recursivelySanitizeUnicode } from './sanitization.js'

// 连接工具函数
export {
  DEFAULT_CONNECTION_TIMEOUT_MS,
  MAX_MCP_DESCRIPTION_LENGTH,
  MAX_ERRORS_BEFORE_RECONNECT,
  createMcpClient,
  withConnectionTimeout,
  captureStderr,
  isTerminalConnectionError,
  isMcpSessionExpiredError,
  installConnectionMonitor,
  terminateWithSignalEscalation,
  createCleanup,
  buildConnectedServer,
} from './connection.js'
export type {
  CreateClientOptions,
  ConnectionMonitorOptions,
  CleanupOptions,
  BuildConnectedServerOptions,
} from './connection.js'

// 工具发现
export {
  MCP_FETCH_CACHE_SIZE,
  discoverTools,
  createCachedToolDiscovery,
} from './discovery.js'
export type { DiscoveryOptions } from './discovery.js'

// 工具执行
export { callMcpTool } from './execution.js'
export type { CallToolOptions, CallToolResult } from './execution.js'

// 管理器（主 API）
export { createMcpManager } from './manager.js'
export type { McpManager } from './manager.js'
