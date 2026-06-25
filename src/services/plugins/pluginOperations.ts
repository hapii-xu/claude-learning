/**
 * 核心 plugin 操作（install、uninstall、enable、disable、update）
 *
 * 本模块提供纯库函数，可同时被以下两处使用：
 * - CLI 命令（`claude plugin install/uninstall/enable/disable/update`）
 * - 交互式 UI（ManagePlugins.tsx）
 *
 * 本模块中的函数：
 * - 不调用 process.exit()
 * - 不向 console 写入内容
 * - 返回包含成功/失败及消息的 result 对象
 * - 可在意外失败时抛出错误
 */
import { dirname, join } from 'path'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { isBuiltinPluginId } from '../../plugins/builtinPlugins.js'
import type { LoadedPlugin, PluginManifest } from '../../types/plugin.js'
import { isENOENT, toError } from '../../utils/errors.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { logError } from '../../utils/log.js'
import {
  clearAllCaches,
  markPluginVersionOrphaned,
} from '../../utils/plugins/cacheUtils.js'
import {
  findReverseDependents,
  formatReverseDependentsSuffix,
} from '../../utils/plugins/dependencyResolver.js'
import {
  loadInstalledPluginsFromDisk,
  loadInstalledPluginsV2,
  removePluginInstallation,
  updateInstallationPathOnDisk,
} from '../../utils/plugins/installedPluginsManager.js'
import {
  getMarketplace,
  getPluginById,
  loadKnownMarketplacesConfig,
} from '../../utils/plugins/marketplaceManager.js'
import { deletePluginDataDir } from '../../utils/plugins/pluginDirectories.js'
import {
  parsePluginIdentifier,
  scopeToSettingSource,
} from '../../utils/plugins/pluginIdentifier.js'
import {
  formatResolutionError,
  installResolvedPlugin,
} from '../../utils/plugins/pluginInstallationHelpers.js'
import {
  cachePlugin,
  copyPluginToVersionedCache,
  getVersionedCachePath,
  getVersionedZipCachePath,
  loadAllPlugins,
  loadPluginManifest,
} from '../../utils/plugins/pluginLoader.js'
import { deletePluginOptions } from '../../utils/plugins/pluginOptionsStorage.js'
import { isPluginBlockedByPolicy } from '../../utils/plugins/pluginPolicy.js'
import { getPluginEditableScopes } from '../../utils/plugins/pluginStartupCheck.js'
import { calculatePluginVersion } from '../../utils/plugins/pluginVersioning.js'
import type {
  PluginMarketplaceEntry,
  PluginScope,
} from '../../utils/plugins/schemas.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'
import { plural } from '../../utils/stringUtils.js'

/** 合法的可安装 scope（不含 'managed'，'managed' 只能通过 managed-settings.json 安装） */
export const VALID_INSTALLABLE_SCOPES = ['user', 'project', 'local'] as const

/** 从 VALID_INSTALLABLE_SCOPES 派生的安装 scope 类型 */
export type InstallableScope = (typeof VALID_INSTALLABLE_SCOPES)[number]

/** 更新操作合法的 scope（含 'managed'，因为 managed plugin 可以被更新） */
export const VALID_UPDATE_SCOPES: readonly PluginScope[] = [
  'user',
  'project',
  'local',
  'managed',
] as const

/**
 * 在运行时断言 scope 是合法的可安装 scope
 * @param scope 待校验的 scope
 * @throws Error 若 scope 不是合法的可安装 scope
 */
export function assertInstallableScope(
  scope: string,
): asserts scope is InstallableScope {
  if (!VALID_INSTALLABLE_SCOPES.includes(scope as InstallableScope)) {
    throw new Error(
      `Invalid scope "${scope}". Must be one of: ${VALID_INSTALLABLE_SCOPES.join(', ')}`,
    )
  }
}

/**
 * 类型守卫：检查 scope 是否为可安装 scope（非 'managed'）。
 * 用于条件块中的类型收窄。
 */
export function isInstallableScope(
  scope: PluginScope,
): scope is InstallableScope {
  return VALID_INSTALLABLE_SCOPES.includes(scope as InstallableScope)
}

/**
 * 获取 project 特定 scope 的项目路径。
 * 'project' 和 'local' scope 返回原始 cwd，其他 scope 返回 undefined。
 */
export function getProjectPathForScope(scope: PluginScope): string | undefined {
  return scope === 'project' || scope === 'local' ? getOriginalCwd() : undefined
}

/**
 * 该 plugin 在 .hclaude/settings.json 中是否已启用（value === true）？
 *
 * 与 V2 的 installed_plugins.json scope 不同：那个文件追踪 plugin 的*安装来源*，
 * 但同一 plugin 也可以通过 settings 在 project scope 启用。
 * 卸载 UI 需要检查此项，因为在 user scope 安装而在 project scope 启用意味着
 * "uninstall"会成功移除 user 级安装，但 project 级启用仍然存在——plugin 继续运行。
 */
export function isPluginEnabledAtProjectScope(pluginId: string): boolean {
  return (
    getSettingsForSource('projectSettings')?.enabledPlugins?.[pluginId] === true
  )
}

// ============================================================================
// Result 类型
// ============================================================================

/**
 * plugin 操作的结果
 */
export type PluginOperationResult = {
  success: boolean
  message: string
  pluginId?: string
  pluginName?: string
  scope?: PluginScope
  /** 声明了对此 plugin 依赖的 plugin 列表（卸载/禁用时的警告） */
  reverseDependents?: string[]
}

/**
 * plugin 更新操作的结果
 */
export type PluginUpdateResult = {
  success: boolean
  message: string
  pluginId?: string
  newVersion?: string
  oldVersion?: string
  alreadyUpToDate?: boolean
  scope?: PluginScope
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 在所有可编辑的 settings scope 中搜索与给定输入匹配的 plugin ID。
 *
 * 若 `plugin` 包含 `@`，视为完整 pluginId，在任意 scope 找到后返回。
 * 若 `plugin` 是裸名称，则在任意 scope 中搜索以 `{plugin}@` 开头的键。
 *
 * 返回 plugin 被提及的最具体 scope（无论启用/禁用状态）及已解析的完整 pluginId。
 *
 * 优先级：local > project > user（最具体的优先）。
 */
function findPluginInSettings(plugin: string): {
  pluginId: string
  scope: InstallableScope
} | null {
  const hasMarketplace = plugin.includes('@')
  // 最具体的优先——第一个匹配胜出
  const searchOrder: InstallableScope[] = ['local', 'project', 'user']

  for (const scope of searchOrder) {
    const enabledPlugins = getSettingsForSource(
      scopeToSettingSource(scope),
    )?.enabledPlugins
    if (!enabledPlugins) continue

    for (const key of Object.keys(enabledPlugins)) {
      if (hasMarketplace ? key === plugin : key.startsWith(`${plugin}@`)) {
        return { pluginId: key, scope }
      }
    }
  }
  return null
}

/**
 * 辅助函数：从已加载的 plugin 中查找指定 plugin
 */
function findPluginByIdentifier(
  plugin: string,
  plugins: LoadedPlugin[],
): LoadedPlugin | undefined {
  const { name, marketplace } = parsePluginIdentifier(plugin)

  return plugins.find(p => {
    // 检查精确名称匹配
    if (p.name === plugin || p.name === name) return true

    // 若指定了 marketplace，检查是否与 source 匹配
    if (marketplace && p.source) {
      return p.name === name && p.source.includes(`@${marketplace}`)
    }

    return false
  })
}

/**
 * 从 V2 已安装 plugin 数据中解析可能已从 marketplace 下架的 plugin ID。
 * 若在 V2 数据中未找到该 plugin，返回 null。
 */
function resolveDelistedPluginId(
  plugin: string,
): { pluginId: string; pluginName: string } | null {
  const { name } = parsePluginIdentifier(plugin)
  const installedData = loadInstalledPluginsV2()

  // 先精确匹配，再按 name 搜索
  if (installedData.plugins[plugin]?.length) {
    return { pluginId: plugin, pluginName: name }
  }

  const matchingKey = Object.keys(installedData.plugins).find(key => {
    const { name: keyName } = parsePluginIdentifier(key)
    return keyName === name && (installedData.plugins[key]?.length ?? 0) > 0
  })

  if (matchingKey) {
    return { pluginId: matchingKey, pluginName: name }
  }

  return null
}

/**
 * 从 V2 数据中获取 plugin 最相关的安装记录。
 * 对于 project/local scope 的 plugin，优先选择与当前项目匹配的安装记录。
 * 优先级顺序：local（匹配项目）> project（匹配项目）> user > 第一条可用记录
 */
export function getPluginInstallationFromV2(pluginId: string): {
  scope: PluginScope
  projectPath?: string
} {
  const installedData = loadInstalledPluginsV2()
  const installations = installedData.plugins[pluginId]

  if (!installations || installations.length === 0) {
    return { scope: 'user' }
  }

  const currentProjectPath = getOriginalCwd()

  // 按优先级查找安装记录：local > project > user > managed
  const localInstall = installations.find(
    inst => inst.scope === 'local' && inst.projectPath === currentProjectPath,
  )
  if (localInstall) {
    return { scope: localInstall.scope, projectPath: localInstall.projectPath }
  }

  const projectInstall = installations.find(
    inst => inst.scope === 'project' && inst.projectPath === currentProjectPath,
  )
  if (projectInstall) {
    return {
      scope: projectInstall.scope,
      projectPath: projectInstall.projectPath,
    }
  }

  const userInstall = installations.find(inst => inst.scope === 'user')
  if (userInstall) {
    return { scope: userInstall.scope }
  }

  // 回退到第一条安装记录（可能是 managed）
  return {
    scope: installations[0]!.scope,
    projectPath: installations[0]!.projectPath,
  }
}

// ============================================================================
// 核心操作
// ============================================================================

/**
 * 安装 plugin（settings 优先）。
 *
 * 操作顺序：
 *   1. 在已物化的 marketplace 中搜索该 plugin
 *   2. 写入 settings（关键动作——声明意图）
 *   3. 缓存 plugin + 记录版本提示（物化）
 *
 * Marketplace 协调不是本函数的职责——启动时的协调负责处理已声明但未物化的 marketplace。
 * 若未找到 marketplace，"not found"是正确的错误。
 *
 * @param plugin plugin 标识符（name 或 plugin@marketplace）
 * @param scope 安装 scope：user、project 或 local（默认为 'user'）
 * @returns 指示成功/失败的结果
 */
export async function installPluginOp(
  plugin: string,
  scope: InstallableScope = 'user',
): Promise<PluginOperationResult> {
  assertInstallableScope(scope)

  const { name: pluginName, marketplace: marketplaceName } =
    parsePluginIdentifier(plugin)

  // ── Search materialized marketplaces for the plugin ──
  let foundPlugin: PluginMarketplaceEntry | undefined
  let foundMarketplace: string | undefined
  let marketplaceInstallLocation: string | undefined

  if (marketplaceName) {
    const pluginInfo = await getPluginById(plugin)
    if (pluginInfo) {
      foundPlugin = pluginInfo.entry
      foundMarketplace = marketplaceName
      marketplaceInstallLocation = pluginInfo.marketplaceInstallLocation
    }
  } else {
    const marketplaces = await loadKnownMarketplacesConfig()
    for (const [mktName, mktConfig] of Object.entries(marketplaces)) {
      try {
        const marketplace = await getMarketplace(mktName)
        const pluginEntry = marketplace.plugins.find(p => p.name === pluginName)
        if (pluginEntry) {
          foundPlugin = pluginEntry
          foundMarketplace = mktName
          marketplaceInstallLocation = mktConfig.installLocation
          break
        }
      } catch (error) {
        logError(toError(error))
      }
    }
  }

  if (!foundPlugin || !foundMarketplace) {
    const location = marketplaceName
      ? `marketplace "${marketplaceName}"`
      : 'any configured marketplace'
    return {
      success: false,
      message: `Plugin "${pluginName}" not found in ${location}`,
    }
  }

  const entry = foundPlugin
  const pluginId = `${entry.name}@${foundMarketplace}`

  const result = await installResolvedPlugin({
    pluginId,
    entry,
    scope,
    marketplaceInstallLocation,
  })

  if (!result.ok) {
    const failResult = result as Extract<typeof result, { ok: false }>
    switch (failResult.reason) {
      case 'local-source-no-location':
        return {
          success: false,
          message: `Cannot install local plugin "${failResult.pluginName}" without marketplace install location`,
        }
      case 'settings-write-failed':
        return {
          success: false,
          message: `Failed to update settings: ${failResult.message}`,
        }
      case 'resolution-failed':
        return {
          success: false,
          message: formatResolutionError(failResult.resolution),
        }
      case 'blocked-by-policy':
        return {
          success: false,
          message: `Plugin "${failResult.pluginName}" is blocked by your organization's policy and cannot be installed`,
        }
      case 'dependency-blocked-by-policy':
        return {
          success: false,
          message: `Plugin "${failResult.pluginName}" depends on "${failResult.blockedDependency}", which is blocked by your organization's policy`,
        }
    }
  }

  return {
    success: true,
    message: `Successfully installed plugin: ${pluginId} (scope: ${scope})${(result as Extract<typeof result, { ok: true }>).depNote}`,
    pluginId,
    pluginName: entry.name,
    scope,
  }
}

/**
 * Uninstall a plugin
 *
 * @param plugin Plugin name or plugin@marketplace identifier
 * @param scope Uninstall from scope: user, project, or local (defaults to 'user')
 * @returns Result indicating success/failure
 */
export async function uninstallPluginOp(
  plugin: string,
  scope: InstallableScope = 'user',
  deleteDataDir = true,
): Promise<PluginOperationResult> {
  // Validate scope at runtime for early error detection
  assertInstallableScope(scope)

  const { enabled, disabled } = await loadAllPlugins()
  const allPlugins = [...enabled, ...disabled]

  // Find the plugin
  const foundPlugin = findPluginByIdentifier(plugin, allPlugins)

  const settingSource = scopeToSettingSource(scope)
  const settings = getSettingsForSource(settingSource)

  let pluginId: string
  let pluginName: string

  if (foundPlugin) {
    // Find the matching settings key for this plugin (may differ from `plugin`
    // if user gave short name but settings has plugin@marketplace)
    pluginId =
      Object.keys(settings?.enabledPlugins ?? {}).find(
        k =>
          k === plugin ||
          k === foundPlugin.name ||
          k.startsWith(`${foundPlugin.name}@`),
      ) ?? (plugin.includes('@') ? plugin : foundPlugin.name)
    pluginName = foundPlugin.name
  } else {
    // Plugin not found via marketplace lookup — it may have been delisted.
    // Fall back to installed_plugins.json (V2) which tracks installations
    // independently of marketplace state.
    const resolved = resolveDelistedPluginId(plugin)
    if (!resolved) {
      return {
        success: false,
        message: `Plugin "${plugin}" not found in installed plugins`,
      }
    }
    pluginId = resolved.pluginId
    pluginName = resolved.pluginName
  }

  // Check if the plugin is installed in this scope (in V2 file)
  const projectPath = getProjectPathForScope(scope)
  const installedData = loadInstalledPluginsV2()
  const installations = installedData.plugins[pluginId]
  const scopeInstallation = installations?.find(
    i => i.scope === scope && i.projectPath === projectPath,
  )

  if (!scopeInstallation) {
    // Try to find where the plugin is actually installed to provide a helpful error
    const { scope: actualScope } = getPluginInstallationFromV2(pluginId)
    if (actualScope !== scope && installations && installations.length > 0) {
      // Project scope is special: .hclaude/settings.json is shared with the team.
      // Point users at the local-override escape hatch instead of --scope project.
      if (actualScope === 'project') {
        return {
          success: false,
          message: `Plugin "${plugin}" is enabled at project scope (.hclaude/settings.json, shared with your team). To disable just for you: claude plugin disable ${plugin} --scope local`,
        }
      }
      return {
        success: false,
        message: `Plugin "${plugin}" is installed in ${actualScope} scope, not ${scope}. Use --scope ${actualScope} to uninstall.`,
      }
    }
    return {
      success: false,
      message: `Plugin "${plugin}" is not installed in ${scope} scope. Use --scope to specify the correct scope.`,
    }
  }

  const installPath = scopeInstallation.installPath

  // Remove the plugin from the appropriate settings file (delete key entirely)
  // Use undefined to signal deletion via mergeWith in updateSettingsForSource
  const newEnabledPlugins: Record<string, boolean | string[] | undefined> = {
    ...settings?.enabledPlugins,
  }
  newEnabledPlugins[pluginId] = undefined
  updateSettingsForSource(settingSource, {
    enabledPlugins: newEnabledPlugins,
  })

  clearAllCaches()

  // Remove from installed_plugins_v2.json for this scope
  removePluginInstallation(pluginId, scope, projectPath)

  const updatedData = loadInstalledPluginsV2()
  const remainingInstallations = updatedData.plugins[pluginId]
  const isLastScope =
    !remainingInstallations || remainingInstallations.length === 0
  if (isLastScope && installPath) {
    await markPluginVersionOrphaned(installPath)
  }
  // Separate from the `&& installPath` guard above — deletePluginOptions only
  // needs pluginId, not installPath. Last scope removed → wipe stored options
  // and secrets. Before this, uninstalling left orphaned entries in
  // settings.pluginConfigs (including the legacy ungated mcpServers sub-key
  // from the MCPB Configure flow) and keychain pluginSecrets forever. No
  // feature gate: deletePluginOptions no-ops when nothing is stored, and
  // pluginConfigs.mcpServers is written ungated so its cleanup must run
  // ungated too.
  if (isLastScope) {
    deletePluginOptions(pluginId)
    if (deleteDataDir) {
      await deletePluginDataDir(pluginId)
    }
  }

  // Warn (don't block) if other enabled plugins depend on this one.
  // Blocking creates tombstones — can't tear down a graph with a delisted
  // plugin. Load-time verifyAndDemote catches the fallout.
  const reverseDependents = findReverseDependents(pluginId, allPlugins)
  const depWarn = formatReverseDependentsSuffix(reverseDependents)

  return {
    success: true,
    message: `Successfully uninstalled plugin: ${pluginName} (scope: ${scope})${depWarn}`,
    pluginId,
    pluginName,
    scope,
    reverseDependents:
      reverseDependents.length > 0 ? reverseDependents : undefined,
  }
}

/**
 * Set plugin enabled/disabled status (settings-first).
 *
 * Resolves the plugin ID and scope from settings — does NOT pre-gate on
 * installed_plugins.json. Settings declares intent; if the plugin isn't
 * cached yet, the next load will cache it.
 *
 * @param plugin Plugin name or plugin@marketplace identifier
 * @param enabled true to enable, false to disable
 * @param scope Optional scope. If not provided, auto-detects the most specific
 *   scope where the plugin is mentioned in settings.
 * @returns Result indicating success/failure
 */
export async function setPluginEnabledOp(
  plugin: string,
  enabled: boolean,
  scope?: InstallableScope,
): Promise<PluginOperationResult> {
  const operation = enabled ? 'enable' : 'disable'

  // Built-in plugins: always use user-scope settings, bypass the normal
  // scope-resolution + installed_plugins lookup (they're not installed).
  if (isBuiltinPluginId(plugin)) {
    const { error } = updateSettingsForSource('userSettings', {
      enabledPlugins: {
        ...getSettingsForSource('userSettings')?.enabledPlugins,
        [plugin]: enabled,
      },
    })
    if (error) {
      return {
        success: false,
        message: `Failed to ${operation} built-in plugin: ${error.message}`,
      }
    }
    clearAllCaches()
    const { name: pluginName } = parsePluginIdentifier(plugin)
    return {
      success: true,
      message: `Successfully ${operation}d built-in plugin: ${pluginName}`,
      pluginId: plugin,
      pluginName,
      scope: 'user',
    }
  }

  if (scope) {
    assertInstallableScope(scope)
  }

  // ── Resolve pluginId and scope from settings ──
  // Search across editable scopes for any mention (enabled or disabled) of
  // this plugin. Does NOT pre-gate on installed_plugins.json.
  let pluginId: string
  let resolvedScope: InstallableScope

  const found = findPluginInSettings(plugin)

  if (scope) {
    // Explicit scope: use it. Resolve pluginId from settings if possible,
    // otherwise require a full plugin@marketplace identifier.
    resolvedScope = scope
    if (found) {
      pluginId = found.pluginId
    } else if (plugin.includes('@')) {
      pluginId = plugin
    } else {
      return {
        success: false,
        message: `Plugin "${plugin}" not found in settings. Use plugin@marketplace format.`,
      }
    }
  } else if (found) {
    // Auto-detect scope: use the most specific scope where the plugin is
    // mentioned in settings.
    pluginId = found.pluginId
    resolvedScope = found.scope
  } else if (plugin.includes('@')) {
    // Not in any settings scope, but full pluginId given — default to user
    // scope (matches install default). This allows enabling a plugin that
    // was cached but never declared.
    pluginId = plugin
    resolvedScope = 'user'
  } else {
    return {
      success: false,
      message: `Plugin "${plugin}" not found in any editable settings scope. Use plugin@marketplace format.`,
    }
  }

  // ── Policy guard ──
  // Org-blocked plugins cannot be enabled at any scope. Check after pluginId
  // is resolved so we catch both full identifiers and bare-name lookups.
  if (enabled && isPluginBlockedByPolicy(pluginId)) {
    return {
      success: false,
      message: `Plugin "${pluginId}" is blocked by your organization's policy and cannot be enabled`,
    }
  }

  const settingSource = scopeToSettingSource(resolvedScope)
  const scopeSettingsValue =
    getSettingsForSource(settingSource)?.enabledPlugins?.[pluginId]

  // ── Cross-scope hint: explicit scope given but plugin is elsewhere ──
  // If the plugin is absent from the requested scope but present at a
  // different scope, guide the user to the right --scope — UNLESS they're
  // writing to a higher-precedence scope to override a lower one
  // (e.g. `disable --scope local` to override a project-enabled plugin
  // without touching the shared .hclaude/settings.json).
  const SCOPE_PRECEDENCE: Record<InstallableScope, number> = {
    user: 0,
    project: 1,
    local: 2,
  }
  const isOverride =
    scope && found && SCOPE_PRECEDENCE[scope] > SCOPE_PRECEDENCE[found.scope]
  if (
    scope &&
    scopeSettingsValue === undefined &&
    found &&
    found.scope !== scope &&
    !isOverride
  ) {
    return {
      success: false,
      message: `Plugin "${plugin}" is installed at ${found.scope} scope, not ${scope}. Use --scope ${found.scope} or omit --scope to auto-detect.`,
    }
  }

  // ── Check current state (for idempotency messaging) ──
  // When explicit scope given: check that scope's settings value directly
  // (merged state can be wrong if plugin is enabled elsewhere but disabled here).
  // When auto-detected: use merged effective state.
  // When overriding a lower scope: check merged state — scopeSettingsValue is
  // undefined (plugin not in this scope yet), which would read as "already
  // disabled", but the whole point of the override is to write an explicit
  // `false` that masks the lower scope's `true`.
  const isCurrentlyEnabled =
    scope && !isOverride
      ? scopeSettingsValue === true
      : getPluginEditableScopes().has(pluginId)
  if (enabled === isCurrentlyEnabled) {
    return {
      success: false,
      message: `Plugin "${plugin}" is already ${enabled ? 'enabled' : 'disabled'}${scope ? ` at ${scope} scope` : ''}`,
    }
  }

  // On disable: capture reverse dependents from the PRE-disable snapshot,
  // before we write settings and clear the memoized plugin cache.
  let reverseDependents: string[] | undefined
  if (!enabled) {
    const { enabled: loadedEnabled, disabled } = await loadAllPlugins()
    const rdeps = findReverseDependents(pluginId, [
      ...loadedEnabled,
      ...disabled,
    ])
    if (rdeps.length > 0) reverseDependents = rdeps
  }

  // ── ACTION: write settings ──
  const { error } = updateSettingsForSource(settingSource, {
    enabledPlugins: {
      ...getSettingsForSource(settingSource)?.enabledPlugins,
      [pluginId]: enabled,
    },
  })
  if (error) {
    return {
      success: false,
      message: `Failed to ${operation} plugin: ${error.message}`,
    }
  }

  clearAllCaches()

  const { name: pluginName } = parsePluginIdentifier(pluginId)
  const depWarn = formatReverseDependentsSuffix(reverseDependents)
  return {
    success: true,
    message: `Successfully ${operation}d plugin: ${pluginName} (scope: ${resolvedScope})${depWarn}`,
    pluginId,
    pluginName,
    scope: resolvedScope,
    reverseDependents,
  }
}

/**
 * Enable a plugin
 *
 * @param plugin Plugin name or plugin@marketplace identifier
 * @param scope Optional scope. If not provided, finds the most specific scope for the current project.
 * @returns Result indicating success/failure
 */
export async function enablePluginOp(
  plugin: string,
  scope?: InstallableScope,
): Promise<PluginOperationResult> {
  return setPluginEnabledOp(plugin, true, scope)
}

/**
 * Disable a plugin
 *
 * @param plugin Plugin name or plugin@marketplace identifier
 * @param scope Optional scope. If not provided, finds the most specific scope for the current project.
 * @returns Result indicating success/failure
 */
export async function disablePluginOp(
  plugin: string,
  scope?: InstallableScope,
): Promise<PluginOperationResult> {
  return setPluginEnabledOp(plugin, false, scope)
}

/**
 * Disable all enabled plugins
 *
 * @returns Result indicating success/failure with count of disabled plugins
 */
export async function disableAllPluginsOp(): Promise<PluginOperationResult> {
  const enabledPlugins = getPluginEditableScopes()

  if (enabledPlugins.size === 0) {
    return { success: true, message: 'No enabled plugins to disable' }
  }

  const disabled: string[] = []
  const errors: string[] = []

  for (const [pluginId] of enabledPlugins) {
    const result = await setPluginEnabledOp(pluginId, false)
    if (result.success) {
      disabled.push(pluginId)
    } else {
      errors.push(`${pluginId}: ${result.message}`)
    }
  }

  if (errors.length > 0) {
    return {
      success: false,
      message: `Disabled ${disabled.length} ${plural(disabled.length, 'plugin')}, ${errors.length} failed:\n${errors.join('\n')}`,
    }
  }

  return {
    success: true,
    message: `Disabled ${disabled.length} ${plural(disabled.length, 'plugin')}`,
  }
}

/**
 * Update a plugin to the latest version.
 *
 * This function performs a NON-INPLACE update:
 * 1. Gets the plugin info from the marketplace
 * 2. For remote plugins: downloads to temp dir and calculates version
 * 3. For local plugins: calculates version from marketplace source
 * 4. If version differs from currently installed, copies to new versioned cache directory
 * 5. Updates installation in V2 file (memory stays unchanged until restart)
 * 6. Cleans up old version if no longer referenced by any installation
 *
 * @param plugin Plugin name or plugin@marketplace identifier
 * @param scope Scope to update. Unlike install/uninstall/enable/disable, managed scope IS allowed.
 * @returns Result indicating success/failure with version info
 */
export async function updatePluginOp(
  plugin: string,
  scope: PluginScope,
): Promise<PluginUpdateResult> {
  // Parse the plugin identifier to get the full plugin ID
  const { name: pluginName, marketplace: marketplaceName } =
    parsePluginIdentifier(plugin)
  const pluginId = marketplaceName ? `${pluginName}@${marketplaceName}` : plugin

  // Get plugin info from marketplace
  const pluginInfo = await getPluginById(plugin)
  if (!pluginInfo) {
    return {
      success: false,
      message: `Plugin "${pluginName}" not found`,
      pluginId,
      scope,
    }
  }

  const { entry, marketplaceInstallLocation } = pluginInfo

  // Get installations from disk
  const diskData = loadInstalledPluginsFromDisk()
  const installations = diskData.plugins[pluginId]

  if (!installations || installations.length === 0) {
    return {
      success: false,
      message: `Plugin "${pluginName}" is not installed`,
      pluginId,
      scope,
    }
  }

  // Determine projectPath based on scope
  const projectPath = getProjectPathForScope(scope)

  // Find the installation for this scope
  const installation = installations.find(
    inst => inst.scope === scope && inst.projectPath === projectPath,
  )
  if (!installation) {
    const scopeDesc = projectPath ? `${scope} (${projectPath})` : scope
    return {
      success: false,
      message: `Plugin "${pluginName}" is not installed at scope ${scopeDesc}`,
      pluginId,
      scope,
    }
  }

  return performPluginUpdate({
    pluginId,
    pluginName,
    entry,
    marketplaceInstallLocation,
    installation,
    scope,
    projectPath,
  })
}

/**
 * Perform the actual plugin update: fetch source, calculate version, copy to cache, update disk.
 * This is the core update execution extracted from updatePluginOp.
 */
async function performPluginUpdate({
  pluginId,
  pluginName,
  entry,
  marketplaceInstallLocation,
  installation,
  scope,
  projectPath,
}: {
  pluginId: string
  pluginName: string
  entry: PluginMarketplaceEntry
  marketplaceInstallLocation: string
  installation: { version?: string; installPath: string }
  scope: PluginScope
  projectPath: string | undefined
}): Promise<PluginUpdateResult> {
  const fs = getFsImplementation()
  const oldVersion = installation.version

  let sourcePath: string
  let newVersion: string
  let shouldCleanupSource = false
  let gitCommitSha: string | undefined

  // Handle remote vs local plugins
  if (typeof entry.source !== 'string') {
    // Remote plugin: download to temp directory first
    const cacheResult = await cachePlugin(entry.source, {
      manifest: { name: entry.name },
    })
    sourcePath = cacheResult.path
    shouldCleanupSource = true
    gitCommitSha = cacheResult.gitCommitSha

    // Calculate version from downloaded plugin. For git-subdir sources,
    // cachePlugin captured the commit SHA before discarding the ephemeral
    // clone (the extracted subdir has no .git, so the installPath-based
    // fallback in calculatePluginVersion can't recover it).
    newVersion = await calculatePluginVersion(
      pluginId,
      entry.source,
      cacheResult.manifest,
      cacheResult.path,
      entry.version,
      cacheResult.gitCommitSha,
    )
  } else {
    // Local plugin: use path from marketplace
    // Stat directly — handle ENOENT inline rather than pre-checking existence
    let marketplaceStats
    try {
      marketplaceStats = await fs.stat(marketplaceInstallLocation)
    } catch (e: unknown) {
      if (isENOENT(e)) {
        return {
          success: false,
          message: `Marketplace directory not found at ${marketplaceInstallLocation}`,
          pluginId,
          scope,
        }
      }
      throw e
    }
    const marketplaceDir = marketplaceStats.isDirectory()
      ? marketplaceInstallLocation
      : dirname(marketplaceInstallLocation)
    sourcePath = join(marketplaceDir, entry.source)

    // Verify sourcePath exists. This stat is required — neither downstream
    // op reliably surfaces ENOENT:
    //   1. calculatePluginVersion → findGitRoot walks UP past a missing dir
    //      to the marketplace .git, returning the same SHA as install-time →
    //      silent false-positive {success: true, alreadyUpToDate: true}.
    //   2. copyPluginToVersionedCache (when versions differ) throws a raw
    //      ENOENT with no friendly message.
    // TOCTOU is negligible for a user-managed local dir.
    try {
      await fs.stat(sourcePath)
    } catch (e: unknown) {
      if (isENOENT(e)) {
        return {
          success: false,
          message: `Plugin source not found at ${sourcePath}`,
          pluginId,
          scope,
        }
      }
      throw e
    }

    // Try to load manifest from plugin directory (for version info)
    let pluginManifest: PluginManifest | undefined
    const manifestPath = join(sourcePath, '.claude-plugin', 'plugin.json')
    try {
      pluginManifest = await loadPluginManifest(
        manifestPath,
        entry.name,
        entry.source,
      )
    } catch {
      // Failed to load - will use other version sources
    }

    // Calculate version from plugin source path
    newVersion = await calculatePluginVersion(
      pluginId,
      entry.source,
      pluginManifest,
      sourcePath,
      entry.version,
    )
  }

  // Use try/finally to ensure temp directory cleanup on any error
  try {
    // Check if this version already exists in cache
    let versionedPath = getVersionedCachePath(pluginId, newVersion)

    // Check if installation is already at the new version
    const zipPath = getVersionedZipCachePath(pluginId, newVersion)
    const isUpToDate =
      installation.version === newVersion ||
      installation.installPath === versionedPath ||
      installation.installPath === zipPath
    if (isUpToDate) {
      return {
        success: true,
        message: `${pluginName} is already at the latest version (${newVersion}).`,
        pluginId,
        newVersion,
        oldVersion,
        alreadyUpToDate: true,
        scope,
      }
    }

    // Copy to versioned cache (returns actual path, which may be .zip)
    versionedPath = await copyPluginToVersionedCache(
      sourcePath,
      pluginId,
      newVersion,
      entry,
    )

    // Store old version path for potential cleanup
    const oldVersionPath = installation.installPath

    // Update disk JSON file for this installation
    // (memory stays unchanged until restart)
    updateInstallationPathOnDisk(
      pluginId,
      scope,
      projectPath,
      versionedPath,
      newVersion,
      gitCommitSha,
    )

    if (oldVersionPath && oldVersionPath !== versionedPath) {
      const updatedDiskData = loadInstalledPluginsFromDisk()
      const isOldVersionStillReferenced = Object.values(
        updatedDiskData.plugins,
      ).some(pluginInstallations =>
        pluginInstallations.some(inst => inst.installPath === oldVersionPath),
      )

      if (!isOldVersionStillReferenced) {
        await markPluginVersionOrphaned(oldVersionPath)
      }
    }

    const scopeDesc = projectPath ? `${scope} (${projectPath})` : scope
    const message = `Plugin "${pluginName}" updated from ${oldVersion || 'unknown'} to ${newVersion} for scope ${scopeDesc}. Restart to apply changes.`

    return {
      success: true,
      message,
      pluginId,
      newVersion,
      oldVersion,
      scope,
    }
  } finally {
    // Clean up temp source if it was a remote download
    if (
      shouldCleanupSource &&
      sourcePath !== getVersionedCachePath(pluginId, newVersion)
    ) {
      await fs.rm(sourcePath, { recursive: true, force: true })
    }
  }
}
