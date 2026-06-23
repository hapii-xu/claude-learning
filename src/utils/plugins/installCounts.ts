/**
 * 插件安装次数数据层
 *
 * 本模块从官方 Claude 插件统计仓库获取并缓存插件安装次数。
 * 若缓存超过 24 小时则刷新。
 *
 * 缓存位置：~/.claude/plugins/install-counts-cache.json
 */

import axios from 'axios'
import { randomBytes } from 'crypto'
import { readFile, rename, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { logForDebugging } from '../debug.js'
import { errorMessage, getErrnoCode } from '../errors.js'
import { getFsImplementation } from '../fsOperations.js'
import { logError } from '../log.js'
import { jsonParse, jsonStringify } from '../slowOperations.js'
import { classifyFetchError, logPluginFetch } from './fetchTelemetry.js'
import { getPluginsDirectory } from './pluginDirectories.js'

const INSTALL_COUNTS_CACHE_VERSION = 1
const INSTALL_COUNTS_CACHE_FILENAME = 'install-counts-cache.json'
const INSTALL_COUNTS_URL =
  'https://raw.githubusercontent.com/anthropics/claude-plugins-official/refs/heads/stats/stats/plugin-installs.json'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24 小时（毫秒）

/**
 * 安装次数缓存文件的结构
 */
type InstallCountsCache = {
  version: number
  fetchedAt: string // ISO 时间戳
  counts: Array<{
    plugin: string // "pluginName@marketplace"
    unique_installs: number
  }>
}

/**
 * GitHub 统计响应的预期结构
 */
type GitHubStatsResponse = {
  plugins: Array<{
    plugin: string
    unique_installs: number
  }>
}

/**
 * 获取安装次数缓存文件的路径
 */
function getInstallCountsCachePath(): string {
  return join(getPluginsDirectory(), INSTALL_COUNTS_CACHE_FILENAME)
}

/**
 * 从磁盘加载安装次数缓存。
 * 若文件不存在、无效或过期（>24小时）则返回 null。
 */
async function loadInstallCountsCache(): Promise<InstallCountsCache | null> {
  const cachePath = getInstallCountsCachePath()

  try {
    const content = await readFile(cachePath, { encoding: 'utf-8' })
    const parsed = jsonParse(content) as unknown

    // 验证基本结构
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('version' in parsed) ||
      !('fetchedAt' in parsed) ||
      !('counts' in parsed)
    ) {
      logForDebugging('Install counts cache has invalid structure')
      return null
    }

    const cache = parsed as {
      version: unknown
      fetchedAt: unknown
      counts: unknown
    }

    // 验证版本号
    if (cache.version !== INSTALL_COUNTS_CACHE_VERSION) {
      logForDebugging(
        `Install counts cache version mismatch (got ${cache.version}, expected ${INSTALL_COUNTS_CACHE_VERSION})`,
      )
      return null
    }

    // 验证 fetchedAt 和 counts
    if (typeof cache.fetchedAt !== 'string' || !Array.isArray(cache.counts)) {
      logForDebugging('Install counts cache has invalid structure')
      return null
    }

    // 验证 fetchedAt 是有效日期
    const fetchedAt = new Date(cache.fetchedAt).getTime()
    if (Number.isNaN(fetchedAt)) {
      logForDebugging('Install counts cache has invalid fetchedAt timestamp')
      return null
    }

    // 验证计数条目包含必需字段
    const validCounts = cache.counts.every(
      (entry): entry is { plugin: string; unique_installs: number } =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof entry.plugin === 'string' &&
        typeof entry.unique_installs === 'number',
    )
    if (!validCounts) {
      logForDebugging('Install counts cache has malformed entries')
      return null
    }

    // 检查缓存是否过期（>24 小时）
    const now = Date.now()
    if (now - fetchedAt > CACHE_TTL_MS) {
      logForDebugging('Install counts cache is stale (>24h old)')
      return null
    }

    // 返回经过验证的缓存
    return {
      version: cache.version as number,
      fetchedAt: cache.fetchedAt,
      counts: cache.counts,
    }
  } catch (error) {
    const code = getErrnoCode(error)
    if (code !== 'ENOENT') {
      logForDebugging(
        `Failed to load install counts cache: ${errorMessage(error)}`,
      )
    }
    return null
  }
}

/**
 * 以原子方式将安装次数缓存保存到磁盘。
 * 使用临时文件 + 重命名模式以防止数据损坏。
 */
async function saveInstallCountsCache(
  cache: InstallCountsCache,
): Promise<void> {
  const cachePath = getInstallCountsCachePath()
  const tempPath = `${cachePath}.${randomBytes(8).toString('hex')}.tmp`

  try {
    // 确保插件目录存在
    const pluginsDir = getPluginsDirectory()
    await getFsImplementation().mkdir(pluginsDir)

    // 写入临时文件
    const content = jsonStringify(cache, null, 2)
    await writeFile(tempPath, content, {
      encoding: 'utf-8',
      mode: 0o600,
    })

    // 原子重命名
    await rename(tempPath, cachePath)
    logForDebugging('Install counts cache saved successfully')
  } catch (error) {
    logError(error)
    // 清理临时文件（如果存在）
    try {
      await unlink(tempPath)
    } catch {
      // 忽略清理错误
    }
  }
}

/**
 * 从 GitHub 统计仓库获取安装次数
 */
async function fetchInstallCountsFromGitHub(): Promise<
  Array<{ plugin: string; unique_installs: number }>
> {
  logForDebugging(`Fetching install counts from ${INSTALL_COUNTS_URL}`)

  const started = performance.now()
  try {
    const response = await axios.get<GitHubStatsResponse>(INSTALL_COUNTS_URL, {
      timeout: 10000,
    })

    if (!response.data?.plugins || !Array.isArray(response.data.plugins)) {
      throw new Error('Invalid response format from install counts API')
    }

    logPluginFetch(
      'install_counts',
      INSTALL_COUNTS_URL,
      'success',
      performance.now() - started,
    )
    return response.data.plugins
  } catch (error) {
    logPluginFetch(
      'install_counts',
      INSTALL_COUNTS_URL,
      'failure',
      performance.now() - started,
      classifyFetchError(error),
    )
    throw error
  }
}

/**
 * 以 Map 形式获取插件安装次数。
 * 若缓存可用且不超过 24 小时则使用缓存数据。
 * 出错时返回 null，使 UI 可以隐藏次数而非显示误导性的零。
 *
 * @returns 插件 ID（name@marketplace）到安装次数的 Map，不可用时返回 null
 */
export async function getInstallCounts(): Promise<Map<string, number> | null> {
  // 优先尝试从缓存加载
  const cache = await loadInstallCountsCache()
  if (cache) {
    logForDebugging('Using cached install counts')
    logPluginFetch('install_counts', INSTALL_COUNTS_URL, 'cache_hit', 0)
    const map = new Map<string, number>()
    for (const entry of cache.counts) {
      map.set(entry.plugin, entry.unique_installs)
    }
    return map
  }

  // 缓存未命中或过期 —— 从 GitHub 获取
  try {
    const counts = await fetchInstallCountsFromGitHub()

    // 保存到缓存
    const newCache: InstallCountsCache = {
      version: INSTALL_COUNTS_CACHE_VERSION,
      fetchedAt: new Date().toISOString(),
      counts,
    }
    await saveInstallCountsCache(newCache)

    // 转换为 Map
    const map = new Map<string, number>()
    for (const entry of counts) {
      map.set(entry.plugin, entry.unique_installs)
    }
    return map
  } catch (error) {
    // 记录错误并返回 null，使 UI 可以隐藏次数
    logError(error)
    logForDebugging(`Failed to fetch install counts: ${errorMessage(error)}`)
    return null
  }
}

/**
 * 格式化安装次数以供显示。
 *
 * @param count - 原始安装次数
 * @returns 格式化字符串：
 *   - <1000：原始数字（如 "42"）
 *   - >=1000：K 后缀保留 1 位小数（如 "1.2K"、"36.2K"）
 *   - >=1000000：M 后缀保留 1 位小数（如 "1.2M"）
 */
export function formatInstallCount(count: number): string {
  if (count < 1000) {
    return String(count)
  }

  if (count < 1000000) {
    const k = count / 1000
    // 使用 toFixed(1) 但去掉末尾的 .0
    const formatted = k.toFixed(1)
    return formatted.endsWith('.0')
      ? `${formatted.slice(0, -2)}K`
      : `${formatted}K`
  }

  const m = count / 1000000
  const formatted = m.toFixed(1)
  return formatted.endsWith('.0')
    ? `${formatted.slice(0, -2)}M`
    : `${formatted}M`
}
