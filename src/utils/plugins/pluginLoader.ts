/**
 * 插件加载器模块
 *
 * 本模块负责从多种来源（包括 marketplace 和 git 仓库）发现、加载和校验 Claude Code 插件。
 *
 * NPM 包也受支持，但必须通过 marketplace 引用——marketplace 条目中包含 NPM 包信息。
 *
 * 插件发现来源（按优先级排序）：
 * 1. 基于 marketplace 的插件（settings 中的 plugin@marketplace 格式）
 * 2. 仅会话插件（来自 --plugin-dir CLI 标志或 SDK plugins 选项）
 *
 * 插件目录结构：
 * ```
 * my-plugin/
 * ├── plugin.json          # 可选的元数据清单
 * ├── commands/            # 自定义斜杠命令
 * │   ├── build.md
 * │   └── deploy.md
 * ├── agents/              # 自定义 AI 代理
 * │   └── test-runner.md
 * └── hooks/               # Hook 配置
 *     └── hooks.json       # Hook 定义
 * ```
 *
 * 加载器处理：
 * - 插件清单校验
 * - Hook 配置加载与变量解析
 * - 重复名称检测
 * - 启用/禁用状态管理
 * - 错误收集与报告
 */

import {
  copyFile,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
} from 'fs/promises'
import memoize from 'lodash-es/memoize.js'
import { basename, dirname, join, relative, resolve, sep } from 'path'
import { getInlinePlugins } from '../../bootstrap/state.js'
import {
  BUILTIN_MARKETPLACE_NAME,
  getBuiltinPlugins,
} from '../../plugins/builtinPlugins.js'
import type {
  LoadedPlugin,
  PluginComponent,
  PluginError,
  PluginLoadResult,
  PluginManifest,
} from '../../types/plugin.js'
import { logForDebugging } from '../debug.js'
import { isEnvTruthy } from '../envUtils.js'
import {
  errorMessage,
  getErrnoPath,
  isENOENT,
  isFsInaccessible,
  toError,
} from '../errors.js'
import { execFileNoThrow, execFileNoThrowWithCwd } from '../execFileNoThrow.js'
import { pathExists } from '../file.js'
import { getFsImplementation } from '../fsOperations.js'
import { gitExe } from '../git.js'
import { lazySchema } from '../lazySchema.js'
import { logError } from '../log.js'
import { getSettings_DEPRECATED } from '../settings/settings.js'
import {
  clearPluginSettingsBase,
  getPluginSettingsBase,
  resetSettingsCache,
  setPluginSettingsBase,
} from '../settings/settingsCache.js'
import type { HooksSettings } from '../settings/types.js'
import type { HookMatcher } from '../../schemas/hooks.js'
import { SettingsSchema } from '../settings/types.js'
import { jsonParse, jsonStringify } from '../slowOperations.js'
import { getAddDirEnabledPlugins } from './addDirPluginSettings.js'
import { verifyAndDemote } from './dependencyResolver.js'
import { classifyFetchError, logPluginFetch } from './fetchTelemetry.js'
import { checkGitAvailable } from './gitAvailability.js'
import { getInMemoryInstalledPlugins } from './installedPluginsManager.js'
import { getManagedPluginNames } from './managedPlugins.js'
import {
  formatSourceForDisplay,
  getBlockedMarketplaces,
  getStrictKnownMarketplaces,
  isSourceAllowedByPolicy,
  isSourceInBlocklist,
} from './marketplaceHelpers.js'
import {
  getMarketplaceCacheOnly,
  getPluginByIdCacheOnly,
  loadKnownMarketplacesConfigSafe,
} from './marketplaceManager.js'
import { getPluginSeedDirs, getPluginsDirectory } from './pluginDirectories.js'
import { parsePluginIdentifier } from './pluginIdentifier.js'
import { validatePathWithinBase } from './pluginInstallationHelpers.js'
import { calculatePluginVersion } from './pluginVersioning.js'
import {
  type CommandMetadata,
  PluginHooksSchema,
  PluginIdSchema,
  PluginManifestSchema,
  type PluginMarketplaceEntry,
  type PluginSource,
} from './schemas.js'
import {
  convertDirectoryToZipInPlace,
  extractZipToDirectory,
  getSessionPluginCachePath,
  isPluginZipCacheEnabled,
} from './zipCache.js'

/**
 * 获取插件缓存存储路径
 */
export function getPluginCachePath(): string {
  return join(getPluginsDirectory(), 'cache')
}

/**
 * 在指定的基础插件目录下计算带版本号的缓存路径。
 * 用于探测主缓存和种子缓存。
 *
 * @param baseDir - 基础插件目录（例如 getPluginsDirectory() 或种子目录）
 * @param pluginId - 插件标识符，格式为 "name@marketplace"
 * @param version - 版本字符串（semver、git SHA 等）
 * @returns baseDir 下带版本号的插件目录绝对路径
 */
export function getVersionedCachePathIn(
  baseDir: string,
  pluginId: string,
  version: string,
): string {
  const { name: pluginName, marketplace } = parsePluginIdentifier(pluginId)
  const sanitizedMarketplace = (marketplace || 'unknown').replace(
    /[^a-zA-Z0-9\-_]/g,
    '-',
  )
  const sanitizedPlugin = (pluginName || pluginId).replace(
    /[^a-zA-Z0-9\-_]/g,
    '-',
  )
  // 对版本号进行清理以防止路径遍历攻击
  const sanitizedVersion = version.replace(/[^a-zA-Z0-9\-_.]/g, '-')
  return join(
    baseDir,
    'cache',
    sanitizedMarketplace,
    sanitizedPlugin,
    sanitizedVersion,
  )
}

/**
 * 获取插件在主插件目录下的带版本号缓存路径。
 * 格式：~/.claude/plugins/cache/{marketplace}/{plugin}/{version}/
 *
 * @param pluginId - 插件标识符，格式为 "name@marketplace"
 * @param version - 版本字符串（semver、git SHA 等）
 * @returns 带版本号的插件目录绝对路径
 */
export function getVersionedCachePath(
  pluginId: string,
  version: string,
): string {
  return getVersionedCachePathIn(getPluginsDirectory(), pluginId, version)
}

/**
 * 获取插件的带版本号 ZIP 缓存路径。
 * 这是 getVersionedCachePath 的 ZIP 缓存变体。
 */
export function getVersionedZipCachePath(
  pluginId: string,
  version: string,
): string {
  return `${getVersionedCachePath(pluginId, version)}.zip`
}

/**
 * 探测种子目录中是否存在该插件版本的已填充缓存。
 * 种子按优先级顺序检查；首次命中即返回。如果未配置种子目录或
 * 没有任何种子在该版本下包含已填充的目录，则返回 null。
 */
async function probeSeedCache(
  pluginId: string,
  version: string,
): Promise<string | null> {
  for (const seedDir of getPluginSeedDirs()) {
    const seedPath = getVersionedCachePathIn(seedDir, pluginId, version)
    try {
      const entries = await readdir(seedPath)
      if (entries.length > 0) return seedPath
    } catch {
      // 尝试下一个种子目录
    }
  }
  return null
}

/**
 * 当计算出的版本为 'unknown' 时，探测种子/cache/<m>/<p>/ 下是否存在
 * 实际的版本目录。处理首次启动时的"先有鸡还是先有蛋"问题——
 * 版本只有在克隆后才能知道，但种子目录中已经有克隆好的内容。
 *
 * 每个种子仅在恰好存在一个版本目录时匹配（典型的 BYOC 场景）。
 * 单个种子内存在多个版本 → 歧义 → 尝试下一个种子。
 * 种子按优先级顺序检查；首次命中即返回。
 */
export async function probeSeedCacheAnyVersion(
  pluginId: string,
): Promise<string | null> {
  for (const seedDir of getPluginSeedDirs()) {
    // 版本目录的父目录——计算方式与 getVersionedCachePathIn 相同，
    // 只是不包含版本组件。
    const pluginDir = dirname(getVersionedCachePathIn(seedDir, pluginId, '_'))
    try {
      const versions = await readdir(pluginDir)
      if (versions.length !== 1) continue
      const versionDir = join(pluginDir, versions[0]!)
      const entries = await readdir(versionDir)
      if (entries.length > 0) return versionDir
    } catch {
      // 尝试下一个种子目录
    }
  }
  return null
}

/**
 * 获取插件的旧版（非版本号）缓存路径。
 * 格式：~/.claude/plugins/cache/{plugin-name}/
 *
 * 用于与现有安装的向后兼容。
 *
 * @param pluginName - 插件名称（不含 marketplace 后缀）
 * @returns 旧版插件目录的绝对路径
 */
export function getLegacyCachePath(pluginName: string): string {
  const cachePath = getPluginCachePath()
  return join(cachePath, pluginName.replace(/[^a-zA-Z0-9\-_]/g, '-'))
}

/**
 * 解析插件路径，失败时回退到旧版位置。
 *
 * 始终按以下顺序：
 * 1. 如果提供了版本号，优先尝试带版本号的路径
 * 2. 对现有安装回退到旧版路径
 * 3. 对新安装返回带版本号的路径
 *
 * @param pluginId - 插件标识符，格式为 "name@marketplace"
 * @param version - 可选的版本字符串
 * @returns 插件目录的绝对路径
 */
export async function resolvePluginPath(
  pluginId: string,
  version?: string,
): Promise<string> {
  // 优先尝试带版本号的路径
  if (version) {
    const versionedPath = getVersionedCachePath(pluginId, version)
    if (await pathExists(versionedPath)) {
      return versionedPath
    }
  }

  // 对现有安装回退到旧版路径
  const pluginName = parsePluginIdentifier(pluginId).name || pluginId
  const legacyPath = getLegacyCachePath(pluginName)
  if (await pathExists(legacyPath)) {
    return legacyPath
  }

  // 对新安装返回带版本号的路径
  return version ? getVersionedCachePath(pluginId, version) : legacyPath
}

/**
 * 递归复制目录。
 * 导出仅供测试使用。
 */
export async function copyDir(src: string, dest: string): Promise<void> {
  await getFsImplementation().mkdir(dest)

  const entries = await readdir(src, { withFileTypes: true })

  for (const entry of entries) {
    const srcPath = join(src, entry.name)
    const destPath = join(dest, entry.name)

    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath)
    } else if (entry.isFile()) {
      await copyFile(srcPath, destPath)
    } else if (entry.isSymbolicLink()) {
      const linkTarget = await readlink(srcPath)

      // 解析符号链接以获取实际目标路径
      // 这可以防止 src 和 dest 重叠时出现循环符号链接（例如通过符号链接链）
      let resolvedTarget: string
      try {
        resolvedTarget = await realpath(srcPath)
      } catch {
        // 损坏的符号链接 - 原样复制原始链接目标
        await symlink(linkTarget, destPath)
        continue
      }

      // 解析源目录以处理符号链接的源目录
      let resolvedSrc: string
      try {
        resolvedSrc = await realpath(src)
      } catch {
        resolvedSrc = src
      }

      // 检查目标是否在源目录树内（使用正确的路径前缀匹配）
      const srcPrefix = resolvedSrc.endsWith(sep)
        ? resolvedSrc
        : resolvedSrc + sep
      if (
        resolvedTarget.startsWith(srcPrefix) ||
        resolvedTarget === resolvedSrc
      ) {
        // 目标在源目录树内 - 创建相对符号链接以在目标中保留相同结构
        const targetRelativeToSrc = relative(resolvedSrc, resolvedTarget)
        const destTargetPath = join(dest, targetRelativeToSrc)
        const relativeLinkPath = relative(dirname(destPath), destTargetPath)
        await symlink(relativeLinkPath, destPath)
      } else {
        // 目标在源目录树外 - 使用绝对解析路径
        await symlink(resolvedTarget, destPath)
      }
    }
  }
}

/**
 * 将插件文件复制到带版本号的缓存目录。
 *
 * 对于本地插件：使用 marketplace.json 中的 entry.source 作为唯一真实来源。
 * 对于远程插件：回退到复制 sourcePath（已下载的内容）。
 *
 * @param sourcePath - 插件源路径（用作远程插件的回退）
 * @param pluginId - 插件标识符，格式为 "name@marketplace"
 * @param version - 带版本号路径的版本字符串
 * @param entry - 可选的 marketplace 条目，包含 source 字段
 * @param marketplaceDir - 用于解析 entry.source 的 marketplace 目录（远程插件为 undefined）
 * @returns 缓存插件目录的路径
 * @throws Error 如果源目录未找到
 * @throws Error 如果复制后目标目录为空
 */
export async function copyPluginToVersionedCache(
  sourcePath: string,
  pluginId: string,
  version: string,
  entry?: PluginMarketplaceEntry,
  marketplaceDir?: string,
): Promise<string> {
  // 当启用 zip 缓存时，规范格式为 ZIP 文件
  const zipCacheMode = isPluginZipCacheEnabled()
  const cachePath = getVersionedCachePath(pluginId, version)
  const zipPath = getVersionedZipCachePath(pluginId, version)

  // 如果缓存已存在（目录或 ZIP），直接返回
  if (zipCacheMode) {
    if (await pathExists(zipPath)) {
      logForDebugging(
        `Plugin ${pluginId} version ${version} already cached at ${zipPath}`,
      )
      return zipPath
    }
  } else if (await pathExists(cachePath)) {
    const entries = await readdir(cachePath)
    if (entries.length > 0) {
      logForDebugging(
        `Plugin ${pluginId} version ${version} already cached at ${cachePath}`,
      )
      return cachePath
    }
    // 目录存在但为空，移除以便重新创建内容
    logForDebugging(
      `Removing empty cache directory for ${pluginId} at ${cachePath}`,
    )
    await rmdir(cachePath)
  }

  // 种子缓存命中 — 原地返回种子路径（只读，不复制）。
  // 调用者同时处理目录和 .zip 路径；此处返回目录。
  const seedPath = await probeSeedCache(pluginId, version)
  if (seedPath) {
    logForDebugging(
      `Using seed cache for ${pluginId}@${version} at ${seedPath}`,
    )
    return seedPath
  }

  // 创建父目录
  await getFsImplementation().mkdir(dirname(cachePath))

  // 对于本地插件：复制 entry.source 目录（唯一真实来源）
  // 对于远程插件：marketplaceDir 为 undefined，回退到复制 sourcePath
  if (entry && typeof entry.source === 'string' && marketplaceDir) {
    const sourceDir = validatePathWithinBase(marketplaceDir, entry.source)

    logForDebugging(
      `Copying source directory ${entry.source} for plugin ${pluginId}`,
    )
    try {
      await copyDir(sourceDir, cachePath)
    } catch (e: unknown) {
      // 仅重新映射顶层 sourceDir 本身的 ENOENT —— 来自递归 copyDir 的
      // 嵌套 ENOENT（损坏的符号链接、竞争删除）应保留原始路径在错误信息中。
      if (isENOENT(e) && getErrnoPath(e) === sourceDir) {
        throw new Error(
          `Plugin source directory not found: ${sourceDir} (from entry.source: ${entry.source})`,
        )
      }
      throw e
    }
  } else {
    // 远程插件的回退（已下载）或没有 entry.source 的插件
    logForDebugging(
      `Copying plugin ${pluginId} to versioned cache (fallback to full copy)`,
    )
    await copyDir(sourcePath, cachePath)
  }

  // 如果存在则从缓存中移除 .git 目录
  const gitPath = join(cachePath, '.git')
  await rm(gitPath, { recursive: true, force: true })

  // 验证缓存有内容 - 如果为空则抛出异常以便使用回退方案
  const cacheEntries = await readdir(cachePath)
  if (cacheEntries.length === 0) {
    throw new Error(
      `Failed to copy plugin ${pluginId} to versioned cache: destination is empty after copy`,
    )
  }

  // Zip 缓存模式：将目录转换为 ZIP 并移除目录
  if (zipCacheMode) {
    await convertDirectoryToZipInPlace(cachePath, zipPath)
    logForDebugging(
      `Successfully cached plugin ${pluginId} as ZIP at ${zipPath}`,
    )
    return zipPath
  }

  logForDebugging(`Successfully cached plugin ${pluginId} at ${cachePath}`)
  return cachePath
}

/**
 * 使用 Node.js URL 解析校验 git URL
 */
function validateGitUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (!['https:', 'http:', 'file:'].includes(parsed.protocol)) {
      if (!/^git@[a-zA-Z0-9.-]+:/.test(url)) {
        throw new Error(
          `Invalid git URL protocol: ${parsed.protocol}. Only HTTPS, HTTP, file:// and SSH (git@) URLs are supported.`,
        )
      }
    }
    return url
  } catch {
    if (/^git@[a-zA-Z0-9.-]+:/.test(url)) {
      return url
    }
    throw new Error(`Invalid git URL: ${url}`)
  }
}

/**
 * 使用全局缓存从 npm 安装插件（导出仅供测试）
 */
export async function installFromNpm(
  packageName: string,
  targetPath: string,
  options: { registry?: string; version?: string } = {},
): Promise<void> {
  const npmCachePath = join(getPluginsDirectory(), 'npm-cache')

  await getFsImplementation().mkdir(npmCachePath)

  const packageSpec = options.version
    ? `${packageName}@${options.version}`
    : packageName
  const packagePath = join(npmCachePath, 'node_modules', packageName)
  const needsInstall = !(await pathExists(packagePath))

  if (needsInstall) {
    logForDebugging(`Installing npm package ${packageSpec} to cache`)
    const args = ['install', packageSpec, '--prefix', npmCachePath]
    if (options.registry) {
      args.push('--registry', options.registry)
    }
    const result = await execFileNoThrow('npm', args, { useCwd: false })

    if (result.code !== 0) {
      throw new Error(`Failed to install npm package: ${result.stderr}`)
    }
  }

  await copyDir(packagePath, targetPath)
  logForDebugging(
    `Copied npm package ${packageName} from cache to ${targetPath}`,
  )
}

/**
 * 克隆 git 仓库（导出仅供测试）
 *
 * @param gitUrl - 要克隆的 git URL
 * @param targetPath - 仓库克隆到的目标位置
 * @param ref - 可选的要检出的分支或标签
 * @param sha - 可选的要检出的特定 commit SHA
 */
export async function gitClone(
  gitUrl: string,
  targetPath: string,
  ref?: string,
  sha?: string,
): Promise<void> {
  // 使用 --recurse-submodules 初始化子模块
  // 始终使用浅克隆以提高效率
  const args = [
    'clone',
    '--depth',
    '1',
    '--recurse-submodules',
    '--shallow-submodules',
  ]

  // 为特定 ref 添加 --branch 标志（对分支和标签均有效）
  if (ref) {
    args.push('--branch', ref)
  }

  // 如果指定了 sha，使用 --no-checkout，因为我们将单独检出该 SHA
  if (sha) {
    args.push('--no-checkout')
  }

  args.push(gitUrl, targetPath)

  const cloneStarted = performance.now()
  const cloneResult = await execFileNoThrow(gitExe(), args)

  if (cloneResult.code !== 0) {
    logPluginFetch(
      'plugin_clone',
      gitUrl,
      'failure',
      performance.now() - cloneStarted,
      classifyFetchError(cloneResult.stderr),
    )
    throw new Error(`Failed to clone repository: ${cloneResult.stderr}`)
  }

  // 如果指定了 sha，获取并检出该特定提交
  if (sha) {
    // 优先尝试浅获取特定 SHA（最高效）
    const shallowFetchResult = await execFileNoThrowWithCwd(
      gitExe(),
      ['fetch', '--depth', '1', 'origin', sha],
      { cwd: targetPath },
    )

    if (shallowFetchResult.code !== 0) {
      // 某些服务器不支持获取任意 SHA
      // 回退到完全获取以获取完整历史
      logForDebugging(
        `Shallow fetch of SHA ${sha} failed, falling back to unshallow fetch`,
      )
      const unshallowResult = await execFileNoThrowWithCwd(
        gitExe(),
        ['fetch', '--unshallow'],
        { cwd: targetPath },
      )

      if (unshallowResult.code !== 0) {
        logPluginFetch(
          'plugin_clone',
          gitUrl,
          'failure',
          performance.now() - cloneStarted,
          classifyFetchError(unshallowResult.stderr),
        )
        throw new Error(
          `Failed to fetch commit ${sha}: ${unshallowResult.stderr}`,
        )
      }
    }

    // 检出特定提交
    const checkoutResult = await execFileNoThrowWithCwd(
      gitExe(),
      ['checkout', sha],
      { cwd: targetPath },
    )

    if (checkoutResult.code !== 0) {
      logPluginFetch(
        'plugin_clone',
        gitUrl,
        'failure',
        performance.now() - cloneStarted,
        classifyFetchError(checkoutResult.stderr),
      )
      throw new Error(
        `Failed to checkout commit ${sha}: ${checkoutResult.stderr}`,
      )
    }
  }

  // 仅在 ALL 网络操作（clone + 可选的 SHA fetch）
  // 完成后触发成功 — 与 mcpb 和 marketplace_url 相同的遥测范围纪律。
  logPluginFetch(
    'plugin_clone',
    gitUrl,
    'success',
    performance.now() - cloneStarted,
  )
}

/**
 * 从 git URL 安装插件
 */
async function installFromGit(
  gitUrl: string,
  targetPath: string,
  ref?: string,
  sha?: string,
): Promise<void> {
  const safeUrl = validateGitUrl(gitUrl)
  await gitClone(safeUrl, targetPath, ref, sha)
  const refMessage = ref ? ` (ref: ${ref})` : ''
  logForDebugging(
    `Cloned repository from ${safeUrl}${refMessage} to ${targetPath}`,
  )
}

/**
 * 从 GitHub 安装插件
 */
async function installFromGitHub(
  repo: string,
  targetPath: string,
  ref?: string,
  sha?: string,
): Promise<void> {
  if (!/^[a-zA-Z0-9-_.]+\/[a-zA-Z0-9-_.]+$/.test(repo)) {
    throw new Error(
      `Invalid GitHub repository format: ${repo}. Expected format: owner/repo`,
    )
  }
  // CCR 使用 HTTPS（无 SSH 密钥），普通 CLI 使用 SSH
  const gitUrl = isEnvTruthy(process.env.CLAUDE_CODE_REMOTE)
    ? `https://github.com/${repo}.git`
    : `git@github.com:${repo}.git`
  return installFromGit(gitUrl, targetPath, ref, sha)
}

/**
 * 将 git-subdir 的 `url` 字段解析为可克隆的 git URL。
 * 接受 GitHub owner/repo 简写（根据 CLAUDE_CODE_REMOTE 转换为 ssh 或 https）
 * 或任何通过 validateGitUrl 校验的 URL（https、http、file、git@ ssh）。
 */
function resolveGitSubdirUrl(url: string): string {
  if (/^[a-zA-Z0-9-_.]+\/[a-zA-Z0-9-_.]+$/.test(url)) {
    return isEnvTruthy(process.env.CLAUDE_CODE_REMOTE)
      ? `https://github.com/${url}.git`
      : `git@github.com:${url}.git`
  }
  return validateGitUrl(url)
}

/**
 * 从 git 仓库的子目录安装插件（导出仅供测试）。
 *
 * 使用部分克隆（--filter=tree:0）+ sparse-checkout，因此仅下载
 * 路径上的树对象和其下的 blob。对于大型单体仓库，这比完整克隆
 * 代价低得多——百万文件仓库的树对象可能达数百 MB，此处完全避免。
 *
 * 操作序列：
 * 1. clone --depth 1 --filter=tree:0 --no-checkout [--branch ref]
 * 2. sparse-checkout set --cone -- <path>
 * 3. 如果有 sha: fetch --depth 1 origin <sha>（回退: --unshallow），然后
 *    checkout <sha>。部分克隆过滤器存储在远程配置中，因此后续 fetch 会
 *    遵守它；--unshallow 获取所有提交但树和 blob 仍为惰性加载。
 *    如果没有 sha: checkout HEAD（如果使用 --branch 则指向 ref）。
 * 4. 将 <cloneDir>/<path> 移动到 targetPath 并丢弃克隆目录。
 *
 * 克隆是临时的——进入同级临时目录，在子目录提取后移除。
 * targetPath 最终仅包含插件文件，没有 .git 目录。
 */
export async function installFromGitSubdir(
  url: string,
  targetPath: string,
  subdirPath: string,
  ref?: string,
  sha?: string,
): Promise<string | undefined> {
  if (!(await checkGitAvailable())) {
    throw new Error(
      'git-subdir plugin source requires git to be installed and on PATH. ' +
        'Install git (version 2.25 or later for sparse-checkout cone mode) and try again.',
    )
  }

  const gitUrl = resolveGitSubdirUrl(url)
  // 克隆到同级临时目录（同一文件系统 → rename 有效，不会 EXDEV）。
  const cloneDir = `${targetPath}.clone`

  const cloneArgs = [
    'clone',
    '--depth',
    '1',
    '--filter=tree:0',
    '--no-checkout',
  ]
  if (ref) {
    cloneArgs.push('--branch', ref)
  }
  cloneArgs.push(gitUrl, cloneDir)

  const cloneResult = await execFileNoThrow(gitExe(), cloneArgs)
  if (cloneResult.code !== 0) {
    throw new Error(
      `Failed to clone repository for git-subdir source: ${cloneResult.stderr}`,
    )
  }

  try {
    const sparseResult = await execFileNoThrowWithCwd(
      gitExe(),
      ['sparse-checkout', 'set', '--cone', '--', subdirPath],
      { cwd: cloneDir },
    )
    if (sparseResult.code !== 0) {
      throw new Error(
        `git sparse-checkout set failed (git >= 2.25 required for cone mode): ${sparseResult.stderr}`,
      )
    }

    // 在丢弃克隆之前捕获已解析的 commit SHA。
    // 提取的子目录没有 .git，因此调用者之后无法 rev-parse。
    // 如果源指定了完整的 40 字符 sha，我们已经知道它；否则
    // 读取 HEAD（--branch 后指向 ref 的顶端，或者远程的
    // 默认分支如果没有给定 ref）。
    let resolvedSha: string | undefined

    if (sha) {
      const fetchSha = await execFileNoThrowWithCwd(
        gitExe(),
        ['fetch', '--depth', '1', 'origin', sha],
        { cwd: cloneDir },
      )
      if (fetchSha.code !== 0) {
        logForDebugging(
          `Shallow fetch of SHA ${sha} failed for git-subdir, falling back to unshallow fetch`,
        )
        const unshallow = await execFileNoThrowWithCwd(
          gitExe(),
          ['fetch', '--unshallow'],
          { cwd: cloneDir },
        )
        if (unshallow.code !== 0) {
          throw new Error(`Failed to fetch commit ${sha}: ${unshallow.stderr}`)
        }
      }
      const checkout = await execFileNoThrowWithCwd(
        gitExe(),
        ['checkout', sha],
        { cwd: cloneDir },
      )
      if (checkout.code !== 0) {
        throw new Error(`Failed to checkout commit ${sha}: ${checkout.stderr}`)
      }
      resolvedSha = sha
    } else {
      // checkout HEAD 物化工作树（这是惰性获取 blob 的地方——
      // 慢速的、依赖网络的步骤）。它不会移动 HEAD；
      // clone 时的 --branch 已经定位了它。rev-parse HEAD 是
      // 纯只读的 ref 查询（无索引锁），因此它可以安全地与
      // checkout 并行运行，避免等待网络。
      const [checkout, revParse] = await Promise.all([
        execFileNoThrowWithCwd(gitExe(), ['checkout', 'HEAD'], {
          cwd: cloneDir,
        }),
        execFileNoThrowWithCwd(gitExe(), ['rev-parse', 'HEAD'], {
          cwd: cloneDir,
        }),
      ])
      if (checkout.code !== 0) {
        throw new Error(
          `git checkout after sparse-checkout failed: ${checkout.stderr}`,
        )
      }
      if (revParse.code === 0) {
        resolvedSha = revParse.stdout.trim()
      }
    }

    // 路径遍历防护：在将子目录移出之前，解析+验证它保持在 cloneDir 内。
    // rename ENOENT 被包装为更友好的消息，引用源路径而非内部临时目录。
    const resolvedSubdir = validatePathWithinBase(cloneDir, subdirPath)
    try {
      await rename(resolvedSubdir, targetPath)
    } catch (e: unknown) {
      if (isENOENT(e)) {
        throw new Error(
          `Subdirectory '${subdirPath}' not found in repository ${gitUrl}${ref ? ` (ref: ${ref})` : ''}. ` +
            'Check that the path is correct and exists at the specified ref/sha.',
        )
      }
      throw e
    }

    const refMsg = ref ? ` ref=${ref}` : ''
    const shaMsg = resolvedSha ? ` sha=${resolvedSha}` : ''
    logForDebugging(
      `Extracted subdir ${subdirPath} from ${gitUrl}${refMsg}${shaMsg} to ${targetPath}`,
    )
    return resolvedSha
  } finally {
    await rm(cloneDir, { recursive: true, force: true })
  }
}

/**
 * 从本地路径安装插件
 */
async function installFromLocal(
  sourcePath: string,
  targetPath: string,
): Promise<void> {
  if (!(await pathExists(sourcePath))) {
    throw new Error(`Source path does not exist: ${sourcePath}`)
  }

  await copyDir(sourcePath, targetPath)

  const gitPath = join(targetPath, '.git')
  await rm(gitPath, { recursive: true, force: true })
}

/**
 * 为插件生成临时缓存名称
 */
export function generateTemporaryCacheNameForPlugin(
  source: PluginSource,
): string {
  const timestamp = Date.now()
  const random = Math.random().toString(36).substring(2, 8)

  let prefix: string

  if (typeof source === 'string') {
    prefix = 'local'
  } else {
    switch (source.source) {
      case 'npm':
        prefix = 'npm'
        break
      case 'pip':
        prefix = 'pip'
        break
      case 'github':
        prefix = 'github'
        break
      case 'url':
        prefix = 'git'
        break
      case 'git-subdir':
        prefix = 'subdir'
        break
      default:
        prefix = 'unknown'
    }
  }

  return `temp_${prefix}_${timestamp}_${random}`
}

/**
 * 从外部来源缓存插件
 */
export async function cachePlugin(
  source: PluginSource,
  options?: {
    manifest?: PluginManifest
  },
): Promise<{ path: string; manifest: PluginManifest; gitCommitSha?: string }> {
  const cachePath = getPluginCachePath()

  await getFsImplementation().mkdir(cachePath)

  const tempName = generateTemporaryCacheNameForPlugin(source)
  const tempPath = join(cachePath, tempName)

  let shouldCleanup = false
  let gitCommitSha: string | undefined

  try {
    logForDebugging(
      `Caching plugin from source: ${jsonStringify(source)} to temporary path ${tempPath}`,
    )

    shouldCleanup = true

    if (typeof source === 'string') {
      await installFromLocal(source, tempPath)
    } else {
      switch (source.source) {
        case 'npm':
          await installFromNpm(source.package, tempPath, {
            registry: source.registry,
            version: source.version,
          })
          break
        case 'github':
          await installFromGitHub(source.repo, tempPath, source.ref, source.sha)
          break
        case 'url':
          await installFromGit(source.url, tempPath, source.ref, source.sha)
          break
        case 'git-subdir':
          gitCommitSha = await installFromGitSubdir(
            source.url,
            tempPath,
            source.path,
            source.ref,
            source.sha,
          )
          break
        case 'pip':
          throw new Error('Python package plugins are not yet supported')
        default:
          throw new Error(`Unsupported plugin source type`)
      }
    }
  } catch (error) {
    if (shouldCleanup && (await pathExists(tempPath))) {
      logForDebugging(`Cleaning up failed installation at ${tempPath}`)
      try {
        await rm(tempPath, { recursive: true, force: true })
      } catch (cleanupError) {
        logForDebugging(`Failed to clean up installation: ${cleanupError}`, {
          level: 'error',
        })
      }
    }
    throw error
  }

  const manifestPath = join(tempPath, '.claude-plugin', 'plugin.json')
  const legacyManifestPath = join(tempPath, 'plugin.json')
  let manifest: PluginManifest

  if (await pathExists(manifestPath)) {
    try {
      const content = await readFile(manifestPath, { encoding: 'utf-8' })
      const parsed = jsonParse(content)
      const result = PluginManifestSchema().safeParse(parsed)

      if (result.success) {
        manifest = result.data
      } else {
        // 清单存在但无效 - 抛出错误
        const errors = result.error.issues
          .map(err => `${err.path.join('.')}: ${err.message}`)
          .join(', ')

        logForDebugging(`Invalid manifest at ${manifestPath}: ${errors}`, {
          level: 'error',
        })

        throw new Error(
          `Plugin has an invalid manifest file at ${manifestPath}. Validation errors: ${errors}`,
        )
      }
    } catch (error) {
      // 检查这是否是我们刚抛出的校验错误
      if (
        error instanceof Error &&
        error.message.includes('invalid manifest file')
      ) {
        throw error
      }

      // JSON 解析错误
      const errorMsg = errorMessage(error)
      logForDebugging(
        `Failed to parse manifest at ${manifestPath}: ${errorMsg}`,
        {
          level: 'error',
        },
      )

      throw new Error(
        `Plugin has a corrupt manifest file at ${manifestPath}. JSON parse error: ${errorMsg}`,
      )
    }
  } else if (await pathExists(legacyManifestPath)) {
    try {
      const content = await readFile(legacyManifestPath, {
        encoding: 'utf-8',
      })
      const parsed = jsonParse(content)
      const result = PluginManifestSchema().safeParse(parsed)

      if (result.success) {
        manifest = result.data
      } else {
        // 清单存在但无效 - 抛出错误
        const errors = result.error.issues
          .map(err => `${err.path.join('.')}: ${err.message}`)
          .join(', ')

        logForDebugging(
          `Invalid legacy manifest at ${legacyManifestPath}: ${errors}`,
          { level: 'error' },
        )

        throw new Error(
          `Plugin has an invalid manifest file at ${legacyManifestPath}. Validation errors: ${errors}`,
        )
      }
    } catch (error) {
      // 检查这是否是我们刚抛出的校验错误
      if (
        error instanceof Error &&
        error.message.includes('invalid manifest file')
      ) {
        throw error
      }

      // JSON 解析错误
      const errorMsg = errorMessage(error)
      logForDebugging(
        `Failed to parse legacy manifest at ${legacyManifestPath}: ${errorMsg}`,
        {
          level: 'error',
        },
      )

      throw new Error(
        `Plugin has a corrupt manifest file at ${legacyManifestPath}. JSON parse error: ${errorMsg}`,
      )
    }
  } else {
    manifest = options?.manifest || {
      name: tempName,
      description: `Plugin cached from ${typeof source === 'string' ? source : source.source}`,
    }
  }

  const finalName = manifest.name.replace(/[^a-zA-Z0-9-_]/g, '-')
  const finalPath = join(cachePath, finalName)

  if (await pathExists(finalPath)) {
    logForDebugging(`Removing old cached version at ${finalPath}`)
    await rm(finalPath, { recursive: true, force: true })
  }

  await rename(tempPath, finalPath)

  logForDebugging(`Successfully cached plugin ${manifest.name} to ${finalPath}`)

  return {
    path: finalPath,
    manifest,
    ...(gitCommitSha && { gitCommitSha }),
  }
}

/**
 * 从 JSON 文件加载并校验插件清单。
 *
 * 清单提供有关插件的元数据，包括名称、版本、
 * 描述、作者和其他可选字段。如果不存在清单，
 * 则创建一个最小清单以使插件能够运行。
 *
 * plugin.json 示例：
 * ```json
 * {
 *   "name": "code-assistant",
 *   "version": "1.2.0",
 *   "description": "AI-powered code assistance tools",
 *   "author": {
 *     "name": "John Doe",
 *     "email": "john@example.com"
 *   },
 *   "keywords": ["coding", "ai", "assistant"],
 *   "homepage": "https://example.com/code-assistant",
 *   "hooks": "./custom-hooks.json",
 *   "commands": ["./extra-commands/*.md"]
 * }
 * ```
 */

/**
 * 从 JSON 文件加载并校验插件清单。
 *
 * 清单提供有关插件的元数据，包括名称、版本、
 * 描述、作者和其他可选字段。如果不存在清单，
 * 则创建一个最小清单以使插件能够运行。
 *
 * 清单中的未知键会被静默移除（PluginManifestSchema
 * 使用 zod 的默认 strip 行为，而非 .strict()）。类型不匹配和
 * 其他校验错误仍会失败。
 *
 * 行为：
 * - 文件缺失：使用提供的 name 和 source 创建默认清单
 * - 无效 JSON：抛出包含解析详情的错误
 * - Schema 校验失败：抛出包含校验详情的错误
 *
 * @param manifestPath - plugin.json 文件的完整路径
 * @param pluginName - 默认清单中使用的名称（例如 "my-plugin"）
 * @param source - 默认清单的来源描述（例如 "git:repo" 或 ".claude-plugin/name"）
 * @returns 有效的 PluginManifest 对象（已加载或默认）
 * @throws Error 如果清单存在但无效（JSON 损坏或 schema 校验失败）
 */
export async function loadPluginManifest(
  manifestPath: string,
  pluginName: string,
  source: string,
): Promise<PluginManifest> {
  logForDebugging(
    `[Hapii] Plugin.loadManifest 开始 name=${pluginName} source=${source}`,
    { level: 'info' },
  )
  // 检查清单文件是否存在
  // 如果不存在，创建最小清单以使插件能够运行
  if (!(await pathExists(manifestPath))) {
    // 返回使用提供的 name 和 source 的默认清单
    return {
      name: pluginName,
      description: `Plugin from ${source}`,
    }
  }

  try {
    // 读取并解析清单 JSON 文件
    const content = await readFile(manifestPath, { encoding: 'utf-8' })
    const parsedJson = jsonParse(content)

    // 根据 PluginManifest schema 进行校验
    const result = PluginManifestSchema().safeParse(parsedJson)

    if (result.success) {
      // 有效清单 - 返回校验后的数据
      return result.data
    }

    // Schema 校验失败但 JSON 有效
    const errors = result.error.issues
      .map(err =>
        err.path.length > 0
          ? `${err.path.join('.')}: ${err.message}`
          : err.message,
      )
      .join(', ')

    logForDebugging(
      `Plugin ${pluginName} has an invalid manifest file at ${manifestPath}. Validation errors: ${errors}`,
      { level: 'error' },
    )

    throw new Error(
      `Plugin ${pluginName} has an invalid manifest file at ${manifestPath}.\n\nValidation errors: ${errors}`,
    )
  } catch (error) {
    // 检查这是否是我们刚抛出的错误（校验错误）
    if (
      error instanceof Error &&
      error.message.includes('invalid manifest file')
    ) {
      throw error
    }

    // JSON 解析失败或文件读取错误
    const errorMsg = errorMessage(error)

    logForDebugging(
      `Plugin ${pluginName} has a corrupt manifest file at ${manifestPath}. Parse error: ${errorMsg}`,
      { level: 'error' },
    )

    throw new Error(
      `Plugin ${pluginName} has a corrupt manifest file at ${manifestPath}.\n\nJSON parse error: ${errorMsg}`,
    )
  }
}

/**
 * 从 JSON 文件加载并校验插件的 hook 配置。
 * 重要：仅在 hook 文件预期存在时调用此函数。
 *
 * @param hooksConfigPath - hooks.json 文件的完整路径
 * @param pluginName - 用于错误信息的插件名称
 * @returns 校验后的 HooksSettings
 * @throws Error 如果文件不存在或无效
 */
async function loadPluginHooks(
  hooksConfigPath: string,
  pluginName: string,
): Promise<HooksSettings> {
  if (!(await pathExists(hooksConfigPath))) {
    throw new Error(
      `Hooks file not found at ${hooksConfigPath} for plugin ${pluginName}. If the manifest declares hooks, the file must exist.`,
    )
  }

  const content = await readFile(hooksConfigPath, { encoding: 'utf-8' })
  const rawHooksConfig = jsonParse(content)

  // hooks.json 文件具有包含 description 和 hooks 的包装结构
  // 使用 PluginHooksSchema 来校验并提取 hooks 属性
  const validatedPluginHooks = PluginHooksSchema().parse(rawHooksConfig)

  return validatedPluginHooks.hooks as HooksSettings
}

/**
 * 通过并行检查存在性来校验插件组件的相对路径列表。
 *
 * 此辅助函数将 pathExists 检查（昂贵的异步部分）并行化，同时
 * 通过按顺序迭代结果来保持确定性的错误/日志排序。
 *
 * 引入目的是修复 sync→async fs 迁移导致的性能回归：顺序的
 * `for { await pathExists }` 循环在每次迭代中增加约 1-5ms 的事件循环开销。
 * 对于多个插件 × 多种组件类型，这会累积到数百毫秒。
 *
 * @param relPaths - 从清单/marketplace 条目中要校验的相对路径
 * @param pluginPath - 用于解析相对路径的插件根目录
 * @param pluginName - 用于错误信息的插件名称
 * @param source - PluginError 记录的来源标识符
 * @param component - 这些路径属于哪个组件（用于错误记录）
 * @param componentLabel - 日志消息的可读标签（例如 "Agent"、"Skill"）
 * @param contextLabel - 路径来源，用于日志消息
 *   （例如 "specified in manifest but"、"from marketplace entry"）
 * @param errors - 路径未找到错误要推入的错误数组（被修改）
 * @returns 磁盘上存在的有效路径数组，按原始顺序
 */
async function validatePluginPaths(
  relPaths: string[],
  pluginPath: string,
  pluginName: string,
  source: string,
  component: PluginComponent,
  componentLabel: string,
  contextLabel: string,
  errors: PluginError[],
): Promise<string[]> {
  // 并行化异步 pathExists 检查
  const checks = await Promise.all(
    relPaths.map(async relPath => {
      const fullPath = join(pluginPath, relPath)
      return { relPath, fullPath, exists: await pathExists(fullPath) }
    }),
  )
  // 按原始顺序处理结果以保持错误/日志排序的确定性
  const validPaths: string[] = []
  for (const { relPath, fullPath, exists } of checks) {
    if (exists) {
      validPaths.push(fullPath)
    } else {
      logForDebugging(
        `${componentLabel} path ${relPath} ${contextLabel} not found at ${fullPath} for ${pluginName}`,
        { level: 'warn' },
      )
      logError(
        new Error(
          `Plugin component file not found: ${fullPath} for ${pluginName}`,
        ),
      )
      errors.push({
        type: 'path-not-found',
        source,
        plugin: pluginName,
        path: fullPath,
        component,
      })
    }
  }
  return validPaths
}

/**
 * 从插件目录路径创建 LoadedPlugin 对象。
 *
 * 这是核心函数，通过扫描插件目录结构并加载所有组件来组装
 * 完整的插件表示。它处理具有清单的完整功能插件
 * 以及仅有 commands 或 agents 目录的最小插件。
 *
 * 它查找的目录结构：
 * ```
 * plugin-directory/
 * ├── plugin.json          # 可选：插件清单
 * ├── commands/            # 可选：自定义斜杠命令
 * │   ├── build.md         # /build 命令
 * │   └── test.md          # /test 命令
 * ├── agents/              # 可选：自定义 AI 代理
 * │   ├── reviewer.md      # 代码审查代理
 * │   └── optimizer.md     # 性能优化代理
 * └── hooks/               # 可选：Hook 配置
 *     └── hooks.json       # Hook 定义
 * ```
 *
 * 组件检测：
 * - 清单：如果存在则从 plugin.json 加载，否则创建默认值
 * - 命令：如果 commands/ 目录存在则设置 commandsPath
 * - 代理：如果 agents/ 目录存在则设置 agentsPath
 * - Hooks：如果存在则从 hooks/hooks.json 加载
 *
 * 该函数能容忍缺失的组件 - 插件可以具有
 * 上述目录/文件的任意组合。缺失的组件文件
 * 被报告为错误，但不会阻止插件加载。
 *
 * @param pluginPath - 插件目录的绝对路径
 * @param source - 来源标识符（例如 "git:repo"、".claude-plugin/my-plugin"）
 * @param enabled - 初始启用状态（可能被 settings 覆盖）
 * @param fallbackName - 清单未指定名称时使用的名称
 * @param strict - 为 true 时，为重复的 hook 文件添加错误（默认：true）
 * @returns 包含 LoadedPlugin 和遇到的任何错误的对象
 */
export async function createPluginFromPath(
  pluginPath: string,
  source: string,
  enabled: boolean,
  fallbackName: string,
  strict = true,
): Promise<{ plugin: LoadedPlugin; errors: PluginError[] }> {
  const errors: PluginError[] = []

  // 步骤 1：加载或创建插件清单
  // 这提供有关插件的元数据（名称、版本等）
  const manifestPath = join(pluginPath, '.claude-plugin', 'plugin.json')
  const manifest = await loadPluginManifest(manifestPath, fallbackName, source)

  // 步骤 2：创建基础插件对象
  // 从清单和参数中获取所需字段
  const plugin: LoadedPlugin = {
    name: manifest.name, // Use name from manifest (or fallback)
    manifest, // Store full manifest for later use
    path: pluginPath, // Absolute path to plugin directory
    source, // Source identifier (e.g., "git:repo" or ".claude-plugin/name")
    repository: source, // For backward compatibility with Plugin Repository
    enabled, // Current enabled state
  }

  // 步骤 3：并行自动检测可选目录
  const [
    commandsDirExists,
    agentsDirExists,
    skillsDirExists,
    outputStylesDirExists,
  ] = await Promise.all([
    !manifest.commands ? pathExists(join(pluginPath, 'commands')) : false,
    !manifest.agents ? pathExists(join(pluginPath, 'agents')) : false,
    !manifest.skills ? pathExists(join(pluginPath, 'skills')) : false,
    !manifest.outputStyles
      ? pathExists(join(pluginPath, 'output-styles'))
      : false,
  ])

  const commandsPath = join(pluginPath, 'commands')
  if (commandsDirExists) {
    plugin.commandsPath = commandsPath
  }

  // 步骤 3a：处理清单中的额外命令路径
  if (manifest.commands) {
    // 检查是否为对象映射（命令名 → 元数据的记录）
    const firstValue = Object.values(manifest.commands)[0]
    if (
      typeof manifest.commands === 'object' &&
      !Array.isArray(manifest.commands) &&
      firstValue &&
      typeof firstValue === 'object' &&
      ('source' in firstValue || 'content' in firstValue)
    ) {
      // 对象映射格式：{ "about": { "source": "./README.md", ... } }
      const commandsMetadata: Record<string, CommandMetadata> = {}
      const validPaths: string[] = []

      // 并行化 pathExists 检查；按顺序处理结果以保持
      // 错误/日志排序的确定性。
      const entries = Object.entries(manifest.commands)
      const checks = await Promise.all(
        entries.map(async ([commandName, metadata]) => {
          if (!metadata || typeof metadata !== 'object') {
            return { commandName, metadata, kind: 'skip' as const }
          }
          if (metadata.source) {
            const fullPath = join(pluginPath, metadata.source)
            return {
              commandName,
              metadata,
              kind: 'source' as const,
              fullPath,
              exists: await pathExists(fullPath),
            }
          }
          if (metadata.content) {
            return { commandName, metadata, kind: 'content' as const }
          }
          return { commandName, metadata, kind: 'skip' as const }
        }),
      )
      for (const check of checks) {
        if (check.kind === 'skip') continue
        if (check.kind === 'content') {
          // 对于内联内容命令，添加无路径的元数据
          commandsMetadata[check.commandName] = check.metadata
          continue
        }
        // kind === 'source'
        if (check.exists) {
          validPaths.push(check.fullPath)
          commandsMetadata[check.commandName] = check.metadata
        } else {
          logForDebugging(
            `Command ${check.commandName} path ${check.metadata.source} specified in manifest but not found at ${check.fullPath} for ${manifest.name}`,
            { level: 'warn' },
          )
          logError(
            new Error(
              `Plugin component file not found: ${check.fullPath} for ${manifest.name}`,
            ),
          )
          errors.push({
            type: 'path-not-found',
            source,
            plugin: manifest.name,
            path: check.fullPath,
            component: 'commands',
          })
        }
      }

      // 如果有基于文件的命令，设置 commandsPaths
      if (validPaths.length > 0) {
        plugin.commandsPaths = validPaths
      }
      // 如果有任何命令（基于文件或内联），设置 commandsMetadata
      if (Object.keys(commandsMetadata).length > 0) {
        plugin.commandsMetadata = commandsMetadata
      }
    } else {
      // 路径或路径数组格式
      const commandPaths = Array.isArray(manifest.commands)
        ? manifest.commands
        : [manifest.commands]

      // 并行化 pathExists 检查；按顺序处理结果。
      const checks = await Promise.all(
        commandPaths.map(async cmdPath => {
          if (typeof cmdPath !== 'string') {
            return { cmdPath, kind: 'invalid' as const }
          }
          const fullPath = join(pluginPath, cmdPath)
          return {
            cmdPath,
            kind: 'path' as const,
            fullPath,
            exists: await pathExists(fullPath),
          }
        }),
      )
      const validPaths: string[] = []
      for (const check of checks) {
        if (check.kind === 'invalid') {
          logForDebugging(
            `Unexpected command format in manifest for ${manifest.name}`,
            { level: 'error' },
          )
          continue
        }
        if (check.exists) {
          validPaths.push(check.fullPath)
        } else {
          logForDebugging(
            `Command path ${check.cmdPath} specified in manifest but not found at ${check.fullPath} for ${manifest.name}`,
            { level: 'warn' },
          )
          logError(
            new Error(
              `Plugin component file not found: ${check.fullPath} for ${manifest.name}`,
            ),
          )
          errors.push({
            type: 'path-not-found',
            source,
            plugin: manifest.name,
            path: check.fullPath,
            component: 'commands',
          })
        }
      }

      if (validPaths.length > 0) {
        plugin.commandsPaths = validPaths
      }
    }
  }

  // 步骤 4：注册检测到的 agents 目录
  const agentsPath = join(pluginPath, 'agents')
  if (agentsDirExists) {
    plugin.agentsPath = agentsPath
  }

  // 步骤 4a：处理清单中的额外 agent 路径
  if (manifest.agents) {
    const agentPaths = Array.isArray(manifest.agents)
      ? manifest.agents
      : [manifest.agents]

    const validPaths = await validatePluginPaths(
      agentPaths,
      pluginPath,
      manifest.name,
      source,
      'agents',
      'Agent',
      'specified in manifest but',
      errors,
    )

    if (validPaths.length > 0) {
      plugin.agentsPaths = validPaths
    }
  }

  // 步骤 4b：注册检测到的 skills 目录
  const skillsPath = join(pluginPath, 'skills')
  if (skillsDirExists) {
    plugin.skillsPath = skillsPath
  }

  // 步骤 4c：处理清单中的额外 skill 路径
  if (manifest.skills) {
    const skillPaths = Array.isArray(manifest.skills)
      ? manifest.skills
      : [manifest.skills]

    const validPaths = await validatePluginPaths(
      skillPaths,
      pluginPath,
      manifest.name,
      source,
      'skills',
      'Skill',
      'specified in manifest but',
      errors,
    )

    if (validPaths.length > 0) {
      plugin.skillsPaths = validPaths
    }
  }

  // 步骤 4d：注册检测到的 output-styles 目录
  const outputStylesPath = join(pluginPath, 'output-styles')
  if (outputStylesDirExists) {
    plugin.outputStylesPath = outputStylesPath
  }

  // 步骤 4e：处理清单中的额外 output style 路径
  if (manifest.outputStyles) {
    const outputStylePaths = Array.isArray(manifest.outputStyles)
      ? manifest.outputStyles
      : [manifest.outputStyles]

    const validPaths = await validatePluginPaths(
      outputStylePaths,
      pluginPath,
      manifest.name,
      source,
      'output-styles',
      'Output style',
      'specified in manifest but',
      errors,
    )

    if (validPaths.length > 0) {
      plugin.outputStylesPaths = validPaths
    }
  }

  // 步骤 5：加载 hook 配置
  let mergedHooks: HooksSettings | undefined
  const loadedHookPaths = new Set<string>() // 跟踪已加载的 hook 文件

  // 如果标准 hooks/hooks.json 存在则从中加载
  const standardHooksPath = join(pluginPath, 'hooks', 'hooks.json')
  if (await pathExists(standardHooksPath)) {
    try {
      mergedHooks = await loadPluginHooks(standardHooksPath, manifest.name)
      // 跟踪规范化路径以防止重复加载
      try {
        loadedHookPaths.add(await realpath(standardHooksPath))
      } catch {
        // 如果 realpathSync 失败，使用原始路径
        loadedHookPaths.add(standardHooksPath)
      }
      logForDebugging(
        `Loaded hooks from standard location for plugin ${manifest.name}: ${standardHooksPath}`,
      )
    } catch (error) {
      const errorMsg = errorMessage(error)
      logForDebugging(
        `Failed to load hooks for ${manifest.name}: ${errorMsg}`,
        {
          level: 'error',
        },
      )
      logError(toError(error))
      errors.push({
        type: 'hook-load-failed',
        source,
        plugin: manifest.name,
        hookPath: standardHooksPath,
        reason: errorMsg,
      })
    }
  }

  // 如果指定了 manifest.hooks，加载并合并 hooks
  if (manifest.hooks) {
    const manifestHooksArray = Array.isArray(manifest.hooks)
      ? manifest.hooks
      : [manifest.hooks]

    for (const hookSpec of manifestHooksArray) {
      if (typeof hookSpec === 'string') {
        // 额外 hooks 文件的路径
        const hookFilePath = join(pluginPath, hookSpec)
        if (!(await pathExists(hookFilePath))) {
          logForDebugging(
            `Hooks file ${hookSpec} specified in manifest but not found at ${hookFilePath} for ${manifest.name}`,
            { level: 'error' },
          )
          logError(
            new Error(
              `Plugin component file not found: ${hookFilePath} for ${manifest.name}`,
            ),
          )
          errors.push({
            type: 'path-not-found',
            source,
            plugin: manifest.name,
            path: hookFilePath,
            component: 'hooks',
          })
          continue
        }

        // 检查此路径是否解析为已加载的 hooks 文件
        let normalizedPath: string
        try {
          normalizedPath = await realpath(hookFilePath)
        } catch {
          // 如果 realpathSync 失败，使用原始路径
          normalizedPath = hookFilePath
        }

        if (loadedHookPaths.has(normalizedPath)) {
          logForDebugging(
            `Skipping duplicate hooks file for plugin ${manifest.name}: ${hookSpec} ` +
              `(resolves to already-loaded file: ${normalizedPath})`,
          )
          if (strict) {
            const errorMsg = `Duplicate hooks file detected: ${hookSpec} resolves to already-loaded file ${normalizedPath}. The standard hooks/hooks.json is loaded automatically, so manifest.hooks should only reference additional hook files.`
            logError(new Error(errorMsg))
            errors.push({
              type: 'hook-load-failed',
              source,
              plugin: manifest.name,
              hookPath: hookFilePath,
              reason: errorMsg,
            })
          }
          continue
        }

        try {
          const additionalHooks = await loadPluginHooks(
            hookFilePath,
            manifest.name,
          )
          try {
            mergedHooks = mergeHooksSettings(mergedHooks, additionalHooks)
            loadedHookPaths.add(normalizedPath)
            logForDebugging(
              `Loaded and merged hooks from manifest for plugin ${manifest.name}: ${hookSpec}`,
            )
          } catch (mergeError) {
            const mergeErrorMsg = errorMessage(mergeError)
            logForDebugging(
              `Failed to merge hooks from ${hookSpec} for ${manifest.name}: ${mergeErrorMsg}`,
              { level: 'error' },
            )
            logError(toError(mergeError))
            errors.push({
              type: 'hook-load-failed',
              source,
              plugin: manifest.name,
              hookPath: hookFilePath,
              reason: `Failed to merge: ${mergeErrorMsg}`,
            })
          }
        } catch (error) {
          const errorMsg = errorMessage(error)
          logForDebugging(
            `Failed to load hooks from ${hookSpec} for ${manifest.name}: ${errorMsg}`,
            { level: 'error' },
          )
          logError(toError(error))
          errors.push({
            type: 'hook-load-failed',
            source,
            plugin: manifest.name,
            hookPath: hookFilePath,
            reason: errorMsg,
          })
        }
      } else if (typeof hookSpec === 'object') {
        // 内联 hooks
        mergedHooks = mergeHooksSettings(mergedHooks, hookSpec as HooksSettings)
      }
    }
  }

  if (mergedHooks) {
    plugin.hooksConfig = mergedHooks
  }

  // 步骤 6：加载插件设置
  // 设置可以来自插件目录中的 settings.json 或 manifest.settings
  // 仅保留白名单中的键（当前：agent）
  const pluginSettings = await loadPluginSettings(pluginPath, manifest)
  if (pluginSettings) {
    plugin.settings = pluginSettings
  }

  return { plugin, errors }
}

/**
 * 从 SettingsSchema 派生的 schema，仅保留插件允许设置的键。
 * 使用 .strip() 以便在解析时静默移除未知键。
 */
const PluginSettingsSchema = lazySchema(() =>
  SettingsSchema()
    .pick({
      agent: true,
    })
    .strip(),
)

/**
 * 通过 PluginSettingsSchema 解析原始设置，仅返回白名单中的键。
 * 如果解析失败或所有键都被过滤掉，则返回 undefined。
 */
function parsePluginSettings(
  raw: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const result = PluginSettingsSchema().safeParse(raw)
  if (!result.success) {
    return undefined
  }
  const data = result.data
  if (Object.keys(data).length === 0) {
    return undefined
  }
  return data
}

/**
 * 从 settings.json 文件或 manifest.settings 加载插件设置。
 * 当两者都存在时，settings.json 优先于 manifest.settings。
 * 结果中仅包含白名单中的键。
 */
async function loadPluginSettings(
  pluginPath: string,
  manifest: PluginManifest,
): Promise<Record<string, unknown> | undefined> {
  // 尝试从插件目录加载 settings.json
  const settingsJsonPath = join(pluginPath, 'settings.json')
  try {
    const content = await readFile(settingsJsonPath, { encoding: 'utf-8' })
    const parsed = jsonParse(content)
    if (isRecord(parsed)) {
      const filtered = parsePluginSettings(parsed)
      if (filtered) {
        logForDebugging(
          `Loaded settings from settings.json for plugin ${manifest.name}`,
        )
        return filtered
      }
    }
  } catch (e: unknown) {
    // 缺失/不可访问是预期行为 - settings.json 是可选的
    if (!isFsInaccessible(e)) {
      logForDebugging(
        `Failed to parse settings.json for plugin ${manifest.name}: ${e}`,
        { level: 'warn' },
      )
    }
  }

  // 回退到 manifest.settings
  if (manifest.settings) {
    const filtered = parsePluginSettings(
      manifest.settings as Record<string, unknown>,
    )
    if (filtered) {
      logForDebugging(
        `Loaded settings from manifest for plugin ${manifest.name}`,
      )
      return filtered
    }
  }

  return undefined
}

/**
 * 合并两个 HooksSettings 对象
 */
function mergeHooksSettings(
  base: HooksSettings | undefined,
  additional: HooksSettings,
): HooksSettings {
  if (!base) {
    return additional
  }

  const merged = { ...base }

  for (const [event, matchers] of Object.entries(additional) as [
    string,
    HookMatcher[],
  ][]) {
    if (!merged[event as keyof HooksSettings]) {
      merged[event as keyof HooksSettings] = matchers
    } else {
      // 合并此事件的匹配器
      const existing = ((merged[event as keyof HooksSettings] as unknown) ??
        []) as HookMatcher[]
      merged[event as keyof HooksSettings] = [...existing, ...matchers]
    }
  }

  return merged
}

/**
 * 两种加载模式的共享发现/策略/合并管道。
 *
 * 解析 enabledPlugins → marketplace 条目，运行企业策略检查，
 * 预加载目录，然后将每个条目分派到完整或仅缓存的每条目加载器。
 * loadAllPlugins 和 loadAllPluginsCacheOnly 之间的唯一区别
 * 是运行哪个加载器——发现和策略完全相同。
 */
async function loadPluginsFromMarketplaces({
  cacheOnly,
}: {
  cacheOnly: boolean
}): Promise<{
  plugins: LoadedPlugin[]
  errors: PluginError[]
}> {
  const settings = getSettings_DEPRECATED()
  // 合并 --add-dir 插件到最低优先级；冲突时标准 settings 优先
  const enabledPlugins = {
    ...getAddDirEnabledPlugins(),
    ...(settings.enabledPlugins || {}),
  }
  const plugins: LoadedPlugin[] = []
  const errors: PluginError[] = []

  // 过滤为 plugin@marketplace 格式并校验
  const marketplacePluginEntries = Object.entries(enabledPlugins).filter(
    ([key, value]) => {
      // 检查是否为 plugin@marketplace 格式（包含启用和禁用的）
      const isValidFormat = PluginIdSchema().safeParse(key).success
      if (!isValidFormat || value === undefined) return false
      // 跳过内置插件 — 由 getBuiltinPlugins() 单独处理
      const { marketplace } = parsePluginIdentifier(key)
      return marketplace !== BUILTIN_MARKETPLACE_NAME
    },
  )

  // 加载已知 marketplace 配置以查找策略检查的来源。
  // 使用 Safe 变体，以便损坏的配置文件不会导致所有插件加载崩溃——
  // 这是只读路径，因此返回 {} 会优雅降级。
  const knownMarketplaces = await loadKnownMarketplacesConfigSafe()

  // 企业策略的故障关闭守卫：如果配置了策略但我们
  // 无法解析 marketplace 的来源（配置因损坏返回 {}，
  // 或条目缺失），我们绝不能静默跳过策略检查并加载插件。
  // 在使用 Safe 之前，损坏的配置会崩溃所有操作（响亮、故障关闭）。
  // 使用 Safe 但没有守卫时，策略检查在 undefined marketplaceConfig 上
  // 短路，而回退路径（getPluginByIdCacheOnly）会不受检查地加载插件——
  // 这是静默故障打开。此守卫恢复了故障关闭：未知来源 + 活跃策略 → 阻止。
  //
  // 白名单：任何值（包括 []）都是活跃的——空白名单 = 全部拒绝。
  // 黑名单：空 [] 是语义上的无操作——仅非空才算活跃。
  const strictAllowlist = getStrictKnownMarketplaces()
  const blocklist = getBlockedMarketplaces()
  const hasEnterprisePolicy =
    strictAllowlist !== null || (blocklist !== null && blocklist.length > 0)

  // 每个 marketplace 预加载一次目录，而不是为每个插件重新读取
  // known_marketplaces.json + marketplace.json。这是热路径——
  // 对于 M 个 marketplace 中的 N 个插件，旧的每插件
  // getPluginByIdCacheOnly() 执行 2N 次配置读取 + N 次目录读取；此处执行 M 次。
  const uniqueMarketplaces = new Set(
    marketplacePluginEntries
      .map(([pluginId]) => parsePluginIdentifier(pluginId).marketplace)
      .filter((m): m is string => !!m),
  )
  const marketplaceCatalogs = new Map<
    string,
    Awaited<ReturnType<typeof getMarketplaceCacheOnly>>
  >()
  await Promise.all(
    [...uniqueMarketplaces].map(async name => {
      marketplaceCatalogs.set(name, await getMarketplaceCacheOnly(name))
    }),
  )

  // 一次性查找已安装的版本，以便即使 marketplace 条目省略 `version`，
  // 第一遍 ZIP 缓存检查也能命中。
  const installedPluginsData = getInMemoryInstalledPlugins()

  // 并行加载所有 marketplace 插件以加快启动速度
  const results = await Promise.allSettled(
    marketplacePluginEntries.map(async ([pluginId, enabledValue]) => {
      const { name: pluginName, marketplace: marketplaceName } =
        parsePluginIdentifier(pluginId)

      // 检查 marketplace 来源是否被企业策略允许
      const marketplaceConfig = knownMarketplaces[marketplaceName!]

      // 故障关闭：如果企业策略活跃且我们无法查找
      // marketplace 来源（配置损坏/为空，或条目缺失），阻止
      // 而非静默跳过策略检查。参见上方 hasEnterprisePolicy
      // 注释了解此守卫防范的故障打开风险。
      //
      // 这也会在"过时的 enabledPlugins 条目没有注册的
      // marketplace"情况下触发，这是一个 UX 权衡：用户收到策略
      // 错误而非 plugin-not-found。接受此行为因为回退路径
      // （getPluginByIdCacheOnly）对 known_marketplaces.json 执行原始转换
      // 而没有任何 schema 校验——如果一个条目畸形到无法通过
      // 我们的校验但可读性足以让原始转换通过，它将不受检查地加载。
      // 不可验证的来源 + 活跃策略 → 始终阻止。
      if (!marketplaceConfig && hasEnterprisePolicy) {
        // 我们无法知道不可验证的来源是否实际上会在
        // 黑名单中或不在白名单中——因此选择与配置的策略匹配的
        // 错误变体。如果存在白名单，"不在允许列表中"是正确的
        // 框架；如果只有黑名单，"被黑名单阻止"比显示
        // 空的允许来源列表更少误导性。
        errors.push({
          type: 'marketplace-blocked-by-policy',
          source: pluginId,
          plugin: pluginName,
          marketplace: marketplaceName!,
          blockedByBlocklist: strictAllowlist === null,
          allowedSources: (strictAllowlist ?? []).map(s =>
            formatSourceForDisplay(s),
          ),
        })
        return null
      }

      if (
        marketplaceConfig &&
        !isSourceAllowedByPolicy(marketplaceConfig.source)
      ) {
        // 检查是明确被阻止还是不在白名单中，以获得更好的错误上下文
        const isBlocked = isSourceInBlocklist(marketplaceConfig.source)
        const allowlist = getStrictKnownMarketplaces() || []
        errors.push({
          type: 'marketplace-blocked-by-policy',
          source: pluginId,
          plugin: pluginName,
          marketplace: marketplaceName!,
          blockedByBlocklist: isBlocked,
          allowedSources: isBlocked
            ? []
            : allowlist.map(s => formatSourceForDisplay(s)),
        })
        return null
      }

      // 从预加载的 marketplace 目录中查找插件条目（无每插件 I/O）。
      // 如果目录无法预加载，回退到 getPluginByIdCacheOnly。
      let result: Awaited<ReturnType<typeof getPluginByIdCacheOnly>> = null
      const marketplace = marketplaceCatalogs.get(marketplaceName!)
      if (marketplace && marketplaceConfig) {
        const entry = marketplace.plugins.find(p => p.name === pluginName)
        if (entry) {
          result = {
            entry,
            marketplaceInstallLocation: marketplaceConfig.installLocation,
          }
        }
      } else {
        result = await getPluginByIdCacheOnly(pluginId)
      }

      if (!result) {
        errors.push({
          type: 'plugin-not-found',
          source: pluginId,
          pluginId: pluginName!,
          marketplace: marketplaceName!,
        })
        return null
      }

      // installed_plugins.json 记录磁盘上实际缓存的内容
      // （完整加载器第一遍探测的 version，
      // 仅缓存加载器直接读取的 installPath）。
      const installEntry = installedPluginsData.plugins[pluginId]?.[0]
      return cacheOnly
        ? loadPluginFromMarketplaceEntryCacheOnly(
            result.entry,
            result.marketplaceInstallLocation,
            pluginId,
            enabledValue === true,
            errors,
            installEntry?.installPath,
          )
        : loadPluginFromMarketplaceEntry(
            result.entry,
            result.marketplaceInstallLocation,
            pluginId,
            enabledValue === true,
            errors,
            installEntry?.version,
          )
    }),
  )

  for (const [i, result] of results.entries()) {
    if (result.status === 'fulfilled' && result.value) {
      plugins.push(result.value)
    } else if (result.status === 'rejected') {
      const err = toError(result.reason)
      logError(err)
      const pluginId = marketplacePluginEntries[i]![0]
      errors.push({
        type: 'generic-error',
        source: pluginId,
        plugin: pluginId.split('@')[0],
        error: err.message,
      })
    }
  }

  return { plugins, errors }
}

/**
 * loadPluginFromMarketplaceEntry 的仅缓存变体。
 *
 * 跳过网络（cachePlugin）和磁盘复制（copyPluginToVersionedCache）。
 * 直接从记录的 installPath 读取；如果缺失，发出
 * 'plugin-cache-miss'。仍然提取 ZIP 缓存的插件（本地、快速）。
 */
async function loadPluginFromMarketplaceEntryCacheOnly(
  entry: PluginMarketplaceEntry,
  marketplaceInstallLocation: string,
  pluginId: string,
  enabled: boolean,
  errorsOut: PluginError[],
  installPath: string | undefined,
): Promise<LoadedPlugin | null> {
  let pluginPath: string

  if (typeof entry.source === 'string') {
    // 本地相对路径 — 直接从 marketplace 源目录读取。
    // 跳过 copyPluginToVersionedCache；启动不需要新副本。
    let marketplaceDir: string
    try {
      marketplaceDir = (await stat(marketplaceInstallLocation)).isDirectory()
        ? marketplaceInstallLocation
        : join(marketplaceInstallLocation, '..')
    } catch {
      errorsOut.push({
        type: 'plugin-cache-miss',
        source: pluginId,
        plugin: entry.name,
        installPath: marketplaceInstallLocation,
      })
      return null
    }
    pluginPath = join(marketplaceDir, entry.source)
    // finishLoadingPluginFromPath 读取 pluginPath — 其错误处理
    // 将 ENOENT 作为加载失败抛出，无需在此预检查。
  } else {
    // 外部来源（npm/github/url/git-subdir）— 使用记录的 installPath。
    if (!installPath || !(await pathExists(installPath))) {
      errorsOut.push({
        type: 'plugin-cache-miss',
        source: pluginId,
        plugin: entry.name,
        installPath: installPath ?? '(not recorded)',
      })
      return null
    }
    pluginPath = installPath
  }

  // Zip 缓存提取 — 在 cacheOnly 模式下仍必须发生（不变量 4）
  if (isPluginZipCacheEnabled() && pluginPath.endsWith('.zip')) {
    const sessionDir = await getSessionPluginCachePath()
    const extractDir = join(
      sessionDir,
      pluginId.replace(/[^a-zA-Z0-9@\-_]/g, '-'),
    )
    try {
      await extractZipToDirectory(pluginPath, extractDir)
      pluginPath = extractDir
    } catch (error) {
      logForDebugging(`Failed to extract plugin ZIP ${pluginPath}: ${error}`, {
        level: 'error',
      })
      errorsOut.push({
        type: 'plugin-cache-miss',
        source: pluginId,
        plugin: entry.name,
        installPath: pluginPath,
      })
      return null
    }
  }

  // 委托给共享尾部 — 从此处与完整加载器相同
  return finishLoadingPluginFromPath(
    entry,
    pluginId,
    enabled,
    errorsOut,
    pluginPath,
  )
}

/**
 * 根据其来源配置从 marketplace 条目加载插件。
 *
 * 处理不同的来源类型：
 * - 相对路径：从 marketplace 仓库目录加载
 * - npm/github/url：缓存后从缓存加载
 *
 * @param installedVersion - 来自 installed_plugins.json 的版本，用作
 *   marketplace 条目省略 `version` 时带版本号缓存查找的第一遍提示。
 *   避免仅仅为了发现我们在安装时已记录的版本而重新克隆外部插件。
 *
 * 返回加载的插件和加载过程中遇到的任何错误。
 * 错误包括缺失的组件文件和 hook 加载失败。
 */
async function loadPluginFromMarketplaceEntry(
  entry: PluginMarketplaceEntry,
  marketplaceInstallLocation: string,
  pluginId: string,
  enabled: boolean,
  errorsOut: PluginError[],
  installedVersion?: string,
): Promise<LoadedPlugin | null> {
  logForDebugging(
    `Loading plugin ${entry.name} from source: ${jsonStringify(entry.source)}`,
  )
  let pluginPath: string

  if (typeof entry.source === 'string') {
    // 相对路径 - 相对于 marketplace 安装位置解析
    const marketplaceDir = (
      await stat(marketplaceInstallLocation)
    ).isDirectory()
      ? marketplaceInstallLocation
      : join(marketplaceInstallLocation, '..')
    const sourcePluginPath = join(marketplaceDir, entry.source)

    if (!(await pathExists(sourcePluginPath))) {
      const error = new Error(`Plugin path not found: ${sourcePluginPath}`)
      logForDebugging(`Plugin path not found: ${sourcePluginPath}`, {
        level: 'error',
      })
      logError(error)
      errorsOut.push({
        type: 'generic-error',
        source: pluginId,
        error: `Plugin directory not found at path: ${sourcePluginPath}. Check that the marketplace entry has the correct path.`,
      })
      return null
    }

    // 始终将本地插件复制到带版本号的缓存
    try {
      // 首先尝试从插件目录加载清单以检查 version 字段
      const manifestPath = join(
        sourcePluginPath,
        '.claude-plugin',
        'plugin.json',
      )
      let pluginManifest: PluginManifest | undefined
      try {
        pluginManifest = await loadPluginManifest(
          manifestPath,
          entry.name,
          entry.source,
        )
      } catch {
        // 清单加载失败 - 将回退到提供的版本或 git SHA
      }

      // 计算版本，回退顺序：
      // 1. 插件清单版本, 2. Marketplace 条目版本, 3. Git SHA, 4. 'unknown'
      const version = await calculatePluginVersion(
        pluginId,
        entry.source,
        pluginManifest,
        marketplaceDir,
        entry.version, // Marketplace entry version as fallback
      )

      // 复制到带版本号的缓存
      pluginPath = await copyPluginToVersionedCache(
        sourcePluginPath,
        pluginId,
        version,
        entry,
        marketplaceDir,
      )

      logForDebugging(
        `Resolved local plugin ${entry.name} to versioned cache: ${pluginPath}`,
      )
    } catch (error) {
      // 如果复制失败，回退到直接从 marketplace 加载
      const errorMsg = errorMessage(error)
      logForDebugging(
        `Failed to copy plugin ${entry.name} to versioned cache: ${errorMsg}. Using marketplace path.`,
        { level: 'warn' },
      )
      pluginPath = sourcePluginPath
    }
  } else {
    // 外部来源（npm、github、url、pip）- 始终使用带版本号的缓存
    try {
      // 计算版本，回退顺序：
      // 1. 尚无清单, 2. installed_plugins.json 版本,
      //    3. Marketplace 条目版本, 4. source.sha（固定提交——
      //    缓存后.gitCommitSha 处调用看到的精确值）,
      //    5. 'unknown' → ref 跟踪，设计上回退到克隆。
      const version = await calculatePluginVersion(
        pluginId,
        entry.source,
        undefined,
        undefined,
        installedVersion ?? entry.version,
        'sha' in entry.source ? entry.source.sha : undefined,
      )

      const versionedPath = getVersionedCachePath(pluginId, version)

      // 检查缓存版本 — ZIP 文件（zip 缓存模式）或目录
      const zipPath = getVersionedZipCachePath(pluginId, version)
      if (isPluginZipCacheEnabled() && (await pathExists(zipPath))) {
        logForDebugging(
          `Using versioned cached plugin ZIP ${entry.name} from ${zipPath}`,
        )
        pluginPath = zipPath
      } else if (await pathExists(versionedPath)) {
        logForDebugging(
          `Using versioned cached plugin ${entry.name} from ${versionedPath}`,
        )
        pluginPath = versionedPath
      } else {
        // 种子缓存探测（CCR 预烘焙镜像，只读）。种子内容在
        // 镜像构建时冻结——无新鲜度问题，"那里有什么"就是
        // 镜像构建者放置的内容。此处不探测主缓存；
        // ref 跟踪的来源回退到克隆（重新克隆本身就是
        // 新鲜度机制）。如果克隆失败，插件在此会话中
        // 被禁用——errorsOut.push 下方会显示错误。
        const seedPath =
          (await probeSeedCache(pluginId, version)) ??
          (version === 'unknown'
            ? await probeSeedCacheAnyVersion(pluginId)
            : null)
        if (seedPath) {
          pluginPath = seedPath
          logForDebugging(
            `Using seed cache for external plugin ${entry.name} at ${seedPath}`,
          )
        } else {
          // 下载到临时位置，然后复制到带版本号的缓存
          const cached = await cachePlugin(entry.source, {
            manifest: { name: entry.name },
          })

          // 如果预克隆版本是确定性的（source.sha /
          // entry.version / installedVersion），复用它。克隆后
          // 用 cached.manifest 重新计算可能返回不同的值——
          // manifest.version（步骤 1）优先于 gitCommitSha（步骤 3）——
          // 这会导致缓存在例如 "2.0.0/" 而每次热启动
          // 探测 "{sha12}-{hash}/"。键不匹配 = 永远重新克隆。
          // 仅当预克隆为 'unknown'（ref 跟踪，无提示）时才需要
          // 重新计算——克隆是唯一的了解方式。
          const actualVersion =
            version !== 'unknown'
              ? version
              : await calculatePluginVersion(
                  pluginId,
                  entry.source,
                  cached.manifest,
                  cached.path,
                  installedVersion ?? entry.version,
                  cached.gitCommitSha,
                )

          // 复制到带版本号的缓存
          // 对于外部来源，marketplaceDir 不适用（已下载）
          pluginPath = await copyPluginToVersionedCache(
            cached.path,
            pluginId,
            actualVersion,
            entry,
            undefined,
          )

          // 清理临时路径
          if (cached.path !== pluginPath) {
            await rm(cached.path, { recursive: true, force: true })
          }
        }
      }
    } catch (error) {
      const errorMsg = errorMessage(error)
      logForDebugging(`Failed to cache plugin ${entry.name}: ${errorMsg}`, {
        level: 'error',
      })
      logError(toError(error))
      errorsOut.push({
        type: 'generic-error',
        source: pluginId,
        error: `Failed to download/cache plugin ${entry.name}: ${errorMsg}`,
      })
      return null
    }
  }

  // Zip 缓存模式：在加载前将 ZIP 提取到会话临时目录
  if (isPluginZipCacheEnabled() && pluginPath.endsWith('.zip')) {
    const sessionDir = await getSessionPluginCachePath()
    const extractDir = join(
      sessionDir,
      pluginId.replace(/[^a-zA-Z0-9@\-_]/g, '-'),
    )
    try {
      await extractZipToDirectory(pluginPath, extractDir)
      logForDebugging(`Extracted plugin ZIP to session dir: ${extractDir}`)
      pluginPath = extractDir
    } catch (error) {
      // 损坏的 ZIP：删除它以便下次安装尝试重新创建
      logForDebugging(
        `Failed to extract plugin ZIP ${pluginPath}, deleting corrupt file: ${error}`,
      )
      await rm(pluginPath, { force: true }).catch(() => {})
      throw error
    }
  }

  return finishLoadingPluginFromPath(
    entry,
    pluginId,
    enabled,
    errorsOut,
    pluginPath,
  )
}

/**
 * loadPluginFromMarketplaceEntry 两种变体的共享尾部。
 *
 * 一旦 pluginPath 被解析（通过克隆、缓存或 installPath 查找），
 * 其余的加载——清单探测、createPluginFromPath、marketplace
 * 条目补充——是相同的。提取出来以便仅缓存路径
 * 不重复约 500 行代码。
 */
async function finishLoadingPluginFromPath(
  entry: PluginMarketplaceEntry,
  pluginId: string,
  enabled: boolean,
  errorsOut: PluginError[],
  pluginPath: string,
): Promise<LoadedPlugin | null> {
  const errors: PluginError[] = []

  // 检查 plugin.json 是否存在以确定是否应使用 marketplace 清单
  const manifestPath = join(pluginPath, '.claude-plugin', 'plugin.json')
  const hasManifest = await pathExists(manifestPath)

  const { plugin, errors: pluginErrors } = await createPluginFromPath(
    pluginPath,
    pluginId,
    enabled,
    entry.name,
    entry.strict ?? true, // 尊重 marketplace 条目的 strict 设置
  )
  errors.push(...pluginErrors)

  // 如果可用，从来源设置 sha（对于 github 和 url 来源类型）
  if (
    typeof entry.source === 'object' &&
    'sha' in entry.source &&
    entry.source.sha
  ) {
    plugin.sha = entry.source.sha
  }

  // 如果没有 plugin.json，使用 marketplace 条目作为清单（无论 strict 模式）
  if (!hasManifest) {
    plugin.manifest = {
      ...entry,
      id: undefined,
      source: undefined,
      strict: undefined,
    } as PluginManifest
    plugin.name = plugin.manifest.name

    // 处理 marketplace 条目中的命令
    if (entry.commands) {
      // 检查是否为对象映射
      const firstValue = Object.values(entry.commands)[0]
      if (
        typeof entry.commands === 'object' &&
        !Array.isArray(entry.commands) &&
        firstValue &&
        typeof firstValue === 'object' &&
        ('source' in firstValue || 'content' in firstValue)
      ) {
        // 对象映射格式
        const commandsMetadata: Record<string, CommandMetadata> = {}
        const validPaths: string[] = []

        // 并行化 pathExists 检查；按顺序处理结果。
        const entries = Object.entries(entry.commands)
        const checks = await Promise.all(
          entries.map(async ([commandName, metadata]) => {
            if (!metadata || typeof metadata !== 'object' || !metadata.source) {
              return { commandName, metadata, skip: true as const }
            }
            const fullPath = join(pluginPath, metadata.source)
            return {
              commandName,
              metadata,
              skip: false as const,
              fullPath,
              exists: await pathExists(fullPath),
            }
          }),
        )
        for (const check of checks) {
          if (check.skip) continue
          if (check.exists) {
            validPaths.push(check.fullPath)
            commandsMetadata[check.commandName] = check.metadata
          } else {
            logForDebugging(
              `Command ${check.commandName} path ${check.metadata.source} from marketplace entry not found at ${check.fullPath} for ${entry.name}`,
              { level: 'warn' },
            )
            logError(
              new Error(
                `Plugin component file not found: ${check.fullPath} for ${entry.name}`,
              ),
            )
            errors.push({
              type: 'path-not-found',
              source: pluginId,
              plugin: entry.name,
              path: check.fullPath,
              component: 'commands',
            })
          }
        }

        if (validPaths.length > 0) {
          plugin.commandsPaths = validPaths
          plugin.commandsMetadata = commandsMetadata
        }
      } else {
        // 路径或路径数组格式
        const commandPaths = Array.isArray(entry.commands)
          ? entry.commands
          : [entry.commands]

        // 并行化 pathExists 检查；按顺序处理结果。
        const checks = await Promise.all(
          commandPaths.map(async cmdPath => {
            if (typeof cmdPath !== 'string') {
              return { cmdPath, kind: 'invalid' as const }
            }
            const fullPath = join(pluginPath, cmdPath)
            return {
              cmdPath,
              kind: 'path' as const,
              fullPath,
              exists: await pathExists(fullPath),
            }
          }),
        )
        const validPaths: string[] = []
        for (const check of checks) {
          if (check.kind === 'invalid') {
            logForDebugging(
              `Unexpected command format in marketplace entry for ${entry.name}`,
              { level: 'error' },
            )
            continue
          }
          if (check.exists) {
            validPaths.push(check.fullPath)
          } else {
            logForDebugging(
              `Command path ${check.cmdPath} from marketplace entry not found at ${check.fullPath} for ${entry.name}`,
              { level: 'warn' },
            )
            logError(
              new Error(
                `Plugin component file not found: ${check.fullPath} for ${entry.name}`,
              ),
            )
            errors.push({
              type: 'path-not-found',
              source: pluginId,
              plugin: entry.name,
              path: check.fullPath,
              component: 'commands',
            })
          }
        }

        if (validPaths.length > 0) {
          plugin.commandsPaths = validPaths
        }
      }
    }

    // 处理 marketplace 条目中的 agents
    if (entry.agents) {
      const agentPaths = Array.isArray(entry.agents)
        ? entry.agents
        : [entry.agents]

      const validPaths = await validatePluginPaths(
        agentPaths,
        pluginPath,
        entry.name,
        pluginId,
        'agents',
        'Agent',
        'from marketplace entry',
        errors,
      )

      if (validPaths.length > 0) {
        plugin.agentsPaths = validPaths
      }
    }

    // 处理 marketplace 条目中的 skills
    if (entry.skills) {
      logForDebugging(
        `Processing ${Array.isArray(entry.skills) ? entry.skills.length : 1} skill paths for plugin ${entry.name}`,
      )
      const skillPaths = Array.isArray(entry.skills)
        ? entry.skills
        : [entry.skills]

      // 并行化 pathExists 检查；按顺序处理结果。
      // 注意：此前此循环在每次迭代中调用 pathExists() 两次
      // (once in a debug log template, once in the if) — now called once.
      const checks = await Promise.all(
        skillPaths.map(async skillPath => {
          const fullPath = join(pluginPath, skillPath)
          return { skillPath, fullPath, exists: await pathExists(fullPath) }
        }),
      )
      const validPaths: string[] = []
      for (const { skillPath, fullPath, exists } of checks) {
        logForDebugging(
          `Checking skill path: ${skillPath} -> ${fullPath} (exists: ${exists})`,
        )
        if (exists) {
          validPaths.push(fullPath)
        } else {
          logForDebugging(
            `Skill path ${skillPath} from marketplace entry not found at ${fullPath} for ${entry.name}`,
            { level: 'warn' },
          )
          logError(
            new Error(
              `Plugin component file not found: ${fullPath} for ${entry.name}`,
            ),
          )
          errors.push({
            type: 'path-not-found',
            source: pluginId,
            plugin: entry.name,
            path: fullPath,
            component: 'skills',
          })
        }
      }

      logForDebugging(
        `Found ${validPaths.length} valid skill paths for plugin ${entry.name}, setting skillsPaths`,
      )
      if (validPaths.length > 0) {
        plugin.skillsPaths = validPaths
      }
    } else {
      logForDebugging(`Plugin ${entry.name} has no entry.skills defined`)
    }

    // 处理 marketplace 条目中的 output styles
    if (entry.outputStyles) {
      const outputStylePaths = Array.isArray(entry.outputStyles)
        ? entry.outputStyles
        : [entry.outputStyles]

      const validPaths = await validatePluginPaths(
        outputStylePaths,
        pluginPath,
        entry.name,
        pluginId,
        'output-styles',
        'Output style',
        'from marketplace entry',
        errors,
      )

      if (validPaths.length > 0) {
        plugin.outputStylesPaths = validPaths
      }
    }

    // 处理 marketplace 条目中的内联 hooks
    if (entry.hooks) {
      plugin.hooksConfig = entry.hooks as HooksSettings
    }
  } else if (
    !entry.strict &&
    hasManifest &&
    (entry.commands ||
      entry.agents ||
      entry.skills ||
      entry.hooks ||
      entry.outputStyles)
  ) {
    // 在非严格模式下有 plugin.json 时，marketplace 条目中的 commands/agents/skills/hooks/outputStyles 是冲突
    const error = new Error(
      `Plugin ${entry.name} has both plugin.json and marketplace manifest entries for commands/agents/skills/hooks/outputStyles. This is a conflict.`,
    )
    logForDebugging(
      `Plugin ${entry.name} has both plugin.json and marketplace manifest entries for commands/agents/skills/hooks/outputStyles. This is a conflict.`,
      { level: 'error' },
    )
    logError(error)
    errorsOut.push({
      type: 'generic-error',
      source: pluginId,
      error: `Plugin ${entry.name} has conflicting manifests: both plugin.json and marketplace entry specify components. Set strict: true in marketplace entry or remove component specs from one location.`,
    })
    return null
  } else if (hasManifest) {
    // 有 plugin.json - marketplace 可以补充 commands/agents/skills/hooks/outputStyles

    // 从 marketplace 条目补充 commands
    if (entry.commands) {
      // 检查是否为对象映射
      const firstValue = Object.values(entry.commands)[0]
      if (
        typeof entry.commands === 'object' &&
        !Array.isArray(entry.commands) &&
        firstValue &&
        typeof firstValue === 'object' &&
        ('source' in firstValue || 'content' in firstValue)
      ) {
        // 对象映射格式 - merge metadata
        const commandsMetadata: Record<string, CommandMetadata> = {
          ...(plugin.commandsMetadata || {}),
        }
        const validPaths: string[] = []

        // 并行化 pathExists 检查；按顺序处理结果。
        const entries = Object.entries(entry.commands)
        const checks = await Promise.all(
          entries.map(async ([commandName, metadata]) => {
            if (!metadata || typeof metadata !== 'object' || !metadata.source) {
              return { commandName, metadata, skip: true as const }
            }
            const fullPath = join(pluginPath, metadata.source)
            return {
              commandName,
              metadata,
              skip: false as const,
              fullPath,
              exists: await pathExists(fullPath),
            }
          }),
        )
        for (const check of checks) {
          if (check.skip) continue
          if (check.exists) {
            validPaths.push(check.fullPath)
            commandsMetadata[check.commandName] = check.metadata
          } else {
            logForDebugging(
              `Command ${check.commandName} path ${check.metadata.source} from marketplace entry not found at ${check.fullPath} for ${entry.name}`,
              { level: 'warn' },
            )
            logError(
              new Error(
                `Plugin component file not found: ${check.fullPath} for ${entry.name}`,
              ),
            )
            errors.push({
              type: 'path-not-found',
              source: pluginId,
              plugin: entry.name,
              path: check.fullPath,
              component: 'commands',
            })
          }
        }

        if (validPaths.length > 0) {
          plugin.commandsPaths = [
            ...(plugin.commandsPaths || []),
            ...validPaths,
          ]
          plugin.commandsMetadata = commandsMetadata
        }
      } else {
        // 路径或路径数组格式
        const commandPaths = Array.isArray(entry.commands)
          ? entry.commands
          : [entry.commands]

        // 并行化 pathExists 检查；按顺序处理结果。
        const checks = await Promise.all(
          commandPaths.map(async cmdPath => {
            if (typeof cmdPath !== 'string') {
              return { cmdPath, kind: 'invalid' as const }
            }
            const fullPath = join(pluginPath, cmdPath)
            return {
              cmdPath,
              kind: 'path' as const,
              fullPath,
              exists: await pathExists(fullPath),
            }
          }),
        )
        const validPaths: string[] = []
        for (const check of checks) {
          if (check.kind === 'invalid') {
            logForDebugging(
              `Unexpected command format in marketplace entry for ${entry.name}`,
              { level: 'error' },
            )
            continue
          }
          if (check.exists) {
            validPaths.push(check.fullPath)
          } else {
            logForDebugging(
              `Command path ${check.cmdPath} from marketplace entry not found at ${check.fullPath} for ${entry.name}`,
              { level: 'warn' },
            )
            logError(
              new Error(
                `Plugin component file not found: ${check.fullPath} for ${entry.name}`,
              ),
            )
            errors.push({
              type: 'path-not-found',
              source: pluginId,
              plugin: entry.name,
              path: check.fullPath,
              component: 'commands',
            })
          }
        }

        if (validPaths.length > 0) {
          plugin.commandsPaths = [
            ...(plugin.commandsPaths || []),
            ...validPaths,
          ]
        }
      }
    }

    // 从 marketplace 条目补充 agents
    if (entry.agents) {
      const agentPaths = Array.isArray(entry.agents)
        ? entry.agents
        : [entry.agents]

      const validPaths = await validatePluginPaths(
        agentPaths,
        pluginPath,
        entry.name,
        pluginId,
        'agents',
        'Agent',
        'from marketplace entry',
        errors,
      )

      if (validPaths.length > 0) {
        plugin.agentsPaths = [...(plugin.agentsPaths || []), ...validPaths]
      }
    }

    // 从 marketplace 条目补充 skills
    if (entry.skills) {
      const skillPaths = Array.isArray(entry.skills)
        ? entry.skills
        : [entry.skills]

      const validPaths = await validatePluginPaths(
        skillPaths,
        pluginPath,
        entry.name,
        pluginId,
        'skills',
        'Skill',
        'from marketplace entry',
        errors,
      )

      if (validPaths.length > 0) {
        plugin.skillsPaths = [...(plugin.skillsPaths || []), ...validPaths]
      }
    }

    // 从 marketplace 条目补充 output styles
    if (entry.outputStyles) {
      const outputStylePaths = Array.isArray(entry.outputStyles)
        ? entry.outputStyles
        : [entry.outputStyles]

      const validPaths = await validatePluginPaths(
        outputStylePaths,
        pluginPath,
        entry.name,
        pluginId,
        'output-styles',
        'Output style',
        'from marketplace entry',
        errors,
      )

      if (validPaths.length > 0) {
        plugin.outputStylesPaths = [
          ...(plugin.outputStylesPaths || []),
          ...validPaths,
        ]
      }
    }

    // 从 marketplace 条目补充 hooks
    if (entry.hooks) {
      plugin.hooksConfig = {
        ...(plugin.hooksConfig || {}),
        ...(entry.hooks as HooksSettings),
      }
    }
  }

  errorsOut.push(...errors)
  return plugin
}

/**
 * 从 --plugin-dir CLI 标志加载仅会话插件。
 *
 * 这些插件直接加载而不经过 marketplace 系统。
 * 它们以 source='plugin-name@inline' 出现，并在当前会话中始终启用。
 *
 * @param sessionPluginPaths - 来自 CLI 的插件目录路径数组
 * @returns LoadedPlugin 对象和遇到的任何错误
 */
async function loadSessionOnlyPlugins(
  sessionPluginPaths: Array<string>,
): Promise<{ plugins: LoadedPlugin[]; errors: PluginError[] }> {
  if (sessionPluginPaths.length === 0) {
    return { plugins: [], errors: [] }
  }

  const plugins: LoadedPlugin[] = []
  const errors: PluginError[] = []

  for (const [index, pluginPath] of sessionPluginPaths.entries()) {
    try {
      const resolvedPath = resolve(pluginPath)

      if (!(await pathExists(resolvedPath))) {
        logForDebugging(
          `Plugin path does not exist: ${resolvedPath}, skipping`,
          { level: 'warn' },
        )
        errors.push({
          type: 'path-not-found',
          source: `inline[${index}]`,
          path: resolvedPath,
          component: 'commands',
        })
        continue
      }

      const dirName = basename(resolvedPath)
      const { plugin, errors: pluginErrors } = await createPluginFromPath(
        resolvedPath,
        `${dirName}@inline`, // 临时的，知道真实名称后会更新
        true, // 始终启用
        dirName,
      )

      // 更新来源以使用清单中的实际插件名称
      plugin.source = `${plugin.name}@inline`
      plugin.repository = `${plugin.name}@inline`

      plugins.push(plugin)
      errors.push(...pluginErrors)

      logForDebugging(`Loaded inline plugin from path: ${plugin.name}`)
    } catch (error) {
      const errorMsg = errorMessage(error)
      logForDebugging(
        `Failed to load session plugin from ${pluginPath}: ${errorMsg}`,
        { level: 'warn' },
      )
      errors.push({
        type: 'generic-error',
        source: `inline[${index}]`,
        error: `Failed to load plugin: ${errorMsg}`,
      })
    }
  }

  if (plugins.length > 0) {
    logForDebugging(
      `Loaded ${plugins.length} session-only plugins from --plugin-dir`,
    )
  }

  return { plugins, errors }
}

/**
 * 合并来自会话（--plugin-dir）、marketplace（已安装）和
 * 内置来源的插件。会话插件覆盖同名的 marketplace 插件——
 * 用户在此会话中明确指向了一个目录。
 *
 * 例外：被托管设置（policySettings）锁定的 marketplace 插件
 * 不能被覆盖。企业管理员意图优先于本地开发便利性。
 * 当会话插件与托管插件冲突时，会话副本被丢弃
 * 并返回错误以供显示。
 *
 * 没有此去重，两个版本都坐在数组中，marketplace 在
 * 首次匹配时获胜，使 --plugin-dir 对于迭代已安装插件变得无用。
 */
export function mergePluginSources(sources: {
  session: LoadedPlugin[]
  marketplace: LoadedPlugin[]
  builtin: LoadedPlugin[]
  managedNames?: Set<string> | null
}): { plugins: LoadedPlugin[]; errors: PluginError[] } {
  const errors: PluginError[] = []
  const managed = sources.managedNames

  // 托管设置优先于 --plugin-dir。丢弃名称出现在
  // policySettings.enabledPlugins 中的会话插件（无论是强制启用
  // 还是强制禁用——两者都是 --plugin-dir 不得绕过的管理员意图）。
  // 显示错误以便用户知道他们的开发副本为何被忽略。
  //
  // 注意：managedNames 包含 pluginId 前缀（entry.name），
  // 按惯例应等于 manifest.name（schemas.ts 中
  // PluginMarketplaceEntry.name 的 schema 描述）。如果 marketplace 发布的
  // 插件 entry.name ≠ manifest.name，此守卫将静默错过——
  // 但那是破坏其他功能的 marketplace 配置错误
  // （例如，ManagePlugins 从 manifest.name 构建 pluginId）。
  const sessionPlugins = sources.session.filter(p => {
    if (managed?.has(p.name)) {
      logForDebugging(
        `Plugin "${p.name}" from --plugin-dir is blocked by managed settings`,
        { level: 'warn' },
      )
      errors.push({
        type: 'generic-error',
        source: p.source,
        plugin: p.name,
        error: `--plugin-dir copy of "${p.name}" ignored: plugin is locked by managed settings`,
      })
      return false
    }
    return true
  })

  const sessionNames = new Set(sessionPlugins.map(p => p.name))
  const marketplacePlugins = sources.marketplace.filter(p => {
    if (sessionNames.has(p.name)) {
      logForDebugging(
        `Plugin "${p.name}" from --plugin-dir overrides installed version`,
      )
      return false
    }
    return true
  })
  // 会话优先，然后未被覆盖的 marketplace，最后内置。
  // 下游的首次匹配消费者在已安装的插件之前看到会话插件，
  // 对于任何通过名称过滤器的插件。
  return {
    plugins: [...sessionPlugins, ...marketplacePlugins, ...sources.builtin],
    errors,
  }
}

/**
 * 发现和加载所有插件的主插件加载函数。
 *
 * 此函数被记忆化以避免重复的文件系统扫描，是
 * 插件系统的主要入口点。它从多个来源发现插件
 * 并返回分类结果。
 *
 * 加载顺序和优先级（参见 mergePluginSources）：
 * 1. 仅会话插件（来自 --plugin-dir CLI 标志）— 覆盖
 *    同名的已安装插件，除非该插件被
 *    托管设置锁定（policySettings，无论是强制启用
 *    还是强制禁用）
 * 2. 基于 marketplace 的插件（settings 中的 plugin@marketplace 格式）
 * 3. 随 CLI 一起发布的内置插件
 *
 * 名称冲突：会话插件优先于已安装的。用户明确
 * 在此会话中指向了一个目录——该意图优先于任何
 * 已安装的内容。例外：托管设置（企业策略）优先于
 * --plugin-dir。管理员意图优先于本地开发便利性。
 *
 * 错误收集：
 * - 非致命错误被收集并返回
 * - 系统在出错时继续加载其他插件
 * - 错误包含来源信息以便调试
 *
 * @returns Promise 解析为分类的插件结果：
 *   - enabled: 已启用的 LoadedPlugin 对象数组
 *   - disabled: 已禁用的 LoadedPlugin 对象数组
 *   - errors: 包含来源信息的加载错误数组
 */
export const loadAllPlugins = memoize(async (): Promise<PluginLoadResult> => {
  const result = await assemblePluginLoadResult(() =>
    loadPluginsFromMarketplaces({ cacheOnly: false }),
  )
  // 新的完整加载结果对仅缓存的调用者严格有效
  // （两种变体共享 assemblePluginLoadResult）。预热单独的
  // 记忆化以便 refreshActivePlugins() 的下游 getPluginCommands() /
  // getAgentDefinitionsWithOverrides() — 现在调用
  // loadAllPluginsCacheOnly — 看到刚克隆的插件而非读取
  // 会话中无人写入的 installed_plugins.json。
  loadAllPluginsCacheOnly.cache?.set(undefined, Promise.resolve(result))
  return result
})

/**
 * loadAllPlugins 的仅缓存变体。
 *
 * 相同的合并/依赖/设置逻辑，但 marketplace 加载器永不
 * 访问网络（无 cachePlugin，无 copyPluginToVersionedCache）。从
 * installed_plugins.json 的 installPath 读取。不在磁盘上的插件发出
 * 'plugin-cache-miss' 并被跳过。
 *
 * 在启动消费者中使用此函数（getCommands、loadPluginAgents、MCP/LSP
 * 配置），以便交互式启动永不在 ref 跟踪插件的 git 克隆上阻塞。
 * 在显式刷新路径中使用 loadAllPlugins()（/plugins、
 * refresh.ts、headlessPluginInstall），其中新鲜来源是意图。
 *
 * CLAUDE_CODE_SYNC_PLUGIN_INSTALL=1 委托给完整加载器——该
 * 模式明确选择首次查询前阻塞安装，且
 * main.tsx 的 getClaudeCodeMcpConfigs()/getInitialSettings().agent 在
 * runHeadless() 之前运行可以预热此缓存。首次运行的 CCR/headless 没有
 * installed_plugins.json，因此仅缓存会错过插件 MCP 服务器
 * 和插件设置（agent 键）。交互式启动的优势被保留
 * 因为交互模式不设置 SYNC_PLUGIN_INSTALL。
 *
 * 与 loadAllPlugins 单独的记忆化缓存——仅缓存结果绝不能
 * 满足想要新鲜来源的调用者。反向是有效的：
 * loadAllPlugins 在完成时预热此缓存，以便运行
 * 完整加载器的刷新路径不会从其下游
 * 仅缓存消费者处获得 plugin-cache-miss。
 */
export const loadAllPluginsCacheOnly = memoize(
  async (): Promise<PluginLoadResult> => {
    if (isEnvTruthy(process.env.CLAUDE_CODE_SYNC_PLUGIN_INSTALL)) {
      return loadAllPlugins()
    }
    return assemblePluginLoadResult(() =>
      loadPluginsFromMarketplaces({ cacheOnly: true }),
    )
  },
)

/**
 * loadAllPlugins 和 loadAllPluginsCacheOnly 的共享主体。
 *
 * 两者之间的唯一区别是运行哪个 marketplace 加载器——
 * 会话插件、内置插件、合并、verifyAndDemote 和 cachePluginSettings
 * 完全相同（不变量 1-3）。
 */
async function assemblePluginLoadResult(
  marketplaceLoader: () => Promise<{
    plugins: LoadedPlugin[]
    errors: PluginError[]
  }>,
): Promise<PluginLoadResult> {
  // 并行加载 marketplace 插件和仅会话插件。
  // getInlinePlugins() 是同步状态读取，不依赖于
  // marketplace 加载，因此这两个来源可以并发获取。
  const inlinePlugins = getInlinePlugins()
  const [marketplaceResult, sessionResult] = await Promise.all([
    marketplaceLoader(),
    inlinePlugins.length > 0
      ? loadSessionOnlyPlugins(inlinePlugins)
      : Promise.resolve({ plugins: [], errors: [] }),
  ])
  // 3. 加载随 CLI 一起发布的内置插件
  const builtinResult = getBuiltinPlugins()

  // 会话插件（--plugin-dir）按名称覆盖已安装的插件，
  // 除非已安装的插件被托管设置锁定
  // （policySettings）。详见 mergePluginSources()。
  const { plugins: allPlugins, errors: mergeErrors } = mergePluginSources({
    session: sessionResult.plugins,
    marketplace: marketplaceResult.plugins,
    builtin: [...builtinResult.enabled, ...builtinResult.disabled],
    managedNames: getManagedPluginNames(),
  })
  const allErrors = [
    ...marketplaceResult.errors,
    ...sessionResult.errors,
    ...mergeErrors,
  ]

  // 验证依赖关系。在并行加载之后运行——依赖是存在性
  // 检查，而非加载顺序，因此不需要拓扑排序。降级是
  // 会话本地的：不写入设置（用户通过 /doctor 修复意图）。
  const { demoted, errors: depErrors } = verifyAndDemote(allPlugins)
  for (const p of allPlugins) {
    if (demoted.has(p.source)) p.enabled = false
  }
  allErrors.push(...depErrors)

  const enabledPlugins = allPlugins.filter(p => p.enabled)
  logForDebugging(
    `Found ${allPlugins.length} plugins (${enabledPlugins.length} enabled, ${allPlugins.length - enabledPlugins.length} disabled)`,
  )

  // 3. 缓存插件设置以便设置级联同步访问
  cachePluginSettings(enabledPlugins)

  return {
    enabled: enabledPlugins,
    disabled: allPlugins.filter(p => !p.enabled),
    errors: allErrors,
  }
}

/**
 * 清除记忆化的插件缓存。
 *
 * 在插件安装、移除或设置更改时调用此函数
 * 以在下次 loadAllPlugins 调用时强制重新扫描。
 *
 * 使用场景：
 * - 安装/卸载插件后
 * - 修改 .claude-plugin/ 目录后（用于导出）
 * - 更改 enabledPlugins 设置后
 * - 调试插件加载问题时
 */
export function clearPluginCache(reason?: string): void {
  if (reason) {
    logForDebugging(
      `clearPluginCache: invalidating loadAllPlugins cache (${reason})`,
    )
  }
  loadAllPlugins.cache?.clear?.()
  loadAllPluginsCacheOnly.cache?.clear?.()
  // 如果插件之前贡献了设置，会话设置缓存
  // 保存包含它们的合并结果。重新加载时的 cachePluginSettings()
  // 在新基础为空时不会破坏缓存（启动性能优势），
  // 因此在此处破坏它以删除过时的插件覆盖。当基础已经是
  // undefined（启动时，或没有之前的插件设置）时，这是无操作。
  if (getPluginSettingsBase() !== undefined) {
    resetSettingsCache()
  }
  clearPluginSettingsBase()
  // TODO: 在 installedPluginsManager 实现后清除已安装插件缓存
}

/**
 * 将所有已启用插件的设置合并为单个记录。
 * 对于相同的键，后续插件覆盖前面的插件。
 * 仅包含白名单中的键（过滤在加载时发生）。
 */
function mergePluginSettings(
  plugins: LoadedPlugin[],
): Record<string, unknown> | undefined {
  let merged: Record<string, unknown> | undefined

  for (const plugin of plugins) {
    if (!plugin.settings) {
      continue
    }

    if (!merged) {
      merged = {}
    }

    for (const [key, value] of Object.entries(plugin.settings)) {
      if (key in merged) {
        logForDebugging(
          `Plugin "${plugin.name}" overrides setting "${key}" (previously set by another plugin)`,
        )
      }
      merged[key] = value
    }
  }

  return merged
}

/**
 * 将合并的插件设置存储到同步缓存中。
 * 在 loadAllPlugins 解析后调用。
 */
export function cachePluginSettings(plugins: LoadedPlugin[]): void {
  const settings = mergePluginSettings(plugins)
  setPluginSettingsBase(settings)
  // 仅当实际上有插件设置要合并时才破坏会话设置缓存。
  // 在常见情况下（没有插件，或插件没有设置），基础层为空
  // 且 loadSettingsFromDisk 无论如何都会产生相同的结果——
  // 在此处重置会在下次 getSettingsWithErrors() 调用时浪费约 17ms
  // 重新读取和重新验证每个设置文件。
  if (settings && Object.keys(settings).length > 0) {
    resetSettingsCache()
    logForDebugging(
      `Cached plugin settings with keys: ${Object.keys(settings).join(', ')}`,
    )
  }
}

/**
 * 类型谓词：检查值是否为非空、非数组对象（即记录）。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
