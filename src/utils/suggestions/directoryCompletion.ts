import { LRUCache } from 'lru-cache'
import { basename, dirname, join, sep } from 'path'
import type { SuggestionItem } from 'src/components/PromptInput/PromptInputFooterSuggestions.js'
import { getCwd } from 'src/utils/cwd.js'
import { getFsImplementation } from 'src/utils/fsOperations.js'
import { logError } from 'src/utils/log.js'
import { expandPath } from 'src/utils/path.js'
// 类型定义
export type DirectoryEntry = {
  name: string
  path: string
  type: 'directory'
}

export type PathEntry = {
  name: string
  path: string
  type: 'directory' | 'file'
}

export type CompletionOptions = {
  basePath?: string
  maxResults?: number
}

export type PathCompletionOptions = CompletionOptions & {
  includeFiles?: boolean
  includeHidden?: boolean
}

type ParsedPath = {
  directory: string
  prefix: string
}

// 缓存配置
const CACHE_SIZE = 500
const CACHE_TTL = 5 * 60 * 1000 // 5 分钟

// 初始化目录扫描的 LRU 缓存
const directoryCache = new LRUCache<string, DirectoryEntry[]>({
  max: CACHE_SIZE,
  ttl: CACHE_TTL,
})

// 初始化路径扫描的 LRU 缓存（文件和目录）
const pathCache = new LRUCache<string, PathEntry[]>({
  max: CACHE_SIZE,
  ttl: CACHE_TTL,
})

/**
 * 将部分路径解析为目录和前缀两部分
 */
export function parsePartialPath(
  partialPath: string,
  basePath?: string,
): ParsedPath {
  // 处理空输入
  if (!partialPath) {
    const directory = basePath || getCwd()
    return { directory, prefix: '' }
  }

  const resolved = expandPath(partialPath, basePath)

  // 如果路径以分隔符结尾，视为无文件前缀的目录
  // 同时处理正斜杠和平台特定分隔符
  if (partialPath.endsWith('/') || partialPath.endsWith(sep)) {
    return { directory: resolved, prefix: '' }
  }

  // 拆分为目录和前缀
  const directory = dirname(resolved)
  const prefix = basename(partialPath)

  return { directory, prefix }
}

/**
 * 扫描目录并返回子目录列表
 * 使用 LRU 缓存避免重复的文件系统调用
 */
export async function scanDirectory(
  dirPath: string,
): Promise<DirectoryEntry[]> {
  // 优先检查缓存
  const cached = directoryCache.get(dirPath)
  if (cached) {
    return cached
  }

  try {
    // 读取目录内容
    const fs = getFsImplementation()
    const entries = await fs.readdir(dirPath)

    // 只保留目录，排除隐藏目录
    const directories = entries
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => ({
        name: entry.name,
        path: join(dirPath, entry.name),
        type: 'directory' as const,
      }))
      .slice(0, 100) // 限制结果数量（MVP 阶段）

    // 缓存结果
    directoryCache.set(dirPath, directories)

    return directories
  } catch (error) {
    logError(error)
    return []
  }
}

/**
 * 获取目录补全建议的主函数
 */
export async function getDirectoryCompletions(
  partialPath: string,
  options: CompletionOptions = {},
): Promise<SuggestionItem[]> {
  const { basePath = getCwd(), maxResults = 10 } = options

  const { directory, prefix } = parsePartialPath(partialPath, basePath)
  const entries = await scanDirectory(directory)
  const prefixLower = prefix.toLowerCase()
  const matches = entries
    .filter(entry => entry.name.toLowerCase().startsWith(prefixLower))
    .slice(0, maxResults)

  return matches.map(entry => ({
    id: entry.path,
    displayText: entry.name + '/',
    description: 'directory',
    metadata: { type: 'directory' as const },
  }))
}

/**
 * 清除目录缓存
 */
export function clearDirectoryCache(): void {
  directoryCache.clear()
}

/**
 * 判断字符串是否看起来像路径（以类似路径的前缀开头）
 */
export function isPathLikeToken(token: string): boolean {
  return (
    token.startsWith('~/') ||
    token.startsWith('/') ||
    token.startsWith('./') ||
    token.startsWith('../') ||
    token === '~' ||
    token === '.' ||
    token === '..'
  )
}

/**
 * 扫描目录并返回文件和子目录列表
 * 使用 LRU 缓存避免重复的文件系统调用
 */
export async function scanDirectoryForPaths(
  dirPath: string,
  includeHidden = false,
): Promise<PathEntry[]> {
  const cacheKey = `${dirPath}:${includeHidden}`
  const cached = pathCache.get(cacheKey)
  if (cached) {
    return cached
  }

  try {
    const fs = getFsImplementation()
    const entries = await fs.readdir(dirPath)

    const paths = entries
      .filter(entry => includeHidden || !entry.name.startsWith('.'))
      .map(entry => ({
        name: entry.name,
        path: join(dirPath, entry.name),
        type: entry.isDirectory() ? ('directory' as const) : ('file' as const),
      }))
      .sort((a, b) => {
        // 目录优先排序，其次按字母顺序
        if (a.type === 'directory' && b.type !== 'directory') return -1
        if (a.type !== 'directory' && b.type === 'directory') return 1
        return a.name.localeCompare(b.name)
      })
      .slice(0, 100)

    pathCache.set(cacheKey, paths)
    return paths
  } catch (error) {
    logError(error)
    return []
  }
}

/**
 * 获取文件和目录的路径补全建议
 */
export async function getPathCompletions(
  partialPath: string,
  options: PathCompletionOptions = {},
): Promise<SuggestionItem[]> {
  const {
    basePath = getCwd(),
    maxResults = 10,
    includeFiles = true,
    includeHidden = false,
  } = options

  const { directory, prefix } = parsePartialPath(partialPath, basePath)
  const entries = await scanDirectoryForPaths(directory, includeHidden)
  const prefixLower = prefix.toLowerCase()

  const matches = entries
    .filter(entry => {
      if (!includeFiles && entry.type === 'file') return false
      return entry.name.toLowerCase().startsWith(prefixLower)
    })
    .slice(0, maxResults)

  // 根据原始 partialPath 构造相对路径
  // 例如，如果 partialPath 为 "src/c"，目录部分为 "src/"
  // 去掉开头的 "./"，因为它只是用于当前目录搜索
  // 同时处理正斜杠和平台分隔符，兼容 Windows
  const hasSeparator = partialPath.includes('/') || partialPath.includes(sep)
  let dirPortion = ''
  if (hasSeparator) {
    // 查找最后一个分隔符（/ 或平台特定分隔符）
    const lastSlash = partialPath.lastIndexOf('/')
    const lastSep = partialPath.lastIndexOf(sep)
    const lastSeparatorPos = Math.max(lastSlash, lastSep)
    dirPortion = partialPath.substring(0, lastSeparatorPos + 1)
  }
  if (dirPortion.startsWith('./') || dirPortion.startsWith('.' + sep)) {
    dirPortion = dirPortion.slice(2)
  }

  return matches.map(entry => {
    const fullPath = dirPortion + entry.name
    return {
      id: fullPath,
      displayText: entry.type === 'directory' ? fullPath + '/' : fullPath,
      metadata: { type: entry.type },
    }
  })
}

/**
 * 清除目录和路径缓存
 */
export function clearPathCache(): void {
  directoryCache.clear()
  pathCache.clear()
}
