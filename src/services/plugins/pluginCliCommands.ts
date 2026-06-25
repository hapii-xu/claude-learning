/**
 * plugin 操作的 CLI 命令包装器
 *
 * 本模块为核心 plugin 操作提供薄包装层，
 * 负责处理 CLI 特有的关注点，如控制台输出和进程退出。
 *
 * 核心操作（无 CLI 副作用）见 pluginOperations.ts
 */
import figures from 'figures'
import { errorMessage } from '../../utils/errors.js'
import { gracefulShutdown } from '../../utils/gracefulShutdown.js'
import { logError } from '../../utils/log.js'
import { getManagedPluginNames } from '../../utils/plugins/managedPlugins.js'
import { parsePluginIdentifier } from '../../utils/plugins/pluginIdentifier.js'
import type { PluginScope } from '../../utils/plugins/schemas.js'
import { writeToStdout } from '../../utils/process.js'
import {
  buildPluginTelemetryFields,
  classifyPluginCommandError,
} from '../../utils/telemetry/pluginTelemetry.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
  logEvent,
} from '../analytics/index.js'
import {
  disableAllPluginsOp,
  disablePluginOp,
  enablePluginOp,
  type InstallableScope,
  installPluginOp,
  uninstallPluginOp,
  updatePluginOp,
  VALID_INSTALLABLE_SCOPES,
  VALID_UPDATE_SCOPES,
} from './pluginOperations.js'

export { VALID_INSTALLABLE_SCOPES, VALID_UPDATE_SCOPES }

type PluginCliCommand =
  | 'install'
  | 'uninstall'
  | 'enable'
  | 'disable'
  | 'disable-all'
  | 'update'

/**
 * plugin CLI 命令的通用错误处理器。在退出前发出
 * tengu_plugin_command_failed 事件，以便仪表板可以与对应成功事件计算成功率。
 */
function handlePluginCommandError(
  error: unknown,
  command: PluginCliCommand,
  plugin?: string,
): never {
  logError(error)
  const operation = plugin
    ? `${command} plugin "${plugin}"`
    : command === 'disable-all'
      ? 'disable all plugins'
      : `${command} plugins`
  console.error(
    `${figures.cross} Failed to ${operation}: ${errorMessage(error)}`,
  )
  const telemetryFields = plugin
    ? (() => {
        const { name, marketplace } = parsePluginIdentifier(plugin)
        return {
          _PROTO_plugin_name:
            name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
          ...(marketplace && {
            _PROTO_marketplace_name:
              marketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
          }),
          ...buildPluginTelemetryFields(
            name,
            marketplace,
            getManagedPluginNames(),
          ),
        }
      })()
    : {}
  logEvent('tengu_plugin_command_failed', {
    command:
      command as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    error_category: classifyPluginCommandError(
      error,
    ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    ...telemetryFields,
  })
  // eslint-disable-next-line custom-rules/no-process-exit
  process.exit(1)
}

/**
 * CLI 命令：非交互式安装 plugin
 * @param plugin plugin 标识符（name 或 plugin@marketplace）
 * @param scope 安装 scope：user、project 或 local（默认为 'user'）
 */
export async function installPlugin(
  plugin: string,
  scope: InstallableScope = 'user',
): Promise<void> {
  try {
    console.log(`Installing plugin "${plugin}"...`)

    const result = await installPluginOp(plugin, scope)

    if (!result.success) {
      throw new Error(result.message)
    }

    console.log(`${figures.tick} ${result.message}`)

    // _PROTO_* 路由到 BQ 中带 PII 标记的 plugin_name/marketplace_name 列。
    // 未脱敏的 plugin_id 此前会对所有用户记录到 additional_metadata 通用列——
    // 已改为使用特权列路由。
    const { name, marketplace } = parsePluginIdentifier(
      result.pluginId || plugin,
    )
    logEvent('tengu_plugin_installed_cli', {
      _PROTO_plugin_name:
        name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      ...(marketplace && {
        _PROTO_marketplace_name:
          marketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      }),
      scope: (result.scope ||
        scope) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      install_source:
        'cli-explicit' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...buildPluginTelemetryFields(name, marketplace, getManagedPluginNames()),
    })

    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(0)
  } catch (error) {
    handlePluginCommandError(error, 'install', plugin)
  }
}

/**
 * CLI 命令：非交互式卸载 plugin
 * @param plugin plugin name 或 plugin@marketplace 标识符
 * @param scope 从哪个 scope 卸载：user、project 或 local（默认为 'user'）
 */
export async function uninstallPlugin(
  plugin: string,
  scope: InstallableScope = 'user',
  keepData = false,
): Promise<void> {
  try {
    const result = await uninstallPluginOp(plugin, scope, !keepData)

    if (!result.success) {
      throw new Error(result.message)
    }

    console.log(`${figures.tick} ${result.message}`)

    const { name, marketplace } = parsePluginIdentifier(
      result.pluginId || plugin,
    )
    logEvent('tengu_plugin_uninstalled_cli', {
      _PROTO_plugin_name:
        name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      ...(marketplace && {
        _PROTO_marketplace_name:
          marketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      }),
      scope: (result.scope ||
        scope) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...buildPluginTelemetryFields(name, marketplace, getManagedPluginNames()),
    })

    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(0)
  } catch (error) {
    handlePluginCommandError(error, 'uninstall', plugin)
  }
}

/**
 * CLI 命令：非交互式启用 plugin
 * @param plugin plugin name 或 plugin@marketplace 标识符
 * @param scope 可选 scope。若未提供，则自动找到当前项目最具体的 scope。
 */
export async function enablePlugin(
  plugin: string,
  scope?: InstallableScope,
): Promise<void> {
  try {
    const result = await enablePluginOp(plugin, scope)

    if (!result.success) {
      throw new Error(result.message)
    }

    console.log(`${figures.tick} ${result.message}`)

    const { name, marketplace } = parsePluginIdentifier(
      result.pluginId || plugin,
    )
    logEvent('tengu_plugin_enabled_cli', {
      _PROTO_plugin_name:
        name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      ...(marketplace && {
        _PROTO_marketplace_name:
          marketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      }),
      scope:
        result.scope as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...buildPluginTelemetryFields(name, marketplace, getManagedPluginNames()),
    })

    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(0)
  } catch (error) {
    handlePluginCommandError(error, 'enable', plugin)
  }
}

/**
 * CLI 命令：非交互式禁用 plugin
 * @param plugin plugin name 或 plugin@marketplace 标识符
 * @param scope 可选 scope。若未提供，则自动找到当前项目最具体的 scope。
 */
export async function disablePlugin(
  plugin: string,
  scope?: InstallableScope,
): Promise<void> {
  try {
    const result = await disablePluginOp(plugin, scope)

    if (!result.success) {
      throw new Error(result.message)
    }

    console.log(`${figures.tick} ${result.message}`)

    const { name, marketplace } = parsePluginIdentifier(
      result.pluginId || plugin,
    )
    logEvent('tengu_plugin_disabled_cli', {
      _PROTO_plugin_name:
        name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      ...(marketplace && {
        _PROTO_marketplace_name:
          marketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      }),
      scope:
        result.scope as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...buildPluginTelemetryFields(name, marketplace, getManagedPluginNames()),
    })

    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(0)
  } catch (error) {
    handlePluginCommandError(error, 'disable', plugin)
  }
}

/**
 * CLI 命令：非交互式禁用所有已启用的 plugin
 */
export async function disableAllPlugins(): Promise<void> {
  try {
    const result = await disableAllPluginsOp()

    if (!result.success) {
      throw new Error(result.message)
    }

    console.log(`${figures.tick} ${result.message}`)

    logEvent('tengu_plugin_disabled_all_cli', {})

    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(0)
  } catch (error) {
    handlePluginCommandError(error, 'disable-all')
  }
}

/**
 * CLI 命令：非交互式更新 plugin
 * @param plugin plugin name 或 plugin@marketplace 标识符
 * @param scope 要更新的 scope
 */
export async function updatePluginCli(
  plugin: string,
  scope: PluginScope,
): Promise<void> {
  try {
    writeToStdout(
      `Checking for updates for plugin "${plugin}" at ${scope} scope…\n`,
    )

    const result = await updatePluginOp(plugin, scope)

    if (!result.success) {
      throw new Error(result.message)
    }

    writeToStdout(`${figures.tick} ${result.message}\n`)

    if (!result.alreadyUpToDate) {
      const { name, marketplace } = parsePluginIdentifier(
        result.pluginId || plugin,
      )
      logEvent('tengu_plugin_updated_cli', {
        _PROTO_plugin_name:
          name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
        ...(marketplace && {
          _PROTO_marketplace_name:
            marketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
        }),
        old_version: (result.oldVersion ||
          'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        new_version: (result.newVersion ||
          'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        ...buildPluginTelemetryFields(
          name,
          marketplace,
          getManagedPluginNames(),
        ),
      })
    }

    await gracefulShutdown(0)
  } catch (error) {
    handlePluginCommandError(error, 'update', plugin)
  }
}
