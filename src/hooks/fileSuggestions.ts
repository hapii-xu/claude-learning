import { statSync } from 'fs'
import ignore from 'ignore'
import * as path from 'path'
import {
  CLAUDE_CONFIG_DIRECTORIES,
  loadMarkdownFilesForSubdir,
} from 'src/utils/markdownConfigLoader.js'
import type { SuggestionItem } from '../components/PromptInput/PromptInputFooterSuggestions.js'
import {
  CHUNK_MS,
  FileIndex,
  yieldToEventLoop,
} from '../native-ts/file-index/index.js'
import { logEvent } from '../services/analytics/index.js'
import type { FileSuggestionCommandInput } from '../types/fileSuggestion.js'
import { getGlobalConfig } from '../utils/config.js'
import { getCwd } from '../utils/cwd.js'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import { execFileNoThrowWithCwd } from '../utils/execFileNoThrow.js'
import { getFsImplementation } from '../utils/fsOperations.js'
import { findGitRoot, gitExe } from '../utils/git.js'
import {
  createBaseHookInput,
  executeFileSuggestionCommand,
} from '../utils/hooks.js'
import { logError } from '../utils/log.js'
import { expandPath } from '../utils/path.js'
import { ripGrep } from '../utils/ripgrep.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import { createSignal } from '../utils/signal.js'

// 延迟构造的单例
let fileIndex: FileIndex | null = null

function getFileIndex(): FileIndex {
  if (!fileIndex) {
    fileIndex = new FileIndex()
  }
  return fileIndex
}

let fileListRefreshPromise: Promise<FileIndex> | null = null
// 当正在进行的索引构建完成时触发的信号。让
// 即时补全 UI 重新运行其上次搜索，以便部分结果升级为完整结果。
const indexBuildComplete = createSignal()
export const onIndexBuildComplete = indexBuildComplete.subscribe
let cacheGeneration = 0

// 后台获取未跟踪文件
let untrackedFetchPromise: Promise<void> | null = null

// 存储已跟踪文件，以便我们可以用未跟踪文件重建索引
let cachedTrackedFiles: string[] = []
// 存储配置文件，以便 mergeUntrackedIntoNormalizedCache 保留它们
let cachedConfigFiles: string[] = []
// 存储已跟踪目录，以便 mergeUntrackedIntoNormalizedCache 不会
// 在每次合并时重新计算约 270k 次 path.dirname() 调用
let cachedTrackedDirs: string[] = []

// .ignore/.rgignore 模式的缓存（以 repoRoot:cwd 为键）
let ignorePatternsCache: ReturnType<typeof ignore> | null = null
let ignorePatternsCacheKey: string | null = null

// 后台刷新的节流状态。.git/index 的 mtime 在已跟踪文件
// 变化时触发立即刷新（add/checkout/commit/rm）。
// 时间下限仍然每 5 秒刷新以获取未跟踪文件，
// 它们不会触碰索引。
let lastRefreshMs = 0
let lastGitIndexMtime: number | null = null

// 加载到 Rust 索引中的路径列表的签名。两个独立的
// 签名是因为两个 loadFromFileList 调用站点使用不同结构的
// 数组 —— 共享签名会导致乒乓效应且永远不匹配。
// 当 git ls-files 返回未更改的列表时跳过 nucleo.restart()
// （例如，对已跟踪文件的 `git add` 会触碰索引 mtime 但不会改变列表）。
let loadedTrackedSignature: string | null = null
let loadedMergedSignature: string | null = null

/**
 * 清除所有文件建议缓存。
 * 在恢复会话时调用此函数以确保新鲜的文件发现。
 */
export function clearFileSuggestionCaches(): void {
  fileIndex = null
  fileListRefreshPromise = null
  cacheGeneration++
  untrackedFetchPromise = null
  cachedTrackedFiles = []
  cachedConfigFiles = []
  cachedTrackedDirs = []
  indexBuildComplete.clear()
  ignorePatternsCache = null
  ignorePatternsCacheKey = null
  lastRefreshMs = 0
  lastGitIndexMtime = null
  loadedTrackedSignature = null
  loadedMergedSignature = null
}

/**
 * 路径列表的内容哈希。length|first|last 采样会遗漏中间文件的
 * 重命名（相同长度、相同端点 → 陈旧条目卡在 nucleo 中）。
 *
 * 每隔 N 个路径采样（加上长度）。在 346k 路径列表上，这会哈希约 700 个
 * 路径而不是 14MB —— 足以捕获 git 操作（checkout、rebase、add/rm），
 * 同时在 <1ms 内运行。单个中间列表重命名如果恰好落在采样之间
 * 会错过重建，但 5 秒刷新下限会在下一个周期捕获它。
 */
export function pathListSignature(paths: string[]): string {
  const n = paths.length
  const stride = Math.max(1, Math.floor(n / 500))
  let h = 0x811c9dc5 | 0
  for (let i = 0; i < n; i += stride) {
    const p = paths[i]!
    for (let j = 0; j < p.length; j++) {
      h = ((h ^ p.charCodeAt(j)) * 0x01000193) | 0
    }
    h = (h * 0x01000193) | 0
  }
  // 步长从 0 开始（第一个路径总是被哈希）；显式包含最后
  // 以便尾部单文件添加/移除被捕获
  if (n > 0) {
    const last = paths[n - 1]!
    for (let j = 0; j < last.length; j++) {
      h = ((h ^ last.charCodeAt(j)) * 0x01000193) | 0
    }
  }
  return `${n}:${(h >>> 0).toString(16)}`
}

/**
 * Stat .git/index 以检测 git 状态变化而无需生成 git ls-files。
 * 对于 worktree（.git 是文件 → ENOTDIR）、尚无索引的新仓库
 * （ENOENT）和非 git 目录返回 null —— 调用方回退到时间节流。
 */
function getGitIndexMtime(): number | null {
  const repoRoot = findGitRoot(getCwd())
  if (!repoRoot) return null
  try {
    // eslint-disable-next-line custom-rules/no-sync-fs -- mtimeMs 在这里是操作本身，而不是预检查。上方的 findGitRoot 已经同步执行了 stat-walk；相比每次按键都启动 git ls-files，多一次 stat 影响很小。异步方式会迫使 startBackgroundCacheRefresh 变为异步，破坏冷启动 await 处的同步 fileListRefreshPromise 契约。
    return statSync(path.join(repoRoot, '.git', 'index')).mtimeMs
  } catch {
    return null
  }
}

/**
 * 相对于 originalCwd 规范化 git 路径
 */
function normalizeGitPaths(
  files: string[],
  repoRoot: string,
  originalCwd: string,
): string[] {
  if (originalCwd === repoRoot) {
    return files
  }
  return files.map(f => {
    const absolutePath = path.join(repoRoot, f)
    return path.relative(originalCwd, absolutePath)
  })
}

/**
 * 将已规范化的未跟踪文件合并到缓存中
 */
async function mergeUntrackedIntoNormalizedCache(
  normalizedUntracked: string[],
): Promise<void> {
  if (normalizedUntracked.length === 0) return
  if (!fileIndex || cachedTrackedFiles.length === 0) return

  const untrackedDirs = await getDirectoryNamesAsync(normalizedUntracked)
  const allPaths = [
    ...cachedTrackedFiles,
    ...cachedConfigFiles,
    ...cachedTrackedDirs,
    ...normalizedUntracked,
    ...untrackedDirs,
  ]
  const sig = pathListSignature(allPaths)
  if (sig === loadedMergedSignature) {
    logForDebugging(
      `[FileIndex] skipped index rebuild — merged paths unchanged`,
    )
    return
  }
  await fileIndex.loadFromFileListAsync(allPaths).done
  loadedMergedSignature = sig
  logForDebugging(
    `[FileIndex] rebuilt index with ${cachedTrackedFiles.length} tracked + ${normalizedUntracked.length} untracked files`,
  )
}

/**
 * 从 .ignore 或 .rgignore 文件加载 ripgrep 特定的忽略模式
 * 如果找到模式则返回 ignore 实例，否则返回 null
 * 结果按 repoRoot:cwd 组合缓存
 */
async function loadRipgrepIgnorePatterns(
  repoRoot: string,
  cwd: string,
): Promise<ReturnType<typeof ignore> | null> {
  const cacheKey = `${repoRoot}:${cwd}`

  // 如果有缓存结果则返回
  if (ignorePatternsCacheKey === cacheKey) {
    return ignorePatternsCache
  }

  const fs = getFsImplementation()
  const ignoreFiles = ['.ignore', '.rgignore']
  const directories = [...new Set([repoRoot, cwd])]

  const ig = ignore()
  let hasPatterns = false

  const paths = directories.flatMap(dir =>
    ignoreFiles.map(f => path.join(dir, f)),
  )
  const contents = await Promise.all(
    paths.map(p => fs.readFile(p, { encoding: 'utf8' }).catch(() => null)),
  )
  for (const [i, content] of contents.entries()) {
    if (content === null) continue
    ig.add(content)
    hasPatterns = true
    logForDebugging(`[FileIndex] loaded ignore patterns from ${paths[i]}`)
  }

  const result = hasPatterns ? ig : null
  ignorePatternsCache = result
  ignorePatternsCacheKey = cacheKey

  return result
}

/**
 * 使用 git ls-files 获取文件（对于 git 仓库比 ripgrep 快得多）
 * 立即返回已跟踪文件，在后台获取未跟踪文件
 * @param respectGitignore 如果为真，则从未跟踪结果中排除 gitignore 的文件
 *
 * 注意：与 ripgrep --follow 不同，git ls-files 不跟随符号链接。
 * 这是有意为之，因为 git 将符号链接跟踪为符号链接。
 */
async function getFilesUsingGit(
  abortSignal: AbortSignal,
  respectGitignore: boolean,
): Promise<string[] | null> {
  const startTime = Date.now()
  logForDebugging(`[FileIndex] getFilesUsingGit called`)

  // 检查是否在 git 仓库中。findGitRoot 按路径进行 LRU 记忆化。
  const cwd = getCwd()
  const repoRoot = findGitRoot(cwd)
  if (!repoRoot) {
    logForDebugging(`[FileIndex] not a git repo, returning null`)
    return null
  }

  try {
    // 获取已跟踪文件（快 - 从 git 索引读取）
    // 从 repoRoot 运行，以便路径相对于仓库根而不是 CWD
    const lsFilesStart = Date.now()
    const trackedResult = await execFileNoThrowWithCwd(
      gitExe(),
      ['-c', 'core.quotepath=false', 'ls-files', '--recurse-submodules'],
      { timeout: 5000, abortSignal, cwd: repoRoot },
    )
    logForDebugging(
      `[FileIndex] git ls-files (tracked) took ${Date.now() - lsFilesStart}ms`,
    )

    if (trackedResult.code !== 0) {
      logForDebugging(
        `[FileIndex] git ls-files failed (code=${trackedResult.code}, stderr=${trackedResult.stderr}), falling back to ripgrep`,
      )
      return null
    }

    const trackedFiles = trackedResult.stdout.trim().split('\n').filter(Boolean)

    // 相对于当前工作目录规范化路径
    let normalizedTracked = normalizeGitPaths(trackedFiles, repoRoot, cwd)

    // 如果存在则应用 .ignore/.rgignore 模式（比回退到 ripgrep 快）
    const ignorePatterns = await loadRipgrepIgnorePatterns(repoRoot, cwd)
    if (ignorePatterns) {
      const beforeCount = normalizedTracked.length
      normalizedTracked = ignorePatterns.filter(normalizedTracked)
      logForDebugging(
        `[FileIndex] applied ignore patterns: ${beforeCount} -> ${normalizedTracked.length} files`,
      )
    }

    // 缓存已跟踪文件以便稍后与未跟踪文件合并
    cachedTrackedFiles = normalizedTracked

    const duration = Date.now() - startTime
    logForDebugging(
      `[FileIndex] git ls-files: ${normalizedTracked.length} tracked files in ${duration}ms`,
    )

    logEvent('tengu_file_suggestions_git_ls_files', {
      file_count: normalizedTracked.length,
      tracked_count: normalizedTracked.length,
      untracked_count: 0,
      duration_ms: duration,
    })

    // 启动后台获取未跟踪文件（不等待）
    if (!untrackedFetchPromise) {
      const untrackedArgs = respectGitignore
        ? [
            '-c',
            'core.quotepath=false',
            'ls-files',
            '--others',
            '--exclude-standard',
          ]
        : ['-c', 'core.quotepath=false', 'ls-files', '--others']

      const generation = cacheGeneration
      untrackedFetchPromise = execFileNoThrowWithCwd(gitExe(), untrackedArgs, {
        timeout: 10000,
        cwd: repoRoot,
      })
        .then(async untrackedResult => {
          if (generation !== cacheGeneration) {
            return // 缓存已被清除；不要合并陈旧的未跟踪文件
          }
          if (untrackedResult.code === 0) {
            const rawUntrackedFiles = untrackedResult.stdout
              .trim()
              .split('\n')
              .filter(Boolean)

            // 在应用忽略模式之前规范化路径（与已跟踪文件一致）
            let normalizedUntracked = normalizeGitPaths(
              rawUntrackedFiles,
              repoRoot,
              cwd,
            )

            // 将 .ignore/.rgignore 模式应用于已规范化的未跟踪文件
            const ignorePatterns = await loadRipgrepIgnorePatterns(
              repoRoot,
              cwd,
            )
            if (ignorePatterns && normalizedUntracked.length > 0) {
              const beforeCount = normalizedUntracked.length
              normalizedUntracked = ignorePatterns.filter(normalizedUntracked)
              logForDebugging(
                `[FileIndex] applied ignore patterns to untracked: ${beforeCount} -> ${normalizedUntracked.length} files`,
              )
            }

            logForDebugging(
              `[FileIndex] background untracked fetch: ${normalizedUntracked.length} files`,
            )
            // 将已规范化的文件直接传递给合并函数
            void mergeUntrackedIntoNormalizedCache(normalizedUntracked)
          }
        })
        .catch(error => {
          logForDebugging(
            `[FileIndex] background untracked fetch failed: ${error}`,
          )
        })
        .finally(() => {
          untrackedFetchPromise = null
        })
    }

    return normalizedTracked
  } catch (error) {
    logForDebugging(`[FileIndex] git ls-files error: ${errorMessage(error)}`)
    return null
  }
}

/**
 * 此函数收集每个文件路径的所有父目录
 * 并返回带尾部分隔符的唯一目录名列表。
 * 例如，如果输入是 ['src/index.js', 'src/utils/helpers.js']，
 * 输出将是 ['src/', 'src/utils/']。
 * @param files 文件路径数组
 */

/**
 * 异步变体：每约 10k 个文件让出一次，以便 270k+ 文件列表不会
 * 阻塞主线程超过 10ms。
 */
export async function getDirectoryNamesAsync(
  files: string[],
): Promise<string[]> {
  const directoryNames = new Set<string>()
  // 基于时间的分块：在 CHUNK_MS 工作量后让出，以便慢机器获得
  // 更小的块并保持响应。
  let chunkStart = performance.now()
  for (let i = 0; i < files.length; i++) {
    collectDirectoryNames(files, i, i + 1, directoryNames)
    if ((i & 0xff) === 0xff && performance.now() - chunkStart > CHUNK_MS) {
      await yieldToEventLoop()
      chunkStart = performance.now()
    }
  }
  return [...directoryNames].map(d => d + path.sep)
}

function collectDirectoryNames(
  files: string[],
  start: number,
  end: number,
  out: Set<string>,
): void {
  for (let i = start; i < end; i++) {
    let currentDir = path.dirname(files[i]!)
    // 如果我们已经处理过此目录及其所有父目录则提前退出。
    // 根检测：path.dirname 在根处返回其输入（不动点），
    // 所以当 dirname 停止变化时我们停止。在 add() 之前检查这一点
    // 使根不在结果集中（匹配旧的 path.parse().root 守卫）。
    // 这避免了 path.parse()，它为每个文件分配一个 5 字段的对象。
    while (currentDir !== '.' && !out.has(currentDir)) {
      const parent = path.dirname(currentDir)
      if (parent === currentDir) break
      out.add(currentDir)
      currentDir = parent
    }
  }
}

/**
 * 从 Claude 配置目录获取额外文件
 */
async function getClaudeConfigFiles(cwd: string): Promise<string[]> {
  const markdownFileArrays = await Promise.all(
    CLAUDE_CONFIG_DIRECTORIES.map(subdir =>
      loadMarkdownFilesForSubdir(subdir, cwd),
    ),
  )
  return markdownFileArrays.flatMap(markdownFiles =>
    markdownFiles.map(f => f.filePath),
  )
}

/**
 * 使用 git ls-files（快）或 ripgrep（回退）获取项目文件
 */
async function getProjectFiles(
  abortSignal: AbortSignal,
  respectGitignore: boolean,
): Promise<string[]> {
  logForDebugging(
    `[FileIndex] getProjectFiles called, respectGitignore=${respectGitignore}`,
  )

  // 首先尝试 git ls-files（对于 git 仓库快得多）
  const gitFiles = await getFilesUsingGit(abortSignal, respectGitignore)
  if (gitFiles !== null) {
    logForDebugging(
      `[FileIndex] using git ls-files result (${gitFiles.length} files)`,
    )
    return gitFiles
  }

  // 回退到 ripgrep
  logForDebugging(
    `[FileIndex] git ls-files returned null, falling back to ripgrep`,
  )
  const startTime = Date.now()
  const rgArgs = [
    '--files',
    '--follow',
    '--hidden',
    '--glob',
    '!.git/',
    '--glob',
    '!.svn/',
    '--glob',
    '!.hg/',
    '--glob',
    '!.bzr/',
    '--glob',
    '!.jj/',
    '--glob',
    '!.sl/',
  ]
  if (!respectGitignore) {
    rgArgs.push('--no-ignore-vcs')
  }

  const files = await ripGrep(rgArgs, '.', abortSignal)
  const relativePaths = files.map(f => path.relative(getCwd(), f))

  const duration = Date.now() - startTime
  logForDebugging(
    `[FileIndex] ripgrep: ${relativePaths.length} files in ${duration}ms`,
  )

  logEvent('tengu_file_suggestions_ripgrep', {
    file_count: relativePaths.length,
    duration_ms: duration,
  })

  return relativePaths
}

/**
 * 获取文件及其目录路径以提供路径建议
 * 对 git 仓库使用 git ls-files（快）或回退到 ripgrep
 * 返回为快速模糊搜索填充的 FileIndex
 */
export async function getPathsForSuggestions(): Promise<FileIndex> {
  const signal = AbortSignal.timeout(10_000)
  const index = getFileIndex()

  try {
    // 首先检查项目设置，然后回退到全局配置
    const projectSettings = getInitialSettings()
    const globalConfig = getGlobalConfig()
    const respectGitignore =
      projectSettings.respectGitignore ?? globalConfig.respectGitignore ?? true

    const cwd = getCwd()
    const [projectFiles, configFiles] = await Promise.all([
      getProjectFiles(signal, respectGitignore),
      getClaudeConfigFiles(cwd),
    ])

    // mergeUntrackedIntoNormalizedCache 的缓存
    cachedConfigFiles = configFiles

    const allFiles = [...projectFiles, ...configFiles]
    const directories = await getDirectoryNamesAsync(allFiles)
    cachedTrackedDirs = directories
    const allPathsList = [...directories, ...allFiles]

    // 当列表未更改时跳过重建。这在打字会话期间
    // 是常见情况 —— git ls-files 返回相同输出。
    const sig = pathListSignature(allPathsList)
    if (sig !== loadedTrackedSignature) {
      // 等待完整构建，以便冷启动返回完整结果。
      // 构建每约 4ms 让出一次，以便 UI 保持响应 —— 用户可以在
      // 约 120ms 等待期间继续打字而没有输入延迟。
      await index.loadFromFileListAsync(allPathsList).done
      loadedTrackedSignature = sig
      // 我们刚刚用仅已跟踪数据替换了合并索引。强制
      // 下一次未跟踪合并重建，即使其自己的签名匹配。
      loadedMergedSignature = null
    } else {
      logForDebugging(
        `[FileIndex] skipped index rebuild — tracked paths unchanged`,
      )
    }
  } catch (error) {
    logError(error)
  }

  return index
}

/**
 * 查找两个字符串之间的公共前缀
 */
function findCommonPrefix(a: string, b: string): string {
  const minLength = Math.min(a.length, b.length)
  let i = 0
  while (i < minLength && a[i] === b[i]) {
    i++
  }
  return a.substring(0, i)
}

/**
 * 查找建议项数组中最长的公共前缀
 */
export function findLongestCommonPrefix(suggestions: SuggestionItem[]): string {
  if (suggestions.length === 0) return ''

  const strings = suggestions.map(item => item.displayText)
  let prefix = strings[0]!
  for (let i = 1; i < strings.length; i++) {
    const currentString = strings[i]!
    prefix = findCommonPrefix(prefix, currentString)
    if (prefix === '') return ''
  }
  return prefix
}

/**
 * 创建文件建议项
 */
function createFileSuggestionItem(
  filePath: string,
  score?: number,
): SuggestionItem {
  return {
    id: `file-${filePath}`,
    displayText: filePath,
    metadata: score !== undefined ? { score } : undefined,
  }
}

/**
 * 使用 TS 文件索引查找与给定查询匹配的文件和文件夹
 */
const MAX_SUGGESTIONS = 15
function findMatchingFiles(
  fileIndex: FileIndex,
  partialPath: string,
): SuggestionItem[] {
  const results = fileIndex.search(partialPath, MAX_SUGGESTIONS)
  return results.map(result =>
    createFileSuggestionItem(result.path, result.score),
  )
}

/**
 * 如果尚未进行中，则启动文件索引缓存的后台刷新。
 *
 * 节流：当缓存已存在时，我们跳过刷新，除非 git 状态
 * 实际已更改。这防止每次按键都生成 git ls-files
 * 并重建 nucleo 索引。
 */
const REFRESH_THROTTLE_MS = 5_000
export function startBackgroundCacheRefresh(): void {
  if (fileListRefreshPromise) {
    return
  }

  // 仅在缓存存在时节流 —— 冷启动必须始终填充。
  // 当 .git/index mtime 更改时立即刷新（已跟踪文件）。
  // 否则最多每 5 秒刷新一次 —— 此下限获取新的未跟踪
  // 文件，它们不会触碰 .git/index。下游的签名检查跳过
  // 重建，当 5 秒刷新没有发现实际更改时。
  const indexMtime = getGitIndexMtime()
  if (fileIndex) {
    const gitStateChanged =
      indexMtime !== null && indexMtime !== lastGitIndexMtime
    if (!gitStateChanged && Date.now() - lastRefreshMs < REFRESH_THROTTLE_MS) {
      return
    }
  }

  const generation = cacheGeneration
  const refreshStart = Date.now()
  // 确保 FileIndex 单例存在 —— 它在构建运行时通过
  // readyCount 渐进可查询。早期搜索的调用方获得部分
  // 结果；indexBuildComplete 在 .done 后触发，以便他们可以重新搜索。
  getFileIndex()
  fileListRefreshPromise = getPathsForSuggestions()
    .then(result => {
      if (generation !== cacheGeneration) {
        return result // 缓存已被清除；不要用陈旧数据覆盖
      }
      fileListRefreshPromise = null
      indexBuildComplete.emit()
      // 成功时提交开始时间的 mtime 观察。如果 git 状态
      // 在刷新期间更改，下一次调用将看到更新的 mtime 并
      // 正确地再次刷新。
      lastGitIndexMtime = indexMtime
      lastRefreshMs = Date.now()
      logForDebugging(
        `[FileIndex] cache refresh completed in ${Date.now() - refreshStart}ms`,
      )
      return result
    })
    .catch(error => {
      logForDebugging(
        `[FileIndex] Cache refresh failed: ${errorMessage(error)}`,
      )
      logError(error)
      if (generation === cacheGeneration) {
        fileListRefreshPromise = null // 允许下次调用时重试
      }
      return getFileIndex()
    })
}

/**
 * 获取当前工作目录中的顶级文件和目录
 * @returns 当前目录中的文件/目录路径数组
 */
async function getTopLevelPaths(): Promise<string[]> {
  const fs = getFsImplementation()
  const cwd = getCwd()

  try {
    const entries = await fs.readdir(cwd)
    return entries.map(entry => {
      const fullPath = path.join(cwd, entry.name)
      const relativePath = path.relative(cwd, fullPath)
      // 为目录添加尾部分隔符
      return entry.isDirectory() ? relativePath + path.sep : relativePath
    })
  } catch (error) {
    logError(error as Error)
    return []
  }
}

/**
 * 为当前输入和光标位置生成文件建议
 * @param partialPath 要匹配的部分文件路径
 * @param showOnEmpty 即使 partialPath 为空时也显示建议（用于 @ 符号）
 */
export async function generateFileSuggestions(
  partialPath: string,
  showOnEmpty = false,
): Promise<SuggestionItem[]> {
  // 如果输入为空且我们不想在空时显示建议，则返回空
  if (!partialPath && !showOnEmpty) {
    return []
  }

  // 如果配置了则直接使用自定义命令。我们不混入我们的配置文件
  // 因为命令使用其自己的搜索逻辑返回预排序结果。
  if (getInitialSettings().fileSuggestion?.type === 'command') {
    const input: FileSuggestionCommandInput = {
      ...createBaseHookInput(),
      query: partialPath,
    }
    const results = await executeFileSuggestionCommand(input)
    return results.slice(0, MAX_SUGGESTIONS).map(createFileSuggestionItem)
  }

  // 如果部分路径为空或只是点，则返回当前目录建议
  if (partialPath === '' || partialPath === '.' || partialPath === './') {
    const topLevelPaths = await getTopLevelPaths()
    startBackgroundCacheRefresh()
    return topLevelPaths.slice(0, MAX_SUGGESTIONS).map(createFileSuggestionItem)
  }

  const startTime = Date.now()

  try {
    // 启动后台刷新。索引渐进可查询 ——
    // 构建期间的搜索从就绪块返回部分结果，
    // 且即时补全回调（setOnIndexBuildComplete）在构建完成时重新触发搜索
    // 以将部分升级为完整。
    const wasBuilding = fileListRefreshPromise !== null
    startBackgroundCacheRefresh()

    // 同时处理 './' 和 '.\'
    let normalizedPath = partialPath
    const currentDirPrefix = '.' + path.sep
    if (partialPath.startsWith(currentDirPrefix)) {
      normalizedPath = partialPath.substring(2)
    }

    // 处理主目录的波浪号展开
    if (normalizedPath.startsWith('~')) {
      normalizedPath = expandPath(normalizedPath)
    }

    const matches = fileIndex
      ? findMatchingFiles(fileIndex, normalizedPath)
      : []

    const duration = Date.now() - startTime
    logForDebugging(
      `[FileIndex] generateFileSuggestions: ${matches.length} results in ${duration}ms (${wasBuilding ? 'partial' : 'full'} index)`,
    )
    logEvent('tengu_file_suggestions_query', {
      duration_ms: duration,
      cache_hit: !wasBuilding,
      result_count: matches.length,
      query_length: partialPath.length,
    })

    return matches
  } catch (error) {
    logError(error)
    return []
  }
}

/**
 * 将文件建议应用于输入
 */
export function applyFileSuggestion(
  suggestion: string | SuggestionItem,
  input: string,
  partialPath: string,
  startPos: number,
  onInputChange: (value: string) => void,
  setCursorOffset: (offset: number) => void,
): void {
  // 从字符串或 SuggestionItem 中提取建议文本
  const suggestionText =
    typeof suggestion === 'string' ? suggestion : suggestion.displayText

  // 用所选文件路径替换部分路径
  const newInput =
    input.substring(0, startPos) +
    suggestionText +
    input.substring(startPos + partialPath.length)
  onInputChange(newInput)

  // 将光标移动到文件路径末尾
  const newCursorPos = startPos + suggestionText.length
  setCursorOffset(newCursorPos)
}
