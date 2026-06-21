// MCP 工具发现 — 从已连接的 MCP 服务器获取并处理工具
// 提取自 src/services/mcp/client.ts (fetchToolsForClient)

import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  ListToolsResultSchema,
  type ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js'
import type { CoreTool } from '@claude-code-best/agent-tools'
import type { ConnectedMCPServer } from './types.js'
import type { McpClientDependencies } from './interfaces.js'
import { buildMcpToolName } from './strings.js'
import { memoizeWithLRU } from './cache.js'
import { recursivelySanitizeUnicode } from './sanitization.js'

// ============================================================================
// 常量
// ============================================================================

/** 工具发现的默认最大缓存大小（以服务器名称为键） */
export const MCP_FETCH_CACHE_SIZE = 20

/** 截断前的最大描述长度 */
const MAX_MCP_DESCRIPTION_LENGTH = 2048

// ============================================================================
// 工具发现
// ============================================================================

export interface DiscoveryOptions {
  /** 用于日志记录和工具命名的服务器名称 */
  serverName: string
  /** 已连接的 MCP 服务器客户端 */
  client: Client
  /** 服务器能力（在获取前检查） */
  capabilities: Record<string, unknown>
  /** 是否跳过工具名称的 mcp__ 前缀 */
  skipPrefix?: boolean
  /** 用于日志记录的宿主依赖 */
  deps: McpClientDependencies
}

/**
 * 从已连接的 MCP 服务器获取工具并将其转换为 CoreTool 格式。
 * 如果服务器不支持工具或获取失败，返回空数组。
 */
export async function discoverTools(
  options: DiscoveryOptions,
): Promise<CoreTool[]> {
  const { serverName, client, capabilities, skipPrefix, deps } = options

  if (!capabilities?.tools) {
    return []
  }

  try {
    const result = (await client.request(
      { method: 'tools/list' },
      ListToolsResultSchema,
    )) as ListToolsResult

    // 清理来自 MCP 服务器的工具数据
    const toolsToProcess = recursivelySanitizeUnicode(result.tools)

    return toolsToProcess.map((tool): CoreTool => {
      const fullyQualifiedName = buildMcpToolName(serverName, tool.name)
      const effectiveName = skipPrefix ? tool.name : fullyQualifiedName

      return {
        name: effectiveName,
        mcpInfo: { serverName, toolName: tool.name },
        isMcp: true,
        inputJSONSchema: tool.inputSchema as CoreTool['inputJSONSchema'],
        async description() {
          return tool.description ?? ''
        },
        async prompt() {
          const desc = tool.description ?? ''
          return desc.length > MAX_MCP_DESCRIPTION_LENGTH
            ? desc.slice(0, MAX_MCP_DESCRIPTION_LENGTH) + '… [truncated]'
            : desc
        },
        isConcurrencySafe: () => tool.annotations?.readOnlyHint ?? false,
        isReadOnly: () => tool.annotations?.readOnlyHint ?? false,
        isDestructive: () => tool.annotations?.destructiveHint ?? false,
        isOpenWorld: () => tool.annotations?.openWorldHint ?? false,
        isEnabled: () => true,
        async checkPermissions() {
          return { behavior: 'passthrough' as const }
        },
        toAutoClassifierInput: () => '',
        userFacingName: () => tool.annotations?.title ?? tool.name,
        maxResultSizeChars: 100_000,
        mapToolResultToToolResultBlockParam: (
          content: unknown,
          id: string,
        ) => ({
          type: 'tool_result' as const,
          tool_use_id: id,
          content,
        }),
        async call() {
          throw new Error('Use manager.callTool() instead')
        },
        inputSchema: {} as CoreTool['inputSchema'],
      } satisfies CoreTool
    })
  } catch (error) {
    deps.logger.warn(`Failed to fetch tools for ${serverName}:`, error)
    return []
  }
}

// ============================================================================
// 缓存的工具发现（按服务器名称 LRU）
// ============================================================================

/**
 * 创建一个带 LRU 缓存的记忆化工具发现函数。
 * 缓存以服务器名称为键（在重连时保持稳定）。
 */
export function createCachedToolDiscovery(
  deps: McpClientDependencies,
  cacheSize: number = MCP_FETCH_CACHE_SIZE,
): {
  discover: (
    server: ConnectedMCPServer,
    skipPrefix?: boolean,
  ) => Promise<CoreTool[]>
  cache: { delete(key: string): void; clear(): void }
} {
  const discover = memoizeWithLRU(
    async (
      server: ConnectedMCPServer,
      skipPrefix?: boolean,
    ): Promise<CoreTool[]> => {
      if (server.type !== 'connected') return []
      return discoverTools({
        serverName: server.name,
        client: server.client,
        capabilities: server.capabilities ?? {},
        skipPrefix,
        deps,
      })
    },
    (server: ConnectedMCPServer) => server.name,
    cacheSize,
  )

  return {
    discover,
    cache: discover.cache,
  }
}
