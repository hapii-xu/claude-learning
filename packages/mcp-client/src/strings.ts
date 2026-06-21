// MCP 字符串工具函数 — 纯函数，无依赖
// 提取自 src/services/mcp/mcpStringUtils.ts 和 normalization.ts

// Claude.ai 服务器名称此前缀开头
const CLAUDEAI_SERVER_PREFIX = 'claude.ai '

/**
 * 规范化服务器名称以符合 API 模式 ^[a-zA-Z0-9_-]{1,64}$
 * 将任何无效字符（包括点和空格）替换为下划线。
 */
export function normalizeNameForMCP(name: string): string {
  let normalized = name.replace(/[^a-zA-Z0-9_-]/g, '_')
  if (name.startsWith(CLAUDEAI_SERVER_PREFIX)) {
    normalized = normalized.replace(/_+/g, '_').replace(/^_|_$/g, '')
  }
  return normalized
}

/**
 * 生成给定服务器的 MCP 工具/命令名称前缀
 */
export function getMcpPrefix(serverName: string): string {
  return `mcp__${normalizeNameForMCP(serverName)}__`
}

/**
 * 从服务器名称和工具名称构建完全限定的 MCP 工具名称。
 * mcpInfoFromString() 的逆操作。
 */
export function buildMcpToolName(serverName: string, toolName: string): string {
  return `${getMcpPrefix(serverName)}${normalizeNameForMCP(toolName)}`
}

/**
 * 从工具名称字符串中提取 MCP 服务器信息。
 * @param toolString 预期格式："mcp__serverName__toolName"
 */
export function mcpInfoFromString(toolString: string): {
  serverName: string
  toolName: string | undefined
} | null {
  const parts = toolString.split('__')
  const [mcpPart, serverName, ...toolNameParts] = parts
  if (mcpPart !== 'mcp' || !serverName) {
    return null
  }
  const toolName =
    toolNameParts.length > 0 ? toolNameParts.join('__') : undefined
  return { serverName, toolName }
}

/**
 * 返回用于权限规则匹配的名称。
 */
export function getToolNameForPermissionCheck(tool: {
  name: string
  mcpInfo?: { serverName: string; toolName: string }
}): string {
  return tool.mcpInfo
    ? buildMcpToolName(tool.mcpInfo.serverName, tool.mcpInfo.toolName)
    : tool.name
}

/**
 * 从 MCP 工具/命令名称中提取显示名称
 */
export function getMcpDisplayName(
  fullName: string,
  serverName: string,
): string {
  const prefix = `mcp__${normalizeNameForMCP(serverName)}__`
  return fullName.replace(prefix, '')
}

/**
 * 从 userFacingName 中仅提取工具/命令的显示名称
 */
export function extractMcpToolDisplayName(userFacingName: string): string {
  let withoutSuffix = userFacingName.replace(/\s*\(MCP\)\s*$/, '')
  withoutSuffix = withoutSuffix.trim()
  const dashIndex = withoutSuffix.indexOf(' - ')
  if (dashIndex !== -1) {
    return withoutSuffix.substring(dashIndex + 3).trim()
  }
  return withoutSuffix
}
