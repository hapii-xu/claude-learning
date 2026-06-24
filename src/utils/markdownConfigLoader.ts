import { feature } from 'bun:bundle'
import { statSync } from 'fs'
import { lstat, readdir, readFile, realpath, stat } from 'fs/promises'
import memoize from 'lodash-es/memoize.js'
import { homedir } from 'os'
import { dirname, join, resolve, sep } from 'path'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { getProjectRoot } from '../bootstrap/state.js'
import { logForDebugging } from './debug.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from './envUtils.js'
import { isFsInaccessible } from './errors.js'
import { normalizePathForComparison } from './file.js'
import type { FrontmatterData } from './frontmatterParser.js'
import { parseFrontmatter } from './frontmatterParser.js'
import { findCanonicalGitRoot, findGitRoot } from './git.js'
import { parseToolListFromCLI } from './permissions/permissionSetup.js'
import { ripGrep } from './ripgrep.js'
import {
  isSettingSourceEnabled,
  type SettingSource,
} from './settings/constants.js'
import { getManagedFilePath } from './settings/managedPath.js'
import { isRestrictedToPluginOnly } from './settings/pluginOnlyPolicy.js'
import { CLAUDE_DIR_NAME } from 'src/constants/claudeDirName.js'

// Claude 配置目录名称
export const CLAUDE_CONFIG_DIRECTORIES = [
  'commands',
  'agents',
  'output-styles',
  'skills',
  'workflows',
  ...(feature('TEMPLATES') ? (['templates'] as const) : []),
] as const

export type ClaudeConfigDirectory = (typeof CLAUDE_CONFIG_DIRECTORIES)[number]

export type MarkdownFile = {
  filePath: string
  baseDir: string
  frontmatter: FrontmatterData
  content: string
  source: SettingSource
}

/**
 * 从 markdown 内容中提取描述。
 * 使用第一个非空行作为描述，或回退到默认值。
 */
export function extractDescriptionFromMarkdown(
  content: string,
  defaultDescription: string = 'Custom item',
): string {
  const lines = content.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed) {
      // 若为标题则剥除标题前缀
      const headerMatch = trimmed.match(/^#+\s+(.+)$/)
      const text = headerMatch?.[1] ?? trimmed

      // 返回文本，限制在合理长度内
      return text.length > 100 ? text.substring(0, 97) + '...' : text
    }
  }
  return defaultDescription
}

/**
 * 解析 frontmatter 中的工具列表，同时支持字符串和数组格式。
 * 始终返回字符串数组以保持一致性。
 * @param toolsValue frontmatter 中的值
 * @returns 解析后的工具列表，类型为 string[]
 */
function parseToolListString(toolsValue: unknown): string[] | null {
  // 缺失/null 时返回 null——让调用方决定默认值
  if (toolsValue === undefined || toolsValue === null) {
    return null
  }

  // 空字符串或其他假值表示无工具
  if (!toolsValue) {
    return []
  }

  let toolsArray: string[] = []
  if (typeof toolsValue === 'string') {
    toolsArray = [toolsValue]
  } else if (Array.isArray(toolsValue)) {
    toolsArray = toolsValue.filter(
      (item): item is string => typeof item === 'string',
    )
  }

  if (toolsArray.length === 0) {
    return []
  }

  const parsedTools = parseToolListFromCLI(toolsArray)
  if (parsedTools.includes('*')) {
    return ['*']
  }
  return parsedTools
}

/**
 * 解析 agent frontmatter 中的工具列表。
 * 字段缺失 = undefined（所有工具）
 * 字段为空 = []（无工具）
 */
export function parseAgentToolsFromFrontmatter(
  toolsValue: unknown,
): string[] | undefined {
  const parsed = parseToolListString(toolsValue)
  if (parsed === null) {
    // 对于 agent：undefined = 所有工具（undefined），null = 无工具（[]）
    return toolsValue === undefined ? undefined : []
  }
  // 如果解析结果包含 '*'，返回 undefined（所有工具）
  if (parsed.includes('*')) {
    return undefined
  }
  return parsed
}

/**
 * 解析 slash 命令 frontmatter 中的允许工具列表。
 * 字段缺失或为空 = 无工具（[]）
 */
export function parseSlashCommandToolsFromFrontmatter(
  toolsValue: unknown,
): string[] {
  const parsed = parseToolListString(toolsValue)
  if (parsed === null) {
    return []
  }
  return parsed
}

/**
 * 根据设备 ID 和 inode 获取文件的唯一标识符。
 * 用于检测通过不同路径（如符号链接）访问的重复文件。
 * 若文件不存在或无法 stat 则返回 null。
 *
 * 注意：在 Windows 上，dev 和 ino 对所有文件系统可能并不可靠。
 * 代码通过出错时返回 null 来优雅处理（fail open），
 * 这意味着在某些 Windows 配置下去重可能无法正常工作。
 *
 * 使用 bigint: true 处理 inode 较大的文件系统（如 ExFAT），
 * 其 inode 超出 JavaScript Number 精度（53 位）。不用 bigint 时，
 * 不同的大 inode 可能四舍五入到相同的 Number，导致误判重复。
 * 参见：https://github.com/anthropics/claude-code/issues/13893
 *
 * @param filePath - 文件路径
 * @returns 字符串标识符 "device:inode"，若无法识别文件则返回 null
 */
async function getFileIdentity(filePath: string): Promise<string | null> {
  try {
    const stats = await lstat(filePath, { bigint: true })
    // 部分文件系统（NFS、FUSE、网络挂载）对所有文件报告 dev=0 和 ino=0，
    // 这会导致每个文件看起来都像是重复的。
    // 返回 null 以跳过这些不可靠标识的去重。
    if (stats.dev === 0n && stats.ino === 0n) {
      return null
    }
    return `${stats.dev}:${stats.ino}`
  } catch {
    return null
  }
}

/**
 * 计算 getProjectDirsUpToHome 向上遍历的停止边界。
 *
 * 通常遍历在 cwd 上方最近的 `.git` 处停止。但如果 Bash 工具
 * 已切换到会话项目内的嵌套 git 仓库（子模块、自带 `.git` 的
 * vendored 依赖），该嵌套根目录并非正确边界——在此停止会让
 * 父项目的 `.hclaude/` 变得不可达（#31905）。
 *
 * 仅当同时满足以下两个条件时，边界才扩展到会话的 git 根：
 *   - cwd 上方最近的 `.git` 属于*不同*的规范仓库
 *     （子模块/vendored 克隆——而非 worktree，worktree 会解析回主仓库）
 *   - 该最近的 `.git` 位于会话项目树*内部*
 *
 * Worktree（在 `.hclaude/worktrees/` 下）保持旧行为：其 `.git` 文件是停止点，
 * loadMarkdownFilesForSubdir 的回退仅在 worktree 缺少时才添加主仓库副本。
 */
function resolveStopBoundary(cwd: string): string | null {
  const cwdGitRoot = findGitRoot(cwd)
  const sessionGitRoot = findGitRoot(getProjectRoot())
  if (!cwdGitRoot || !sessionGitRoot) {
    return cwdGitRoot
  }
  // findCanonicalGitRoot 将 worktree 的 `.git` 文件解析到主仓库。
  // 子模块（无 commondir）和独立克隆保持不变。
  const cwdCanonical = findCanonicalGitRoot(cwd)
  if (
    cwdCanonical &&
    normalizePathForComparison(cwdCanonical) ===
      normalizePathForComparison(sessionGitRoot)
  ) {
    // 同一规范仓库（主仓库或其 worktree）。停在最近的 .git。
    return cwdGitRoot
  }
  // 不同规范仓库。它是否嵌套在会话项目*内部*？
  const nCwdGitRoot = normalizePathForComparison(cwdGitRoot)
  const nSessionRoot = normalizePathForComparison(sessionGitRoot)
  if (
    nCwdGitRoot !== nSessionRoot &&
    nCwdGitRoot.startsWith(nSessionRoot + sep)
  ) {
    // 嵌套在项目内的仓库——跳过它，停在项目根目录。
    return sessionGitRoot
  }
  // 兄弟仓库或其他位置。停在最近的 .git（旧行为）。
  return cwdGitRoot
}

/**
 * 从当前目录向上遍历至 git 根目录（若不在 git 仓库中则至 home 目录），
 * 收集沿途所有 .hclaude 目录。
 *
 * 在 git 根处停止可防止仓库外父目录的命令/skills 泄漏到项目中。
 * 例如，若 ~/projects/.hclaude/commands/ 存在，当 my-repo 是 git 仓库时，
 * 它不会出现在 ~/projects/my-repo/ 中。
 *
 * @param subdir 子目录（如 "commands"、"agents"）
 * @param cwd 开始遍历的当前工作目录
 * @returns 包含 .hclaude/subdir 的目录路径数组，从最具体（cwd）到最不具体
 */
export function getProjectDirsUpToHome(
  subdir: ClaudeConfigDirectory,
  cwd: string,
): string[] {
  const home = resolve(homedir()).normalize('NFC')
  const gitRoot = resolveStopBoundary(cwd)
  let current = resolve(cwd)
  const dirs: string[] = []

  // 从当前目录向上遍历至 git 根目录（若不在 git 仓库中则至 home 目录）
  while (true) {
    // 到达 home 目录时停止（不检查它，因为它作为 userDir 单独加载）
    // 使用规范化比较处理 Windows 驱动器字母大小写（C:\ vs c:\）
    if (
      normalizePathForComparison(current) === normalizePathForComparison(home)
    ) {
      break
    }

    const claudeSubdir = join(current, CLAUDE_DIR_NAME, subdir)
    // 过滤到已存在的目录。这是性能过滤器（避免对不存在目录向下游的
    // ripgrep 进行 spawn），loadMarkdownFilesForSubdir 中的 worktree 回退也依赖它。
    // 使用 statSync + 显式错误处理而非 existsSync——会重新抛出意外错误
    // 而非静默吞下。下游 loadMarkdownFiles 能优雅处理 TOCTOU 窗口
    //（目录在读取前消失的情况）。
    try {
      statSync(claudeSubdir)
      dirs.push(claudeSubdir)
    } catch (e: unknown) {
      if (!isFsInaccessible(e)) throw e
    }

    // 处理完 git 根目录后停止——防止仓库外父目录的命令出现在项目中
    if (
      gitRoot &&
      normalizePathForComparison(current) ===
        normalizePathForComparison(gitRoot)
    ) {
      break
    }

    // 移动到父目录
    const parent = dirname(current)

    // 安全检查：若父目录与当前目录相同，说明已到达文件系统根目录
    if (parent === current) {
      break
    }

    current = parent
  }

  return dirs
}

/**
 * 从托管、用户和项目目录加载 markdown 文件
 * @param subdir 子目录（如 "agents" 或 "commands"）
 * @param cwd 用于项目目录遍历的当前工作目录
 * @returns 带元数据的已解析 markdown 文件数组
 */
export const loadMarkdownFilesForSubdir = memoize(
  async function (
    subdir: ClaudeConfigDirectory,
    cwd: string,
  ): Promise<MarkdownFile[]> {
    const searchStartTime = Date.now()
    const userDir = join(getClaudeConfigHomeDir(), subdir)
    const managedDir = join(getManagedFilePath(), CLAUDE_DIR_NAME, subdir)
    const projectDirs = getProjectDirsUpToHome(subdir, cwd)

    // 对于 .hclaude/<subdir> 未被检出的 git worktree（如 sparse-checkout），
    // 回退到主仓库的副本。getProjectDirsUpToHome 在 worktree 根目录
    //（.git 文件所在处）停止，因此它不会自行看到主仓库。
    //
    // 仅在 worktree 根的 .hclaude/<subdir> 不存在时才添加主仓库副本。
    // 标准的 `git worktree add` 会检出完整树，所以 worktree 已有相同的
    // .hclaude/<subdir> 内容——同时加载主仓库副本会导致每个
    // command/agent/skill 重复（anthropics/claude-code#29599, #28182, #26992）。
    //
    // projectDirs 已经反映了存在性（getProjectDirsUpToHome 逐一检查过），
    // 因此我们与它比较，而不是再次 stat。
    const gitRoot = findGitRoot(cwd)
    const canonicalRoot = findCanonicalGitRoot(cwd)
    if (gitRoot && canonicalRoot && canonicalRoot !== gitRoot) {
      const worktreeSubdir = normalizePathForComparison(
        join(gitRoot, CLAUDE_DIR_NAME, subdir),
      )
      const worktreeHasSubdir = projectDirs.some(
        dir => normalizePathForComparison(dir) === worktreeSubdir,
      )
      if (!worktreeHasSubdir) {
        const mainClaudeSubdir = join(canonicalRoot, CLAUDE_DIR_NAME, subdir)
        if (!projectDirs.includes(mainClaudeSubdir)) {
          projectDirs.push(mainClaudeSubdir)
        }
      }
    }

    const [managedFiles, userFiles, projectFilesNested] = await Promise.all([
      // 始终加载托管文件（policy settings）
      loadMarkdownFiles(managedDir).then(_ =>
        _.map(file => ({
          ...file,
          baseDir: managedDir,
          source: 'policySettings' as const,
        })),
      ),
      // 条件性加载用户文件
      isSettingSourceEnabled('userSettings') &&
      !(subdir === 'agents' && isRestrictedToPluginOnly('agents'))
        ? loadMarkdownFiles(userDir).then(_ =>
            _.map(file => ({
              ...file,
              baseDir: userDir,
              source: 'userSettings' as const,
            })),
          )
        : Promise.resolve([]),
      // 条件性从所有目录（至 home）加载项目文件
      isSettingSourceEnabled('projectSettings') &&
      !(subdir === 'agents' && isRestrictedToPluginOnly('agents'))
        ? Promise.all(
            projectDirs.map(projectDir =>
              loadMarkdownFiles(projectDir).then(_ =>
                _.map(file => ({
                  ...file,
                  baseDir: projectDir,
                  source: 'projectSettings' as const,
                })),
              ),
            ),
          )
        : Promise.resolve([]),
    ])

    // 展平嵌套的项目文件数组
    const projectFiles = projectFilesNested.flat()

    // 合并所有文件，优先级：托管 > 用户 > 项目
    const allFiles = [...managedFiles, ...userFiles, ...projectFiles]

    // 去重解析到同一物理文件（相同 inode）的文件。
    // 防止当 ~/.hclaude 被符号链接到项目层次中的某个目录时，
    // 同一物理文件通过不同路径被多次发现。
    const fileIdentities = await Promise.all(
      allFiles.map(file => getFileIdentity(file.filePath)),
    )

    const seenFileIds = new Map<string, SettingSource>()
    const deduplicatedFiles: MarkdownFile[] = []

    for (const [i, file] of allFiles.entries()) {
      const fileId = fileIdentities[i] ?? null
      if (fileId === null) {
        // 若无法识别文件，则包含它（fail open）
        deduplicatedFiles.push(file)
        continue
      }
      const existingSource = seenFileIds.get(fileId)
      if (existingSource !== undefined) {
        logForDebugging(
          `Skipping duplicate file '${file.filePath}' from ${file.source} (same inode already loaded from ${existingSource})`,
        )
        continue
      }
      seenFileIds.set(fileId, file.source)
      deduplicatedFiles.push(file)
    }

    const duplicatesRemoved = allFiles.length - deduplicatedFiles.length
    if (duplicatesRemoved > 0) {
      logForDebugging(
        `Deduplicated ${duplicatesRemoved} files in ${subdir} (same inode via symlinks or hard links)`,
      )
    }

    logEvent(`tengu_dir_search`, {
      durationMs: Date.now() - searchStartTime,
      managedFilesFound: managedFiles.length,
      userFilesFound: userFiles.length,
      projectFilesFound: projectFiles.length,
      projectDirsSearched: projectDirs.length,
      subdir:
        subdir as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })

    return deduplicatedFiles
  },
  // Custom resolver creates cache key from both subdir and cwd parameters
  (subdir: ClaudeConfigDirectory, cwd: string) => `${subdir}:${cwd}`,
)

/**
 * Native implementation to find markdown files using Node.js fs APIs
 *
 * This implementation exists alongside ripgrep for the following reasons:
 * 1. Ripgrep has poor startup performance in native builds (noticeable on app startup)
 * 2. Provides a fallback when ripgrep is unavailable
 * 3. Can be explicitly enabled via CLAUDE_CODE_USE_NATIVE_FILE_SEARCH env var
 *
 * Symlink handling:
 * - Follows symlinks (equivalent to ripgrep's --follow flag)
 * - Uses device+inode tracking to detect cycles (same as ripgrep's same_file library)
 * - Falls back to realpath on systems without inode support
 *
 * Does not respect .gitignore (matches ripgrep with --no-ignore flag)
 *
 * @param dir Directory to search
 * @param signal AbortSignal for timeout
 * @returns Array of file paths
 */
async function findMarkdownFilesNative(
  dir: string,
  signal: AbortSignal,
): Promise<string[]> {
  const files: string[] = []
  const visitedDirs = new Set<string>()

  async function walk(currentDir: string): Promise<void> {
    if (signal.aborted) {
      return
    }

    // Cycle detection: track visited directories by device+inode
    // Uses bigint: true to handle filesystems with large inodes (e.g., ExFAT)
    // that exceed JavaScript's Number precision (53 bits).
    // See: https://github.com/anthropics/claude-code/issues/13893
    try {
      const stats = await stat(currentDir, { bigint: true })
      if (stats.isDirectory()) {
        const dirKey =
          stats.dev !== undefined && stats.ino !== undefined
            ? `${stats.dev}:${stats.ino}` // Unix/Linux: device + inode
            : await realpath(currentDir) // Windows: canonical path

        if (visitedDirs.has(dirKey)) {
          logForDebugging(
            `Skipping already visited directory (circular symlink): ${currentDir}`,
          )
          return
        }
        visitedDirs.add(dirKey)
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      logForDebugging(`Failed to stat directory ${currentDir}: ${errorMessage}`)
      return
    }

    try {
      const entries = await readdir(currentDir, { withFileTypes: true })

      for (const entry of entries) {
        if (signal.aborted) {
          break
        }

        const fullPath = join(currentDir, entry.name)

        try {
          // Handle symlinks: isFile() and isDirectory() return false for symlinks
          if (entry.isSymbolicLink()) {
            try {
              const stats = await stat(fullPath) // stat() follows symlinks
              if (stats.isDirectory()) {
                await walk(fullPath)
              } else if (stats.isFile() && entry.name.endsWith('.md')) {
                files.push(fullPath)
              }
            } catch (error) {
              const errorMessage =
                error instanceof Error ? error.message : String(error)
              logForDebugging(
                `Failed to follow symlink ${fullPath}: ${errorMessage}`,
              )
            }
          } else if (entry.isDirectory()) {
            await walk(fullPath)
          } else if (entry.isFile() && entry.name.endsWith('.md')) {
            files.push(fullPath)
          }
        } catch (error) {
          // Skip files/directories we can't access
          const errorMessage =
            error instanceof Error ? error.message : String(error)
          logForDebugging(`Failed to access ${fullPath}: ${errorMessage}`)
        }
      }
    } catch (error) {
      // If readdir fails (e.g., permission denied), log and continue
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      logForDebugging(`Failed to read directory ${currentDir}: ${errorMessage}`)
    }
  }

  await walk(dir)
  return files
}

/**
 * Generic function to load markdown files from specified directories
 * @param dir Directory (eg. "~/.hclaude/commands")
 * @returns Array of parsed markdown files with metadata
 */
async function loadMarkdownFiles(dir: string): Promise<
  {
    filePath: string
    frontmatter: FrontmatterData
    content: string
  }[]
> {
  // File search strategy:
  // - Default: ripgrep (faster, battle-tested)
  // - Fallback: native Node.js (when CLAUDE_CODE_USE_NATIVE_FILE_SEARCH is set)
  //
  // Why both? Ripgrep has poor startup performance in native builds.
  const useNative = isEnvTruthy(process.env.CLAUDE_CODE_USE_NATIVE_FILE_SEARCH)
  const signal = AbortSignal.timeout(3000)
  let files: string[]
  try {
    files = useNative
      ? await findMarkdownFilesNative(dir, signal)
      : await ripGrep(
          ['--files', '--hidden', '--follow', '--no-ignore', '--glob', '*.md'],
          dir,
          signal,
        )
  } catch (e: unknown) {
    // Handle missing/inaccessible dir directly instead of pre-checking
    // existence (TOCTOU). findMarkdownFilesNative already catches internally;
    // ripGrep rejects on inaccessible target paths.
    if (isFsInaccessible(e)) return []
    throw e
  }

  const results = await Promise.all(
    files.map(async filePath => {
      try {
        const rawContent = await readFile(filePath, { encoding: 'utf-8' })
        const { frontmatter, content } = parseFrontmatter(rawContent, filePath)

        return {
          filePath,
          frontmatter,
          content,
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error)
        logForDebugging(
          `Failed to read/parse markdown file:  ${filePath}: ${errorMessage}`,
        )
        return null
      }
    }),
  )

  return results.filter(_ => _ !== null)
}
