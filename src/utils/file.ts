import { chmodSync, writeFileSync as fsWriteFileSync } from 'fs'
import { realpath, stat } from 'fs/promises'
import { homedir } from 'os'
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from 'path'
import { logEvent } from 'src/services/analytics/index.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { getCwd } from '../utils/cwd.js'
import { logForDebugging } from './debug.js'
import { isENOENT, isFsInaccessible } from './errors.js'
import {
  detectEncodingForResolvedPath,
  detectLineEndingsForString,
  type LineEndingType,
} from './fileRead.js'
import { fileReadCache } from './fileReadCache.js'
import { getFsImplementation, safeResolvePath } from './fsOperations.js'
import { logError } from './log.js'
import { expandPath } from './path.js'
import { getPlatform } from './platform.js'

export type File = {
  filename: string
  content: string
}

/**
 * 异步检查路径是否存在。
 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export const MAX_OUTPUT_SIZE = 0.25 * 1024 * 1024 // 0.25MB in bytes

export function readFileSafe(filepath: string): string | null {
  try {
    const fs = getFsImplementation()
    return fs.readFileSync(filepath, { encoding: 'utf8' })
  } catch (error) {
    logError(error)
    return null
  }
}

/**
 * 获取文件的规范化修改时间（毫秒）。
 * 使用 Math.floor 确保文件操作间时间戳比较的一致性，
 * 减少亚毫秒精度变化带来的误报（例如 IDE 文件监视器触碰文件但不修改内容时）。
 */
export function getFileModificationTime(filePath: string): number {
  const fs = getFsImplementation()
  return Math.floor(fs.statSync(filePath).mtimeMs)
}

/**
 * getFileModificationTime 的异步变体，具有相同的 floor 语义。
 * 在异步路径中使用（getChangedFiles 每轮对每个 readFileState 条目运行
 * — 在网络/慢速磁盘上同步 statSync 会触发慢操作指示器）。
 */
export async function getFileModificationTimeAsync(
  filePath: string,
): Promise<number> {
  const s = await getFsImplementation().stat(filePath)
  return Math.floor(s.mtimeMs)
}

export function writeTextContent(
  filePath: string,
  content: string,
  encoding: BufferEncoding,
  endings: LineEndingType,
): void {
  let toWrite = content
  if (endings === 'CRLF') {
    // 先将现有的 CRLF 规范化为 LF，避免已包含 \r\n 的 new_string（原始模型输出）
    // 在 join 后变成 \r\r\n。
    toWrite = content.replaceAll('\r\n', '\n').split('\n').join('\r\n')
  }

  writeFileSyncAndFlush_DEPRECATED(filePath, toWrite, { encoding })
}

export function detectFileEncoding(filePath: string): BufferEncoding {
  try {
    const fs = getFsImplementation()
    const { resolvedPath } = safeResolvePath(fs, filePath)
    return detectEncodingForResolvedPath(resolvedPath)
  } catch (error) {
    if (isFsInaccessible(error)) {
      logForDebugging(
        `detectFileEncoding failed for expected reason: ${error.code}`,
        {
          level: 'debug',
        },
      )
    } else {
      logError(error)
    }
    return 'utf8'
  }
}

export function detectLineEndings(
  filePath: string,
  encoding: BufferEncoding = 'utf8',
): LineEndingType {
  try {
    const fs = getFsImplementation()
    const { resolvedPath } = safeResolvePath(fs, filePath)
    const { buffer, bytesRead } = fs.readSync(resolvedPath, { length: 4096 })

    const content = buffer.toString(encoding, 0, bytesRead)
    return detectLineEndingsForString(content)
  } catch (error) {
    logError(error)
    return 'LF'
  }
}

export function convertLeadingTabsToSpaces(content: string): string {
  // /gm 正则即使不匹配也会扫描每一行；对于常见的无 tab 情况直接跳过。
  if (!content.includes('\t')) return content
  return content.replace(/^\t+/gm, _ => '  '.repeat(_.length))
}

export function getAbsoluteAndRelativePaths(path: string | undefined): {
  absolutePath: string | undefined
  relativePath: string | undefined
} {
  const absolutePath = path ? expandPath(path) : undefined
  const relativePath = absolutePath
    ? relative(getCwd(), absolutePath)
    : undefined
  return { absolutePath, relativePath }
}

export function getDisplayPath(filePath: string): string {
  // 若文件位于当前工作目录，使用相对路径
  const { relativePath } = getAbsoluteAndRelativePaths(filePath)
  if (relativePath && !relativePath.startsWith('..')) {
    return relativePath
  }

  // 对主目录中的文件使用波浪号表示法
  const homeDir = homedir()
  if (filePath.startsWith(homeDir + sep)) {
    return '~' + filePath.slice(homeDir.length)
  }

  // 否则返回绝对路径
  return filePath
}

/**
 * 在同一目录中查找同名但扩展名不同的文件
 * @param filePath 不存在的文件路径
 * @returns 找到的扩展名不同的文件，若未找到则返回 undefined
 */

export function findSimilarFile(filePath: string): string | undefined {
  const fs = getFsImplementation()
  try {
    const dir = dirname(filePath)
    const fileBaseName = basename(filePath, extname(filePath))

    // 获取目录中的所有文件
    const files = fs.readdirSync(dir)

    // 查找同基础名但扩展名不同的文件
    const similarFiles = files.filter(
      file =>
        basename(file.name, extname(file.name)) === fileBaseName &&
        join(dir, file.name) !== filePath,
    )

    // 若找到则仅返回第一个匹配项的文件名
    const firstMatch = similarFiles[0]
    if (firstMatch) {
      return firstMatch.name
    }
    return undefined
  } catch (error) {
    // 目录缺失（ENOENT）是预期的；其他错误则记录日志并返回 undefined
    if (!isENOENT(error)) {
      logError(error)
    }
    return undefined
  }
}

/**
 * 包含 cwd 注释的文件未找到错误消息中的标记。
 * UI 渲染器检查此标记以显示简短的"文件未找到"消息。
 */
export const FILE_NOT_FOUND_CWD_NOTE = 'Note: your current working directory is'

/**
 * 当文件/目录未找到时，建议当前工作目录下的修正路径。
 * 检测"丢失仓库文件夹"模式，即模型构造了缺少仓库目录组件的绝对路径。
 *
 * 示例：
 *   cwd = /Users/zeeg/src/currentRepo
 *   requestedPath = /Users/zeeg/src/foobar           （不存在）
 *   returns        /Users/zeeg/src/currentRepo/foobar （若存在）
 *
 * @param requestedPath - 未找到的绝对路径
 * @returns 若在 cwd 下找到则返回修正路径，否则返回 undefined
 */
export async function suggestPathUnderCwd(
  requestedPath: string,
): Promise<string | undefined> {
  const cwd = getCwd()
  const cwdParent = dirname(cwd)

  // 解析请求路径父目录中的符号链接（例如 macOS 上 /tmp -> /private/tmp），
  // 确保前缀比较与已经 realpath 解析过的 cwd 正确匹配。
  let resolvedPath = requestedPath
  try {
    const resolvedDir = await realpath(dirname(requestedPath))
    resolvedPath = join(resolvedDir, basename(requestedPath))
  } catch {
    // 父目录不存在，使用原始路径
  }

  // 仅检查请求路径是否在 cwd 父目录下但不在 cwd 本身下。
  // 当 cwdParent 为根目录（例如 '/'）时，直接使用它作为前缀
  // 以避免永远不匹配的双分隔符 '//'。
  const cwdParentPrefix = cwdParent === sep ? sep : cwdParent + sep
  if (
    !resolvedPath.startsWith(cwdParentPrefix) ||
    resolvedPath.startsWith(cwd + sep) ||
    resolvedPath === cwd
  ) {
    return undefined
  }

  // 获取相对于父目录的相对路径
  const relFromParent = relative(cwdParent, resolvedPath)

  // 检查相同的相对路径是否在 cwd 下存在
  const correctedPath = join(cwd, relFromParent)
  try {
    await stat(correctedPath)
    return correctedPath
  } catch {
    return undefined
  }
}

/**
 * 是否使用紧凑行号前缀格式（`N\t` 而非 `     N→`）。填充箭头格式每行增加 9 字节开销；
 * 按 13.5 亿次 Read 调用 × 平均 132 行计算，占全量未缓存输入的 2.18%
 * （bq-queries/read_line_prefix_overhead_verify.sql）。
 *
 * Ant 浸泡测试验证无 Edit 错误回归（6.29% vs 6.86% 基线）。
 * 熔断模式：如果外部出现问题，GB 可以禁用。
 */
export function isCompactLinePrefixEnabled(): boolean {
  // 3P 默认：熔断关闭 = 紧凑格式启用。仅客户端 —
  // 无需服务器支持，对 Bedrock/Vertex/Foundry 安全。
  return !getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_compact_line_prefix_killswitch',
    false,
  )
}

/**
 * 为内容添加 cat -n 风格的行号。
 */
export function addLineNumbers({
  content,
  // 从 1 开始索引
  startLine,
}: {
  content: string
  startLine: number
}): string {
  if (!content) {
    return ''
  }

  const lines = content.split(/\r?\n/)

  if (isCompactLinePrefixEnabled()) {
    return lines
      .map((line, index) => `${index + startLine}\t${line}`)
      .join('\n')
  }

  return lines
    .map((line, index) => {
      const numStr = String(index + startLine)
      if (numStr.length >= 6) {
        return `${numStr}→${line}`
      }
      return `${numStr.padStart(6, ' ')}→${line}`
    })
    .join('\n')
}

/**
 * addLineNumbers 的逆操作 — 从单行中去除 `N→` 或 `N\t` 前缀。
 * 与 addLineNumbers 放在一起，以便格式变更时两者保持同步。
 */
export function stripLineNumberPrefix(line: string): string {
  const match = line.match(/^\s*\d+[\u2192\t](.*)$/)
  return match?.[1] ?? line
}

/**
 * 检查目录是否为空。
 * @param dirPath 要检查的目录路径
 * @returns 若目录为空或不存在则返回 true，否则返回 false
 */
export function isDirEmpty(dirPath: string): boolean {
  try {
    return getFsImplementation().isDirEmptySync(dirPath)
  } catch (e) {
    // ENOENT：目录不存在，视为空目录
    // 其他错误（macOS 受保护文件夹的 EPERM 等）：假设非空
    return isENOENT(e)
  }
}

/**
 * 带缓存读取文件，以避免冗余 I/O 操作。
 * 这是 FileEditTool 操作的首选方法。
 */
export function readFileSyncCached(filePath: string): string {
  const { content } = fileReadCache.readFile(filePath)
  return content
}

/**
 * 写入文件并将文件刷新到磁盘
 * @param filePath 要写入的文件路径
 * @param content 要写入的内容
 * @param options 写入选项，包括编码和模式
 * @deprecated 对非阻塞写入请改用带 flush 选项的 `fs.promises.writeFile`。
 * 同步文件写入会阻塞事件循环并导致性能问题。
 */
export function writeFileSyncAndFlush_DEPRECATED(
  filePath: string,
  content: string,
  options: { encoding: BufferEncoding; mode?: number } = { encoding: 'utf-8' },
): void {
  const fs = getFsImplementation()

  // 检查目标文件是否为符号链接以便为所有用户保留它
  // 注意：这里不使用 safeResolvePath，因为需要手动处理
  // 符号链接以确保写入目标时保留符号链接本身
  let targetPath = filePath
  try {
    // 尝试读取符号链接 — 若成功则表明是符号链接
    const linkTarget = fs.readlinkSync(filePath)
    // 解析为绝对路径
    targetPath = isAbsolute(linkTarget)
      ? linkTarget
      : resolve(dirname(filePath), linkTarget)
    logForDebugging(`Writing through symlink: ${filePath} -> ${targetPath}`)
  } catch {
    // ENOENT（不存在）或 EINVAL（非符号链接）— 保持 targetPath = filePath
  }

  // 首先尝试原子写入
  const tempPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`

  // 检查目标文件是否存在并获取其权限（单次 stat，在原子路径和回退路径中复用）
  let targetMode: number | undefined
  let targetExists = false
  try {
    targetMode = fs.statSync(targetPath).mode
    targetExists = true
    logForDebugging(`Preserving file permissions: ${targetMode.toString(8)}`)
  } catch (e) {
    if (!isENOENT(e)) throw e
    if (options.mode !== undefined) {
      // 对新文件使用提供的模式
      targetMode = options.mode
      logForDebugging(
        `Setting permissions for new file: ${targetMode.toString(8)}`,
      )
    }
  }

  try {
    logForDebugging(`Writing to temp file: ${tempPath}`)

    // 写入临时文件并 flush，设置模式（若为新文件且已指定）
    const writeOptions: {
      encoding: BufferEncoding
      flush: boolean
      mode?: number
    } = {
      encoding: options.encoding,
      flush: true,
    }
    // 仅对新文件在 writeFileSync 中设置模式，以确保原子权限设置
    if (!targetExists && options.mode !== undefined) {
      writeOptions.mode = options.mode
    }

    fsWriteFileSync(tempPath, content, writeOptions)
    logForDebugging(
      `Temp file written successfully, size: ${content.length} bytes`,
    )

    // 对已存在的文件，或模式未原子设置时，应用权限
    if (targetExists && targetMode !== undefined) {
      chmodSync(tempPath, targetMode)
      logForDebugging(`Applied original permissions to temp file`)
    }

    // 原子重命名（在 POSIX 系统上是原子的）
    // 在 Windows 上，若目标已存在则会覆盖
    logForDebugging(`Renaming ${tempPath} to ${targetPath}`)
    fs.renameSync(tempPath, targetPath)
    logForDebugging(`File ${targetPath} written atomically`)
  } catch (atomicError) {
    logForDebugging(`Failed to write file atomically: ${atomicError}`, {
      level: 'error',
    })
    logEvent('tengu_atomic_write_error', {})

    // 发生错误时清理临时文件
    try {
      logForDebugging(`Cleaning up temp file: ${tempPath}`)
      fs.unlinkSync(tempPath)
    } catch (cleanupError) {
      logForDebugging(`Failed to clean up temp file: ${cleanupError}`)
    }

    // 回退到非原子写入
    logForDebugging(`Falling back to non-atomic write for ${targetPath}`)
    try {
      const fallbackOptions: {
        encoding: BufferEncoding
        flush: boolean
        mode?: number
      } = {
        encoding: options.encoding,
        flush: true,
      }
      // 仅对新文件设置模式
      if (!targetExists && options.mode !== undefined) {
        fallbackOptions.mode = options.mode
      }

      fsWriteFileSync(targetPath, content, fallbackOptions)
      logForDebugging(
        `File ${targetPath} written successfully with non-atomic fallback`,
      )
    } catch (fallbackError) {
      logForDebugging(`Non-atomic write also failed: ${fallbackError}`)
      throw fallbackError
    }
  }
}

export function getDesktopPath(): string {
  const platform = getPlatform()
  const homeDir = homedir()

  if (platform === 'macos') {
    return join(homeDir, 'Desktop')
  }

  if (platform === 'windows') {
    // 对于 WSL，尝试访问 Windows 桌面
    const windowsHome = process.env.USERPROFILE
      ? process.env.USERPROFILE.replace(/\\/g, '/')
      : null

    if (windowsHome) {
      const wslPath = windowsHome.replace(/^[A-Z]:/, '')
      const desktopPath = `/mnt/c${wslPath}/Desktop`

      if (getFsImplementation().existsSync(desktopPath)) {
        return desktopPath
      }
    }

    // 回退：尝试在典型的 Windows 用户位置查找桌面
    try {
      const usersDir = '/mnt/c/Users'
      const userDirs = getFsImplementation().readdirSync(usersDir)

      for (const user of userDirs) {
        if (
          user.name === 'Public' ||
          user.name === 'Default' ||
          user.name === 'Default User' ||
          user.name === 'All Users'
        ) {
          continue
        }

        const potentialDesktopPath = join(usersDir, user.name, 'Desktop')

        if (getFsImplementation().existsSync(potentialDesktopPath)) {
          return potentialDesktopPath
        }
      }
    } catch (error) {
      logError(error)
    }
  }

  // Linux/未知平台回退
  const desktopPath = join(homeDir, 'Desktop')
  if (getFsImplementation().existsSync(desktopPath)) {
    return desktopPath
  }

  // 若 Desktop 文件夹不存在，回退到主目录
  return homeDir
}

/**
 * 验证文件大小是否在指定限制内。
 * 若文件在限制内返回 true，否则返回 false。
 *
 * @param filePath 要验证的文件路径
 * @param maxSizeBytes 允许的最大文件大小（字节）
 * @returns 若文件大小在限制内返回 true，否则返回 false
 */
export function isFileWithinReadSizeLimit(
  filePath: string,
  maxSizeBytes: number = MAX_OUTPUT_SIZE,
): boolean {
  try {
    const stats = getFsImplementation().statSync(filePath)
    return stats.size <= maxSizeBytes
  } catch {
    // 无法 stat 文件时返回 false 表示验证失败
    return false
  }
}

/**
 * 为比较规范化文件路径，处理平台差异。
 * 在 Windows 上，规范化路径分隔符并转为小写以进行大小写不敏感比较。
 */
export function normalizePathForComparison(filePath: string): string {
  // 使用 path.normalize() 清理冗余分隔符并解析 . 和 ..
  let normalized = normalize(filePath)

  // 将分隔符转为稳定的斜杠形式，使比较行为在各平台及
  // 使用 POSIX 风格 fixture 的测试中保持一致。
  normalized = normalized.replace(/\\/g, '/')

  // 在 Windows 上规范化大小写以进行大小写不敏感比较。
  if (getPlatform() === 'windows') {
    normalized = normalized.toLowerCase()
  }

  return normalized
}

/**
 * 比较两个文件路径是否相等，处理 Windows 大小写不敏感情况。
 */
export function pathsEqual(path1: string, path2: string): boolean {
  return normalizePathForComparison(path1) === normalizePathForComparison(path2)
}
