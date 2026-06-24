import axios from 'axios'
import { constants as fsConstants } from 'fs'
import { access, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { getDynamicConfig_BLOCKS_ON_INIT } from 'src/services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { type ReleaseChannel, saveGlobalConfig } from './config.js'
import { logForDebugging } from './debug.js'
import { env } from './env.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { ClaudeError, getErrnoCode, isENOENT } from './errors.js'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { getFsImplementation } from './fsOperations.js'
import { gracefulShutdownSync } from './gracefulShutdown.js'
import { logError } from './log.js'
import { gte, lt } from './semver.js'
import { getInitialSettings } from './settings/settings.js'
import {
  filterClaudeAliases,
  getShellConfigPaths,
  readFileLines,
  writeFileLines,
} from './shellConfig.js'
import { jsonParse } from './slowOperations.js'

const GCS_BUCKET_URL =
  'https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases'

class AutoUpdaterError extends ClaudeError {}

export type InstallStatus =
  | 'success'
  | 'no_permissions'
  | 'install_failed'
  | 'in_progress'

export type AutoUpdaterResult = {
  version: string | null
  status: InstallStatus
  notifications?: string[]
}

export type MaxVersionConfig = {
  external?: string
  ant?: string
  external_message?: string
  ant_message?: string
}

/**
 * 检查当前版本是否满足 Statsig 配置中的最低要求版本。
 * 如果版本过旧则终止进程并显示错误消息。
 *
 * 关于基于 SHA 的版本控制说明：
 * 我们使用符合 SemVer 规范的版本控制，采用构建元数据格式（X.X.X+SHA）用于持续部署。
 * 根据 SemVer 规范，构建元数据（+SHA 部分）在比较版本时会被忽略。
 *
 * 版本控制方法：
 * 1. 对于版本要求/兼容性检查（assertMinVersion），使用忽略构建元数据的 semver 比较
 * 2. 对于更新（'claude update'），使用精确字符串比较来检测任何更改，包括 SHA
 *    - 这确保用户始终获得最新构建，即使只有 SHA 发生变化
 *    - UI 会清晰地显示包含构建元数据的两个版本
 *
 * 该方法保持版本比较逻辑简单，同时通过 SHA 维护可追溯性。
 */
export async function assertMinVersion(): Promise<void> {
  if (process.env.NODE_ENV === 'test') {
    return
  }

  try {
    const versionConfig = await getDynamicConfig_BLOCKS_ON_INIT<{
      minVersion: string
    }>('tengu_version_config', { minVersion: '0.0.0' })

    if (
      versionConfig.minVersion &&
      lt(MACRO.VERSION, versionConfig.minVersion)
    ) {
      console.error(`
It looks like your version of Claude Code (${MACRO.VERSION}) needs an update.
A newer version (${versionConfig.minVersion} or higher) is required to continue.

To update, please run:
    claude update

This will ensure you have access to the latest features and improvements.
`)
      gracefulShutdownSync(1)
    }
  } catch (error) {
    logError(error as Error)
  }
}

/**
 * 返回当前用户类型允许的最高版本。
 * 对于 ant 用户，返回 `ant` 字段（开发版本格式）。
 * 对于外部用户，返回 `external` 字段（干净的 semver）。
 * 用作服务端 kill switch 以在事故期间暂停自动更新。
 * 如果未配置上限则返回 undefined。
 */
export async function getMaxVersion(): Promise<string | undefined> {
  const config = await getMaxVersionConfig()
  if (process.env.USER_TYPE === 'ant') {
    return config.ant || undefined
  }
  return config.external || undefined
}

/**
 * 返回服务端驱动的已知问题说明消息（如果已配置）。
 * 当当前版本超过允许的最高版本时显示在警告横幅中。
 */
export async function getMaxVersionMessage(): Promise<string | undefined> {
  const config = await getMaxVersionConfig()
  if (process.env.USER_TYPE === 'ant') {
    return config.ant_message || undefined
  }
  return config.external_message || undefined
}

async function getMaxVersionConfig(): Promise<MaxVersionConfig> {
  try {
    return await getDynamicConfig_BLOCKS_ON_INIT<MaxVersionConfig>(
      'tengu_max_version_config',
      {},
    )
  } catch (error) {
    logError(error as Error)
    return {}
  }
}

/**
 * 检查是否应因用户的 minimumVersion 设置跳过目标版本。
 * 用于切换到 stable 渠道时 —— 用户可以选择停留在当前版本，
 * 直到 stable 追上来，以防止降级。
 */
export function shouldSkipVersion(targetVersion: string): boolean {
  const settings = getInitialSettings()
  const minimumVersion = settings?.minimumVersion
  if (!minimumVersion) {
    return false
  }
  // 如果目标版本低于最低版本则跳过
  const shouldSkip = !gte(targetVersion, minimumVersion)
  if (shouldSkip) {
    logForDebugging(
      `Skipping update to ${targetVersion} - below minimumVersion ${minimumVersion}`,
    )
  }
  return shouldSkip
}

// 自动更新器的锁文件，用于防止并发更新
const LOCK_TIMEOUT_MS = 5 * 60 * 1000 // 5 分钟锁超时时间

/**
 * 获取锁文件路径。
 * 使用函数形式以确保在测试设置后于运行时求值。
 */
export function getLockFilePath(): string {
  return join(getClaudeConfigHomeDir(), '.update.lock')
}

/**
 * 尝试为自动更新器获取锁。
 * @returns 获取锁成功返回 true，另一进程持有锁则返回 false。
 */
async function acquireLock(): Promise<boolean> {
  const fs = getFsImplementation()
  const lockPath = getLockFilePath()

  // 检查现有锁：正常路径（全新锁或 ENOENT）1 次 stat()，
  // 陈旧锁恢复时（在 unlink 前立即重新验证过期状态）2 次 stat()。
  try {
    const stats = await fs.stat(lockPath)
    const age = Date.now() - stats.mtimeMs
    if (age < LOCK_TIMEOUT_MS) {
      return false
    }
    // 锁已过期，接管前先移除。在 unlink 前立即重新验证过期状态，
    // 以关闭 TOCTOU 竞争：如果两个进程都观察到过期锁，A unlink + 写入新锁，
    // 然后 B 会 unlink A 的新锁，导致双方都认为自己持有锁。
    // 新锁有近期的 mtime，重新检查过期状态使 B 退出。
    try {
      const recheck = await fs.stat(lockPath)
      if (Date.now() - recheck.mtimeMs < LOCK_TIMEOUT_MS) {
        return false
      }
      await fs.unlink(lockPath)
    } catch (err) {
      if (!isENOENT(err)) {
        logError(err as Error)
        return false
      }
    }
  } catch (err) {
    if (!isENOENT(err)) {
      logError(err as Error)
      return false
    }
    // ENOENT：无锁文件，继续创建一个
  }

  // 使用 O_EXCL（flag: 'wx'）原子地创建锁文件。如果另一个进程
  // 抢先创建，我们会得到 EEXIST 并退出。ENOENT 时懒惰地创建 config 目录。
  try {
    await writeFile(lockPath, `${process.pid}`, {
      encoding: 'utf8',
      flag: 'wx',
    })
    return true
  } catch (err) {
    const code = getErrnoCode(err)
    if (code === 'EEXIST') {
      return false
    }
    if (code === 'ENOENT') {
      try {
        // getFsImplementation() 中的 fs.mkdir 始终是 recursive:true 且
        // 内部吞掉 EEXIST，因此目录创建竞争不会到达下方的 catch ——
        // 只有 writeFile 的 EEXIST（真正的锁竞争）才会到达。
        await fs.mkdir(getClaudeConfigHomeDir())
        await writeFile(lockPath, `${process.pid}`, {
          encoding: 'utf8',
          flag: 'wx',
        })
        return true
      } catch (mkdirErr) {
        if (getErrnoCode(mkdirErr) === 'EEXIST') {
          return false
        }
        logError(mkdirErr as Error)
        return false
      }
    }
    logError(err as Error)
    return false
  }
}

/**
 * 如果此进程持有更新锁则释放它。
 */
async function releaseLock(): Promise<void> {
  const fs = getFsImplementation()
  const lockPath = getLockFilePath()
  try {
    const lockData = await fs.readFile(lockPath, { encoding: 'utf8' })
    if (lockData === `${process.pid}`) {
      await fs.unlink(lockPath)
    }
  } catch (err) {
    if (isENOENT(err)) {
      return
    }
    logError(err as Error)
  }
}

async function getInstallationPrefix(): Promise<string | null> {
  // 从 home 目录运行，避免读取项目级 .npmrc/.bunfig.toml
  const isBun = env.isRunningWithBun()
  let prefixResult = null
  if (isBun) {
    prefixResult = await execFileNoThrowWithCwd('bun', ['pm', 'bin', '-g'], {
      cwd: homedir(),
    })
  } else {
    prefixResult = await execFileNoThrowWithCwd(
      'npm',
      ['-g', 'config', 'get', 'prefix'],
      { cwd: homedir() },
    )
  }
  if (prefixResult.code !== 0) {
    logError(new Error(`Failed to check ${isBun ? 'bun' : 'npm'} permissions`))
    return null
  }
  return prefixResult.stdout.trim()
}

export async function checkGlobalInstallPermissions(): Promise<{
  hasPermissions: boolean
  npmPrefix: string | null
}> {
  try {
    const prefix = await getInstallationPrefix()
    if (!prefix) {
      return { hasPermissions: false, npmPrefix: null }
    }

    try {
      await access(prefix, fsConstants.W_OK)
      return { hasPermissions: true, npmPrefix: prefix }
    } catch {
      logError(
        new AutoUpdaterError(
          'Insufficient permissions for global npm install.',
        ),
      )
      return { hasPermissions: false, npmPrefix: prefix }
    }
  } catch (error) {
    logError(error as Error)
    return { hasPermissions: false, npmPrefix: null }
  }
}

export async function getLatestVersion(
  channel: ReleaseChannel,
): Promise<string | null> {
  const npmTag = channel === 'stable' ? 'stable' : 'latest'

  // 从 home 目录运行，避免读取项目级 .npmrc，
  // 该文件可能被恶意构造以重定向到攻击者的 registry
  const result = await execFileNoThrowWithCwd(
    'npm',
    ['view', `${MACRO.PACKAGE_URL}@${npmTag}`, 'version', '--prefer-online'],
    { abortSignal: AbortSignal.timeout(5000), cwd: homedir() },
  )
  if (result.code !== 0) {
    logForDebugging(`npm view failed with code ${result.code}`)
    if (result.stderr) {
      logForDebugging(`npm stderr: ${result.stderr.trim()}`)
    } else {
      logForDebugging('npm stderr: (empty)')
    }
    if (result.stdout) {
      logForDebugging(`npm stdout: ${result.stdout.trim()}`)
    }
    return null
  }
  return result.stdout.trim()
}

export type NpmDistTags = {
  latest: string | null
  stable: string | null
}

/**
 * 从 registry 获取 npm dist-tags（最新版本和稳定版本）。
 * 用于 doctor 命令向用户显示可用版本。
 */
export async function getNpmDistTags(): Promise<NpmDistTags> {
  // 从 home 目录运行，避免读取项目级 .npmrc
  const result = await execFileNoThrowWithCwd(
    'npm',
    ['view', MACRO.PACKAGE_URL, 'dist-tags', '--json', '--prefer-online'],
    { abortSignal: AbortSignal.timeout(5000), cwd: homedir() },
  )

  if (result.code !== 0) {
    logForDebugging(`npm view dist-tags failed with code ${result.code}`)
    return { latest: null, stable: null }
  }

  try {
    const parsed = jsonParse(result.stdout.trim()) as Record<string, unknown>
    return {
      latest: typeof parsed.latest === 'string' ? parsed.latest : null,
      stable: typeof parsed.stable === 'string' ? parsed.stable : null,
    }
  } catch (error) {
    logForDebugging(`Failed to parse dist-tags: ${error}`)
    return { latest: null, stable: null }
  }
}

/**
 * 从 GCS bucket 获取给定发布渠道的最新版本。
 * 用于没有 npm 的安装（例如包管理器安装）。
 */
export async function getLatestVersionFromGcs(
  channel: ReleaseChannel,
): Promise<string | null> {
  try {
    const response = await axios.get(`${GCS_BUCKET_URL}/${channel}`, {
      timeout: 5000,
      responseType: 'text',
    })
    return response.data.trim()
  } catch (error) {
    logForDebugging(`Failed to fetch ${channel} from GCS: ${error}`)
    return null
  }
}

/**
 * 从 GCS bucket 获取可用版本（用于原生安装）。
 * 同时获取最新版和稳定版渠道指针。
 */
export async function getGcsDistTags(): Promise<NpmDistTags> {
  const [latest, stable] = await Promise.all([
    getLatestVersionFromGcs('latest'),
    getLatestVersionFromGcs('stable'),
  ])

  return { latest, stable }
}

/**
 * 从 npm registry 获取版本历史（仅 ant 功能）。
 * 返回按最新优先排序的版本列表，限制到指定数量。
 *
 * 优先使用 NATIVE_PACKAGE_URL 的原因：
 * 1. 原生安装是 ant 用户的主要安装方式
 * 2. 并非所有 JS 包版本都有对应的原生包
 * 3. 这可以防止回滚列出没有原生二进制的版本
 */
export async function getVersionHistory(limit: number): Promise<string[]> {
  if (process.env.USER_TYPE !== 'ant') {
    return []
  }

  // 优先使用原生包 URL，以确保只显示有原生二进制的版本
  //（并非所有 JS 包版本都有原生构建）
  const packageUrl = MACRO.NATIVE_PACKAGE_URL ?? MACRO.PACKAGE_URL

  // 从 home 目录运行，避免读取项目级 .npmrc
  const result = await execFileNoThrowWithCwd(
    'npm',
    ['view', packageUrl, 'versions', '--json', '--prefer-online'],
    // 版本列表使用更长的超时时间
    { abortSignal: AbortSignal.timeout(30000), cwd: homedir() },
  )

  if (result.code !== 0) {
    logForDebugging(`npm view versions failed with code ${result.code}`)
    if (result.stderr) {
      logForDebugging(`npm stderr: ${result.stderr.trim()}`)
    }
    return []
  }

  try {
    const versions = jsonParse(result.stdout.trim()) as string[]
    // 取最后 N 个版本，然后反转以按最新优先排列
    return versions.slice(-limit).reverse()
  } catch (error) {
    logForDebugging(`Failed to parse version history: ${error}`)
    return []
  }
}

export async function installGlobalPackage(
  specificVersion?: string | null,
): Promise<InstallStatus> {
  if (!(await acquireLock())) {
    logError(
      new AutoUpdaterError('Another process is currently installing an update'),
    )
    // 记录锁竞争事件
    logEvent('tengu_auto_updater_lock_contention', {
      pid: process.pid,
      currentVersion:
        MACRO.VERSION as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return 'in_progress'
  }

  try {
    await removeClaudeAliasesFromShellConfigs()
    // 检查是否在 WSL 中使用 Windows 路径下的 npm
    if (!env.isRunningWithBun() && env.isNpmFromWindowsPath()) {
      logError(new Error('Windows NPM detected in WSL environment'))
      logEvent('tengu_auto_updater_windows_npm_in_wsl', {
        currentVersion:
          MACRO.VERSION as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      console.error(`
Error: Windows NPM detected in WSL

You're running Claude Code in WSL but using the Windows NPM installation from /mnt/c/.
This configuration is not supported for updates.

To fix this issue:
  1. Install Node.js within your Linux distribution: e.g. sudo apt install nodejs npm
  2. Make sure Linux NPM is in your PATH before the Windows version
  3. Try updating again with 'claude update'
`)
      return 'install_failed'
    }

    const { hasPermissions } = await checkGlobalInstallPermissions()
    if (!hasPermissions) {
      return 'no_permissions'
    }

    // 如果提供了具体版本则使用该版本，否则使用最新版
    const packageSpec = specificVersion
      ? `${MACRO.PACKAGE_URL}@${specificVersion}`
      : MACRO.PACKAGE_URL

    // 从 home 目录运行，避免读取项目级 .npmrc/.bunfig.toml，
    // 该文件可能被恶意构造以重定向到攻击者的 registry
    const packageManager = env.isRunningWithBun() ? 'bun' : 'npm'
    const installResult = await execFileNoThrowWithCwd(
      packageManager,
      ['install', '-g', packageSpec],
      { cwd: homedir() },
    )
    if (installResult.code !== 0) {
      const error = new AutoUpdaterError(
        `Failed to install new version of claude: ${installResult.stdout} ${installResult.stderr}`,
      )
      logError(error)
      return 'install_failed'
    }

    // 将 installMethod 设置为 'global' 以跟踪 npm 全局安装
    saveGlobalConfig(current => ({
      ...current,
      installMethod: 'global',
    }))

    return 'success'
  } finally {
    // 确保始终释放锁
    await releaseLock()
  }
}

/**
 * 从 shell 配置文件中移除 claude 别名。
 * 有助于在切换到原生安装或 npm 全局安装时清理旧安装方式。
 */
async function removeClaudeAliasesFromShellConfigs(): Promise<void> {
  const configMap = getShellConfigPaths()

  // 处理每个 shell 配置文件
  for (const [, configFile] of Object.entries(configMap)) {
    try {
      const lines = await readFileLines(configFile)
      if (!lines) continue

      const { filtered, hadAlias } = filterClaudeAliases(lines)

      if (hadAlias) {
        await writeFileLines(configFile, filtered)
        logForDebugging(`Removed claude alias from ${configFile}`)
      }
    } catch (error) {
      // 如果某个文件无法处理，不要失败整个操作
      logForDebugging(`Failed to remove alias from ${configFile}: ${error}`, {
        level: 'error',
      })
    }
  }
}
