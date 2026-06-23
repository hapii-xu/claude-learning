/**
 * 管理存储在 installed_plugins.json 中的插件安装元数据
 *
 * 本模块将插件安装状态（全局）与启用/禁用状态（按仓库）分离。
 * installed_plugins.json 文件跟踪：
 * - 哪些插件已全局安装
 * - 安装元数据（版本、时间戳、路径）
 *
 * 启用/禁用状态保留在 .claude/settings.json 中，以便按仓库控制。
 *
 * 原因：安装是全局的（插件要么在磁盘上，要么不在），而
 * 启用/禁用状态是按仓库的（不同项目可能需要不同的插件激活）。
 */

import { dirname, join } from 'path'
import { logForDebugging } from '../debug.js'
import { errorMessage, isENOENT, toError } from '../errors.js'
import { getFsImplementation } from '../fsOperations.js'
import { logError } from '../log.js'
import {
  jsonParse,
  jsonStringify,
  writeFileSync_DEPRECATED,
} from '../slowOperations.js'
import { getPluginsDirectory } from './pluginDirectories.js'
import {
  type InstalledPlugin,
  InstalledPluginsFileSchemaV1,
  InstalledPluginsFileSchemaV2,
  type InstalledPluginsFileV1,
  type InstalledPluginsFileV2,
  type PluginInstallationEntry,
  type PluginScope,
} from './schemas.js'

// V2 插件映射的类型别名
type InstalledPluginsMapV2 = Record<string, PluginInstallationEntry[]>

// 可持久化作用域的类型（排除仅会话级别的 'flag'）
export type PersistableScope = Exclude<PluginScope, never> // 所有作用域在 schema 中均可持久化

import { getOriginalCwd } from '../../bootstrap/state.js'
import { getCwd } from '../cwd.js'
import { getHeadForDir } from '../git/gitFilesystem.js'
import type { EditableSettingSource } from '../settings/constants.js'
import {
  getSettings_DEPRECATED,
  getSettingsForSource,
} from '../settings/settings.js'
import { getPluginById } from './marketplaceManager.js'
import {
  parsePluginIdentifier,
  settingSourceToScope,
} from './pluginIdentifier.js'
import { getPluginCachePath, getVersionedCachePath } from './pluginLoader.js'

// 迁移状态，防止每次会话中多次执行迁移
let migrationCompleted = false

/**
 * 已安装插件数据的记忆化缓存（V2 格式）
 * 当文件被修改时，由 clearInstalledPluginsCache() 清除。
 * 防止在单次 CLI 会话中重复读取文件系统。
 */
let installedPluginsCacheV2: InstalledPluginsFileV2 | null = null

/**
 * 启动时已安装插件的会话级快照。
 * 这是当前运行会话使用的数据 —— 不会被后台操作更新。
 * 后台更新仅修改磁盘文件。
 */
let inMemoryInstalledPlugins: InstalledPluginsFileV2 | null = null

/**
 * 获取 installed_plugins.json 文件的路径
 */
export function getInstalledPluginsFilePath(): string {
  return join(getPluginsDirectory(), 'installed_plugins.json')
}

/**
 * 获取旧版 installed_plugins_v2.json 文件的路径。
 * 仅在迁移期间用于合并为单个文件。
 */
export function getInstalledPluginsV2FilePath(): string {
  return join(getPluginsDirectory(), 'installed_plugins_v2.json')
}

/**
 * 清除已安装插件的缓存
 * 当文件被修改时调用此函数以强制重新加载
 *
 * 注意：这也会清除内存中的会话状态（inMemoryInstalledPlugins）。
 * 大多数情况下，仅在初始化或测试期间调用。
 * 对于后台更新，请使用 updateInstallationPathOnDisk()，它会保留内存中的状态。
 */
export function clearInstalledPluginsCache(): void {
  installedPluginsCacheV2 = null
  inMemoryInstalledPlugins = null
  logForDebugging('Cleared installed plugins cache')
}

/**
 * 迁移到单插件文件格式。
 *
 * 将 V1/V2 双文件系统合并为单个文件：
 * 1. 若 installed_plugins_v2.json 存在：复制到 installed_plugins.json（version=2），删除 V2 文件
 * 2. 若只有 installed_plugins.json 且 version=1：就地转换为 version=2
 * 3. 清理旧版无版本号的缓存目录
 *
 * 此迁移在每次会话启动时执行一次。
 */
export function migrateToSinglePluginFile(): void {
  if (migrationCompleted) {
    return
  }

  const fs = getFsImplementation()
  const mainFilePath = getInstalledPluginsFilePath()
  const v2FilePath = getInstalledPluginsV2FilePath()

  try {
    // 情况 1：尝试直接将 v2 重命名为 main；ENOENT 表示 v2 不存在
    try {
      fs.renameSync(v2FilePath, mainFilePath)
      logForDebugging(
        `Renamed installed_plugins_v2.json to installed_plugins.json`,
      )
      // 清理旧版缓存目录
      const v2Data = loadInstalledPluginsV2()
      cleanupLegacyCache(v2Data)
      migrationCompleted = true
      return
    } catch (e) {
      if (!isENOENT(e)) throw e
    }

    // 情况 2：v2 不存在 —— 尝试读取 main；ENOENT = 两者都不存在（情况 3）
    let mainContent: string
    try {
      mainContent = fs.readFileSync(mainFilePath, { encoding: 'utf-8' })
    } catch (e) {
      if (!isENOENT(e)) throw e
      // 情况 3：文件不存在 —— 无需迁移
      migrationCompleted = true
      return
    }

    const mainData = jsonParse(mainContent)
    const version = typeof mainData?.version === 'number' ? mainData.version : 1

    if (version === 1) {
      // 就地将 V1 转换为 V2 格式
      const v1Data = InstalledPluginsFileSchemaV1().parse(mainData)
      const v2Data = migrateV1ToV2(v1Data)

      writeFileSync_DEPRECATED(mainFilePath, jsonStringify(v2Data, null, 2), {
        encoding: 'utf-8',
        flush: true,
      })
      logForDebugging(
        `Converted installed_plugins.json from V1 to V2 format (${Object.keys(v1Data.plugins).length} plugins)`,
      )

      // 清理旧版缓存目录
      cleanupLegacyCache(v2Data)
    }
    // 若 version=2，已是正确格式，无需操作

    migrationCompleted = true
  } catch (error) {
    const errorMsg = errorMessage(error)
    logForDebugging(`Failed to migrate plugin files: ${errorMsg}`, {
      level: 'error',
    })
    logError(toError(error))
    // 标记为已完成，避免重试失败的迁移
    migrationCompleted = true
  }
}

/**
 * 清理旧版无版本号的缓存目录。
 *
 * 旧版缓存结构：~/.claude/plugins/cache/{plugin-name}/
 * 版本化缓存结构：~/.claude/plugins/cache/{marketplace}/{plugin}/{version}/
 *
 * 此函数删除未被任何安装引用的旧版目录。
 */
function cleanupLegacyCache(v2Data: InstalledPluginsFileV2): void {
  const fs = getFsImplementation()
  const cachePath = getPluginCachePath()
  try {
    // 收集所有被引用的安装路径
    const referencedPaths = new Set<string>()
    for (const installations of Object.values(v2Data.plugins)) {
      for (const entry of installations) {
        referencedPaths.add(entry.installPath)
      }
    }

    // 列出缓存中的顶层目录
    const entries = fs.readdirSync(cachePath)

    for (const dirent of entries) {
      if (!dirent.isDirectory()) {
        continue
      }

      const entry = dirent.name
      const entryPath = join(cachePath, entry)

      // 检查这是版本化缓存（含 plugin/version 子目录的 marketplace 目录）
      // 还是旧版缓存（扁平插件目录）
      const subEntries = fs.readdirSync(entryPath)
      const hasVersionedStructure = subEntries.some(subDirent => {
        if (!subDirent.isDirectory()) return false
        const subPath = join(entryPath, subDirent.name)
        // 检查子目录是否包含版本目录（类 semver 或哈希）
        const versionEntries = fs.readdirSync(subPath)
        return versionEntries.some(vDirent => vDirent.isDirectory())
      })

      if (hasVersionedStructure) {
        // 这是具有版本化结构的 marketplace 目录 —— 跳过
        continue
      }

      // 这是旧版扁平缓存目录
      // 检查是否被任何安装引用
      if (!referencedPaths.has(entryPath)) {
        // 未被引用 —— 可以安全删除
        fs.rmSync(entryPath, { recursive: true, force: true })
        logForDebugging(`Cleaned up legacy cache directory: ${entry}`)
      }
    }
  } catch (error) {
    const errorMsg = errorMessage(error)
    logForDebugging(`Failed to clean up legacy cache: ${errorMsg}`, {
      level: 'warn',
    })
  }
}

/**
 * 重置迁移状态（用于测试）
 */
export function resetMigrationState(): void {
  migrationCompleted = false
}

/**
 * 从 installed_plugins.json 读取原始文件数据
 * 若文件不存在则返回 null。
 * 若文件存在但无法解析则抛出错误。
 */
function readInstalledPluginsFileRaw(): {
  version: number
  data: unknown
} | null {
  const fs = getFsImplementation()
  const filePath = getInstalledPluginsFilePath()

  let fileContent: string
  try {
    fileContent = fs.readFileSync(filePath, { encoding: 'utf-8' })
  } catch (e) {
    if (isENOENT(e)) {
      return null
    }
    throw e
  }
  const data = jsonParse(fileContent)
  const version = typeof data?.version === 'number' ? data.version : 1
  return { version, data }
}

/**
 * 将 V1 数据迁移到 V2 格式。
 * 所有 V1 插件均迁移到 'user' 作用域，因为 V1 没有作用域概念。
 */
function migrateV1ToV2(v1Data: InstalledPluginsFileV1): InstalledPluginsFileV2 {
  const v2Plugins: InstalledPluginsMapV2 = {}

  for (const [pluginId, plugin] of Object.entries(v1Data.plugins)) {
    // V2 格式使用版本化缓存路径：~/.claude/plugins/cache/{marketplace}/{plugin}/{version}
    // 从 pluginId 和 version 计算路径，而非使用 V1 的 installPath
    const versionedCachePath = getVersionedCachePath(pluginId, plugin.version)

    v2Plugins[pluginId] = [
      {
        scope: 'user', // 将所有现有安装默认为 user 作用域
        installPath: versionedCachePath,
        version: plugin.version,
        installedAt: plugin.installedAt,
        lastUpdated: plugin.lastUpdated,
        gitCommitSha: plugin.gitCommitSha,
      },
    ]
  }

  return { version: 2, plugins: v2Plugins }
}

/**
 * 以 V2 格式加载已安装插件。
 *
 * 从 installed_plugins.json 读取。若文件 version=1，
 * 则在内存中转换为 V2 格式。
 *
 * @returns 每个插件为数组结构的 V2 格式数据
 */
export function loadInstalledPluginsV2(): InstalledPluginsFileV2 {
  // 如果缓存的 V2 数据可用则直接返回
  if (installedPluginsCacheV2 !== null) {
    return installedPluginsCacheV2
  }

  const filePath = getInstalledPluginsFilePath()

  try {
    const rawData = readInstalledPluginsFileRaw()

    if (rawData) {
      if (rawData.version === 2) {
        // V2 格式 —— 验证并返回
        const validated = InstalledPluginsFileSchemaV2().parse(rawData.data)
        installedPluginsCacheV2 = validated
        logForDebugging(
          `Loaded ${Object.keys(validated.plugins).length} installed plugins from ${filePath}`,
        )
        return validated
      }

      // V1 格式 —— 转换为 V2
      const v1Validated = InstalledPluginsFileSchemaV1().parse(rawData.data)
      const v2Data = migrateV1ToV2(v1Validated)
      installedPluginsCacheV2 = v2Data
      logForDebugging(
        `Loaded and converted ${Object.keys(v1Validated.plugins).length} plugins from V1 format`,
      )
      return v2Data
    }

    // 文件不存在 —— 返回空 V2
    logForDebugging(
      `installed_plugins.json doesn't exist, returning empty V2 object`,
    )
    installedPluginsCacheV2 = { version: 2, plugins: {} }
    return installedPluginsCacheV2
  } catch (error) {
    const errorMsg = errorMessage(error)
    logForDebugging(
      `Failed to load installed_plugins.json: ${errorMsg}. Starting with empty state.`,
      { level: 'error' },
    )
    logError(toError(error))

    installedPluginsCacheV2 = { version: 2, plugins: {} }
    return installedPluginsCacheV2
  }
}

/**
 * 以 V2 格式将已安装插件保存到 installed_plugins.json。
 * 这是 V1/V2 合并后的单一数据来源。
 */
function saveInstalledPluginsV2(data: InstalledPluginsFileV2): void {
  const fs = getFsImplementation()
  const filePath = getInstalledPluginsFilePath()

  try {
    fs.mkdirSync(getPluginsDirectory())

    const jsonContent = jsonStringify(data, null, 2)
    writeFileSync_DEPRECATED(filePath, jsonContent, {
      encoding: 'utf-8',
      flush: true,
    })

    // 更新缓存
    installedPluginsCacheV2 = data

    logForDebugging(
      `Saved ${Object.keys(data.plugins).length} installed plugins to ${filePath}`,
    )
  } catch (error) {
    const _errorMsg = errorMessage(error)
    logError(toError(error))
    throw error
  }
}

/**
 * 在指定作用域添加或更新插件安装条目。
 * 用于 V2 格式，其中每个插件有一个安装数组。
 *
 * @param pluginId - 插件 ID，格式为 "plugin@marketplace"
 * @param scope - 安装作用域（managed/user/project/local）
 * @param installPath - 版本化插件目录的路径
 * @param metadata - 额外的安装元数据
 * @param projectPath - 项目路径（project/local 作用域必填）
 */
export function addPluginInstallation(
  pluginId: string,
  scope: PersistableScope,
  installPath: string,
  metadata: Partial<PluginInstallationEntry>,
  projectPath?: string,
): void {
  const data = loadInstalledPluginsFromDisk()

  // 获取或创建该插件的安装数组
  const installations = data.plugins[pluginId] || []

  // 查找该 scope+projectPath 的现有条目
  const existingIndex = installations.findIndex(
    entry => entry.scope === scope && entry.projectPath === projectPath,
  )

  const newEntry: PluginInstallationEntry = {
    scope,
    installPath,
    version: metadata.version,
    installedAt: metadata.installedAt || new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    gitCommitSha: metadata.gitCommitSha,
    ...(projectPath && { projectPath }),
  }

  if (existingIndex >= 0) {
    installations[existingIndex] = newEntry
    logForDebugging(`Updated installation for ${pluginId} at scope ${scope}`)
  } else {
    installations.push(newEntry)
    logForDebugging(`Added installation for ${pluginId} at scope ${scope}`)
  }

  data.plugins[pluginId] = installations
  saveInstalledPluginsV2(data)
}

/**
 * 从指定作用域移除插件安装条目。
 *
 * @param pluginId - 插件 ID，格式为 "plugin@marketplace"
 * @param scope - 要移除的安装作用域
 * @param projectPath - 项目路径（project/local 作用域使用）
 */
export function removePluginInstallation(
  pluginId: string,
  scope: PersistableScope,
  projectPath?: string,
): void {
  const data = loadInstalledPluginsFromDisk()
  const installations = data.plugins[pluginId]

  if (!installations) {
    return
  }

  data.plugins[pluginId] = installations.filter(
    entry => !(entry.scope === scope && entry.projectPath === projectPath),
  )

  // 若无剩余安装则完全移除该插件
  if (data.plugins[pluginId].length === 0) {
    delete data.plugins[pluginId]
  }

  saveInstalledPluginsV2(data)
  logForDebugging(`Removed installation for ${pluginId} at scope ${scope}`)
}

// =============================================================================
// 内存状态与磁盘状态管理（用于非就地更新）
// =============================================================================

/**
 * 获取内存中的已安装插件（会话状态）。
 * 此快照在启动时加载，并在整个会话中使用。
 * 不会被后台操作更新。
 *
 * @returns 表示会话视图中已安装插件的 V2 格式数据
 */
export function getInMemoryInstalledPlugins(): InstalledPluginsFileV2 {
  if (inMemoryInstalledPlugins === null) {
    inMemoryInstalledPlugins = loadInstalledPluginsV2()
  }
  return inMemoryInstalledPlugins
}

/**
 * 直接从磁盘加载已安装插件，绕过所有缓存。
 * 供后台更新程序检查变更时使用，不影响当前运行会话的视图。
 *
 * @returns 从磁盘全新读取的 V2 格式数据
 */
export function loadInstalledPluginsFromDisk(): InstalledPluginsFileV2 {
  try {
    // 从主文件读取
    const rawData = readInstalledPluginsFileRaw()

    if (rawData) {
      if (rawData.version === 2) {
        return InstalledPluginsFileSchemaV2().parse(rawData.data)
      }
      // V1 格式 —— 转换为 V2
      const v1Data = InstalledPluginsFileSchemaV1().parse(rawData.data)
      return migrateV1ToV2(v1Data)
    }

    return { version: 2, plugins: {} }
  } catch (error) {
    const errorMsg = errorMessage(error)
    logForDebugging(`Failed to load installed plugins from disk: ${errorMsg}`, {
      level: 'error',
    })
    return { version: 2, plugins: {} }
  }
}

/**
 * 仅在磁盘上更新插件的安装路径，不修改内存中的状态。
 * 供后台更新程序在磁盘上记录新版本时使用，同时会话继续使用旧版本。
 *
 * @param pluginId - 插件 ID，格式为 "plugin@marketplace"
 * @param scope - 安装作用域
 * @param projectPath - 项目路径（project/local 作用域使用）
 * @param newPath - 新安装路径（指向新版本目录）
 * @param newVersion - 新版本字符串
 */
export function updateInstallationPathOnDisk(
  pluginId: string,
  scope: PersistableScope,
  projectPath: string | undefined,
  newPath: string,
  newVersion: string,
  gitCommitSha?: string,
): void {
  const diskData = loadInstalledPluginsFromDisk()
  const installations = diskData.plugins[pluginId]

  if (!installations) {
    logForDebugging(
      `Cannot update ${pluginId} on disk: plugin not found in installed plugins`,
    )
    return
  }

  const entry = installations.find(
    e => e.scope === scope && e.projectPath === projectPath,
  )

  if (entry) {
    entry.installPath = newPath
    entry.version = newVersion
    entry.lastUpdated = new Date().toISOString()
    if (gitCommitSha !== undefined) {
      entry.gitCommitSha = gitCommitSha
    }

    const filePath = getInstalledPluginsFilePath()

    // 写入单个文件（version=2 的 V2 格式）
    writeFileSync_DEPRECATED(filePath, jsonStringify(diskData, null, 2), {
      encoding: 'utf-8',
      flush: true,
    })

    // 清除缓存（因磁盘已更改），但不更新 inMemoryInstalledPlugins
    installedPluginsCacheV2 = null

    logForDebugging(
      `Updated ${pluginId} on disk to version ${newVersion} at ${newPath}`,
    )
  } else {
    logForDebugging(
      `Cannot update ${pluginId} on disk: no installation for scope ${scope}`,
    )
  }
  // 注意：inMemoryInstalledPlugins 不会被更新
}

/**
 * 检查是否存在待处理的更新（磁盘与内存不一致）。
 * 当后台更新程序已下载新版本时会发生此情况。
 *
 * @returns 若任意插件的磁盘安装路径与内存不同则返回 true
 */
export function hasPendingUpdates(): boolean {
  const memoryState = getInMemoryInstalledPlugins()
  const diskState = loadInstalledPluginsFromDisk()

  for (const [pluginId, diskInstallations] of Object.entries(
    diskState.plugins,
  )) {
    const memoryInstallations = memoryState.plugins[pluginId]
    if (!memoryInstallations) continue

    for (const diskEntry of diskInstallations) {
      const memoryEntry = memoryInstallations.find(
        m =>
          m.scope === diskEntry.scope &&
          m.projectPath === diskEntry.projectPath,
      )
      if (memoryEntry && memoryEntry.installPath !== diskEntry.installPath) {
        return true // 磁盘版本与内存中的版本不同
      }
    }
  }

  return false
}

/**
 * 获取待处理更新的数量（磁盘与内存不一致的安装条目数）。
 *
 * @returns 有待处理更新的安装条目数量
 */
export function getPendingUpdateCount(): number {
  let count = 0
  const memoryState = getInMemoryInstalledPlugins()
  const diskState = loadInstalledPluginsFromDisk()

  for (const [pluginId, diskInstallations] of Object.entries(
    diskState.plugins,
  )) {
    const memoryInstallations = memoryState.plugins[pluginId]
    if (!memoryInstallations) continue

    for (const diskEntry of diskInstallations) {
      const memoryEntry = memoryInstallations.find(
        m =>
          m.scope === diskEntry.scope &&
          m.projectPath === diskEntry.projectPath,
      )
      if (memoryEntry && memoryEntry.installPath !== diskEntry.installPath) {
        count++
      }
    }
  }

  return count
}

/**
 * 获取待处理更新的详细信息以供显示。
 *
 * @returns 包含 pluginId、scope、oldVersion、newVersion 的对象数组
 */
export function getPendingUpdatesDetails(): Array<{
  pluginId: string
  scope: string
  oldVersion: string
  newVersion: string
}> {
  const updates: Array<{
    pluginId: string
    scope: string
    oldVersion: string
    newVersion: string
  }> = []

  const memoryState = getInMemoryInstalledPlugins()
  const diskState = loadInstalledPluginsFromDisk()

  for (const [pluginId, diskInstallations] of Object.entries(
    diskState.plugins,
  )) {
    const memoryInstallations = memoryState.plugins[pluginId]
    if (!memoryInstallations) continue

    for (const diskEntry of diskInstallations) {
      const memoryEntry = memoryInstallations.find(
        m =>
          m.scope === diskEntry.scope &&
          m.projectPath === diskEntry.projectPath,
      )
      if (memoryEntry && memoryEntry.installPath !== diskEntry.installPath) {
        updates.push({
          pluginId,
          scope: diskEntry.scope,
          oldVersion: memoryEntry.version || 'unknown',
          newVersion: diskEntry.version || 'unknown',
        })
      }
    }
  }

  return updates
}

/**
 * 重置内存中的会话状态。
 * 仅应在启动时或测试时调用。
 */
export function resetInMemoryState(): void {
  inMemoryInstalledPlugins = null
}

/**
 * 初始化版本化插件系统。
 * 触发 V1→V2 迁移并初始化内存中的会话状态。
 *
 * 应在所有模式（REPL 和无头模式）启动初期调用。
 *
 * @returns 初始化完成后 resolve 的 Promise
 */
export async function initializeVersionedPlugins(): Promise<void> {
  // 步骤 1：迁移到单文件格式（合并 V1/V2 文件，清理旧版缓存）
  migrateToSinglePluginFile()

  // 步骤 2：将 settings.json 中的 enabledPlugins 同步到 installed_plugins.json
  // 必须在 CLI 退出前完成（尤其是在无头模式下）
  try {
    await migrateFromEnabledPlugins()
  } catch (error) {
    logError(error)
  }

  // 步骤 3：初始化内存中的会话状态
  // 调用 getInMemoryInstalledPlugins 会触发：
  // 1. 从磁盘加载
  // 2. 缓存到 inMemoryInstalledPlugins 作为会话状态
  const data = getInMemoryInstalledPlugins()
  logForDebugging(
    `Initialized versioned plugins system with ${Object.keys(data.plugins).length} plugins`,
  )
}

/**
 * 从 installed_plugins.json 中移除属于指定 marketplace 的所有插件条目。
 *
 * 加载一次 V2 数据，找到所有匹配 `@{marketplaceName}` 后缀的插件 ID，
 * 收集其安装路径，移除条目，然后保存一次。
 *
 * @param marketplaceName - marketplace 名称（与 `@{name}` 后缀匹配）
 * @returns 被移除条目的 orphanedPaths（供 markPluginVersionOrphaned 使用）
 *   和 removedPluginIds（供 deletePluginOptions 使用）
 */
export function removeAllPluginsForMarketplace(marketplaceName: string): {
  orphanedPaths: string[]
  removedPluginIds: string[]
} {
  if (!marketplaceName) {
    return { orphanedPaths: [], removedPluginIds: [] }
  }

  const data = loadInstalledPluginsFromDisk()
  const suffix = `@${marketplaceName}`
  const orphanedPaths = new Set<string>()
  const removedPluginIds: string[] = []

  for (const pluginId of Object.keys(data.plugins)) {
    if (!pluginId.endsWith(suffix)) {
      continue
    }

    for (const entry of data.plugins[pluginId] ?? []) {
      if (entry.installPath) {
        orphanedPaths.add(entry.installPath)
      }
    }

    delete data.plugins[pluginId]
    removedPluginIds.push(pluginId)
    logForDebugging(
      `Removed installed plugin for marketplace removal: ${pluginId}`,
    )
  }

  if (removedPluginIds.length > 0) {
    saveInstalledPluginsV2(data)
  }

  return { orphanedPaths: Array.from(orphanedPaths), removedPluginIds }
}

/**
 * 谓词：此安装是否与当前项目上下文相关？
 *
 * V2 installed_plugins.json 可能包含来自其他项目的 project 作用域条目
 * （单个用户级文件跟踪所有作用域）。调用者询问"此插件是否已安装"
 * 几乎总是指"以在此处激活的方式安装"——而非"安装在此机器上的任何位置"。
 * 参见 #29608：DiscoverPlugins.tsx 隐藏了仅在无关项目中安装的插件。
 *
 * - user/managed 作用域：始终相关（全局）
 * - project/local 作用域：仅当 projectPath 与当前项目匹配时
 *
 * 使用 getOriginalCwd() 而非 getCwd()，因为"当前项目"是 Claude Code 启动时的目录，
 * 而非工作目录漂移到的位置。
 */
export function isInstallationRelevantToCurrentProject(
  inst: PluginInstallationEntry,
): boolean {
  return (
    inst.scope === 'user' ||
    inst.scope === 'managed' ||
    inst.projectPath === getOriginalCwd()
  )
}

/**
 * 检查插件是否以与当前项目相关的方式安装。
 *
 * @param pluginId - 插件 ID，格式为 "plugin@marketplace"
 * @returns 若插件有 user/managed 作用域安装，或 project/local 作用域安装
 *   且 projectPath 与当前项目匹配则返回 true。
 *   若插件仅安装在其他项目中则返回 false。
 */
export function isPluginInstalled(pluginId: string): boolean {
  const v2Data = loadInstalledPluginsV2()
  const installations = v2Data.plugins[pluginId]
  if (!installations || installations.length === 0) {
    return false
  }
  if (!installations.some(isInstallationRelevantToCurrentProject)) {
    return false
  }
  // 插件从 settings.enabledPlugins 加载
  // 若 settings.enabledPlugins 与 installed_plugins.json 不一致
  // （通过 settings.json 覆写），则返回 false
  return getSettings_DEPRECATED().enabledPlugins?.[pluginId] !== undefined
}

/**
 * 仅当插件有 USER 或 MANAGED 作用域安装时返回 true。
 *
 * 在决定是否提供安装选项的 UI 流程中使用此函数。
 * user/managed 作用域安装表示插件全局可用 —— 用户无需再添加。
 * project/local 作用域安装表示用户可能仍想在 user 作用域安装以使其全局可用。
 *
 * gh-29997 / gh-29240 / gh-29392：浏览 UI 曾阻塞在
 * isPluginInstalled()（对 project 作用域安装返回 true），
 * 导致用户无法为同一插件添加 user 作用域条目。
 * 后端（installPluginOp → addInstalledPlugin）已支持每个插件多个作用域条目
 * —— 只有 UI 门控出了问题。
 *
 * @param pluginId - 插件 ID，格式为 "plugin@marketplace"
 */
export function isPluginGloballyInstalled(pluginId: string): boolean {
  const v2Data = loadInstalledPluginsV2()
  const installations = v2Data.plugins[pluginId]
  if (!installations || installations.length === 0) {
    return false
  }
  const hasGlobalEntry = installations.some(
    entry => entry.scope === 'user' || entry.scope === 'managed',
  )
  if (!hasGlobalEntry) return false
  // 与 isPluginInstalled 相同的设置不一致保护 —— 若 enabledPlugins
  // 被覆写，则视为未安装，以便用户重新启用。
  return getSettings_DEPRECATED().enabledPlugins?.[pluginId] !== undefined
}

/**
 * 添加或更新插件的安装元数据
 *
 * 实现双写：同时更新 V1 和 V2 文件。
 *
 * @param pluginId - 插件 ID，格式为 "plugin@marketplace"
 * @param metadata - 安装元数据
 * @param scope - 安装作用域（默认为 'user' 以向后兼容）
 * @param projectPath - 项目路径（project/local 作用域使用）
 */
export function addInstalledPlugin(
  pluginId: string,
  metadata: InstalledPlugin,
  scope: PersistableScope = 'user',
  projectPath?: string,
): void {
  const v2Data = loadInstalledPluginsFromDisk()
  const v2Entry: PluginInstallationEntry = {
    scope,
    installPath: metadata.installPath,
    version: metadata.version,
    installedAt: metadata.installedAt,
    lastUpdated: metadata.lastUpdated,
    gitCommitSha: metadata.gitCommitSha,
    ...(projectPath && { projectPath }),
  }

  // 获取或创建该插件的安装数组（保留其他作用域的安装条目）
  const installations = v2Data.plugins[pluginId] || []

  // 查找该 scope+projectPath 的现有条目
  const existingIndex = installations.findIndex(
    entry => entry.scope === scope && entry.projectPath === projectPath,
  )

  const isUpdate = existingIndex >= 0
  if (isUpdate) {
    installations[existingIndex] = v2Entry
  } else {
    installations.push(v2Entry)
  }

  v2Data.plugins[pluginId] = installations
  saveInstalledPluginsV2(v2Data)

  logForDebugging(
    `${isUpdate ? 'Updated' : 'Added'} installed plugin: ${pluginId} (scope: ${scope})`,
  )
}

/**
 * 从已安装插件注册表中移除插件
 * 应在卸载插件时调用。
 *
 * 注意：此函数仅更新注册表文件。要完全卸载，
 * 之后需调用 deletePluginCache() 以删除物理文件。
 *
 * @param pluginId - 插件 ID，格式为 "plugin@marketplace"
 * @returns 被移除插件的元数据，若未安装则返回 undefined
 */
export function removeInstalledPlugin(
  pluginId: string,
): InstalledPlugin | undefined {
  const v2Data = loadInstalledPluginsFromDisk()
  const installations = v2Data.plugins[pluginId]

  if (!installations || installations.length === 0) {
    return undefined
  }

  // 从第一个安装条目提取 V1 兼容的元数据作为返回值
  const firstInstall = installations[0]
  const metadata: InstalledPlugin | undefined = firstInstall
    ? {
        version: firstInstall.version || 'unknown',
        installedAt: firstInstall.installedAt || new Date().toISOString(),
        lastUpdated: firstInstall.lastUpdated,
        installPath: firstInstall.installPath,
        gitCommitSha: firstInstall.gitCommitSha,
      }
    : undefined

  delete v2Data.plugins[pluginId]
  saveInstalledPluginsV2(v2Data)

  logForDebugging(`Removed installed plugin: ${pluginId}`)

  return metadata
}

/**
 * 删除插件的缓存目录
 * 这会从磁盘上物理删除插件文件
 *
 * @param installPath - 插件缓存目录的绝对路径
 */
/**
 * 导出 getGitCommitSha 供 pluginInstallationHelpers 使用
 */
export { getGitCommitSha }

export function deletePluginCache(installPath: string): void {
  const fs = getFsImplementation()

  try {
    fs.rmSync(installPath, { recursive: true, force: true })
    logForDebugging(`Deleted plugin cache at ${installPath}`)

    // 清理空的父级插件目录（cache/{marketplace}/{plugin}）
    // 版本化路径结构：cache/{marketplace}/{plugin}/{version}
    const cachePath = getPluginCachePath()
    if (installPath.includes('/cache/') && installPath.startsWith(cachePath)) {
      const pluginDir = dirname(installPath) // e.g., cache/{marketplace}/{plugin}
      if (pluginDir !== cachePath && pluginDir.startsWith(cachePath)) {
        try {
          const contents = fs.readdirSync(pluginDir)
          if (contents.length === 0) {
            fs.rmdirSync(pluginDir)
            logForDebugging(`Deleted empty plugin directory at ${pluginDir}`)
          }
        } catch {
          // 父目录不存在或不可读 —— 跳过清理
        }
      }
    }
  } catch (error) {
    const errorMsg = errorMessage(error)
    logError(toError(error))
    throw new Error(
      `Failed to delete plugin cache at ${installPath}: ${errorMsg}`,
    )
  }
}

/**
 * 从 git 仓库目录获取 git commit SHA
 * 若不是 git 仓库或操作失败则返回 undefined
 */
async function getGitCommitSha(dirPath: string): Promise<string | undefined> {
  const sha = await getHeadForDir(dirPath)
  return sha ?? undefined
}

/**
 * 尝试从插件清单读取版本号
 */
function getPluginVersionFromManifest(
  pluginCachePath: string,
  pluginId: string,
): string {
  const fs = getFsImplementation()
  const manifestPath = join(pluginCachePath, '.claude-plugin', 'plugin.json')

  try {
    const manifestContent = fs.readFileSync(manifestPath, { encoding: 'utf-8' })
    const manifest = jsonParse(manifestContent)
    return manifest.version || 'unknown'
  } catch {
    logForDebugging(`Could not read version from manifest for ${pluginId}`)
    return 'unknown'
  }
}

/**
 * 将 installed_plugins.json 与 settings 中的 enabledPlugins 同步
 *
 * 检查 schema 版本，仅在以下情况更新：
 * - 文件不存在（version 0 → 当前版本）
 * - schema 版本已过时（旧版本 → 当前版本）
 * - enabledPlugins 中出现新插件
 *
 * 这种基于版本的方法使未来添加新字段变得简单：
 * 1. 递增 CURRENT_SCHEMA_VERSION
 * 2. 为新版本添加迁移逻辑
 * 3. 下次启动时文件自动更新
 *
 * 对于 enabledPlugins 中但不在 installed_plugins.json 中的每个插件：
 * - 查询 marketplace 获取实际安装路径
 * - 从清单中提取版本（若可用）
 * - 捕获基于 git 插件的 commit SHA
 *
 * 出现在 enabledPlugins 中（无论 true 还是 false）表示插件已安装。
 * 启用/禁用状态保留在 settings.json 中。
 */
export async function migrateFromEnabledPlugins(): Promise<void> {
  // 使用合并后的设置进行 shouldSkipSync 检查
  const settings = getSettings_DEPRECATED()
  const enabledPlugins = settings.enabledPlugins || {}

  // settings 中无插件 = 无需同步
  if (Object.keys(enabledPlugins).length === 0) {
    return
  }

  // 检查主文件是否存在且为 V2 格式
  const rawFileData = readInstalledPluginsFileRaw()
  const fileExists = rawFileData !== null
  const isV2Format = fileExists && rawFileData?.version === 2

  // 若文件存在且为 V2 格式，检查是否可以跳过耗时的迁移
  if (isV2Format && rawFileData) {
    // 检查 settings 中的所有插件是否已存在
    // （耗时的 getPluginById/getGitCommitSha 仅对缺失的插件运行）
    const existingData = InstalledPluginsFileSchemaV2().safeParse(
      rawFileData.data,
    )

    if (existingData?.success) {
      const plugins = existingData.data.plugins
      const allPluginsExist = Object.keys(enabledPlugins)
        .filter(id => id.includes('@'))
        .every(id => {
          const installations = plugins[id]
          return installations && installations.length > 0
        })

      if (allPluginsExist) {
        logForDebugging('All plugins already exist, skipping migration')
        return
      }
    }
  }

  logForDebugging(
    fileExists
      ? 'Syncing installed_plugins.json with enabledPlugins from all settings.json files'
      : 'Creating installed_plugins.json from settings.json files',
  )

  const now = new Date().toISOString()
  const projectPath = getCwd()

  // 步骤 1：从所有 settings.json 文件构建 pluginId -> scope 的映射
  // Settings.json 是 scope 的单一数据来源
  const pluginScopeFromSettings = new Map<
    string,
    {
      scope: 'user' | 'project' | 'local'
      projectPath: string | undefined
    }
  >()

  // 遍历每个可编辑的 settings 来源（顺序重要：user 优先）
  const settingSources: EditableSettingSource[] = [
    'userSettings',
    'projectSettings',
    'localSettings',
  ]

  for (const source of settingSources) {
    const sourceSettings = getSettingsForSource(source)
    const sourceEnabledPlugins = sourceSettings?.enabledPlugins || {}

    for (const pluginId of Object.keys(sourceEnabledPlugins)) {
      // 跳过非标准插件 ID
      if (!pluginId.includes('@')) continue

      // Settings.json 是数据来源 —— 始终更新 scope
      // 使用最具体的作用域（后者覆盖：local > project > user）
      const scope = settingSourceToScope(source)
      pluginScopeFromSettings.set(pluginId, {
        scope,
        projectPath: scope === 'user' ? undefined : projectPath,
      })
    }
  }

  // 步骤 2：从现有数据开始（若文件不存在则从空数据开始）
  let v2Plugins: InstalledPluginsMapV2 = {}

  if (fileExists) {
    // 文件存在 —— 加载现有数据
    const existingData = loadInstalledPluginsV2()
    v2Plugins = { ...existingData.plugins }
  }

  // 步骤 3：根据 settings.json 更新 V2 作用域（settings 是数据来源）
  let updatedCount = 0
  let addedCount = 0

  for (const [pluginId, scopeInfo] of pluginScopeFromSettings) {
    const existingInstallations = v2Plugins[pluginId]

    if (existingInstallations && existingInstallations.length > 0) {
      // 插件已存在于 V2 中 —— 若不同则更新 scope（settings 是数据来源）
      const existingEntry = existingInstallations[0]
      if (
        existingEntry &&
        (existingEntry.scope !== scopeInfo.scope ||
          existingEntry.projectPath !== scopeInfo.projectPath)
      ) {
        existingEntry.scope = scopeInfo.scope
        if (scopeInfo.projectPath) {
          existingEntry.projectPath = scopeInfo.projectPath
        } else {
          delete existingEntry.projectPath
        }
        existingEntry.lastUpdated = now
        updatedCount++
        logForDebugging(
          `Updated ${pluginId} scope to ${scopeInfo.scope} (settings.json is source of truth)`,
        )
      }
    } else {
      // 插件不在 V2 中 —— 尝试通过 marketplace 查找并添加
      const { name: pluginName, marketplace } = parsePluginIdentifier(pluginId)

      if (!pluginName || !marketplace) {
        continue
      }

      try {
        logForDebugging(
          `Looking up plugin ${pluginId} in marketplace ${marketplace}`,
        )
        const pluginInfo = await getPluginById(pluginId)
        if (!pluginInfo) {
          logForDebugging(
            `Plugin ${pluginId} not found in any marketplace, skipping`,
          )
          continue
        }

        const { entry, marketplaceInstallLocation } = pluginInfo

        let installPath: string
        let version = 'unknown'
        let gitCommitSha: string | undefined

        if (typeof entry.source === 'string') {
          installPath = join(marketplaceInstallLocation, entry.source)
          version = getPluginVersionFromManifest(installPath, pluginId)
          gitCommitSha = await getGitCommitSha(installPath)
        } else {
          const cachePath = getPluginCachePath()
          const sanitizedName = pluginName.replace(/[^a-zA-Z0-9-_]/g, '-')
          const pluginCachePath = join(cachePath, sanitizedName)

          // 直接读取缓存目录 —— readdir 是第一个真实操作，而非预检查。
          // 其 ENOENT 表示缓存不存在；其结果控制下方的清单读取。
          // 不是 TOCTOU 问题 —— 下游操作优雅处理 ENOENT，
          // 因此竞争（readdir 和 read 之间目录被删除）会降级为
          // version='unknown'，而非崩溃。
          let dirEntries: string[]
          try {
            dirEntries = (
              await getFsImplementation().readdir(pluginCachePath)
            ).map(e => (typeof e === 'string' ? e : e.name))
          } catch (e) {
            if (!isENOENT(e)) throw e
            logForDebugging(
              `External plugin ${pluginId} not in cache, skipping`,
            )
            continue
          }

          installPath = pluginCachePath

          // 仅当 .claude-plugin 目录存在时才读取清单
          if (dirEntries.includes('.claude-plugin')) {
            version = getPluginVersionFromManifest(pluginCachePath, pluginId)
          }

          gitCommitSha = await getGitCommitSha(pluginCachePath)
        }

        if (version === 'unknown' && entry.version) {
          version = entry.version
        }
        if (version === 'unknown' && gitCommitSha) {
          version = gitCommitSha.substring(0, 12)
        }

        v2Plugins[pluginId] = [
          {
            scope: scopeInfo.scope,
            installPath: getVersionedCachePath(pluginId, version),
            version,
            installedAt: now,
            lastUpdated: now,
            gitCommitSha,
            ...(scopeInfo.projectPath && {
              projectPath: scopeInfo.projectPath,
            }),
          },
        ]

        addedCount++
        logForDebugging(`Added ${pluginId} with scope ${scopeInfo.scope}`)
      } catch (error) {
        logForDebugging(`Failed to add plugin ${pluginId}: ${error}`)
      }
    }
  }

  // 步骤 4：保存到单个文件（V2 格式）
  if (!fileExists || updatedCount > 0 || addedCount > 0) {
    const v2Data: InstalledPluginsFileV2 = { version: 2, plugins: v2Plugins }
    saveInstalledPluginsV2(v2Data)
    logForDebugging(
      `Sync completed: ${addedCount} added, ${updatedCount} updated in installed_plugins.json`,
    )
  }
}
