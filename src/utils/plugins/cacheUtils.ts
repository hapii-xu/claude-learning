import { readdir, rm, stat, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { clearCommandsCache } from '../../commands.js'
import { clearAllOutputStylesCache } from '../../constants/outputStyles.js'
import { clearAgentDefinitionsCache } from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import { clearPromptCache } from '@claude-code-best/builtin-tools/tools/SkillTool/prompt.js'
import { resetSentSkillNames } from '../attachments.js'
import { logForDebugging } from '../debug.js'
import { getErrnoCode } from '../errors.js'
import { logError } from '../log.js'
import { loadInstalledPluginsFromDisk } from './installedPluginsManager.js'
import { clearPluginAgentCache } from './loadPluginAgents.js'
import { clearPluginCommandCache } from './loadPluginCommands.js'
import {
  clearPluginHookCache,
  pruneRemovedPluginHooks,
} from './loadPluginHooks.js'
import { clearPluginOutputStyleCache } from './loadPluginOutputStyles.js'
import { clearPluginCache, getPluginCachePath } from './pluginLoader.js'
import { clearPluginOptionsCache } from './pluginOptionsStorage.js'
import { isPluginZipCacheEnabled } from './zipCache.js'

const ORPHANED_AT_FILENAME = '.orphaned_at'
const CLEANUP_AGE_MS = 7 * 24 * 60 * 60 * 1000 // 7 天

export function clearAllPluginCaches(): void {
  clearPluginCache()
  clearPluginCommandCache()
  clearPluginAgentCache()
  clearPluginHookCache()
  // 从不再属于已启用集合的插件中剪除 hooks，使已卸载/禁用的插件立即
  // 停止触发（gh-36995）。仅剪除：新启用插件的 hooks 不在此处添加
  // —— 与命令/代理/MCP 一样等待 /reload-plugins。即发即忘：旧 hooks
  // 在剪除完成之前保持有效（保留 gh-29767）。当 STATE.registeredHooks 为空时
  // 为无操作（test/preload.ts 的 beforeEach 通过 resetStateForTests 在到达此处前清除它）。
  pruneRemovedPluginHooks().catch(e => logError(e))
  clearPluginOptionsCache()
  clearPluginOutputStyleCache()
  clearAllOutputStylesCache()
}

export function clearAllCaches(): void {
  clearAllPluginCaches()
  clearCommandsCache()
  clearAgentDefinitionsCache()
  clearPromptCache()
  resetSentSkillNames()
}

/**
 * 将插件版本标记为孤立。
 * 在插件被卸载或更新到新版本时调用。
 */
export async function markPluginVersionOrphaned(
  versionPath: string,
): Promise<void> {
  try {
    await writeFile(getOrphanedAtPath(versionPath), `${Date.now()}`, 'utf-8')
  } catch (error) {
    logForDebugging(`Failed to write .orphaned_at: ${versionPath}: ${error}`)
  }
}

/**
 * 清理已孤立超过 7 天的插件版本。
 *
 * 第一轮：从已安装版本中移除 .orphaned_at（清除过期标记）
 * 第二轮：对不在 installed_plugins.json 中的每个已缓存版本：
 *   - 若不存在 .orphaned_at：创建它（处理旧版 CC、手动编辑的情况）
 *   - 若 .orphaned_at 存在且超过 7 天：删除该版本
 */
export async function cleanupOrphanedPluginVersionsInBackground(): Promise<void> {
  // Zip 缓存模式将插件存储为 .zip 文件而非目录。readSubdirs
  // 仅过滤目录，因此 removeIfEmpty 会将插件目录视为空目录并删除它们
  // （包括 ZIP 文件）。在 zip 模式下完全跳过清理。
  if (isPluginZipCacheEnabled()) {
    return
  }
  try {
    const installedVersions = getInstalledVersionPaths()
    if (!installedVersions) return

    const cachePath = getPluginCachePath()

    const now = Date.now()

    // 第一轮：从已安装版本中移除 .orphaned_at
    // 处理插件在孤立后被重新安装的情况
    await Promise.all(
      [...installedVersions].map(p => removeOrphanedAtMarker(p)),
    )

    // 第二轮：处理孤立版本
    for (const marketplace of await readSubdirs(cachePath)) {
      const marketplacePath = join(cachePath, marketplace)

      for (const plugin of await readSubdirs(marketplacePath)) {
        const pluginPath = join(marketplacePath, plugin)

        for (const version of await readSubdirs(pluginPath)) {
          const versionPath = join(pluginPath, version)
          if (installedVersions.has(versionPath)) continue
          await processOrphanedPluginVersion(versionPath, now)
        }

        await removeIfEmpty(pluginPath)
      }

      await removeIfEmpty(marketplacePath)
    }
  } catch (error) {
    logForDebugging(`Plugin cache cleanup failed: ${error}`)
  }
}

function getOrphanedAtPath(versionPath: string): string {
  return join(versionPath, ORPHANED_AT_FILENAME)
}

async function removeOrphanedAtMarker(versionPath: string): Promise<void> {
  const orphanedAtPath = getOrphanedAtPath(versionPath)
  try {
    await unlink(orphanedAtPath)
  } catch (error) {
    const code = getErrnoCode(error)
    if (code === 'ENOENT') return
    logForDebugging(`Failed to remove .orphaned_at: ${versionPath}: ${error}`)
  }
}

function getInstalledVersionPaths(): Set<string> | null {
  try {
    const paths = new Set<string>()
    const diskData = loadInstalledPluginsFromDisk()
    for (const installations of Object.values(diskData.plugins)) {
      for (const entry of installations) {
        paths.add(entry.installPath)
      }
    }
    return paths
  } catch (error) {
    logForDebugging(`Failed to load installed plugins: ${error}`)
    return null
  }
}

async function processOrphanedPluginVersion(
  versionPath: string,
  now: number,
): Promise<void> {
  const orphanedAtPath = getOrphanedAtPath(versionPath)

  let orphanedAt: number
  try {
    orphanedAt = (await stat(orphanedAtPath)).mtimeMs
  } catch (error) {
    const code = getErrnoCode(error)
    if (code === 'ENOENT') {
      await markPluginVersionOrphaned(versionPath)
      return
    }
    logForDebugging(`Failed to stat orphaned marker: ${versionPath}: ${error}`)
    return
  }

  if (now - orphanedAt > CLEANUP_AGE_MS) {
    try {
      await rm(versionPath, { recursive: true, force: true })
    } catch (error) {
      logForDebugging(
        `Failed to delete orphaned version: ${versionPath}: ${error}`,
      )
    }
  }
}

async function removeIfEmpty(dirPath: string): Promise<void> {
  if ((await readSubdirs(dirPath)).length === 0) {
    try {
      await rm(dirPath, { recursive: true, force: true })
    } catch (error) {
      logForDebugging(`Failed to remove empty dir: ${dirPath}: ${error}`)
    }
  }
}

async function readSubdirs(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true })
    return entries.filter(d => d.isDirectory()).map(d => d.name)
  } catch {
    return []
  }
}
