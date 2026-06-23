/**
 * 后台插件自动更新功能
 *
 * 启动时，本模块：
 * 1. 首先更新启用了 autoUpdate 的 marketplace
 * 2. 然后检查来自这些 marketplace 的所有已安装插件并更新它们
 *
 * 更新采用非就地方式（仅磁盘），需要重启才能生效。
 * Anthropic 官方 marketplace 默认启用 autoUpdate，
 * 但用户可以按 marketplace 禁用它。
 */

import { updatePluginOp } from '../../services/plugins/pluginOperations.js'
import { shouldSkipPluginAutoupdate } from '../config.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import { logError } from '../log.js'
import {
  getPendingUpdatesDetails,
  hasPendingUpdates,
  isInstallationRelevantToCurrentProject,
  loadInstalledPluginsFromDisk,
} from './installedPluginsManager.js'
import {
  getDeclaredMarketplaces,
  loadKnownMarketplacesConfig,
  refreshMarketplace,
} from './marketplaceManager.js'
import { parsePluginIdentifier } from './pluginIdentifier.js'
import { isMarketplaceAutoUpdate, type PluginScope } from './schemas.js'

/**
 * 插件更新通知的回调类型
 */
export type PluginAutoUpdateCallback = (updatedPlugins: string[]) => void

// 存储插件更新通知的回调
let pluginUpdateCallback: PluginAutoUpdateCallback | null = null

// 存储在回调注册前发生的待处理更新
// 这处理了更新在 REPL 挂载前完成的竞态条件
let pendingNotification: string[] | null = null

/**
 * 注册一个在插件自动更新时收到通知的回调。
 * REPL 使用此函数显示重启通知。
 *
 * 若在回调注册前插件已被更新，
 * 回调将立即被调用并传入待处理的更新。
 */
export function onPluginsAutoUpdated(
  callback: PluginAutoUpdateCallback,
): () => void {
  pluginUpdateCallback = callback

  // 若在注册前有待处理的更新，立即交付它们
  if (pendingNotification !== null && pendingNotification.length > 0) {
    callback(pendingNotification)
    pendingNotification = null
  }

  return () => {
    pluginUpdateCallback = null
  }
}

/**
 * 检查待处理的更新是否来自自动更新（用于通知目的）。
 * 返回有待处理更新的插件名称列表。
 */
export function getAutoUpdatedPluginNames(): string[] {
  if (!hasPendingUpdates()) {
    return []
  }
  return getPendingUpdatesDetails().map(
    d => parsePluginIdentifier(d.pluginId).name,
  )
}

/**
 * 获取启用了 autoUpdate 的 marketplace 集合。
 * 返回应自动更新的 marketplace 名称。
 */
async function getAutoUpdateEnabledMarketplaces(): Promise<Set<string>> {
  const config = await loadKnownMarketplacesConfig()
  const declared = getDeclaredMarketplaces()
  const enabled = new Set<string>()

  for (const [name, entry] of Object.entries(config)) {
    // Settings 声明的 autoUpdate 优先于 JSON 状态
    const declaredAutoUpdate = declared[name]?.autoUpdate
    const autoUpdate =
      declaredAutoUpdate !== undefined
        ? declaredAutoUpdate
        : isMarketplaceAutoUpdate(name, entry)
    if (autoUpdate) {
      enabled.add(name.toLowerCase())
    }
  }

  return enabled
}

/**
 * 更新单个插件的所有安装。
 * 若任意安装被更新则返回插件 ID，否则返回 null。
 */
async function updatePlugin(
  pluginId: string,
  installations: Array<{ scope: PluginScope; projectPath?: string }>,
): Promise<string | null> {
  let wasUpdated = false

  for (const { scope } of installations) {
    try {
      const result = await updatePluginOp(pluginId, scope)

      if (result.success && !result.alreadyUpToDate) {
        wasUpdated = true
        logForDebugging(
          `Plugin autoupdate: updated ${pluginId} from ${result.oldVersion} to ${result.newVersion}`,
        )
      } else if (!result.alreadyUpToDate) {
        logForDebugging(
          `Plugin autoupdate: failed to update ${pluginId}: ${result.message}`,
          { level: 'warn' },
        )
      }
    } catch (error) {
      logForDebugging(
        `Plugin autoupdate: error updating ${pluginId}: ${errorMessage(error)}`,
        { level: 'warn' },
      )
    }
  }

  return wasUpdated ? pluginId : null
}

/**
 * 更新所有与当前项目相关的已安装插件（来自给定的 marketplace）。
 *
 * 遍历 installed_plugins.json，过滤出 marketplace 在集合中的插件，
 * 进一步过滤每个插件的安装为与当前项目相关的安装（user/managed 作用域，
 * 或与 cwd 匹配的 project/local 作用域 —— 参见 isInstallationRelevantToCurrentProject），
 * 然后对每个安装调用 updatePluginOp。已是最新的插件会被静默跳过。
 *
 * 调用方：
 * - 下方的 updatePlugins() —— 后台自动更新路径（仅限 autoUpdate 启用的
 *   marketplace；第三方 marketplace 默认 autoUpdate: false）
 * - ManageMarketplaces.tsx 的 applyChanges() —— 用户发起的 /plugin marketplace
 *   更新。在 #29512 之前，此路径仅调用 refreshMarketplace()（对 marketplace
 *   克隆执行 git pull），因此加载器会创建新版本缓存目录，但 installed_plugins.json
 *   仍停留在旧版本，孤立 GC 在下次启动时会在新目录上盖上 .orphaned_at。
 *
 * @param marketplaceNames - 要更新插件的小写 marketplace 名称
 * @returns 实际被更新的插件 ID（非已是最新的）
 */
export async function updatePluginsForMarketplaces(
  marketplaceNames: Set<string>,
): Promise<string[]> {
  const installedPlugins = loadInstalledPluginsFromDisk()
  const pluginIds = Object.keys(installedPlugins.plugins)

  if (pluginIds.length === 0) {
    return []
  }

  const results = await Promise.allSettled(
    pluginIds.map(async pluginId => {
      const { marketplace } = parsePluginIdentifier(pluginId)
      if (!marketplace || !marketplaceNames.has(marketplace.toLowerCase())) {
        return null
      }

      const allInstallations = installedPlugins.plugins[pluginId]
      if (!allInstallations || allInstallations.length === 0) {
        return null
      }

      const relevantInstallations = allInstallations.filter(
        isInstallationRelevantToCurrentProject,
      )
      if (relevantInstallations.length === 0) {
        return null
      }

      return updatePlugin(pluginId, relevantInstallations)
    }),
  )

  return results
    .filter(
      (r): r is PromiseFulfilledResult<string> =>
        r.status === 'fulfilled' && r.value !== null,
    )
    .map(r => r.value)
}

/**
 * 从启用了 autoUpdate 的 marketplace 更新插件。
 * 返回被更新的插件 ID 列表。
 */
async function updatePlugins(
  autoUpdateEnabledMarketplaces: Set<string>,
): Promise<string[]> {
  return updatePluginsForMarketplaces(autoUpdateEnabledMarketplaces)
}

/**
 * 在后台自动更新 marketplace 和插件。
 *
 * 此函数：
 * 1. 检查哪些 marketplace 启用了 autoUpdate
 * 2. 仅刷新这些 marketplace（git pull/重新下载）
 * 3. 更新来自这些 marketplace 的已安装插件
 * 4. 若有插件被更新，通过注册的回调通知
 *
 * Anthropic 官方 marketplace 默认启用 autoUpdate，
 * 但用户可以在 UI 中按 marketplace 禁用它。
 *
 * 此函数静默运行，不阻塞用户交互。
 * 在启动期间从 main.tsx 作为后台任务调用。
 */
export function autoUpdateMarketplacesAndPluginsInBackground(): void {
  void (async () => {
    if (shouldSkipPluginAutoupdate()) {
      logForDebugging('Plugin autoupdate: skipped (auto-updater disabled)')
      return
    }

    try {
      // 获取启用了 autoUpdate 的 marketplace
      const autoUpdateEnabledMarketplaces =
        await getAutoUpdateEnabledMarketplaces()

      if (autoUpdateEnabledMarketplaces.size === 0) {
        return
      }

      // 仅刷新启用了 autoUpdate 的 marketplace
      const refreshResults = await Promise.allSettled(
        Array.from(autoUpdateEnabledMarketplaces).map(async name => {
          try {
            await refreshMarketplace(name, undefined, {
              disableCredentialHelper: true,
            })
          } catch (error) {
            logForDebugging(
              `Plugin autoupdate: failed to refresh marketplace ${name}: ${errorMessage(error)}`,
              { level: 'warn' },
            )
          }
        }),
      )

      // 记录所有刷新失败
      const failures = refreshResults.filter(r => r.status === 'rejected')
      if (failures.length > 0) {
        logForDebugging(
          `Plugin autoupdate: ${failures.length} marketplace refresh(es) failed`,
          { level: 'warn' },
        )
      }

      logForDebugging('Plugin autoupdate: checking installed plugins')
      const updatedPlugins = await updatePlugins(autoUpdateEnabledMarketplaces)

      if (updatedPlugins.length > 0) {
        if (pluginUpdateCallback) {
          // 回调已注册，立即调用
          pluginUpdateCallback(updatedPlugins)
        } else {
          // 回调尚未注册（REPL 未挂载），存储以便稍后交付
          pendingNotification = updatedPlugins
        }
      }
    } catch (error) {
      logError(error)
    }
  })()
}
