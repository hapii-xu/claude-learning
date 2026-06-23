import memoize from 'lodash-es/memoize.js'
import { homedir } from 'os'
import { dirname, isAbsolute, resolve } from 'path'
import type { ToolPermissionContext } from '../../Tool.js'
import { getPlatform } from '../../utils/platform.js'
import {
  getFsImplementation,
  getPathsForPermissionCheck,
  safeResolvePath,
} from '../fsOperations.js'
import { containsPathTraversal } from '../path.js'
import { SandboxManager } from '../sandbox/sandbox-adapter.js'
import { containsVulnerableUncPath } from '../shell/readOnlyCommandValidation.js'
import {
  checkEditableInternalPath,
  checkPathSafetyForAutoEdit,
  checkReadableInternalPath,
  matchingRuleForInput,
  pathInAllowedWorkingPath,
  pathInWorkingPath,
} from './filesystem.js'
import type { PermissionDecisionReason } from './PermissionResult.js'

const MAX_DIRS_TO_LIST = 5
const GLOB_PATTERN_REGEX = /[*?[\]{}]/

export type FileOperationType = 'read' | 'write' | 'create'

export type PathCheckResult = {
  allowed: boolean
  decisionReason?: PermissionDecisionReason
}

export type ResolvedPathCheckResult = PathCheckResult & {
  resolvedPath: string
}

export function formatDirectoryList(directories: string[]): string {
  const dirCount = directories.length

  if (dirCount <= MAX_DIRS_TO_LIST) {
    return directories.map(dir => `'${dir}'`).join(', ')
  }

  const firstDirs = directories
    .slice(0, MAX_DIRS_TO_LIST)
    .map(dir => `'${dir}'`)
    .join(', ')

  return `${firstDirs}, and ${dirCount - MAX_DIRS_TO_LIST} more`
}

/**
 * 从 glob 模式中提取基础目录以进行验证。
 * 例如："/path/to/*.txt" 返回 "/path/to"
 */
export function getGlobBaseDirectory(path: string): string {
  const globMatch = path.match(GLOB_PATTERN_REGEX)
  if (!globMatch || globMatch.index === undefined) {
    return path
  }

  // 获取第一个 glob 字符之前的所有内容
  const beforeGlob = path.substring(0, globMatch.index)

  // 查找最后一个目录分隔符
  const lastSepIndex =
    getPlatform() === 'windows'
      ? Math.max(beforeGlob.lastIndexOf('/'), beforeGlob.lastIndexOf('\\'))
      : beforeGlob.lastIndexOf('/')
  if (lastSepIndex === -1) return '.'

  return beforeGlob.substring(0, lastSepIndex) || '/'
}

/**
 * 将路径开头的波浪号（~）展开为用户主目录。
 * 注意：出于安全原因，不支持 ~username 展开。
 */
export function expandTilde(path: string): string {
  if (
    path === '~' ||
    path.startsWith('~/') ||
    (process.platform === 'win32' && path.startsWith('~\\'))
  ) {
    return homedir() + path.slice(1)
  }
  return path
}

/**
 * 检查已解析路径是否根据沙箱写入允许列表可写。
 * 当沙箱启用时，用户已明确配置了哪些目录可写。
 * 我们将这些视为额外的允许写入目录用于路径验证，
 * 这样当 /tmp/claude/ 已在沙箱允许列表中时，
 * 像 `echo foo > /tmp/claude/x.txt` 这样的命令不会提示权限。
 *
 * 尊重 allow-within-deny 列表：denyWithinAllow 中的路径（如
 * .hclaude/settings.json）即使其父目录在 allowOnly 中也会被阻止。
 */
export function isPathInSandboxWriteAllowlist(resolvedPath: string): boolean {
  if (!SandboxManager.isSandboxingEnabled()) {
    return false
  }
  const { allowOnly, denyWithinAllow } = SandboxManager.getFsWriteConfig()
  // 解析两边的符号链接，使比较对称（匹配
  // pathInAllowedWorkingPath）。没有这个，作为符号链接的
  // 允许列表条目（例如 /home/user/proj -> /data/proj）将不会
  // 匹配对其解析目标的写入，导致不必要的提示。
  // 过度保守，不是安全问题。所有解析的输入表示都必须被允许，
  // 且没有一个可以被拒绝。配置路径在会话期间稳定，
  // 因此记忆化其解析以避免每个命令 N × config.length 次
  // 冗余系统调用，其中 N 个写入目标（匹配 getResolvedWorkingDirPaths）。
  const pathsToCheck = getPathsForPermissionCheck(resolvedPath)
  const resolvedAllow = allowOnly.flatMap(
    getResolvedSandboxConfigPath,
  ) as string[]
  const resolvedDeny = denyWithinAllow.flatMap(
    getResolvedSandboxConfigPath,
  ) as string[]
  return pathsToCheck.every(p => {
    for (const denyPath of resolvedDeny) {
      if (pathInWorkingPath(p, denyPath)) return false
    }
    return resolvedAllow.some(allowPath => pathInWorkingPath(p, allowPath))
  })
}

// 沙箱配置路径在会话期间稳定；记忆化其解析形式以避免
// 每次写入目标检查时重复 lstat/realpath 系统调用。
// 匹配 filesystem.ts 中的 getResolvedWorkingDirPaths 模式。
const getResolvedSandboxConfigPath = memoize(getPathsForPermissionCheck)

/**
 * 检查已解析路径是否允许给定操作类型。
 *
 * @param precomputedPathsToCheck - 可选的缓存结果
 *   `getPathsForPermissionCheck(resolvedPath)`。当 `resolvedPath` 是
 *   `realpathSync` 的输出（规范路径，所有符号链接已解析）时，
 *   此处平凡地为 `[resolvedPath]`，传递它可跳过每次内部检查
 *   5 次冗余系统调用。不要为非规范路径传递此参数
 *   （不存在的文件、UNC 路径等）——这些仍需要父目录符号链接解析。
 */
export function isPathAllowed(
  resolvedPath: string,
  context: ToolPermissionContext,
  operationType: FileOperationType,
  precomputedPathsToCheck?: readonly string[],
): PathCheckResult {
  // 根据操作确定要检查的权限类型
  const permissionType = operationType === 'read' ? 'read' : 'edit'

  // 1. 首先检查拒绝规则（它们优先）
  const denyRule = matchingRuleForInput(
    resolvedPath,
    context,
    permissionType,
    'deny',
  )
  if (denyRule !== null) {
    return {
      allowed: false,
      decisionReason: { type: 'rule', rule: denyRule },
    }
  }

  // 2. 对于写入/创建操作，检查内部可编辑路径（计划文件、临时目录、代理内存、任务目录）
  // 这必须在 checkPathSafetyForAutoEdit 之前，因为 .hclaude 是危险目录
  // 且内部可编辑路径位于 ~/.hclaude/ 下——匹配
  // checkWritePermissionForTool 中的顺序（filesystem.ts 步骤 1.5）
  if (operationType !== 'read') {
    const internalEditResult = checkEditableInternalPath(resolvedPath, {})
    if (internalEditResult.behavior === 'allow') {
      return {
        allowed: true,
        decisionReason: internalEditResult.decisionReason,
      }
    }
  }

  // 2.5. 对于写入/创建操作，检查全面的安全验证
  // 这必须在检查工作目录之前，以防止通过 acceptEdits 模式绕过
  // 检查：Windows 模式、Claude 配置文件、危险文件（在原始 + 符号链接路径上）
  if (operationType !== 'read') {
    const safetyCheck = checkPathSafetyForAutoEdit(
      resolvedPath,
      precomputedPathsToCheck,
    )
    if (!safetyCheck.safe) {
      const failedCheck = safetyCheck as {
        safe: false
        message: string
        classifierApprovable: boolean
      }
      return {
        allowed: false,
        decisionReason: {
          type: 'safetyCheck',
          reason: failedCheck.message,
          classifierApprovable: failedCheck.classifierApprovable,
        },
      }
    }
  }

  // 3. 检查路径是否在允许的工作目录中
  // 对于写入/创建操作，需要 acceptEdits 模式才能自动允许
  // 这与 filesystem.ts 中的 checkWritePermissionForTool 一致
  const isInWorkingDir = pathInAllowedWorkingPath(
    resolvedPath,
    context,
    precomputedPathsToCheck,
  )
  if (isInWorkingDir) {
    if (operationType === 'read' || context.mode === 'acceptEdits') {
      return { allowed: true }
    }
    // 没有 acceptEdits 模式的写入/创建回退到检查允许规则
  }

  // 3.5. 对于读取操作，检查内部可读路径（项目临时目录、会话内存等）
  // 这允许读取代理输出文件而无需显式权限
  if (operationType === 'read') {
    const internalReadResult = checkReadableInternalPath(resolvedPath, {})
    if (internalReadResult.behavior === 'allow') {
      return {
        allowed: true,
        decisionReason: internalReadResult.decisionReason,
      }
    }
  }

  // 3.7. 对于工作目录外的写入/创建操作，
  // 检查沙箱写入允许列表。当沙箱启用时，用户
  // 已明确配置可写目录（例如 /tmp/claude/）——
  // 将这些视为额外的允许写入目录，这样重定向/touch/
  // mkdir 不会不必要地提示。安全检查（步骤 2）已经运行。
  // 工作目录内的路径被故意排除：沙箱
  // 允许列表总是播种 '.'（cwd，参见 sandbox-adapter.ts），
  // 这会绕过步骤 3 的 acceptEdits 门控。步骤 3 处理那些。
  if (
    operationType !== 'read' &&
    !isInWorkingDir &&
    isPathInSandboxWriteAllowlist(resolvedPath)
  ) {
    return {
      allowed: true,
      decisionReason: {
        type: 'other',
        reason: 'Path is in sandbox write allowlist',
      },
    }
  }

  // 4. 检查操作类型的允许规则
  const allowRule = matchingRuleForInput(
    resolvedPath,
    context,
    permissionType,
    'allow',
  )
  if (allowRule !== null) {
    return {
      allowed: true,
      decisionReason: { type: 'rule', rule: allowRule },
    }
  }

  // 5. 路径不被允许
  return { allowed: false }
}

/**
 * 通过检查其基础目录来验证 glob 模式。
 * 返回 glob 将展开的基础路径的验证结果。
 */
export function validateGlobPattern(
  cleanPath: string,
  cwd: string,
  toolPermissionContext: ToolPermissionContext,
  operationType: FileOperationType,
): ResolvedPathCheckResult {
  if (containsPathTraversal(cleanPath)) {
    // 对于有路径遍历的模式，解析完整路径
    const absolutePath = isAbsolute(cleanPath)
      ? cleanPath
      : resolve(cwd, cleanPath)
    const { resolvedPath, isCanonical } = safeResolvePath(
      getFsImplementation(),
      absolutePath,
    )
    const result = isPathAllowed(
      resolvedPath,
      toolPermissionContext,
      operationType,
      isCanonical ? [resolvedPath] : undefined,
    )
    return {
      allowed: result.allowed,
      resolvedPath,
      decisionReason: result.decisionReason,
    }
  }

  const basePath = getGlobBaseDirectory(cleanPath)
  const absoluteBasePath = isAbsolute(basePath)
    ? basePath
    : resolve(cwd, basePath)
  const { resolvedPath, isCanonical } = safeResolvePath(
    getFsImplementation(),
    absoluteBasePath,
  )
  const result = isPathAllowed(
    resolvedPath,
    toolPermissionContext,
    operationType,
    isCanonical ? [resolvedPath] : undefined,
  )
  return {
    allowed: result.allowed,
    resolvedPath,
    decisionReason: result.decisionReason,
  }
}

const WINDOWS_DRIVE_ROOT_REGEX = /^[A-Za-z]:\/?$/
const WINDOWS_DRIVE_CHILD_REGEX = /^[A-Za-z]:\/[^/]+$/

/**
 * 检查已解析路径对于删除操作（rm/rmdir）是否危险。
 * 危险路径包括：
 * - 通配符 '*'（删除目录中的所有文件）
 * - 任何以 '/*' 或 '\*' 结尾的路径（例如 /path/to/dir/*、C:\foo\*）
 * - 根目录（/）
 * - 主目录（~）
 * - 根目录的直接子目录（/usr、/tmp、/etc 等）
 * - Windows 驱动器根（C:\、D:\）和直接子目录（C:\Windows、C:\Users）
 */
export function isDangerousRemovalPath(resolvedPath: string): boolean {
  // 调用者传递两种斜杠形式；合并连续斜杠，使 C:\\Windows
  // （在 PowerShell 中有效）不会绕过驱动器子目录检查。
  const forwardSlashed = resolvedPath.replace(/[\\/]+/g, '/')

  if (forwardSlashed === '*' || forwardSlashed.endsWith('/*')) {
    return true
  }

  const normalizedPath =
    forwardSlashed === '/' ? forwardSlashed : forwardSlashed.replace(/\/$/, '')

  if (normalizedPath === '/') {
    return true
  }

  if (WINDOWS_DRIVE_ROOT_REGEX.test(normalizedPath)) {
    return true
  }

  const normalizedHome = homedir().replace(/[\\/]+/g, '/')
  if (normalizedPath === normalizedHome) {
    return true
  }

  // 根目录的直接子目录：/usr、/tmp、/etc（但不是 /usr/local）
  const parentDir = dirname(normalizedPath)
  if (parentDir === '/') {
    return true
  }

  if (WINDOWS_DRIVE_CHILD_REGEX.test(normalizedPath)) {
    return true
  }

  return false
}

/**
 * 验证文件系统路径，处理波浪号展开和 glob 模式。
 * 返回路径是否允许以及用于错误消息的已解析路径。
 */
export function validatePath(
  path: string,
  cwd: string,
  toolPermissionContext: ToolPermissionContext,
  operationType: FileOperationType,
): ResolvedPathCheckResult {
  // 移除周围的引号（如果存在）
  const cleanPath = expandTilde(path.replace(/^['"]|['"]$/g, ''))

  // 安全性：阻止可能泄露凭据的 UNC 路径
  if (containsVulnerableUncPath(cleanPath)) {
    return {
      allowed: false,
      resolvedPath: cleanPath,
      decisionReason: {
        type: 'other',
        reason: 'UNC network paths require manual approval',
      },
    }
  }

  // 安全性：拒绝 expandTilde 不处理的波浪号变体（~user、~+、~-、~N）。
  // expandTilde 将 ~ 和 ~/ 解析为 $HOME，但 ~root、~+、~- 等保留为字面
  // 文本并解析为相对路径（例如 /cwd/~root/.ssh/id_rsa）。
  // Shell 以不同方式展开这些（~root → /var/root、~+ → $PWD、~- → $OLDPWD），
  // 造成 TOCTOU 间隙：我们验证 /cwd/~root/... 但 bash 读取 /var/root/...
  // 此检查不会有误报，因为 expandTilde 已将 ~ 和 ~/ 转换为
  // 以 / 开头的绝对路径，因此只剩下未展开的变体。
  if (cleanPath.startsWith('~')) {
    return {
      allowed: false,
      resolvedPath: cleanPath,
      decisionReason: {
        type: 'other',
        reason:
          'Tilde expansion variants (~user, ~+, ~-) in paths require manual approval',
      },
    }
  }

  // 安全性：拒绝包含任何 shell 展开语法的路径（$ 或 % 字符，
  // 或以 = 开头的路径，触发 Zsh 等号展开）
  // - $VAR（Unix/Linux 环境变量，如 $HOME、$PWD）
  // - ${VAR}（花括号展开）
  // - $(cmd)（命令替换）
  // - %VAR%（Windows 环境变量，如 %TEMP%、%USERPROFILE%）
  // - 嵌套组合，如 $(echo $HOME)
  // - =cmd（Zsh 等号展开，例如 =rg 展开为 /usr/bin/rg）
  // 所有这些在验证期间保留为字面字符串，但在执行期间
  // 由 shell 展开，造成 TOCTOU 漏洞
  if (
    cleanPath.includes('$') ||
    cleanPath.includes('%') ||
    cleanPath.startsWith('=')
  ) {
    return {
      allowed: false,
      resolvedPath: cleanPath,
      decisionReason: {
        type: 'other',
        reason: 'Shell expansion syntax in paths requires manual approval',
      },
    }
  }

  // 安全性：在写入/创建操作中阻止 glob 模式
  // 写入工具不展开 glob——它们字面使用路径。
  // 允许写入操作中的 glob 可能绕过安全检查。
  // 示例：/allowed/dir/*.txt 只会验证 /allowed/dir，
  // 但实际写入将使用带 * 的字面路径
  if (GLOB_PATTERN_REGEX.test(cleanPath)) {
    if (operationType === 'write' || operationType === 'create') {
      return {
        allowed: false,
        resolvedPath: cleanPath,
        decisionReason: {
          type: 'other',
          reason:
            'Glob patterns are not allowed in write operations. Please specify an exact file path.',
        },
      }
    }

    // 对于读取操作，验证 glob 将展开的基础目录
    return validateGlobPattern(
      cleanPath,
      cwd,
      toolPermissionContext,
      operationType,
    )
  }

  // 解析路径
  const absolutePath = isAbsolute(cleanPath)
    ? cleanPath
    : resolve(cwd, cleanPath)
  const { resolvedPath, isCanonical } = safeResolvePath(
    getFsImplementation(),
    absolutePath,
  )

  const result = isPathAllowed(
    resolvedPath,
    toolPermissionContext,
    operationType,
    isCanonical ? [resolvedPath] : undefined,
  )
  return {
    allowed: result.allowed,
    resolvedPath,
    decisionReason: result.decisionReason,
  }
}
