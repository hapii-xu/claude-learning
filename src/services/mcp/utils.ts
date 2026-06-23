import { createHash } from 'crypto'
import { join } from 'path'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'
import type { AgentMcpServerInfo } from '../../components/mcp/types.js'
import type { Tool } from '../../Tool.js'
import type { AgentDefinition } from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import { getCwd } from '../../utils/cwd.js'
import { getGlobalClaudeFile } from '../../utils/env.js'
import { isSettingSourceEnabled } from '../../utils/settings/constants.js'
import {
  getSettings_DEPRECATED,
  hasSkipDangerousModePermissionPrompt,
} from '../../utils/settings/settings.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { getEnterpriseMcpFilePath, getMcpConfigByName } from './config.js'
import { mcpInfoFromString } from './mcpStringUtils.js'
import { normalizeNameForMCP } from './normalization.js'
import {
  type ConfigScope,
  ConfigScopeSchema,
  type MCPServerConnection,
  type McpHTTPServerConfig,
  type McpServerConfig,
  type McpSSEServerConfig,
  type McpStdioServerConfig,
  type McpWebSocketServerConfig,
  type ScopedMcpServerConfig,
  type ServerResource,
} from './types.js'

/**
 * 按 MCP 服务器名称过滤工具
 *
 * @param tools 要过滤的工具数组
 * @param serverName MCP 服务器名称
 * @returns 属于指定服务器的工具
 */
export function filterToolsByServer(tools: Tool[], serverName: string): Tool[] {
  const prefix = `mcp__${normalizeNameForMCP(serverName)}__`
  return tools.filter(tool => tool.name?.startsWith(prefix))
}

/**
 * 当一个命令属于指定的 MCP 服务器时返回 true。
 *
 * MCP **prompts** 的命名格式为 `mcp__<server>__<prompt>`（协议格式约束）；
 * MCP **skills** 的命名格式为 `<server>:<skill>`（与 plugin/嵌套目录 skill
 * 命名一致）。两者都在 `mcp.commands` 中，因此清理和过滤必须匹配
 * 这两种格式。
 */
export function commandBelongsToServer(
  command: Command,
  serverName: string,
): boolean {
  const normalized = normalizeNameForMCP(serverName)
  const name = command.name
  if (!name) return false
  return (
    name.startsWith(`mcp__${normalized}__`) || name.startsWith(`${normalized}:`)
  )
}

/**
 * 按 MCP 服务器名称过滤命令
 * @param commands 要过滤的命令数组
 * @param serverName MCP 服务器名称
 * @returns 属于指定服务器的命令
 */
export function filterCommandsByServer(
  commands: Command[],
  serverName: string,
): Command[] {
  return commands.filter(c => commandBelongsToServer(c, serverName))
}

/**
 * 按服务器过滤 MCP **prompts**（不含 skills）。用于 `/mcp` 菜单的
 * 能力展示——skills 是单独的功能，在 `/skills` 中显示，
 * 因此不应计入 "prompts" 能力徽章。
 *
 * 区分依据是 `loadedFrom === 'mcp'`：MCP skills 会设置此字段，
 * 而 MCP prompts 不会（它们使用 `isMcp: true`）。
 */
export function filterMcpPromptsByServer(
  commands: Command[],
  serverName: string,
): Command[] {
  return commands.filter(
    c =>
      commandBelongsToServer(c, serverName) &&
      !(c.type === 'prompt' && c.loadedFrom === 'mcp'),
  )
}

/**
 * 按 MCP 服务器名称过滤资源
 * @param resources 要过滤的资源数组
 * @param serverName MCP 服务器名称
 * @returns 属于指定服务器的资源
 */
export function filterResourcesByServer(
  resources: ServerResource[],
  serverName: string,
): ServerResource[] {
  return resources.filter(resource => resource.server === serverName)
}

/**
 * 移除属于特定 MCP 服务器的工具
 * @param tools 工具数组
 * @param serverName 要排除的 MCP 服务器名称
 * @returns 不属于指定服务器的工具
 */
export function excludeToolsByServer(
  tools: Tool[],
  serverName: string,
): Tool[] {
  const prefix = `mcp__${normalizeNameForMCP(serverName)}__`
  return tools.filter(tool => !tool.name?.startsWith(prefix))
}

/**
 * 移除属于特定 MCP 服务器的命令
 * @param commands 命令数组
 * @param serverName 要排除的 MCP 服务器名称
 * @returns 不属于指定服务器的命令
 */
export function excludeCommandsByServer(
  commands: Command[],
  serverName: string,
): Command[] {
  return commands.filter(c => !commandBelongsToServer(c, serverName))
}

/**
 * 移除属于特定 MCP 服务器的资源
 * @param resources 服务器资源的 Map
 * @param serverName 要排除的 MCP 服务器名称
 * @returns 移除指定服务器后的资源 Map
 */
export function excludeResourcesByServer(
  resources: Record<string, ServerResource[]>,
  serverName: string,
): Record<string, ServerResource[]> {
  const result = { ...resources }
  delete result[serverName]
  return result
}

/**
 * MCP 服务器配置的稳定哈希值，用于 /reload-plugins 时的变更检测。
 * 排除 `scope`（是来源信息，不是内容——将服务器从 .mcp.json
 * 移到 settings.json 不应触发重连）。键名排序确保 `{a:1,b:2}` 和
 * `{b:2,a:1}` 产生相同的哈希。
 */
export function hashMcpConfig(config: ScopedMcpServerConfig): string {
  const { scope: _scope, ...rest } = config
  const stable = jsonStringify(rest, (_k, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>
      const sorted: Record<string, unknown> = {}
      for (const k of Object.keys(obj).sort()) sorted[k] = obj[k]
      return sorted
    }
    return v
  })
  return createHash('sha256').update(stable).digest('hex').slice(0, 16)
}

/**
 * 移除过期的 MCP 客户端及其工具/命令/资源。客户端被视为过期，如果：
 *   - scope 为 'dynamic' 且名称不再在 configs 中（插件已禁用），或
 *   - 配置哈希值已变更（在 .mcp.json 中编辑了 args/url/env）—— 任何 scope
 *
 * 移除场景限定于 'dynamic'，这样 /reload-plugins 不会意外断开
 * 用户配置的、只是暂时不在内存配置中的服务器（例如在部分重载期间）。
 * 配置变更场景适用于所有 scope——如果磁盘上的配置确实发生了变更，
 * 重连正是你期望的行为。
 *
 * 返回过期的客户端，以便调用方断开它们（clearServerCache）。
 */
export function excludeStalePluginClients(
  mcp: {
    clients: MCPServerConnection[]
    tools: Tool[]
    commands: Command[]
    resources: Record<string, ServerResource[]>
  },
  configs: Record<string, ScopedMcpServerConfig>,
): {
  clients: MCPServerConnection[]
  tools: Tool[]
  commands: Command[]
  resources: Record<string, ServerResource[]>
  stale: MCPServerConnection[]
} {
  const stale = mcp.clients.filter(c => {
    const fresh = configs[c.name]
    if (!fresh) return c.config.scope === 'dynamic'
    return hashMcpConfig(c.config) !== hashMcpConfig(fresh)
  })
  if (stale.length === 0) {
    return { ...mcp, stale: [] }
  }

  let { tools, commands, resources } = mcp
  for (const s of stale) {
    tools = excludeToolsByServer(tools, s.name)
    commands = excludeCommandsByServer(commands, s.name)
    resources = excludeResourcesByServer(resources, s.name)
  }
  const staleNames = new Set(stale.map(c => c.name))

  return {
    clients: mcp.clients.filter(c => !staleNames.has(c.name)),
    tools,
    commands,
    resources,
    stale,
  }
}

/**
 * 检查工具名称是否属于特定的 MCP 服务器
 * @param toolName 要检查的工具名称
 * @param serverName 要匹配的服务器名称
 * @returns 如果工具属于指定服务器则返回 true
 */
export function isToolFromMcpServer(
  toolName: string,
  serverName: string,
): boolean {
  const info = mcpInfoFromString(toolName)
  return info?.serverName === serverName
}

/**
 * 检查工具是否属于任意 MCP 服务器
 * @param tool 要检查的工具
 * @returns 如果工具来自 MCP 服务器则返回 true
 */
export function isMcpTool(tool: Tool): boolean {
  return tool.name?.startsWith('mcp__') || tool.isMcp === true
}

/**
 * 检查命令是否属于任意 MCP 服务器
 * @param command 要检查的命令
 * @returns 如果命令来自 MCP 服务器则返回 true
 */
export function isMcpCommand(command: Command): boolean {
  return command.name?.startsWith('mcp__') || command.isMcp === true
}

/**
 * 描述给定 MCP 配置作用域的文件路径。
 * @param scope 配置作用域（'user'、'project'、'local' 或 'dynamic'）
 * @returns 配置存储位置的描述
 */
export function describeMcpConfigFilePath(scope: ConfigScope): string {
  switch (scope) {
    case 'user':
      return getGlobalClaudeFile()
    case 'project':
      return join(getCwd(), '.mcp.json')
    case 'local':
      return `${getGlobalClaudeFile()} [project: ${getCwd()}]`
    case 'dynamic':
      return 'Dynamically configured'
    case 'enterprise':
      return getEnterpriseMcpFilePath()
    case 'claudeai':
      return 'claude.ai'
    default:
      return scope
  }
}

export function getScopeLabel(scope: ConfigScope): string {
  switch (scope) {
    case 'local':
      return 'Local config (private to you in this project)'
    case 'project':
      return 'Project config (shared via .mcp.json)'
    case 'user':
      return 'User config (available in all your projects)'
    case 'dynamic':
      return 'Dynamic config (from command line)'
    case 'enterprise':
      return 'Enterprise config (managed by your organization)'
    case 'claudeai':
      return 'claude.ai config'
    default:
      return scope
  }
}

export function ensureConfigScope(scope?: string): ConfigScope {
  if (!scope) return 'local'

  if (!ConfigScopeSchema().options.includes(scope as ConfigScope)) {
    throw new Error(
      `Invalid scope: ${scope}. Must be one of: ${ConfigScopeSchema().options.join(', ')}`,
    )
  }

  return scope as ConfigScope
}

export function ensureTransport(type?: string): 'stdio' | 'sse' | 'http' {
  if (!type) return 'stdio'

  if (type !== 'stdio' && type !== 'sse' && type !== 'http') {
    throw new Error(
      `Invalid transport type: ${type}. Must be one of: stdio, sse, http`,
    )
  }

  return type as 'stdio' | 'sse' | 'http'
}

export function parseHeaders(headerArray: string[]): Record<string, string> {
  const headers: Record<string, string> = {}

  for (const header of headerArray) {
    const colonIndex = header.indexOf(':')
    if (colonIndex === -1) {
      throw new Error(
        `Invalid header format: "${header}". Expected format: "Header-Name: value"`,
      )
    }

    const key = header.substring(0, colonIndex).trim()
    const value = header.substring(colonIndex + 1).trim()

    if (!key) {
      throw new Error(
        `Invalid header: "${header}". Header name cannot be empty.`,
      )
    }

    headers[key] = value
  }

  return headers
}

export function getProjectMcpServerStatus(
  serverName: string,
): 'approved' | 'rejected' | 'pending' {
  const settings = getSettings_DEPRECATED()
  const normalizedName = normalizeNameForMCP(serverName)

  // TODO: 如果去掉 ?. 会导致端到端测试失败。这可能是端到端测试本身的 bug。
  // 将在后续 PR 中修复。
  if (
    settings?.disabledMcpjsonServers?.some(
      name => normalizeNameForMCP(name) === normalizedName,
    )
  ) {
    return 'rejected'
  }

  if (
    settings?.enabledMcpjsonServers?.some(
      name => normalizeNameForMCP(name) === normalizedName,
    ) ||
    settings?.enableAllProjectMcpServers
  ) {
    return 'approved'
  }

  // 在绕过权限模式（--dangerously-skip-permissions）下，无法显示
  // 审批弹窗。如果 projectSettings 已启用则自动批准，因为
  // 用户已明确选择绕过所有权限检查。
  // 安全性：我们特意仅通过 hasSkipDangerousModePermissionPrompt() 来检查
  // skipDangerousModePermissionPrompt，该函数从 userSettings/localSettings/
  // flagSettings/policySettings 中读取，但不从 projectSettings（仓库级
  // .hclaude/settings.json）中读取。这是有意为之：仓库不应能代表用户
  // 接受绕过对话框。我们也不在这里检查 getSessionBypassPermissionsMode()，
  // 因为 sessionBypassPermissionsMode 可能在对话框显示之前就从项目设置中被设置，
  // 这将允许通过恶意项目设置进行 RCE 攻击。
  if (
    hasSkipDangerousModePermissionPrompt() &&
    isSettingSourceEnabled('projectSettings')
  ) {
    return 'approved'
  }

  // 在非交互模式（SDK、claude -p、管道输入）下，无法显示
  // 审批弹窗。如果 projectSettings 已启用则自动批准，因为：
  // 1. 用户/开发者明确选择了在此模式下运行
  // 2. 对于 SDK，projectSettings 默认关闭——必须显式启用
  // 3. 对于 -p 模式，帮助文本警告仅在受信任目录中使用
  if (
    getIsNonInteractiveSession() &&
    isSettingSourceEnabled('projectSettings')
  ) {
    return 'approved'
  }

  return 'pending'
}

/**
 * 从工具名称获取 MCP 服务器的作用域/设置来源
 * @param toolName MCP 工具名称（格式：mcp__serverName__toolName）
 * @returns ConfigScope，如果不是 MCP 工具或服务器未找到则返回 null
 */
export function getMcpServerScopeFromToolName(
  toolName: string,
): ConfigScope | null {
  if (!isMcpTool({ name: toolName } as Tool)) {
    return null
  }

  // 从工具名称中提取服务器名称（格式：mcp__serverName__toolName）
  const mcpInfo = mcpInfoFromString(toolName)
  if (!mcpInfo) {
    return null
  }

  // 查找服务器配置
  const serverConfig = getMcpConfigByName(mcpInfo.serverName)

  // 回退：claude.ai 服务器的规范化名称以 "claude_ai_" 开头
  // 但不在 getMcpConfigByName 中（它们是单独异步获取的）
  if (!serverConfig && mcpInfo.serverName.startsWith('claude_ai_')) {
    return 'claudeai'
  }

  return serverConfig?.scope ?? null
}

// MCP 服务器配置类型的类型守卫
function isStdioConfig(
  config: McpServerConfig,
): config is McpStdioServerConfig {
  return config.type === 'stdio' || config.type === undefined
}

function isSSEConfig(config: McpServerConfig): config is McpSSEServerConfig {
  return config.type === 'sse'
}

function isHTTPConfig(config: McpServerConfig): config is McpHTTPServerConfig {
  return config.type === 'http'
}

function isWebSocketConfig(
  config: McpServerConfig,
): config is McpWebSocketServerConfig {
  return config.type === 'ws'
}

/**
 * 从 agent frontmatter 中提取 MCP 服务器定义并按服务器名称分组。
 * 用于在 /mcp 命令中显示 agent 特定的 MCP 服务器。
 *
 * @param agents agent 定义数组
 * @returns AgentMcpServerInfo 数组，按服务器名称分组并包含来源 agent 列表
 */
export function extractAgentMcpServers(
  agents: AgentDefinition[],
): AgentMcpServerInfo[] {
  // 映射：服务器名称 -> { config, sourceAgents }
  const serverMap = new Map<
    string,
    {
      config: McpServerConfig & { name: string }
      sourceAgents: string[]
    }
  >()

  for (const agent of agents) {
    if (!agent.mcpServers?.length) continue

    for (const spec of agent.mcpServers) {
      // 跳过字符串引用——这些引用的是已在全局配置中的服务器
      if (typeof spec === 'string') continue

      // 内联定义为 { [name]: config }
      const entries = Object.entries(spec)
      if (entries.length !== 1) continue

      const [serverName, serverConfig] = entries[0]!
      const existing = serverMap.get(serverName)

      if (existing) {
        // 将此 agent 添加为另一个来源
        if (!existing.sourceAgents.includes(agent.agentType)) {
          existing.sourceAgents.push(agent.agentType)
        }
      } else {
        // 新服务器
        serverMap.set(serverName, {
          config: { ...serverConfig, name: serverName } as McpServerConfig & {
            name: string
          },
          sourceAgents: [agent.agentType],
        })
      }
    }
  }

  // 将 map 转换为 AgentMcpServerInfo 数组
  // 仅包含 AgentMcpServerInfo 支持的传输类型
  const result: AgentMcpServerInfo[] = []
  for (const [name, { config, sourceAgents }] of serverMap) {
    // 使用类型守卫正确收窄判别联合类型
    // 仅包含 AgentMcpServerInfo 支持的传输类型
    if (isStdioConfig(config)) {
      result.push({
        name,
        sourceAgents,
        transport: 'stdio',
        command: config.command,
        needsAuth: false,
      })
    } else if (isSSEConfig(config)) {
      result.push({
        name,
        sourceAgents,
        transport: 'sse',
        url: config.url,
        needsAuth: true,
      })
    } else if (isHTTPConfig(config)) {
      result.push({
        name,
        sourceAgents,
        transport: 'http',
        url: config.url,
        needsAuth: true,
      })
    } else if (isWebSocketConfig(config)) {
      result.push({
        name,
        sourceAgents,
        transport: 'ws',
        url: config.url,
        needsAuth: false,
      })
    }
    // 跳过不支持的传输类型（sdk、claudeai-proxy、sse-ide、ws-ide）
    // 这些是内部类型，不用于 agent MCP 服务器显示
  }

  return result.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * 提取 MCP 服务器基础 URL（不含查询字符串），用于分析日志记录。
 * 查询字符串会被移除，因为它们可能包含访问令牌。
 * 尾部斜杠也会被移除以实现规范化。
 * 对于 stdio/sdk 服务器或 URL 解析失败时返回 undefined。
 */
export function getLoggingSafeMcpBaseUrl(
  config: McpServerConfig,
): string | undefined {
  if (!('url' in config) || typeof config.url !== 'string') {
    return undefined
  }

  try {
    const url = new URL(config.url)
    url.search = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return undefined
  }
}
