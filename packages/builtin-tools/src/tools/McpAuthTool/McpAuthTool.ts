import reject from 'lodash-es/reject.js'
import { z } from 'zod/v4'
import { performMCPOAuthFlow } from 'src/services/mcp/auth.js'
import {
  clearMcpAuthCache,
  reconnectMcpServerImpl,
} from 'src/services/mcp/client.js'
import {
  buildMcpToolName,
  getMcpPrefix,
} from 'src/services/mcp/mcpStringUtils.js'
import type {
  McpHTTPServerConfig,
  McpSSEServerConfig,
  ScopedMcpServerConfig,
} from 'src/services/mcp/types.js'
import type { Tool } from 'src/Tool.js'
import { errorMessage } from 'src/utils/errors.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { logMCPDebug, logMCPError } from 'src/utils/log.js'
import type { PermissionDecision } from 'src/utils/permissions/PermissionResult.js'

const inputSchema = lazySchema(() => z.object({}))
type InputSchema = ReturnType<typeof inputSchema>

export type McpAuthOutput = {
  status: 'auth_url' | 'unsupported' | 'error'
  message: string
  authUrl?: string
}

function getConfigUrl(config: ScopedMcpServerConfig): string | undefined {
  if ('url' in config) return config.url
  return undefined
}

/**
 * 为已安装但未认证的 MCP server 创建一个伪工具。用它代替该 server 的真实
 * 工具暴露给模型，让模型知道该 server 存在，并可以代用户启动 OAuth 流程。
 *
 * 被调用时，会以 skipBrowserOpen 启动 performMCPOAuthFlow 并返回授权 URL。
 * OAuth 回调在后台完成；回调触发后，reconnectMcpServerImpl 会运行，并将
 * 该 server 的真实工具通过现有的前缀替换机制替换进 appState.mcp.tools
 * （useManageMCPConnections.updateServer 会清掉所有匹配 mcp__<server>__*
 * 的内容，因此该伪工具会被自动移除）。
 */
export function createMcpAuthTool(
  serverName: string,
  config: ScopedMcpServerConfig,
): Tool<InputSchema, McpAuthOutput> {
  const url = getConfigUrl(config)
  const transport = config.type ?? 'stdio'
  const location = url ? `${transport} at ${url}` : transport

  const description =
    `\`${serverName}\` MCP server（${location}）已安装但需要认证。` +
    `调用此工具以启动 OAuth 流程 —— 你会收到一个授权 URL，请分享给用户。` +
    `用户在浏览器中完成认证后，该 server 的真实工具会自动变为可用。`

  return {
    name: buildMcpToolName(serverName, 'authenticate'),
    isMcp: true,
    mcpInfo: { serverName, toolName: 'authenticate' },
    isEnabled: () => true,
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    toAutoClassifierInput: () => serverName,
    userFacingName: () => `${serverName} - 认证 (MCP)`,
    maxResultSizeChars: 10_000,
    renderToolUseMessage: () => `认证 ${serverName} MCP server`,
    async description() {
      return description
    },
    async prompt() {
      return description
    },
    get inputSchema(): InputSchema {
      return inputSchema()
    },
    async checkPermissions(input): Promise<PermissionDecision> {
      return { behavior: 'allow', updatedInput: input }
    },
    async call(_input, context) {
      // claude.ai connectors 使用独立的认证流程（MCPRemoteServerMenu 中的
      // handleClaudeAIAuth），我们在此不通过代码触发 —— 只引导用户到 /mcp。
      if (config.type === 'claudeai-proxy') {
        return {
          data: {
            status: 'unsupported' as const,
            message: `这是一个 claude.ai MCP connector。请让用户运行 /mcp 并选择 "${serverName}" 来认证。`,
          },
        }
      }

      // performMCPOAuthFlow 只接受 sse/http。needs-auth 状态仅在
      // HTTP 401（UnauthorizedError）时设置，因此其他传输方式不应到达此处，
      // 但做防御性处理。
      if (config.type !== 'sse' && config.type !== 'http') {
        return {
          data: {
            status: 'unsupported' as const,
            message: `服务器 "${serverName}" 使用 ${transport} 传输方式，此工具不支持其 OAuth。请让用户运行 /mcp 并手动认证。`,
          },
        }
      }

      const sseOrHttpConfig = config as (
        | McpSSEServerConfig
        | McpHTTPServerConfig
      ) & { scope: ScopedMcpServerConfig['scope'] }

      // 镜像 cli/print.ts 的 mcp_authenticate：启动流程，通过
      // onAuthorizationUrl 捕获 URL，立即返回。该流程的 Promise 在浏览器
      // 回调触发后才 resolve。
      let resolveAuthUrl: ((url: string) => void) | undefined
      const authUrlPromise = new Promise<string>(resolve => {
        resolveAuthUrl = resolve
      })

      const controller = new AbortController()
      const { setAppState } = context

      const oauthPromise = performMCPOAuthFlow(
        serverName,
        sseOrHttpConfig,
        u => resolveAuthUrl?.(u),
        controller.signal,
        { skipBrowserOpen: true },
      )

      // 后台延续：OAuth 完成后重连，并将真实工具替换进 appState。
      // 前缀替换会移除该伪工具，因为它共享 mcp__<server>__ 前缀。
      void oauthPromise
        .then(async () => {
          clearMcpAuthCache()
          const result = await reconnectMcpServerImpl(serverName, config)
          const prefix = getMcpPrefix(serverName)
          setAppState(prev => ({
            ...prev,
            mcp: {
              ...prev.mcp,
              clients: prev.mcp.clients.map(c =>
                c.name === serverName ? result.client : c,
              ),
              tools: [
                ...reject(prev.mcp.tools, t => t.name?.startsWith(prefix)),
                ...result.tools,
              ],
              commands: [
                ...reject(prev.mcp.commands, c => c.name?.startsWith(prefix)),
                ...result.commands,
              ],
              resources: result.resources
                ? { ...prev.mcp.resources, [serverName]: result.resources }
                : prev.mcp.resources,
            },
          }))
          logMCPDebug(
            serverName,
            `OAuth 完成，已重连并获得 ${result.tools.length} 个工具`,
          )
        })
        .catch(err => {
          logMCPError(
            serverName,
            `工具触发启动后 OAuth 流程失败：${errorMessage(err)}`,
          )
        })

      try {
        // 竞速：获取 URL，或流程不需要 URL 就完成
        //（例如 XAA 有缓存的 IdP token —— 静默认证）。
        const authUrl = await Promise.race([
          authUrlPromise,
          oauthPromise.then(() => null as string | null),
        ])

        if (authUrl) {
          return {
            data: {
              status: 'auth_url' as const,
              authUrl,
              message: `请让用户在浏览器中打开此 URL 以授权 ${serverName} MCP server：\n\n${authUrl}\n\n用户完成流程后，该 server 的工具会自动变为可用。`,
            },
          }
        }

        return {
          data: {
            status: 'auth_url' as const,
            message: `已为 ${serverName} 静默完成认证。该 server 的工具现在应已可用。`,
          },
        }
      } catch (err) {
        return {
          data: {
            status: 'error' as const,
            message: `为 ${serverName} 启动 OAuth 流程失败：${errorMessage(err)}。请让用户运行 /mcp 并手动认证。`,
          },
        }
      }
    },
    mapToolResultToToolResultBlockParam(data, toolUseID) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: data.message,
      }
    },
  } satisfies Tool<InputSchema, McpAuthOutput>
}
