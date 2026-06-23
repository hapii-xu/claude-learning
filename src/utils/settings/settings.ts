import { feature } from 'bun:bundle'
import mergeWith from 'lodash-es/mergeWith.js'
import { dirname, join, resolve } from 'path'
import { z } from 'zod/v4'
import {
  getFlagSettingsInline,
  getFlagSettingsPath,
  getOriginalCwd,
  getUseCoworkPlugins,
} from '../../bootstrap/state.js'
import { getRemoteManagedSettingsSyncFromCache } from '../../services/remoteManagedSettings/syncCacheState.js'
import { uniq } from '../array.js'
import { logForDebugging } from '../debug.js'
import { logForDiagnosticsNoPII } from '../diagLogs.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from '../envUtils.js'
import { getErrnoCode, isENOENT } from '../errors.js'
import { writeFileSyncAndFlush_DEPRECATED } from '../file.js'
import { readFileSync } from '../fileRead.js'
import { getFsImplementation, safeResolvePath } from '../fsOperations.js'
import { addFileGlobRuleToGitignore } from '../git/gitignore.js'
import { safeParseJSON } from '../json.js'
import { logError } from '../log.js'
import { getPlatform } from '../platform.js'
import { clone, jsonStringify } from '../slowOperations.js'
import { profileCheckpoint } from '../startupProfiler.js'
import {
  type EditableSettingSource,
  getEnabledSettingSources,
  type SettingSource,
} from './constants.js'
import { markInternalWrite } from './internalWrites.js'
import {
  getManagedFilePath,
  getManagedSettingsDropInDir,
} from './managedPath.js'
import { getHkcuSettings, getMdmSettings } from './mdm/settings.js'
import {
  getCachedParsedFile,
  getCachedSettingsForSource,
  getPluginSettingsBase,
  getSessionSettingsCache,
  resetSettingsCache,
  setCachedParsedFile,
  setCachedSettingsForSource,
  setSessionSettingsCache,
} from './settingsCache.js'
import { type SettingsJson, SettingsSchema } from './types.js'
import { CLAUDE_DIR_NAME } from 'src/constants/claudeDirName.js'
import {
  filterInvalidPermissionRules,
  formatZodError,
  type SettingsWithErrors,
  type ValidationError,
} from './validation.js'

/**
 * 根据当前平台获取托管设置文件的路径
 */
function getManagedSettingsFilePath(): string {
  return join(getManagedFilePath(), 'managed-settings.json')
}

/**
 * 加载基于文件的托管设置：managed-settings.json + managed-settings.d/*.json。
 *
 * managed-settings.json 最先合并（最低优先级 / 基础），然后 drop-in
 * 文件按字母顺序排列并合并到上面（更高优先级，后面的文件胜出）。
 * 这遵循 systemd/sudoers 的 drop-in 约定：基础文件提供默认值，
 * drop-in 进行定制。不同的团队可以独立发布策略片段
 * （例如 10-otel.json、20-security.json），无需协调对单一管理员文件的修改。
 *
 * 导出用于测试。
 */
export function loadManagedFileSettings(): {
  settings: SettingsJson | null
  errors: ValidationError[]
} {
  const errors: ValidationError[] = []
  let merged: SettingsJson = {}
  let found = false

  const { settings, errors: baseErrors } = parseSettingsFile(
    getManagedSettingsFilePath(),
  )
  errors.push(...baseErrors)
  if (settings && Object.keys(settings).length > 0) {
    merged = mergeWith(merged, settings, settingsMergeCustomizer)
    found = true
  }

  const dropInDir = getManagedSettingsDropInDir()
  try {
    const entries = getFsImplementation()
      .readdirSync(dropInDir)
      .filter(
        d =>
          (d.isFile() || d.isSymbolicLink()) &&
          d.name.endsWith('.json') &&
          !d.name.startsWith('.'),
      )
      .map(d => d.name)
      .sort()
    for (const name of entries) {
      const { settings, errors: fileErrors } = parseSettingsFile(
        join(dropInDir, name),
      )
      errors.push(...fileErrors)
      if (settings && Object.keys(settings).length > 0) {
        merged = mergeWith(merged, settings, settingsMergeCustomizer)
        found = true
      }
    }
  } catch (e) {
    const code = getErrnoCode(e)
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      logError(e)
    }
  }

  return { settings: found ? merged : null, errors }
}

/**
 * 检查哪些基于文件的托管设置源存在。
 * 供 /status 命令使用，显示 "(file)"、"(drop-ins)" 或 "(file + drop-ins)"。
 */
export function getManagedFileSettingsPresence(): {
  hasBase: boolean
  hasDropIns: boolean
} {
  const { settings: base } = parseSettingsFile(getManagedSettingsFilePath())
  const hasBase = !!base && Object.keys(base).length > 0

  let hasDropIns = false
  const dropInDir = getManagedSettingsDropInDir()
  try {
    hasDropIns = getFsImplementation()
      .readdirSync(dropInDir)
      .some(
        d =>
          (d.isFile() || d.isSymbolicLink()) &&
          d.name.endsWith('.json') &&
          !d.name.startsWith('.'),
      )
  } catch {
    // 目录不存在
  }

  return { hasBase, hasDropIns }
}

/**
 * 处理文件系统错误
 * @param error 要处理的错误
 * @param path 引发错误的文件路径
 */
function handleFileSystemError(error: unknown, path: string): void {
  if (
    typeof error === 'object' &&
    error &&
    'code' in error &&
    error.code === 'ENOENT'
  ) {
    logForDebugging(
      `Broken symlink or missing file encountered for settings.json at path: ${path}`,
    )
  } else {
    logError(error)
  }
}

/**
 * 将设置文件解析为结构化格式
 * @param path 设置文件的路径
 * @param source 设置的来源（可选，用于错误报告）
 * @returns 解析后的设置数据和验证错误
 */
export function parseSettingsFile(path: string): {
  settings: SettingsJson | null
  errors: ValidationError[]
} {
  const cached = getCachedParsedFile(path)
  if (cached) {
    // 深拷贝，防止调用方（如 getSettingsForSourceUncached 中的 mergeWith、
    // updateSettingsForSource）修改缓存中的条目。
    return {
      settings: cached.settings ? clone(cached.settings) : null,
      errors: cached.errors,
    }
  }
  const result = parseSettingsFileUncached(path)
  setCachedParsedFile(path, result)
  // 首次返回也要深拷贝——调用方可能在另一个调用方读取同一缓存条目前修改它。
  return {
    settings: result.settings ? clone(result.settings) : null,
    errors: result.errors,
  }
}

function parseSettingsFileUncached(path: string): {
  settings: SettingsJson | null
  errors: ValidationError[]
} {
  try {
    const { resolvedPath } = safeResolvePath(getFsImplementation(), path)
    const content = readFileSync(resolvedPath)

    if (content.trim() === '') {
      return { settings: {}, errors: [] }
    }

    const data = safeParseJSON(content, false)

    // 在 schema 校验前过滤无效的权限规则，避免一条错误规则导致整个设置文件被拒绝。
    const ruleWarnings = filterInvalidPermissionRules(data, path)

    const result = SettingsSchema().safeParse(data)

    if (!result.success) {
      const errors = formatZodError(result.error, path)
      return { settings: null, errors: [...ruleWarnings, ...errors] }
    }

    return { settings: result.data, errors: ruleWarnings }
  } catch (error) {
    handleFileSystemError(error, path)
    return { settings: null, errors: [] }
  }
}

/**
 * 获取给定设置源关联的文件根目录的绝对路径
 * （例如，对于 $PROJ_DIR/.hclaude/settings.json，返回 $PROJ_DIR）
 * @param source 设置的来源
 * @returns 设置文件的根路径
 */
export function getSettingsRootPathForSource(source: SettingSource): string {
  switch (source) {
    case 'userSettings':
      return resolve(getClaudeConfigHomeDir())
    case 'policySettings':
    case 'projectSettings':
    case 'localSettings': {
      return resolve(getOriginalCwd())
    }
    case 'flagSettings': {
      const path = getFlagSettingsPath()
      return path ? dirname(resolve(path)) : resolve(getOriginalCwd())
    }
  }
}

/**
 * 根据 cowork 模式获取用户设置文件名。
 * cowork 模式下返回 'cowork_settings.json'，否则返回 'settings.json'。
 *
 * 优先级：
 * 1. 会话状态（由 CLI 参数 --cowork 设置）
 * 2. 环境变量 CLAUDE_CODE_USE_COWORK_PLUGINS
 * 3. 默认值：'settings.json'
 */
function getUserSettingsFilePath(): string {
  if (
    getUseCoworkPlugins() ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_COWORK_PLUGINS)
  ) {
    return 'cowork_settings.json'
  }
  return 'settings.json'
}

export function getSettingsFilePathForSource(
  source: SettingSource,
): string | undefined {
  switch (source) {
    case 'userSettings':
      return join(
        getSettingsRootPathForSource(source),
        getUserSettingsFilePath(),
      )
    case 'projectSettings':
    case 'localSettings': {
      return join(
        getSettingsRootPathForSource(source),
        getRelativeSettingsFilePathForSource(source),
      )
    }
    case 'policySettings':
      return getManagedSettingsFilePath()
    case 'flagSettings': {
      return getFlagSettingsPath()
    }
  }
}

export function getRelativeSettingsFilePathForSource(
  source: 'projectSettings' | 'localSettings',
): string {
  switch (source) {
    case 'projectSettings':
      return join(CLAUDE_DIR_NAME, 'settings.json')
    case 'localSettings':
      return join(CLAUDE_DIR_NAME, 'settings.local.json')
  }
}

export function getSettingsForSource(
  source: SettingSource,
): SettingsJson | null {
  const cached = getCachedSettingsForSource(source)
  if (cached !== undefined) return cached
  const result = getSettingsForSourceUncached(source)
  setCachedSettingsForSource(source, result)
  return result
}

function getSettingsForSourceUncached(
  source: SettingSource,
): SettingsJson | null {
  // policySettings 的处理：第一个源胜出（remote > HKLM/plist > file > HKCU）
  if (source === 'policySettings') {
    const remoteSettings = getRemoteManagedSettingsSyncFromCache()
    if (remoteSettings && Object.keys(remoteSettings).length > 0) {
      return remoteSettings
    }

    const mdmResult = getMdmSettings()
    if (Object.keys(mdmResult.settings).length > 0) {
      return mdmResult.settings
    }

    const { settings: fileSettings } = loadManagedFileSettings()
    if (fileSettings) {
      return fileSettings
    }

    const hkcu = getHkcuSettings()
    if (Object.keys(hkcu.settings).length > 0) {
      return hkcu.settings
    }

    return null
  }

  const settingsFilePath = getSettingsFilePathForSource(source)
  const { settings: fileSettings } = settingsFilePath
    ? parseSettingsFile(settingsFilePath)
    : { settings: null }

  // flagSettings 的处理：合并通过 SDK 设置的内联设置
  if (source === 'flagSettings') {
    const inlineSettings = getFlagSettingsInline()
    if (inlineSettings) {
      const parsed = SettingsSchema().safeParse(inlineSettings)
      if (parsed.success) {
        return mergeWith(
          fileSettings || {},
          parsed.data,
          settingsMergeCustomizer,
        ) as SettingsJson
      }
    }
  }

  return fileSettings
}

/**
 * 获取最高优先级的活跃策略设置源的来源。
 * 使用"第一个源胜出"策略——返回第一个有内容的源。
 * 优先级：remote > plist/hklm > file (managed-settings.json) > hkcu
 */
export function getPolicySettingsOrigin():
  | 'remote'
  | 'plist'
  | 'hklm'
  | 'file'
  | 'hkcu'
  | null {
  // 1. Remote（最高优先级）
  const remoteSettings = getRemoteManagedSettingsSyncFromCache()
  if (remoteSettings && Object.keys(remoteSettings).length > 0) {
    return 'remote'
  }

  // 2. 仅管理员的 MDM（HKLM / macOS plist）
  const mdmResult = getMdmSettings()
  if (Object.keys(mdmResult.settings).length > 0) {
    return getPlatform() === 'macos' ? 'plist' : 'hklm'
  }

  // 3. managed-settings.json + managed-settings.d/（基于文件，需要管理员权限）
  const { settings: fileSettings } = loadManagedFileSettings()
  if (fileSettings) {
    return 'file'
  }

  // 4. HKCU（最低优先级——用户可写）
  const hkcu = getHkcuSettings()
  if (Object.keys(hkcu.settings).length > 0) {
    return 'hkcu'
  }

  return null
}

/**
 * 使用 lodash mergeWith 将 `settings` 合并到 `source` 的现有设置中。
 *
 * 要从 record 字段中删除某个键（例如 enabledPlugins、extraKnownMarketplaces），
 * 将其设为 `undefined`——不要使用 `delete`。mergeWith 只在键以显式
 * `undefined` 值存在时才检测到删除操作。
 */
export function updateSettingsForSource(
  source: EditableSettingSource,
  settings: SettingsJson,
): { error: Error | null } {
  if (
    (source as unknown) === 'policySettings' ||
    (source as unknown) === 'flagSettings'
  ) {
    return { error: null }
  }

  // 必要时创建目录
  const filePath = getSettingsFilePathForSource(source)
  if (!filePath) {
    return { error: null }
  }

  try {
    getFsImplementation().mkdirSync(dirname(filePath))

    // 尝试获取现有设置并进行校验。绕过 per-source
    // 缓存——下面的 mergeWith 会修改其目标对象（包括嵌套引用），
    // 修改缓存对象会在写入失败时泄漏未持久化的状态
    // （在 resetSettingsCache() 之前）。
    let existingSettings = getSettingsForSourceUncached(source)

    // 如果校验失败，检查文件是否存在且有 JSON 语法错误
    if (!existingSettings) {
      let content: string | null = null
      try {
        content = readFileSync(filePath)
      } catch (e) {
        if (!isENOENT(e)) {
          throw e
        }
        // 文件不存在——继续与空设置合并
      }
      if (content !== null) {
        const rawData = safeParseJSON(content)
        if (rawData === null) {
          // JSON 语法错误 - 返回校验错误而不是覆盖
          // safeParseJSON 已经会记录错误，所以我们直接在这里返回错误
          return {
            error: new Error(
              `Invalid JSON syntax in settings file at ${filePath}`,
            ),
          }
        }
        if (rawData && typeof rawData === 'object') {
          existingSettings = rawData as SettingsJson
          logForDebugging(
            `Using raw settings from ${filePath} due to validation failure`,
          )
        }
      }
    }

    const updatedSettings = mergeWith(
      existingSettings || {},
      settings,
      (
        _objValue: unknown,
        srcValue: unknown,
        key: string | number | symbol,
        object: Record<string | number | symbol, unknown>,
      ) => {
        // 将 undefined 视为删除操作
        if (srcValue === undefined && object && typeof key === 'string') {
          delete object[key]
          return undefined
        }
        // 对于数组，始终用提供的数组替换
        // 这要求调用方计算期望的最终状态
        if (Array.isArray(srcValue)) {
          return srcValue
        }
        // 对于非数组，让 lodash 处理默认的合并行为
        return undefined
      },
    )

    // 在写入文件前标记为内部写入
    markInternalWrite(filePath)

    writeFileSyncAndFlush_DEPRECATED(
      filePath,
      jsonStringify(updatedSettings, null, 2) + '\n',
    )

    // 设置已更新，使会话缓存失效
    resetSettingsCache()

    if (source === 'localSettings') {
      // 可以异步添加到 gitignore，无需等待
      void addFileGlobRuleToGitignore(
        getRelativeSettingsFilePathForSource('localSettings'),
        getOriginalCwd(),
      )
    }
  } catch (e) {
    const error = new Error(
      `Failed to read raw settings from ${filePath}: ${e}`,
    )
    logError(error)
    return { error }
  }

  return { error: null }
}

/**
 * 数组的自定义合并函数 - 拼接并去重
 */
function mergeArrays<T>(targetArray: T[], sourceArray: T[]): T[] {
  return uniq([...targetArray, ...sourceArray])
}

/**
 * 合并设置时给 lodash mergeWith 使用的自定义合并函数。
 * 数组会被拼接并去重；其他值使用 lodash 默认的合并行为。
 * 导出用于测试。
 */
export function settingsMergeCustomizer(
  objValue: unknown,
  srcValue: unknown,
): unknown {
  if (Array.isArray(objValue) && Array.isArray(srcValue)) {
    return mergeArrays(objValue, srcValue)
  }
  // 返回 undefined 让 lodash 处理默认合并行为
  return undefined
}

/**
 * 获取托管设置中的设置键列表，用于日志记录。
 * 对于某些嵌套设置（permissions、sandbox、hooks），展开显示
 * 一层嵌套（例如 "permissions.allow"）。其他设置只返回顶层键。
 *
 * @param settings 要提取键的设置对象
 * @returns 排序后的键路径数组
 */
export function getManagedSettingsKeysForLogging(
  settings: SettingsJson,
): string[] {
  // 使用 .strip() 只获取有效的 schema 键
  const validSettings = SettingsSchema().strip().parse(settings) as Record<
    string,
    unknown
  >
  const keysToExpand = ['permissions', 'sandbox', 'hooks']
  const allKeys: string[] = []

  // 为每个要展开的嵌套设置定义有效的嵌套键
  const validNestedKeys: Record<string, Set<string>> = {
    permissions: new Set([
      'allow',
      'deny',
      'ask',
      'defaultMode',
      'disableBypassPermissionsMode',
      ...(feature('TRANSCRIPT_CLASSIFIER') ? ['disableAutoMode'] : []),
      'additionalDirectories',
    ]),
    sandbox: new Set([
      'enabled',
      'failIfUnavailable',
      'allowUnsandboxedCommands',
      'network',
      'filesystem',
      'ignoreViolations',
      'excludedCommands',
      'autoAllowBashIfSandboxed',
      'enableWeakerNestedSandbox',
      'enableWeakerNetworkIsolation',
      'ripgrep',
    ]),
    // hooks 使用 z.record 和枚举键，因此单独校验
    hooks: new Set([
      'PreToolUse',
      'PostToolUse',
      'Notification',
      'UserPromptSubmit',
      'SessionStart',
      'SessionEnd',
      'Stop',
      'SubagentStop',
      'PreCompact',
      'PostCompact',
      'TeammateIdle',
      'TaskCreated',
      'TaskCompleted',
    ]),
  }

  for (const key of Object.keys(validSettings)) {
    if (
      keysToExpand.includes(key) &&
      validSettings[key] &&
      typeof validSettings[key] === 'object'
    ) {
      // 为这些特殊设置展开嵌套键（仅一层深度）
      const nestedObj = validSettings[key] as Record<string, unknown>
      const validKeys = validNestedKeys[key]

      if (validKeys) {
        for (const nestedKey of Object.keys(nestedObj)) {
          // 只包含已知的有效嵌套键
          if (validKeys.has(nestedKey)) {
            allKeys.push(`${key}.${nestedKey}`)
          }
        }
      }
    } else {
      // 其他设置只使用顶层键
      allKeys.push(key)
    }
  }

  return allKeys.sort()
}

// 防止加载设置时无限递归的标志
let isLoadingSettings = false

/**
 * 从磁盘加载设置，不使用缓存
 * 这是实际从文件读取的原始实现
 */
function loadSettingsFromDisk(): SettingsWithErrors {
  // 防止递归调用 loadSettingsFromDisk
  if (isLoadingSettings) {
    return { settings: {}, errors: [] }
  }

  const startTime = Date.now()
  profileCheckpoint('loadSettingsFromDisk_start')
  logForDiagnosticsNoPII('info', 'settings_load_started')

  isLoadingSettings = true
  try {
    // 以插件设置作为最低优先级基础开始。
    // 所有基于文件的源（user、project、local、flag、policy）都会覆盖它们。
    // 插件设置只包含白名单允许的键（例如 agent），这些是有效的 SettingsJson 字段。
    const pluginSettings = getPluginSettingsBase()
    let mergedSettings: SettingsJson = {}
    if (pluginSettings) {
      mergedSettings = mergeWith(
        mergedSettings,
        pluginSettings,
        settingsMergeCustomizer,
      )
    }
    const allErrors: ValidationError[] = []
    const seenErrors = new Set<string>()
    const seenFiles = new Set<string>()

    // 按优先级顺序合并每个来源的设置，使用深度合并
    for (const source of getEnabledSettingSources()) {
      // policySettings 的处理："第一个源胜出"——使用有内容的最高优先级源。
      // 优先级：remote > HKLM/plist > managed-settings.json > HKCU
      if (source === 'policySettings') {
        let policySettings: SettingsJson | null = null
        const policyErrors: ValidationError[] = []

        // 1. Remote（最高优先级）
        const remoteSettings = getRemoteManagedSettingsSyncFromCache()
        if (remoteSettings && Object.keys(remoteSettings).length > 0) {
          const result = SettingsSchema().safeParse(remoteSettings)
          if (result.success) {
            policySettings = result.data
          } else {
            // Remote 存在但无效——即使在回退时也要暴露错误
            policyErrors.push(
              ...formatZodError(result.error, 'remote managed settings'),
            )
          }
        }

        // 2. 仅管理员的 MDM（HKLM / macOS plist）
        if (!policySettings) {
          const mdmResult = getMdmSettings()
          if (Object.keys(mdmResult.settings).length > 0) {
            policySettings = mdmResult.settings
          }
          policyErrors.push(...mdmResult.errors)
        }

        // 3. managed-settings.json + managed-settings.d/（基于文件，需要管理员权限）
        if (!policySettings) {
          const { settings, errors } = loadManagedFileSettings()
          if (settings) {
            policySettings = settings
          }
          policyErrors.push(...errors)
        }

        // 4. HKCU（最低优先级——用户可写，仅在上面都不存在时使用）
        if (!policySettings) {
          const hkcu = getHkcuSettings()
          if (Object.keys(hkcu.settings).length > 0) {
            policySettings = hkcu.settings
          }
          policyErrors.push(...hkcu.errors)
        }

        // 将胜出的策略源合并到设置链中
        if (policySettings) {
          mergedSettings = mergeWith(
            mergedSettings,
            policySettings,
            settingsMergeCustomizer,
          )
        }
        for (const error of policyErrors) {
          const errorKey = `${error.file}:${error.path}:${error.message}`
          if (!seenErrors.has(errorKey)) {
            seenErrors.add(errorKey)
            allErrors.push(error)
          }
        }

        continue
      }

      const filePath = getSettingsFilePathForSource(source)
      if (filePath) {
        const resolvedPath = resolve(filePath)

        // 如果已经从其他源加载过此文件则跳过
        if (!seenFiles.has(resolvedPath)) {
          seenFiles.add(resolvedPath)

          const { settings, errors } = parseSettingsFile(filePath)

          // 添加唯一的错误（去重）
          for (const error of errors) {
            const errorKey = `${error.file}:${error.path}:${error.message}`
            if (!seenErrors.has(errorKey)) {
              seenErrors.add(errorKey)
              allErrors.push(error)
            }
          }

          if (settings) {
            mergedSettings = mergeWith(
              mergedSettings,
              settings,
              settingsMergeCustomizer,
            )
          }
        }
      }

      // flagSettings 的处理：同时合并通过 SDK 设置的内联设置
      if (source === 'flagSettings') {
        const inlineSettings = getFlagSettingsInline()
        if (inlineSettings) {
          const parsed = SettingsSchema().safeParse(inlineSettings)
          if (parsed.success) {
            mergedSettings = mergeWith(
              mergedSettings,
              parsed.data,
              settingsMergeCustomizer,
            )
          }
        }
      }
    }

    logForDiagnosticsNoPII('info', 'settings_load_completed', {
      duration_ms: Date.now() - startTime,
      source_count: seenFiles.size,
      error_count: allErrors.length,
    })

    return { settings: mergedSettings, errors: allErrors }
  } finally {
    isLoadingSettings = false
  }
}

/**
 * 按优先级顺序获取所有来源的合并设置
 * 设置按从低到高的优先级合并：
 * userSettings -> projectSettings -> localSettings -> policySettings
 *
 * 此函数返回调用时设置的快照。
 * 对于 React 组件，推荐使用 useSettings() hook 以在磁盘上的
 * 设置更改时获得响应式更新。
 *
 * 使用会话级缓存以避免重复的文件 I/O。
 * 当设置文件通过 resetSettingsCache() 更改时缓存失效。
 *
 * @returns 所有可用来源的合并设置（始终至少返回空对象）
 */
export function getInitialSettings(): SettingsJson {
  const { settings } = getSettingsWithErrors()
  return settings || {}
}

/**
 * @deprecated 请使用 getInitialSettings() 代替。此别名仅为向后兼容而保留。
 */
export const getSettings_DEPRECATED = getInitialSettings

export type SettingsWithSources = {
  effective: SettingsJson
  /** 按从低到高的优先级排序——后面的条目覆盖前面的。 */
  sources: Array<{ source: SettingSource; settings: SettingsJson }>
}

/**
 * 获取有效的合并设置以及每个来源的原始设置，按合并优先级排序。
 * 仅包含已启用且有非空内容的来源。
 *
 * 始终从磁盘新鲜读取——重置会话缓存，以便即使变更检测器
 * 尚未触发，`effective` 和 `sources` 也保持一致。
 */
export function getSettingsWithSources(): SettingsWithSources {
  // 重置两个缓存，使 getSettingsForSource（per-source 缓存）和
  // getInitialSettings（会话缓存）对当前磁盘状态保持一致。
  resetSettingsCache()
  const sources: SettingsWithSources['sources'] = []
  for (const source of getEnabledSettingSources()) {
    const settings = getSettingsForSource(source)
    if (settings && Object.keys(settings).length > 0) {
      sources.push({ source, settings })
    }
  }
  return { effective: getInitialSettings(), sources }
}

/**
 * 获取所有来源的合并设置和校验错误
 * 此函数现在使用会话级缓存以避免重复的文件 I/O。
 * 设置更改需要重启 Claude Code，因此缓存在整个会话期间有效。
 * @returns 合并的设置和遇到的所有校验错误
 */
export function getSettingsWithErrors(): SettingsWithErrors {
  // 使用缓存的结果（如果有）
  const cached = getSessionSettingsCache()
  if (cached !== null) {
    return cached
  }

  // 从磁盘加载并缓存结果
  const result = loadSettingsFromDisk()
  profileCheckpoint('loadSettingsFromDisk_end')
  setSessionSettingsCache(result)
  return result
}

/**
 * 检查任何原始设置文件是否包含特定键，忽略校验结果。
 * 这用于在设置校验失败时检测用户意图。
 * 例如，如果用户设置了 cleanupPeriodDays 但在其他地方有校验错误，
 * 我们可以检测到他们明确配置了清理功能，跳过清理而不是回退到默认值。
 */
/**
 * 如果任何受信任的设置源已接受绕过权限模式对话框则返回 true。
 * 故意排除 projectSettings——否则恶意项目可以自动绕过对话框（RCE 风险）。
 */
export function hasSkipDangerousModePermissionPrompt(): boolean {
  return !!(
    getSettingsForSource('userSettings')?.skipDangerousModePermissionPrompt ||
    getSettingsForSource('localSettings')?.skipDangerousModePermissionPrompt ||
    getSettingsForSource('flagSettings')?.skipDangerousModePermissionPrompt ||
    getSettingsForSource('policySettings')?.skipDangerousModePermissionPrompt
  )
}

/**
 * 如果任何受信任的设置源已接受 auto 模式的 opt-in 对话框则返回 true。
 * 故意排除 projectSettings——否则恶意项目可以自动绕过对话框（RCE 风险）。
 */
export function hasAutoModeOptIn(): boolean {
  // Auto 模式对所有用户可用——无需 opt-in
  return true
}

/**
 * 返回 plan 模式是否应使用 auto 模式语义。默认为 true（opt-out）。
 * 如果任何受信任的源显式设置为 false 则返回 false。
 * 排除 projectSettings，防止恶意项目控制此设置。
 */
export function getUseAutoModeDuringPlan(): boolean {
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    return (
      getSettingsForSource('policySettings')?.useAutoModeDuringPlan !== false &&
      getSettingsForSource('flagSettings')?.useAutoModeDuringPlan !== false &&
      getSettingsForSource('userSettings')?.useAutoModeDuringPlan !== false &&
      getSettingsForSource('localSettings')?.useAutoModeDuringPlan !== false
    )
  }
  return true
}

/**
 * 返回受信任设置来源的合并 autoMode 配置。
 * 仅在 TRANSCRIPT_CLASSIFIER 激活时可用；否则返回 undefined。
 * 故意排除 projectSettings——否则恶意项目可以注入
 * 分类器的 allow/deny 规则（RCE 风险）。
 */
export function getAutoModeConfig():
  | { allow?: string[]; soft_deny?: string[]; environment?: string[] }
  | undefined {
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    const schema = z.object({
      allow: z.array(z.string()).optional(),
      soft_deny: z.array(z.string()).optional(),
      deny: z.array(z.string()).optional(),
      environment: z.array(z.string()).optional(),
    })

    const allow: string[] = []
    const soft_deny: string[] = []
    const environment: string[] = []

    for (const source of [
      'userSettings',
      'localSettings',
      'flagSettings',
      'policySettings',
    ] as const) {
      const settings = getSettingsForSource(source)
      if (!settings) continue
      const result = schema.safeParse(
        (settings as Record<string, unknown>).autoMode,
      )
      if (result.success) {
        if (result.data.allow) allow.push(...result.data.allow)
        if (result.data.soft_deny) soft_deny.push(...result.data.soft_deny)
        if (process.env.USER_TYPE === 'ant') {
          if (result.data.deny) soft_deny.push(...result.data.deny)
        }
        if (result.data.environment)
          environment.push(...result.data.environment)
      }
    }

    if (allow.length > 0 || soft_deny.length > 0 || environment.length > 0) {
      return {
        ...(allow.length > 0 && { allow }),
        ...(soft_deny.length > 0 && { soft_deny }),
        ...(environment.length > 0 && { environment }),
      }
    }
  }
  return undefined
}

export function rawSettingsContainsKey(key: string): boolean {
  for (const source of getEnabledSettingSources()) {
    // 跳过 policySettings——我们只关心用户配置的设置
    if (source === 'policySettings') {
      continue
    }

    const filePath = getSettingsFilePathForSource(source)
    if (!filePath) {
      continue
    }

    try {
      const { resolvedPath } = safeResolvePath(getFsImplementation(), filePath)
      const content = readFileSync(resolvedPath)
      if (!content.trim()) {
        continue
      }

      const rawData = safeParseJSON(content, false)
      if (rawData && typeof rawData === 'object' && key in rawData) {
        return true
      }
    } catch (error) {
      // 文件未找到是预期行为——并非所有设置文件都存在
      // 其他错误（权限、I/O）应被追踪
      handleFileSystemError(error, filePath)
    }
  }

  return false
}
