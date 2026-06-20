import { lstat, realpath } from 'fs/promises'
import { dirname, join, resolve, sep } from 'path'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { getErrnoCode } from '../utils/errors.js'
import { getAutoMemPath, isAutoMemoryEnabled } from './paths.js'

/**
 * 当路径验证检测到遍历或注入尝试时抛出的错误。
 */
export class PathTraversalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PathTraversalError'
  }
}

/**
 * 通过拒绝危险模式来清理文件路径键。
 * 检查空字节、URL 编码的遍历和其他注入向量。
 * 返回清理后的字符串或抛出 PathTraversalError。
 */
function sanitizePathKey(key: string): string {
  // 空字节可以在基于 C 的系统调用中截断路径
  if (key.includes('\0')) {
    throw new PathTraversalError(`Null byte in path key: "${key}"`)
  }
  // URL 编码的遍历（例如 %2e%2e%2f = ../）
  let decoded: string
  try {
    decoded = decodeURIComponent(key)
  } catch {
    // 格式错误的百分号编码（例如 %ZZ、单独的 %）—— 不是有效的 URL 编码，
    // 所以不可能有 URL 编码的遍历
    decoded = key
  }
  if (decoded !== key && (decoded.includes('..') || decoded.includes('/'))) {
    throw new PathTraversalError(`URL-encoded traversal in path key: "${key}"`)
  }
  // Unicode 规范化攻击：全角 ．．／（U+FF0E U+FF0F）在 NFKC 下
  // 规范化为 ASCII ../。虽然 path.resolve/fs.writeFile 将这些视为
  // 字面字节（非分隔符），但下游层或文件系统可能会规范化 ——
  // 为纵深防御拒绝（PSR M22187 向量 4）。
  const normalized = key.normalize('NFKC')
  if (
    normalized !== key &&
    (normalized.includes('..') ||
      normalized.includes('/') ||
      normalized.includes('\\') ||
      normalized.includes('\0'))
  ) {
    throw new PathTraversalError(
      `Unicode-normalized traversal in path key: "${key}"`,
    )
  }
  // 拒绝反斜杠（Windows 路径分隔符用作遍历向量）
  if (key.includes('\\')) {
    throw new PathTraversalError(`Backslash in path key: "${key}"`)
  }
  // 拒绝绝对路径
  if (key.startsWith('/')) {
    throw new PathTraversalError(`Absolute path key: "${key}"`)
  }
  return key
}

/**
 * 团队记忆功能是否启用。团队记忆是自动记忆的子目录，因此需要启用自动记忆。
 * 这使所有团队记忆消费者（提示、内容注入、同步监视器、文件检测）在
 * 通过环境变量或设置禁用自动记忆时保持一致。
 */
export function isTeamMemoryEnabled(): boolean {
  if (!isAutoMemoryEnabled()) {
    return false
  }
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_herring_clock', false)
}

/**
 * 返回团队记忆路径：<memoryBase>/projects/<sanitized-project-root>/memory/team/
 * 作为自动记忆目录的子目录存在，按项目作用域。
 */
export function getTeamMemPath(): string {
  return (join(getAutoMemPath(), 'team') + sep).normalize('NFC')
}

/**
 * 返回团队记忆入口：<memoryBase>/projects/<sanitized-project-root>/memory/team/MEMORY.md
 * 作为自动记忆目录的子目录存在，按项目作用域。
 */
export function getTeamMemEntrypoint(): string {
  return join(getAutoMemPath(), 'team', 'MEMORY.md')
}

/**
 * 为路径的最深存在祖先解析符号链接。目标文件可能尚不存在
 * （我们可能即将创建它），所以我们向上遍历目录树直到 realpath() 成功，
 * 然后将不存在的尾部重新连接到已解析的祖先。
 *
 * 安全性（PSR M22186）：path.resolve() 不解析符号链接。能够在 teamDir 内
 * 放置指向外部（例如 ~/.ssh/authorized_keys）的符号链接的攻击者会通过
 * 基于 resolve() 的包含检查。对最深存在祖先使用 realpath() 确保我们比较
 * 实际的文件系统位置，而非符号路径。
 */
async function realpathDeepestExisting(absolutePath: string): Promise<string> {
  const tail: string[] = []
  let current = absolutePath
  // 向上遍历直到 realpath 成功。ENOENT 表示此段尚不存在；将其弹出到
  // 尾部并重试父级。ENOTDIR 表示路径中间有非目录组件；弹出并重试以便
  // 我们可以 realpath 祖先来检测符号链接逃逸。当我们到达文件系统根目录时
  // 循环终止（dirname('/') === '/'）。
  for (
    let parent = dirname(current);
    current !== parent;
    parent = dirname(current)
  ) {
    try {
      const realCurrent = await realpath(current)
      // 以相反顺序重新连接不存在的尾部（最深先弹出）
      return tail.length === 0
        ? realCurrent
        : join(realCurrent, ...tail.reverse())
    } catch (e: unknown) {
      const code = getErrnoCode(e)
      if (code === 'ENOENT') {
        // 可能是真正不存在（可安全向上遍历）或目标不存在的悬空符号链接。
        // 悬空符号链接是攻击向量：writeFile 会跟随链接在 teamDir 外创建目标。
        // lstat 区分：它对悬空符号链接成功（链接条目本身存在），对真正不存在
        // 的路径失败并返回 ENOENT。
        try {
          const st = await lstat(current)
          if (st.isSymbolicLink()) {
            throw new PathTraversalError(
              `Dangling symlink detected (target does not exist): "${current}"`,
            )
          }
          // lstat 成功但不是符号链接 —— realpath 的 ENOENT 是由祖先中的
          // 悬空符号链接引起的。向上遍历以找到它。
        } catch (lstatErr: unknown) {
          if (lstatErr instanceof PathTraversalError) {
            throw lstatErr
          }
          // lstat 也失败（真正不存在或不可访问）—— 可安全向上遍历。
        }
      } else if (code === 'ELOOP') {
        // 符号链接循环 —— 损坏或恶意的文件系统状态。
        throw new PathTraversalError(
          `Symlink loop detected in path: "${current}"`,
        )
      } else if (code !== 'ENOTDIR' && code !== 'ENAMETOOLONG') {
        // EACCES、EIO 等 —— 无法验证包含。通过包装为 PathTraversalError
        // 失败关闭，以便调用者可以优雅地跳过此条目，而不是中止整个批次。
        throw new PathTraversalError(
          `Cannot verify path containment (${code}): "${current}"`,
        )
      }
      tail.push(current.slice(parent.length + sep.length))
      current = parent
    }
  }
  // 到达文件系统根目录而未找到存在的祖先（罕见 —— 根目录通常存在）。
  // 回退到输入；包含检查将拒绝。
  return absolutePath
}

/**
 * 检查真实（已解析符号链接）路径是否在真实团队记忆目录内。两边都
 * realpath 化，以便比较在规范文件系统位置之间。
 *
 * 如果 teamDir 不存在，返回 true（跳过检查）。这是安全的：符号链接逃逸
 * 需要 teamDir 内预先存在的符号链接，这需要 teamDir 存在。如果没有目录，
 * 就没有符号链接，第一遍字符串级包含检查就足够了。
 */
async function isRealPathWithinTeamDir(
  realCandidate: string,
): Promise<boolean> {
  let realTeamDir: string
  try {
    // getTeamMemPath() 包含尾部分隔符；剥离它，因为 realpath() 在某些
    // 平台上拒绝尾部分隔符。
    realTeamDir = await realpath(getTeamMemPath().replace(/[/\\]+$/, ''))
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      // 团队目录不存在 —— 符号链接逃逸不可能，跳过检查。
      return true
    }
    // 意外错误（EACCES、EIO）—— 失败关闭。
    return false
  }
  if (realCandidate === realTeamDir) {
    return true
  }
  // 前缀攻击防护：要求前缀后有分隔符，以便 "/foo/team-evil" 不匹配 "/foo/team"。
  return realCandidate.startsWith(realTeamDir + sep)
}

/**
 * 检查已解析的绝对路径是否在团队记忆目录内。使用 path.resolve() 转换
 * 相对路径并消除遍历段。不解析符号链接 —— 对于写入验证，请使用
 * validateTeamMemWritePath() 或 validateTeamMemKey()，它们包含符号链接解析。
 */
export function isTeamMemPath(filePath: string): boolean {
  // 安全性：resolve() 转换为绝对路径并消除 .. 段，防止路径遍历攻击
  // （例如 "team/../../etc/passwd"）
  const resolvedPath = resolve(filePath)
  const teamDir = getTeamMemPath()
  return resolvedPath.startsWith(teamDir)
}

/**
 * 验证绝对文件路径是否可安全写入团队记忆目录。有效时返回已解析的绝对路径。
 * 如果路径包含注入向量、通过 .. 段逃逸目录、或通过符号链接逃逸
 * （PSR M22186），抛出 PathTraversalError。
 */
export async function validateTeamMemWritePath(
  filePath: string,
): Promise<string> {
  if (filePath.includes('\0')) {
    throw new PathTraversalError(`Null byte in path: "${filePath}"`)
  }
  // 第一遍：规范化 .. 段并检查字符串级包含。这是在我们接触文件系统之前
  // 对明显遍历尝试的快速拒绝。
  const resolvedPath = resolve(filePath)
  const teamDir = getTeamMemPath()
  // 前缀攻击防护：teamDir 已经以 sep 结尾（来自 getTeamMemPath），
  // 所以 "team-evil/" 不会匹配 "team/"
  if (!resolvedPath.startsWith(teamDir)) {
    throw new PathTraversalError(
      `Path escapes team memory directory: "${filePath}"`,
    )
  }
  // 第二遍：解析最深存在祖先上的符号链接并验证真实路径仍在真实团队目录内。
  // 这捕获了仅 path.resolve() 无法检测的基于符号链接的逃逸。
  const realPath = await realpathDeepestExisting(resolvedPath)
  if (!(await isRealPathWithinTeamDir(realPath))) {
    throw new PathTraversalError(
      `Path escapes team memory directory via symlink: "${filePath}"`,
    )
  }
  return resolvedPath
}

/**
 * 验证来自服务器的相对路径键是否在团队记忆目录内。清理键，与团队目录
 * 连接，解析最深存在祖先上的符号链接，并验证对真实团队目录的包含。
 * 返回已解析的绝对路径。如果键是恶意的（PSR M22186），抛出 PathTraversalError。
 */
export async function validateTeamMemKey(relativeKey: string): Promise<string> {
  sanitizePathKey(relativeKey)
  const teamDir = getTeamMemPath()
  const fullPath = join(teamDir, relativeKey)
  // 第一遍：规范化 .. 段并检查字符串级包含。
  const resolvedPath = resolve(fullPath)
  if (!resolvedPath.startsWith(teamDir)) {
    throw new PathTraversalError(
      `Key escapes team memory directory: "${relativeKey}"`,
    )
  }
  // 第二遍：解析符号链接并验证真实包含。
  const realPath = await realpathDeepestExisting(resolvedPath)
  if (!(await isRealPathWithinTeamDir(realPath))) {
    throw new PathTraversalError(
      `Key escapes team memory directory via symlink: "${relativeKey}"`,
    )
  }
  return resolvedPath
}

/**
 * 检查文件路径是否在团队记忆目录内
 * 且团队记忆已启用。
 */
export function isTeamMemFile(filePath: string): boolean {
  return isTeamMemoryEnabled() && isTeamMemPath(filePath)
}
