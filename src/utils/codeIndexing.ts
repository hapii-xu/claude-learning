/**
 * 检测代码索引工具使用情况的工具函数。
 *
 * 追踪常见代码索引解决方案（如 Sourcegraph、Cody 等）的使用情况，
 * 包括 CLI 命令和 MCP 服务器集成。
 */

/**
 * 已知的代码索引工具标识符。
 * 这些是分析事件中使用的规范化名称。
 */
export type CodeIndexingTool =
  // 代码搜索引擎
  | 'sourcegraph'
  | 'hound'
  | 'seagoat'
  | 'bloop'
  | 'gitloop'
  // 带索引的 AI 编程助手
  | 'cody'
  | 'aider'
  | 'continue'
  | 'github-copilot'
  | 'cursor'
  | 'tabby'
  | 'codeium'
  | 'tabnine'
  | 'augment'
  | 'windsurf'
  | 'aide'
  | 'pieces'
  | 'qodo'
  | 'amazon-q'
  | 'gemini'
  // MCP 代码索引服务器
  | 'claude-context'
  | 'code-index-mcp'
  | 'local-code-search'
  | 'autodev-codebase'
  // 上下文提供者
  | 'openctx'

/**
 * CLI 命令前缀到代码索引工具的映射。
 * 键为命令名（命令的第一个词）。
 */
const CLI_COMMAND_MAPPING: Record<string, CodeIndexingTool> = {
  // Sourcegraph 生态
  src: 'sourcegraph',
  cody: 'cody',
  // AI 编程助手
  aider: 'aider',
  tabby: 'tabby',
  tabnine: 'tabnine',
  augment: 'augment',
  pieces: 'pieces',
  qodo: 'qodo',
  aide: 'aide',
  // 代码搜索工具
  hound: 'hound',
  seagoat: 'seagoat',
  bloop: 'bloop',
  gitloop: 'gitloop',
  // 云厂商 AI 助手
  q: 'amazon-q',
  gemini: 'gemini',
}

/**
 * MCP 服务器名称模式到代码索引工具的映射。
 * 模式以不区分大小写的方式匹配服务器名。
 */
const MCP_SERVER_PATTERNS: Array<{
  pattern: RegExp
  tool: CodeIndexingTool
}> = [
  // Sourcegraph 生态
  { pattern: /^sourcegraph$/i, tool: 'sourcegraph' },
  { pattern: /^cody$/i, tool: 'cody' },
  { pattern: /^openctx$/i, tool: 'openctx' },
  // AI 编程助手
  { pattern: /^aider$/i, tool: 'aider' },
  { pattern: /^continue$/i, tool: 'continue' },
  { pattern: /^github[-_]?copilot$/i, tool: 'github-copilot' },
  { pattern: /^copilot$/i, tool: 'github-copilot' },
  { pattern: /^cursor$/i, tool: 'cursor' },
  { pattern: /^tabby$/i, tool: 'tabby' },
  { pattern: /^codeium$/i, tool: 'codeium' },
  { pattern: /^tabnine$/i, tool: 'tabnine' },
  { pattern: /^augment[-_]?code$/i, tool: 'augment' },
  { pattern: /^augment$/i, tool: 'augment' },
  { pattern: /^windsurf$/i, tool: 'windsurf' },
  { pattern: /^aide$/i, tool: 'aide' },
  { pattern: /^codestory$/i, tool: 'aide' },
  { pattern: /^pieces$/i, tool: 'pieces' },
  { pattern: /^qodo$/i, tool: 'qodo' },
  { pattern: /^amazon[-_]?q$/i, tool: 'amazon-q' },
  { pattern: /^gemini[-_]?code[-_]?assist$/i, tool: 'gemini' },
  { pattern: /^gemini$/i, tool: 'gemini' },
  // 代码搜索工具
  { pattern: /^hound$/i, tool: 'hound' },
  { pattern: /^seagoat$/i, tool: 'seagoat' },
  { pattern: /^bloop$/i, tool: 'bloop' },
  { pattern: /^gitloop$/i, tool: 'gitloop' },
  // MCP 代码索引服务器
  { pattern: /^claude[-_]?context$/i, tool: 'claude-context' },
  { pattern: /^code[-_]?index[-_]?mcp$/i, tool: 'code-index-mcp' },
  { pattern: /^code[-_]?index$/i, tool: 'code-index-mcp' },
  { pattern: /^local[-_]?code[-_]?search$/i, tool: 'local-code-search' },
  { pattern: /^codebase$/i, tool: 'autodev-codebase' },
  { pattern: /^autodev[-_]?codebase$/i, tool: 'autodev-codebase' },
  { pattern: /^code[-_]?context$/i, tool: 'claude-context' },
]

/**
 * 检测 bash 命令是否在使用代码索引 CLI 工具。
 *
 * @param command - 完整的 bash 命令字符串
 * @returns 代码索引工具标识符，非代码索引命令则返回 undefined
 *
 * @example
 * detectCodeIndexingFromCommand('src search "pattern"') // 返回 'sourcegraph'
 * detectCodeIndexingFromCommand('cody chat --message "help"') // 返回 'cody'
 * detectCodeIndexingFromCommand('ls -la') // 返回 undefined
 */
export function detectCodeIndexingFromCommand(
  command: string,
): CodeIndexingTool | undefined {
  // 提取第一个词（命令名）
  const trimmed = command.trim()
  const firstWord = trimmed.split(/\s+/)[0]?.toLowerCase()

  if (!firstWord) {
    return undefined
  }

  // 检查 npx/bunx 前缀的命令
  if (firstWord === 'npx' || firstWord === 'bunx') {
    const secondWord = trimmed.split(/\s+/)[1]?.toLowerCase()
    if (secondWord && secondWord in CLI_COMMAND_MAPPING) {
      return CLI_COMMAND_MAPPING[secondWord]
    }
  }

  return CLI_COMMAND_MAPPING[firstWord]
}

/**
 * 检测 MCP 工具是否来自代码索引服务器。
 *
 * @param toolName - MCP 工具名（格式：mcp__serverName__toolName）
 * @returns 代码索引工具标识符，非代码索引工具则返回 undefined
 *
 * @example
 * detectCodeIndexingFromMcpTool('mcp__sourcegraph__search') // 返回 'sourcegraph'
 * detectCodeIndexingFromMcpTool('mcp__cody__chat') // 返回 'cody'
 * detectCodeIndexingFromMcpTool('mcp__filesystem__read') // 返回 undefined
 */
export function detectCodeIndexingFromMcpTool(
  toolName: string,
): CodeIndexingTool | undefined {
  // MCP 工具名遵循格式：mcp__serverName__toolName
  if (!toolName.startsWith('mcp__')) {
    return undefined
  }

  const parts = toolName.split('__')
  if (parts.length < 3) {
    return undefined
  }

  const serverName = parts[1]
  if (!serverName) {
    return undefined
  }

  for (const { pattern, tool } of MCP_SERVER_PATTERNS) {
    if (pattern.test(serverName)) {
      return tool
    }
  }

  return undefined
}

/**
 * 检测 MCP 服务器名是否对应代码索引工具。
 *
 * @param serverName - MCP 服务器名
 * @returns 代码索引工具标识符，非代码索引服务器则返回 undefined
 *
 * @example
 * detectCodeIndexingFromMcpServerName('sourcegraph') // 返回 'sourcegraph'
 * detectCodeIndexingFromMcpServerName('filesystem') // 返回 undefined
 */
export function detectCodeIndexingFromMcpServerName(
  serverName: string,
): CodeIndexingTool | undefined {
  for (const { pattern, tool } of MCP_SERVER_PATTERNS) {
    if (pattern.test(serverName)) {
      return tool
    }
  }

  return undefined
}
