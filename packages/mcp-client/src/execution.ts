// MCP 工具执行 — 在已连接的 MCP 服务器上调用工具
// 提取自 src/services/mcp/client.ts (callMCPTool)

import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import type { ConnectedMCPServer } from './types.js'
import type { McpClientDependencies } from './interfaces.js'
import { McpToolCallError, McpAuthError } from './errors.js'

// ============================================================================
// 常量
// ============================================================================

/** MCP 工具调用的默认超时时间（约 27.8 小时 — 实际为无限） */
const DEFAULT_MCP_TOOL_TIMEOUT_MS = 100_000_000

// ============================================================================
// 工具执行
// ============================================================================

export interface CallToolOptions {
  /** 要调用的已连接 MCP 服务器 */
  client: ConnectedMCPServer
  /** 工具名称（服务器上注册的名称，非完全限定名） */
  tool: string
  /** 工具参数 */
  args: Record<string, unknown>
  /** 随调用发送的可选元数据 */
  meta?: Record<string, unknown>
  /** 用于取消的 AbortSignal */
  signal: AbortSignal
  /** 进度回调 */
  onProgress?: (data: {
    progress?: number
    total?: number
    message?: string
  }) => void
  /** 工具调用超时时间（毫秒），默认约 27.8 小时 */
  timeoutMs?: number
}

export interface CallToolResult {
  content: unknown
  _meta?: Record<string, unknown>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

/**
 * 在已连接的 MCP 服务器上调用工具，带超时和进度处理。
 *
 * 这是协议层的工具执行函数。宿主负责：
 * - 会话管理（过期时重连）
 * - 结果转换（内容处理、截断、持久化）
 * - 错误包装以用于遥测
 */
export async function callMcpTool(
  options: CallToolOptions,
  deps: McpClientDependencies,
): Promise<CallToolResult> {
  const { client, tool, args, meta, signal, onProgress, timeoutMs } = options
  const { name: serverName, client: mcpClient } = client
  const effectiveTimeout = timeoutMs ?? getMcpToolTimeoutMs()

  let progressInterval: ReturnType<typeof setInterval> | undefined

  try {
    deps.logger.debug(`[${serverName}] Calling MCP tool: ${tool}`)

    // 长时间运行工具的进度日志（每 30 秒）
    progressInterval = setInterval(() => {
      deps.logger.debug(`[${serverName}] Tool '${tool}' still running`)
    }, 30_000)

    const result = await Promise.race([
      mcpClient.callTool(
        {
          name: tool,
          arguments: args,
          _meta: meta,
        },
        CallToolResultSchema,
        {
          signal,
          timeout: effectiveTimeout,
          onprogress: onProgress,
        },
      ),
      createTimeoutPromise(serverName, tool, effectiveTimeout),
    ])

    // 处理结果中的 isError 标志
    if ('isError' in result && result.isError) {
      let errorDetails = 'Unknown error'
      if (
        'content' in result &&
        Array.isArray(result.content) &&
        result.content.length > 0
      ) {
        const firstContent = result.content[0]
        if (
          firstContent &&
          typeof firstContent === 'object' &&
          'text' in firstContent
        ) {
          errorDetails = (firstContent as { text: string }).text
        }
      }

      throw new McpToolCallError(serverName, tool, errorDetails)
    }

    return {
      content: result,
      _meta: result._meta as Record<string, unknown> | undefined,
      structuredContent: result.structuredContent as
        | Record<string, unknown>
        | undefined,
    }
  } catch (e) {
    if (progressInterval !== undefined) {
      clearInterval(progressInterval)
    }

    if (e instanceof Error && e.name !== 'AbortError') {
      deps.logger.debug(`[${serverName}] Tool '${tool}' failed: ${e.message}`)
    }

    // 检查 401 错误
    if (e instanceof Error) {
      const errorCode = 'code' in e ? (e.code as number | undefined) : undefined
      if (errorCode === 401) {
        throw new McpAuthError(
          serverName,
          `MCP server "${serverName}" requires re-authorization (token expired)`,
        )
      }
    }

    throw e
  } finally {
    if (progressInterval !== undefined) {
      clearInterval(progressInterval)
    }
  }
}

// ============================================================================
// 辅助函数
// ============================================================================

function getMcpToolTimeoutMs(): number {
  return (
    parseInt(process.env.MCP_TOOL_TIMEOUT || '', 10) ||
    DEFAULT_MCP_TOOL_TIMEOUT_MS
  )
}

function createTimeoutPromise(
  serverName: string,
  tool: string,
  timeoutMs: number,
): Promise<never> {
  return new Promise((_, reject) => {
    const timeoutId = setTimeout(() => {
      reject(
        new Error(
          `MCP server "${serverName}" tool "${tool}" timed out after ${Math.floor(timeoutMs / 1000)}s`,
        ),
      )
    }, timeoutMs)
    timeoutId.unref?.()
  })
}
