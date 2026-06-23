/**
 * 第 3 层刷新原语：在运行中的会话内交换活跃插件组件。
 *
 * 三层模型（Layer-2 见 reconciler.ts）：
 * - 第 1 层：意图（settings）
 * - 第 2 层：物化（~/.claude/plugins/）— reconcileMarketplaces()
 * - 第 3 层：活跃组件（AppState）— 本文件
 *
 * 调用来源：
 * - /reload-plugins 命令（交互式，用户发起）
 * - print.ts refreshPluginState()（无头模式，SYNC_PLUGIN_INSTALL 下首次查询前自动调用）
 * - performBackgroundPluginInstallations()（后台，新 marketplace 安装后自动调用）
 *
 * 不调用自：
 * - useManagePlugins needsRefresh effect — 交互模式显示通知；
 *   用户明确运行 /reload-plugins（PR 5c）
 * - /plugin 菜单 — 设置 needsRefresh，用户运行 /reload-plugins（PR 5b）
 */

import { getOriginalCwd } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'
import { reinitializeLspServerManager } from '../../services/lsp/manager.js'
import type { AppState } from '../../state/AppState.js'
import type { AgentDefinitionsResult } from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import { getAgentDefinitionsWithOverrides } from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import type { PluginError } from '../../types/plugin.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import { logError } from '../log.js'
import { clearAllCaches } from './cacheUtils.js'
import { getPluginCommands } from './loadPluginCommands.js'
import { loadPluginHooks } from './loadPluginHooks.js'
import { loadPluginLspServers } from './lspPluginIntegration.js'
import { loadPluginMcpServers } from './mcpPluginIntegration.js'
import { clearPluginCacheExclusions } from './orphanedPluginFilter.js'
import { loadAllPlugins } from './pluginLoader.js'

type SetAppState = (updater: (prev: AppState) => AppState) => void

export type RefreshActivePluginsResult = {
  enabled_count: number
  disabled_count: number
  command_count: number
  agent_count: number
  hook_count: number
  mcp_count: number
  /** 已启用插件提供的 LSP 服务器。reinitializeLspServerManager()
   * 无条件调用以便管理器接收这些服务器（若管理器
   * 从未初始化则为无操作）。 */
  lsp_count: number
  error_count: number
  /** 刷新后的 agent 定义，供同时在 AppState 外
   * 维护本地可变引用的调用者使用（如 print.ts）。 */
  agentDefinitions: AgentDefinitionsResult
  /** 刷新后的插件命令，理由同 agentDefinitions。 */
  pluginCommands: Command[]
}

/**
 * 刷新所有活跃插件组件：命令、agent、hook、MCP 重连
 * 触发器、AppState 插件数组。清除所有插件缓存（不同于旧的
 * needsRefresh 路径，后者只清除 loadAllPlugins 并从
 * 下游记忆化加载器返回过时数据）。
 *
 * 消费 plugins.needsRefresh（设为 false）。
 * 递增 mcp.pluginReconnectKey，使 useManageMCPConnections effects 重新运行
 * 并接收新的插件 MCP 服务器。
 *
 * LSP：如果插件现在贡献 LSP 服务器，reinitializeLspServerManager()
 * 重新读取配置。服务器是懒启动的，所以这只是配置解析。
 */
export async function refreshActivePlugins(
  setAppState: SetAppState,
): Promise<RefreshActivePluginsResult> {
  logForDebugging('refreshActivePlugins: clearing all plugin caches')
  clearAllCaches()
  // 孤儿排除默认在会话中冻结，但 /reload-plugins 是
  // 明确的"磁盘已变更，重新读取"信号 — 也重新计算它们。
  clearPluginCacheExclusions()

  // 在仅缓存消费者之前排序完整加载。在 #23693 之前，所有
  // 三个共享 loadAllPlugins() 的记忆化 promise，所以 Promise.all 是
  // 无操作竞争。在 #23693 之后，getPluginCommands/getAgentDefinitions 调用
  // loadAllPluginsCacheOnly（单独记忆化）— 竞争它们意味着它们
  // 在 loadAllPlugins() 克隆并缓存插件之前读取 installed_plugins.json，
  // 返回 plugin-cache-miss。loadAllPlugins 在完成时预热
  // 仅缓存记忆化，所以下面的 await 基本上是免费的。
  const pluginResult = await loadAllPlugins()
  const [pluginCommands, agentDefinitions] = await Promise.all([
    getPluginCommands(),
    getAgentDefinitionsWithOverrides(getOriginalCwd()),
  ])

  const { enabled, disabled, errors } = pluginResult

  // 在每个已启用插件上填充 mcpServers/lspServers。这些是懒
  // 缓存槽，loadAllPlugins() 不会填充 — 它们后来由
  // extractMcpServersFromPlugins/getPluginLspServers 写入，与此竞争。
  // 在此处加载提供准确指标，并预热缓存槽，使 MCP
  // 连接管理器（由 pluginReconnectKey 递增触发）无需
  // 重新解析清单即可看到服务器。错误推入共享错误数组。
  const [mcpCounts, lspCounts] = await Promise.all([
    Promise.all(
      enabled.map(async p => {
        if (p.mcpServers) return Object.keys(p.mcpServers).length
        const servers = await loadPluginMcpServers(p, errors)
        if (servers) p.mcpServers = servers
        return servers ? Object.keys(servers).length : 0
      }),
    ),
    Promise.all(
      enabled.map(async p => {
        if (p.lspServers) return Object.keys(p.lspServers).length
        const servers = await loadPluginLspServers(p, errors)
        if (servers) p.lspServers = servers
        return servers ? Object.keys(servers).length : 0
      }),
    ),
  ])
  const mcp_count = mcpCounts.reduce((sum, n) => sum + n, 0)
  const lsp_count = lspCounts.reduce((sum, n) => sum + n, 0)

  setAppState(prev => ({
    ...prev,
    plugins: {
      ...prev.plugins,
      enabled,
      disabled,
      commands: pluginCommands,
      errors: mergePluginErrors(prev.plugins.errors, errors),
      needsRefresh: false,
    },
    agentDefinitions,
    mcp: {
      ...prev.mcp,
      pluginReconnectKey: prev.mcp.pluginReconnectKey + 1,
    },
  }))

  // 重新初始化 LSP 管理器，以便新加载的插件 LSP 服务器被接收。
  // 若 LSP 从未初始化（无头子命令路径）则为无操作。
  // 无条件调用，以便移除最后一个 LSP 插件时也能清除过时配置。
  // 修复问题 #15521：LSP 管理器之前读取了来自 marketplace 对账之前的
  // 过时记忆化 loadAllPlugins() 结果。
  reinitializeLspServerManager()

  // clearAllCaches() 修剪已移除插件的 hook；此处执行完整交换
  // （也添加新启用插件的 hook）。在此捕获以便
  // hook_load_failed 可以计入 error_count；失败不会丢失
  // 上面的 plugin/command/agent 数据（hook 进入 STATE.registeredHooks，
  // 不是 AppState）。
  let hook_load_failed = false
  try {
    await loadPluginHooks()
  } catch (e) {
    hook_load_failed = true
    logError(e)
    logForDebugging(
      `refreshActivePlugins: loadPluginHooks failed: ${errorMessage(e)}`,
    )
  }

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
            (h: number, m: { hooks: { length: number } }) => h + m.hooks.length,
            0,
          ) ?? 0),
        0,
      )
    )
  }, 0)

  logForDebugging(
    `refreshActivePlugins: ${enabled.length} enabled, ${pluginCommands.length} commands, ${agentDefinitions.allAgents.length} agents, ${hook_count} hooks, ${mcp_count} MCP, ${lsp_count} LSP`,
  )

  return {
    enabled_count: enabled.length,
    disabled_count: disabled.length,
    command_count: pluginCommands.length,
    agent_count: agentDefinitions.allAgents.length,
    hook_count,
    mcp_count,
    lsp_count,
    error_count: errors.length + (hook_load_failed ? 1 : 0),
    agentDefinitions,
    pluginCommands,
  }
}

/**
 * 将新的插件加载错误与现有错误合并，保留由其他系统
 * 记录的 LSP 和插件组件错误并去重。与 refreshPlugins()/updatePluginState()
 * 相同的逻辑，提取出来以避免 refresh.ts 遗漏这些错误。
 */
function mergePluginErrors(
  existing: PluginError[],
  fresh: PluginError[],
): PluginError[] {
  const preserved = existing.filter(
    e => e.source === 'lsp-manager' || e.source.startsWith('plugin:'),
  )
  const freshKeys = new Set(fresh.map(errorKey))
  const deduped = preserved.filter(e => !freshKeys.has(errorKey(e)))
  return [...deduped, ...fresh]
}

function errorKey(e: PluginError): string {
  return e.type === 'generic-error'
    ? `generic-error:${e.source}:${e.error}`
    : `${e.type}:${e.source}`
}
