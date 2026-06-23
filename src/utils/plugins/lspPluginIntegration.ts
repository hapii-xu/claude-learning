import { readFile } from 'fs/promises'
import { join, relative, resolve } from 'path'
import { z } from 'zod/v4'
import type {
  LspServerConfig,
  ScopedLspServerConfig,
} from '../../services/lsp/types.js'
import { expandEnvVarsInString } from '../../services/mcp/envExpansion.js'
import type { LoadedPlugin, PluginError } from '../../types/plugin.js'
import { logForDebugging } from '../debug.js'
import { isENOENT, toError } from '../errors.js'
import { logError } from '../log.js'
import { jsonParse } from '../slowOperations.js'
import { getPluginDataDir } from './pluginDirectories.js'
import {
  getPluginStorageId,
  loadPluginOptions,
  type PluginOptionValues,
  substitutePluginVariables,
  substituteUserConfigVariables,
} from './pluginOptionsStorage.js'
import { LspServerConfigSchema } from './schemas.js'

/**
 * 验证解析后的路径是否在插件目录内。
 * 防止通过 .. 或绝对路径进行路径遍历攻击。
 */
function validatePathWithinPlugin(
  pluginPath: string,
  relativePath: string,
): string | null {
  // 将两个路径解析为绝对路径
  const resolvedPluginPath = resolve(pluginPath)
  const resolvedFilePath = resolve(pluginPath, relativePath)

  // 检查解析后的文件路径是否在插件目录内
  const rel = relative(resolvedPluginPath, resolvedFilePath)

  // 如果相对路径以 .. 开头或为绝对路径，则在插件目录之外
  if (rel.startsWith('..') || resolve(rel) === rel) {
    return null
  }

  return resolvedFilePath
}

/**
 * 从插件加载 LSP 服务器配置。
 * 检查以下内容：
 * 1. 插件目录中的 .lsp.json 文件
 * 2. manifest.lspServers 字段
 *
 * @param plugin - 已加载的插件
 * @param errors - 用于收集遇到的错误的数组
 * @returns 服务器名称到配置的记录，如果没有服务器则返回 undefined
 */
export async function loadPluginLspServers(
  plugin: LoadedPlugin,
  errors: PluginError[] = [],
): Promise<Record<string, LspServerConfig> | undefined> {
  const servers: Record<string, LspServerConfig> = {}

  // 1. 检查插件目录中是否存在 .lsp.json 文件
  const lspJsonPath = join(plugin.path, '.lsp.json')
  try {
    const content = await readFile(lspJsonPath, 'utf-8')
    const parsed = jsonParse(content)
    const result = z
      .record(z.string(), LspServerConfigSchema())
      .safeParse(parsed)

    if (result.success) {
      Object.assign(servers, result.data)
    } else {
      const errorMsg = `LSP config validation failed for .lsp.json in plugin ${plugin.name}: ${result.error.message}`
      logError(new Error(errorMsg))
      errors.push({
        type: 'lsp-config-invalid',
        plugin: plugin.name,
        serverName: '.lsp.json',
        validationError: result.error.message,
        source: 'plugin',
      })
    }
  } catch (error) {
    // .lsp.json 是可选的，不存在时忽略
    if (!isENOENT(error)) {
      const _errorMsg =
        error instanceof Error
          ? `Failed to read/parse .lsp.json in plugin ${plugin.name}: ${error.message}`
          : `Failed to read/parse .lsp.json file in plugin ${plugin.name}`

      logError(toError(error))

      errors.push({
        type: 'lsp-config-invalid',
        plugin: plugin.name,
        serverName: '.lsp.json',
        validationError:
          error instanceof Error
            ? `Failed to parse JSON: ${error.message}`
            : 'Failed to parse JSON file',
        source: 'plugin',
      })
    }
  }

  // 2. 检查 manifest.lspServers 字段
  if (plugin.manifest.lspServers) {
    const manifestServers = await loadLspServersFromManifest(
      plugin.manifest.lspServers,
      plugin.path,
      plugin.name,
      errors,
    )
    if (manifestServers) {
      Object.assign(servers, manifestServers)
    }
  }

  return Object.keys(servers).length > 0 ? servers : undefined
}

/**
 * 从 manifest 声明加载 LSP 服务器（支持多种格式）。
 */
async function loadLspServersFromManifest(
  declaration:
    | string
    | Record<string, LspServerConfig>
    | Array<string | Record<string, LspServerConfig>>,
  pluginPath: string,
  pluginName: string,
  errors: PluginError[],
): Promise<Record<string, LspServerConfig> | undefined> {
  const servers: Record<string, LspServerConfig> = {}

  // 规范化为数组
  const declarations = Array.isArray(declaration) ? declaration : [declaration]

  for (const decl of declarations) {
    if (typeof decl === 'string') {
      // 验证路径以防止目录遍历
      const validatedPath = validatePathWithinPlugin(pluginPath, decl)
      if (!validatedPath) {
        const securityMsg = `Security: Path traversal attempt blocked in plugin ${pluginName}: ${decl}`
        logError(new Error(securityMsg))
        logForDebugging(securityMsg, { level: 'warn' })
        errors.push({
          type: 'lsp-config-invalid',
          plugin: pluginName,
          serverName: decl,
          validationError:
            'Invalid path: must be relative and within plugin directory',
          source: 'plugin',
        })
        continue
      }

      // 从文件加载
      try {
        const content = await readFile(validatedPath, 'utf-8')
        const parsed = jsonParse(content)
        const result = z
          .record(z.string(), LspServerConfigSchema())
          .safeParse(parsed)

        if (result.success) {
          Object.assign(servers, result.data)
        } else {
          const errorMsg = `LSP config validation failed for ${decl} in plugin ${pluginName}: ${result.error.message}`
          logError(new Error(errorMsg))
          errors.push({
            type: 'lsp-config-invalid',
            plugin: pluginName,
            serverName: decl,
            validationError: result.error.message,
            source: 'plugin',
          })
        }
      } catch (error) {
        const _errorMsg =
          error instanceof Error
            ? `Failed to read/parse LSP config from ${decl} in plugin ${pluginName}: ${error.message}`
            : `Failed to read/parse LSP config file ${decl} in plugin ${pluginName}`

        logError(toError(error))

        errors.push({
          type: 'lsp-config-invalid',
          plugin: pluginName,
          serverName: decl,
          validationError:
            error instanceof Error
              ? `Failed to parse JSON: ${error.message}`
              : 'Failed to parse JSON file',
          source: 'plugin',
        })
      }
    } else {
      // 内联配置
      for (const [serverName, config] of Object.entries(decl)) {
        const result = LspServerConfigSchema().safeParse(config)
        if (result.success) {
          servers[serverName] = result.data
        } else {
          const errorMsg = `LSP config validation failed for inline server "${serverName}" in plugin ${pluginName}: ${result.error.message}`
          logError(new Error(errorMsg))
          errors.push({
            type: 'lsp-config-invalid',
            plugin: pluginName,
            serverName,
            validationError: result.error.message,
            source: 'plugin',
          })
        }
      }
    }
  }

  return Object.keys(servers).length > 0 ? servers : undefined
}

/**
 * 解析插件 LSP 服务器的环境变量。
 * 处理 ${CLAUDE_PLUGIN_ROOT}、${user_config.X} 以及通用 ${VAR}
 * 替换。跟踪缺失的环境变量以用于错误报告。
 */
export function resolvePluginLspEnvironment(
  config: LspServerConfig,
  plugin: { path: string; source: string },
  userConfig?: PluginOptionValues,
  _errors?: PluginError[],
): LspServerConfig {
  const allMissingVars: string[] = []

  const resolveValue = (value: string): string => {
    // 首先替换插件特定变量
    let resolved = substitutePluginVariables(value, plugin)

    // 然后替换用户配置变量（如果提供）
    if (userConfig) {
      resolved = substituteUserConfigVariables(resolved, userConfig)
    }

    // 最后展开通用环境变量
    const { expanded, missingVars } = expandEnvVarsInString(resolved)
    allMissingVars.push(...missingVars)

    return expanded
  }

  const resolved = { ...config }

  // 解析命令路径
  if (resolved.command) {
    resolved.command = resolveValue(resolved.command)
  }

  // 解析参数
  if (resolved.args) {
    resolved.args = resolved.args.map((arg: string) => resolveValue(arg))
  }

  // 解析环境变量并添加 CLAUDE_PLUGIN_ROOT / CLAUDE_PLUGIN_DATA
  const resolvedEnv: Record<string, string> = {
    CLAUDE_PLUGIN_ROOT: plugin.path,
    CLAUDE_PLUGIN_DATA: getPluginDataDir(plugin.source),
    ...(resolved.env || {}),
  }
  for (const [key, value] of Object.entries(resolvedEnv)) {
    if (key !== 'CLAUDE_PLUGIN_ROOT' && key !== 'CLAUDE_PLUGIN_DATA') {
      resolvedEnv[key] = resolveValue(value)
    }
  }
  resolved.env = resolvedEnv

  // 如果存在 workspaceFolder，则解析它
  if (resolved.workspaceFolder) {
    resolved.workspaceFolder = resolveValue(resolved.workspaceFolder)
  }

  // 如果发现缺失变量，则记录日志
  if (allMissingVars.length > 0) {
    const uniqueMissingVars = [...new Set(allMissingVars)]
    const warnMsg = `Missing environment variables in plugin LSP config: ${uniqueMissingVars.join(', ')}`
    logError(new Error(warnMsg))
    logForDebugging(warnMsg, { level: 'warn' })
  }

  return resolved
}

/**
 * 向 LSP 服务器配置添加插件作用域
 * 这会为服务器名称添加前缀以避免插件之间的冲突
 */
export function addPluginScopeToLspServers(
  servers: Record<string, LspServerConfig>,
  pluginName: string,
): Record<string, ScopedLspServerConfig> {
  const scopedServers: Record<string, ScopedLspServerConfig> = {}

  for (const [name, config] of Object.entries(servers)) {
    // 为服务器名称添加插件前缀以避免冲突
    const scopedName = `plugin:${pluginName}:${name}`
    scopedServers[scopedName] = {
      ...config,
      scope: 'dynamic', // 为插件服务器使用动态作用域
      source: pluginName,
    }
  }

  return scopedServers
}

/**
 * 获取特定插件的 LSP 服务器，并进行环境变量解析和作用域处理
 * 在需要激活 LSP 服务器时调用此函数，确保其拥有
 * 正确的环境变量和作用域
 */
export async function getPluginLspServers(
  plugin: LoadedPlugin,
  errors: PluginError[] = [],
): Promise<Record<string, ScopedLspServerConfig> | undefined> {
  if (!plugin.enabled) {
    return undefined
  }

  // 如果有缓存的服务器则使用缓存
  const servers =
    plugin.lspServers || (await loadPluginLspServers(plugin, errors))
  if (!servers) {
    return undefined
  }

  // 解析环境变量。顶层 manifest.userConfig 的值
  // 在 LSP 的 command/args/env 中以 ${user_config.KEY} 形式可用。
  // 通过 manifest.userConfig 进行门控——与 buildMcpUserConfig 的理由相同：
  // loadPluginOptions 始终返回 {}，若不加此守卫，userConfig 对每个插件都为真值，
  // substituteUserConfigVariables 会在任何未解析的 ${user_config.X} 处抛出。
  // 同时跳过不必要的 keychain 读取。
  const userConfig = plugin.manifest.userConfig
    ? loadPluginOptions(getPluginStorageId(plugin))
    : undefined
  const resolvedServers: Record<string, LspServerConfig> = {}
  for (const [name, config] of Object.entries(servers)) {
    resolvedServers[name] = resolvePluginLspEnvironment(
      config,
      plugin,
      userConfig,
      errors,
    )
  }

  // 添加插件作用域
  return addPluginScopeToLspServers(resolvedServers, plugin.name)
}

/**
 * 从已加载的插件中提取所有 LSP 服务器
 */
export async function extractLspServersFromPlugins(
  plugins: LoadedPlugin[],
  errors: PluginError[] = [],
): Promise<Record<string, ScopedLspServerConfig>> {
  const allServers: Record<string, ScopedLspServerConfig> = {}

  for (const plugin of plugins) {
    if (!plugin.enabled) continue

    const servers = await loadPluginLspServers(plugin, errors)
    if (servers) {
      const scopedServers = addPluginScopeToLspServers(servers, plugin.name)
      Object.assign(allServers, scopedServers)

      // 将服务器存储在插件上以供缓存
      plugin.lspServers = servers

      logForDebugging(
        `Loaded ${Object.keys(servers).length} LSP servers from plugin ${plugin.name}`,
      )
    }
  }

  return allServers
}
