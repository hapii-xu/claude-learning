/**
 * Zip 缓存适配器
 *
 * 插件 zip 缓存的 I/O 辅助函数。这些函数处理读/写
 * zip 缓存本地元数据文件、将 ZIP 提取到会话目录，
 * 以及为新安装的插件创建 ZIP。
 *
 * zip 缓存将数据存储在挂载卷（如 Filestore）上，跨临时容器
 * 生命周期持久化。会话缓存是本地临时目录，
 * 用于单次会话中已提取的插件。
 */

import { readFile } from 'fs/promises'
import { join } from 'path'
import { logForDebugging } from '../debug.js'
import { jsonParse, jsonStringify } from '../slowOperations.js'
import { loadKnownMarketplacesConfigSafe } from './marketplaceManager.js'
import {
  type KnownMarketplacesFile,
  KnownMarketplacesFileSchema,
  type PluginMarketplace,
  PluginMarketplaceSchema,
} from './schemas.js'
import {
  atomicWriteToZipCache,
  getMarketplaceJsonRelativePath,
  getPluginZipCachePath,
  getZipCacheKnownMarketplacesPath,
} from './zipCache.js'

// ── 元数据 I/O ──

/**
 * 从 zip 缓存读取 known_marketplaces.json。
 * 若文件不存在、无法解析或 schema 验证失败则返回空对象
 * （数据来自共享挂载卷 — 其他容器可能写入）。
 */
export async function readZipCacheKnownMarketplaces(): Promise<KnownMarketplacesFile> {
  try {
    const content = await readFile(getZipCacheKnownMarketplacesPath(), 'utf-8')
    const parsed = KnownMarketplacesFileSchema().safeParse(jsonParse(content))
    if (!parsed.success) {
      logForDebugging(
        `Invalid known_marketplaces.json in zip cache: ${parsed.error.message}`,
        { level: 'error' },
      )
      return {}
    }
    return parsed.data
  } catch {
    return {}
  }
}

/**
 * 原子地将 known_marketplaces.json 写入 zip 缓存。
 */
export async function writeZipCacheKnownMarketplaces(
  data: KnownMarketplacesFile,
): Promise<void> {
  await atomicWriteToZipCache(
    getZipCacheKnownMarketplacesPath(),
    jsonStringify(data, null, 2),
  )
}

// ── Marketplace JSON ──

/**
 * 从 zip 缓存读取 marketplace JSON 文件。
 */
export async function readMarketplaceJson(
  marketplaceName: string,
): Promise<PluginMarketplace | null> {
  const zipCachePath = getPluginZipCachePath()
  if (!zipCachePath) {
    return null
  }
  const relPath = getMarketplaceJsonRelativePath(marketplaceName)
  const fullPath = join(zipCachePath, relPath)
  try {
    const content = await readFile(fullPath, 'utf-8')
    const parsed = jsonParse(content)
    const result = PluginMarketplaceSchema().safeParse(parsed)
    if (result.success) {
      return result.data
    }
    logForDebugging(
      `Invalid marketplace JSON for ${marketplaceName}: ${result.error}`,
    )
    return null
  } catch {
    return null
  }
}

/**
 * 从安装位置将 marketplace JSON 保存到 zip 缓存。
 */
export async function saveMarketplaceJsonToZipCache(
  marketplaceName: string,
  installLocation: string,
): Promise<void> {
  const zipCachePath = getPluginZipCachePath()
  if (!zipCachePath) {
    return
  }
  const content = await readMarketplaceJsonContent(installLocation)
  if (content !== null) {
    const relPath = getMarketplaceJsonRelativePath(marketplaceName)
    await atomicWriteToZipCache(join(zipCachePath, relPath), content)
  }
}

/**
 * 从克隆的 marketplace 目录或文件读取 marketplace.json 内容。
 * 对于目录来源：检查 .claude-plugin/marketplace.json、marketplace.json
 * 对于 URL 来源：installLocation 本身就是 marketplace JSON 文件。
 */
async function readMarketplaceJsonContent(dir: string): Promise<string | null> {
  const candidates = [
    join(dir, '.claude-plugin', 'marketplace.json'),
    join(dir, 'marketplace.json'),
    dir, // 对于 URL 来源，installLocation 就是 marketplace JSON 文件
  ]
  for (const candidate of candidates) {
    try {
      return await readFile(candidate, 'utf-8')
    } catch {
      // ENOENT（不存在）或 EISDIR（是目录）— 尝试下一个
    }
  }
  return null
}

/**
 * 将 marketplace 数据同步到 zip 缓存以供离线访问。
 * 保存 marketplace JSON 并与之前缓存的数据合并，
 * 以便临时容器无需重新克隆即可访问 marketplace。
 */
export async function syncMarketplacesToZipCache(): Promise<void> {
  // 只读迭代 — 使用 Safe 变体，以免损坏的配置抛出异常。
  // 这在启动路径中运行；此处的抛出会级联到捕获
  // loadAllPlugins 失败的同一 try-block。
  const knownMarketplaces = await loadKnownMarketplacesConfigSafe()

  // 将 marketplace JSON 保存到 zip 缓存
  for (const [name, entry] of Object.entries(knownMarketplaces)) {
    if (!entry.installLocation) continue
    try {
      await saveMarketplaceJsonToZipCache(name, entry.installLocation)
    } catch (error) {
      logForDebugging(`Failed to save marketplace JSON for ${name}: ${error}`)
    }
  }

  // 与之前缓存的数据合并（临时容器会丢失全局配置）
  const zipCacheKnownMarketplaces = await readZipCacheKnownMarketplaces()
  const mergedKnownMarketplaces: KnownMarketplacesFile = {
    ...zipCacheKnownMarketplaces,
    ...knownMarketplaces,
  }
  await writeZipCacheKnownMarketplaces(mergedKnownMarketplaces)
}
