// MCP 连接工具 —— 用于建立和管理连接的协议级辅助函数。
// 这些是宿主 connectToServer 实现使用的构建块。

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { McpClientDependencies } from './interfaces.js'
import type { ConnectedMCPServer, ScopedMcpServerConfig } from './types.js'

// ============================================================================
// 常量
// ============================================================================

/** 默认连接超时时间（毫秒） */
export const DEFAULT_CONNECTION_TIMEOUT_MS = 30_000

/** MCP 描述/说明的最大长度 */
export const MAX_MCP_DESCRIPTION_LENGTH = 2048

/** 触发重连前的最大连续终端错误数 */
export const MAX_ERRORS_BEFORE_RECONNECT = 3

// ============================================================================
// 客户端创建
// ============================================================================

export interface CreateClientOptions {
  /** 客户端名称（例如 "claude-code"） */
  name: string
  /** 客户端标题 */
  title?: string
  /** 客户端版本 */
  version: string
  /** 客户端描述 */
  description?: string
  /** 客户端网站 URL */
  websiteUrl?: string
  /** ListRoots 请求的根 URI（默认为当前工作目录） */
  rootUri?: string
}

/**
 * 创建带有标准能力和处理器的配置好的 MCP Client 实例。
 * 宿主可以在连接前进一步自定义客户端。
 */
export function createMcpClient(options: CreateClientOptions): Client {
  const client = new Client(
    {
      name: options.name,
      title: options.title ?? options.name,
      version: options.version,
      description: options.description,
      websiteUrl: options.websiteUrl,
    },
    {
      capabilities: {
        roots: {},
        elicitation: {},
      },
    },
  )

  // 注册默认的 ListRoots 处理器
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: [
      {
        uri: options.rootUri ?? `file://${process.cwd()}`,
      },
    ],
  }))

  return client
}

// ============================================================================
// 连接超时
// ============================================================================

/**
 * 用超时包装连接 Promise。
 * 返回 connectPromise 的结果，或在超时时以超时错误拒绝。
 */
export async function withConnectionTimeout<T>(
  connectPromise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Promise<void> | void,
): Promise<T> {
  const startTime = Date.now()

  const timeoutPromise = new Promise<never>((_, reject) => {
    const timeoutId = setTimeout(async () => {
      await onTimeout()
      reject(new Error(`MCP connection timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    // 如果连接成功解析或拒绝，清理超时
    connectPromise.then(
      () => clearTimeout(timeoutId),
      () => clearTimeout(timeoutId),
    )
  })

  return Promise.race([connectPromise, timeoutPromise])
}

// ============================================================================
// Stderr 捕获
// ============================================================================

/**
 * 为 stdio 传输设置 stderr 捕获。
 * 返回 stderr 输出累加器和清理函数。
 */
export function captureStderr(
  transport: StdioClientTransport,
  maxSize = 8 * 1024 * 1024,
): {
  getOutput: () => string
  clearOutput: () => void
  removeHandler: () => void
} {
  let stderrOutput = ''

  const handler = (data: Buffer) => {
    if (stderrOutput.length < maxSize) {
      try {
        stderrOutput += data.toString()
      } catch {
        // 忽略超过最大字符串长度的错误
      }
    }
  }

  transport.stderr?.on('data', handler)

  return {
    getOutput: () => stderrOutput,
    clearOutput: () => {
      stderrOutput = ''
    },
    removeHandler: () => {
      transport.stderr?.off('data', handler)
    },
  }
}

// ============================================================================
// 错误/关闭处理器
// ============================================================================

/**
 * 指示连接已断开的终端连接错误模式。
 */
export function isTerminalConnectionError(msg: string): boolean {
  return (
    msg.includes('ECONNRESET') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('EPIPE') ||
    msg.includes('EHOSTUNREACH') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('Body Timeout Error') ||
    msg.includes('terminated') ||
    msg.includes('SSE stream disconnected') ||
    msg.includes('Failed to reconnect SSE stream')
  )
}

/**
 * 检测 MCP "Session not found" 错误（HTTP 404 + JSON-RPC 代码 -32001）。
 */
export function isMcpSessionExpiredError(error: Error): boolean {
  const httpStatus =
    'code' in error ? (error as Error & { code?: number }).code : undefined
  if (httpStatus !== 404) {
    return false
  }
  return (
    error.message.includes('"code":-32001') ||
    error.message.includes('"code": -32001')
  )
}

export interface ConnectionMonitorOptions {
  serverName: string
  transportType: string
  logger: McpClientDependencies['logger']
  /** 当应关闭传输以触发重连时调用 */
  closeTransport: () => void
  /** 关闭时调用以清除连接缓存 */
  onConnectionClosed?: () => void
}

/**
 * 在 MCP Client 上安装增强的错误和关闭处理器，
 * 用于连接断开检测和自动重连。
 *
 * 返回用于移除处理器的清理函数。
 */
export function installConnectionMonitor(
  client: Client,
  options: ConnectionMonitorOptions,
): () => void {
  const {
    serverName,
    transportType,
    logger,
    closeTransport,
    onConnectionClosed,
  } = options
  const connectionStartTime = Date.now()
  let hasErrorOccurred = false
  let consecutiveConnectionErrors = 0
  let hasTriggeredClose = false

  const originalOnerror = client.onerror
  const originalOnclose = client.onclose

  const safeClose = (reason: string) => {
    if (hasTriggeredClose) return
    hasTriggeredClose = true
    logger.debug(`[${serverName}] Closing transport (${reason})`)
    void client.close().catch(e => {
      logger.debug(`[${serverName}] Error during close: ${e}`)
    })
  }

  // 错误处理器
  client.onerror = (error: Error) => {
    const uptime = Date.now() - connectionStartTime
    hasErrorOccurred = true

    logger.debug(
      `[${serverName}] ${transportType.toUpperCase()} connection dropped after ${Math.floor(uptime / 1000)}s uptime`,
    )

    // HTTP 传输的会话过期
    if (
      (transportType === 'http' || transportType === 'claudeai-proxy') &&
      isMcpSessionExpiredError(error)
    ) {
      logger.debug(
        `[${serverName}] MCP session expired, triggering reconnection`,
      )
      safeClose('session expired')
      originalOnerror?.(error)
      return
    }

    // 远程传输的终端错误跟踪
    if (
      transportType === 'sse' ||
      transportType === 'http' ||
      transportType === 'claudeai-proxy'
    ) {
      if (error.message.includes('Maximum reconnection attempts')) {
        safeClose('SSE reconnection exhausted')
        originalOnerror?.(error)
        return
      }

      if (isTerminalConnectionError(error.message)) {
        consecutiveConnectionErrors++
        logger.debug(
          `[${serverName}] Terminal connection error ${consecutiveConnectionErrors}/${MAX_ERRORS_BEFORE_RECONNECT}`,
        )

        if (consecutiveConnectionErrors >= MAX_ERRORS_BEFORE_RECONNECT) {
          consecutiveConnectionErrors = 0
          safeClose('max consecutive terminal errors')
        }
      } else {
        consecutiveConnectionErrors = 0
      }
    }

    originalOnerror?.(error)
  }

  // 关闭处理器
  client.onclose = () => {
    const uptime = Date.now() - connectionStartTime
    logger.debug(
      `[${serverName}] ${transportType.toUpperCase()} connection closed after ${Math.floor(uptime / 1000)}s (${hasErrorOccurred ? 'with errors' : 'cleanly'})`,
    )

    onConnectionClosed?.()
    originalOnclose?.()
  }

  // 返回清理函数
  return () => {
    client.onerror = originalOnerror
    client.onclose = originalOnclose
  }
}

// ============================================================================
// stdio 清理的信号升级
// ============================================================================

/**
 * 使用升级信号终止 stdio 子进程：
 * SIGINT (100ms) → SIGTERM (400ms) → SIGKILL
 *
 * 总最大清理时间：约 500ms
 */
export async function terminateWithSignalEscalation(
  childPid: number,
  logger: McpClientDependencies['logger'],
  serverName: string,
): Promise<void> {
  try {
    logger.debug(`[${serverName}] Sending SIGINT to MCP server process`)

    try {
      process.kill(childPid, 'SIGINT')
    } catch (error) {
      logger.debug(`[${serverName}] Error sending SIGINT: ${error}`)
      return
    }

    // biome-ignore lint/suspicious/noAsyncPromiseExecutor: complex cleanup logic requires async in executor
    await new Promise<void>(async resolve => {
      let resolved = false

      const checkInterval = setInterval(() => {
        try {
          process.kill(childPid, 0)
        } catch {
          if (!resolved) {
            resolved = true
            clearInterval(checkInterval)
            clearTimeout(failsafeTimeout)
            logger.debug(`[${serverName}] MCP server process exited cleanly`)
            resolve()
          }
        }
      }, 50)

      const failsafeTimeout = setTimeout(() => {
        if (!resolved) {
          resolved = true
          clearInterval(checkInterval)
          logger.debug(
            `[${serverName}] Cleanup timeout reached, stopping process monitoring`,
          )
          resolve()
        }
      }, 600)

      try {
        // 等待 100ms 让 SIGINT 生效
        await sleep(100)

        if (!resolved) {
          try {
            process.kill(childPid, 0)
            // 进程仍存在，尝试 SIGTERM
            logger.debug(`[${serverName}] SIGINT failed, sending SIGTERM`)
            try {
              process.kill(childPid, 'SIGTERM')
            } catch (termError) {
              logger.debug(
                `[${serverName}] Error sending SIGTERM: ${termError}`,
              )
              resolved = true
              clearInterval(checkInterval)
              clearTimeout(failsafeTimeout)
              resolve()
              return
            }
          } catch {
            resolved = true
            clearInterval(checkInterval)
            clearTimeout(failsafeTimeout)
            resolve()
            return
          }

          // 等待 400ms 让 SIGTERM 生效
          await sleep(400)

          if (!resolved) {
            try {
              process.kill(childPid, 0)
              logger.debug(`[${serverName}] SIGTERM failed, sending SIGKILL`)
              try {
                process.kill(childPid, 'SIGKILL')
              } catch (killError) {
                logger.debug(
                  `[${serverName}] Error sending SIGKILL: ${killError}`,
                )
              }
            } catch {
              resolved = true
              clearInterval(checkInterval)
              clearTimeout(failsafeTimeout)
              resolve()
            }
          }
        }

        if (!resolved) {
          resolved = true
          clearInterval(checkInterval)
          clearTimeout(failsafeTimeout)
          resolve()
        }
      } catch {
        if (!resolved) {
          resolved = true
          clearInterval(checkInterval)
          clearTimeout(failsafeTimeout)
          resolve()
        }
      }
    })
  } catch (processError) {
    logger.debug(`[${serverName}] Error terminating process: ${processError}`)
  }
}

/** 简单的 sleep 工具函数（避免从宿主导入） */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ============================================================================
// 清理工厂函数
// ============================================================================

export interface CleanupOptions {
  client: Client
  transport: Transport
  transportType: string
  childPid?: number
  inProcessServer?: { close(): Promise<void> }
  stderrCleanup?: { removeHandler: () => void }
  logger: McpClientDependencies['logger']
  serverName: string
}

/**
 * 为 MCP 连接创建清理函数。
 * 处理进程内服务器、stderr 监听器移除、信号升级和客户端关闭。
 */
export function createCleanup(options: CleanupOptions): () => Promise<void> {
  const {
    client,
    transport,
    transportType,
    childPid,
    inProcessServer,
    stderrCleanup,
    logger,
    serverName,
  } = options

  return async () => {
    // 进程内服务器
    if (inProcessServer) {
      try {
        await inProcessServer.close()
      } catch (error) {
        logger.debug(
          `[${serverName}] Error closing in-process server: ${error}`,
        )
      }
      try {
        await client.close()
      } catch (error) {
        logger.debug(`[${serverName}] Error closing client: ${error}`)
      }
      return
    }

    // 移除 stderr 监听器
    stderrCleanup?.removeHandler()

    // stdio 的信号升级
    if (transportType === 'stdio' && childPid) {
      await terminateWithSignalEscalation(childPid, logger, serverName)
    }

    // 关闭客户端连接（同时也会关闭传输）
    try {
      await client.close()
    } catch (error) {
      logger.debug(`[${serverName}] Error closing client: ${error}`)
    }
  }
}

// ============================================================================
// 已连接服务器结果构建器
// ============================================================================

export interface BuildConnectedServerOptions {
  name: string
  client: Client
  config: ScopedMcpServerConfig
  cleanup: () => Promise<void>
}

/**
 * 从已连接的客户端构建 ConnectedMCPServer 结果。
 * 如果服务器说明超过 MAX_MCP_DESCRIPTION_LENGTH，则截断。
 */
export function buildConnectedServer(
  options: BuildConnectedServerOptions,
  logger: McpClientDependencies['logger'],
): ConnectedMCPServer {
  const { name, client, config, cleanup } = options

  const capabilities = client.getServerCapabilities() ?? {}
  const serverVersion = client.getServerVersion()
  const rawInstructions = client.getInstructions()

  let instructions = rawInstructions
  if (rawInstructions && rawInstructions.length > MAX_MCP_DESCRIPTION_LENGTH) {
    instructions =
      rawInstructions.slice(0, MAX_MCP_DESCRIPTION_LENGTH) + '… [truncated]'
    logger.debug(
      `[${name}] Server instructions truncated from ${rawInstructions.length} to ${MAX_MCP_DESCRIPTION_LENGTH} chars`,
    )
  }

  return {
    name,
    client,
    type: 'connected' as const,
    capabilities,
    serverInfo: serverVersion,
    instructions,
    config,
    cleanup,
  }
}
