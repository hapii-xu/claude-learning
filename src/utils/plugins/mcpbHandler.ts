import type { McpbManifestAny as McpbManifest } from '@anthropic-ai/mcpb'
import axios from 'axios'
import { createHash } from 'crypto'
import { chmod, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import type { McpServerConfig } from '../../services/mcp/types.js'
import { logForDebugging } from '../debug.js'
import { parseAndValidateManifestFromBytes } from '../dxt/helpers.js'
import { parseZipModes, unzipFile } from '../dxt/zip.js'
import { errorMessage, getErrnoCode, isENOENT, toError } from '../errors.js'
import { getFsImplementation } from '../fsOperations.js'
import { logError } from '../log.js'
import { getSecureStorage } from '../secureStorage/index.js'
import {
  getSettings_DEPRECATED,
  updateSettingsForSource,
} from '../settings/settings.js'
import { jsonParse, jsonStringify } from '../slowOperations.js'
import { getSystemDirectories } from '../systemDirectories.js'
import { classifyFetchError, logPluginFetch } from './fetchTelemetry.js'

/** DXT / MCPB `user_config` 中单字段的 JSON Schema 式描述（校验见 `validateUserConfig`）。 */
export type McpbUserConfigurationOption = {
  type: 'string' | 'number' | 'boolean' | 'file' | 'directory' // 控件/校验类型
  required?: boolean // 是否必填
  title?: string // 表单标签（缺省用 key）
  description?: string // 帮助说明
  sensitive?: boolean // true 时写入安全存储而非明文 settings
  multiple?: boolean // string 类型时是否允许多值（数组）
  min?: number // 数值下限
  max?: number // 数值上限
}

/**
 * MCPB 的用户配置值
 */
export type UserConfigValues = Record<
  string,
  string | number | boolean | string[]
>

/**
 * 来自 DXT 清单的用户配置 schema
 */
export type UserConfigSchema = Record<string, McpbUserConfigurationOption>

/**
 * 加载 MCPB 文件的结果（成功情况）
 */
export type McpbLoadResult = {
  manifest: McpbManifest
  mcpConfig: McpServerConfig
  extractedPath: string
  contentHash: string
}

/**
 * MCPB 需要用户配置时的结果
 */
export type McpbNeedsConfigResult = {
  status: 'needs-config'
  manifest: McpbManifest
  extractedPath: string
  contentHash: string
  configSchema: UserConfigSchema
  existingConfig: UserConfigValues
  validationErrors: string[]
}

/**
 * 为每个缓存的 MCPB 存储的元数据
 */
export type McpbCacheMetadata = {
  source: string
  contentHash: string
  extractedPath: string
  cachedAt: string
  lastChecked: string
}

/**
 * 下载和提取操作的进度回调
 */
export type ProgressCallback = (status: string) => void

/**
 * 检查来源字符串是否为 MCPB 文件引用
 */
export function isMcpbSource(source: string): boolean {
  return source.endsWith('.mcpb') || source.endsWith('.dxt')
}

/**
 * 检查来源是否为 URL
 */
function isUrl(source: string): boolean {
  return source.startsWith('http://') || source.startsWith('https://')
}

/**
 * 为 MCPB 文件生成内容哈希
 */
function generateContentHash(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex').substring(0, 16)
}

/**
 * 获取 MCPB 文件的缓存目录
 */
function getMcpbCacheDir(pluginPath: string): string {
  return join(pluginPath, '.mcpb-cache')
}

/**
 * 获取缓存的 MCPB 的元数据文件路径
 */
function getMetadataPath(cacheDir: string, source: string): string {
  const sourceHash = createHash('md5')
    .update(source)
    .digest('hex')
    .substring(0, 8)
  return join(cacheDir, `${sourceHash}.metadata.json`)
}

/**
 * 组合每个服务器密钥桶的 secureStorage 键。
 * `pluginSecrets` 是一个扁平 map — 每个服务器的密钥使用 `${pluginId}/${server}`
 * 复合键与顶层插件选项（pluginOptionsStorage.ts）共享它。
 * `/` 不能出现在插件 ID（`name@marketplace`）或
 * 服务器名称（MCP 标识符约束）中，所以没有歧义。保持
 * SecureStorageData schema 不变，单个 keychain 条目大小
 * 预算（~2KB stdin 安全，见 INC-3028）在所有插件密钥间共享。
 */
function serverSecretsKey(pluginId: string, serverName: string): string {
  return `${pluginId}/${serverName}`
}

/**
 * 加载 MCP 服务器的用户配置，合并非敏感值
 * （来自 settings.json）与敏感值（来自 secureStorage keychain）。
 * 冲突时 secureStorage 优先 — schema 决定存储目的地，
 * 因此理论上不会冲突，但如果用户手动编辑 settings.json
 * 我们信任更安全的来源。
 *
 * 仅当两个来源都没有内容时返回 null — 调用者
 * 在该情况下跳过 ${user_config.X} 替换。
 *
 * @param pluginId - 格式为 "plugin@marketplace" 的插件标识符
 * @param serverName - DXT 清单中的 MCP 服务器名称
 */
export function loadMcpServerUserConfig(
  pluginId: string,
  serverName: string,
): UserConfigValues | null {
  try {
    const settings = getSettings_DEPRECATED()
    const nonSensitive =
      settings.pluginConfigs?.[pluginId]?.mcpServers?.[serverName]

    const sensitive =
      getSecureStorage().read()?.pluginSecrets?.[
        serverSecretsKey(pluginId, serverName)
      ]

    if (!nonSensitive && !sensitive) {
      return null
    }

    logForDebugging(
      `Loaded user config for ${pluginId}/${serverName} (settings + secureStorage)`,
    )
    return { ...nonSensitive, ...sensitive }
  } catch (error) {
    const errorObj = toError(error)
    logError(errorObj)
    logForDebugging(
      `Failed to load user config for ${pluginId}/${serverName}: ${error}`,
      { level: 'error' },
    )
    return null
  }
}

/**
 * 保存 MCP 服务器的用户配置，按 `schema[key].sensitive` 分拆。
 * 镜像 savePluginOptions（pluginOptionsStorage.ts:90）顶层选项的行为：
 *   - `sensitive: true` → secureStorage（macOS 上的 keychain，其他地方为 .credentials.json 0600）
 *   - 其他            → settings.json pluginConfigs[pluginId].mcpServers[serverName]
 *
 * 没有此分拆，per-channel `sensitive: true` 只是一种虚假的安全感
 * — 对话框掩盖了输入但保存仍然写入明文 settings.json。
 * H1 #3617646（Telegram/Discord bot token 出现在全局可读的 .env 中）
 * 暴露了这一待修复的缺口。
 *
 * 若该类别中没有内容则跳过写入。
 *
 * @param pluginId - 格式为 "plugin@marketplace" 的插件标识符
 * @param serverName - DXT 清单中的 MCP 服务器名称
 * @param config - 用户配置值
 * @param schema - 此服务器的 userConfig schema（manifest.user_config
 *   或 channels[].userConfig）— 驱动敏感/非敏感分拆
 */
export function saveMcpServerUserConfig(
  pluginId: string,
  serverName: string,
  config: UserConfigValues,
  schema: UserConfigSchema,
): void {
  try {
    const nonSensitive: UserConfigValues = {}
    const sensitive: Record<string, string> = {}

    for (const [key, value] of Object.entries(config)) {
      if (schema[key]?.sensitive === true) {
        sensitive[key] = String(value)
      } else {
        nonSensitive[key] = value
      }
    }

    // 仅清除此次调用中正在写入的键。覆盖跨 schema 版本切换的两个方向：
    //  - sensitive→secureStorage ⇒ 从 settings.json 中移除过时的明文
    //  - nonSensitive→settings.json ⇒ 从 secureStorage 中移除过时条目
    //    （否则 loadMcpServerUserConfig 的 {...nonSensitive, ...sensitive}
    //    会让过时的 secureStorage 值在下次读取时优先）
    // 部分 `config`（用户只重新输入一个字段）使两个存储中的
    // 其他字段保持不变 — 对未来调用者的深度防御。
    const sensitiveKeysInThisSave = new Set(Object.keys(sensitive))
    const nonSensitiveKeysInThisSave = new Set(Object.keys(nonSensitive))

    // 敏感值 → secureStorage 优先。若失败（keychain 已锁、
    // .credentials.json 权限问题），在修改 settings.json 之前抛出 —
    // 旧的明文作为后备保留，而不是丢失两份副本。
    //
    // 同时从 secureStorage 清除非敏感键 — schema 将
    // sensitive 翻转为 false，它们现在要写入 settings.json。如果不这么做，
    // loadMcpServerUserConfig 的合并会让过时的 secureStorage
    // 值在下次读取时优先。
    const storage = getSecureStorage()
    const k = serverSecretsKey(pluginId, serverName)
    const existingInSecureStorage =
      storage.read()?.pluginSecrets?.[k] ?? undefined
    const secureScrubbed = existingInSecureStorage
      ? Object.fromEntries(
          Object.entries(existingInSecureStorage).filter(
            ([key]) => !nonSensitiveKeysInThisSave.has(key),
          ),
        )
      : undefined
    const needSecureScrub =
      secureScrubbed &&
      existingInSecureStorage &&
      Object.keys(secureScrubbed).length !==
        Object.keys(existingInSecureStorage).length
    if (Object.keys(sensitive).length > 0 || needSecureScrub) {
      const existing = storage.read() ?? {}
      if (!existing.pluginSecrets) {
        existing.pluginSecrets = {}
      }
      // secureStorage keyvault 是扁平对象 — 直接替换，无需关心合并
      // 语义（不同于 settings.json 的 mergeWith）。
      existing.pluginSecrets[k] = {
        ...secureScrubbed,
        ...sensitive,
      }
      const result = storage.update(existing)
      if (!result.success) {
        throw new Error(
          `Failed to save sensitive config to secure storage for ${k}`,
        )
      }
      if (result.warning) {
        logForDebugging(`Server secrets save warning: ${result.warning}`, {
          level: 'warn',
        })
      }
      if (needSecureScrub) {
        logForDebugging(
          `saveMcpServerUserConfig: scrubbed ${
            Object.keys(existingInSecureStorage!).length -
            Object.keys(secureScrubbed!).length
          } stale non-sensitive key(s) from secureStorage for ${k}`,
        )
      }
    }

    // 非敏感值 → settings.json。在有新的非敏感值或需要
    // 清除现有明文敏感值时写入 — 以便重新配置仅含
    // 敏感字段的 schema 时仍能清理旧 settings.json。在
    // secureStorage 写入成功后运行，确保清除不会让你
    // 一份密钥副本都没有。
    //
    // updateSettingsForSource 执行 mergeWith(diskSettings, ourSettings, ...)，
    // 该操作会保留目标中来源没有的键 — 所以简单地省略
    // 敏感键无法清除它们，磁盘副本会合并回来。作为替代：
    // 将每个敏感键设为显式 `undefined` — mergeWith（搭配
    // settings.ts:349 处的自定义器）将显式 undefined 视为删除。
    const settings = getSettings_DEPRECATED()
    const existingInSettings =
      settings.pluginConfigs?.[pluginId]?.mcpServers?.[serverName] ?? {}
    const keysToScrubFromSettings = Object.keys(existingInSettings).filter(k =>
      sensitiveKeysInThisSave.has(k),
    )
    if (
      Object.keys(nonSensitive).length > 0 ||
      keysToScrubFromSettings.length > 0
    ) {
      if (!settings.pluginConfigs) {
        settings.pluginConfigs = {}
      }
      if (!settings.pluginConfigs[pluginId]) {
        settings.pluginConfigs[pluginId] = {}
      }
      if (!settings.pluginConfigs[pluginId].mcpServers) {
        settings.pluginConfigs[pluginId].mcpServers = {}
      }
      // 构建通过 undefined 清除的 map。UserConfigValues 类型不
      // 包含 undefined，但 updateSettingsForSource 的 mergeWith 自定义器
      // 需要显式 undefined 才能删除 — 此处的类型转换是有意为之的内部
      // 管道（与 pluginOptionsStorage.ts:184 中 deletePluginOptions 的
      // 理由相同，见 CLAUDE.md 的 10% case）。
      const scrubbed = Object.fromEntries(
        keysToScrubFromSettings.map(k => [k, undefined]),
      ) as Record<string, undefined>
      settings.pluginConfigs[pluginId].mcpServers![serverName] = {
        ...nonSensitive,
        ...scrubbed,
      } as UserConfigValues
      const result = updateSettingsForSource('userSettings', settings)
      if (result.error) {
        throw result.error
      }
      if (keysToScrubFromSettings.length > 0) {
        logForDebugging(
          `saveMcpServerUserConfig: scrubbed ${keysToScrubFromSettings.length} plaintext sensitive key(s) from settings.json for ${pluginId}/${serverName}`,
        )
      }
    }

    logForDebugging(
      `Saved user config for ${pluginId}/${serverName} (${Object.keys(nonSensitive).length} non-sensitive, ${Object.keys(sensitive).length} sensitive)`,
    )
  } catch (error) {
    const errorObj = toError(error)
    logError(errorObj)
    throw new Error(
      `Failed to save user configuration for ${pluginId}/${serverName}: ${errorObj.message}`,
    )
  }
}

/**
 * 根据 DXT user_config schema 校验用户配置值
 */
export function validateUserConfig(
  values: UserConfigValues,
  schema: UserConfigSchema,
): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  // 检查 schema 中的每个字段
  for (const [key, fieldSchema] of Object.entries(schema)) {
    const value = values[key]

    // 检查必填字段
    if (fieldSchema.required && (value === undefined || value === '')) {
      errors.push(`${fieldSchema.title || key} is required but not provided`)
      continue
    }

    // 跳过未提供值的可选字段
    if (value === undefined || value === '') {
      continue
    }

    // 类型校验
    if (fieldSchema.type === 'string') {
      if (Array.isArray(value)) {
        // multiple: true 时允许字符串数组
        if (!fieldSchema.multiple) {
          errors.push(
            `${fieldSchema.title || key} must be a string, not an array`,
          )
        } else if (!value.every(v => typeof v === 'string')) {
          errors.push(`${fieldSchema.title || key} must be an array of strings`)
        }
      } else if (typeof value !== 'string') {
        errors.push(`${fieldSchema.title || key} must be a string`)
      }
    } else if (fieldSchema.type === 'number' && typeof value !== 'number') {
      errors.push(`${fieldSchema.title || key} must be a number`)
    } else if (fieldSchema.type === 'boolean' && typeof value !== 'boolean') {
      errors.push(`${fieldSchema.title || key} must be a boolean`)
    } else if (
      (fieldSchema.type === 'file' || fieldSchema.type === 'directory') &&
      typeof value !== 'string'
    ) {
      errors.push(`${fieldSchema.title || key} must be a path string`)
    }

    // 数值范围校验
    if (fieldSchema.type === 'number' && typeof value === 'number') {
      if (fieldSchema.min !== undefined && value < fieldSchema.min) {
        errors.push(
          `${fieldSchema.title || key} must be at least ${fieldSchema.min}`,
        )
      }
      if (fieldSchema.max !== undefined && value > fieldSchema.max) {
        errors.push(
          `${fieldSchema.title || key} must be at most ${fieldSchema.max}`,
        )
      }
    }
  }

  return { valid: errors.length === 0, errors }
}

/**
 * 从 DXT 清单生成 MCP 服务器配置
 */
async function generateMcpConfig(
  manifest: McpbManifest,
  extractedPath: string,
  userConfig: UserConfigValues = {},
): Promise<McpServerConfig> {
  // 懒导入：@anthropic-ai/mcpb barrel 引入 zod v3 schemas（~700KB
  // 绑定闭包）。详见 dxt/helpers.ts。
  const { getMcpConfigForManifest } = await import('@anthropic-ai/mcpb')
  const mcpConfig = await getMcpConfigForManifest({
    manifest,
    extensionPath: extractedPath,
    systemDirs: getSystemDirectories(),
    userConfig,
    pathSeparator: '/',
  })

  if (!mcpConfig) {
    const error = new Error(
      `Failed to generate MCP server configuration from manifest "${manifest.name}"`,
    )
    logError(error)
    throw error
  }

  return mcpConfig as McpServerConfig
}

/**
 * 加载 MCPB 来源的缓存元数据
 */
async function loadCacheMetadata(
  cacheDir: string,
  source: string,
): Promise<McpbCacheMetadata | null> {
  const fs = getFsImplementation()
  const metadataPath = getMetadataPath(cacheDir, source)

  try {
    const content = await fs.readFile(metadataPath, { encoding: 'utf-8' })
    return jsonParse(content) as McpbCacheMetadata
  } catch (error) {
    const code = getErrnoCode(error)
    if (code === 'ENOENT') return null
    const errorObj = toError(error)
    logError(errorObj)
    logForDebugging(`Failed to load MCPB cache metadata: ${error}`, {
      level: 'error',
    })
    return null
  }
}

/**
 * 保存 MCPB 来源的缓存元数据
 */
async function saveCacheMetadata(
  cacheDir: string,
  source: string,
  metadata: McpbCacheMetadata,
): Promise<void> {
  const metadataPath = getMetadataPath(cacheDir, source)

  await getFsImplementation().mkdir(cacheDir)
  await writeFile(metadataPath, jsonStringify(metadata, null, 2), 'utf-8')
}

/**
 * 从 URL 下载 MCPB 文件
 */
async function downloadMcpb(
  url: string,
  destPath: string,
  onProgress?: ProgressCallback,
): Promise<Uint8Array> {
  logForDebugging(`Downloading MCPB from ${url}`)
  if (onProgress) {
    onProgress(`Downloading ${url}...`)
  }

  const started = performance.now()
  let fetchTelemetryFired = false
  try {
    const response = await axios.get(url, {
      timeout: 120000, // 2 分钟超时
      responseType: 'arraybuffer',
      maxRedirects: 5, // 跟随重定向（类似 curl -L）
      onDownloadProgress: progressEvent => {
        if (progressEvent.total && onProgress) {
          const percent = Math.round(
            (progressEvent.loaded / progressEvent.total) * 100,
          )
          onProgress(`Downloading... ${percent}%`)
        }
      },
    })

    const data = new Uint8Array(response.data)
    // 在 writeFile 之前触发遥测 — 该事件度量网络
    // 获取，而非磁盘 I/O。否则 writeFile 的 EACCES 会匹配
    // classifyFetchError 的 /permission denied/ → 误报为认证问题。
    logPluginFetch('mcpb', url, 'success', performance.now() - started)
    fetchTelemetryFired = true

    // 保存到磁盘（二进制数据）
    await writeFile(destPath, Buffer.from(data))

    logForDebugging(`Downloaded ${data.length} bytes to ${destPath}`)
    if (onProgress) {
      onProgress('Download complete')
    }

    return data
  } catch (error) {
    if (!fetchTelemetryFired) {
      logPluginFetch(
        'mcpb',
        url,
        'failure',
        performance.now() - started,
        classifyFetchError(error),
      )
    }
    const errorMsg = errorMessage(error)
    const fullError = new Error(
      `Failed to download MCPB file from ${url}: ${errorMsg}`,
    )
    logError(fullError)
    throw fullError
  }
}

/**
 * 提取 MCPB 文件并将内容写入提取目录。
 *
 * @param modes - 来自 `parseZipModes` 的 name→mode 映射。MCPB 包可能
 *   包含原生 MCP 服务器二进制文件，因此保留执行位很重要。
 */
async function extractMcpbContents(
  unzipped: Record<string, Uint8Array>,
  extractPath: string,
  modes: Record<string, number>,
  onProgress?: ProgressCallback,
): Promise<void> {
  if (onProgress) {
    onProgress('Extracting files...')
  }

  // 创建提取目录
  await getFsImplementation().mkdir(extractPath)

  // 写入所有文件。从计数中过滤目录条目，以便进度
  // 消息使用与 filesWritten（跳过目录条目）相同的分母。
  let filesWritten = 0
  const entries = Object.entries(unzipped).filter(([k]) => !k.endsWith('/'))
  const totalFiles = entries.length

  for (const [filePath, fileData] of entries) {
    // 目录条目（zip -r、Python zipfile、Java ZipOutputStream 中常见）
    // 在上面已过滤 — writeFile 会将 `bin/` 创建为空普通
    // 文件，然后 `bin/server` 的 mkdir 会因 ENOTDIR 失败。
    // 下面的 mkdir(dirname(fullPath)) 隐式创建父目录。

    const fullPath = join(extractPath, filePath)
    const dir = dirname(fullPath)

    // 确保目录存在（recursive 处理已存在的情况）
    if (dir !== extractPath) {
      await getFsImplementation().mkdir(dir)
    }

    // 判断是文本还是二进制
    const isTextFile =
      filePath.endsWith('.json') ||
      filePath.endsWith('.js') ||
      filePath.endsWith('.ts') ||
      filePath.endsWith('.txt') ||
      filePath.endsWith('.md') ||
      filePath.endsWith('.yml') ||
      filePath.endsWith('.yaml')

    if (isTextFile) {
      const content = new TextDecoder().decode(fileData)
      await writeFile(fullPath, content, 'utf-8')
    } else {
      await writeFile(fullPath, Buffer.from(fileData))
    }

    const mode = modes[filePath]
    if (mode && mode & 0o111) {
      // 吞掉 EPERM/ENOTSUP（NFS root_squash、某些 FUSE 挂载）— 丢失 +x
      // 是此 PR 之前的行为，比在提取中途中止要好。
      await chmod(fullPath, mode & 0o777).catch(() => {})
    }

    filesWritten++
    if (onProgress && filesWritten % 10 === 0) {
      onProgress(`Extracted ${filesWritten}/${totalFiles} files`)
    }
  }

  logForDebugging(`Extracted ${filesWritten} files to ${extractPath}`)
  if (onProgress) {
    onProgress(`Extraction complete (${filesWritten} files)`)
  }
}

/**
 * 检查 MCPB 来源是否已变更并需要重新提取
 */
export async function checkMcpbChanged(
  source: string,
  pluginPath: string,
): Promise<boolean> {
  const fs = getFsImplementation()
  const cacheDir = getMcpbCacheDir(pluginPath)
  const metadata = await loadCacheMetadata(cacheDir, source)

  if (!metadata) {
    // 没有缓存元数据，需要加载
    return true
  }

  // 检查提取目录是否仍然存在
  try {
    await fs.stat(metadata.extractedPath)
  } catch (error) {
    const code = getErrnoCode(error)
    if (code === 'ENOENT') {
      logForDebugging(`MCPB extraction path missing: ${metadata.extractedPath}`)
    } else {
      logForDebugging(
        `MCPB extraction path inaccessible: ${metadata.extractedPath}: ${error}`,
        { level: 'error' },
      )
    }
    return true
  }

  // 对于本地文件，检查 mtime
  if (!isUrl(source)) {
    const localPath = join(pluginPath, source)
    let stats
    try {
      stats = await fs.stat(localPath)
    } catch (error) {
      const code = getErrnoCode(error)
      if (code === 'ENOENT') {
        logForDebugging(`MCPB source file missing: ${localPath}`)
      } else {
        logForDebugging(
          `MCPB source file inaccessible: ${localPath}: ${error}`,
          { level: 'error' },
        )
      }
      return true
    }

    const cachedTime = new Date(metadata.cachedAt).getTime()
    // 取整以匹配 cachedAt 的毫秒精度（ISO 字符串）。mtimeMs 的亚毫秒
    // 精度会让刚缓存的文件在两者发生于同一毫秒时看起来比
    // 自身的缓存时间戳"更新"。
    const fileTime = Math.floor(stats.mtimeMs)

    if (fileTime > cachedTime) {
      logForDebugging(
        `MCPB file modified: ${new Date(fileTime)} > ${new Date(cachedTime)}`,
      )
      return true
    }
  }

  // 对于 URL，在显式更新时重新检查（在其他地方处理）
  return false
}

/**
 * 加载并提取 MCPB 文件，支持缓存和用户配置
 *
 * @param source - MCPB 文件路径或 URL
 * @param pluginPath - 插件目录路径
 * @param pluginId - 格式为 "plugin@marketplace" 的插件标识符（用于配置存储）
 * @param onProgress - 进度回调
 * @param providedUserConfig - 用户配置值（用于初次设置或重新配置）
 * @returns 成功时返回 MCP 配置，或返回带 schema 的 needs-config 状态
 */
export async function loadMcpbFile(
  source: string,
  pluginPath: string,
  pluginId: string,
  onProgress?: ProgressCallback,
  providedUserConfig?: UserConfigValues,
  forceConfigDialog?: boolean,
): Promise<McpbLoadResult | McpbNeedsConfigResult> {
  const fs = getFsImplementation()
  const cacheDir = getMcpbCacheDir(pluginPath)
  await fs.mkdir(cacheDir)

  logForDebugging(`Loading MCPB from source: ${source}`)

  // 优先检查缓存
  const metadata = await loadCacheMetadata(cacheDir, source)
  if (metadata && !(await checkMcpbChanged(source, pluginPath))) {
    logForDebugging(
      `Using cached MCPB from ${metadata.extractedPath} (hash: ${metadata.contentHash})`,
    )

    // 从缓存加载清单
    const manifestPath = join(metadata.extractedPath, 'manifest.json')
    let manifestContent: string
    try {
      manifestContent = await fs.readFile(manifestPath, { encoding: 'utf-8' })
    } catch (error) {
      if (isENOENT(error)) {
        const err = new Error(`Cached manifest not found: ${manifestPath}`)
        logError(err)
        throw err
      }
      throw error
    }

    const manifestData = new TextEncoder().encode(manifestContent)
    const manifest = await parseAndValidateManifestFromBytes(manifestData)

    // 检查 user_config 需求
    if (manifest.user_config && Object.keys(manifest.user_config).length > 0) {
      // DXT 清单中的服务器名称
      const serverName = manifest.name

      // 尝试从 settings.json 加载已有配置，或使用提供的配置
      const savedConfig = loadMcpServerUserConfig(pluginId, serverName)
      const userConfig = providedUserConfig || savedConfig || {}

      // 校验所有必填字段
      const validation = validateUserConfig(userConfig, manifest.user_config)

      // 在以下情况返回 needs-config：强制（重新配置）或校验失败
      if (forceConfigDialog || !validation.valid) {
        return {
          status: 'needs-config',
          manifest,
          extractedPath: metadata.extractedPath,
          contentHash: metadata.contentHash,
          configSchema: manifest.user_config,
          existingConfig: savedConfig || {},
          validationErrors: validation.valid ? [] : validation.errors,
        }
      }

      // 若提供了配置则保存（初次设置或重新配置）
      if (providedUserConfig) {
        saveMcpServerUserConfig(
          pluginId,
          serverName,
          providedUserConfig,
          manifest.user_config ?? {},
        )
      }

      // 使用用户配置生成 MCP 配置
      const mcpConfig = await generateMcpConfig(
        manifest,
        metadata.extractedPath,
        userConfig,
      )

      return {
        manifest,
        mcpConfig,
        extractedPath: metadata.extractedPath,
        contentHash: metadata.contentHash,
      }
    }

    // 不需要 user_config — 不带配置生成
    const mcpConfig = await generateMcpConfig(manifest, metadata.extractedPath)

    return {
      manifest,
      mcpConfig,
      extractedPath: metadata.extractedPath,
      contentHash: metadata.contentHash,
    }
  }

  // 未缓存或已变更 — 需要下载/加载并提取
  let mcpbData: Uint8Array
  let mcpbFilePath: string

  if (isUrl(source)) {
    // 从 URL 下载
    const sourceHash = createHash('md5')
      .update(source)
      .digest('hex')
      .substring(0, 8)
    mcpbFilePath = join(cacheDir, `${sourceHash}.mcpb`)
    mcpbData = await downloadMcpb(source, mcpbFilePath, onProgress)
  } else {
    // 从本地路径加载
    const localPath = join(pluginPath, source)

    if (onProgress) {
      onProgress(`Loading ${source}...`)
    }

    try {
      mcpbData = await fs.readFileBytes(localPath)
      mcpbFilePath = localPath
    } catch (error) {
      if (isENOENT(error)) {
        const err = new Error(`MCPB file not found: ${localPath}`)
        logError(err)
        throw err
      }
      throw error
    }
  }

  // 生成内容哈希
  const contentHash = generateContentHash(mcpbData)
  logForDebugging(`MCPB content hash: ${contentHash}`)

  // 提取 ZIP
  if (onProgress) {
    onProgress('Extracting MCPB archive...')
  }

  const unzipped = await unzipFile(Buffer.from(mcpbData))
  // fflate 不暴露 external_attr — 解析中央目录以便
  // 原生 MCP 服务器二进制文件在提取后保留执行位。
  const modes = parseZipModes(mcpbData)

  // 检查 manifest.json
  const manifestData = unzipped['manifest.json']
  if (!manifestData) {
    const error = new Error('No manifest.json found in MCPB file')
    logError(error)
    throw error
  }

  // 解析并校验清单
  const manifest = await parseAndValidateManifestFromBytes(manifestData)
  logForDebugging(
    `MCPB manifest: ${manifest.name} v${manifest.version} by ${manifest.author.name}`,
  )

  // 检查清单是否有服务器配置
  if (!manifest.server) {
    const error = new Error(
      `MCPB manifest for "${manifest.name}" does not define a server configuration`,
    )
    logError(error)
    throw error
  }

  // 提取到缓存目录
  const extractPath = join(cacheDir, contentHash)
  await extractMcpbContents(unzipped, extractPath, modes, onProgress)

  // 检查 user_config 需求
  if (manifest.user_config && Object.keys(manifest.user_config).length > 0) {
    // DXT 清单中的服务器名称
    const serverName = manifest.name

    // 尝试从 settings.json 加载已有配置，或使用提供的配置
    const savedConfig = loadMcpServerUserConfig(pluginId, serverName)
    const userConfig = providedUserConfig || savedConfig || {}

    // 校验所有必填字段
    const validation = validateUserConfig(userConfig, manifest.user_config)

    if (!validation.valid) {
      // 即使配置不完整也保存缓存元数据
      const newMetadata: McpbCacheMetadata = {
        source,
        contentHash,
        extractedPath: extractPath,
        cachedAt: new Date().toISOString(),
        lastChecked: new Date().toISOString(),
      }
      await saveCacheMetadata(cacheDir, source, newMetadata)

      // 返回"需要配置"状态
      return {
        status: 'needs-config',
        manifest,
        extractedPath: extractPath,
        contentHash,
        configSchema: manifest.user_config,
        existingConfig: savedConfig || {},
        validationErrors: validation.errors,
      }
    }

    // 若提供了配置则保存（初次设置或重新配置）
    if (providedUserConfig) {
      saveMcpServerUserConfig(
        pluginId,
        serverName,
        providedUserConfig,
        manifest.user_config ?? {},
      )
    }

    // 使用用户配置生成 MCP 配置
    if (onProgress) {
      onProgress('Generating MCP server configuration...')
    }

    const mcpConfig = await generateMcpConfig(manifest, extractPath, userConfig)

    // 保存缓存元数据
    const newMetadata: McpbCacheMetadata = {
      source,
      contentHash,
      extractedPath: extractPath,
      cachedAt: new Date().toISOString(),
      lastChecked: new Date().toISOString(),
    }
    await saveCacheMetadata(cacheDir, source, newMetadata)

    return {
      manifest,
      mcpConfig,
      extractedPath: extractPath,
      contentHash,
    }
  }

  // 不需要 user_config — 不带配置生成
  if (onProgress) {
    onProgress('Generating MCP server configuration...')
  }

  const mcpConfig = await generateMcpConfig(manifest, extractPath)

  // 保存缓存元数据
  const newMetadata: McpbCacheMetadata = {
    source,
    contentHash,
    extractedPath: extractPath,
    cachedAt: new Date().toISOString(),
    lastChecked: new Date().toISOString(),
  }
  await saveCacheMetadata(cacheDir, source, newMetadata)

  logForDebugging(
    `Successfully loaded MCPB: ${manifest.name} (extracted to ${extractPath})`,
  )

  return {
    manifest,
    mcpConfig: mcpConfig as McpServerConfig,
    extractedPath: extractPath,
    contentHash,
  }
}
