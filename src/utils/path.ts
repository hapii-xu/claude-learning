import { homedir } from 'os'
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  posix,
  relative,
  resolve,
} from 'path'
import { getCwd } from './cwd.js'
import { getFsImplementation } from './fsOperations.js'
import { getPlatform } from './platform.js'
import { posixPathToWindowsPath } from './windowsPaths.js'

/**
 * 展开可能包含波浪号记号（~）的路径为绝对路径。
 *
 * 在 Windows 上，POSIX 风格路径（如 `/c/Users/...`）会自动转换
 * 为 Windows 格式（如 `C:\Users\...`）。函数始终以当前平台
 * 的原生格式返回路径。
 *
 * @param path - 要展开的路径，可包含：
 *   - `~` - 展开为用户主目录
 *   - `~/path` - 展开为用户主目录内的路径
 *   - 绝对路径 - 规范化后返回
 *   - 相对路径 - 相对于 baseDir 解析
 *   - Windows 上的 POSIX 路径 - 转换为 Windows 格式
 * @param baseDir - 解析相对路径的基目录（默认为当前工作目录）
 * @returns 当前平台原生格式的展开后绝对路径
 *
 * @throws {Error} 若路径无效
 *
 * @example
 * expandPath('~') // '/home/user'
 * expandPath('~/Documents') // '/home/user/Documents'
 * expandPath('./src', '/project') // '/project/src'
 * expandPath('/absolute/path') // '/absolute/path'
 */
export function expandPath(path: string, baseDir?: string): string {
  // 若未提供则将 baseDir 设为 getCwd()
  const actualBaseDir = baseDir ?? getCwd() ?? getFsImplementation().cwd()

  // 输入校验
  if (typeof path !== 'string') {
    throw new TypeError(`Path must be a string, received ${typeof path}`)
  }

  if (typeof actualBaseDir !== 'string') {
    throw new TypeError(
      `Base directory must be a string, received ${typeof actualBaseDir}`,
    )
  }

  // 安全检查：检查 null 字节
  if (path.includes('\0') || actualBaseDir.includes('\0')) {
    throw new Error('Path contains null bytes')
  }

  const isSyntheticPosixPath = (value: string): boolean =>
    value.includes('/') && !value.includes('\\') && !/^[A-Za-z]:/.test(value)

  // 处理空或仅空白路径
  const trimmedPath = path.trim()
  if (!trimmedPath) {
    if (getPlatform() === 'windows' && isSyntheticPosixPath(actualBaseDir)) {
      return posix.normalize(actualBaseDir).normalize('NFC')
    }
    return normalize(actualBaseDir).normalize('NFC')
  }

  // 处理主目录记号
  if (trimmedPath === '~') {
    return homedir().normalize('NFC')
  }

  if (trimmedPath.startsWith('~/')) {
    return join(homedir(), trimmedPath.slice(2)).normalize('NFC')
  }

  // 在 Windows 上，将 POSIX 风格路径（如 /c/Users/...）转换为 Windows 格式
  let processedPath = trimmedPath
  if (getPlatform() === 'windows' && trimmedPath.match(/^\/[a-z]\//i)) {
    try {
      processedPath = posixPathToWindowsPath(trimmedPath)
    } catch {
      // 若转换失败，使用原始路径
      processedPath = trimmedPath
    }
  }

  // 处理绝对路径
  if (isAbsolute(processedPath)) {
    if (getPlatform() === 'windows' && isSyntheticPosixPath(processedPath)) {
      return posix.normalize(processedPath).normalize('NFC')
    }
    return normalize(processedPath).normalize('NFC')
  }

  // 处理相对路径
  if (
    getPlatform() === 'windows' &&
    isSyntheticPosixPath(actualBaseDir) &&
    !/^[A-Za-z]:/.test(processedPath) &&
    !processedPath.startsWith('\\\\')
  ) {
    return posix.resolve(actualBaseDir, processedPath).normalize('NFC')
  }
  return resolve(actualBaseDir, processedPath).normalize('NFC')
}

/**
 * 将绝对路径转换为相对于 cwd 的相对路径，以节省
 * 工具输出中的 token。若路径在 cwd 之外（相对路径以 .. 开头），
 * 则原样返回绝对路径以保持无歧义。
 *
 * @param absolutePath - 要相对化的绝对路径
 * @returns 若在 cwd 下则为相对路径，否则为原始绝对路径
 */
export function toRelativePath(absolutePath: string): string {
  const relativePath = relative(getCwd(), absolutePath)
  // 若相对路径会超出 cwd（以 .. 开头），则保留绝对路径
  return relativePath.startsWith('..') ? absolutePath : relativePath
}

/**
 * 获取给定文件或目录路径的目录路径。
 * 若路径为目录，返回路径本身。
 * 若路径为文件或不存在，返回父目录。
 *
 * @param path - 文件或目录路径
 * @returns 目录路径
 */
export function getDirectoryForPath(path: string): string {
  const absolutePath = expandPath(path)
  // 安全检查：对 UNC 路径跳过文件系统操作以防止 NTLM 凭据泄露。
  if (absolutePath.startsWith('\\\\') || absolutePath.startsWith('//')) {
    return dirname(absolutePath)
  }
  try {
    const stats = getFsImplementation().statSync(absolutePath)
    if (stats.isDirectory()) {
      return absolutePath
    }
  } catch {
    // 路径不存在或无法访问
  }
  // 若非目录或不存在，返回父目录
  return dirname(absolutePath)
}

/**
 * 检查路径是否包含导航到父目录的路径遍历模式。
 *
 * @param path - 要检查遍历模式的路径
 * @returns 若路径包含遍历则为 true（如 '../'、'..\' 或以 '..' 结尾）
 */
export function containsPathTraversal(path: string): boolean {
  return /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(path)
}

// 从无依赖共享源重新导出。
export { sanitizePath } from './sessionStoragePortable.js'

/**
 * 规范化路径以用作 JSON 配置键。
 * 在 Windows 上，路径可能有不一致的分隔符（C:\path vs C:/path）
 * 取决于来源是 git、Node.js API 还是用户输入。
 * 此函数规范化为正斜杠以确保 JSON 序列化一致。
 *
 * @param path - 要规范化的路径
 * @returns 具有统一正斜杠的规范化路径
 */
export function normalizePathForConfigKey(path: string): string {
  // 首先使用 Node 的 normalize 解析 . 和 .. 段
  const normalized = normalize(path)
  // 然后将所有反斜杠转换为正斜杠以确保 JSON 键一致
  // 这是安全的，因为正斜杠在 Windows 路径中对大多数操作都有效
  return normalized.replace(/\\/g, '/')
}
