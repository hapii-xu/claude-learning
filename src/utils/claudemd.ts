/**
 * 文件按以下顺序加载：
 *
 * 1. 托管内存（如 /etc/claude-code/CLAUDE.md）—— 所有用户的全局指令
 * 2. 用户内存（~/.claude/CLAUDE.md）—— 所有项目的私人全局指令
 * 3. 项目内存（项目根目录中的 CLAUDE.md、.claude/CLAUDE.md 和 .claude/rules/*.md）—— 签入代码库的指令
 * 4. 本地内存（项目根目录中的 CLAUDE.local.md）—— 私人项目特定指令
 *
 * 文件按优先级相反的顺序加载，即后加载的文件优先级最高，
 * 模型会更关注它们。
 *
 * 文件发现：
 * - 用户内存从用户主目录加载
 * - 项目和本地文件通过从当前目录向上遍历到根目录来发现
 * - 越靠近当前目录的文件优先级越高（后加载）
 * - 每个目录中检查 CLAUDE.md、.claude/CLAUDE.md 和 .claude/rules/ 下的所有 .md 文件作为项目内存
 *
 * 内存 @include 指令：
 * - 内存文件可以使用 @ 符号包含其他文件
 * - 语法：@path、@./相对路径、@~/主目录路径 或 @/绝对路径
 * - @path（无前缀）被视为相对路径（同 @./path）
 * - 仅在叶文本节点中生效（不在代码块或代码字符串内）
 * - 被包含的文件作为单独条目添加到包含文件之前
 * - 通过跟踪已处理文件来防止循环引用
 * - 不存在的文件会被静默忽略
 */

import { feature } from 'bun:bundle'
import ignore from 'ignore'
import memoize from 'lodash-es/memoize.js'
import { Lexer } from 'marked'
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  parse,
  relative,
} from 'path'
import picomatch from 'picomatch'
import { logEvent } from 'src/services/analytics/index.js'
import {
  getAdditionalDirectoriesForClaudeMd,
  getOriginalCwd,
} from '../bootstrap/state.js'
import { truncateEntrypointContent } from '../memdir/memdir.js'
import { getAutoMemEntrypoint, isAutoMemoryEnabled } from '../memdir/paths.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import {
  getCurrentProjectConfig,
  getManagedClaudeRulesDir,
  getMemoryPath,
  getUserClaudeRulesDir,
} from './config.js'
import { logForDebugging } from './debug.js'
import { logForDiagnosticsNoPII } from './diagLogs.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from './envUtils.js'
import { getErrnoCode } from './errors.js'
import { normalizePathForComparison } from './file.js'
import { cacheKeys, type FileStateCache } from './fileStateCache.js'
import {
  parseFrontmatter,
  splitPathInFrontmatter,
} from './frontmatterParser.js'
import { getFsImplementation, safeResolvePath } from './fsOperations.js'
import { findCanonicalGitRoot, findGitRoot } from './git.js'
import {
  executeInstructionsLoadedHooks,
  hasInstructionsLoadedHook,
  type InstructionsLoadReason,
  type InstructionsMemoryType,
} from './hooks.js'
import type { MemoryType } from './memory/types.js'
import { expandPath } from './path.js'
import { pathInWorkingPath } from './permissions/filesystem.js'
import { isSettingSourceEnabled } from './settings/constants.js'
import { getInitialSettings } from './settings/settings.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const teamMemPaths = feature('TEAMMEM')
  ? (require('../memdir/teamMemPaths.js') as typeof import('../memdir/teamMemPaths.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

let hasLoggedInitialLoad = false

const MEMORY_INSTRUCTION_PROMPT = 'Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.'
// 内存文件的建议最大字符数
export const MAX_MEMORY_CHARACTER_COUNT = 40000

// @include 指令允许的文件扩展名
// 防止二进制文件（图片、PDF 等）被加载到内存中
const TEXT_FILE_EXTENSIONS = new Set([
  // Markdown 和文本
  '.md',
  '.txt',
  '.text',
  // 数据格式
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  '.csv',
  // Web
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.sass',
  '.less',
  // JavaScript/TypeScript
  '.js',
  '.ts',
  '.tsx',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
  // Python
  '.py',
  '.pyi',
  '.pyw',
  // Ruby
  '.rb',
  '.erb',
  '.rake',
  // Go
  '.go',
  // Rust
  '.rs',
  // Java/Kotlin/Scala
  '.java',
  '.kt',
  '.kts',
  '.scala',
  // C/C++
  '.c',
  '.cpp',
  '.cc',
  '.cxx',
  '.h',
  '.hpp',
  '.hxx',
  // C#
  '.cs',
  // Swift
  '.swift',
  // Shell
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.ps1',
  '.bat',
  '.cmd',
  // 配置
  '.env',
  '.ini',
  '.cfg',
  '.conf',
  '.config',
  '.properties',
  // 数据库
  '.sql',
  '.graphql',
  '.gql',
  // 协议
  '.proto',
  // 前端框架
  '.vue',
  '.svelte',
  '.astro',
  // 模板
  '.ejs',
  '.hbs',
  '.pug',
  '.jade',
  // 其他语言
  '.php',
  '.pl',
  '.pm',
  '.lua',
  '.r',
  '.R',
  '.dart',
  '.ex',
  '.exs',
  '.erl',
  '.hrl',
  '.clj',
  '.cljs',
  '.cljc',
  '.edn',
  '.hs',
  '.lhs',
  '.elm',
  '.ml',
  '.mli',
  '.f',
  '.f90',
  '.f95',
  '.for',
  // 构建文件
  '.cmake',
  '.make',
  '.makefile',
  '.gradle',
  '.sbt',
  // 文档
  '.rst',
  '.adoc',
  '.asciidoc',
  '.org',
  '.tex',
  '.latex',
  // 锁文件（通常为文本）
  '.lock',
  // 其他
  '.log',
  '.diff',
  '.patch',
])

export type MemoryFileInfo = {
  path: string
  type: MemoryType
  content: string
  parent?: string // 包含此文件的父文件路径
  globs?: string[] // 此规则适用的文件路径 glob 模式
  // 当自动注入转换了 `content`（剥离 HTML 注释、剥离 frontmatter、
  // 截断 MEMORY.md）使其不再匹配磁盘上的字节时为 true。
  // 设置后，`rawContent` 保存未修改的磁盘字节，以便调用方可以缓存
  // `isPartialView` readFileState 条目 —— 缓存中的存在提供去重 + 变更检测，
  // 但 Edit/Write 仍需要显式 Read 后才能继续。
  contentDiffersFromDisk?: boolean
  rawContent?: string
}

function pathInOriginalCwd(path: string): boolean {
  return pathInWorkingPath(path, getOriginalCwd())
}

/**
 * 从原始内容中解析出内容和 frontmatter 中的 glob 模式
 * @param rawContent 带 frontmatter 的原始文件内容
 * @returns 包含 content 和 globs 的对象（无 paths 或为全匹配模式时 globs 为 undefined）
 */
function parseFrontmatterPaths(rawContent: string): {
  content: string
  paths?: string[]
} {
  const { frontmatter, content } = parseFrontmatter(rawContent)

  if (!frontmatter.paths) {
    return { content }
  }

  const patterns = splitPathInFrontmatter(frontmatter.paths)
    .map(pattern => {
      // 移除 /** 后缀 —— ignore 库将 'path' 视为同时匹配
      // 路径本身和其内部所有内容
      return pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern
    })
    .filter((p: string) => p.length > 0)

  // 若所有模式均为 **（全匹配），视为无 globs（undefined）
  // 表示文件适用于所有路径
  if (patterns.length === 0 || patterns.every((p: string) => p === '**')) {
    return { content }
  }

  return { content, paths: patterns }
}

/**
 * 从 markdown 内容中剥离块级 HTML 注释（<!-- ... -->）。
 *
 * 使用 marked lexer 仅识别块级注释，因此内联代码区间和
 * 围栏代码块内的注释会被保留。段落内的内联 HTML 注释
 * 也会被保留；预期用例是占据独立行的作者注释。
 *
 * 未闭合的注释（`<!--` 无对应 `-->`）会被保留，
 * 避免拼写错误静默吞掉文件的其余部分。
 */
export function stripHtmlComments(content: string): {
  content: string
  stripped: boolean
} {
  if (!content.includes('<!--')) {
    return { content, stripped: false }
  }
  // gfm:false 在此无影响 —— html-block 检测是 CommonMark 规则。
  return stripHtmlCommentsFromTokens(new Lexer({ gfm: false }).lex(content))
}

function stripHtmlCommentsFromTokens(tokens: ReturnType<Lexer['lex']>): {
  content: string
  stripped: boolean
} {
  let result = ''
  let stripped = false

  // 良好格式的 HTML 注释跨度。非贪婪模式以便同一行的多个注释独立匹配；
  // [\s\S] 用于跨行匹配。
  const commentSpan = /<!--[\s\S]*?-->/g

  for (const token of tokens) {
    if (token.type === 'html') {
      const trimmed = token.raw.trimStart()
      if (trimmed.startsWith('<!--') && trimmed.includes('-->')) {
        // 按 CommonMark 规范，type-2 HTML 块在包含 `-->` 的*行*结束，
        // 因此该行 `-->` 之后的文本仍属于此 token。
        // 仅剥离注释跨度并保留残余内容。
        const residue = token.raw.replace(commentSpan, '')
        stripped = true
        if (residue.trim().length > 0) {
          // 存在残余内容（如 `<!-- note --> Use bun`）：保留它。
          result += residue
        }
        continue
      }
    }
    result += token.raw
  }

  return { content: result, stripped }
}

/**
 * 将原始内存文件内容解析为 MemoryFileInfo。纯函数 —— 无 I/O。
 *
 * 当提供 includeBasePath 时，@include 路径会在同一次 lex 遍历中解析，
 * 并与解析后的文件一同返回（这样 processMemoryFile 无需第二次 lex 同一内容）。
 */
function parseMemoryFileContent(
  rawContent: string,
  filePath: string,
  type: MemoryType,
  includeBasePath?: string,
): { info: MemoryFileInfo | null; includePaths: string[] } {
  // 跳过非文本文件以防止将二进制数据（图片、PDF 等）加载到内存中
  const ext = extname(filePath).toLowerCase()
  if (ext && !TEXT_FILE_EXTENSIONS.has(ext)) {
    logForDebugging(`Skipping non-text file in @include: ${filePath}`)
    return { info: null, includePaths: [] }
  }

  const { content: withoutFrontmatter, paths } =
    parseFrontmatterPaths(rawContent)

  // 仅 lex 一次，供剥离和 @include 提取共享 token。gfm:false
  // 是 extract 所必需的（防止 ~/path 被解析为删除线），
  // 且不影响 strip（html 块是 CommonMark 规则）。
  const hasComment = withoutFrontmatter.includes('<!--')
  const tokens =
    hasComment || includeBasePath !== undefined
      ? new Lexer({ gfm: false }).lex(withoutFrontmatter)
      : undefined

  // 仅当确实需要剥离注释时才通过 token 重建 ——
  // marked 在 lex 时会规范化 \r\n，因此将 CRLF 文件
  // 通过 token.raw 来回转换会错误地翻转 contentDiffersFromDisk。
  const strippedContent =
    hasComment && tokens
      ? stripHtmlCommentsFromTokens(tokens).content
      : withoutFrontmatter

  const includePaths =
    tokens && includeBasePath !== undefined
      ? extractIncludePathsFromTokens(tokens, includeBasePath)
      : []

  // 将 MEMORY.md 入口点截断到行和字节上限
  let finalContent = strippedContent
  if (type === 'AutoMem' || type === 'TeamMem') {
    finalContent = truncateEntrypointContent(strippedContent).content
  }

  // 涵盖 frontmatter 剥离、HTML 注释剥离和 MEMORY.md 截断
  const contentDiffersFromDisk = finalContent !== rawContent
  return {
    info: {
      path: filePath,
      type,
      content: finalContent,
      globs: paths,
      contentDiffersFromDisk,
      rawContent: contentDiffersFromDisk ? rawContent : undefined,
    },
    includePaths,
  }
}

function handleMemoryFileReadError(error: unknown, filePath: string): void {
  const code = getErrnoCode(error)
  // ENOENT = 文件不存在，EISDIR = 是目录 —— 均为预期情况
  if (code === 'ENOENT' || code === 'EISDIR') {
    return
  }
  // 记录权限错误（EACCES），因为它们需要用户处理
  if (code === 'EACCES') {
    // 不记录完整文件路径以避免 PII/安全问题
    logEvent('tengu_claude_md_permission_error', {
      is_access_error: 1,
      has_home_dir: filePath.includes(getClaudeConfigHomeDir()) ? 1 : 0,
    })
  }
}

/**
 * 由 processMemoryFile → getMemoryFiles 使用，以保持目录遍历期间
 * 事件循环的响应性（大量 readFile 尝试，多数返回 ENOENT）。
 * 当提供 includeBasePath 时，@include 路径会在同一次 lex 遍历中解析，
 * 并与解析后的文件一同返回。
 */
async function safelyReadMemoryFileAsync(
  filePath: string,
  type: MemoryType,
  includeBasePath?: string,
): Promise<{ info: MemoryFileInfo | null; includePaths: string[] }> {
  try {
    const fs = getFsImplementation()
    const rawContent = await fs.readFile(filePath, { encoding: 'utf-8' })
    return parseMemoryFileContent(rawContent, filePath, type, includeBasePath)
  } catch (error) {
    handleMemoryFileReadError(error, filePath)
    return { info: null, includePaths: [] }
  }
}

type MarkdownToken = {
  type: string
  text?: string
  href?: string
  tokens?: MarkdownToken[]
  raw?: string
  items?: MarkdownToken[]
}

// 从预 lex 的 token 中提取 @path include 引用并解析为绝对路径。
// 跳过 html token，以便块注释内的 @path 被忽略 ——
// 调用方可以传入剥离前的 token。
function extractIncludePathsFromTokens(
  tokens: ReturnType<Lexer['lex']>,
  basePath: string,
): string[] {
  const absolutePaths = new Set<string>()

  // 从文本字符串中提取 @path 并将解析后的路径加入 absolutePaths。
  function extractPathsFromText(textContent: string) {
    const includeRegex = /(?:^|\s)@((?:[^\s\\]|\\ )+)/g
    let match
    while ((match = includeRegex.exec(textContent)) !== null) {
      let path = match[1]
      if (!path) continue

      // 剥离片段标识符（#heading、#section-name 等）
      const hashIndex = path.indexOf('#')
      if (hashIndex !== -1) {
        path = path.substring(0, hashIndex)
      }
      if (!path) continue

      // 反转义路径中的空格
      path = path.replace(/\\ /g, ' ')

      // 接受 @path、@./path、@~/path 或 @/path
      if (path) {
        const isValidPath =
          path.startsWith('./') ||
          path.startsWith('~/') ||
          (path.startsWith('/') && path !== '/') ||
          (!path.startsWith('@') &&
            !path.match(/^[#%^&*()]+/) &&
            path.match(/^[a-zA-Z0-9._-]/))

        if (isValidPath) {
          const resolvedPath = expandPath(path, dirname(basePath))
          absolutePaths.add(resolvedPath)
        }
      }
    }
  }

  // 递归处理元素以查找文本节点
  function processElements(elements: MarkdownToken[]) {
    for (const element of elements) {
      if (element.type === 'code' || element.type === 'codespan') {
        continue
      }

      // 对于含注释的 html token，剥离注释跨度并检查残余中的 @path
      // （如 `<!-- note --> @./file.md`）。
      // 其他 html token（非注释标签）完全跳过。
      if (element.type === 'html') {
        const raw = element.raw || ''
        const trimmed = raw.trimStart()
        if (trimmed.startsWith('<!--') && trimmed.includes('-->')) {
          const commentSpan = /<!--[\s\S]*?-->/g
          const residue = raw.replace(commentSpan, '')
          if (residue.trim().length > 0) {
            extractPathsFromText(residue)
          }
        }
        continue
      }

      // 处理文本节点
      if (element.type === 'text') {
        extractPathsFromText(element.text || '')
      }

      // 递归进入子 token
      if (element.tokens) {
        processElements(element.tokens)
      }

      // 列表结构的特殊处理
      if (element.items) {
        processElements(element.items)
      }
    }
  }

  processElements(tokens as MarkdownToken[])
  return [...absolutePaths]
}

const MAX_INCLUDE_DEPTH = 5

/**
 * 检查 CLAUDE.md 文件路径是否被 claudeMdExcludes 设置排除。
 * 仅适用于 User、Project 和 Local 内存类型。
 * Managed、AutoMem 和 TeamMem 类型永远不会被排除。
 *
 * 同时匹配原始路径和 realpath 解析后的路径以处理软链接
 * （例如 macOS 上 /tmp -> /private/tmp）。
 */
function isClaudeMdExcluded(filePath: string, type: MemoryType): boolean {
  if (type !== 'User' && type !== 'Project' && type !== 'Local') {
    return false
  }

  const patterns = getInitialSettings().claudeMdExcludes
  if (!patterns || patterns.length === 0) {
    return false
  }

  const matchOpts = { dot: true }
  const normalizedPath = filePath.replaceAll('\\', '/')

  // 构建扩展的模式列表，包含绝对模式的 realpath 解析版本。
  // 这处理了 macOS 上的软链接（如 /tmp -> /private/tmp）：
  // 用户在排除项中写了 "/tmp/project/CLAUDE.md"，但系统将 CWD
  // 解析为 "/private/tmp/project/..."，因此文件路径使用真实路径。
  // 通过同样解析模式，两侧都能匹配。
  const expandedPatterns = resolveExcludePatterns(patterns).filter(
    p => p.length > 0,
  )
  if (expandedPatterns.length === 0) {
    return false
  }

  return picomatch.isMatch(normalizedPath, expandedPatterns, matchOpts)
}

/**
 * 通过解析绝对路径前缀中的软链接来扩展排除模式。
 * 对每个绝对模式（以 / 开头），尝试通过 realpathSync 解析最长的
 * 现有目录前缀，并添加解析后的版本。
 * glob 模式（含 *）会解析其静态前缀。
 */
function resolveExcludePatterns(patterns: string[]): string[] {
  const fs = getFsImplementation()
  const expanded: string[] = patterns.map(p => p.replaceAll('\\', '/'))

  for (const normalized of expanded) {
    // 仅解析绝对模式 —— 纯 glob 模式如 "**/*.md" 没有可解析的文件系统前缀
    if (!normalized.startsWith('/')) {
      continue
    }

    // 找到 glob 字符之前的静态前缀
    const globStart = normalized.search(/[*?{[]/)
    const staticPrefix =
      globStart === -1 ? normalized : normalized.slice(0, globStart)
    const dirToResolve = dirname(staticPrefix)

    try {
      // 同步 IO：从同步上下文调用（isClaudeMdExcluded -> processMemoryFile -> getMemoryFiles）
      const resolvedDir = fs.realpathSync(dirToResolve).replaceAll('\\', '/')
      if (resolvedDir !== dirToResolve) {
        const resolvedPattern =
          resolvedDir + normalized.slice(dirToResolve.length)
        expanded.push(resolvedPattern)
      }
    } catch {
      // 目录不存在；跳过此模式的解析
    }
  }

  return expanded
}

/**
 * 递归处理内存文件及其所有 @include 引用
 * 返回 MemoryFileInfo 对象数组，includes 在前，主文件在后
 */
export async function processMemoryFile(
  filePath: string,
  type: MemoryType,
  processedPaths: Set<string>,
  includeExternal: boolean,
  depth: number = 0,
  parent?: string,
): Promise<MemoryFileInfo[]> {
  // 若已处理或超过最大深度则跳过。
  // 规范化路径以处理 Windows 盘符大小写差异（如 C:\Users vs c:\Users）。
  const normalizedPath = normalizePathForComparison(filePath)
  if (processedPaths.has(normalizedPath) || depth >= MAX_INCLUDE_DEPTH) {
    return []
  }

  // 若路径被 claudeMdExcludes 设置排除则跳过
  if (isClaudeMdExcluded(filePath, type)) {
    return []
  }

  // 提前解析软链接路径以供 @import 解析使用
  const { resolvedPath, isSymlink } = safeResolvePath(
    getFsImplementation(),
    filePath,
  )

  processedPaths.add(normalizedPath)
  if (isSymlink) {
    processedPaths.add(normalizePathForComparison(resolvedPath))
  }

  const { info: memoryFile, includePaths: resolvedIncludePaths } =
    await safelyReadMemoryFileAsync(filePath, type, resolvedPath)
  if (!memoryFile || !memoryFile.content.trim()) {
    return []
  }

  // 添加父文件信息
  if (parent) {
    memoryFile.parent = parent
  }

  const result: MemoryFileInfo[] = []

  // 先添加主文件（父在子前）
  result.push(memoryFile)

  for (const resolvedIncludePath of resolvedIncludePaths) {
    const isExternal = !pathInOriginalCwd(resolvedIncludePath)
    if (isExternal && !includeExternal) {
      continue
    }

    // 递归处理被包含文件，将当前文件作为父文件
    const includedFiles = await processMemoryFile(
      resolvedIncludePath,
      type,
      processedPaths,
      includeExternal,
      depth + 1,
      filePath, // 将当前文件作为父文件传递
    )
    result.push(...includedFiles)
  }

  return result
}

/**
 * 处理 .claude/rules/ 目录及其子目录中的所有 .md 文件
 * @param rulesDir rules 目录的路径
 * @param type 内存文件类型（User、Project、Local）
 * @param processedPaths 已处理文件路径的集合
 * @param includeExternal 是否包含外部文件
 * @param conditionalRule 若为 true，仅包含有 frontmatter paths 的文件；若为 false，仅包含无 frontmatter paths 的文件
 * @param visitedDirs 已访问目录的真实路径集合（用于循环检测）
 * @returns MemoryFileInfo 对象数组
 */
export async function processMdRules({
  rulesDir,
  type,
  processedPaths,
  includeExternal,
  conditionalRule,
  visitedDirs = new Set(),
}: {
  rulesDir: string
  type: MemoryType
  processedPaths: Set<string>
  includeExternal: boolean
  conditionalRule: boolean
  visitedDirs?: Set<string>
}): Promise<MemoryFileInfo[]> {
  if (visitedDirs.has(rulesDir)) {
    return []
  }

  try {
    const fs = getFsImplementation()

    const { resolvedPath: resolvedRulesDir, isSymlink } = safeResolvePath(
      fs,
      rulesDir,
    )

    visitedDirs.add(rulesDir)
    if (isSymlink) {
      visitedDirs.add(resolvedRulesDir)
    }

    const result: MemoryFileInfo[] = []
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(resolvedRulesDir)
    } catch (e: unknown) {
      const code = getErrnoCode(e)
      if (code === 'ENOENT' || code === 'EACCES' || code === 'ENOTDIR') {
        return []
      }
      throw e
    }

    for (const entry of entries) {
      const entryPath = join(rulesDir, entry.name)
      const { resolvedPath: resolvedEntryPath, isSymlink } = safeResolvePath(
        fs,
        entryPath,
      )

      // 对非软链接使用 Dirent 方法以避免额外的 stat 调用。
      // 对软链接需要 stat 来确定目标类型。
      const stats = isSymlink ? await fs.stat(resolvedEntryPath) : null
      const isDirectory = stats ? stats.isDirectory() : entry.isDirectory()
      const isFile = stats ? stats.isFile() : entry.isFile()

      if (isDirectory) {
        result.push(
          ...(await processMdRules({
            rulesDir: resolvedEntryPath,
            type,
            processedPaths,
            includeExternal,
            conditionalRule,
            visitedDirs,
          })),
        )
      } else if (isFile && entry.name.endsWith('.md')) {
        const files = await processMemoryFile(
          resolvedEntryPath,
          type,
          processedPaths,
          includeExternal,
        )
        result.push(
          ...files.filter(f => (conditionalRule ? f.globs : !f.globs)),
        )
      }
    }

    return result
  } catch (error) {
    if (error instanceof Error && error.message.includes('EACCES')) {
      logEvent('tengu_claude_rules_md_permission_error', {
        is_access_error: 1,
        has_home_dir: rulesDir.includes(getClaudeConfigHomeDir()) ? 1 : 0,
      })
    }
    return []
  }
}

export const getMemoryFiles = memoize(
  async (forceIncludeExternal: boolean = false): Promise<MemoryFileInfo[]> => {
    const startTime = Date.now()
    logForDebugging('[Hapii] ClaudeMd.getMemoryFiles 开始加载内存文件', {
      level: 'info',
    })
    logForDiagnosticsNoPII('info', 'memory_files_started')

    const result: MemoryFileInfo[] = []
    const processedPaths = new Set<string>()
    const config = getCurrentProjectConfig()
    const includeExternal =
      forceIncludeExternal ||
      config.hasClaudeMdExternalIncludesApproved ||
      false

    // 首先处理 Managed 文件（始终加载 —— 策略设置）
    const managedClaudeMd = getMemoryPath('Managed')
    result.push(
      ...(await processMemoryFile(
        managedClaudeMd,
        'Managed',
        processedPaths,
        includeExternal,
      )),
    )
    // 处理 Managed .claude/rules/*.md 文件
    const managedClaudeRulesDir = getManagedClaudeRulesDir()
    result.push(
      ...(await processMdRules({
        rulesDir: managedClaudeRulesDir,
        type: 'Managed',
        processedPaths,
        includeExternal,
        conditionalRule: false,
      })),
    )

    // 处理 User 文件（仅当 userSettings 启用时）
    if (isSettingSourceEnabled('userSettings')) {
      const userClaudeMd = getMemoryPath('User')
      result.push(
        ...(await processMemoryFile(
          userClaudeMd,
          'User',
          processedPaths,
          true, // User 内存始终可以包含外部文件
        )),
      )
      // 处理 User ~/.claude/rules/*.md 文件
      const userClaudeRulesDir = getUserClaudeRulesDir()
      result.push(
        ...(await processMdRules({
          rulesDir: userClaudeRulesDir,
          type: 'User',
          processedPaths,
          includeExternal: true,
          conditionalRule: false,
        })),
      )
    }

    // 然后处理 Project 和 Local 文件
    const dirs: string[] = []
    const originalCwd = getOriginalCwd()
    let currentDir = originalCwd

    while (currentDir !== parse(currentDir).root) {
      dirs.push(currentDir)
      currentDir = dirname(currentDir)
    }

    // 当从嵌套在主仓库内的 git worktree 运行时（例如 `claude -w` 产生的
    // .claude/worktrees/<name>/），向上遍历会同时经过 worktree 根目录和主仓库根目录。
    // 两者都包含签入文件（如 CLAUDE.md 和 .claude/rules/*.md），
    // 导致同一内容被加载两次。跳过 worktree 之上但在主仓库之内的
    // Project 类型（签入）文件 —— worktree 已有自己的签出。
    // CLAUDE.local.md 被 gitignore，仅存在于主仓库中，仍会被加载。
    // 参见：https://github.com/anthropics/claude-code/issues/29599
    const gitRoot = findGitRoot(originalCwd)
    const canonicalRoot = findCanonicalGitRoot(originalCwd)
    const isNestedWorktree =
      gitRoot !== null &&
      canonicalRoot !== null &&
      normalizePathForComparison(gitRoot) !==
        normalizePathForComparison(canonicalRoot) &&
      pathInWorkingPath(gitRoot, canonicalRoot)

    // 从根目录向下处理到 CWD
    for (const dir of dirs.reverse()) {
      // 在嵌套 worktree 中，跳过主仓库工作树中的签入文件
      //（canonicalRoot 内但在 worktree 外的目录）。
      const skipProject =
        isNestedWorktree &&
        pathInWorkingPath(dir, canonicalRoot) &&
        !pathInWorkingPath(dir, gitRoot)

      // 尝试读取 CLAUDE.md（Project）—— 仅当 projectSettings 启用时
      if (isSettingSourceEnabled('projectSettings') && !skipProject) {
        const projectPath = join(dir, 'CLAUDE.md')
        result.push(
          ...(await processMemoryFile(
            projectPath,
            'Project',
            processedPaths,
            includeExternal,
          )),
        )

        // 尝试读取 .claude/CLAUDE.md（Project）
        const dotClaudePath = join(dir, '.claude', 'CLAUDE.md')
        result.push(
          ...(await processMemoryFile(
            dotClaudePath,
            'Project',
            processedPaths,
            includeExternal,
          )),
        )

        // 尝试读取 .claude/rules/*.md 文件（Project）
        const rulesDir = join(dir, '.claude', 'rules')
        result.push(
          ...(await processMdRules({
            rulesDir,
            type: 'Project',
            processedPaths,
            includeExternal,
            conditionalRule: false,
          })),
        )
      }

      // 尝试读取 CLAUDE.local.md（Local）—— 仅当 localSettings 启用时
      if (isSettingSourceEnabled('localSettings')) {
        const localPath = join(dir, 'CLAUDE.local.md')
        result.push(
          ...(await processMemoryFile(
            localPath,
            'Local',
            processedPaths,
            includeExternal,
          )),
        )
      }
    }

    // 若环境变量启用，处理附加目录（--add-dir）中的 CLAUDE.md
    // 由 CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD 控制，默认关闭
    // 注意：此处不检查 isSettingSourceEnabled('projectSettings')，
    // 因为 --add-dir 是用户显式操作，SDK 在未指定时默认 settingSources 为 []
    if (isEnvTruthy(process.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD)) {
      const additionalDirs = getAdditionalDirectoriesForClaudeMd()
      for (const dir of additionalDirs) {
        // 尝试从附加目录读取 CLAUDE.md
        const projectPath = join(dir, 'CLAUDE.md')
        result.push(
          ...(await processMemoryFile(
            projectPath,
            'Project',
            processedPaths,
            includeExternal,
          )),
        )

        // 尝试从附加目录读取 .claude/CLAUDE.md
        const dotClaudePath = join(dir, '.claude', 'CLAUDE.md')
        result.push(
          ...(await processMemoryFile(
            dotClaudePath,
            'Project',
            processedPaths,
            includeExternal,
          )),
        )

        // 尝试从附加目录读取 .claude/rules/*.md 文件
        const rulesDir = join(dir, '.claude', 'rules')
        result.push(
          ...(await processMdRules({
            rulesDir,
            type: 'Project',
            processedPaths,
            includeExternal,
            conditionalRule: false,
          })),
        )
      }
    }

    // Memdir 入口点（memory.md）—— 仅当功能启用且文件存在时
    if (isAutoMemoryEnabled()) {
      const { info: memdirEntry } = await safelyReadMemoryFileAsync(
        getAutoMemEntrypoint(),
        'AutoMem',
      )
      if (memdirEntry) {
        const normalizedPath = normalizePathForComparison(memdirEntry.path)
        if (!processedPaths.has(normalizedPath)) {
          processedPaths.add(normalizedPath)
          result.push(memdirEntry)
        }
      }
    }

    // Team memory 入口点 —— 仅当功能启用且文件存在时
    if (feature('TEAMMEM') && teamMemPaths!.isTeamMemoryEnabled()) {
      const { info: teamMemEntry } = await safelyReadMemoryFileAsync(
        teamMemPaths!.getTeamMemEntrypoint(),
        'TeamMem',
      )
      if (teamMemEntry) {
        const normalizedPath = normalizePathForComparison(teamMemEntry.path)
        if (!processedPaths.has(normalizedPath)) {
          processedPaths.add(normalizedPath)
          result.push(teamMemEntry)
        }
      }
    }

    const totalContentLength = result.reduce(
      (sum, f) => sum + f.content.length,
      0,
    )

    logForDebugging(
      `[Hapii] ClaudeMd.getMemoryFiles 完成 count=${result.length} 耗时=${Date.now() - startTime}ms`,
      { level: 'info' },
    )
    logForDiagnosticsNoPII('info', 'memory_files_completed', {
      duration_ms: Date.now() - startTime,
      file_count: result.length,
      total_content_length: totalContentLength,
    })

    const typeCounts: Record<string, number> = {}
    for (const f of result) {
      typeCounts[f.type] = (typeCounts[f.type] ?? 0) + 1
    }

    if (!hasLoggedInitialLoad) {
      hasLoggedInitialLoad = true
      logEvent('tengu_claudemd__initial_load', {
        file_count: result.length,
        total_content_length: totalContentLength,
        user_count: typeCounts['User'] ?? 0,
        project_count: typeCounts['Project'] ?? 0,
        local_count: typeCounts['Local'] ?? 0,
        managed_count: typeCounts['Managed'] ?? 0,
        automem_count: typeCounts['AutoMem'] ?? 0,
        ...(feature('TEAMMEM')
          ? { teammem_count: typeCounts['TeamMem'] ?? 0 }
          : {}),
        duration_ms: Date.now() - startTime,
      })
    }

    // 为加载的每个指令文件触发 InstructionsLoaded 钩子
    //（fire-and-forget，仅用于审计/可观测性）。
    // AutoMem/TeamMem 被有意排除 —— 它们是独立的内存系统，
    // 不是 CLAUDE.md/rules 意义上的"指令"。
    // 由 !forceIncludeExternal 门控：forceIncludeExternal=true 变体
    // 仅由 getExternalClaudeMdIncludes() 用于审批检查，而非构建上下文 ——
    // 在此处触发钩子会在启动时重复触发。
    // 一次性标志在每次 !forceIncludeExternal 缓存未命中时被消费
    //（不受 hasInstructionsLoadedHook 门控），以便即使未配置钩子也能释放标志 ——
    // 否则会话中途注册钩子后直接 .cache.clear() 会用过期的
    // 'session_start' 原因错误触发。
    if (!forceIncludeExternal) {
      const eagerLoadReason = consumeNextEagerLoadReason()
      if (eagerLoadReason !== undefined && hasInstructionsLoadedHook()) {
        for (const file of result) {
          if (!isInstructionsMemoryType(file.type)) continue
          const loadReason = file.parent ? 'include' : eagerLoadReason
          void executeInstructionsLoadedHooks(
            file.path,
            file.type,
            loadReason,
            {
              globs: file.globs,
              parentFilePath: file.parent,
            },
          )
        }
      }
    }

    return result
  },
)

function isInstructionsMemoryType(
  type: MemoryType,
): type is InstructionsMemoryType {
  return (
    type === 'User' ||
    type === 'Project' ||
    type === 'Local' ||
    type === 'Managed'
  )
}

// 下一次 getMemoryFiles() 主动遍历中，为顶级（非 include）文件报告的加载原因。
// 当压缩清空缓存时，由 resetGetMemoryFilesCache 设为 'compact'，
// 以便 InstructionsLoaded 钩子正确报告重新加载，而非误报为 'session_start'。
// 一次性：读取后重置为 'session_start'。
let nextEagerLoadReason: InstructionsLoadReason = 'session_start'

// InstructionsLoaded 钩子是否应在下一次缓存未命中时触发。
// 初始为 true（用于 session_start），触发后消费，
// 仅由 resetGetMemoryFilesCache() 重新启用。
// 仅需缓存失效以保证正确性的调用方（如 worktree 进入/退出、
// 设置同步、/memory 对话框）应使用 clearMemoryFileCaches()
// 以避免错误的钩子触发。
let shouldFireHook = true

function consumeNextEagerLoadReason(): InstructionsLoadReason | undefined {
  if (!shouldFireHook) return undefined
  shouldFireHook = false
  const reason = nextEagerLoadReason
  nextEagerLoadReason = 'session_start'
  return reason
}

/**
 * 清空 getMemoryFiles 的 memoize 缓存，
 * 不触发 InstructionsLoaded 钩子。
 *
 * 用于纯粹为保证正确性的缓存失效（如 worktree 进入/退出、
 * 设置同步、/memory 对话框）。对于代表指令实际被重新加载到上下文的事件
 *（如压缩），应使用 resetGetMemoryFilesCache()。
 */
export function clearMemoryFileCaches(): void {
  // 使用 ?.cache 因为测试会 spyOn 此函数，替换 memoize 包装器。
  getMemoryFiles.cache?.clear?.()
}

export function resetGetMemoryFilesCache(
  reason: InstructionsLoadReason = 'session_start',
): void {
  nextEagerLoadReason = reason
  shouldFireHook = true
  clearMemoryFileCaches()
}

export function getLargeMemoryFiles(files: MemoryFileInfo[]): MemoryFileInfo[] {
  return files.filter(f => f.content.length > MAX_MEMORY_CHARACTER_COUNT)
}

/**
 * 当 tengu_moth_copse 开启时，findRelevantMemories 预取通过附件展示内存文件，
 * 因此 MEMORY.md 索引不再注入系统提示。关注"实际在上下文中是什么"的调用方
 *（上下文构建器、/context 可视化）应通过此函数过滤。
 */
export function filterInjectedMemoryFiles(
  files: MemoryFileInfo[],
): MemoryFileInfo[] {
  const skipMemoryIndex = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_moth_copse',
    false,
  )
  if (!skipMemoryIndex) return files
  return files.filter(f => f.type !== 'AutoMem' && f.type !== 'TeamMem')
}

export const getClaudeMds = (
  memoryFiles: MemoryFileInfo[],
  filter?: (type: MemoryType) => boolean,
): string => {
  logForDebugging(
    `[Hapii] ClaudeMd.getClaudeMds 开始合并 fileCount=${memoryFiles.length} types=[${[...new Set(memoryFiles.map(f => f.type))].join(', ')}]`,
    { level: 'info' },
  )
  const memories: string[] = []
  const skipProjectLevel = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_paper_halyard',
    false,
  )

  for (const file of memoryFiles) {
    if (filter && !filter(file.type)) continue
    if (skipProjectLevel && (file.type === 'Project' || file.type === 'Local'))
      continue
    if (file.content) {
      const description =
        file.type === 'Project'
          ? ' (project instructions, checked into the codebase)'
          : file.type === 'Local'
            ? " (user's private project instructions, not checked in)"
            : feature('TEAMMEM') && file.type === 'TeamMem'
              ? ' (shared team memory, synced across the organization)'
              : file.type === 'AutoMem'
                ? " (user's auto-memory, persists across conversations)"
                : " (user's private global instructions for all projects)"

      const content = file.content.trim()
      if (feature('TEAMMEM') && file.type === 'TeamMem') {
        memories.push(
          `Contents of ${file.path}${description}:\n\n<team-memory-content source="shared">\n${content}\n</team-memory-content>`,
        )
      } else {
        memories.push(`Contents of ${file.path}${description}:\n\n${content}`)
      }
    }
  }

  if (memories.length === 0) {
    logForDebugging(
      '[Hapii] ClaudeMd.getClaudeMds 无有效 CLAUDE.md 内容，返回空串',
      { level: 'info' },
    )
    return ''
  }

  const result = `${MEMORY_INSTRUCTION_PROMPT}\n\n${memories.join('\n\n')}`
  logForDebugging(
    `[Hapii] ClaudeMd.getClaudeMds 完成 blocksCount=${memories.length} totalChars=${result.length}`,
    { level: 'info' },
  )
  return result
}

/**
 * 获取匹配目标路径的 Managed 和 User 条件规则。
 * 这是嵌套内存加载的第一阶段。
 *
 * @param targetPath 要与 glob 模式匹配的目标文件路径
 * @param processedPaths 已处理文件路径的集合（会被修改）
 * @returns 匹配条件规则的 MemoryFileInfo 对象数组
 */
export async function getManagedAndUserConditionalRules(
  targetPath: string,
  processedPaths: Set<string>,
): Promise<MemoryFileInfo[]> {
  const result: MemoryFileInfo[] = []

  // 处理 Managed 条件 .claude/rules/*.md 文件
  const managedClaudeRulesDir = getManagedClaudeRulesDir()
  result.push(
    ...(await processConditionedMdRules(
      targetPath,
      managedClaudeRulesDir,
      'Managed',
      processedPaths,
      false,
    )),
  )

  if (isSettingSourceEnabled('userSettings')) {
    // 处理 User 条件 .claude/rules/*.md 文件
    const userClaudeRulesDir = getUserClaudeRulesDir()
    result.push(
      ...(await processConditionedMdRules(
        targetPath,
        userClaudeRulesDir,
        'User',
        processedPaths,
        true,
      )),
    )
  }

  return result
}

/**
 * 获取单个嵌套目录（CWD 和目标之间）的内存文件。
 * 加载该目录的 CLAUDE.md、无条件规则和条件规则。
 *
 * @param dir 要处理的目录
 * @param targetPath 目标文件路径（用于条件规则匹配）
 * @param processedPaths 已处理文件路径的集合（会被修改）
 * @returns MemoryFileInfo 对象数组
 */
export async function getMemoryFilesForNestedDirectory(
  dir: string,
  targetPath: string,
  processedPaths: Set<string>,
): Promise<MemoryFileInfo[]> {
  const result: MemoryFileInfo[] = []

  // 处理项目内存文件（CLAUDE.md 和 .claude/CLAUDE.md）
  if (isSettingSourceEnabled('projectSettings')) {
    const projectPath = join(dir, 'CLAUDE.md')
    result.push(
      ...(await processMemoryFile(
        projectPath,
        'Project',
        processedPaths,
        false,
      )),
    )
    const dotClaudePath = join(dir, '.claude', 'CLAUDE.md')
    result.push(
      ...(await processMemoryFile(
        dotClaudePath,
        'Project',
        processedPaths,
        false,
      )),
    )
  }

  // 处理本地内存文件（CLAUDE.local.md）
  if (isSettingSourceEnabled('localSettings')) {
    const localPath = join(dir, 'CLAUDE.local.md')
    result.push(
      ...(await processMemoryFile(localPath, 'Local', processedPaths, false)),
    )
  }

  const rulesDir = join(dir, '.claude', 'rules')

  // 处理项目无条件 .claude/rules/*.md 文件，这些未被急切加载
  // 使用独立的 processedPaths 集合，避免将条件规则文件标记为已处理
  const unconditionalProcessedPaths = new Set(processedPaths)
  result.push(
    ...(await processMdRules({
      rulesDir,
      type: 'Project',
      processedPaths: unconditionalProcessedPaths,
      includeExternal: false,
      conditionalRule: false,
    })),
  )

  // 处理项目条件 .claude/rules/*.md 文件
  result.push(
    ...(await processConditionedMdRules(
      targetPath,
      rulesDir,
      'Project',
      processedPaths,
      false,
    )),
  )

  // 后续目录需要将无条件路径作为 processedPaths 的种子
  for (const path of unconditionalProcessedPaths) {
    processedPaths.add(path)
  }

  return result
}

/**
 * 获取 CWD 级别目录（从根目录到 CWD）的条件规则。
 * 仅处理条件规则，因为无条件规则已在急切加载中加载。
 *
 * @param dir 要处理的目录
 * @param targetPath 目标文件路径（用于条件规则匹配）
 * @param processedPaths 已处理文件路径的集合（会被修改）
 * @returns MemoryFileInfo 对象数组
 */
export async function getConditionalRulesForCwdLevelDirectory(
  dir: string,
  targetPath: string,
  processedPaths: Set<string>,
): Promise<MemoryFileInfo[]> {
  const rulesDir = join(dir, '.claude', 'rules')
  return processConditionedMdRules(
    targetPath,
    rulesDir,
    'Project',
    processedPaths,
    false,
  )
}

/**
 * 处理 .claude/rules/ 目录及其子目录中的所有 .md 文件，
 * 仅包含 frontmatter paths 匹配目标路径的文件
 * @param targetPath 要与 frontmatter glob 模式匹配的文件路径
 * @param rulesDir rules 目录的路径
 * @param type 内存文件类型（User、Project、Local）
 * @param processedPaths 已处理文件路径的集合
 * @param includeExternal 是否包含外部文件
 * @returns 匹配目标路径的 MemoryFileInfo 对象数组
 */
export async function processConditionedMdRules(
  targetPath: string,
  rulesDir: string,
  type: MemoryType,
  processedPaths: Set<string>,
  includeExternal: boolean,
): Promise<MemoryFileInfo[]> {
  const conditionedRuleMdFiles = await processMdRules({
    rulesDir,
    type,
    processedPaths,
    includeExternal,
    conditionalRule: true,
  })

  // 过滤，仅包含 glob 模式匹配 targetPath 的文件
  return conditionedRuleMdFiles.filter(file => {
    if (!file.globs || file.globs.length === 0) {
      return false
    }

    // 对于 Project 规则：glob 模式相对于包含 .claude 的目录
    // 对于 Managed/User 规则：glob 模式相对于原始 CWD
    const baseDir =
      type === 'Project'
        ? dirname(dirname(rulesDir)) // .claude 的父目录
        : getOriginalCwd() // Managed/User 规则的项目根目录

    const relativePath = isAbsolute(targetPath)
      ? relative(baseDir, targetPath)
      : targetPath
    // ignore() 对空字符串、逃逸基础目录的路径（../）
    // 和绝对路径（Windows 跨盘 relative() 返回绝对路径）会抛出异常。
    // baseDir 之外的文件无论如何都无法匹配 baseDir 相对的 glob。
    if (
      !relativePath ||
      relativePath.startsWith('..') ||
      isAbsolute(relativePath)
    ) {
      return false
    }
    return ignore().add(file.globs).ignores(relativePath)
  })
}

export type ExternalClaudeMdInclude = {
  path: string
  parent: string
}

export function getExternalClaudeMdIncludes(
  files: MemoryFileInfo[],
): ExternalClaudeMdInclude[] {
  const externals: ExternalClaudeMdInclude[] = []
  for (const file of files) {
    if (file.type !== 'User' && file.parent && !pathInOriginalCwd(file.path)) {
      externals.push({ path: file.path, parent: file.parent })
    }
  }
  return externals
}

export function hasExternalClaudeMdIncludes(files: MemoryFileInfo[]): boolean {
  return getExternalClaudeMdIncludes(files).length > 0
}

export async function shouldShowClaudeMdExternalIncludesWarning(): Promise<boolean> {
  const config = getCurrentProjectConfig()
  if (
    config.hasClaudeMdExternalIncludesApproved ||
    config.hasClaudeMdExternalIncludesWarningShown
  ) {
    return false
  }

  return hasExternalClaudeMdIncludes(await getMemoryFiles(true))
}

/**
 * 检查文件路径是否为内存文件（CLAUDE.md、CLAUDE.local.md 或 .claude/rules/*.md）
 */
export function isMemoryFilePath(filePath: string): boolean {
  const name = basename(filePath)
  const normalizedPath = normalizePathForComparison(filePath)

  // 任意位置的 CLAUDE.md 或 CLAUDE.local.md
  if (name === 'CLAUDE.md' || name === 'CLAUDE.local.md') {
    return true
  }

  // .claude/rules/ 目录中的 .md 文件
  if (name.endsWith('.md') && normalizedPath.includes('/.claude/rules/')) {
    return true
  }

  return false
}

/**
 * 从标准发现和 readFileState 中获取所有内存文件路径。
 * 合并：
 * - getMemoryFiles() 路径（从 CWD 向上到根目录）
 * - readFileState 中匹配内存模式的路径（包含子目录）
 */
export function getAllMemoryFilePaths(
  files: MemoryFileInfo[],
  readFileState: FileStateCache,
): string[] {
  const paths = new Set<string>()
  for (const file of files) {
    if (file.content.trim().length > 0) {
      paths.add(file.path)
    }
  }

  // 从 readFileState 添加内存文件（包含子目录）
  for (const filePath of cacheKeys(readFileState)) {
    if (isMemoryFilePath(filePath)) {
      paths.add(filePath)
    }
  }

  return Array.from(paths)
}
