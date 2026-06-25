/**
 * 后台 plugin 和 marketplace 安装管理器
 *
 * 本模块负责从可信来源（repository 和用户设置）自动安装 plugin 和 marketplace，
 * 且不阻塞启动流程。
 */

import type { AppState } from '../../state/AppState.js'
import { logForDebugging } from '../../utils/debug.js'
import { logForDiagnosticsNoPII } from '../../utils/diagLogs.js'
import { logError } from '../../utils/log.js'
import {
  clearMarketplacesCache,
  getDeclaredMarketplaces,
  loadKnownMarketplacesConfig,
} from '../../utils/plugins/marketplaceManager.js'
import { clearPluginCache } from '../../utils/plugins/pluginLoader.js'
import {
  diffMarketplaces,
  reconcileMarketplaces,
} from '../../utils/plugins/reconciler.js'
import { refreshActivePlugins } from '../../utils/plugins/refresh.js'
import { logEvent } from '../analytics/index.js'

type SetAppState = (f: (prevState: AppState) => AppState) => void

/**
 * 更新 app state 中的 marketplace 安装状态
 */
function updateMarketplaceStatus(
  setAppState: SetAppState,
  name: string,
  status: 'pending' | 'installing' | 'installed' | 'failed',
  error?: string,
): void {
  setAppState(prevState => ({
    ...prevState,
    plugins: {
      ...prevState.plugins,
      installationStatus: {
        ...prevState.plugins.installationStatus,
        marketplaces: prevState.plugins.installationStatus.marketplaces.map(
          m => (m.name === name ? { ...m, status, error } : m),
        ),
      },
    },
  }))
}

/**
 * 执行后台 plugin 启动检查和安装。
 *
 * 这是 reconcileMarketplaces() 的薄包装层，负责将 onProgress 事件
 * 映射为 REPL UI 的 AppState 更新。marketplace 协调完成后：
 * - 新安装 → 自动刷新 plugin（修复新 homespace / 清空缓存时初次仅从缓存加载
 *   导致的"plugin-not-found"错误）
 * - 仅更新 → 设置 needsRefresh，展示 /reload-plugins 通知
 */
export async function performBackgroundPluginInstallations(
  setAppState: SetAppState,
): Promise<void> {
  logForDebugging('performBackgroundPluginInstallations called')

  try {
    // 提前计算 diff，用于初始 UI 状态（pending 加载动画）
    const declared = getDeclaredMarketplaces()
    const materialized = await loadKnownMarketplacesConfig().catch(() => ({}))
    const diff = diffMarketplaces(declared, materialized)

    const pendingNames = [
      ...diff.missing,
      ...diff.sourceChanged.map(c => c.name),
    ]

    // 用 pending 状态初始化 AppState。无需 per-plugin 的 pending 状态——
    // plugin 加载很快（命中缓存或本地副本）；marketplace clone 才是
    // 值得展示进度的慢操作。
    setAppState(prev => ({
      ...prev,
      plugins: {
        ...prev.plugins,
        installationStatus: {
          marketplaces: pendingNames.map(name => ({
            name,
            status: 'pending' as const,
          })),
          plugins: [],
        },
      },
    }))

    if (pendingNames.length === 0) {
      return
    }

    logForDebugging(
      `Installing ${pendingNames.length} marketplace(s) in background`,
    )

    const result = await reconcileMarketplaces({
      onProgress: event => {
        switch (event.type) {
          case 'installing':
            updateMarketplaceStatus(setAppState, event.name, 'installing')
            break
          case 'installed':
            updateMarketplaceStatus(setAppState, event.name, 'installed')
            break
          case 'failed':
            updateMarketplaceStatus(
              setAppState,
              event.name,
              'failed',
              event.error,
            )
            break
        }
      },
    })

    const metrics = {
      installed_count: result.installed.length,
      updated_count: result.updated.length,
      failed_count: result.failed.length,
      up_to_date_count: result.upToDate.length,
    }
    logEvent('tengu_marketplace_background_install', metrics)
    logForDiagnosticsNoPII(
      'info',
      'tengu_marketplace_background_install',
      metrics,
    )

    if (result.installed.length > 0) {
      // 新 marketplace 已安装——自动刷新 plugin。这修复了从初次仅缓存加载
      // 时出现的"Plugin not found in marketplace"错误
      //（例如 marketplace 缓存为空的全新 homespace）。
      // refreshActivePlugins 会清除所有缓存、重新加载 plugin，
      // 并递增 pluginReconnectKey 以重建 MCP 连接。
      clearMarketplacesCache()
      logForDebugging(
        `Auto-refreshing plugins after ${result.installed.length} new marketplace(s) installed`,
      )
      try {
        await refreshActivePlugins(setAppState)
      } catch (refreshError) {
        // 若自动刷新失败，回退到 needsRefresh 通知，
        // 让用户可以手动运行 /reload-plugins 来恢复。
        logError(refreshError)
        logForDebugging(
          `Auto-refresh failed, falling back to needsRefresh: ${refreshError}`,
          { level: 'warn' },
        )
        clearPluginCache(
          'performBackgroundPluginInstallations: auto-refresh failed',
        )
        setAppState(prev => {
          if (prev.plugins.needsRefresh) return prev
          return {
            ...prev,
            plugins: { ...prev.plugins, needsRefresh: true },
          }
        })
      }
    } else if (result.updated.length > 0) {
      // 已有 marketplace 有更新——通知用户运行 /reload-plugins。
      // 更新不那么紧迫，用户可自行决定何时应用。
      clearMarketplacesCache()
      clearPluginCache(
        'performBackgroundPluginInstallations: marketplaces reconciled',
      )
      setAppState(prev => {
        if (prev.plugins.needsRefresh) return prev
        return {
          ...prev,
          plugins: { ...prev.plugins, needsRefresh: true },
        }
      })
    }
  } catch (error) {
    logError(error)
  }
}
