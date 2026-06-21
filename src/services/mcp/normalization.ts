/**
 * MCP 名称规范化的纯工具函数。
 * 此文件没有任何依赖，以避免循环导入。
 */

// Claude.ai 服务器名称以此字符串作为前缀
const CLAUDEAI_SERVER_PREFIX = 'claude.ai '

/**
 * 将服务器名称规范化，以符合 API 模式 ^[a-zA-Z0-9_-]{1,64}$
 * 将任何无效字符（包括点和空格）替换为下划线。
 *
 * 对于 claude.ai 服务器（名称以 "claude.ai " 开头），还会合并
 * 连续的下划线并去除首尾下划线，以防止干扰 MCP 工具名称中
 * 使用的 __ 分隔符。
 */
export function normalizeNameForMCP(name: string): string {
  let normalized = name.replace(/[^a-zA-Z0-9_-]/g, '_')
  if (name.startsWith(CLAUDEAI_SERVER_PREFIX)) {
    normalized = normalized.replace(/_+/g, '_').replace(/^_|_$/g, '')
  }
  return normalized
}
