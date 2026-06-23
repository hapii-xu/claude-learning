/**
 * LSP 插件推荐工具
 *
 * 扫描已安装的 marketplace 中的 LSP 插件，并根据文件扩展名推荐插件，
 * 但仅当 LSP 二进制文件已安装在系统上时。
 *
 * 限制：只能检测在 marketplace 条目中内联声明其服务器的 LSP 插件。
 * 具有单独 .lsp.json 文件的插件在安装前无法检测到。
 */

import { extname } from 'path'
import { isBinaryInstalled } from '../binaryCheck.js'
import { getGlobalConfig, saveGlobalConfig } from '../config.js'
import { logForDebugging } from '../debug.js'
import { isPluginInstalled } from './installedPluginsManager.js'
import {
  getMarketplace,
  loadKnownMarketplacesConfig,
} from './marketplaceManager.js'
import {
  ALLOWED_OFFICIAL_MARKETPLACE_NAMES,
  type PluginMarketplaceEntry,
} from './schemas.js'

/**
 * 返回给调用方的 LSP 插件推荐
 */
export type LspPluginRecommendation = {
  pluginId: string // "plugin-name@marketplace-name"
  pluginName: string // 人类可读的插件名称
  marketplaceName: string // Marketplace 名称
  description?: string // 插件描述
  isOfficial: boolean // 来自官方 marketplace？
  extensions: string[] // 此插件支持的文件扩展名
  command: string // LSP 服务器命令（例如 "typescript-language-server"）
}

// 用户可忽略推荐的最大次数，超过后停止显示
const MAX_IGNORED_COUNT = 5

/**
 * 检查 marketplace 是否为官方（来自 Anthropic）
 */
function isOfficialMarketplace(name: string): boolean {
  return ALLOWED_OFFICIAL_MARKETPLACE_NAMES.has(name.toLowerCase())
}

/**
 * 从插件清单提取的 LSP 信息的内部类型
 */
type LspInfo = {
  extensions: Set<string>
  command: string
}

/**
 * 从内联 lspServers 配置提取 LSP 信息（扩展名和命令）。
 *
 * 注意：只能读取内联配置，不能读取外部 .lsp.json 文件。
 * 字符串路径会被跳过，因为它们引用的文件仅在安装后可用。
 *
 * @param lspServers - PluginMarketplaceEntry 的 lspServers 字段
 * @returns 包含扩展名和命令的 LSP 信息，若无法提取则返回 null
 */
function extractLspInfoFromManifest(
  lspServers: PluginMarketplaceEntry['lspServers'],
): LspInfo | null {
  if (!lspServers) {
    return null
  }

  // 若是字符串路径（例如 "./.lsp.json"），无法从 marketplace 读取
  if (typeof lspServers === 'string') {
    logForDebugging(
      '[lspRecommendation] Skipping string path lspServers (not readable from marketplace)',
    )
    return null
  }

  // 若是数组，处理每个元素
  if (Array.isArray(lspServers)) {
    for (const item of lspServers) {
      // 跳过数组中的字符串路径
      if (typeof item === 'string') {
        continue
      }
      // 尝试从内联配置对象提取
      const info = extractFromServerConfigRecord(item)
      if (info) {
        return info
      }
    }
    return null
  }

  // 是内联配置对象：Record<string, LspServerConfig>
  return extractFromServerConfigRecord(lspServers)
}

/**
 * 从服务器配置记录（内联对象格式）提取 LSP 信息
 */
/**
 * 类型守卫：检查值是否为 record 对象
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function extractFromServerConfigRecord(
  serverConfigs: Record<string, unknown>,
): LspInfo | null {
  const extensions = new Set<string>()
  let command: string | null = null

  for (const [_serverName, config] of Object.entries(serverConfigs)) {
    if (!isRecord(config)) {
      continue
    }

    // 从第一个有效的服务器配置获取命令
    if (!command && typeof config.command === 'string') {
      command = config.command
    }

    // 从 extensionToLanguage 映射收集所有扩展名
    const extMapping = config.extensionToLanguage
    if (isRecord(extMapping)) {
      for (const ext of Object.keys(extMapping)) {
        extensions.add(ext.toLowerCase())
      }
    }
  }

  if (!command || extensions.size === 0) {
    return null
  }

  return { extensions, command }
}

/**
 * 带 LSP 信息的插件内部类型
 */
type LspPluginInfo = {
  entry: PluginMarketplaceEntry
  marketplaceName: string
  extensions: Set<string>
  command: string
  isOfficial: boolean
}

/**
 * 从所有已安装的 marketplace 获取所有 LSP 插件
 *
 * @returns pluginId 到含 LSP 元数据的插件信息的映射
 */
async function getLspPluginsFromMarketplaces(): Promise<
  Map<string, LspPluginInfo>
> {
  const result = new Map<string, LspPluginInfo>()

  try {
    const config = await loadKnownMarketplacesConfig()

    for (const marketplaceName of Object.keys(config)) {
      try {
        const marketplace = await getMarketplace(marketplaceName)
        const isOfficial = isOfficialMarketplace(marketplaceName)

        for (const entry of marketplace.plugins) {
          // 跳过没有 lspServers 的插件
          if (!entry.lspServers) {
            continue
          }

          const lspInfo = extractLspInfoFromManifest(entry.lspServers)
          if (!lspInfo) {
            continue
          }

          const pluginId = `${entry.name}@${marketplaceName}`
          result.set(pluginId, {
            entry,
            marketplaceName,
            extensions: lspInfo.extensions,
            command: lspInfo.command,
            isOfficial,
          })
        }
      } catch (error) {
        logForDebugging(
          `[lspRecommendation] Failed to load marketplace ${marketplaceName}: ${error}`,
        )
      }
    }
  } catch (error) {
    logForDebugging(
      `[lspRecommendation] Failed to load marketplaces config: ${error}`,
    )
  }

  return result
}

/**
 * 查找与文件路径匹配的 LSP 插件。
 *
 * 返回满足以下条件的插件推荐：
 * 1. 支持该文件的扩展名
 * 2. 其 LSP 二进制文件已安装在系统上
 * 3. 尚未安装
 * 4. 不在用户的"永不建议"列表中
 *
 * 结果按官方 marketplace 插件优先排序。
 *
 * @param filePath - 要查找 LSP 插件的文件路径
 * @returns 匹配的插件推荐数组（若无匹配或已禁用则为空）
 */
export async function getMatchingLspPlugins(
  filePath: string,
): Promise<LspPluginRecommendation[]> {
  // 检查是否全局禁用
  if (isLspRecommendationsDisabled()) {
    logForDebugging('[lspRecommendation] Recommendations are disabled')
    return []
  }

  // 提取文件扩展名
  const ext = extname(filePath).toLowerCase()
  if (!ext) {
    logForDebugging('[lspRecommendation] No file extension found')
    return []
  }

  logForDebugging(`[lspRecommendation] Looking for LSP plugins for ${ext}`)

  // 从 marketplace 获取所有 LSP 插件
  const allLspPlugins = await getLspPluginsFromMarketplaces()

  // 获取用于过滤的配置
  const config = getGlobalConfig()
  const neverPlugins = config.lspRecommendationNeverPlugins ?? []

  // 过滤出匹配的插件
  const matchingPlugins: Array<{ info: LspPluginInfo; pluginId: string }> = []

  for (const [pluginId, info] of allLspPlugins) {
    // 检查扩展名匹配
    if (!info.extensions.has(ext)) {
      continue
    }

    // 过滤：不在"永不"列表中
    if (neverPlugins.includes(pluginId)) {
      logForDebugging(
        `[lspRecommendation] Skipping ${pluginId} (in never suggest list)`,
      )
      continue
    }

    // 过滤：尚未安装
    if (isPluginInstalled(pluginId)) {
      logForDebugging(
        `[lspRecommendation] Skipping ${pluginId} (already installed)`,
      )
      continue
    }

    matchingPlugins.push({ info, pluginId })
  }

  // 过滤：二进制文件必须已安装（异步检查）
  const pluginsWithBinary: Array<{ info: LspPluginInfo; pluginId: string }> = []

  for (const { info, pluginId } of matchingPlugins) {
    const binaryExists = await isBinaryInstalled(info.command)
    if (binaryExists) {
      pluginsWithBinary.push({ info, pluginId })
      logForDebugging(
        `[lspRecommendation] Binary '${info.command}' found for ${pluginId}`,
      )
    } else {
      logForDebugging(
        `[lspRecommendation] Skipping ${pluginId} (binary '${info.command}' not found)`,
      )
    }
  }

  // 排序：官方 marketplace 优先
  pluginsWithBinary.sort((a, b) => {
    if (a.info.isOfficial && !b.info.isOfficial) return -1
    if (!a.info.isOfficial && b.info.isOfficial) return 1
    return 0
  })

  // 转换为推荐结果
  return pluginsWithBinary.map(({ info, pluginId }) => ({
    pluginId,
    pluginName: info.entry.name,
    marketplaceName: info.marketplaceName,
    description: info.entry.description,
    isOfficial: info.isOfficial,
    extensions: Array.from(info.extensions),
    command: info.command,
  }))
}

/**
 * 将插件添加到"永不建议"列表
 *
 * @param pluginId - 不再建议的插件 ID
 */
export function addToNeverSuggest(pluginId: string): void {
  saveGlobalConfig(currentConfig => {
    const current = currentConfig.lspRecommendationNeverPlugins ?? []
    if (current.includes(pluginId)) {
      return currentConfig
    }
    return {
      ...currentConfig,
      lspRecommendationNeverPlugins: [...current, pluginId],
    }
  })
  logForDebugging(`[lspRecommendation] Added ${pluginId} to never suggest`)
}

/**
 * 递增已忽略推荐计数。
 * 在忽略 MAX_IGNORED_COUNT 次后，推荐被禁用。
 */
export function incrementIgnoredCount(): void {
  saveGlobalConfig(currentConfig => {
    const newCount = (currentConfig.lspRecommendationIgnoredCount ?? 0) + 1
    return {
      ...currentConfig,
      lspRecommendationIgnoredCount: newCount,
    }
  })
  logForDebugging('[lspRecommendation] Incremented ignored count')
}

/**
 * 检查 LSP 推荐是否被禁用。
 * 禁用条件：
 * - 用户通过配置显式禁用
 * - 用户已忽略 MAX_IGNORED_COUNT 次推荐
 */
export function isLspRecommendationsDisabled(): boolean {
  const config = getGlobalConfig()
  return (
    config.lspRecommendationDisabled === true ||
    (config.lspRecommendationIgnoredCount ?? 0) >= MAX_IGNORED_COUNT
  )
}

/**
 * 重置已忽略计数（若用户重新启用推荐则有用）
 */
export function resetIgnoredCount(): void {
  saveGlobalConfig(currentConfig => {
    const currentCount = currentConfig.lspRecommendationIgnoredCount ?? 0
    if (currentCount === 0) {
      return currentConfig
    }
    return {
      ...currentConfig,
      lspRecommendationIgnoredCount: 0,
    }
  })
  logForDebugging('[lspRecommendation] Reset ignored count')
}
