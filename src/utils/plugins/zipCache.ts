/**
 * 插件 Zip 缓存模块
 *
 * 在挂载目录（如 Filestore）中以 ZIP 归档的形式管理插件。
 * 当 CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE 启用且 CLAUDE_CODE_PLUGIN_CACHE_DIR
 * 已设置时，插件以 ZIP 形式存储在该目录中，并在启动时
 * 提取到会话本地临时目录。
 *
 * 限制：
 * - 仅支持无头模式
 * - 使用所有设置来源（与普通插件流相同）
 * - 仅支持 github、git 和 url marketplace 来源
 * - 仅支持 strict:true 的 marketplace 条目
 * - 自动更新是非阻塞的（后台，不影响当前会话）
 *
 * Zip 缓存的目录结构：
 * /mnt/plugins-cache/
 *   ├── known_marketplaces.json
 *   ├── installed_plugins.json
 *   ├── marketplaces/
 *   │   ├── official-marketplace.json
 *   │   └── company-marketplace.json
 *   └── plugins/
 *       ├── official-marketplace/
 *       │   └── plugin-a/
 *       │       └── 1.0.0.zip
 *       └── company-marketplace/
 *           └── plugin-b/
 *               └── 2.1.3.zip
 */

import { randomBytes } from 'crypto'
import {
  chmod,
  lstat,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'fs/promises'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import { logForDebugging } from '../debug.js'
import { parseZipModes, unzipFile } from '../dxt/zip.js'
import { isEnvTruthy } from '../envUtils.js'
import { getFsImplementation } from '../fsOperations.js'
import { expandTilde } from '../permissions/pathValidation.js'
import type { MarketplaceSource } from './schemas.js'

/**
 * 检查插件 zip 缓存模式是否已启用。
 */
export function isPluginZipCacheEnabled(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE)
}

/**
 * 获取 zip 缓存目录的路径。
 * 需要设置 CLAUDE_CODE_PLUGIN_CACHE_DIR。
 * 若 zip 缓存未启用则返回 undefined。
 */
export function getPluginZipCachePath(): string | undefined {
  if (!isPluginZipCacheEnabled()) {
    return undefined
  }
  const dir = process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
  return dir ? expandTilde(dir) : undefined
}

/**
 * 获取 zip 缓存中 known_marketplaces.json 的路径。
 */
export function getZipCacheKnownMarketplacesPath(): string {
  const cachePath = getPluginZipCachePath()
  if (!cachePath) {
    throw new Error('Plugin zip cache is not enabled')
  }
  return join(cachePath, 'known_marketplaces.json')
}

/**
 * 获取 zip 缓存中 installed_plugins.json 的路径。
 */
export function getZipCacheInstalledPluginsPath(): string {
  const cachePath = getPluginZipCachePath()
  if (!cachePath) {
    throw new Error('Plugin zip cache is not enabled')
  }
  return join(cachePath, 'installed_plugins.json')
}

/**
 * 获取 zip 缓存中的 marketplaces 目录。
 */
export function getZipCacheMarketplacesDir(): string {
  const cachePath = getPluginZipCachePath()
  if (!cachePath) {
    throw new Error('Plugin zip cache is not enabled')
  }
  return join(cachePath, 'marketplaces')
}

/**
 * 获取 zip 缓存中的 plugins 目录。
 */
export function getZipCachePluginsDir(): string {
  const cachePath = getPluginZipCachePath()
  if (!cachePath) {
    throw new Error('Plugin zip cache is not enabled')
  }
  return join(cachePath, 'plugins')
}

// 会话插件缓存：本地磁盘上的临时目录（不在挂载的 zip 缓存中），
// 在会话期间存放已提取的插件。
let sessionPluginCachePath: string | null = null
let sessionPluginCachePromise: Promise<string> | null = null

/**
 * 获取或创建会话插件缓存目录。
 * 这是本地磁盘上的临时目录，会话期间在此提取插件。
 */
export async function getSessionPluginCachePath(): Promise<string> {
  if (sessionPluginCachePath) {
    return sessionPluginCachePath
  }
  if (!sessionPluginCachePromise) {
    sessionPluginCachePromise = (async () => {
      const suffix = randomBytes(8).toString('hex')
      const dir = join(tmpdir(), `claude-plugin-session-${suffix}`)
      await getFsImplementation().mkdir(dir)
      sessionPluginCachePath = dir
      logForDebugging(`Created session plugin cache at ${dir}`)
      return dir
    })()
  }
  return sessionPluginCachePromise
}

/**
 * 清理会话插件缓存目录。
 * 应在会话结束时调用。
 */
export async function cleanupSessionPluginCache(): Promise<void> {
  if (!sessionPluginCachePath) {
    return
  }
  try {
    await rm(sessionPluginCachePath, { recursive: true, force: true })
    logForDebugging(
      `Cleaned up session plugin cache at ${sessionPluginCachePath}`,
    )
  } catch (error) {
    logForDebugging(`Failed to clean up session plugin cache: ${error}`)
  } finally {
    sessionPluginCachePath = null
    sessionPluginCachePromise = null
  }
}

/**
 * 重置会话插件缓存路径（用于测试）。
 */
export function resetSessionPluginCache(): void {
  sessionPluginCachePath = null
  sessionPluginCachePromise = null
}

/**
 * 原子地将数据写入 zip 缓存中的文件。
 * 先写入同一目录中的临时文件，然后重命名。
 */
export async function atomicWriteToZipCache(
  targetPath: string,
  data: string | Uint8Array,
): Promise<void> {
  const dir = dirname(targetPath)
  await getFsImplementation().mkdir(dir)

  const tmpName = `.${basename(targetPath)}.tmp.${randomBytes(4).toString('hex')}`
  const tmpPath = join(dir, tmpName)

  try {
    if (typeof data === 'string') {
      await writeFile(tmpPath, data, { encoding: 'utf-8' })
    } else {
      await writeFile(tmpPath, data)
    }
    await rename(tmpPath, targetPath)
  } catch (error) {
    // 失败时清理临时文件
    try {
      await rm(tmpPath, { force: true })
    } catch {
      // 忽略清理错误
    }
    throw error
  }
}

// fflate 的 ZippableFile 元组形式：[data, opts]。使用元组让我们
// 可以存储 {os, attrs}，以便 parseZipModes 在提取时恢复执行位。
type ZipEntry = [Uint8Array, { os: number; attrs: number }]

/**
 * 从目录创建 ZIP 归档。
 * 将符号链接解析为实际文件内容（用真实数据替换符号链接）。
 * 将 Unix 模式位存储在 external_attr 中，以便 extractZipToDirectory 能恢复
 * +x — 否则往返过程（git clone → zip → extract）会丢失执行位。
 *
 * @param sourceDir - 要压缩的目录
 * @returns ZIP 文件的 Uint8Array
 */
export async function createZipFromDirectory(
  sourceDir: string,
): Promise<Uint8Array> {
  const files: Record<string, ZipEntry> = {}
  const visited = new Set<string>()
  await collectFilesForZip(sourceDir, '', files, visited)

  const { zipSync } = await import('fflate')
  const zipData = zipSync(files, { level: 6 })
  logForDebugging(
    `Created ZIP from ${sourceDir}: ${Object.keys(files).length} files, ${zipData.length} bytes`,
  )
  return zipData
}

/**
 * 递归收集目录中的文件用于压缩。
 * 使用 lstat 检测符号链接，并追踪已访问的 inode 以进行循环检测。
 */
async function collectFilesForZip(
  baseDir: string,
  relativePath: string,
  files: Record<string, ZipEntry>,
  visited: Set<string>,
): Promise<void> {
  const currentDir = relativePath ? join(baseDir, relativePath) : baseDir
  let entries: string[]
  try {
    entries = await readdir(currentDir)
  } catch {
    return
  }

  // 按 dev+ino 追踪已访问目录以检测符号链接循环。
  // bigint: true 是必需的 — 在 Windows NTFS 上，文件索引将 16 位
  // 序列号打包进高位。一旦该序列超过 ~32（在频繁产生临时文件的
  // CI runner 上很常见），值就超过了 Number.MAX_SAFE_INTEGER，
  // 两个相邻目录会舍入为相同 JS 数字，导致子目录被静默跳过为"循环"。
  // 当分片打乱测试执行顺序并将 MFT 序列号推过精度悬崖时，
  // 这破坏了 Windows CI 上的往返测试。
  // 另见：markdownConfigLoader.ts getFileIdentity，anthropics/claude-code#13893
  try {
    const dirStat = await stat(currentDir, { bigint: true })
    // ReFS（Dev Drive）、NFS、某些 FUSE 挂载对所有内容报告 dev=0 和 ino=0。
    // 失败时开放：跳过循环检测而非跳过目录。我们已经在下面
    // 无条件跳过符号链接目录，所以唯一剩余的循环是 bind mount，
    // 我们接受这种情况。
    if (dirStat.dev !== 0n || dirStat.ino !== 0n) {
      const key = `${dirStat.dev}:${dirStat.ino}`
      if (visited.has(key)) {
        logForDebugging(`Skipping symlink cycle at ${currentDir}`)
        return
      }
      visited.add(key)
    }
  } catch {
    return
  }

  for (const entry of entries) {
    // 跳过与 git 相关的隐藏文件
    if (entry === '.git') {
      continue
    }

    const fullPath = join(currentDir, entry)
    const relPath = relativePath ? `${relativePath}/${entry}` : entry

    let fileStat
    try {
      fileStat = await lstat(fullPath)
    } catch {
      continue
    }

    // 跳过符号链接目录（跟随符号链接文件）
    if (fileStat.isSymbolicLink()) {
      try {
        const targetStat = await stat(fullPath)
        if (targetStat.isDirectory()) {
          continue
        }
        // 符号链接文件 — 在下面读取其内容
        fileStat = targetStat
      } catch {
        continue // 损坏的符号链接
      }
    }

    if (fileStat.isDirectory()) {
      await collectFilesForZip(baseDir, relPath, files, visited)
    } else if (fileStat.isFile()) {
      try {
        const content = await readFile(fullPath)
        // os=3（Unix）+ st_mode 在 external_attr 的高 16 位 — 这是
        // parseZipModes 在提取时回读的内容。fileStat 已经
        // 通过上面的 lstat/stat 获得，无需额外系统调用。
        files[relPath] = [
          new Uint8Array(content),
          { os: 3, attrs: (fileStat.mode & 0xffff) << 16 },
        ]
      } catch (error) {
        logForDebugging(`Failed to read file for zip: ${relPath}: ${error}`)
      }
    }
  }
}

/**
 * 将 ZIP 文件提取到目标目录。
 *
 * @param zipPath - ZIP 文件的路径
 * @param targetDir - 要提取到的目录
 */
export async function extractZipToDirectory(
  zipPath: string,
  targetDir: string,
): Promise<void> {
  const zipBuf = await getFsImplementation().readFileBytes(zipPath)
  const files = await unzipFile(zipBuf)
  // fflate 不暴露 external_attr — 解析中央目录以便
  // 执行位在提取后依然保留（hook/脚本需要 +x 才能通过 `sh -c` 运行）。
  const modes = parseZipModes(zipBuf)

  await getFsImplementation().mkdir(targetDir)

  for (const [relPath, data] of Object.entries(files)) {
    // 跳过目录条目（尾部斜杠）
    if (relPath.endsWith('/')) {
      await getFsImplementation().mkdir(join(targetDir, relPath))
      continue
    }

    const fullPath = join(targetDir, relPath)
    await getFsImplementation().mkdir(dirname(fullPath))
    await writeFile(fullPath, data)
    const mode = modes[relPath]
    if (mode && mode & 0o111) {
      // 吞掉 EPERM/ENOTSUP（NFS root_squash、某些 FUSE 挂载）— 丢失 +x
      // 是此 PR 之前的行为，比在提取中途中止要好。
      await chmod(fullPath, mode & 0o777).catch(() => {})
    }
  }

  logForDebugging(
    `Extracted ZIP to ${targetDir}: ${Object.keys(files).length} entries`,
  )
}

/**
 * 将插件目录原地转换为 ZIP：zip → 原子写入 → 删除目录。
 * 两个调用点（cacheAndRegisterPlugin、copyPluginToVersionedCache）都需要
 * 相同的序列；搞错（非原子写入、忘记 rm）会损坏缓存。
 */
export async function convertDirectoryToZipInPlace(
  dirPath: string,
  zipPath: string,
): Promise<void> {
  const zipData = await createZipFromDirectory(dirPath)
  await atomicWriteToZipCache(zipPath, zipData)
  await rm(dirPath, { recursive: true, force: true })
}

/**
 * 获取 zip 缓存中 marketplace JSON 文件的相对路径。
 * 格式：marketplaces/{marketplace-name}.json
 */
export function getMarketplaceJsonRelativePath(
  marketplaceName: string,
): string {
  const sanitized = marketplaceName.replace(/[^a-zA-Z0-9\-_]/g, '-')
  return join('marketplaces', `${sanitized}.json`)
}

/**
 * 检查 marketplace 来源类型是否受 zip 缓存模式支持。
 *
 * 支持的来源写入 `join(cacheDir, name)` — syncMarketplacesToZipCache
 * 从该 installLocation 读取 marketplace.json，与来源类型无关。
 * - github/git/url：克隆到临时目录，重命名到 cacheDir
 * - settings：直接将合成的 marketplace.json 写入 cacheDir（无需获取）
 *
 * 排除：file/directory（installLocation 是 cacheDir 之外的用户路径 —
 * 在临时容器中毫无意义），npm（Filestore 挂载上 node_modules 膨胀）。
 */
export function isMarketplaceSourceSupportedByZipCache(
  source: MarketplaceSource,
): boolean {
  return ['github', 'git', 'url', 'settings'].includes(source.source)
}
