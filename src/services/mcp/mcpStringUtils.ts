/**
 * MCP 工具/服务器名称解析的纯字符串工具函数。
 * 此文件没有重度依赖，以保持轻量，
 * 供仅需字符串解析的消费者使用（例如 permissionValidation）。
 */

import { normalizeNameForMCP } from './normalization.js'

/*
 * 从工具名称字符串中提取 MCP 服务器信息
 * @param toolString 要解析的字符串。预期格式："mcp__serverName__toolName"
 * @returns 包含服务器名称和可选工具名称的对象，如果不是有效的 MCP 规则则返回 null
 *
 * 已知限制：如果服务器名称包含 "__"，解析将不正确。
 * 例如，"mcp__my__server__tool" 会被解析为 server="my"，tool="server__tool"，
 * 而不是 server="my__server"，tool="tool"。这在实际中很少见，因为服务器
 * 名称通常不包含双下划线。
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
  // 拼接服务器名称之后的所有部分，以保留工具名称中的双下划线
  const toolName =
    toolNameParts.length > 0 ? toolNameParts.join('__') : undefined
  return { serverName, toolName }
}

/**
 * 为指定服务器生成 MCP 工具/命令名称前缀
 * @param serverName MCP 服务器的名称
 * @returns 前缀字符串
 */
export function getMcpPrefix(serverName: string): string {
  return `mcp__${normalizeNameForMCP(serverName)}__`
}

/**
 * 从服务器名称和工具名称构建完整的 MCP 工具名称。
 * 是 mcpInfoFromString() 的逆操作。
 * @param serverName MCP 服务器名称（未规范化）
 * @param toolName 工具名称（未规范化）
 * @returns 完整限定名称，例如 "mcp__server__tool"
 */
export function buildMcpToolName(serverName: string, toolName: string): string {
  return `${getMcpPrefix(serverName)}${normalizeNameForMCP(toolName)}`
}

/**
 * 返回用于权限规则匹配的名称。
 * 对于 MCP 工具，使用完整的 mcp__server__tool 名称，这样
 * 针对内置工具的拒绝规则（例如 "Write"）就不会匹配共享同一显示名称的
 * 未加前缀的 MCP 替代工具。否则回退到 `tool.name`。
 */
export function getToolNameForPermissionCheck(tool: {
  name: string
  mcpInfo?: { serverName: string; toolName: string }
}): string {
  return tool.mcpInfo
    ? buildMcpToolName(tool.mcpInfo.serverName, tool.mcpInfo.toolName)
    : tool.name
}

/*
 * 从 MCP 工具/命令名称中提取显示名称
 * @param fullName 完整的 MCP 工具/命令名称（例如 "mcp__server_name__tool_name"）
 * @param serverName 要从前缀中移除的服务器名称
 * @returns 去掉 MCP 前缀后的显示名称
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
 * @param userFacingName 完整的面向用户的名称（例如 "github - Add comment to issue (MCP)"）
 * @returns 去掉服务器前缀和 (MCP) 后缀后的显示名称
 */
export function extractMcpToolDisplayName(userFacingName: string): string {
  // 这确实很丑陋，但我们当前的 Tool 类型不容易为不同用途设置不同的显示名称。

  // 首先，移除 (MCP) 后缀（如果存在）
  let withoutSuffix = userFacingName.replace(/\s*\(MCP\)\s*$/, '')

  // 对结果进行去空格处理
  withoutSuffix = withoutSuffix.trim()

  // 然后，移除服务器前缀（" - " 之前的所有内容）
  const dashIndex = withoutSuffix.indexOf(' - ')
  if (dashIndex !== -1) {
    const displayName = withoutSuffix.substring(dashIndex + 3).trim()
    return displayName
  }

  // 如果没找到短横线，返回去掉 (MCP) 后的字符串
  return withoutSuffix
}
