import { useCallback, useEffect } from 'react'
import type { Command } from '../commands.js'
import { useNotifications } from '../context/notifications.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import { reinitializeLspServerManager } from '../services/lsp/manager.js'
import { useAppState, useSetAppState } from '../state/AppState.js'
import type { AgentDefinition } from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import { count } from '../utils/array.js'
import { logForDebugging } from '../utils/debug.js'
import { logForDiagnosticsNoPII } from '../utils/diagLogs.js'
import { toError } from '../utils/errors.js'
import { logError } from '../utils/log.js'
import { loadPluginAgents } from '../utils/plugins/loadPluginAgents.js'
import { getPluginCommands } from '../utils/plugins/loadPluginCommands.js'
import { loadPluginHooks } from '../utils/plugins/loadPluginHooks.js'
import { loadPluginLspServers } from '../utils/plugins/lspPluginIntegration.js'
import { loadPluginMcpServers } from '../utils/plugins/mcpPluginIntegration.js'
import { detectAndUninstallDelistedPlugins } from '../utils/plugins/pluginBlocklist.js'
import { getFlaggedPlugins } from '../utils/plugins/pluginFlagging.js'
import { loadAllPlugins } from '../utils/plugins/pluginLoader.js'
import type { PluginLoadResult } from '../types/plugin.js'

/**
 * 管理插件状态并与 AppState 同步的 Hook。
 *
 * 挂载时：加载所有插件，运行除名执行，弹出已标记
 * 插件通知，填充 AppState.plugins。这是初始的
 * Layer-3 加载 —— 后续刷新通过 /reload-plugins。
 *
 * needsRefresh 时：显示通知指导用户运行 /reload-plugins。
 * 不会自动刷新。所有 Layer-3 交换（命令、agent、hook、MCP）
 * 通过 refreshActivePlugins() 经 /reload-plugins 以实现一个一致的心智模型。
 * 参见 Outline: declarative-settings-hXHBMDIf4b PR 5c。
 */
export function useManagePlugins({
  enabled = true,
}: {
  enabled?: boolean
} = {}) {
  const setAppState = useSetAppState()
  const needsRefresh = useAppState(s => s.plugins.needsRefresh)
  const { addNotification } = useNotifications()

  // 初始插件加载。挂载时运行一次。不用于刷新 —— 所有
  // 挂载后刷新通过 /reload-plugins → refreshActivePlugins()。
  // 与 refreshActivePlugins 不同，这也运行除名执行和
  // 已标记插件通知（会话启动关注点），并且不会提升
  // mcp.pluginReconnectKey（MCP 效果在自己的挂载时触发）。
  const initialPluginLoad = useCallback(async () => {
    try {
      // 加载所有插件 - 捕获错误数组
      const { enabled, disabled, errors }: PluginLoadResult =
        await loadAllPlugins()

      // 检测已除名的插件，自动卸载它们，并记录为已标记。
      await detectAndUninstallDelistedPlugins()

      // 如果有待关闭的已标记插件则通知
      const flagged = getFlaggedPlugins()
      if (Object.keys(flagged).length > 0) {
        addNotification({
          key: 'plugin-delisted-flagged',
          text: 'Plugins flagged. Check /plugins',
          color: 'warning',
          priority: 'high',
        })
      }

      // 加载命令、agent 和 hook，带单独错误处理
      // 错误被添加到 errors 数组以便用户在 Doctor UI 中可见
      let commands: Command[] = []
      let agents: AgentDefinition[] = []

      try {
        commands = await getPluginCommands()
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error)
        errors.push({
          type: 'generic-error',
          source: 'plugin-commands',
          error: `Failed to load plugin commands: ${errorMessage}`,
        })
      }

      try {
        agents = await loadPluginAgents()
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error)
        errors.push({
          type: 'generic-error',
          source: 'plugin-agents',
          error: `Failed to load plugin agents: ${errorMessage}`,
        })
      }

      try {
        await loadPluginHooks()
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error)
        errors.push({
          type: 'generic-error',
          source: 'plugin-hooks',
          error: `Failed to load plugin hooks: ${errorMessage}`,
        })
      }

      // 按插件加载 MCP 服务器配置以获得准确计数。
      // LoadedPlugin.mcpServers 不由 loadAllPlugins 填充 —— 它是
      // extractMcpServersFromPlugins 稍后填充的缓存槽，与此指标竞争。
      // 直接调用 loadPluginMcpServers（如 cli/handlers/plugins.ts 所做）
      // 给出正确计数并且也为 MCP 连接管理器预热缓存。
      //
      // 在 setAppState 之前运行，以便这些加载器推送的任何错误
      // 进入 AppState.plugins.errors（Doctor UI），而不仅仅是遥测。
      const mcpServerCounts = await Promise.all(
        enabled.map(async p => {
          if (p.mcpServers) return Object.keys(p.mcpServers).length
          const servers = await loadPluginMcpServers(p, errors)
          if (servers) p.mcpServers = servers
          return servers ? Object.keys(servers).length : 0
        }),
      )
      const mcp_count = mcpServerCounts.reduce((sum, n) => sum + n, 0)

      // LSP：问题 #15521 的主要修复在 refresh.ts 中（通过
      // performBackgroundPluginInstallations → refreshActivePlugins，它
      // 首先清除缓存）。此重新初始化是防御性的 —— 它读取与原始
      // 初始化相同的记忆化 loadAllPlugins() 结果，除非在
      // main.tsx:3203 和 REPL 挂载之间发生缓存失效（例如
      // 种子 marketplace 注册或 policySettings 热重载）。
      const lspServerCounts = await Promise.all(
        enabled.map(async p => {
          if (p.lspServers) return Object.keys(p.lspServers).length
          const servers = await loadPluginLspServers(p, errors)
          if (servers) p.lspServers = servers
          return servers ? Object.keys(servers).length : 0
        }),
      )
      const lsp_count = lspServerCounts.reduce((sum, n) => sum + n, 0)
      reinitializeLspServerManager()

      // 更新 AppState - 合并错误以保留 LSP 错误
      setAppState(prevState => {
        // 保留现有 LSP/非插件加载错误（源为 'lsp-manager' 或 'plugin:*'）
        const existingLspErrors = prevState.plugins.errors.filter(
          e => e.source === 'lsp-manager' || e.source.startsWith('plugin:'),
        )
        // 去重：移除也在新错误中的现有 LSP 错误
        const newErrorKeys = new Set(
          errors.map(e =>
            e.type === 'generic-error'
              ? `generic-error:${e.source}:${e.error}`
              : `${e.type}:${e.source}`,
          ),
        )
        const filteredExisting = existingLspErrors.filter(e => {
          const key =
            e.type === 'generic-error'
              ? `generic-error:${e.source}:${e.error}`
              : `${e.type}:${e.source}`
          return !newErrorKeys.has(key)
        })
        const mergedErrors = [...filteredExisting, ...errors]

        return {
          ...prevState,
          plugins: {
            ...prevState.plugins,
            enabled,
            disabled,
            commands,
            errors: mergedErrors,
          },
        }
      })

      logForDebugging(
        `Loaded plugins - Enabled: ${enabled.length}, Disabled: ${disabled.length}, Commands: ${commands.length}, Agents: ${agents.length}, Errors: ${errors.length}`,
      )

      // 跨启用插件计数组件类型
      const hook_count = enabled.reduce((sum, p) => {
        if (!p.hooksConfig) return sum
        return (
          sum +
          (
            Object.values(p.hooksConfig) as Array<
              Array<{ hooks: unknown[] }> | undefined
            >
          ).reduce(
            (s, matchers) =>
              s +
              (matchers?.reduce(
                (h: number, m: { hooks: unknown[] }) => h + m.hooks.length,
                0,
              ) ?? 0),
            0,
          )
        )
      }, 0)

      return {
        enabled_count: enabled.length,
        disabled_count: disabled.length,
        inline_count: count(enabled, p => p.source.endsWith('@inline')),
        marketplace_count: count(enabled, p => !p.source.endsWith('@inline')),
        error_count: errors.length,
        skill_count: commands.length,
        agent_count: agents.length,
        hook_count,
        mcp_count,
        lsp_count,
        // 仅 Ant：哪些插件已启用，用于与 RSS/FPS 关联。
        // 与基础指标分开保存，这样不会流入
        // logForDiagnosticsNoPII。
        ant_enabled_names:
          process.env.USER_TYPE === 'ant' && enabled.length > 0
            ? (enabled
                .map(p => p.name)
                .sort()
                .join(
                  ',',
                ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
            : undefined,
      }
    } catch (error) {
      // 仅插件加载错误应到达这里 - 记录以监控
      const errorObj = toError(error)
      logError(errorObj)
      logForDebugging(`Error loading plugins: ${error}`)
      // 错误时设置空状态，但保留 LSP 错误并添加新错误
      setAppState(prevState => {
        // 保留现有 LSP/非插件加载错误
        const existingLspErrors = prevState.plugins.errors.filter(
          e => e.source === 'lsp-manager' || e.source.startsWith('plugin:'),
        )
        const newError = {
          type: 'generic-error' as const,
          source: 'plugin-system',
          error: errorObj.message,
        }
        return {
          ...prevState,
          plugins: {
            ...prevState.plugins,
            enabled: [],
            disabled: [],
            commands: [],
            errors: [...existingLspErrors, newError],
          },
        }
      })

      return {
        enabled_count: 0,
        disabled_count: 0,
        inline_count: 0,
        marketplace_count: 0,
        error_count: 1,
        skill_count: 0,
        agent_count: 0,
        hook_count: 0,
        mcp_count: 0,
        lsp_count: 0,
        load_failed: true,
        ant_enabled_names: undefined,
      }
    }
  }, [setAppState, addNotification])

  // 挂载时加载插件并发出遥测
  useEffect(() => {
    if (!enabled) return
    void initialPluginLoad().then(metrics => {
      const { ant_enabled_names, ...baseMetrics } = metrics
      const allMetrics = {
        ...baseMetrics,
        has_custom_plugin_cache_dir: !!process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR,
      }
      logEvent('tengu_plugins_loaded', {
        ...allMetrics,
        ...(ant_enabled_names !== undefined && {
          enabled_names: ant_enabled_names,
        }),
      })
      logForDiagnosticsNoPII('info', 'tengu_plugins_loaded', allMetrics)
    })
  }, [initialPluginLoad, enabled])

  // 插件状态在磁盘上已更改（后台协调、/plugin 菜单、
  // 外部设置编辑）。显示通知；用户运行 /reload-plugins
  // 应用。之前此处的自动刷新有一个过时缓存 bug（仅
  // 清除 loadAllPlugins，下游记忆化加载器返回旧数据）
  // 并且不完整（无 MCP，无 agentDefinitions）。/reload-plugins
  // 通过 refreshActivePlugins() 正确处理所有这些。
  useEffect(() => {
    if (!enabled || !needsRefresh) return
    addNotification({
      key: 'plugin-reload-pending',
      text: 'Plugins changed. Run /reload-plugins to activate.',
      color: 'suggestion',
      priority: 'low',
    })
    // 不要自动刷新。不要重置 needsRefresh —— /reload-plugins
    // 通过 refreshActivePlugins() 消费它。
  }, [enabled, needsRefresh, addNotification])
}
