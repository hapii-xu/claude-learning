/**
 * Plugin 和 marketplace 子命令处理器 — 从 main.tsx 抽出以便懒加载。
 * 仅在执行 `claude plugin *` 或 `claude plugin marketplace *` 时动态加载。
 */
/* eslint-disable custom-rules/no-process-exit -- CLI 子命令处理器需要主动退出 */
import figures from 'figures'
import { basename, dirname } from 'path'
import { setUseCoworkPlugins } from '../../bootstrap/state.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
  logEvent,
} from '../../services/analytics/index.js'
import {
  disableAllPlugins,
  disablePlugin,
  enablePlugin,
  installPlugin,
  uninstallPlugin,
  updatePluginCli,
  VALID_INSTALLABLE_SCOPES,
  VALID_UPDATE_SCOPES,
} from '../../services/plugins/pluginCliCommands.js'
import { getPluginErrorMessage } from '../../types/plugin.js'
import { errorMessage } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { clearAllCaches } from '../../utils/plugins/cacheUtils.js'
import { getInstallCounts } from '../../utils/plugins/installCounts.js'
import {
  isPluginInstalled,
  loadInstalledPluginsV2,
} from '../../utils/plugins/installedPluginsManager.js'
import {
  createPluginId,
  loadMarketplacesWithGracefulDegradation,
} from '../../utils/plugins/marketplaceHelpers.js'
import {
  addMarketplaceSource,
  loadKnownMarketplacesConfig,
  refreshAllMarketplaces,
  refreshMarketplace,
  removeMarketplaceSource,
  saveMarketplaceToSettings,
} from '../../utils/plugins/marketplaceManager.js'
import { loadPluginMcpServers } from '../../utils/plugins/mcpPluginIntegration.js'
import { parseMarketplaceInput } from '../../utils/plugins/parseMarketplaceInput.js'
import {
  parsePluginIdentifier,
  scopeToSettingSource,
} from '../../utils/plugins/pluginIdentifier.js'
import { loadAllPlugins } from '../../utils/plugins/pluginLoader.js'
import type { PluginSource } from '../../utils/plugins/schemas.js'
import {
  type ValidationResult,
  validateManifest,
  validatePluginContents,
} from '../../utils/plugins/validatePlugin.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { plural } from '../../utils/stringUtils.js'
import { cliError, cliOk } from '../exit.js'

// 重新导出，供 main.tsx 在选项定义中引用
export { VALID_INSTALLABLE_SCOPES, VALID_UPDATE_SCOPES }

/**
 * 统一处理 marketplace 命令错误的辅助函数。
 */
export function handleMarketplaceError(error: unknown, action: string): never {
  logError(error)
  cliError(`${figures.cross} Failed to ${action}: ${errorMessage(error)}`)
}

function printValidationResult(result: ValidationResult): void {
  if (result.errors.length > 0) {
    console.log(
      `${figures.cross} Found ${result.errors.length} ${plural(result.errors.length, 'error')}:\n`,
    )
    result.errors.forEach(error => {
      console.log(`  ${figures.pointer} ${error.path}: ${error.message}`)
    })
    console.log('')
  }
  if (result.warnings.length > 0) {
    console.log(
      `${figures.warning} Found ${result.warnings.length} ${plural(result.warnings.length, 'warning')}:\n`,
    )
    result.warnings.forEach(warning => {
      console.log(`  ${figures.pointer} ${warning.path}: ${warning.message}`)
    })
    console.log('')
  }
}

// plugin validate（插件校验）
export async function pluginValidateHandler(
  manifestPath: string,
  options: { cowork?: boolean },
): Promise<void> {
  if (options.cowork) setUseCoworkPlugins(true)
  try {
    const result = await validateManifest(manifestPath)

    console.log(`Validating ${result.fileType} manifest: ${result.filePath}\n`)
    printValidationResult(result)

    // 如果这是一个位于 .claude-plugin 目录中的 plugin manifest，
    // 同时校验该插件的内容文件（skills、agents、commands、hooks）。
    // 无论用户传入的是目录还是 plugin.json 的路径，都能正常工作。
    let contentResults: ValidationResult[] = []
    if (result.fileType === 'plugin') {
      const manifestDir = dirname(result.filePath)
      if (basename(manifestDir) === '.claude-plugin') {
        contentResults = await validatePluginContents(dirname(manifestDir))
        for (const r of contentResults) {
          console.log(`Validating ${r.fileType}: ${r.filePath}\n`)
          printValidationResult(r)
        }
      }
    }

    const allSuccess = result.success && contentResults.every(r => r.success)
    const hasWarnings =
      result.warnings.length > 0 ||
      contentResults.some(r => r.warnings.length > 0)

    if (allSuccess) {
      cliOk(
        hasWarnings
          ? `${figures.tick} Validation passed with warnings`
          : `${figures.tick} Validation passed`,
      )
    } else {
      console.log(`${figures.cross} Validation failed`)
      process.exit(1)
    }
  } catch (error) {
    logError(error)
    console.error(
      `${figures.cross} Unexpected error during validation: ${errorMessage(error)}`,
    )
    process.exit(2)
  }
}

// plugin list（插件列表，对应原 main.tsx 5217–5416 行）
export async function pluginListHandler(options: {
  json?: boolean
  available?: boolean
  cowork?: boolean
}): Promise<void> {
  if (options.cowork) setUseCoworkPlugins(true)
  logEvent('tengu_plugin_list_command', {})

  const installedData = loadInstalledPluginsV2()
  const { getPluginEditableScopes } = await import(
    '../../utils/plugins/pluginStartupCheck.js'
  )
  const enabledPlugins = getPluginEditableScopes()

  const pluginIds = Object.keys(installedData.plugins)

  // 一次性加载全部插件。JSON 和人工可读两条路径都需要：
  //  - loadErrors（用于展示每个插件的加载失败）
  //  - inline 插件（通过 --plugin-dir 引入的仅当前会话生效、source='name@inline'），
  //    它们并不在 installedData.plugins（V2 账目）中 — 必须单独展示，
  //    否则 `plugin list` 会静默忽略 --plugin-dir。
  const {
    enabled: loadedEnabled,
    disabled: loadedDisabled,
    errors: loadErrors,
  } = await loadAllPlugins()
  const allLoadedPlugins = [...loadedEnabled, ...loadedDisabled]
  const inlinePlugins = allLoadedPlugins.filter(p =>
    p.source.endsWith('@inline'),
  )
  // 路径级别的 inline 失败（目录不存在、读取 manifest 前的解析错误）使用
  // source='inline[N]'。读取 manifest 之后的插件级错误使用 source='name@inline'。
  // 两者都要收集到 session 段中 — 否则它们会因为没有 pluginId 而完全不可见。
  const inlineLoadErrors = loadErrors.filter(
    e => e.source.endsWith('@inline') || e.source.startsWith('inline['),
  )

  if (options.json) {
    // 构建 source 到已加载插件的映射，便于快速查找
    const loadedPluginMap = new Map(allLoadedPlugins.map(p => [p.source, p]))

    const plugins: Array<{
      id: string
      version: string
      scope: string
      enabled: boolean
      installPath: string
      installedAt?: string
      lastUpdated?: string
      projectPath?: string
      mcpServers?: Record<string, unknown>
      errors?: string[]
    }> = []

    for (const pluginId of pluginIds.sort()) {
      const installations = installedData.plugins[pluginId]
      if (!installations || installations.length === 0) continue

      // 查找该插件的加载错误
      const pluginName = parsePluginIdentifier(pluginId).name
      const pluginErrors = loadErrors
        .filter(
          e =>
            e.source === pluginId || ('plugin' in e && e.plugin === pluginName),
        )
        .map(getPluginErrorMessage)

      for (const installation of installations) {
        // 尝试找到已加载的插件以获取 MCP servers
        const loadedPlugin = loadedPluginMap.get(pluginId)
        let mcpServers: Record<string, unknown> | undefined

        if (loadedPlugin) {
          // 如果尚未缓存，则加载 MCP servers
          const servers =
            loadedPlugin.mcpServers ||
            (await loadPluginMcpServers(loadedPlugin))
          if (servers && Object.keys(servers).length > 0) {
            mcpServers = servers
          }
        }

        plugins.push({
          id: pluginId,
          version: installation.version || 'unknown',
          scope: installation.scope,
          enabled: enabledPlugins.has(pluginId),
          installPath: installation.installPath,
          installedAt: installation.installedAt,
          lastUpdated: installation.lastUpdated,
          projectPath: installation.projectPath,
          mcpServers,
          errors: pluginErrors.length > 0 ? pluginErrors : undefined,
        })
      }
    }

    // 仅当前会话的插件：scope='session'，没有安装元数据。
    // 从 inlineLoadErrors（而不是 loadErrors）中过滤，避免同名 manifest 的已安装插件
    // 通过 e.plugin 造成交叉污染。
    // e.plugin 的兜底分支用于处理 dirName≠manifestName 的情况：
    // createPluginFromPath 使用 `${dirName}@inline` 标记错误，但随后
    // plugin.source 被重新赋值为 `${manifest.name}@inline`
    // （见 pluginLoader.ts 的 loadInlinePlugins），因此当 dev checkout 目录
    // （例如 ~/code/my-fork/）的 manifest 名为 'cool-plugin' 时，e.source !== p.source。
    for (const p of inlinePlugins) {
      const servers = p.mcpServers || (await loadPluginMcpServers(p))
      const pErrors = inlineLoadErrors
        .filter(
          e => e.source === p.source || ('plugin' in e && e.plugin === p.name),
        )
        .map(getPluginErrorMessage)
      plugins.push({
        id: p.source,
        version: p.manifest.version ?? 'unknown',
        scope: 'session',
        enabled: p.enabled !== false,
        installPath: p.path,
        mcpServers:
          servers && Object.keys(servers).length > 0 ? servers : undefined,
        errors: pErrors.length > 0 ? pErrors : undefined,
      })
    }
    // 路径级别的 inline 失败（--plugin-dir /nonexistent）：不存在 LoadedPlugin 对象，
    // 因此上面的循环无法暴露这类失败。此处与人工可读路径保持一致，
    // 让 JSON 消费者也能看到失败信息，而不是被静默忽略。
    for (const e of inlineLoadErrors.filter(e =>
      e.source.startsWith('inline['),
    )) {
      plugins.push({
        id: e.source,
        version: 'unknown',
        scope: 'session',
        enabled: false,
        installPath: 'path' in e ? e.path : '',
        errors: [getPluginErrorMessage(e)],
      })
    }

    // 如果设置了 --available，则同时从 marketplaces 加载可用插件
    if (options.available) {
      const available: Array<{
        pluginId: string
        name: string
        description?: string
        marketplaceName: string
        version?: string
        source: PluginSource
        installCount?: number
      }> = []

      try {
        const [config, installCounts] = await Promise.all([
          loadKnownMarketplacesConfig(),
          getInstallCounts(),
        ])
        const { marketplaces } =
          await loadMarketplacesWithGracefulDegradation(config)

        for (const {
          name: marketplaceName,
          data: marketplace,
        } of marketplaces) {
          if (marketplace) {
            for (const entry of marketplace.plugins) {
              const pluginId = createPluginId(entry.name, marketplaceName)
              // 仅包含尚未安装的插件
              if (!isPluginInstalled(pluginId)) {
                available.push({
                  pluginId,
                  name: entry.name,
                  description: entry.description,
                  marketplaceName,
                  version: entry.version,
                  source: entry.source,
                  installCount: installCounts?.get(pluginId),
                })
              }
            }
          }
        }
      } catch {
        // 静默忽略 marketplace 加载错误
      }

      cliOk(jsonStringify({ installed: plugins, available }, null, 2))
    } else {
      cliOk(jsonStringify(plugins, null, 2))
    }
  }

  if (pluginIds.length === 0 && inlinePlugins.length === 0) {
    // inlineLoadErrors 可能在 inline 插件数为 0 时仍然存在（例如 --plugin-dir
    // 指向了一个不存在的路径）。不要因此提前退出 — 继续落到 session 段，
    // 以便失败信息能够展示出来。
    if (inlineLoadErrors.length === 0) {
      cliOk(
        'No plugins installed. Use `claude plugin install` to install a plugin.',
      )
    }
  }

  if (pluginIds.length > 0) {
    console.log('Installed plugins:\n')
  }

  for (const pluginId of pluginIds.sort()) {
    const installations = installedData.plugins[pluginId]
    if (!installations || installations.length === 0) continue

    // 查找该插件的加载错误
    const pluginName = parsePluginIdentifier(pluginId).name
    const pluginErrors = loadErrors.filter(
      e => e.source === pluginId || ('plugin' in e && e.plugin === pluginName),
    )

    for (const installation of installations) {
      const isEnabled = enabledPlugins.has(pluginId)
      const status =
        pluginErrors.length > 0
          ? `${figures.cross} failed to load`
          : isEnabled
            ? `${figures.tick} enabled`
            : `${figures.cross} disabled`
      const version = installation.version || 'unknown'
      const scope = installation.scope

      console.log(`  ${figures.pointer} ${pluginId}`)
      console.log(`    Version: ${version}`)
      console.log(`    Scope: ${scope}`)
      console.log(`    Status: ${status}`)
      for (const error of pluginErrors) {
        console.log(`    Error: ${getPluginErrorMessage(error)}`)
      }
      console.log('')
    }
  }

  if (inlinePlugins.length > 0 || inlineLoadErrors.length > 0) {
    console.log('Session-only plugins (--plugin-dir):\n')
    for (const p of inlinePlugins) {
      // 与上方 JSON 路径相同的 dirName≠manifestName 兜底逻辑 — 错误来源
      // 使用目录名，而 p.source 使用 manifest 名。
      const pErrors = inlineLoadErrors.filter(
        e => e.source === p.source || ('plugin' in e && e.plugin === p.name),
      )
      const status =
        pErrors.length > 0
          ? `${figures.cross} loaded with errors`
          : `${figures.tick} loaded`
      console.log(`  ${figures.pointer} ${p.source}`)
      console.log(`    Version: ${p.manifest.version ?? 'unknown'}`)
      console.log(`    Path: ${p.path}`)
      console.log(`    Status: ${status}`)
      for (const e of pErrors) {
        console.log(`    Error: ${getPluginErrorMessage(e)}`)
      }
      console.log('')
    }
    // 路径级别的失败：不存在 LoadedPlugin 对象。在此展示，
    // 以免 `--plugin-dir /typo` 静默地没有任何输出。
    for (const e of inlineLoadErrors.filter(e =>
      e.source.startsWith('inline['),
    )) {
      console.log(
        `  ${figures.pointer} ${e.source}: ${figures.cross} ${getPluginErrorMessage(e)}\n`,
      )
    }
  }

  cliOk()
}

// marketplace add（添加 marketplace，对应原 5433–5487 行）
export async function marketplaceAddHandler(
  source: string,
  options: { cowork?: boolean; sparse?: string[]; scope?: string },
): Promise<void> {
  if (options.cowork) setUseCoworkPlugins(true)
  try {
    const parsed = await parseMarketplaceInput(source)

    if (!parsed) {
      cliError(
        `${figures.cross} Invalid marketplace source format. Try: owner/repo, https://..., or ./path`,
      )
    }

    if ('error' in parsed) {
      cliError(`${figures.cross} ${parsed.error}`)
    }

    // 校验 scope
    const scope = options.scope ?? 'user'
    if (scope !== 'user' && scope !== 'project' && scope !== 'local') {
      cliError(
        `${figures.cross} Invalid scope '${scope}'. Use: user, project, or local`,
      )
    }
    const settingSource = scopeToSettingSource(scope)

    let marketplaceSource = parsed

    if (options.sparse && options.sparse.length > 0) {
      if (
        marketplaceSource.source === 'github' ||
        marketplaceSource.source === 'git'
      ) {
        marketplaceSource = {
          ...marketplaceSource,
          sparsePaths: options.sparse,
        }
      } else {
        cliError(
          `${figures.cross} --sparse is only supported for github and git marketplace sources (got: ${marketplaceSource.source})`,
        )
      }
    }

    console.log('Adding marketplace...')

    const { name, alreadyMaterialized, resolvedSource } =
      await addMarketplaceSource(marketplaceSource, message => {
        console.log(message)
      })

    // 将意图写入指定 scope 的 settings 中
    saveMarketplaceToSettings(name, { source: resolvedSource }, settingSource)

    clearAllCaches()

    let sourceType = marketplaceSource.source
    if (marketplaceSource.source === 'github') {
      sourceType =
        marketplaceSource.repo as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    }
    logEvent('tengu_marketplace_added', {
      source_type:
        sourceType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })

    cliOk(
      alreadyMaterialized
        ? `${figures.tick} Marketplace '${name}' already on disk — declared in ${scope} settings`
        : `${figures.tick} Successfully added marketplace: ${name} (declared in ${scope} settings)`,
    )
  } catch (error) {
    handleMarketplaceError(error, 'add marketplace')
  }
}

// marketplace list（列出 marketplaces，对应原 5497–5565 行）
export async function marketplaceListHandler(options: {
  json?: boolean
  cowork?: boolean
}): Promise<void> {
  if (options.cowork) setUseCoworkPlugins(true)
  try {
    const config = await loadKnownMarketplacesConfig()
    const names = Object.keys(config)

    if (options.json) {
      const marketplaces = names.sort().map(name => {
        const marketplace = config[name]
        const source = marketplace?.source
        return {
          name,
          source: source?.source,
          ...(source?.source === 'github' && { repo: source.repo }),
          ...(source?.source === 'git' && { url: source.url }),
          ...(source?.source === 'url' && { url: source.url }),
          ...(source?.source === 'directory' && { path: source.path }),
          ...(source?.source === 'file' && { path: source.path }),
          installLocation: marketplace?.installLocation,
        }
      })
      cliOk(jsonStringify(marketplaces, null, 2))
    }

    if (names.length === 0) {
      cliOk('No marketplaces configured')
    }

    console.log('Configured marketplaces:\n')
    names.forEach(name => {
      const marketplace = config[name]
      console.log(`  ${figures.pointer} ${name}`)

      if (marketplace?.source) {
        const src = marketplace.source
        if (src.source === 'github') {
          console.log(`    Source: GitHub (${src.repo})`)
        } else if (src.source === 'git') {
          console.log(`    Source: Git (${src.url})`)
        } else if (src.source === 'url') {
          console.log(`    Source: URL (${src.url})`)
        } else if (src.source === 'directory') {
          console.log(`    Source: Directory (${src.path})`)
        } else if (src.source === 'file') {
          console.log(`    Source: File (${src.path})`)
        }
      }
      console.log('')
    })

    cliOk()
  } catch (error) {
    handleMarketplaceError(error, 'list marketplaces')
  }
}

// marketplace remove（移除 marketplace，对应原 5576–5598 行）
export async function marketplaceRemoveHandler(
  name: string,
  options: { cowork?: boolean },
): Promise<void> {
  if (options.cowork) setUseCoworkPlugins(true)
  try {
    await removeMarketplaceSource(name)
    clearAllCaches()

    logEvent('tengu_marketplace_removed', {
      marketplace_name:
        name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })

    cliOk(`${figures.tick} Successfully removed marketplace: ${name}`)
  } catch (error) {
    handleMarketplaceError(error, 'remove marketplace')
  }
}

// marketplace update（更新 marketplace，对应原 5609–5672 行）
export async function marketplaceUpdateHandler(
  name: string | undefined,
  options: { cowork?: boolean },
): Promise<void> {
  if (options.cowork) setUseCoworkPlugins(true)
  try {
    if (name) {
      console.log(`Updating marketplace: ${name}...`)

      await refreshMarketplace(name, message => {
        console.log(message)
      })

      clearAllCaches()

      logEvent('tengu_marketplace_updated', {
        marketplace_name:
          name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })

      cliOk(`${figures.tick} Successfully updated marketplace: ${name}`)
    } else {
      const config = await loadKnownMarketplacesConfig()
      const marketplaceNames = Object.keys(config)

      if (marketplaceNames.length === 0) {
        cliOk('No marketplaces configured')
      }

      console.log(`Updating ${marketplaceNames.length} marketplace(s)...`)

      await refreshAllMarketplaces()
      clearAllCaches()

      logEvent('tengu_marketplace_updated_all', {
        count:
          marketplaceNames.length as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })

      cliOk(
        `${figures.tick} Successfully updated ${marketplaceNames.length} marketplace(s)`,
      )
    }
  } catch (error) {
    handleMarketplaceError(error, 'update marketplace(s)')
  }
}

// plugin install（安装插件，对应原 5690–5721 行）
export async function pluginInstallHandler(
  plugin: string,
  options: { scope?: string; cowork?: boolean },
): Promise<void> {
  if (options.cowork) setUseCoworkPlugins(true)
  const scope = options.scope || 'user'
  if (options.cowork && scope !== 'user') {
    cliError('--cowork can only be used with user scope')
  }
  if (
    !VALID_INSTALLABLE_SCOPES.includes(
      scope as (typeof VALID_INSTALLABLE_SCOPES)[number],
    )
  ) {
    cliError(
      `Invalid scope: ${scope}. Must be one of: ${VALID_INSTALLABLE_SCOPES.join(', ')}.`,
    )
  }
  // _PROTO_* 路由到带 PII 标签的 plugin_name/marketplace_name BQ 列。
  // 此前未脱敏的插件参数会被写入所有用户可访问的 additional_metadata —
  // 已弃用，改为走专门的特权列。marketplace 可能为 undefined（在解析前就触发）。
  const { name, marketplace } = parsePluginIdentifier(plugin)
  logEvent('tengu_plugin_install_command', {
    _PROTO_plugin_name: name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
    ...(marketplace && {
      _PROTO_marketplace_name:
        marketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
    }),
    scope: scope as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })

  await installPlugin(plugin, scope as 'user' | 'project' | 'local')
}

// plugin uninstall（卸载插件，对应原 5738–5769 行）
export async function pluginUninstallHandler(
  plugin: string,
  options: { scope?: string; cowork?: boolean; keepData?: boolean },
): Promise<void> {
  if (options.cowork) setUseCoworkPlugins(true)
  const scope = options.scope || 'user'
  if (options.cowork && scope !== 'user') {
    cliError('--cowork can only be used with user scope')
  }
  if (
    !VALID_INSTALLABLE_SCOPES.includes(
      scope as (typeof VALID_INSTALLABLE_SCOPES)[number],
    )
  ) {
    cliError(
      `Invalid scope: ${scope}. Must be one of: ${VALID_INSTALLABLE_SCOPES.join(', ')}.`,
    )
  }
  const { name, marketplace } = parsePluginIdentifier(plugin)
  logEvent('tengu_plugin_uninstall_command', {
    _PROTO_plugin_name: name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
    ...(marketplace && {
      _PROTO_marketplace_name:
        marketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
    }),
    scope: scope as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })

  await uninstallPlugin(
    plugin,
    scope as 'user' | 'project' | 'local',
    options.keepData,
  )
}

// plugin enable（启用插件，对应原 5783–5818 行）
export async function pluginEnableHandler(
  plugin: string,
  options: { scope?: string; cowork?: boolean },
): Promise<void> {
  if (options.cowork) setUseCoworkPlugins(true)
  let scope: (typeof VALID_INSTALLABLE_SCOPES)[number] | undefined
  if (options.scope) {
    if (
      !VALID_INSTALLABLE_SCOPES.includes(
        options.scope as (typeof VALID_INSTALLABLE_SCOPES)[number],
      )
    ) {
      cliError(
        `Invalid scope "${options.scope}". Valid scopes: ${VALID_INSTALLABLE_SCOPES.join(', ')}`,
      )
    }
    scope = options.scope as (typeof VALID_INSTALLABLE_SCOPES)[number]
  }
  if (options.cowork && scope !== undefined && scope !== 'user') {
    cliError('--cowork can only be used with user scope')
  }

  // --cowork 始终在 user scope 下操作
  if (options.cowork && scope === undefined) {
    scope = 'user'
  }

  const { name, marketplace } = parsePluginIdentifier(plugin)
  logEvent('tengu_plugin_enable_command', {
    _PROTO_plugin_name: name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
    ...(marketplace && {
      _PROTO_marketplace_name:
        marketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
    }),
    scope: (scope ??
      'auto') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })

  await enablePlugin(plugin, scope)
}

// plugin disable（禁用插件，对应原 5833–5902 行）
export async function pluginDisableHandler(
  plugin: string | undefined,
  options: { scope?: string; cowork?: boolean; all?: boolean },
): Promise<void> {
  if (options.all && plugin) {
    cliError('Cannot use --all with a specific plugin')
  }

  if (!options.all && !plugin) {
    cliError('Please specify a plugin name or use --all to disable all plugins')
  }

  if (options.cowork) setUseCoworkPlugins(true)

  if (options.all) {
    if (options.scope) {
      cliError('Cannot use --scope with --all')
    }

    // 此处不带 _PROTO_plugin_name — --all 会禁用所有插件。
    // 通过 plugin_name IS NULL 与指定插件的分支区分。
    logEvent('tengu_plugin_disable_command', {})

    await disableAllPlugins()
    return
  }

  let scope: (typeof VALID_INSTALLABLE_SCOPES)[number] | undefined
  if (options.scope) {
    if (
      !VALID_INSTALLABLE_SCOPES.includes(
        options.scope as (typeof VALID_INSTALLABLE_SCOPES)[number],
      )
    ) {
      cliError(
        `Invalid scope "${options.scope}". Valid scopes: ${VALID_INSTALLABLE_SCOPES.join(', ')}`,
      )
    }
    scope = options.scope as (typeof VALID_INSTALLABLE_SCOPES)[number]
  }
  if (options.cowork && scope !== undefined && scope !== 'user') {
    cliError('--cowork can only be used with user scope')
  }

  // --cowork 始终在 user scope 下操作
  if (options.cowork && scope === undefined) {
    scope = 'user'
  }

  const { name, marketplace } = parsePluginIdentifier(plugin!)
  logEvent('tengu_plugin_disable_command', {
    _PROTO_plugin_name: name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
    ...(marketplace && {
      _PROTO_marketplace_name:
        marketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
    }),
    scope: (scope ??
      'auto') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })

  await disablePlugin(plugin!, scope)
}

// plugin update（更新插件，对应原 5918–5948 行）
export async function pluginUpdateHandler(
  plugin: string,
  options: { scope?: string; cowork?: boolean },
): Promise<void> {
  if (options.cowork) setUseCoworkPlugins(true)
  const { name, marketplace } = parsePluginIdentifier(plugin)
  logEvent('tengu_plugin_update_command', {
    _PROTO_plugin_name: name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
    ...(marketplace && {
      _PROTO_marketplace_name:
        marketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
    }),
  })

  let scope: (typeof VALID_UPDATE_SCOPES)[number] = 'user'
  if (options.scope) {
    if (
      !VALID_UPDATE_SCOPES.includes(
        options.scope as (typeof VALID_UPDATE_SCOPES)[number],
      )
    ) {
      cliError(
        `Invalid scope "${options.scope}". Valid scopes: ${VALID_UPDATE_SCOPES.join(', ')}`,
      )
    }
    scope = options.scope as (typeof VALID_UPDATE_SCOPES)[number]
  }
  if (options.cowork && scope !== 'user') {
    cliError('--cowork can only be used with user scope')
  }

  await updatePluginCli(plugin, scope)
}
