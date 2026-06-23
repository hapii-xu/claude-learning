/**
 * Claude Code 插件的 Marketplace 管理器
 *
 * 本模块提供以下功能：
 * - 管理已知的 marketplace 来源（URL、GitHub 仓库、npm 包、本地文件）
 * - 在本地缓存 marketplace 清单以供离线访问
 * - 从 marketplace 条目安装插件
 * - 跟踪和更新 marketplace 配置
 *
 * 本模块管理的文件结构：
 * ~/.claude/
 *   └── plugins/
 *       ├── known_marketplaces.json    # 所有已知 marketplace 的配置
 *       └── marketplaces/              # marketplace 数据的缓存目录
 *           ├── my-marketplace.json    # 来自 URL 来源的缓存 marketplace
 *           └── github-marketplace/    # 来自 GitHub 来源的克隆仓库
 *               └── .claude-plugin/
 *                   └── marketplace.json
 */

import axios from 'axios'
import { writeFile } from 'fs/promises'
import isEqual from 'lodash-es/isEqual.js'
import memoize from 'lodash-es/memoize.js'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'path'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { logForDebugging } from '../debug.js'
import { isEnvTruthy } from '../envUtils.js'
import {
  ConfigParseError,
  errorMessage,
  getErrnoCode,
  isENOENT,
  toError,
} from '../errors.js'
import { execFileNoThrow, execFileNoThrowWithCwd } from '../execFileNoThrow.js'
import { getFsImplementation } from '../fsOperations.js'
import { gitExe } from '../git.js'
import { logError } from '../log.js'
import {
  getInitialSettings,
  getSettingsForSource,
  updateSettingsForSource,
} from '../settings/settings.js'
import type { SettingsJson } from '../settings/types.js'
import {
  jsonParse,
  jsonStringify,
  writeFileSync_DEPRECATED,
} from '../slowOperations.js'
import {
  getAddDirEnabledPlugins,
  getAddDirExtraMarketplaces,
} from './addDirPluginSettings.js'
import { markPluginVersionOrphaned } from './cacheUtils.js'
import { classifyFetchError, logPluginFetch } from './fetchTelemetry.js'
import { removeAllPluginsForMarketplace } from './installedPluginsManager.js'
import {
  extractHostFromSource,
  formatSourceForDisplay,
  getHostPatternsFromAllowlist,
  getStrictKnownMarketplaces,
  isSourceAllowedByPolicy,
  isSourceInBlocklist,
} from './marketplaceHelpers.js'
import {
  OFFICIAL_MARKETPLACE_NAME,
  OFFICIAL_MARKETPLACE_SOURCE,
} from './officialMarketplace.js'
import { fetchOfficialMarketplaceFromGcs } from './officialMarketplaceGcs.js'
import {
  deletePluginDataDir,
  getPluginSeedDirs,
  getPluginsDirectory,
} from './pluginDirectories.js'
import { parsePluginIdentifier } from './pluginIdentifier.js'
import { deletePluginOptions } from './pluginOptionsStorage.js'
import {
  isLocalMarketplaceSource,
  type KnownMarketplace,
  type KnownMarketplacesFile,
  KnownMarketplacesFileSchema,
  type MarketplaceSource,
  type PluginMarketplace,
  type PluginMarketplaceEntry,
  PluginMarketplaceSchema,
  validateOfficialNameSource,
} from './schemas.js'

/**
 * 加载和缓存 marketplace 的结果
 */
type LoadedPluginMarketplace = {
  marketplace: PluginMarketplace
  cachePath: string
}

/**
 * 获取已知 marketplace 配置文件的路径
 * 使用函数而非常量允许在测试中正确 mock
 */
function getKnownMarketplacesFile(): string {
  return join(getPluginsDirectory(), 'known_marketplaces.json')
}

/**
 * 获取 marketplace 缓存目录的路径
 * 使用函数而非常量允许在测试中正确 mock
 */
export function getMarketplacesCacheDir(): string {
  return join(getPluginsDirectory(), 'marketplaces')
}

/**
 * 获取 marketplace 数据的记忆化内部函数。
 * 这会在从磁盘或网络加载后将 marketplace 缓存在内存中。
 */

/**
 * 清除所有缓存的 marketplace 数据（用于测试）
 */
export function clearMarketplacesCache(): void {
  getMarketplace.cache?.clear?.()
}

/**
 * 已知 marketplace 的配置
 */
export type KnownMarketplacesConfig = KnownMarketplacesFile

/**
 * 声明的 marketplace 条目（意图层）。
 *
 * 结构与 settings 的 `extraKnownMarketplaces` 条目兼容，但
 * 添加了 `sourceIsFallback` 用于隐式内置声明。这 NOT 是
 * settings-schema 字段 — 它只在代码中设置（从不从 JSON 解析）。
 */
export type DeclaredMarketplace = {
  source: MarketplaceSource
  installLocation?: string
  autoUpdate?: boolean
  /**
   * 存在即可。设置后，diffMarketplaces 将已物化的条目视为
   * upToDate，无论来源形状如何 — 从不报告 sourceChanged。
   *
   * 用于隐式官方 marketplace 声明：我们想要"如果缺失则从
   * GitHub 克隆"，而非"如果以不同来源存在则替换为 GitHub"。
   * 没有这个，在例如内部镜像来源下注册官方 marketplace 的
   * seed 目录会被 GitHub 重新克隆覆盖。
   */
  sourceIsFallback?: boolean
}

/**
 * 从合并的 settings 和 --add-dir 来源获取声明的 marketplace 意图。
 * 这是应该存在的 — 由对账器用来查找差距。
 *
 * 当任何启用的插件引用它时，官方 marketplace 会被隐式声明为
 * `sourceIsFallback: true`。
 */
export function getDeclaredMarketplaces(): Record<string, DeclaredMarketplace> {
  const implicit: Record<string, DeclaredMarketplace> = {}

  // 只有官方 marketplace 可以隐式声明 — 它是我们知道的
  // 唯一一个内置来源。其他 marketplace 没有默认来源可以注入。
  // 显式禁用的条目（值：false）不算。
  const enabledPlugins = {
    ...getAddDirEnabledPlugins(),
    ...(getInitialSettings().enabledPlugins ?? {}),
  }
  for (const [pluginId, value] of Object.entries(enabledPlugins)) {
    if (
      value &&
      parsePluginIdentifier(pluginId).marketplace === OFFICIAL_MARKETPLACE_NAME
    ) {
      implicit[OFFICIAL_MARKETPLACE_NAME] = {
        source: OFFICIAL_MARKETPLACE_SOURCE,
        sourceIsFallback: true,
      }
      break
    }
  }

  // 最低优先级：隐式 < --add-dir < 合并的 settings。
  // --add-dir 或 settings 中 claude-plugins-official 的显式
  // extraKnownMarketplaces 条目会获胜。
  return {
    ...implicit,
    ...getAddDirExtraMarketplaces(),
    ...(getInitialSettings().extraKnownMarketplaces ?? {}),
  } as any
}

/**
 * 查找哪个可编辑的 settings 来源声明了 marketplace。
 * 按逆优先级顺序检查（最高优先级最后），以便结果是
 * 在合并视图中"获胜"的来源。
 * 如果 marketplace 未在任何可编辑来源中声明则返回 null。
 */
export function getMarketplaceDeclaringSource(
  name: string,
): 'userSettings' | 'projectSettings' | 'localSettings' | null {
  // 优先检查最高优先级的可编辑来源 — 在合并视图中
  // 获胜的那个是我们应该回写的。
  const editableSources: Array<
    'localSettings' | 'projectSettings' | 'userSettings'
  > = ['localSettings', 'projectSettings', 'userSettings']

  for (const source of editableSources) {
    const settings = getSettingsForSource(source)
    if (settings?.extraKnownMarketplaces?.[name]) {
      return source
    }
  }
  return null
}

/**
 * 将 marketplace 条目保存到 settings（意图层）。
 * 不触及 known_marketplaces.json（状态层）。
 *
 * @param name - marketplace 名称
 * @param entry - marketplace 配置
 * @param settingSource - 要写入的 settings 来源（默认为 userSettings）
 */
export function saveMarketplaceToSettings(
  name: string,
  entry: DeclaredMarketplace,
  settingSource:
    | 'userSettings'
    | 'projectSettings'
    | 'localSettings' = 'userSettings',
): void {
  const existing = getSettingsForSource(settingSource) ?? {}
  const current = { ...existing.extraKnownMarketplaces }
  current[name] = entry
  updateSettingsForSource(settingSource, { extraKnownMarketplaces: current })
}

/**
 * 从磁盘加载已知 marketplace 配置
 *
 * 读取 ~/.claude/plugins/known_marketplaces.json 的配置文件，
 * 其中包含 marketplace 名称到其来源和元数据的映射。
 *
 * 配置文件内容示例：
 * ```json
 * {
 *   "official-marketplace": {
 *     "source": { "source": "url", "url": "https://example.com/marketplace.json" },
 *     "installLocation": "/Users/me/.claude/plugins/marketplaces/official-marketplace.json",
 *     "lastUpdated": "2024-01-15T10:30:00.000Z"
 *   },
 *   "company-plugins": {
 *     "source": { "source": "github", "repo": "mycompany/plugins" },
 *     "installLocation": "/Users/me/.claude/plugins/marketplaces/company-plugins",
 *     "lastUpdated": "2024-01-14T15:45:00.000Z"
 *   }
 * }
 * ```
 *
 * @returns 将 marketplace 名称映射到其元数据的配置对象
 */
export async function loadKnownMarketplacesConfig(): Promise<KnownMarketplacesConfig> {
  const fs = getFsImplementation()
  const configFile = getKnownMarketplacesFile()

  try {
    const content = await fs.readFile(configFile, {
      encoding: 'utf-8',
    })
    const data = jsonParse(content)
    // 针对 schema 校验
    const parsed = KnownMarketplacesFileSchema().safeParse(data)
    if (!parsed.success) {
      const errorMsg = `Marketplace configuration file is corrupted: ${parsed.error.issues.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')}`
      logForDebugging(errorMsg, {
        level: 'error',
      })
      throw new ConfigParseError(errorMsg, configFile, data)
    }
    return parsed.data
  } catch (error) {
    if (isENOENT(error)) {
      return {}
    }
    // 如果已经是 ConfigParseError，重新抛出
    if (error instanceof ConfigParseError) {
      throw error
    }
    // 对于 JSON 解析错误或 I/O 错误，抛出并附带有用消息
    const errorMsg = `Failed to load marketplace configuration: ${errorMessage(error)}`
    logForDebugging(errorMsg, {
      level: 'error',
    })
    throw new Error(errorMsg)
  }
}

/**
 * 加载已知 marketplace 配置，在任何错误时返回 {} 而非抛出。
 *
 * 在只读路径（插件加载、功能检查）上使用此函数，以便损坏的配置
 * 优雅降级而非崩溃。不要在加载→变更→保存路径上使用 — 在那里
 * 返回 {} 会导致保存操作仅用新条目覆盖损坏的文件，永久销毁用户的
 * 其他条目。抛出变体保留文件以便用户可以修复损坏并恢复。
 */
export async function loadKnownMarketplacesConfigSafe(): Promise<KnownMarketplacesConfig> {
  try {
    return await loadKnownMarketplacesConfig()
  } catch {
    // 内部函数已通过 logForDebugging 记录。不要在此处 logError —
    // 损坏的用户配置不是 Claude Code 的错误，不应命中错误文件。
    return {}
  }
}

/**
 * 将已知 marketplace 配置保存到磁盘
 *
 * 将配置写入 ~/.claude/plugins/known_marketplaces.json，
 * 如果目录结构不存在则创建。
 *
 * @param config - 要保存的 marketplace 配置
 */
export async function saveKnownMarketplacesConfig(
  config: KnownMarketplacesConfig,
): Promise<void> {
  // 保存前校验
  const parsed = KnownMarketplacesFileSchema().safeParse(config)
  const configFile = getKnownMarketplacesFile()

  if (!parsed.success) {
    throw new ConfigParseError(
      `Invalid marketplace config: ${parsed.error.message}`,
      configFile,
      config,
    )
  }

  const fs = getFsImplementation()
  // 从配置文件路径获取目录以确保一致性
  const dir = join(configFile, '..')
  await fs.mkdir(dir)
  writeFileSync_DEPRECATED(configFile, jsonStringify(parsed.data, null, 2), {
    encoding: 'utf-8',
    flush: true,
  })
}

/**
 * 将只读 seed 目录中的 marketplace 注册到主
 * known_marketplaces.json。
 *
 * seed 的 known_marketplaces.json 包含指向 seed 目录本身的
 * installLocation 路径。将这些条目注册到主 JSON 使它们对所有
 * marketplace 读取器可见（getMarketplaceCacheOnly、
 * getPluginByIdCacheOnly 等），无需任何加载器更改 — 它们只需
 * 跟随 installLocation 指向的任何位置。
 *
 * seed 条目在 seed 中声明的 marketplace 上始终获胜 — seed 由
 * 管理员管理（烘焙到容器镜像中）。如果管理员在新镜像中更新
 * seed，这些更改会在下次启动时传播。用户通过 `plugin disable`
 * 退出 seed 插件，而非移除 marketplace。
 *
 * 使用多个 seed 目录（路径分隔符分隔），第一个 seed 获胜：
 * 被早期 seed 声明的 marketplace 名称会被后续 seed 跳过。
 *
 * autoUpdate 被强制为 false，因为 seed 是只读的，git-pull 会
 * 失败。installLocation 从运行时 seedDir 计算，而非信任 seed
 * 的 JSON（处理多阶段 Docker 挂载路径漂移）。
 *
 * 幂等：使用未更改 seed 的第二次调用不写入任何内容。
 *
 * @returns 如果写入/更改了任何 marketplace 条目则返回 true（调用者应
 *   清除缓存，以便早期插件加载通道不会保留过时的"marketplace
 *   未找到"状态）
 */
export async function registerSeedMarketplaces(): Promise<boolean> {
  const seedDirs = getPluginSeedDirs()
  if (seedDirs.length === 0) return false

  const primary = await loadKnownMarketplacesConfig()
  // 本次注册过程中的第一个 seed 获胜。不能单独使用 isEqual 检查
  // — 两个同名 seed 会有不同的 installLocations。
  const claimed = new Set<string>()
  let changed = 0

  for (const seedDir of seedDirs) {
    const seedConfig = await readSeedKnownMarketplaces(seedDir)
    if (!seedConfig) continue

    for (const [name, seedEntry] of Object.entries(seedConfig)) {
      if (claimed.has(name)) continue

      // 计算相对于此 seedDir 的 installLocation，而非烘焙到
      // seed JSON 中的构建时路径。处理多阶段 Docker 构建，
      // 其中 seed 挂载在与构建位置不同的路径。
      const resolvedLocation = await findSeedMarketplaceLocation(seedDir, name)
      if (!resolvedLocation) {
        // seed 内容缺失（不完整构建）— 保持主配置不变，但
        // 也不要声明名称：后续 seed 可能有可用的内容。
        logForDebugging(
          `Seed marketplace '${name}' not found under ${seedDir}/marketplaces/, skipping`,
          { level: 'warn' },
        )
        continue
      }
      claimed.add(name)

      const desired: KnownMarketplace = {
        source: seedEntry.source,
        installLocation: resolvedLocation,
        lastUpdated: seedEntry.lastUpdated,
        autoUpdate: false,
      }

      // 如果主配置已经匹配则跳过 — 幂等无操作，不写入。
      if (isEqual(primary[name], desired)) continue

      // seed 获胜 — 管理员管理。覆盖任何现有主条目。
      primary[name] = desired
      changed++
    }
  }

  if (changed > 0) {
    await saveKnownMarketplacesConfig(primary)
    logForDebugging(`Synced ${changed} marketplace(s) from seed dir(s)`)
    return true
  }
  return false
}

async function readSeedKnownMarketplaces(
  seedDir: string,
): Promise<KnownMarketplacesConfig | null> {
  const seedJsonPath = join(seedDir, 'known_marketplaces.json')
  try {
    const content = await getFsImplementation().readFile(seedJsonPath, {
      encoding: 'utf-8',
    })
    const parsed = KnownMarketplacesFileSchema().safeParse(jsonParse(content))
    if (!parsed.success) {
      logForDebugging(
        `Seed known_marketplaces.json invalid at ${seedDir}: ${parsed.error.message}`,
        { level: 'warn' },
      )
      return null
    }
    return parsed.data
  } catch (e) {
    if (!isENOENT(e)) {
      logForDebugging(
        `Failed to read seed known_marketplaces.json at ${seedDir}: ${e}`,
        { level: 'warn' },
      )
    }
    return null
  }
}

/**
 * 按名称在 seed 目录中定位 marketplace。
 *
 * 探测 seedDir/marketplaces/ 下的规范位置，而非信任 seed 存储的
 * installLocation（可能包含来自不同构建时挂载点的过时绝对路径）。
 *
 * @returns 可读位置，如果两种格式都不存在/验证则返回 null
 */
async function findSeedMarketplaceLocation(
  seedDir: string,
  name: string,
): Promise<string | null> {
  const dirCandidate = join(seedDir, 'marketplaces', name)
  const jsonCandidate = join(seedDir, 'marketplaces', `${name}.json`)
  for (const candidate of [dirCandidate, jsonCandidate]) {
    try {
      await readCachedMarketplace(candidate)
      return candidate
    } catch {
      // 尝试下一个候选
    }
  }
  return null
}

/**
 * 如果 installLocation 指向已配置的 seed 目录，则返回该 seed
 * 目录。seed 管理的条目由管理员控制 — 用户不能
 * 移除/刷新/修改它们（它们会在下次启动时被
 * registerSeedMarketplaces 覆盖）。返回特定的 seed 让错误消息可以命名它。
 */
function seedDirFor(installLocation: string): string | undefined {
  return getPluginSeedDirs().find(
    d => installLocation === d || installLocation.startsWith(d + sep),
  )
}

/**
 * Git pull 操作（导出用于测试）
 *
 * 以可配置的超时拉取最新更改（默认 120 秒，通过 CLAUDE_CODE_PLUGIN_GIT_TIMEOUT_MS 覆盖）。
 * 为常见失败场景提供有用的错误消息。
 * 如果指定了 ref，则获取并检出该特定分支或标签。
 */
// 环境变量以防止 git 提示输入凭据
const GIT_NO_PROMPT_ENV = {
  GIT_TERMINAL_PROMPT: '0', // 防止终端凭据提示
  GIT_ASKPASS: '', // 禁用 askpass GUI 程序
}

const DEFAULT_PLUGIN_GIT_TIMEOUT_MS = 120 * 1000

function getPluginGitTimeoutMs(): number {
  const envValue = process.env.CLAUDE_CODE_PLUGIN_GIT_TIMEOUT_MS
  if (envValue) {
    const parsed = parseInt(envValue, 10)
    if (!isNaN(parsed) && parsed > 0) {
      return parsed
    }
  }
  return DEFAULT_PLUGIN_GIT_TIMEOUT_MS
}

export async function gitPull(
  cwd: string,
  ref?: string,
  options?: { disableCredentialHelper?: boolean; sparsePaths?: string[] },
): Promise<{ code: number; stderr: string }> {
  logForDebugging(`git pull: cwd=${cwd} ref=${ref ?? 'default'}`)
  const env = { ...process.env, ...GIT_NO_PROMPT_ENV }
  const credentialArgs = options?.disableCredentialHelper
    ? ['-c', 'credential.helper=']
    : []

  if (ref) {
    const fetchResult = await execFileNoThrowWithCwd(
      gitExe(),
      [...credentialArgs, 'fetch', 'origin', ref],
      { cwd, timeout: getPluginGitTimeoutMs(), stdin: 'ignore', env },
    )

    if (fetchResult.code !== 0) {
      return enhanceGitPullErrorMessages(fetchResult)
    }

    const checkoutResult = await execFileNoThrowWithCwd(
      gitExe(),
      [...credentialArgs, 'checkout', ref],
      { cwd, timeout: getPluginGitTimeoutMs(), stdin: 'ignore', env },
    )

    if (checkoutResult.code !== 0) {
      return enhanceGitPullErrorMessages(checkoutResult)
    }

    const pullResult = await execFileNoThrowWithCwd(
      gitExe(),
      [...credentialArgs, 'pull', 'origin', ref],
      { cwd, timeout: getPluginGitTimeoutMs(), stdin: 'ignore', env },
    )
    if (pullResult.code !== 0) {
      return enhanceGitPullErrorMessages(pullResult)
    }
    await gitSubmoduleUpdate(cwd, credentialArgs, env, options?.sparsePaths)
    return pullResult
  }

  const result = await execFileNoThrowWithCwd(
    gitExe(),
    [...credentialArgs, 'pull', 'origin', 'HEAD'],
    { cwd, timeout: getPluginGitTimeoutMs(), stdin: 'ignore', env },
  )
  if (result.code !== 0) {
    return enhanceGitPullErrorMessages(result)
  }
  await gitSubmoduleUpdate(cwd, credentialArgs, env, options?.sparsePaths)
  return result
}

/**
 * 成功拉取后同步子模块工作目录。gitClone() 使用
 * --recurse-submodules，但 gitPull() 没有 — 父仓库的子模块
 * 指针会前进，而工作目录停留在旧提交，
 * 使得 marketplace 更新后子模块中的插件来源无法解析。
 * 非致命：失败的子模块更新记录警告；大多数 marketplace
 * 根本不使用子模块。（gh-30696）
 *
 * 对于稀疏克隆跳过 — gitClone 的稀疏路径故意省略
 * --recurse-submodules 以保留部分克隆的带宽节省，且
 * .gitmodules 是 cone-mode sparse-checkout 始终物化的根文件，
 * 因此仅 .gitmodules 门控无法区分稀疏仓库。
 *
 * 性能：git-submodule 是一个 bash 脚本，即使没有子模块也会
 * 产生约 20 个子进程（约 35ms+）。.gitmodules 是受跟踪的文件
 * — pull 仅在仓库有子模块时物化它 — 因此在文件存在时门控
 * 以跳过常见情况的进程产生。
 *
 * --init 对新添加的子模块执行首次联系克隆，因此与
 * gitClone 的非稀疏路径保持对等：StrictHostKeyChecking=yes
 * 用于失败关闭的 SSH（未知主机拒绝而非静默填充
 * known_hosts），以及 --depth 1 用于浅克隆（匹配
 * --shallow-submodules）。--depth 仅影响尚未初始化的子模块；
 * 现有浅子模块不受影响。
 */
async function gitSubmoduleUpdate(
  cwd: string,
  credentialArgs: string[],
  env: NodeJS.ProcessEnv,
  sparsePaths: string[] | undefined,
): Promise<void> {
  if (sparsePaths && sparsePaths.length > 0) return
  const hasGitmodules = await getFsImplementation()
    .stat(join(cwd, '.gitmodules'))
    .then(
      () => true,
      () => false,
    )
  if (!hasGitmodules) return
  const result = await execFileNoThrowWithCwd(
    gitExe(),
    [
      '-c',
      'core.sshCommand=ssh -o BatchMode=yes -o StrictHostKeyChecking=yes',
      ...credentialArgs,
      'submodule',
      'update',
      '--init',
      '--recursive',
      '--depth',
      '1',
    ],
    { cwd, timeout: getPluginGitTimeoutMs(), stdin: 'ignore', env },
  )
  if (result.code !== 0) {
    logForDebugging(
      `git submodule update failed (non-fatal): ${result.stderr}`,
      { level: 'warn' },
    )
  }
}

/**
 * 增强 git pull 失败的错误消息
 */
function enhanceGitPullErrorMessages(result: {
  code: number
  stderr: string
  error?: string
}): { code: number; stderr: string } {
  if (result.code === 0) {
    return result
  }

  // 通过 error 字段检测 execa 超时终止（当进程被 SIGTERM 杀死时
  // stderr 不会包含 "timed out" — 超时信息只在 error 中）
  if (result.error?.includes('timed out')) {
    const timeoutSec = Math.round(getPluginGitTimeoutMs() / 1000)
    return {
      ...result,
      stderr: `Git pull timed out after ${timeoutSec}s. Try increasing the timeout via CLAUDE_CODE_PLUGIN_GIT_TIMEOUT_MS environment variable.\n\nOriginal error: ${result.stderr}`,
    }
  }

  // 检测 SSH 主机密钥验证失败（在通用的
  // 'Could not read from remote' 捕获之前检查 — 两种情况都会出现该字符串）。
  // OpenSSH 对于主机不在 known_hosts 和主机密钥已更改两种情况都发出
  // "Host key verification failed" — 后者还包括"REMOTE HOST
  // IDENTIFICATION HAS CHANGED"横幅，需要不同的修复方法。
  if (result.stderr.includes('REMOTE HOST IDENTIFICATION HAS CHANGED')) {
    return {
      ...result,
      stderr: `SSH host key for this marketplace's git host has changed (server key rotation or possible MITM). Remove the stale entry with: ssh-keygen -R <host>\nThen connect once manually to accept the new key.\n\nOriginal error: ${result.stderr}`,
    }
  }
  if (result.stderr.includes('Host key verification failed')) {
    return {
      ...result,
      stderr: `SSH host key verification failed while updating marketplace. The host key is not in your known_hosts file. Connect once manually to add it (e.g., ssh -T git@<host>), or remove and re-add the marketplace with an HTTPS URL.\n\nOriginal error: ${result.stderr}`,
    }
  }

  // 检测 SSH 认证失败
  if (
    result.stderr.includes('Permission denied (publickey)') ||
    result.stderr.includes('Could not read from remote repository')
  ) {
    return {
      ...result,
      stderr: `SSH authentication failed while updating marketplace. Please ensure your SSH keys are configured.\n\nOriginal error: ${result.stderr}`,
    }
  }

  // 检测网络问题
  if (
    result.stderr.includes('timed out') ||
    result.stderr.includes('Could not resolve host')
  ) {
    return {
      ...result,
      stderr: `Network error while updating marketplace. Please check your internet connection.\n\nOriginal error: ${result.stderr}`,
    }
  }

  return result
}

/**
 * 检查 SSH 是否可能对 GitHub 有效
 * 这是避免完整克隆超时的快速启发式检查
 *
 * 使用 StrictHostKeyChecking=yes（不是 accept-new），以便未知的 github.com
 * 主机密钥失败关闭而非被静默添加到 known_hosts。这防止了网络级 MITM
 * 在首次接触时污染 known_hosts。已经在 known_hosts 中有 github.com 的用户
 * 看不到变化；没有的用户会被路由到 HTTPS 克隆路径。
 *
 * @returns 如果 SSH 认证成功且 github.com 已被信任则返回 true
 */
async function isGitHubSshLikelyConfigured(): Promise<boolean> {
  try {
    // 使用 2 秒超时的快速 SSH 连接测试
    // 如果 SSH 未配置，这会快速失败
    const result = await execFileNoThrow(
      'ssh',
      [
        '-T',
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=2',
        '-o',
        'StrictHostKeyChecking=yes',
        'git@github.com',
      ],
      {
        timeout: 3000, // 总超时 3 秒
      },
    )

    // SSH 到 github.com 总是返回退出码 1 并显示"successfully authenticated"
    // 或退出码 255 并显示"Permission denied" — 我们需要前者
    const configured =
      result.code === 1 &&
      (result.stderr?.includes('successfully authenticated') ||
        result.stdout?.includes('successfully authenticated'))
    logForDebugging(
      `SSH config check: code=${result.code} configured=${configured}`,
    )
    return configured
  } catch (error) {
    // 任何错误都意味着 SSH 配置不正确
    logForDebugging(`SSH configuration check failed: ${errorMessage(error)}`, {
      level: 'warn',
    })
    return false
  }
}

/**
 * 检查 git 错误是否表示认证失败。
 * 用于为认证失败提供增强的错误消息。
 */
function isAuthenticationError(stderr: string): boolean {
  return (
    stderr.includes('Authentication failed') ||
    stderr.includes('could not read Username') ||
    stderr.includes('terminal prompts disabled') ||
    stderr.includes('403') ||
    stderr.includes('401')
  )
}

/**
 * 从 git URL 中提取 SSH 主机以用于错误消息。
 * 匹配 SSH 格式 user@host:path（例如 git@github.com:owner/repo.git）。
 */
function extractSshHost(gitUrl: string): string | null {
  const match = gitUrl.match(/^[^@]+@([^:]+):/)
  return match?.[1] ?? null
}

/**
 * Git clone 操作（导出用于测试）
 *
 * 克隆 git 仓库，可配置超时（默认 120 秒，通过 CLAUDE_CODE_PLUGIN_GIT_TIMEOUT_MS 覆盖）
 * 和更大的仓库。为常见失败场景提供有用的错误消息。
 * 可选地检出特定分支或标签。
 *
 * 不禁用凭据助手 — 这允许用户现有的认证设置
 * （gh auth、keychain、git-credential-store 等）为私有仓库原生工作。
 * 交互式提示仍通过 GIT_TERMINAL_PROMPT=0、GIT_ASKPASS=''、
 * stdin: 'ignore' 和 SSH 的 BatchMode=yes 来防止。
 *
 * 使用 StrictHostKeyChecking=yes（不是 accept-new）：未知 SSH 主机失败关闭
 * 并显示清晰消息，而非在首次接触时被静默信任。对于
 * github 来源类型，预检会将未知主机用户自动路由到 HTTPS；
 * 对于显式 git@host:… URL，用户看到可操作的错误。
 */
export async function gitClone(
  gitUrl: string,
  targetPath: string,
  ref?: string,
  sparsePaths?: string[],
): Promise<{ code: number; stderr: string }> {
  const useSparse = sparsePaths && sparsePaths.length > 0
  const args = [
    '-c',
    'core.sshCommand=ssh -o BatchMode=yes -o StrictHostKeyChecking=yes',
    'clone',
    '--depth',
    '1',
  ]

  if (useSparse) {
    // 部分克隆：跳过 blob 下载直到检出，在配置 sparse-checkout 后延迟检出。
    // 对于稀疏克隆故意省略子模块 — 稀疏单仓库很少需要它们，
    // 递归子模块会破坏部分克隆的带宽节省。
    args.push('--filter=blob:none', '--no-checkout')
  } else {
    args.push('--recurse-submodules', '--shallow-submodules')
  }

  if (ref) {
    args.push('--branch', ref)
  }

  args.push(gitUrl, targetPath)

  const timeoutMs = getPluginGitTimeoutMs()
  logForDebugging(
    `git clone: url=${redactUrlCredentials(gitUrl)} ref=${ref ?? 'default'} timeout=${timeoutMs}ms`,
  )

  const result = await execFileNoThrowWithCwd(gitExe(), args, {
    timeout: timeoutMs,
    stdin: 'ignore',
    env: { ...process.env, ...GIT_NO_PROMPT_ENV },
  })

  // 在任何日志记录或返回之前，从 execa 的 error/stderr 字段中清除凭据。
  // execa 的 shortMessage 嵌入完整命令行（包括带凭据的 URL），
  // 而 result.stderr 在某些 git 版本上也可能包含它。
  const redacted = redactUrlCredentials(gitUrl)
  if (gitUrl !== redacted) {
    if (result.error) result.error = result.error.replaceAll(gitUrl, redacted)
    if (result.stderr)
      result.stderr = result.stderr.replaceAll(gitUrl, redacted)
  }

  if (result.code === 0) {
    if (useSparse) {
      // 配置稀疏锥，然后仅物化这些路径。
      // `sparse-checkout set --cone` 在 git >= 2.25 上单步处理初始化和路径选择。
      const sparseResult = await execFileNoThrowWithCwd(
        gitExe(),
        ['sparse-checkout', 'set', '--cone', '--', ...sparsePaths],
        {
          cwd: targetPath,
          timeout: timeoutMs,
          stdin: 'ignore',
          env: { ...process.env, ...GIT_NO_PROMPT_ENV },
        },
      )
      if (sparseResult.code !== 0) {
        return {
          code: sparseResult.code,
          stderr: `git sparse-checkout set failed: ${sparseResult.stderr}`,
        }
      }

      const checkoutResult = await execFileNoThrowWithCwd(
        gitExe(),
        // ref 已通过 --branch 传递给 clone，因此 HEAD 指向它；
        // 如果没有 ref，HEAD 指向远程的默认分支。
        ['checkout', 'HEAD'],
        {
          cwd: targetPath,
          timeout: timeoutMs,
          stdin: 'ignore',
          env: { ...process.env, ...GIT_NO_PROMPT_ENV },
        },
      )
      if (checkoutResult.code !== 0) {
        return {
          code: checkoutResult.code,
          stderr: `git checkout after sparse-checkout failed: ${checkoutResult.stderr}`,
        }
      }
    }
    logForDebugging(`git clone succeeded: ${redactUrlCredentials(gitUrl)}`)
    return result
  }

  logForDebugging(
    `git clone failed: url=${redactUrlCredentials(gitUrl)} code=${result.code} error=${result.error ?? 'none'} stderr=${result.stderr}`,
    { level: 'warn' },
  )

  // 检测超时终止 — 当 execFileNoThrowWithCwd 通过 SIGTERM 杀死进程时，
  // stderr 可能只包含部分输出（例如"Cloning into '...'"）而没有
  // "timed out"字符串。检查 execa 的 error 字段，其中包含超时消息。
  if (result.error?.includes('timed out')) {
    return {
      ...result,
      stderr: `Git clone timed out after ${Math.round(timeoutMs / 1000)}s. The repository may be too large for the current timeout. Set CLAUDE_CODE_PLUGIN_GIT_TIMEOUT_MS to increase it (e.g., 300000 for 5 minutes).\n\nOriginal error: ${result.stderr}`,
    }
  }

  // 为常见场景增强错误消息
  if (result.stderr) {
    // 主机密钥验证失败 — 优先检查，在通用的
    // 'Could not read from remote repository' 捕获之前（该字符串出现在
    // 两个 stderr 输出中，因此顺序很重要）。OpenSSH 对于主机不在 known_hosts
    // 和主机密钥已更改两种情况都发出"Host key verification failed"；
    // 通过密钥更改横幅区分它们。
    if (result.stderr.includes('REMOTE HOST IDENTIFICATION HAS CHANGED')) {
      const host = extractSshHost(gitUrl)
      const removeHint = host ? `ssh-keygen -R ${host}` : 'ssh-keygen -R <host>'
      return {
        ...result,
        stderr: `SSH host key has changed (server key rotation or possible MITM). Remove the stale known_hosts entry:\n  ${removeHint}\nThen connect once manually to verify and accept the new key.\n\nOriginal error: ${result.stderr}`,
      }
    }
    if (result.stderr.includes('Host key verification failed')) {
      const host = extractSshHost(gitUrl)
      const connectHint = host ? `ssh -T git@${host}` : 'ssh -T git@<host>'
      return {
        ...result,
        stderr: `SSH host key is not in your known_hosts file. To add it, connect once manually (this will show the fingerprint for you to verify):\n  ${connectHint}\n\nOr use an HTTPS URL instead (recommended for public repos).\n\nOriginal error: ${result.stderr}`,
      }
    }

    if (
      result.stderr.includes('Permission denied (publickey)') ||
      result.stderr.includes('Could not read from remote repository')
    ) {
      return {
        ...result,
        stderr: `SSH authentication failed. Please ensure your SSH keys are configured for GitHub, or use an HTTPS URL instead.\n\nOriginal error: ${result.stderr}`,
      }
    }

    if (isAuthenticationError(result.stderr)) {
      return {
        ...result,
        stderr: `HTTPS authentication failed. Please ensure your credential helper is configured (e.g., gh auth login).\n\nOriginal error: ${result.stderr}`,
      }
    }

    if (
      result.stderr.includes('timed out') ||
      result.stderr.includes('timeout') ||
      result.stderr.includes('Could not resolve host')
    ) {
      return {
        ...result,
        stderr: `Network error or timeout while cloning repository. Please check your internet connection and try again.\n\nOriginal error: ${result.stderr}`,
      }
    }
  }

  // 空 stderr 的回退 — gh-28373：用户看到"Failed to clone
  // marketplace repository:"后面什么都没有。Git CAN 在不写入
  // stderr 的情况下失败（改为 stdout，或被凭据助手/信号吞掉的输出）。
  // execa 的 error 字段有 execa 级别的消息（命令、退出码、信号）；
  // 退出码是最低限度。
  if (!result.stderr) {
    return {
      code: result.code,
      stderr:
        result.error ||
        `git clone exited with code ${result.code} (no stderr output). Run with --debug to see the full command.`,
    }
  }

  return result
}

/**
 * marketplace 操作的进度回调。
 *
 * 此回调在 marketplace 操作的各种阶段被调用
 * （下载、git 操作、校验等）以提供用户反馈。
 *
 * 重要：实现应该在内部处理错误并不抛出异常。
 * 如果回调抛出，它会被捕获并记录但不会中止操作。
 *
 * @param message - 显示给用户的可读进度消息
 */
export type MarketplaceProgressCallback = (message: string) => void

/**
 * 安全调用进度回调，捕获并记录任何错误。
 * 防止回调错误中止 marketplace 操作。
 *
 * @param onProgress - 要调用的进度回调
 * @param message - 传递给回调的进度消息
 */
function safeCallProgress(
  onProgress: MarketplaceProgressCallback | undefined,
  message: string,
): void {
  if (!onProgress) return
  try {
    onProgress(message)
  } catch (callbackError) {
    logForDebugging(`Progress callback error: ${errorMessage(callbackError)}`, {
      level: 'warn',
    })
  }
}

/**
 * 协调磁盘上的 sparse-checkout 状态与所需配置。
 *
 * 在 gitPull 之前运行以处理转换：
 * - 完整→稀疏 或 稀疏A→稀疏B：运行 `sparse-checkout set --cone`（幂等）
 * - 稀疏→完整：返回非零以便调用者回退到 rm+重新克隆。避免
 *   在 --filter=blob:none 部分克隆上 `sparse-checkout disable`，这会
 *   触发单仓库中每个 blob 的惰性获取。
 * - 完整→完整（常见情况）：单个本地 `git config --get` 检查，无操作。
 *
 * 此处的失败（ENOENT，不是仓库）是无害的 — gitPull 也会失败并
 * 触发克隆路径，从头开始建立正确的状态。
 */
export async function reconcileSparseCheckout(
  cwd: string,
  sparsePaths: string[] | undefined,
): Promise<{ code: number; stderr: string }> {
  const env = { ...process.env, ...GIT_NO_PROMPT_ENV }

  if (sparsePaths && sparsePaths.length > 0) {
    return execFileNoThrowWithCwd(
      gitExe(),
      ['sparse-checkout', 'set', '--cone', '--', ...sparsePaths],
      { cwd, timeout: getPluginGitTimeoutMs(), stdin: 'ignore', env },
    )
  }

  const check = await execFileNoThrowWithCwd(
    gitExe(),
    ['config', '--get', 'core.sparseCheckout'],
    { cwd, stdin: 'ignore', env },
  )
  if (check.code === 0 && check.stdout.trim() === 'true') {
    return {
      code: 1,
      stderr:
        'sparsePaths removed from config but repository is sparse; re-cloning for full checkout',
    }
  }
  return { code: 0, stderr: '' }
}

/**
 * 从 git 仓库缓存 marketplace
 *
 * 克隆或更新包含 marketplace 数据的 git 仓库。
 * 如果仓库已存在于 cachePath，则拉取最新更改。
 * 如果拉取失败，则移除目录并重新克隆。
 *
 * 仓库结构示例：
 * ```
 * my-marketplace/
 *   ├── .claude-plugin/
 *   │   └── marketplace.json    # marketplace 清单的默认位置
 *   ├── plugins/                # 插件实现
 *   └── README.md
 * ```
 *
 * @param gitUrl - 要克隆的 git URL（https 或 ssh）
 * @param cachePath - 克隆/更新仓库的本地目录路径
 * @param ref - 可选的 git 分支或标签以检出
 * @param onProgress - 可选的回调以报告进度
 */
async function cacheMarketplaceFromGit(
  gitUrl: string,
  cachePath: string,
  ref?: string,
  sparsePaths?: string[],
  onProgress?: MarketplaceProgressCallback,
  options?: { disableCredentialHelper?: boolean },
): Promise<void> {
  const fs = getFsImplementation()

  // 尝试增量更新；如果仓库缺失、过时或无法更新则回退到重新克隆。
  // 使用先拉取避免 stat-before-operate TOCTOU 检查：当 cachePath
  // 缺失或没有 .git 时 gitPull 返回非零。
  const timeoutSec = Math.round(getPluginGitTimeoutMs() / 1000)
  safeCallProgress(
    onProgress,
    `Refreshing marketplace cache (timeout: ${timeoutSec}s)…`,
  )

  // 在拉取前协调 sparse-checkout 配置。如果这需要重新克隆
  // （稀疏→完整转换）或失败（缺失目录，不是仓库），直接跳到
  // rm+克隆回退。
  const reconcileResult = await reconcileSparseCheckout(cachePath, sparsePaths)
  if (reconcileResult.code === 0) {
    const pullStarted = performance.now()
    const pullResult = await gitPull(cachePath, ref, {
      disableCredentialHelper: options?.disableCredentialHelper,
      sparsePaths,
    })
    logPluginFetch(
      'marketplace_pull',
      gitUrl,
      pullResult.code === 0 ? 'success' : 'failure',
      performance.now() - pullStarted,
      pullResult.code === 0 ? undefined : classifyFetchError(pullResult.stderr),
    )
    if (pullResult.code === 0) return
    logForDebugging(`git pull failed, will re-clone: ${pullResult.stderr}`, {
      level: 'warn',
    })
  } else {
    logForDebugging(
      `sparse-checkout reconcile requires re-clone: ${reconcileResult.stderr}`,
    )
  }

  try {
    await fs.rm(cachePath, { recursive: true })
    // rm 成功 — 存在过时或部分克隆的目录；记录以用于诊断
    logForDebugging(
      `Found stale marketplace directory at ${cachePath}, cleaning up to allow re-clone`,
      { level: 'warn' },
    )
    safeCallProgress(
      onProgress,
      'Found stale directory, cleaning up and re-cloning…',
    )
  } catch (rmError) {
    if (!isENOENT(rmError)) {
      const rmErrorMsg = errorMessage(rmError)
      throw new Error(
        `Failed to clean up existing marketplace directory. Please manually delete the directory at ${cachePath} and try again.\n\nTechnical details: ${rmErrorMsg}`,
      )
    }
    // ENOENT — cachePath 不存在，这是全新安装，无需清理
  }

  // 克隆仓库（一次尝试 — 无内部重试循环）
  const refMessage = ref ? ` (ref: ${ref})` : ''
  safeCallProgress(
    onProgress,
    `Cloning repository (timeout: ${timeoutSec}s): ${redactUrlCredentials(gitUrl)}${refMessage}`,
  )
  const cloneStarted = performance.now()
  const result = await gitClone(gitUrl, cachePath, ref, sparsePaths)
  logPluginFetch(
    'marketplace_clone',
    gitUrl,
    result.code === 0 ? 'success' : 'failure',
    performance.now() - cloneStarted,
    result.code === 0 ? undefined : classifyFetchError(result.stderr),
  )
  if (result.code !== 0) {
    // 清理失败克隆创建的任何部分目录，以便下次
    // 尝试从头开始。尽力而为：如果失败，过时目录会在
    // 下次调用顶部被自动检测并移除。
    try {
      await fs.rm(cachePath, { recursive: true, force: true })
    } catch {
      // 忽略
    }
    throw new Error(`Failed to clone marketplace repository: ${result.stderr}`)
  }
  safeCallProgress(onProgress, 'Clone complete, validating marketplace…')
}

/**
 * 为安全日志记录编辑头部值
 *
 * @param headers - 要编辑的头部
 * @returns 将值替换为 '***REDACTED***' 的头部
 */
function redactHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key]) => [key, '***REDACTED***']),
  )
}

/**
 * 编辑 URL 中的用户信息（用户名:密码）以避免记录凭据。
 *
 * marketplace URL 可能嵌入凭据（例如 GitHub PAT 在
 * `https://user:token@github.com/org/repo` 中）。调试日志和进度输出
 * 被写入磁盘，可能包含在错误报告中，因此必须在日志记录前编辑凭据。
 *
 * 编辑 http(s) URL 中的所有凭据：
 *   https://user:token@github.com/repo → https://***:***@github.com/repo
 *   https://:token@github.com/repo     → https://:***@github.com/repo
 *   https://token@github.com/repo      → https://***@github.com/repo
 *
 * 用户名和密码在 http(s) 上无条件编辑，因为
 * 无法仅通过解析区分 `placeholder:secret`（例如 x-access-token:ghp_...）
 * 和 `secret:placeholder`（例如 ghp_...:x-oauth-basic）。
 * 非 http(s) 方案（ssh://git@...）和非 URL 输入（`owner/repo` 简写）
 * 不变地传递。
 */
function redactUrlCredentials(urlString: string): string {
  try {
    const parsed = new URL(urlString)
    const isHttp = parsed.protocol === 'http:' || parsed.protocol === 'https:'
    if (isHttp && (parsed.username || parsed.password)) {
      if (parsed.username) parsed.username = '***'
      if (parsed.password) parsed.password = '***'
      return parsed.toString()
    }
  } catch {
    // 不是有效 URL — 原样安全
  }
  return urlString
}

/**
 * 从 URL 缓存 marketplace
 *
 * 从 URL 下载 marketplace.json 文件并保存到本地。
 * 如不存在则创建缓存目录结构。
 *
 * marketplace.json 结构示例：
 * ```json
 * {
 *   "name": "my-marketplace",
 *   "owner": { "name": "John Doe", "email": "john@example.com" },
 *   "plugins": [
 *     {
 *       "id": "my-plugin",
 *       "name": "My Plugin",
 *       "source": "./plugins/my-plugin.json",
 *       "category": "productivity",
 *       "description": "A helpful plugin"
 *     }
 *   ]
 * }
 * ```
 *
 * @param url - 用于下载 marketplace.json 的 URL
 * @param cachePath - 保存下载的 marketplace 的本地文件路径
 * @param customHeaders - 可选的自定义 HTTP 头部（用于认证）
 * @param onProgress - 可选的进度回调
 */
async function cacheMarketplaceFromUrl(
  url: string,
  cachePath: string,
  customHeaders?: Record<string, string>,
  onProgress?: MarketplaceProgressCallback,
): Promise<void> {
  const fs = getFsImplementation()

  const redactedUrl = redactUrlCredentials(url)
  safeCallProgress(onProgress, `Downloading marketplace from ${redactedUrl}`)
  logForDebugging(`Downloading marketplace from URL: ${redactedUrl}`)
  if (customHeaders && Object.keys(customHeaders).length > 0) {
    logForDebugging(
      `Using custom headers: ${jsonStringify(redactHeaders(customHeaders))}`,
    )
  }

  const headers = {
    ...customHeaders,
    // User-Agent 必须放在最后以防止被覆盖（与 WebFetch 保持一致）
    'User-Agent': 'Claude-Code-Plugin-Manager',
  }

  let response
  const fetchStarted = performance.now()
  try {
    response = await axios.get(url, {
      timeout: 10000,
      headers,
    })
  } catch (error) {
    logPluginFetch(
      'marketplace_url',
      url,
      'failure',
      performance.now() - fetchStarted,
      classifyFetchError(error),
    )
    if (axios.isAxiosError(error)) {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
        throw new Error(
          `Could not connect to ${redactedUrl}. Please check your internet connection and verify the URL is correct.\n\nTechnical details: ${error.message}`,
        )
      }
      if (error.code === 'ETIMEDOUT') {
        throw new Error(
          `Request timed out while downloading marketplace from ${redactedUrl}. The server may be slow or unreachable.\n\nTechnical details: ${error.message}`,
        )
      }
      if (error.response) {
        throw new Error(
          `HTTP ${error.response.status} error while downloading marketplace from ${redactedUrl}. The marketplace file may not exist at this URL.\n\nTechnical details: ${error.message}`,
        )
      }
    }
    throw new Error(
      `Failed to download marketplace from ${redactedUrl}: ${errorMessage(error)}`,
    )
  }

  safeCallProgress(onProgress, 'Validating marketplace data')
  // 校验响应是否为有效的 marketplace
  const result = PluginMarketplaceSchema().safeParse(response.data)
  if (!result.success) {
    logPluginFetch(
      'marketplace_url',
      url,
      'failure',
      performance.now() - fetchStarted,
      'invalid_schema',
    )
    throw new ConfigParseError(
      `Invalid marketplace schema from URL: ${result.error.issues.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')}`,
      redactedUrl,
      response.data,
    )
  }
  logPluginFetch(
    'marketplace_url',
    url,
    'success',
    performance.now() - fetchStarted,
  )

  safeCallProgress(onProgress, 'Saving marketplace to cache')
  // 确保缓存目录存在
  const cacheDir = join(cachePath, '..')
  await fs.mkdir(cacheDir)

  // 写入已校验的 marketplace 文件
  writeFileSync_DEPRECATED(cachePath, jsonStringify(result.data, null, 2), {
    encoding: 'utf-8',
    flush: true,
  })
}

/**
 * 为 marketplace 来源生成缓存路径
 */
function getCachePathForSource(source: MarketplaceSource): string {
  const tempName =
    source.source === 'github'
      ? source.repo.replace('/', '-')
      : source.source === 'npm'
        ? source.package.replace('@', '').replace('/', '-')
        : source.source === 'file'
          ? basename(source.path).replace('.json', '')
          : source.source === 'directory'
            ? basename(source.path)
            : 'temp_' + Date.now()
  return tempName
}

/**
 * 使用 Zod schema 解析并校验 JSON 文件
 */
async function parseFileWithSchema<T>(
  filePath: string,
  schema: {
    safeParse: (data: unknown) => {
      success: boolean
      data?: T
      error?: {
        issues: Array<{ path: PropertyKey[]; message: string }>
      }
    }
  },
): Promise<T> {
  const fs = getFsImplementation()
  const content = await fs.readFile(filePath, { encoding: 'utf-8' })
  let data: unknown
  try {
    data = jsonParse(content)
  } catch (error) {
    throw new ConfigParseError(
      `Invalid JSON in ${filePath}: ${errorMessage(error)}`,
      filePath,
      content,
    )
  }
  const result = schema.safeParse(data)
  if (!result.success) {
    throw new ConfigParseError(
      `Invalid schema: ${filePath} ${result.error?.issues.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')}`,
      filePath,
      data,
    )
  }
  return result.data!
}

/**
 * 从来源加载并缓存 marketplace
 *
 * 处理不同的来源类型：
 * - URL：直接下载 marketplace.json
 * - GitHub：克隆仓库并查找 .claude-plugin/marketplace.json
 * - Git：从 git URL 克隆仓库
 * - NPM：（尚未实现）将从 npm 包获取
 * - File：从本地文件系统读取
 *
 * 加载后，校验 marketplace schema 并重命名缓存
 * 以匹配清单中 marketplace 的实际名称。
 *
 * 缓存结构：
 * ~/.claude/plugins/marketplaces/
 *   ├── official-marketplace.json     # 来自 URL 来源
 *   ├── github-marketplace/          # 来自 GitHub/Git 来源
 *   │   └── .claude-plugin/
 *   │       └── marketplace.json
 *   └── local-marketplace.json       # 来自 file 来源
 *
 * @param source - 要加载的 marketplace 来源
 * @param onProgress - 可选的进度回调
 * @returns 包含已校验 marketplace 及其缓存路径的对象
 * @throws 如果 marketplace 文件未找到或校验失败
 */
async function loadAndCacheMarketplace(
  source: MarketplaceSource,
  onProgress?: MarketplaceProgressCallback,
): Promise<LoadedPluginMarketplace> {
  const fs = getFsImplementation()
  const cacheDir = getMarketplacesCacheDir()

  // 确保缓存目录存在
  await fs.mkdir(cacheDir)

  let temporaryCachePath: string
  let marketplacePath: string
  let cleanupNeeded = false

  // 为缓存路径生成临时名称
  const tempName = getCachePathForSource(source)

  try {
    switch (source.source) {
      case 'url': {
        // 直接指向 marketplace.json 的 URL
        temporaryCachePath = join(cacheDir, `${tempName}.json`)
        cleanupNeeded = true
        await cacheMarketplaceFromUrl(
          source.url,
          temporaryCachePath,
          source.headers,
          onProgress,
        )
        marketplacePath = temporaryCachePath
        break
      }

      case 'github': {
        // 智能 SSH/HTTPS 选择：在尝试 SSH 之前先检查是否已配置
        // 这避免了在 SSH 未配置时等待超时
        const sshUrl = `git@github.com:${source.repo}.git`
        const httpsUrl = `https://github.com/${source.repo}.git`
        temporaryCachePath = join(cacheDir, tempName)
        cleanupNeeded = true

        let lastError: Error | null = null

        // 快速检查 SSH 是否可能正常工作
        const sshConfigured = await isGitHubSshLikelyConfigured()

        if (sshConfigured) {
          // SSH 看起来没问题，先试试
          safeCallProgress(onProgress, `Cloning via SSH: ${sshUrl}`)
          try {
            await cacheMarketplaceFromGit(
              sshUrl,
              temporaryCachePath,
              source.ref,
              source.sparsePaths,
              onProgress,
            )
          } catch (err) {
            lastError = toError(err)

            // 记录 SSH 失败以供监控
            logError(lastError)

            // SSH 尽管已配置仍然失败，尝试 HTTPS 回退
            safeCallProgress(
              onProgress,
              `SSH clone failed, retrying with HTTPS: ${httpsUrl}`,
            )

            logForDebugging(
              `SSH clone failed for ${source.repo} despite SSH being configured, falling back to HTTPS`,
              { level: 'info' },
            )

            // 清理失败的 SSH 尝试创建的任何内容
            await fs.rm(temporaryCachePath, { recursive: true, force: true })

            // 尝试 HTTPS
            try {
              await cacheMarketplaceFromGit(
                httpsUrl,
                temporaryCachePath,
                source.ref,
                source.sparsePaths,
                onProgress,
              )
              lastError = null // 成功！
            } catch (httpsErr) {
              // HTTPS 也失败了 — 使用 HTTPS 错误作为最终错误
              lastError = toError(httpsErr)

              // 记录 HTTPS 失败以供监控（SSH 和 HTTPS 均失败）
              logError(lastError)
            }
          }
        } else {
          // SSH 未配置，直接走 HTTPS
          safeCallProgress(
            onProgress,
            `SSH not configured, cloning via HTTPS: ${httpsUrl}`,
          )

          logForDebugging(
            `SSH not configured for GitHub, using HTTPS for ${source.repo}`,
            { level: 'info' },
          )

          try {
            await cacheMarketplaceFromGit(
              httpsUrl,
              temporaryCachePath,
              source.ref,
              source.sparsePaths,
              onProgress,
            )
          } catch (err) {
            lastError = toError(err)

            // 对于任何 HTTPS 失败始终尝试 SSH 作为回退
            // 记录 HTTPS 失败以供监控
            logError(lastError)

            // HTTPS 失败，尝试 SSH 作为回退
            safeCallProgress(
              onProgress,
              `HTTPS clone failed, retrying with SSH: ${sshUrl}`,
            )

            logForDebugging(
              `HTTPS clone failed for ${source.repo} (${lastError.message}), falling back to SSH`,
              { level: 'info' },
            )

            // 清理失败的 HTTPS 尝试创建的任何内容
            await fs.rm(temporaryCachePath, { recursive: true, force: true })

            // 尝试 SSH
            try {
              await cacheMarketplaceFromGit(
                sshUrl,
                temporaryCachePath,
                source.ref,
                source.sparsePaths,
                onProgress,
              )
              lastError = null // 成功！
            } catch (sshErr) {
              // SSH 也失败了 — 使用 SSH 错误作为最终错误
              lastError = toError(sshErr)

              // 记录 SSH 失败以供监控（HTTPS 和 SSH 均失败）
              logError(lastError)
            }
          }
        }

        // 如果仍有错误，抛出
        if (lastError) {
          throw lastError
        }

        marketplacePath = join(
          temporaryCachePath,
          source.path || '.claude-plugin/marketplace.json',
        )
        break
      }

      case 'git': {
        temporaryCachePath = join(cacheDir, tempName)
        cleanupNeeded = true
        await cacheMarketplaceFromGit(
          source.url,
          temporaryCachePath,
          source.ref,
          source.sparsePaths,
          onProgress,
        )
        marketplacePath = join(
          temporaryCachePath,
          source.path || '.claude-plugin/marketplace.json',
        )
        break
      }

      case 'npm': {
        // TODO: 实现 npm 包支持
        throw new Error('NPM marketplace sources not yet implemented')
      }

      case 'file': {
        // 对于本地文件，解析相对于 marketplace 根目录的路径
        // file 来源指向 .claude-plugin/marketplace.json，因此 marketplace
        // 根目录在上两级（.claude-plugin/ 的父目录）
        // 解析为绝对路径以便错误消息显示实际检查的路径
        //（旧版 known_marketplaces.json 条目可能包含相对路径）
        const absPath = resolve(source.path)
        marketplacePath = absPath
        temporaryCachePath = dirname(dirname(absPath))
        cleanupNeeded = false
        break
      }

      case 'directory': {
        // 对于目录，查找 .claude-plugin/marketplace.json
        // 解析为绝对路径以便错误消息显示实际检查的路径
        //（旧版 known_marketplaces.json 条目可能包含相对路径）
        const absPath = resolve(source.path)
        marketplacePath = join(absPath, '.claude-plugin', 'marketplace.json')
        temporaryCachePath = absPath
        cleanupNeeded = false
        break
      }

      case 'settings': {
        // 来自 settings.json 的内联清单 — 无需获取。在磁盘上合成
        // marketplace.json，以便 getMarketplaceCacheOnly 像其他来源一样
        // 读取它。plugins 数组在 settings 解析时已通过
        // PluginMarketplaceEntrySchema 校验；切换后的 parseFileWithSchema
        // 重新校验完整的 PluginMarketplaceSchema（捕获两者之间的
        // schema 漂移）。
        //
        // 预先写入 source.name 意味着下面的重命名是无操作
        //（temporaryCachePath === finalCachePath）。known_marketplaces.json
        // 存储此来源对象（包括 plugins 数组），因此
        // diffMarketplaces 通过 isEqual 检测 settings 编辑 — 无需
        // 特殊的脏标记跟踪。
        temporaryCachePath = join(cacheDir, source.name)
        marketplacePath = join(
          temporaryCachePath,
          '.claude-plugin',
          'marketplace.json',
        )
        cleanupNeeded = false
        await fs.mkdir(dirname(marketplacePath))
        // 此处不使用 `satisfies PluginMarketplace`：source.plugins 是窄
        // SettingsMarketplacePlugin 类型（无 strict/.default()，无清单
        // 字段）。下面的 parseFileWithSchema(PluginMarketplaceSchema())
        // 调用拓宽并校验 — 那才是真正的检查。
        await writeFile(
          marketplacePath,
          jsonStringify(
            {
              name: source.name,
              owner: source.owner ?? { name: 'settings' },
              plugins: source.plugins,
            },
            null,
            2,
          ),
        )
        break
      }

      default:
        throw new Error(`Unsupported marketplace source type`)
    }

    // 加载并校验 marketplace
    logForDebugging(`Reading marketplace from ${marketplacePath}`)
    let marketplace: PluginMarketplace
    try {
      marketplace = await parseFileWithSchema(
        marketplacePath,
        PluginMarketplaceSchema(),
      )
    } catch (e) {
      if (isENOENT(e)) {
        throw new Error(`Marketplace file not found at ${marketplacePath}`)
      }
      throw new Error(
        `Failed to parse marketplace file at ${marketplacePath}: ${errorMessage(e)}`,
      )
    }

    // 现在重命名缓存路径以使用 marketplace 的实际名称
    const finalCachePath = join(cacheDir, marketplace.name)
    // 深度防御：schema 拒绝 marketplace.name 中的路径分隔符、.. 和 .，
    // 但在 fs.rm 之前验证计算出的路径是 cacheDir 的严格子目录。
    // 带有精心构造名称的恶意 marketplace.json 绝不能导致我们在
    // cacheDir 之外执行 rm，也不能 rm cacheDir 本身
    //（例如 name "." → join 规范化为 cacheDir）。
    const resolvedFinal = resolve(finalCachePath)
    const resolvedCacheDir = resolve(cacheDir)
    if (!resolvedFinal.startsWith(resolvedCacheDir + sep)) {
      throw new Error(
        `Marketplace name '${marketplace.name}' resolves to a path outside the cache directory`,
      )
    }
    // 如果是本地文件或目录，或者已经具有正确的名称，则不重命名
    if (
      temporaryCachePath !== finalCachePath &&
      !isLocalMarketplaceSource(source)
    ) {
      try {
        // 如果目标已存在则移除，然后重命名
        try {
          onProgress?.('Cleaning up old marketplace cache…')
        } catch (callbackError) {
          logForDebugging(
            `Progress callback error: ${errorMessage(callbackError)}`,
            { level: 'warn' },
          )
        }
        await fs.rm(finalCachePath, { recursive: true, force: true })
        // 将临时缓存重命名为最终名称
        await fs.rename(temporaryCachePath, finalCachePath)
        temporaryCachePath = finalCachePath
        cleanupNeeded = false // 成功重命名，无需清理
      } catch (error) {
        const errorMsg = errorMessage(error)
        throw new Error(
          `Failed to finalize marketplace cache. Please manually delete the directory at ${finalCachePath} if it exists and try again.\n\nTechnical details: ${errorMsg}`,
        )
      }
    }

    return { marketplace, cachePath: temporaryCachePath }
  } catch (error) {
    // 出错时清理任何临时文件/目录
    if (
      cleanupNeeded &&
      temporaryCachePath! &&
      !isLocalMarketplaceSource(source)
    ) {
      try {
        await fs.rm(temporaryCachePath!, { recursive: true, force: true })
      } catch (cleanupError) {
        logForDebugging(
          `Warning: Failed to clean up temporary marketplace cache at ${temporaryCachePath}: ${errorMessage(cleanupError)}`,
          { level: 'warn' },
        )
      }
    }
    throw error
  }
}

/**
 * 将 marketplace 来源添加到已知 marketplace
 *
 * marketplace 被获取、校验并缓存到本地。
 * 配置保存到 ~/.claude/plugins/known_marketplaces.json。
 *
 * @param source - 表示 marketplace 来源的 MarketplaceSource 对象。
 *                 调用者应将用户输入解析为 MarketplaceSource 格式
 *                 （参见 AddMarketplace.parseMarketplaceInput 处理 "owner/repo" 等快捷方式）。
 * @param onProgress - marketplace 安装过程中的可选进度回调
 * @throws 如果来源格式无效或 marketplace 无法加载
 */
export async function addMarketplaceSource(
  source: MarketplaceSource,
  onProgress?: MarketplaceProgressCallback,
): Promise<{
  name: string
  alreadyMaterialized: boolean
  resolvedSource: MarketplaceSource
}> {
  // 将相对目录/文件路径解析为绝对路径，使状态独立于 cwd
  let resolvedSource = source
  if (isLocalMarketplaceSource(source) && !isAbsolute(source.path)) {
    resolvedSource = { ...source, path: resolve(source.path) }
  }

  // 首先检查策略，在任何网络/文件系统操作之前
  // 这防止在来源被阻止时仍然下载/克隆
  if (!isSourceAllowedByPolicy(resolvedSource)) {
    // 检查是明确被阻止还是不在白名单中，以便提供更好的错误消息
    if (isSourceInBlocklist(resolvedSource)) {
      throw new Error(
        `Marketplace source '${formatSourceForDisplay(resolvedSource)}' is blocked by enterprise policy.`,
      )
    }
    // 不在白名单中 — 构建有用的错误消息
    const allowlist = getStrictKnownMarketplaces() || []
    const hostPatterns = getHostPatternsFromAllowlist()
    const sourceHost = extractHostFromSource(resolvedSource)

    let errorMessage = `Marketplace source '${formatSourceForDisplay(resolvedSource)}'`
    if (sourceHost) {
      errorMessage += ` (${sourceHost})`
    }
    errorMessage += ' is blocked by enterprise policy.'

    if (allowlist.length > 0) {
      errorMessage += ` Allowed sources: ${allowlist.map(s => formatSourceForDisplay(s)).join(', ')}`
    } else {
      errorMessage += ' No external marketplaces are allowed.'
    }

    // 如果来源是 github 简写且存在 hostPatterns，建议使用完整 URL
    if (resolvedSource.source === 'github' && hostPatterns.length > 0) {
      errorMessage +=
        `\n\nTip: The shorthand "${resolvedSource.repo}" assumes github.com. ` +
        `For internal GitHub Enterprise, use the full URL:\n` +
        `  git@your-github-host.com:${resolvedSource.repo}.git`
    }

    throw new Error(errorMessage)
  }

  // 来源幂等性：如果完全相同的来源已存在，跳过克隆
  const existingConfig = await loadKnownMarketplacesConfig()
  for (const [existingName, existingEntry] of Object.entries(existingConfig)) {
    if (isEqual(existingEntry.source, resolvedSource)) {
      logForDebugging(
        `Source already materialized as '${existingName}', skipping clone`,
      )
      return { name: existingName, alreadyMaterialized: true, resolvedSource }
    }
  }

  // 加载并缓存 marketplace 以校验并获取其名称
  const { marketplace, cachePath } = await loadAndCacheMarketplace(
    resolvedSource,
    onProgress,
  )

  // 校验保留名称来自官方来源
  const sourceValidationError = validateOfficialNameSource(
    marketplace.name,
    resolvedSource,
  )
  if (sourceValidationError) {
    throw new Error(sourceValidationError)
  }

  // 名称冲突但来源不同：覆盖（settings 意图优先）。
  // seed 管理的条目由管理员控制，不能被覆盖。
  // 克隆后重新读取配置（可能耗时；另一个进程可能已写入）。
  const config = await loadKnownMarketplacesConfig()
  const oldEntry = config[marketplace.name]
  if (oldEntry) {
    const seedDir = seedDirFor(oldEntry.installLocation)
    if (seedDir) {
      throw new Error(
        `Marketplace '${marketplace.name}' is seed-managed (${seedDir}). ` +
          `To use a different source, ask your admin to update the seed, ` +
          `or use a different marketplace name.`,
      )
    }
    logForDebugging(
      `Marketplace '${marketplace.name}' exists with different source — overwriting`,
    )
    // 如果旧缓存不是用户拥有的本地路径且与新 cachePath
    // 实际不同，则清理旧缓存。loadAndCacheMarketplace 在到达此处
    // 之前已写入 cachePath — rm 同一目录会删除新写入的内容。
    // settings 来源始终落在同一目录（name → path）；
    // git 来源在来源仓库变更但获取的 marketplace.json
    // 声明相同名称时会潜在触发此问题。仅在位置
    // 确实不同时才 rm（这是唯一存在过时目录需要清理的情况）。
    //
    // 在 rm 之前防御性地校验存储的路径：损坏的
    // installLocation（gh-32793, gh-32661）可能指向用户的项目
    // 目录。如果在缓存目录之外，跳过清理 — 过时目录
    //（如果有的话）无害，而阻止重新添加会妨碍用户
    // 修复损坏。
    if (!isLocalMarketplaceSource(oldEntry.source)) {
      const cacheDir = resolve(getMarketplacesCacheDir())
      const resolvedOld = resolve(oldEntry.installLocation)
      const resolvedNew = resolve(cachePath)
      if (resolvedOld === resolvedNew) {
        // 同一目录 — loadAndCacheMarketplace 已就地覆盖。
        // 无需清理。
      } else if (
        resolvedOld === cacheDir ||
        resolvedOld.startsWith(cacheDir + sep)
      ) {
        const fs = getFsImplementation()
        await fs.rm(oldEntry.installLocation, { recursive: true, force: true })
      } else {
        logForDebugging(
          `Skipping cleanup of old installLocation (${oldEntry.installLocation}) — ` +
            `outside ${cacheDir}. The path is corrupted; leaving it alone and ` +
            `overwriting the config entry.`,
          { level: 'warn' },
        )
      }
    }
  }

  // 使用 marketplace 的实际名称更新配置
  config[marketplace.name] = {
    source: resolvedSource,
    installLocation: cachePath,
    lastUpdated: new Date().toISOString(),
  }
  await saveKnownMarketplacesConfig(config)

  logForDebugging(`Added marketplace source: ${marketplace.name}`)

  return { name: marketplace.name, alreadyMaterialized: false, resolvedSource }
}

/**
 * 从已知 marketplace 中移除 marketplace 来源
 *
 * 移除 marketplace 配置并清理缓存文件。
 * 删除目录缓存（git 来源）和文件缓存（URL 来源）。
 * 同时从 settings.json（extraKnownMarketplaces）中清理 marketplace
 * 并从 enabledPlugins 中移除相关插件条目。
 *
 * @param name - 要移除的 marketplace 名称
 * @throws 如果未找到给定名称的 marketplace
 */
export async function removeMarketplaceSource(name: string): Promise<void> {
  const config = await loadKnownMarketplacesConfig()

  if (!config[name]) {
    throw new Error(`Marketplace '${name}' not found`)
  }

  // seed 注册的 marketplace 由管理员烘焙到容器中 — 移除
  // 它们是类别错误。无论如何它们会在下次启动时复活。
  // 引导用户采取正确的操作。
  const entry = config[name]
  const seedDir = seedDirFor(entry.installLocation)
  if (seedDir) {
    throw new Error(
      `Marketplace '${name}' is registered from the read-only seed directory ` +
        `(${seedDir}) and will be re-registered on next startup. ` +
        `To stop using its plugins: claude plugin disable <plugin>@${name}`,
    )
  }

  // 从配置中移除
  delete config[name]
  await saveKnownMarketplacesConfig(config)

  // 清理缓存文件（目录和 JSON 两种格式）
  const fs = getFsImplementation()
  const cacheDir = getMarketplacesCacheDir()
  const cachePath = join(cacheDir, name)
  await fs.rm(cachePath, { recursive: true, force: true })
  const jsonCachePath = join(cacheDir, `${name}.json`)
  await fs.rm(jsonCachePath, { force: true })

  // 清理 settings.json — 从 extraKnownMarketplaces 中移除 marketplace
  // 并从 enabledPlugins 中移除相关插件条目

  // 检查每个可编辑的 settings 来源
  const editableSources: Array<
    'userSettings' | 'projectSettings' | 'localSettings'
  > = ['userSettings', 'projectSettings', 'localSettings']

  for (const source of editableSources) {
    const settings = getSettingsForSource(source)
    if (!settings) continue

    let needsUpdate = false
    const updates: {
      extraKnownMarketplaces?: typeof settings.extraKnownMarketplaces
      enabledPlugins?: typeof settings.enabledPlugins
    } = {}

    // 如果存在则从 extraKnownMarketplaces 中移除
    if (settings.extraKnownMarketplaces?.[name]) {
      const updatedMarketplaces: Partial<
        SettingsJson['extraKnownMarketplaces']
      > = { ...settings.extraKnownMarketplaces }
      // 使用 undefined 值（而非 delete）通过 mergeWith 发出键移除信号
      updatedMarketplaces[name] = undefined
      updates.extraKnownMarketplaces =
        updatedMarketplaces as SettingsJson['extraKnownMarketplaces']
      needsUpdate = true
    }

    // 从 enabledPlugins 中移除相关插件（格式："plugin@marketplace"）
    if (settings.enabledPlugins) {
      const marketplaceSuffix = `@${name}`
      const updatedPlugins = { ...settings.enabledPlugins }
      let removedPlugins = false

      for (const pluginId in updatedPlugins) {
        if (pluginId.endsWith(marketplaceSuffix)) {
          updatedPlugins[pluginId] = undefined
          removedPlugins = true
        }
      }

      if (removedPlugins) {
        updates.enabledPlugins = updatedPlugins
        needsUpdate = true
      }
    }

    // 如果发生了变更则更新 settings
    if (needsUpdate) {
      const result = updateSettingsForSource(source, updates)
      if (result.error) {
        logError(result.error)
        logForDebugging(
          `Failed to clean up marketplace '${name}' from ${source} settings: ${result.error.message}`,
        )
      } else {
        logForDebugging(
          `Cleaned up marketplace '${name}' from ${source} settings`,
        )
      }
    }
  }

  // 从 installed_plugins.json 中移除插件并标记孤立路径。
  // 同时清除其存储的选项/密钥 — marketplace 移除后
  // 剩余零个安装，与 uninstallPluginOp 的
  // "最后一个作用域已移除"条件相同。
  const { orphanedPaths, removedPluginIds } =
    removeAllPluginsForMarketplace(name)
  for (const installPath of orphanedPaths) {
    await markPluginVersionOrphaned(installPath)
  }
  for (const pluginId of removedPluginIds) {
    deletePluginOptions(pluginId)
    await deletePluginDataDir(pluginId)
  }

  logForDebugging(`Removed marketplace source: ${name}`)
}

/**
 * 从磁盘读取已缓存的 marketplace，不进行更新
 *
 * @param installLocation - 已缓存 marketplace 的路径
 * @returns marketplace 对象
 * @throws 当 marketplace 文件未找到或无效时抛出异常
 */
async function readCachedMarketplace(
  installLocation: string,
): Promise<PluginMarketplace> {
  // 对于 git 来源的目录，manifest 位于 .claude-plugin/marketplace.json。
  // 对于 url/file/directory 来源，installLocation 本身就是 manifest 路径。
  // 优先尝试嵌套路径；当嵌套文件不存在（ENOENT）或路径不是目录（ENOTDIR）时，
  // 回退到 installLocation。
  const nestedPath = join(installLocation, '.claude-plugin', 'marketplace.json')
  try {
    return await parseFileWithSchema(nestedPath, PluginMarketplaceSchema())
  } catch (e) {
    if (e instanceof ConfigParseError) throw e
    const code = getErrnoCode(e)
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw e
  }
  return await parseFileWithSchema(installLocation, PluginMarketplaceSchema())
}

/**
 * Get a specific marketplace by name from cache only (no network).
 * Returns null if cache is missing or corrupted.
 * Use this for startup paths that should never block on network.
 */
export async function getMarketplaceCacheOnly(
  name: string,
): Promise<PluginMarketplace | null> {
  const fs = getFsImplementation()
  const configFile = getKnownMarketplacesFile()

  try {
    const content = await fs.readFile(configFile, { encoding: 'utf-8' })
    const config = jsonParse(content) as KnownMarketplacesConfig
    const entry = config[name]

    if (!entry) {
      return null
    }

    return await readCachedMarketplace(entry.installLocation)
  } catch (error) {
    if (isENOENT(error)) {
      return null
    }
    logForDebugging(
      `Failed to read cached marketplace ${name}: ${errorMessage(error)}`,
      { level: 'warn' },
    )
    return null
  }
}

/**
 * Get a specific marketplace by name
 *
 * First attempts to read from cache. Only fetches from source if:
 * - No cached version exists
 * - Cache is invalid/corrupted
 *
 * This avoids unnecessary network/git operations on every access.
 * Use refreshMarketplace() to explicitly update from source.
 *
 * @param name - The marketplace name to fetch
 * @returns The marketplace object or null if not found/failed
 */
export const getMarketplace = memoize(
  async (name: string): Promise<PluginMarketplace> => {
    const config = await loadKnownMarketplacesConfig()
    const entry = config[name]

    if (!entry) {
      throw new Error(
        `Marketplace '${name}' not found in configuration. Available marketplaces: ${Object.keys(config).join(', ')}`,
      )
    }

    // Legacy entries (pre-#19708) may have relative paths in global config.
    // These are meaningless outside the project that wrote them — resolving
    // against process.cwd() produces the wrong path. Give actionable guidance
    // instead of a misleading ENOENT.
    if (
      isLocalMarketplaceSource(entry.source) &&
      !isAbsolute(entry.source.path)
    ) {
      throw new Error(
        `Marketplace "${name}" has a relative source path (${entry.source.path}) ` +
          `in known_marketplaces.json — this is stale state from an older ` +
          `Claude Code version. Run 'claude marketplace remove ${name}' and ` +
          `re-add it from the original project directory.`,
      )
    }

    // Try to read from disk cache
    try {
      return await readCachedMarketplace(entry.installLocation)
    } catch (error) {
      // Log cache corruption before re-fetching
      logForDebugging(
        `Cache corrupted or missing for marketplace ${name}, re-fetching from source: ${errorMessage(error)}`,
        {
          level: 'warn',
        },
      )
    }

    // Cache doesn't exist or is invalid, fetch from source
    let marketplace: PluginMarketplace
    try {
      ;({ marketplace } = await loadAndCacheMarketplace(entry.source))
    } catch (error) {
      throw new Error(
        `Failed to load marketplace "${name}" from source (${entry.source.source}): ${errorMessage(error)}`,
      )
    }

    // Update lastUpdated only when we actually fetch
    config[name]!.lastUpdated = new Date().toISOString()
    await saveKnownMarketplacesConfig(config)

    return marketplace
  },
)

/**
 * Get plugin by ID from cache only (no network calls).
 * Returns null if marketplace cache is missing or corrupted.
 * Use this for startup paths that should never block on network.
 *
 * @param pluginId - The plugin ID in format "name@marketplace"
 * @returns The plugin entry or null if not found/cache missing
 */
export async function getPluginByIdCacheOnly(pluginId: string): Promise<{
  entry: PluginMarketplaceEntry
  marketplaceInstallLocation: string
} | null> {
  const { name: pluginName, marketplace: marketplaceName } =
    parsePluginIdentifier(pluginId)
  if (!pluginName || !marketplaceName) {
    return null
  }

  const fs = getFsImplementation()
  const configFile = getKnownMarketplacesFile()

  try {
    const content = await fs.readFile(configFile, { encoding: 'utf-8' })
    const config = jsonParse(content) as KnownMarketplacesConfig
    const marketplaceConfig = config[marketplaceName]

    if (!marketplaceConfig) {
      return null
    }

    const marketplace = await getMarketplaceCacheOnly(marketplaceName)
    if (!marketplace) {
      return null
    }

    const plugin = marketplace.plugins.find(p => p.name === pluginName)
    if (!plugin) {
      return null
    }

    return {
      entry: plugin,
      marketplaceInstallLocation: marketplaceConfig.installLocation,
    }
  } catch {
    return null
  }
}

/**
 * Get plugin by ID from a specific marketplace
 *
 * First tries cache-only lookup. If cache is missing/corrupted,
 * falls back to fetching from source.
 *
 * @param pluginId - The plugin ID in format "name@marketplace"
 * @returns The plugin entry or null if not found
 */
export async function getPluginById(pluginId: string): Promise<{
  entry: PluginMarketplaceEntry
  marketplaceInstallLocation: string
} | null> {
  // Try cache-only first (fast path)
  const cached = await getPluginByIdCacheOnly(pluginId)
  if (cached) {
    return cached
  }

  // Cache miss - try fetching from source
  const { name: pluginName, marketplace: marketplaceName } =
    parsePluginIdentifier(pluginId)
  if (!pluginName || !marketplaceName) {
    return null
  }

  try {
    const config = await loadKnownMarketplacesConfig()
    const marketplaceConfig = config[marketplaceName]
    if (!marketplaceConfig) {
      return null
    }

    const marketplace = await getMarketplace(marketplaceName)
    const plugin = marketplace.plugins.find(p => p.name === pluginName)

    if (!plugin) {
      return null
    }

    return {
      entry: plugin,
      marketplaceInstallLocation: marketplaceConfig.installLocation,
    }
  } catch (error) {
    logForDebugging(
      `Could not find plugin ${pluginId}: ${errorMessage(error)}`,
      { level: 'debug' },
    )
    return null
  }
}

/**
 * Refresh all marketplace caches
 *
 * Updates all configured marketplaces from their sources.
 * Continues refreshing even if some marketplaces fail.
 * Updates lastUpdated timestamps for successful refreshes.
 *
 * This is useful for:
 * - Periodic updates to get new plugins
 * - Syncing after network connectivity is restored
 * - Ensuring caches are up-to-date before browsing
 *
 * @returns Promise that resolves when all refresh attempts complete
 */
export async function refreshAllMarketplaces(): Promise<void> {
  const config = await loadKnownMarketplacesConfig()

  for (const [name, entry] of Object.entries(config)) {
    // Seed-managed marketplaces are controlled by the seed image — refreshing
    // them is pointless (registerSeedMarketplaces overwrites on next startup).
    if (seedDirFor(entry.installLocation)) {
      logForDebugging(
        `Skipping seed-managed marketplace '${name}' in bulk refresh`,
      )
      continue
    }
    // settings-sourced marketplaces have no upstream — see refreshMarketplace.
    if (entry.source.source === 'settings') {
      continue
    }
    // inc-5046: same GCS intercept as refreshMarketplace() — bulk update
    // hits this path on `claude plugin marketplace update` (no name arg).
    if (name === OFFICIAL_MARKETPLACE_NAME) {
      const sha = await fetchOfficialMarketplaceFromGcs(
        entry.installLocation,
        getMarketplacesCacheDir(),
      )
      if (sha !== null) {
        config[name]!.lastUpdated = new Date().toISOString()
        continue
      }
      if (
        !getFeatureValue_CACHED_MAY_BE_STALE(
          'tengu_plugin_official_mkt_git_fallback',
          true,
        )
      ) {
        logForDebugging(
          `Skipping official marketplace bulk refresh: GCS failed, git fallback disabled`,
        )
        continue
      }
      // fall through to git
    }
    try {
      const { cachePath } = await loadAndCacheMarketplace(entry.source)
      config[name]!.lastUpdated = new Date().toISOString()
      config[name]!.installLocation = cachePath
    } catch (error) {
      logForDebugging(
        `Failed to refresh marketplace ${name}: ${errorMessage(error)}`,
        {
          level: 'error',
        },
      )
    }
  }

  await saveKnownMarketplacesConfig(config)
}

/**
 * Refresh a single marketplace cache
 *
 * Updates a specific marketplace from its source by doing an in-place update.
 * For git sources, runs git pull in the existing directory.
 * For URL sources, re-downloads to the existing file.
 * Clears the memoization cache and updates the lastUpdated timestamp.
 *
 * @param name - The name of the marketplace to refresh
 * @param onProgress - Optional callback to report progress
 * @throws If marketplace not found or refresh fails
 */
export async function refreshMarketplace(
  name: string,
  onProgress?: MarketplaceProgressCallback,
  options?: { disableCredentialHelper?: boolean },
): Promise<void> {
  const config = await loadKnownMarketplacesConfig()
  const entry = config[name]

  if (!entry) {
    throw new Error(
      `Marketplace '${name}' not found. Available marketplaces: ${Object.keys(config).join(', ')}`,
    )
  }

  // Clear the memoization cache for this specific marketplace
  getMarketplace.cache?.delete?.(name)

  // settings-sourced marketplaces have no upstream to pull. Edits to the
  // inline plugins array surface as sourceChanged in the reconciler, which
  // re-materializes via addMarketplaceSource — refresh is not the vehicle.
  if (entry.source.source === 'settings') {
    logForDebugging(
      `Skipping refresh for settings-sourced marketplace '${name}' — no upstream`,
    )
    return
  }

  try {
    // For updates, use the existing installLocation directly (in-place update)
    const installLocation = entry.installLocation
    const source = entry.source

    // Seed-managed marketplaces are controlled by the seed image. Refreshing
    // would be pointless — registerSeedMarketplaces() overwrites installLocation
    // back to seed on next startup. Error with guidance instead.
    const seedDir = seedDirFor(installLocation)
    if (seedDir) {
      throw new Error(
        `Marketplace '${name}' is seed-managed (${seedDir}) and its content is ` +
          `controlled by the seed image. To update: ask your admin to update the seed.`,
      )
    }

    // For remote sources (github/git/url), installLocation must be inside the
    // marketplaces cache dir. A corrupted value (gh-32793, gh-32661 — e.g.
    // Windows path read on WSL, literal tilde, manual edit) can point at the
    // user's project. cacheMarketplaceFromGit would then run git ops with that
    // cwd (git walks up to the user's .git) and fs.rm it on pull failure.
    // Refuse instead of auto-fixing so the user knows their state is corrupted.
    if (!isLocalMarketplaceSource(source)) {
      const cacheDir = resolve(getMarketplacesCacheDir())
      const resolvedLoc = resolve(installLocation)
      if (resolvedLoc !== cacheDir && !resolvedLoc.startsWith(cacheDir + sep)) {
        throw new Error(
          `Marketplace '${name}' has a corrupted installLocation ` +
            `(${installLocation}) — expected a path inside ${cacheDir}. ` +
            `This can happen after cross-platform path writes or manual edits ` +
            `to known_marketplaces.json. ` +
            `Run: claude plugin marketplace remove "${name}" and re-add it.`,
        )
      }
    }

    // inc-5046: official marketplace fetches from a GCS mirror instead of
    // git-cloning GitHub. Special-cased by NAME (not a new source type) so
    // no data migration is needed — existing known_marketplaces.json entries
    // still say source:'github', which is true (GCS is a mirror).
    if (name === OFFICIAL_MARKETPLACE_NAME) {
      const sha = await fetchOfficialMarketplaceFromGcs(
        installLocation,
        getMarketplacesCacheDir(),
      )
      if (sha !== null) {
        config[name] = { ...entry, lastUpdated: new Date().toISOString() }
        await saveKnownMarketplacesConfig(config)
        return
      }
      // GCS failed — fall through to git ONLY if the kill-switch allows.
      // Default true (backend write perms are pending as of inc-5046); flip
      // to false via GrowthBook once the backend is confirmed live so new
      // clients NEVER hit GitHub for the official marketplace.
      if (
        !getFeatureValue_CACHED_MAY_BE_STALE(
          'tengu_plugin_official_mkt_git_fallback',
          true,
        )
      ) {
        // Throw, don't return — every other failure path in this function
        // throws, and callers like ManageMarketplaces.tsx:259 increment
        // updatedCount on any non-throwing return. A silent return would
        // report "Updated 1 marketplace" when nothing was refreshed.
        throw new Error(
          'Official marketplace GCS fetch failed and git fallback is disabled',
        )
      }
      logForDebugging('Official marketplace GCS failed; falling back to git', {
        level: 'warn',
      })
      // ...falls through to source.source === 'github' branch below
    }

    // Update based on source type
    if (source.source === 'github' || source.source === 'git') {
      // Git sources: do in-place git pull
      if (source.source === 'github') {
        // Same SSH/HTTPS fallback as loadAndCacheMarketplace: if the pull
        // succeeds the remote URL in .git/config is used, but a re-clone
        // needs a URL — pick the right protocol up-front and fall back.
        const sshUrl = `git@github.com:${source.repo}.git`
        const httpsUrl = `https://github.com/${source.repo}.git`

        if (isEnvTruthy(process.env.CLAUDE_CODE_REMOTE)) {
          // CCR: always HTTPS (no SSH keys available)
          await cacheMarketplaceFromGit(
            httpsUrl,
            installLocation,
            source.ref,
            source.sparsePaths,
            onProgress,
            options,
          )
        } else {
          const sshConfigured = await isGitHubSshLikelyConfigured()
          const primaryUrl = sshConfigured ? sshUrl : httpsUrl
          const fallbackUrl = sshConfigured ? httpsUrl : sshUrl

          try {
            await cacheMarketplaceFromGit(
              primaryUrl,
              installLocation,
              source.ref,
              source.sparsePaths,
              onProgress,
              options,
            )
          } catch {
            logForDebugging(
              `Marketplace refresh failed with ${sshConfigured ? 'SSH' : 'HTTPS'} for ${source.repo}, falling back to ${sshConfigured ? 'HTTPS' : 'SSH'}`,
              { level: 'info' },
            )
            await cacheMarketplaceFromGit(
              fallbackUrl,
              installLocation,
              source.ref,
              source.sparsePaths,
              onProgress,
              options,
            )
          }
        }
      } else {
        // Explicit git URL: use as-is (no fallback available)
        await cacheMarketplaceFromGit(
          source.url,
          installLocation,
          source.ref,
          source.sparsePaths,
          onProgress,
          options,
        )
      }
      // Validate that marketplace.json still exists after update
      // The repo may have been restructured or deprecated
      try {
        await readCachedMarketplace(installLocation)
      } catch {
        const sourceDisplay =
          source.source === 'github'
            ? source.repo
            : redactUrlCredentials(source.url)
        const reason =
          name === 'claude-code-plugins'
            ? `We've deprecated "claude-code-plugins" in favor of "claude-plugins-official".`
            : `This marketplace may have been deprecated or moved to a new location.`
        throw new Error(
          `The marketplace.json file is no longer present in this repository.\n\n` +
            `${reason}\n` +
            `Source: ${sourceDisplay}\n\n` +
            `You can remove this marketplace with: claude plugin marketplace remove "${name}"`,
        )
      }
    } else if (source.source === 'url') {
      // URL sources: re-download to existing file
      await cacheMarketplaceFromUrl(
        source.url,
        installLocation,
        source.headers,
        onProgress,
      )
    } else if (isLocalMarketplaceSource(source)) {
      // Local sources: no remote to update from, but validate the file still exists and is valid
      safeCallProgress(onProgress, 'Validating local marketplace')
      // Read and validate to ensure the marketplace file is still valid
      await readCachedMarketplace(installLocation)
    } else {
      throw new Error(`Unsupported marketplace source type for refresh`)
    }

    // Update lastUpdated timestamp
    config[name]!.lastUpdated = new Date().toISOString()
    await saveKnownMarketplacesConfig(config)

    logForDebugging(`Successfully refreshed marketplace: ${name}`)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logForDebugging(`Failed to refresh marketplace ${name}: ${errorMessage}`, {
      level: 'error',
    })
    throw new Error(`Failed to refresh marketplace '${name}': ${errorMessage}`)
  }
}

/**
 * Set the autoUpdate flag for a marketplace
 *
 * When autoUpdate is enabled, the marketplace and its installed plugins
 * will be automatically updated on startup.
 *
 * @param name - The name of the marketplace to update
 * @param autoUpdate - Whether to enable auto-update
 * @throws If marketplace not found
 */
export async function setMarketplaceAutoUpdate(
  name: string,
  autoUpdate: boolean,
): Promise<void> {
  const config = await loadKnownMarketplacesConfig()
  const entry = config[name]

  if (!entry) {
    throw new Error(
      `Marketplace '${name}' not found. Available marketplaces: ${Object.keys(config).join(', ')}`,
    )
  }

  // Seed-managed marketplaces always have autoUpdate: false (read-only, git-pull
  // would fail). Toggle appears to work but registerSeedMarketplaces overwrites
  // it on next startup. Error with guidance instead of silent revert.
  const seedDir = seedDirFor(entry.installLocation)
  if (seedDir) {
    throw new Error(
      `Marketplace '${name}' is seed-managed (${seedDir}) and ` +
        `auto-update is always disabled for seed content. ` +
        `To update: ask your admin to update the seed.`,
    )
  }

  // Only update if the value is actually changing
  if (entry.autoUpdate === autoUpdate) {
    return
  }

  config[name] = {
    ...entry,
    autoUpdate,
  }
  await saveKnownMarketplacesConfig(config)

  // Also update intent in settings if declared there — write to the SAME
  // source that declared it to avoid creating duplicates at wrong scope
  const declaringSource = getMarketplaceDeclaringSource(name)
  if (declaringSource) {
    const declared =
      getSettingsForSource(declaringSource)?.extraKnownMarketplaces?.[name]
    if (declared) {
      saveMarketplaceToSettings(
        name,
        { source: declared.source, autoUpdate },
        declaringSource,
      )
    }
  }

  logForDebugging(`Set autoUpdate=${autoUpdate} for marketplace: ${name}`)
}

export const _test = {
  redactUrlCredentials,
}
