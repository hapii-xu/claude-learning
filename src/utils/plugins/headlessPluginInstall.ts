/**
 * 无头/CCR 模式的插件安装。
 *
 * 本模块提供不更新 AppState 的插件安装功能，适用于 CCR 等非交互式环境。
 *
 * 启用 CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE 时，插件以 ZIP 形式存储在挂载卷上。
 * 存储层（pluginLoader.ts）在安装时透明地处理 ZIP 创建，在加载时处理解压。
 */

import { logEvent } from '../../services/analytics/index.js'
import { registerCleanup } from '../cleanupRegistry.js'
import { logForDebugging } from '../debug.js'
import { withDiagnosticsTiming } from '../diagLogs.js'
import { getFsImplementation } from '../fsOperations.js'
import { logError } from '../log.js'
import {
  clearMarketplacesCache,
  getDeclaredMarketplaces,
  registerSeedMarketplaces,
} from './marketplaceManager.js'
import { detectAndUninstallDelistedPlugins } from './pluginBlocklist.js'
import { clearPluginCache } from './pluginLoader.js'
import { reconcileMarketplaces } from './reconciler.js'
import {
  cleanupSessionPluginCache,
  getZipCacheMarketplacesDir,
  getZipCachePluginsDir,
  isMarketplaceSourceSupportedByZipCache,
  isPluginZipCacheEnabled,
} from './zipCache.js'
import { syncMarketplacesToZipCache } from './zipCacheAdapters.js'

/**
 * 为无头/CCR 模式安装插件。
 *
 * 这是 performBackgroundPluginInstallations() 的无头等价物，
 * 但不更新 AppState（无头模式下没有 UI 需要更新）。
 *
 * @returns 若有插件被安装则返回 true（调用者应刷新 MCP）
 */
export async function installPluginsForHeadless(): Promise<boolean> {
  const zipCacheMode = isPluginZipCacheEnabled()
  logForDebugging(
    `installPluginsForHeadless: starting${zipCacheMode ? ' (zip cache mode)' : ''}`,
  )

  // 在 diff 之前注册种子市场（CLAUDE_CODE_PLUGIN_SEED_DIR）。
  // 幂等；若未配置种子则为无操作。没有此步骤，findMissingMarketplaces
  // 会将种子条目视为缺失 → 克隆 → 破坏种子的意义。
  //
  // 若注册改变了状态，清除缓存，以免早期插件加载阶段
  // （在 CLI 启动时、此函数之前运行）保留过期的"市场未找到"结果。
  // 若不清除，首次启动的无头运行使用种子缓存插件时，初始化消息中
  // 插件命令/代理/技能数量会显示为 0，即使种子中包含所有内容。
  const seedChanged = await registerSeedMarketplaces()
  if (seedChanged) {
    clearMarketplacesCache()
    clearPluginCache('headlessPluginInstall: seed marketplaces registered')
  }

  // 确保 zip 缓存目录结构存在
  if (zipCacheMode) {
    await getFsImplementation().mkdir(getZipCacheMarketplacesDir())
    await getFsImplementation().mkdir(getZipCachePluginsDir())
  }

  // 当任何已启用插件引用 claude-plugins-official 时，已声明市场会隐式包含它
  // （参见 getDeclaredMarketplaces）。这使官方市场通过与其他市场相同的
  // reconciler 路径处理 —— 与 CLAUDE_CODE_PLUGIN_SEED_DIR 正确组合：
  // 种子在 known_marketplaces.json 中注册它，reconciler diff 将其视为 upToDate，不克隆。
  const declaredCount = Object.keys(getDeclaredMarketplaces()).length

  const metrics = {
    marketplaces_installed: 0,
    delisted_count: 0,
  }

  // 从 seedChanged 初始化，使调用者（print.ts）在种子注册添加了市场时
  // 调用 refreshPluginState() → clearCommandsCache/clearAgentDefinitionsCache。
  // 没有此初始化，调用者只在实际发生插件安装时才刷新。
  let pluginsChanged = seedChanged

  try {
    if (declaredCount === 0) {
      logForDebugging('installPluginsForHeadless: no marketplaces declared')
    } else {
      // 将已声明市场（设置意图 + 隐式官方市场）与实体化状态进行 reconcile。
      // Zip 缓存模式：跳过不支持的源类型。
      const reconcileResult = await withDiagnosticsTiming(
        'headless_marketplace_reconcile',
        () =>
          reconcileMarketplaces({
            skip: zipCacheMode
              ? (_name, source) =>
                  !isMarketplaceSourceSupportedByZipCache(source)
              : undefined,
            onProgress: event => {
              if (event.type === 'installed') {
                logForDebugging(
                  `installPluginsForHeadless: installed marketplace ${event.name}`,
                )
              } else if (event.type === 'failed') {
                logForDebugging(
                  `installPluginsForHeadless: failed to install marketplace ${event.name}: ${event.error}`,
                )
              }
            },
          }),
        r => ({
          installed_count: r.installed.length,
          updated_count: r.updated.length,
          failed_count: r.failed.length,
          skipped_count: r.skipped.length,
        }),
      )

      if (reconcileResult.skipped.length > 0) {
        logForDebugging(
          `installPluginsForHeadless: skipped ${reconcileResult.skipped.length} marketplace(s) unsupported by zip cache: ${reconcileResult.skipped.join(', ')}`,
        )
      }

      const marketplacesChanged =
        reconcileResult.installed.length + reconcileResult.updated.length

      // 清除缓存使新安装的市场插件可被发现。
      // 插件缓存是加载器的职责 —— 缓存清除后，调用者的
      // refreshPluginState() → loadAllPlugins() 将从新实体化的市场中缓存缺失插件。
      if (marketplacesChanged > 0) {
        clearMarketplacesCache()
        clearPluginCache('headlessPluginInstall: marketplaces reconciled')
        pluginsChanged = true
      }

      metrics.marketplaces_installed = marketplacesChanged
    }

    // Zip 缓存：保存市场 JSON 以便临时容器上的离线访问。
    // 无条件运行，使稳态容器（所有插件已安装）仍能同步
    // 可能在上次运行中克隆的市场数据。
    if (zipCacheMode) {
      await syncMarketplacesToZipCache()
    }

    // 下架执行
    const newlyDelisted = await detectAndUninstallDelistedPlugins()
    metrics.delisted_count = newlyDelisted.length
    if (newlyDelisted.length > 0) {
      pluginsChanged = true
    }

    if (pluginsChanged) {
      clearPluginCache('headlessPluginInstall: plugins changed')
    }

    // Zip 缓存：注册会话清理函数，用于清理解压后的插件临时目录
    if (zipCacheMode) {
      registerCleanup(cleanupSessionPluginCache)
    }

    return pluginsChanged
  } catch (error) {
    logError(error)
    return false
  } finally {
    logEvent('tengu_headless_plugin_install', metrics)
  }
}
