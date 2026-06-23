/**
 * 插件下架检测。
 *
 * 将已安装插件与 marketplace 清单进行对比，找出已被移除的插件，
 * 并自动卸载它们。
 *
 * security.json 获取已被移除（参见 #25447）—— 每周约 2950 万次 GitHub 请求
 * 仅用于 UI 原因/文本。若重新引入，请从 downloads.claude.ai 提供。
 */

import { uninstallPluginOp } from '../../services/plugins/pluginOperations.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import { loadInstalledPluginsV2 } from './installedPluginsManager.js'
import {
  getMarketplace,
  loadKnownMarketplacesConfigSafe,
} from './marketplaceManager.js'
import {
  addFlaggedPlugin,
  getFlaggedPlugins,
  loadFlaggedPlugins,
} from './pluginFlagging.js'
import type { InstalledPluginsFileV2, PluginMarketplace } from './schemas.js'

/**
 * 检测已从 marketplace 下架的已安装插件。
 *
 * @param installedPlugins 所有已安装插件
 * @param marketplace 要检查的 marketplace
 * @param marketplaceName marketplace 名称后缀（例如 "claude-plugins-official"）
 * @returns "name@marketplace" 格式的下架插件 ID 列表
 */
export function detectDelistedPlugins(
  installedPlugins: InstalledPluginsFileV2,
  marketplace: PluginMarketplace,
  marketplaceName: string,
): string[] {
  const marketplacePluginNames = new Set(marketplace.plugins.map(p => p.name))
  const suffix = `@${marketplaceName}`

  const delisted: string[] = []
  for (const pluginId of Object.keys(installedPlugins.plugins)) {
    if (!pluginId.endsWith(suffix)) continue

    const pluginName = pluginId.slice(0, -suffix.length)
    if (!marketplacePluginNames.has(pluginName)) {
      delisted.push(pluginId)
    }
  }

  return delisted
}

/**
 * 跨所有 marketplace 检测下架插件，自动卸载它们，
 * 并将其记录为已标记。
 *
 * 这是核心的下架执行逻辑，在交互模式（useManagePlugins）
 * 和无头模式（main.tsx 打印路径）之间共享。
 *
 * @returns 新标记的插件 ID 列表
 */
export async function detectAndUninstallDelistedPlugins(): Promise<string[]> {
  await loadFlaggedPlugins()

  const installedPlugins = loadInstalledPluginsV2()
  const alreadyFlagged = getFlaggedPlugins()
  // 只读遍历 —— 使用 Safe 变体，以便损坏的配置不会从此函数抛出
  //（它在 useManagePlugins 中与 loadAllPlugins 在同一个 try 块中调用，
  // 因此此处的抛出会使 loadAllPlugins 的容错性失效）。
  const knownMarketplaces = await loadKnownMarketplacesConfigSafe()
  const newlyFlagged: string[] = []

  for (const marketplaceName of Object.keys(knownMarketplaces)) {
    try {
      const marketplace = await getMarketplace(marketplaceName)

      if (!marketplace.forceRemoveDeletedPlugins) continue

      const delisted = detectDelistedPlugins(
        installedPlugins,
        marketplace,
        marketplaceName,
      )

      for (const pluginId of delisted) {
        if (pluginId in alreadyFlagged) continue

        // 跳过仅托管的插件 —— 应由企业管理员处理
        const installations = installedPlugins.plugins[pluginId] ?? []
        const hasUserInstall = installations.some(
          i =>
            i.scope === 'user' || i.scope === 'project' || i.scope === 'local',
        )
        if (!hasUserInstall) continue

        // 从所有用户可控制的作用域自动卸载下架的插件
        for (const installation of installations) {
          const { scope } = installation
          if (scope !== 'user' && scope !== 'project' && scope !== 'local') {
            continue
          }
          try {
            await uninstallPluginOp(pluginId, scope)
          } catch (error) {
            logForDebugging(
              `Failed to auto-uninstall delisted plugin ${pluginId} from ${scope}: ${errorMessage(error)}`,
              { level: 'error' },
            )
          }
        }

        await addFlaggedPlugin(pluginId)
        newlyFlagged.push(pluginId)
      }
    } catch (error) {
      // Marketplace 可能尚未可用 —— 记录并继续
      logForDebugging(
        `Failed to check for delisted plugins in "${marketplaceName}": ${errorMessage(error)}`,
        { level: 'warn' },
      )
    }
  }

  return newlyFlagged
}
