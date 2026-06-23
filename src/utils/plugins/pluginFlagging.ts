/**
 * 已标记插件的跟踪工具
 *
 * 跟踪因在市场中被下架而被自动移除的插件。数据存储在
 * ~/.claude/plugins/flagged-plugins.json 中。
 * 被标记的插件会在 /plugins 的"已标记"区块中显示，直到用户
 * 将其关闭为止。
 *
 * 使用模块级缓存，使得 getFlaggedPlugins() 可以在 React 渲染期间
 * 以同步方式调用。缓存在首次异步调用（loadFlaggedPlugins 或 addFlaggedPlugin）时填充，
 * 并与写入操作保持同步。
 */

import { randomBytes } from 'crypto'
import { readFile, rename, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { logForDebugging } from '../debug.js'
import { getFsImplementation } from '../fsOperations.js'
import { logError } from '../log.js'
import { jsonParse, jsonStringify } from '../slowOperations.js'
import { getPluginsDirectory } from './pluginDirectories.js'

const FLAGGED_PLUGINS_FILENAME = 'flagged-plugins.json'

export type FlaggedPlugin = {
  flaggedAt: string
  seenAt?: string
}

const SEEN_EXPIRY_MS = 48 * 60 * 60 * 1000 // 48 小时

// 模块级缓存——由 loadFlaggedPlugins() 填充，随写入操作更新。
let cache: Record<string, FlaggedPlugin> | null = null

function getFlaggedPluginsPath(): string {
  return join(getPluginsDirectory(), FLAGGED_PLUGINS_FILENAME)
}

function parsePluginsData(content: string): Record<string, FlaggedPlugin> {
  const parsed = jsonParse(content) as unknown
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('plugins' in parsed) ||
    typeof (parsed as { plugins: unknown }).plugins !== 'object' ||
    (parsed as { plugins: unknown }).plugins === null
  ) {
    return {}
  }
  const plugins = (parsed as { plugins: Record<string, unknown> }).plugins
  const result: Record<string, FlaggedPlugin> = {}
  for (const [id, entry] of Object.entries(plugins)) {
    if (
      entry &&
      typeof entry === 'object' &&
      'flaggedAt' in entry &&
      typeof (entry as { flaggedAt: unknown }).flaggedAt === 'string'
    ) {
      const parsed: FlaggedPlugin = {
        flaggedAt: (entry as { flaggedAt: string }).flaggedAt,
      }
      if (
        'seenAt' in entry &&
        typeof (entry as { seenAt: unknown }).seenAt === 'string'
      ) {
        parsed.seenAt = (entry as { seenAt: string }).seenAt
      }
      result[id] = parsed
    }
  }
  return result
}

async function readFromDisk(): Promise<Record<string, FlaggedPlugin>> {
  try {
    const content = await readFile(getFlaggedPluginsPath(), {
      encoding: 'utf-8',
    })
    return parsePluginsData(content)
  } catch {
    return {}
  }
}

async function writeToDisk(
  plugins: Record<string, FlaggedPlugin>,
): Promise<void> {
  const filePath = getFlaggedPluginsPath()
  const tempPath = `${filePath}.${randomBytes(8).toString('hex')}.tmp`

  try {
    await getFsImplementation().mkdir(getPluginsDirectory())

    const content = jsonStringify({ plugins }, null, 2)
    await writeFile(tempPath, content, {
      encoding: 'utf-8',
      mode: 0o600,
    })
    await rename(tempPath, filePath)
    cache = plugins
  } catch (error) {
    logError(error)
    try {
      await unlink(tempPath)
    } catch {
      // 忽略清理错误
    }
  }
}

/**
 * 从磁盘加载已标记插件到模块缓存。
 * 必须先调用（并 await）此函数，getFlaggedPlugins() 才能返回有效数据。
 * 在插件刷新期间由 useManagePlugins 调用。
 */
export async function loadFlaggedPlugins(): Promise<void> {
  const all = await readFromDisk()
  const now = Date.now()
  let changed = false

  for (const [id, entry] of Object.entries(all)) {
    if (
      entry.seenAt &&
      now - new Date(entry.seenAt).getTime() >= SEEN_EXPIRY_MS
    ) {
      delete all[id]
      changed = true
    }
  }

  cache = all
  if (changed) {
    await writeToDisk(all)
  }
}

/**
 * 从内存缓存中获取所有已标记的插件。
 * 如果尚未调用 loadFlaggedPlugins()，则返回空对象。
 */
export function getFlaggedPlugins(): Record<string, FlaggedPlugin> {
  return cache ?? {}
}

/**
 * 将插件添加到已标记列表。
 *
 * @param pluginId "name@marketplace" 格式
 */
export async function addFlaggedPlugin(pluginId: string): Promise<void> {
  if (cache === null) {
    cache = await readFromDisk()
  }

  const updated = {
    ...cache,
    [pluginId]: {
      flaggedAt: new Date().toISOString(),
    },
  }

  await writeToDisk(updated)
  logForDebugging(`Flagged plugin: ${pluginId}`)
}

/**
 * 将已标记的插件标记为已查看。在已安装视图渲染已标记插件时调用。
 * 对尚未设置 seenAt 的条目设置 seenAt。
 * 从 seenAt 起 48 小时后，条目在下次加载时自动清除。
 */
export async function markFlaggedPluginsSeen(
  pluginIds: string[],
): Promise<void> {
  if (cache === null) {
    cache = await readFromDisk()
  }
  const now = new Date().toISOString()
  let changed = false

  const updated = { ...cache }
  for (const id of pluginIds) {
    const entry = updated[id]
    if (entry && !entry.seenAt) {
      updated[id] = { ...entry, seenAt: now }
      changed = true
    }
  }

  if (changed) {
    await writeToDisk(updated)
  }
}

/**
 * 从已标记列表中移除插件。当用户在 /plugins 中关闭
 * 已标记插件通知时调用。
 */
export async function removeFlaggedPlugin(pluginId: string): Promise<void> {
  if (cache === null) {
    cache = await readFromDisk()
  }
  if (!(pluginId in cache)) return

  const { [pluginId]: _, ...rest } = cache
  cache = rest
  await writeToDisk(rest)
}
