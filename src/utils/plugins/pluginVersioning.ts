/**
 * 插件版本计算模块
 *
 * 处理来自各种来源的插件的版本计算。
 * 版本用于版本化缓存路径和更新检测。
 *
 * 版本来源（按优先级排序）：
 * 1. plugin.json 中的显式版本
 * 2. Git 提交 SHA（用于 git/github 来源）
 * 3. 本地来源的回退时间戳
 */

import { createHash } from 'crypto'
import { logForDebugging } from '../debug.js'
import { getHeadForDir } from '../git/gitFilesystem.js'
import type { PluginManifest, PluginSource } from './schemas.js'

/**
 * 根据插件来源计算版本。
 *
 * 版本来源（按优先级排序）：
 * 1. plugin.json 的 version 字段（最高优先级）
 * 2. 提供的版本（通常来自市场条目）
 * 3. 安装路径的 Git 提交 SHA
 * 4. 最后使用 'unknown'
 *
 * @param pluginId - 插件标识符（例如 "plugin@marketplace"）
 * @param source - 插件来源配置（用于 git-subdir 路径哈希）
 * @param manifest - 包含 version 字段的可选插件 manifest
 * @param installPath - 已安装插件的可选路径（用于提取 git SHA）
 * @param providedVersion - 来自市场条目或调用方的可选版本
 * @param gitCommitSha - 可选的预解析 git SHA（用于 git-subdir 等来源，
 *   其中克隆被丢弃且安装路径没有 .git）
 * @returns 版本字符串（semver、短 SHA 或 'unknown'）
 */
export async function calculatePluginVersion(
  pluginId: string,
  source: PluginSource,
  manifest?: PluginManifest,
  installPath?: string,
  providedVersion?: string,
  gitCommitSha?: string,
): Promise<string> {
  // 1. 如果可用，使用 plugin.json 中的显式版本
  if (manifest?.version) {
    logForDebugging(
      `Using manifest version for ${pluginId}: ${manifest.version}`,
    )
    return manifest.version
  }

  // 2. 使用提供的版本（通常来自市场条目）
  if (providedVersion) {
    logForDebugging(
      `Using provided version for ${pluginId}: ${providedVersion}`,
    )
    return providedVersion
  }

  // 3. 如果调用方在丢弃克隆之前捕获了预解析的 git SHA，则使用它
  if (gitCommitSha) {
    const shortSha = gitCommitSha.substring(0, 12)
    if (typeof source === 'object' && source.source === 'git-subdir') {
      // 将子目录路径编码到版本中，以便在
      // marketplace.json 的 `path` 改变但 monorepo SHA 不变时，缓存键也不同。
      // 若不这样做，同一提交下不同子目录的两个插件
      // 会在 cache/<m>/<p>/<sha>/ 发生冲突并互相提供对方的文件树。
      //
      // 规范化必须与 squashfs cron 逐字节匹配：
      //   1. 反斜杠 → 正斜杠
      //   2. 去除一个前导 `./`
      //   3. 去除所有尾部 `/`
      //   4. UTF-8 sha256，前 8 位十六进制字符
      // 参见 api/…/plugins_official_squashfs/job.py _validate_subdir()。
      const normPath = source.path
        .replace(/\\/g, '/')
        .replace(/^\.\//, '')
        .replace(/\/+$/, '')
      const pathHash = createHash('sha256')
        .update(normPath)
        .digest('hex')
        .substring(0, 8)
      const v = `${shortSha}-${pathHash}`
      logForDebugging(
        `Using git-subdir SHA+path version for ${pluginId}: ${v} (path=${normPath})`,
      )
      return v
    }
    logForDebugging(`Using pre-resolved git SHA for ${pluginId}: ${shortSha}`)
    return shortSha
  }

  // 4. 尝试从安装路径获取 git SHA
  if (installPath) {
    const sha = await getGitCommitSha(installPath)
    if (sha) {
      const shortSha = sha.substring(0, 12)
      logForDebugging(`Using git SHA for ${pluginId}: ${shortSha}`)
      return shortSha
    }
  }

  // 5. 最后返回 'unknown'
  logForDebugging(`No version found for ${pluginId}, using 'unknown'`)
  return 'unknown'
}

/**
 * 获取目录的 git 提交 SHA。
 *
 * @param dirPath - 目录路径（应为 git 仓库）
 * @returns 完整的提交 SHA，如果不是 git 仓库则返回 null
 */
export function getGitCommitSha(dirPath: string): Promise<string | null> {
  return getHeadForDir(dirPath)
}

/**
 * 从版本化缓存路径中提取版本。
 *
 * 给定类似 `~/.hclaude/plugins/cache/marketplace/plugin/1.0.0` 的路径，
 * 提取并返回 `1.0.0`。
 *
 * @param installPath - 插件安装的完整路径
 * @returns 从路径中提取的版本字符串，如果不是版本化路径则返回 null
 */
export function getVersionFromPath(installPath: string): string | null {
  // 版本化路径格式为：.../plugins/cache/marketplace/plugin/version/
  const parts = installPath.split('/').filter(Boolean)

  // 查找 'cache' 的索引以确定深度
  const cacheIndex = parts.findIndex(
    (part, i) => part === 'cache' && parts[i - 1] === 'plugins',
  )

  if (cacheIndex === -1) {
    return null
  }

  // 版本化路径在 'cache' 之后有 3 个组件：marketplace/plugin/version
  const componentsAfterCache = parts.slice(cacheIndex + 1)
  if (componentsAfterCache.length >= 3) {
    return componentsAfterCache[2] || null
  }

  return null
}

/**
 * 检查路径是否为版本化插件路径。
 *
 * @param path - 要检查的路径
 * @returns 如果路径遵循版本化结构则返回 true
 */
export function isVersionedPath(path: string): boolean {
  return getVersionFromPath(path) !== null
}
