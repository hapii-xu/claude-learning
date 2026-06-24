import { feature } from 'bun:bundle'
import { normalize, posix, win32 } from 'path'
import {
  getAutoMemPath,
  getMemoryBaseDir,
  isAutoMemoryEnabled,
  isAutoMemPath,
} from '../memdir/paths.js'
import { isAgentMemoryPath } from '@claude-code-best/builtin-tools/tools/AgentTool/agentMemory.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import {
  posixPathToWindowsPath,
  windowsPathToPosixPath,
} from './windowsPaths.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const teamMemPaths = feature('TEAMMEM')
  ? (require('../memdir/teamMemPaths.js') as typeof import('../memdir/teamMemPaths.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

const IS_WINDOWS = process.platform === 'win32'

// 将路径分隔符规范化为 posix（/）格式。不翻译驱动器编码。
function toPosix(p: string): string {
  return p.split(win32.sep).join(posix.sep)
}

// 将路径转为稳定可字符串比较的形式：正斜杠分隔，
// 在 Windows 上额外转为小写（Windows 文件系统不区分大小写）。
function toComparable(p: string): string {
  const posixForm = toPosix(p)
  return IS_WINDOWS ? posixForm.toLowerCase() : posixForm
}

/**
 * 检测文件路径是否为 ~/.hclaude 下与会话相关的文件。
 * 返回会话文件类型，若不是会话文件则返回 null。
 */
export function detectSessionFileType(
  filePath: string,
): 'session_memory' | 'session_transcript' | null {
  const configDir = getClaudeConfigHomeDir()
  // 以正斜杠形式比较；在 Windows 上还要进行大小写折叠。调用方
  //（isShellCommandTargetingMemory）在到达此处前会将 MinGW /c/... 转为原生路径，
  // 因此这里只需要分隔符 + 大小写规范化。
  const normalized = toComparable(filePath)
  const configDirCmp = toComparable(configDir)
  if (!normalized.startsWith(configDirCmp)) {
    return null
  }
  if (normalized.includes('/session-memory/') && normalized.endsWith('.md')) {
    return 'session_memory'
  }
  if (normalized.includes('/projects/') && normalized.endsWith('.jsonl')) {
    return 'session_transcript'
  }
  return null
}

/**
 * 检查 glob/pattern 字符串是否表示会话文件访问意图。
 * 用于 Grep/Glob 工具，此处检查的是模式而非实际文件路径。
 */
export function detectSessionPatternType(
  pattern: string,
): 'session_memory' | 'session_transcript' | null {
  const normalized = pattern.split(win32.sep).join(posix.sep)
  if (
    normalized.includes('session-memory') &&
    (normalized.includes('.md') || normalized.endsWith('*'))
  ) {
    return 'session_memory'
  }
  if (
    normalized.includes('.jsonl') ||
    (normalized.includes('projects') && normalized.includes('*.jsonl'))
  ) {
    return 'session_transcript'
  }
  return null
}

/**
 * 检查文件路径是否在 memdir 目录内。
 */
export function isAutoMemFile(filePath: string): boolean {
  if (isAutoMemoryEnabled()) {
    return isAutoMemPath(filePath)
  }
  return false
}

export type MemoryScope = 'personal' | 'team'

/**
 * 判断路径属于哪个内存存储（如果有）。
 *
 * team 目录是 memdir 的子目录（getTeamMemPath = join(getAutoMemPath, 'team')），
 * 因此 team 路径同时匹配 isTeamMemFile 和 isAutoMemFile。优先检查 team。
 *
 * 用于按 scope 字段区分的遥测事件——现有的 tengu_memdir_* / tengu_team_mem_*
 * 事件名层次以不同方式处理重叠（team 写入会有意同时触发两者）。
 */
export function memoryScopeForPath(filePath: string): MemoryScope | null {
  if (feature('TEAMMEM') && teamMemPaths!.isTeamMemFile(filePath)) {
    return 'team'
  }
  if (isAutoMemFile(filePath)) {
    return 'personal'
  }
  return null
}

/**
 * 检查文件路径是否在 agent 内存目录内。
 */
function isAgentMemFile(filePath: string): boolean {
  if (isAutoMemoryEnabled()) {
    return isAgentMemoryPath(filePath)
  }
  return false
}

/**
 * 检查文件是否为 Claude 托管的内存文件（不含用户管理的指令文件）。
 * 包含：自动内存（memdir）、agent 内存、会话内存/记录。
 * 排除：CLAUDE.md、CLAUDE.local.md、.hclaude/rules/*.md（用户管理）。
 *
 * 用于折叠/徽章逻辑，用户管理的文件应显示完整 diff。
 */
export function isAutoManagedMemoryFile(filePath: string): boolean {
  if (isAutoMemFile(filePath)) {
    return true
  }
  if (feature('TEAMMEM') && teamMemPaths!.isTeamMemFile(filePath)) {
    return true
  }
  if (detectSessionFileType(filePath) !== null) {
    return true
  }
  if (isAgentMemFile(filePath)) {
    return true
  }
  return false
}

// 检查目录路径是否为内存相关目录。
// 供 Grep/Glob 使用，它们接受目录 `path` 而非具体文件。
// 同时检查 configDir 和 memoryBaseDir 以处理自定义内存目录路径。
export function isMemoryDirectory(dirPath: string): boolean {
  // 安全：规范化路径以防止通过 .. 段进行路径穿越绕过。
  // 在 Windows 上会生成反斜杠；toComparable 将其翻转回正斜杠以用于字符串匹配。
  // MinGW /c/... 路径在到达此处前（isShellCommandTargetingMemory 提取阶段）
  // 已被转换为原生路径，因此 normalize() 不会看到它们。
  const normalizedPath = normalize(dirPath)
  const normalizedCmp = toComparable(normalizedPath)
  // Agent 内存目录可位于 cwd（项目作用域）、configDir 或 memoryBaseDir 下
  if (
    isAutoMemoryEnabled() &&
    (normalizedCmp.includes('/agent-memory/') ||
      normalizedCmp.includes('/agent-memory-local/'))
  ) {
    return true
  }
  // team 内存目录位于 <autoMemPath>/team/ 下
  if (
    feature('TEAMMEM') &&
    teamMemPaths!.isTeamMemoryEnabled() &&
    teamMemPaths!.isTeamMemPath(normalizedPath)
  ) {
    return true
  }
  // 检查自动内存路径覆盖（CLAUDE_COWORK_MEMORY_PATH_OVERRIDE）
  if (isAutoMemoryEnabled()) {
    const autoMemPath = getAutoMemPath()
    const autoMemDirCmp = toComparable(autoMemPath.replace(/[/\\]+$/, ''))
    const autoMemPathCmp = toComparable(autoMemPath)
    if (
      normalizedCmp === autoMemDirCmp ||
      normalizedCmp.startsWith(autoMemPathCmp)
    ) {
      return true
    }
  }

  const configDirCmp = toComparable(getClaudeConfigHomeDir())
  const memoryBaseCmp = toComparable(getMemoryBaseDir())
  const underConfig = normalizedCmp.startsWith(configDirCmp)
  const underMemoryBase = normalizedCmp.startsWith(memoryBaseCmp)

  if (!underConfig && !underMemoryBase) {
    return false
  }
  if (normalizedCmp.includes('/session-memory/')) {
    return true
  }
  if (underConfig && normalizedCmp.includes('/projects/')) {
    return true
  }
  if (isAutoMemoryEnabled() && normalizedCmp.includes('/memory/')) {
    return true
  }
  return false
}

/**
 * 通过提取绝对路径 token 并与内存检测函数对比，
 * 检查 shell 命令字符串（Bash 或 PowerShell）是否以内存文件为目标。
 * 用于折叠逻辑中 Bash/PowerShell grep/search 命令的检测。
 */
export function isShellCommandTargetingMemory(command: string): boolean {
  const configDir = getClaudeConfigHomeDir()
  const memoryBase = getMemoryBaseDir()
  const autoMemDir = isAutoMemoryEnabled()
    ? getAutoMemPath().replace(/[/\\]+$/, '')
    : ''

  // 快速检查：命令是否提及 config、memory base 或 auto-mem 目录？
  // 以正斜杠形式比较（Windows 上的 PowerShell 可能使用任意分隔符，
  // 而 configDir 使用平台原生分隔符）。
  // 在 Windows 上还要检查 MinGW 形式（/c/...），因为 BashTool 在
  // Git Bash 下运行，它会输出该编码。在 Linux/Mac 上，configDir 已是
  // posix 形式，只需检查一种形式——关键是 windowsPathToPosixPath
  // 不会被调用，以防 Linux 路径如 /m/foo 被误解为 MinGW。
  const commandCmp = toComparable(command)
  const dirs = [configDir, memoryBase, autoMemDir].filter(Boolean)
  const matchesAnyDir = dirs.some(d => {
    if (commandCmp.includes(toComparable(d))) return true
    if (IS_WINDOWS) {
      // BashTool on Windows (Git Bash) emits /c/Users/... — check MinGW form too
      return commandCmp.includes(windowsPathToPosixPath(d).toLowerCase())
    }
    return false
  })
  if (!matchesAnyDir) {
    return false
  }

  // 提取绝对路径类 token。匹配 Unix 绝对路径（/foo/bar）、
  // Windows 驱动器路径（C:\foo, C:/foo）和 MinGW 路径（/c/foo——
  // 以 / 开头，正则已可捕获）。裸反斜杠 token（\foo）被有意排除——
  // 它们出现在正则/grep 模式中，规范化将反斜杠翻转为正斜杠后会导致内存误分类。
  const matches = command.match(/(?:[A-Za-z]:[/\\]|\/)[^\s'"]+/g)
  if (!matches) {
    return false
  }

  for (const match of matches) {
    // 去除可能紧邻路径的尾部 shell 元字符
    const cleanPath = match.replace(/[,;|&>]+$/, '')
    // 在 Windows 上，在此单一位置将 MinGW /c/... 转换为原生 C:\...。
    // 下游谓词（isAutoManagedMemoryFile、isMemoryDirectory、
    // isAutoMemPath、isAgentMemoryPath）随后接收原生路径，
    // 只需 toComparable() 即可匹配。在其他平台上，路径已是原生形式——
    // 无需转换，/m/foo 等直接透传不变。
    const nativePath = IS_WINDOWS
      ? posixPathToWindowsPath(cleanPath)
      : cleanPath
    if (isAutoManagedMemoryFile(nativePath) || isMemoryDirectory(nativePath)) {
      return true
    }
  }

  return false
}

// 检查 glob/pattern 是否仅以自动管理的内存文件为目标。
// 排除 CLAUDE.md、CLAUDE.local.md、.hclaude/rules/（用户管理）。
// 用于折叠徽章逻辑，用户管理的文件不应被计为"内存"操作。
export function isAutoManagedMemoryPattern(pattern: string): boolean {
  if (detectSessionPatternType(pattern) !== null) {
    return true
  }
  if (
    isAutoMemoryEnabled() &&
    (pattern.replace(/\\/g, '/').includes('agent-memory/') ||
      pattern.replace(/\\/g, '/').includes('agent-memory-local/'))
  ) {
    return true
  }
  return false
}
