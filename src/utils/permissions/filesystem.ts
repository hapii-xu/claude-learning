import { feature } from 'bun:bundle'
import { randomBytes } from 'crypto'
import ignore from 'ignore'
import memoize from 'lodash-es/memoize.js'
import { homedir, tmpdir } from 'os'
import { join, normalize, posix, sep } from 'path'
import { hasAutoMemPathOverride, isAutoMemPath } from 'src/memdir/paths.js'
import { isAgentMemoryPath } from '@claude-code-best/builtin-tools/tools/AgentTool/agentMemory.js'
import {
  CLAUDE_FOLDER_PERMISSION_PATTERN,
  FILE_EDIT_TOOL_NAME,
  GLOBAL_CLAUDE_FOLDER_PERMISSION_PATTERN,
} from '@claude-code-best/builtin-tools/tools/FileEditTool/constants.js'
import type { z } from 'zod/v4'
import { getOriginalCwd, getSessionId } from '../../bootstrap/state.js'
import { checkStatsigFeatureGate_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import type { AnyObject, Tool, ToolPermissionContext } from '../../Tool.js'
import { FILE_READ_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/FileReadTool/prompt.js'
import { getCwd } from '../cwd.js'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import {
  getFsImplementation,
  getPathsForPermissionCheck,
} from '../fsOperations.js'
import {
  containsPathTraversal,
  expandPath,
  getDirectoryForPath,
  sanitizePath,
} from '../path.js'
import { getPlanSlug, getPlansDirectory } from '../plans.js'
import { getPlatform } from '../platform.js'
import { getProjectDir } from '../sessionStorage.js'
import { SETTING_SOURCES } from '../settings/constants.js'
import {
  getSettingsFilePathForSource,
  getSettingsRootPathForSource,
} from '../settings/settings.js'
import { containsVulnerableUncPath } from '../shell/readOnlyCommandValidation.js'
import { getToolResultsDir } from '../toolResultStorage.js'
import { windowsPathToPosixPath } from '../windowsPaths.js'
import type {
  PermissionDecision,
  PermissionResult,
} from './PermissionResult.js'
import type { PermissionRule, PermissionRuleSource } from './PermissionRule.js'
import { createReadRuleSuggestion } from './PermissionUpdate.js'
import type { PermissionUpdate } from './PermissionUpdateSchema.js'
import { getRuleByContentsForToolName } from './permissions.js'
import { CLAUDE_DIR_NAME } from 'src/constants/claudeDirName.js'

declare const MACRO: { VERSION: string }

/**
 * 不应自动编辑的危险文件列表。
 * 这些文件可能被用于代码执行或数据泄露。
 */
export const DANGEROUS_FILES = [
  '.gitconfig',
  '.gitmodules',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  '.ripgreprc',
  '.mcp.json',
  '.hclaude.json',
] as const

/**
 * 不应自动编辑的危险目录列表。
 * 这些目录包含敏感的配置或可执行文件。
 */
export const DANGEROUS_DIRECTORIES = [
  '.git',
  '.vscode',
  '.idea',
  CLAUDE_DIR_NAME,
] as const

/**
 * 对路径进行大小写不敏感比较的规范化处理。
 * 这可以防止在大小写不敏感的文件系统（macOS/Windows）上
 * 使用混合大小写路径绕过安全检查，例如 `.hclaude/Settings.locaL.json`。
 *
 * 无论平台如何，始终规范化为小写以确保一致的安全性。
 * @param path 要规范化的路径
 * @returns 用于安全比较的小写路径
 */
export function normalizeCaseForComparison(path: string): string {
  return path.toLowerCase()
}

/**
 * 如果 filePath 位于 .hclaude/skills/{name}/ 目录内（项目级或全局级），
 * 返回技能名称和仅限定于该技能的 session-allow 模式。
 * 用于在权限对话框和 SDK 建议中提供更窄的"仅允许编辑此技能"选项，
 * 这样在迭代单个技能时不需要授予对整个 .hclaude/ 目录的会话访问权限
 * （包括 settings.json、hooks/ 等）。
 */
export function getClaudeSkillScope(
  filePath: string,
): { skillName: string; pattern: string } | null {
  const absolutePath = expandPath(filePath)
  const absolutePathLower = normalizeCaseForComparison(absolutePath)

  const bases = [
    {
      dir: expandPath(join(getOriginalCwd(), CLAUDE_DIR_NAME, 'skills')),
      prefix: '/.hclaude/skills/',
    },
    {
      dir: expandPath(join(homedir(), CLAUDE_DIR_NAME, 'skills')),
      prefix: '~/.hclaude/skills/',
    },
  ]

  for (const { dir, prefix } of bases) {
    const dirLower = normalizeCaseForComparison(dir)
    // 尝试两种路径分隔符（Windows 路径可能未规范化为 /）
    for (const s of [sep, '/']) {
      if (absolutePathLower.startsWith(dirLower + s.toLowerCase())) {
        // 使用小写匹配，但切片使用原始路径以保留技能名称的大小写
        // （下游的模式匹配是大小写敏感的）
        const rest = absolutePath.slice(dir.length + s.length)
        const slash = rest.indexOf('/')
        const bslash = sep === '\\' ? rest.indexOf('\\') : -1
        const cut =
          slash === -1
            ? bslash
            : bslash === -1
              ? slash
              : Math.min(slash, bslash)
        // 要求有分隔符：文件必须在技能目录内部，而不是直接位于 skills/ 下
        // （直接位于 skills/ 下没有技能作用域）
        if (cut <= 0) return null
        const skillName = rest.slice(0, cut)
        // 拒绝路径遍历和空值。使用 includes('..') 而非 === '..' 来
        // 匹配步骤 1.6 的 ruleContent.includes('..') 保护：像 'v2..beta' 这样的技能名
        // 会产生步骤 1.7 发出的建议，但步骤 1.6 总是会拒绝（死建议，无限重新提示）。
        if (!skillName || skillName === '.' || skillName.includes('..')) {
          return null
        }
        // 拒绝 glob 元字符。skillName 会被插入到
        // matchingRuleForInput 中步骤 1.6 的 ignore().add() 消费的 gitignore 模式中。
        // 一个名为 '*' 的目录（在 POSIX 上合法）会产生 '/.hclaude/skills/*/**'，
        // 这会匹配所有技能。返回 null 以便回退到 generateSuggestions()。
        if (/[*?[\]]/.test(skillName)) return null
        return { skillName, pattern: prefix + skillName + '/**' }
      }
    }
  }

  return null
}

// 根据 gitignore 规范，始终使用 / 作为路径分隔符
// https://git-scm.com/docs/gitignore
const DIR_SEP = posix.sep

/**
 * 跨平台相对路径计算，返回 POSIX 风格的路径。
 * 内部处理 Windows 路径转换。
 * @param from 基础路径
 * @param to 目标路径
 * @returns POSIX 风格的相对路径
 */
export function relativePath(from: string, to: string): string {
  if (getPlatform() === 'windows') {
    // 将 Windows 路径转换为 POSIX 格式以进行一致比较
    const posixFrom = windowsPathToPosixPath(from)
    const posixTo = windowsPathToPosixPath(to)
    return posix.relative(posixFrom, posixTo)
  }
  // 直接使用 POSIX 路径
  return posix.relative(from, to)
}

/**
 * 将路径转换为 POSIX 格式以进行模式匹配。
 * 内部处理 Windows 路径转换。
 * @param path 要转换的路径
 * @returns POSIX 风格的路径
 */
export function toPosixPath(path: string): string {
  if (getPlatform() === 'windows') {
    return windowsPathToPosixPath(path)
  }
  return path
}

function getSettingsPaths(): string[] {
  return SETTING_SOURCES.map(source =>
    getSettingsFilePathForSource(source),
  ).filter(path => path !== undefined)
}

export function isClaudeSettingsPath(filePath: string): boolean {
  // 安全性：首先规范化路径结构，防止通过冗余的 ./
  // 序列（如 `./.hclaude/./settings.json`）绕过 endsWith() 检查
  const expandedPath = expandPath(filePath)

  // 规范化以进行大小写不敏感比较，防止通过
  // .hclaude/Settings.locaL.json 等路径绕过安全性
  const normalizedPath = normalizeCaseForComparison(expandedPath)

  // 使用平台分隔符，使 endsWith 检查在 Unix (/) 和 Windows (\) 上都能工作
  if (
    normalizedPath.endsWith(`${sep}.hclaude${sep}settings.json`) ||
    normalizedPath.endsWith(`${sep}.hclaude${sep}settings.local.json`)
  ) {
    // 包含其他项目的 .hclaude/settings.json
    return true
  }
  // 检查当前项目的设置文件（包括托管设置和 CLI 参数）
  // 两个路径现在都是绝对路径并经过规范化以进行一致比较
  return getSettingsPaths().some(
    settingsPath => normalizeCaseForComparison(settingsPath) === normalizedPath,
  )
}

// 当 Claude Code 尝试编辑自己的配置文件时始终询问
function isClaudeConfigFilePath(filePath: string): boolean {
  if (isClaudeSettingsPath(filePath)) {
    return true
  }

  // 检查文件是否在 .hclaude/commands 或 .hclaude/agents 目录内
  // 使用正确的路径段验证（而不是使用 includes() 的字符串匹配）
  // pathInWorkingPath 现在处理大小写不敏感比较以防止绕过
  const commandsDir = join(getOriginalCwd(), CLAUDE_DIR_NAME, 'commands')
  const agentsDir = join(getOriginalCwd(), CLAUDE_DIR_NAME, 'agents')
  const skillsDir = join(getOriginalCwd(), CLAUDE_DIR_NAME, 'skills')

  return (
    pathInWorkingPath(filePath, commandsDir) ||
    pathInWorkingPath(filePath, agentsDir) ||
    pathInWorkingPath(filePath, skillsDir)
  )
}

// 检查文件是否为当前会话的计划文件
function isSessionPlanFile(absolutePath: string): boolean {
  // 检查路径是否为当前会话的计划文件（主计划或特定代理计划）
  // 主计划文件：{plansDir}/{planSlug}.md
  // 代理计划文件：{plansDir}/{planSlug}-agent-{agentId}.md
  const expectedPrefix = join(getPlansDirectory(), getPlanSlug())
  // 安全性：规范化以防止通过 .. 段绕过路径遍历
  const normalizedPath = normalize(absolutePath)
  return (
    normalizedPath.startsWith(expectedPrefix) && normalizedPath.endsWith('.md')
  )
}

/**
 * 返回当前会话的会话内存目录路径，带尾部路径分隔符。
 * 路径格式：{projectDir}/{sessionId}/session-memory/
 */
export function getSessionMemoryDir(): string {
  return join(getProjectDir(getCwd()), getSessionId(), 'session-memory') + sep
}

/**
 * 返回当前会话的会话内存文件路径。
 * 路径格式：{projectDir}/{sessionId}/session-memory/summary.md
 */
export function getSessionMemoryPath(): string {
  return join(getSessionMemoryDir(), 'summary.md')
}

// 检查文件是否在会话内存目录内
function isSessionMemoryPath(absolutePath: string): boolean {
  // 安全性：规范化以防止通过 .. 段绕过路径遍历
  const normalizedPath = normalize(absolutePath)
  return normalizedPath.startsWith(getSessionMemoryDir())
}

/**
 * 检查文件是否在当前项目的目录内。
 * 路径格式：~/.hclaude/projects/{sanitized-cwd}/...
 */
function isProjectDirPath(absolutePath: string): boolean {
  const projectDir = getProjectDir(getCwd())
  // 安全性：规范化以防止通过 .. 段绕过路径遍历
  const normalizedPath = normalize(absolutePath)
  return (
    normalizedPath === projectDir || normalizedPath.startsWith(projectDir + sep)
  )
}

/**
 * 检查临时文件目录功能是否启用。
 * 临时文件目录是每个会话用于 Claude 写入临时文件的目录。
 * 由 tengu_scratch Statsig 门控控制。
 */
export function isScratchpadEnabled(): boolean {
  return checkStatsigFeatureGate_CACHED_MAY_BE_STALE('tengu_scratch')
}

/**
 * 返回用户特定的 Claude 临时目录名称。
 * 在 Unix 上：'claude-{uid}' 以防止多用户权限冲突
 * 在 Windows 上：'claude'（tmpdir() 已经是每用户独立的）
 */
export function getClaudeTempDirName(): string {
  if (getPlatform() === 'windows') {
    return 'claude'
  }
  // 使用 UID 创建每用户目录，防止多个用户
  // 共享同一 /tmp 目录时的权限冲突
  const uid = process.getuid?.() ?? 0
  return `claude-${uid}`
}

/**
 * 返回已解析符号链接的 Claude 临时目录路径。
 * 如果设置了 TMPDIR 环境变量则使用它，否则：
 * - 在 Unix 上：/tmp/claude-{uid}/（在 macOS 上解析为 /private/tmp/claude-{uid}/）
 * - 在 Windows 上：{tmpdir}/claude/（例如 C:\Users\{user}\AppData\Local\Temp\claude\）
 * 这是 Claude Code 用于所有临时文件的每用户临时目录。
 *
 * 注意：我们解析符号链接以确保此路径与权限检查中使用的已解析路径匹配。
 * 在 macOS 上，/tmp 是指向 /private/tmp 的符号链接，如果不解析，
 * 像 /tmp/claude-{uid}/... 这样的路径就无法匹配 /private/tmp/claude-{uid}/...
 */
// 已记忆化：从权限检查（yoloClassifier、sandbox-adapter）和每轮
// BashTool 提示中调用。输入（CLAUDE_CODE_TMPDIR 环境变量 + 平台）在启动时固定，
// 系统 tmp 目录的 realpath 在会话期间不会改变。
export const getClaudeTempDir = memoize(function getClaudeTempDir(): string {
  // tmpdir() 遵循 $TMPDIR，因此非 /tmp 环境（Termux/Android、容器）
  // 可以开箱即用；如果显式设置了 CLAUDE_CODE_TMPDIR 则优先使用。
  const baseTmpDir = process.env.CLAUDE_CODE_TMPDIR || tmpdir()

  // 解析基础临时目录中的符号链接（例如 macOS 上的 /tmp -> /private/tmp）
  // 这确保路径与权限检查中已解析的路径匹配
  const fs = getFsImplementation()
  let resolvedBaseTmpDir = baseTmpDir
  try {
    resolvedBaseTmpDir = fs.realpathSync(baseTmpDir)
  } catch {
    // 如果解析失败，使用原始路径
  }

  return join(resolvedBaseTmpDir, getClaudeTempDirName()) + sep
})

/**
 * 捆绑技能文件提取的根目录（参见 bundledSkills.ts）。
 *
 * 安全性：每进程随机 nonce 是这里的承重防御。
 * 所有其他路径组件（uid、VERSION、技能名、文件键）都是公开信息，
 * 没有 nonce 的话，本地攻击者可以在共享的 /tmp 上预先创建目录树
 * （sticky bit 阻止删除但不阻止创建），然后要么符号链接中间目录
 * （O_NOFOLLOW 只检查最终组件），要么拥有父目录并在写入后
 * 交换文件内容以通过读取允许列表进行提示注入。diskOutput.ts
 * 从其路径中的会话 ID UUID 获得相同的属性。
 *
 * 已记忆化，以便提取写入和权限检查在进程生命周期内对路径达成一致。
 * 按版本作用域，以便来自其他二进制文件的过期提取不会落入允许列表。
 */
export const getBundledSkillsRoot = memoize(
  function getBundledSkillsRoot(): string {
    const nonce = randomBytes(16).toString('hex')
    return join(getClaudeTempDir(), 'bundled-skills', MACRO.VERSION, nonce)
  },
)

/**
 * 返回项目临时目录路径，带尾部路径分隔符。
 * 路径格式：/tmp/claude-{uid}/{sanitized-cwd}/
 */
export function getProjectTempDir(): string {
  return join(getClaudeTempDir(), sanitizePath(getOriginalCwd())) + sep
}

/**
 * 返回当前会话的临时文件目录路径。
 * 路径格式：/tmp/claude-{uid}/{sanitized-cwd}/{sessionId}/scratchpad/
 */
export function getScratchpadDir(): string {
  return join(getProjectTempDir(), getSessionId(), 'scratchpad')
}

/**
 * 确保当前会话的临时文件目录存在。
 * 如果不存在，以安全权限（0o700）创建目录。
 * 返回临时文件目录的路径。
 * @throws 如果临时文件目录功能未启用
 */
export async function ensureScratchpadDir(): Promise<string> {
  if (!isScratchpadEnabled()) {
    throw new Error('Scratchpad directory feature is not enabled')
  }

  const fs = getFsImplementation()
  const scratchpadDir = getScratchpadDir()

  // 以安全权限（仅所有者访问）递归创建目录
  // FsOperations.mkdir 内部处理 recursive: true，如果目录已存在则为空操作
  await fs.mkdir(scratchpadDir, { mode: 0o700 })

  return scratchpadDir
}

// 检查文件是否在临时文件目录内
function isScratchpadPath(absolutePath: string): boolean {
  if (!isScratchpadEnabled()) {
    return false
  }
  const scratchpadDir = getScratchpadDir()
  // 安全性：规范化路径以在检查前解析 .. 段
  // 这可以防止路径遍历绕过，例如：
  //   echo "malicious" > /tmp/claude-0/proj/session/scratchpad/../../../etc/passwd
  // 如果不规范化，路径会通过 startsWith 检查但实际写入 /etc/passwd
  const normalizedPath = normalize(absolutePath)
  return (
    normalizedPath === scratchpadDir ||
    normalizedPath.startsWith(scratchpadDir + sep)
  )
}

/**
 * 检查文件路径在没有明确权限时自动编辑是否危险。
 * 包括：
 * - .git 目录或 .gitconfig 文件中的文件（防止基于 git 的数据泄露和代码执行）
 * - .vscode 目录中的文件（防止 VS Code 设置操纵和潜在的代码执行）
 * - .idea 目录中的文件（防止 JetBrains IDE 设置操纵）
 * - Shell 配置文件（防止 shell 启动脚本操纵）
 * - UNC 路径（防止网络文件访问和 WebDAV 攻击）
 */
function isDangerousFilePathToAutoEdit(path: string): boolean {
  const absolutePath = expandPath(path)
  const pathSegments = absolutePath.split(sep)
  const fileName = pathSegments.at(-1)

  // 检查 UNC 路径（纵深防御，捕获 containsVulnerableUncPath 可能未捕获的任何模式）
  // 阻止以 \\ 或 // 开头的任何内容，因为这些是可能访问网络资源的潜在 UNC 路径
  if (path.startsWith('\\\\') || path.startsWith('//')) {
    return true
  }

  // 检查路径是否在危险目录内（大小写不敏感以防止绕过）
  for (let i = 0; i < pathSegments.length; i++) {
    const segment = pathSegments[i]!
    const normalizedSegment = normalizeCaseForComparison(segment)

    for (const dir of DANGEROUS_DIRECTORIES) {
      if (normalizedSegment !== normalizeCaseForComparison(dir)) {
        continue
      }

      // 特殊情况：.hclaude/worktrees/ 是结构路径（Claude 存储 git worktree 的位置），
      // 不是用户创建的危险目录。当 .hclaude 后跟 'worktrees' 时跳过。
      // worktree 内嵌套的任何 .hclaude 目录（不跟 'worktrees'）仍被阻止。
      if (dir === CLAUDE_DIR_NAME) {
        const nextSegment = pathSegments[i + 1]
        if (
          nextSegment &&
          normalizeCaseForComparison(nextSegment) === 'worktrees'
        ) {
          break // 跳过此 .hclaude，继续检查其他段
        }
      }

      return true
    }
  }

  // 检查危险的配置文件（大小写不敏感）
  if (fileName) {
    const normalizedFileName = normalizeCaseForComparison(fileName)
    if (
      (DANGEROUS_FILES as readonly string[]).some(
        dangerousFile =>
          normalizeCaseForComparison(dangerousFile) === normalizedFileName,
      )
    ) {
      return true
    }
  }

  return false
}

/**
 * 检测可能绕过安全检查的可疑 Windows 路径模式。
 * 这些模式包括：
 * - NTFS 备用数据流（例如 file.txt::$DATA 或 file.txt:stream）
 * - 8.3 短名称（例如 GIT~1、CLAUDE~1、SETTIN~1.JSON）
 * - 长路径前缀（例如 \\?\C:\...、\\.\C:\...、//?/C:/...、//./C:/...）
 * - 尾随点和空格（例如 .git.、.hclaude 、.bashrc...）
 * - DOS 设备名（例如 .git.CON、settings.json.PRN、.bashrc.AUX）
 * - 三个或更多连续点（例如 .../file.txt、path/.../file、file...txt）
 *
 * 检测到这些路径时，应始终要求手动批准，以防止
 * 通过路径规范化漏洞绕过安全检查。
 *
 * ## 为什么在所有平台上检查？
 *
 * 虽然这些模式主要是 Windows 特定的，但 NTFS 文件系统可以
 * 挂载在 Linux 和 macOS 上（例如使用 ntfs-3g）。在这些系统上，
 * 相同的绕过技术会起作用——攻击者可以使用短名称或长路径前缀
 * 绕过安全检查。因此，我们在所有平台上检查这些模式以确保
 * 全面保护。（注意：ADS 冒号检查仅限 Windows/WSL，因为冒号
 * 语法只由 Windows 内核解释；在 Linux/macOS 上，NTFS ADS
 * 通过 xattrs 访问，而不是冒号语法。）
 *
 * ## 为什么检测而不是规范化？
 *
 * 另一种方法是使用 Windows API（例如 GetLongPathNameW）规范化这些路径。
 * 然而，这种方法有重大挑战：
 *
 * 1. **文件系统依赖性**：短路径规范化是相对于文件系统上当前存在的文件。
 *    这在写入新文件时会产生问题，因为它们尚不存在且无法规范化。
 *
 * 2. **竞态条件**：文件系统状态可能在规范化和实际文件访问之间改变，
 *    造成 TOCTOU（检查时间-使用时间）漏洞。
 *
 * 3. **复杂性**：正确的规范化需要 Windows 特定的 API，处理多个边缘情况，
 *    并处理各种路径格式（UNC、设备路径等）。
 *
 * 4. **可靠性**：模式检测更可预测，不依赖外部系统状态。
 *
 * 如果您考虑为这些路径添加规范化，请先联系 AppSec
 * 讨论安全影响和实施方法。
 *
 * @param path 要检查可疑模式的路径
 * @returns 如果检测到可疑的 Windows 路径模式则返回 true
 */
function hasSuspiciousWindowsPathPattern(path: string): boolean {
  // 检查 NTFS 备用数据流
  // 在位置 2 之后查找 ':' 以跳过驱动器号（例如 C:\）
  // 示例：file.txt::$DATA、.bashrc:hidden、settings.json:stream
  // 注意：ADS 冒号语法只由 Windows 内核解释。在 WSL 上，
  // DrvFs 挂载将文件操作路由到 Windows 内核，因此冒号语法
  // 仍被解释为 ADS 分隔符。在 Linux/macOS（非 WSL）上，
  // 即使挂载了 NTFS，ADS 也通过 xattrs（ntfs-3g）访问，
  // 而不是冒号语法，冒号是合法的文件名字符。
  if (getPlatform() === 'windows' || getPlatform() === 'wsl') {
    const colonIndex = path.indexOf(':', 2)
    if (colonIndex !== -1) {
      return true
    }
  }

  // 检查 8.3 短名称
  // 查找 '~' 后跟数字
  // 示例：GIT~1、CLAUDE~1、SETTIN~1.JSON、BASHRC~1
  if (/~\d/.test(path)) {
    return true
  }

  // 检查长路径前缀（反斜杠和正斜杠变体）
  // 示例：\\?\C:\Users\...、\\.\C:\...、//?/C:/...、//./C:/...
  if (
    path.startsWith('\\\\?\\') ||
    path.startsWith('\\\\.\\') ||
    path.startsWith('//?/') ||
    path.startsWith('//./')
  ) {
    return true
  }

  // 检查 Windows 在路径解析期间会剥离的尾随点和空格
  // 示例：.git.、.hclaude 、.bashrc...、settings.json.
  // 如果 ".git" 被阻止但使用 ".git." 则可能绕过字符串匹配
  if (/[.\s]+$/.test(path)) {
    return true
  }

  // 检查 Windows 视为特殊设备的 DOS 设备名
  // 示例：.git.CON、settings.json.PRN、.bashrc.AUX
  // 设备名：CON、PRN、AUX、NUL、COM1-9、LPT1-9
  if (/\.(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(path)) {
    return true
  }

  // 检查三个或更多连续点（...）当用作路径组件时
  // 此模式可用于绕过安全检查或制造混乱
  // 示例：.../file.txt、path/.../file
  // 仅当点前后都有路径分隔符（/ 或 \）时才阻止
  // 这允许合法用途，如 Next.js 的全捕获路由 [...]name]
  if (/(^|\/|\\)\.{3,}(\/|\\|$)/.test(path)) {
    return true
  }

  // 检查 UNC 路径（在所有平台上进行纵深防御）
  // 示例：\\server\share、\\foo.com\file、//server/share、\\192.168.1.1\share
  // UNC 路径可以访问远程资源、泄露凭据并绕过工作目录限制
  if (containsVulnerableUncPath(path)) {
    return true
  }

  return false
}

/**
 * 检查路径对于自动编辑（acceptEdits 模式）是否安全。
 * 返回路径不安全的原因，如果所有检查通过则返回 null。
 *
 * 此函数执行全面的安全检查，包括：
 * - 可疑的 Windows 路径模式（NTFS 流、8.3 名称、长路径前缀等）
 * - Claude 配置文件（.hclaude/settings.json、.hclaude/commands/、.hclaude/agents/）
 * - MCP CLI 状态文件（由 Claude Code 内部管理）
 * - 危险文件（.bashrc、.gitconfig、.git/、.vscode/、.idea/ 等）
 *
 * 重要：此函数同时检查原始路径和已解析的符号链接路径
 * 以防止通过指向受保护文件的符号链接绕过。
 *
 * @param path 要检查安全性的路径
 * @returns 如果不安全则返回 safe=false 和消息，如果所有检查通过则返回 { safe: true }
 */
export function checkPathSafetyForAutoEdit(
  path: string,
  precomputedPathsToCheck?: readonly string[],
):
  | { safe: true }
  | { safe: false; message: string; classifierApprovable: boolean } {
  // 获取所有要检查的路径（原始路径 + 符号链接解析路径）
  const pathsToCheck =
    precomputedPathsToCheck ?? getPathsForPermissionCheck(path)

  // 检查所有路径的可疑 Windows 路径模式
  for (const pathToCheck of pathsToCheck) {
    if (hasSuspiciousWindowsPathPattern(pathToCheck)) {
      return {
        safe: false,
        message: `Claude requested permissions to write to ${path}, which contains a suspicious Windows path pattern that requires manual approval.`,
        classifierApprovable: false,
      }
    }
  }

  // 检查所有路径的 Claude 配置文件
  for (const pathToCheck of pathsToCheck) {
    if (isClaudeConfigFilePath(pathToCheck)) {
      return {
        safe: false,
        message: `Claude requested permissions to write to ${path}, but you haven't granted it yet.`,
        classifierApprovable: true,
      }
    }
  }

  // 检查所有路径的危险文件
  for (const pathToCheck of pathsToCheck) {
    if (isDangerousFilePathToAutoEdit(pathToCheck)) {
      return {
        safe: false,
        message: `Claude requested permissions to edit ${path} which is a sensitive file.`,
        classifierApprovable: true,
      }
    }
  }

  // 所有安全检查通过
  return { safe: true }
}

export function allWorkingDirectories(
  context: ToolPermissionContext,
): Set<string> {
  return new Set([
    getOriginalCwd(),
    ...context.additionalWorkingDirectories.keys(),
  ])
}

// 工作目录在会话期间稳定；记忆化其解析形式以避免
// 每次权限检查时重复 existsSync/lstatSync/realpathSync 系统调用。
// 按键入路径字符串——getPathsForPermissionCheck 对于会话内
// 现有目录是确定性的。
// 导出用于 test/preload.ts 缓存清理（分片隔离）。
export const getResolvedWorkingDirPaths = memoize(getPathsForPermissionCheck)

export function pathInAllowedWorkingPath(
  path: string,
  toolPermissionContext: ToolPermissionContext,
  precomputedPathsToCheck?: readonly string[],
): boolean {
  // 同时检查原始路径和已解析的符号链接路径
  const pathsToCheck =
    precomputedPathsToCheck ?? getPathsForPermissionCheck(path)

  // 解析工作目录的方式与解析输入路径的方式相同，
  // 以便比较是对称的。没有这个，已解析的输入路径
  // （例如 macOS 上的 /System/Volumes/Data/home/...）将无法匹配
  // 未解析的工作目录（/home/...），导致错误的拒绝。
  const workingPaths = Array.from(
    allWorkingDirectories(toolPermissionContext),
  ).flatMap(wp => getResolvedWorkingDirPaths(wp))

  // 所有路径必须在允许的工作目录内
  // 如果任何解析路径在外部，拒绝访问
  return pathsToCheck.every(pathToCheck =>
    workingPaths.some(workingPath =>
      pathInWorkingPath(pathToCheck, workingPath),
    ),
  )
}

export function pathInWorkingPath(path: string, workingPath: string): boolean {
  const absolutePath = expandPath(path)
  const absoluteWorkingPath = expandPath(workingPath)

  // 在 macOS 上，处理常见的符号链接问题：
  // - /var -> /private/var
  // - /tmp -> /private/tmp
  const normalizedPath = absolutePath
    .replace(/^\/private\/var\//, '/var/')
    .replace(/^\/private\/tmp(\/|$)/, '/tmp$1')
  const normalizedWorkingPath = absoluteWorkingPath
    .replace(/^\/private\/var\//, '/var/')
    .replace(/^\/private\/tmp(\/|$)/, '/tmp$1')

  // 规范化大小写以在大小写不敏感的文件系统（macOS/Windows）上进行
  // 比较，防止绕过安全检查，如 .hclaude/CoMmAnDs
  const caseNormalizedPath = normalizeCaseForComparison(normalizedPath)
  const caseNormalizedWorkingPath = normalizeCaseForComparison(
    normalizedWorkingPath,
  )

  // 使用跨平台相对路径辅助函数
  const relative = relativePath(caseNormalizedWorkingPath, caseNormalizedPath)

  // 相同路径
  if (relative === '') {
    return true
  }

  if (containsPathTraversal(relative)) {
    return false
  }

  // 路径在内部（不向上遍历的相对路径）
  return !posix.isAbsolute(relative)
}

function rootPathForSource(source: PermissionRuleSource): string {
  switch (source) {
    case 'cliArg':
    case 'command':
    case 'session':
      return expandPath(getOriginalCwd())
    case 'userSettings':
    case 'policySettings':
    case 'projectSettings':
    case 'localSettings':
    case 'flagSettings':
      return getSettingsRootPathForSource(source)
  }
}

function prependDirSep(path: string): string {
  return posix.join(DIR_SEP, path)
}

function normalizePatternToPath({
  patternRoot,
  pattern,
  rootPath,
}: {
  patternRoot: string
  pattern: string
  rootPath: string
}): string | null {
  // 如果模式根 + 模式组合以参考根开始
  const fullPattern = posix.join(patternRoot, pattern)
  if (patternRoot === rootPath) {
    // 如果模式根恰好等于参考根，无需更改
    return prependDirSep(pattern)
  } else if (fullPattern.startsWith(`${rootPath}${DIR_SEP}`)) {
    // 提取相对部分
    const relativePart = fullPattern.slice(rootPath.length)
    return prependDirSep(relativePart)
  } else {
    // 处理在参考根内但不以其开始的模式
    const relativePath = posix.relative(rootPath, patternRoot)
    if (
      !relativePath ||
      relativePath.startsWith(`..${DIR_SEP}`) ||
      relativePath === '..'
    ) {
      // 模式在参考根之外，可以跳过
      return null
    } else {
      const relativePattern = posix.join(relativePath, pattern)
      return prependDirSep(relativePattern)
    }
  }
}

export function normalizePatternsToPath(
  patternsByRoot: Map<string | null, string[]>,
  root: string,
): string[] {
  // null 根表示模式可以匹配任何位置
  const result = new Set(patternsByRoot.get(null) ?? [])

  for (const [patternRoot, patterns] of patternsByRoot.entries()) {
    if (patternRoot === null) {
      // 已添加
      continue
    }

    // 检查每个模式以查看完整路径是否以参考根开始
    for (const pattern of patterns) {
      const normalizedPattern = normalizePatternToPath({
        patternRoot,
        pattern,
        rootPath: root,
      })
      if (normalizedPattern) {
        result.add(normalizedPattern)
      }
    }
  }
  return Array.from(result)
}

/**
 * 收集文件读取权限的所有拒绝规则并返回其忽略模式。
 * 每个模式必须相对于其根（map 键）解析。
 * null 键用于没有根的模式。
 *
 * 这用于隐藏被读取拒绝规则阻止的文件。
 *
 * @param toolPermissionContext
 */
export function getFileReadIgnorePatterns(
  toolPermissionContext: ToolPermissionContext,
): Map<string | null, string[]> {
  const patternsByRoot = getPatternsByRoot(
    toolPermissionContext,
    'read',
    'deny',
  )
  const result = new Map<string | null, string[]>()
  for (const [patternRoot, patternMap] of patternsByRoot.entries()) {
    result.set(patternRoot, Array.from(patternMap.keys()))
  }

  return result
}

function patternWithRoot(
  pattern: string,
  source: PermissionRuleSource,
): {
  relativePattern: string
  root: string | null
} {
  if (pattern.startsWith(`${DIR_SEP}${DIR_SEP}`)) {
    // 以 // 开头的模式相对于 / 解析
    const patternWithoutDoubleSlash = pattern.slice(1)

    // 在 Windows 上，检查这是否是 POSIX 风格的驱动器路径，如 //c/Users/...
    // 注意：UNC 路径（//server/share）不会匹配此正则表达式，将被视为
    // 根相对模式，将来可能需要单独处理
    if (
      getPlatform() === 'windows' &&
      patternWithoutDoubleSlash.match(/^\/[a-z]\//i)
    ) {
      // 将 POSIX 路径转换为 Windows 格式
      // 模式如 /c/Users/... 因此我们将其转换为 C:\Users\...
      const driveLetter = patternWithoutDoubleSlash[1]?.toUpperCase() ?? 'C'
      // 保持 POSIX 格式，因为 relativePath 返回 POSIX 路径
      const pathAfterDrive = patternWithoutDoubleSlash.slice(2)

      // 提取驱动器根（C:\）和模式的其余部分
      const driveRoot = `${driveLetter}:\\`
      const relativeFromDrive = pathAfterDrive.startsWith('/')
        ? pathAfterDrive.slice(1)
        : pathAfterDrive

      return {
        relativePattern: relativeFromDrive,
        root: driveRoot,
      }
    }

    return {
      relativePattern: patternWithoutDoubleSlash,
      root: DIR_SEP,
    }
  } else if (pattern.startsWith(`~${DIR_SEP}`)) {
    // 以 ~/ 开头的模式相对于用户主目录解析
    return {
      relativePattern: pattern.slice(1),
      root: homedir().normalize('NFC'),
    }
  } else if (pattern.startsWith(DIR_SEP)) {
    // 以 / 开头的模式相对于存储设置的目录解析（不含 .hclaude/）
    return {
      relativePattern: pattern,
      root: rootPathForSource(source),
    }
  }
  // 未指定根，将其与所有其他模式放在一起
  // 规范化以 "./" 开头的模式以移除前缀
  // 这确保像 "./.env" 这样的模式可以匹配 ".env" 文件
  let normalizedPattern = pattern
  if (pattern.startsWith(`.${DIR_SEP}`)) {
    normalizedPattern = pattern.slice(2)
  }
  return {
    relativePattern: normalizedPattern,
    root: null,
  }
}

function getPatternsByRoot(
  toolPermissionContext: ToolPermissionContext,
  toolType: 'edit' | 'read',
  behavior: 'allow' | 'deny' | 'ask',
): Map<string | null, Map<string, PermissionRule>> {
  const toolName = (() => {
    switch (toolType) {
      case 'edit':
        // 将编辑工具规则应用于任何编辑文件的工具
        return FILE_EDIT_TOOL_NAME
      case 'read':
        // 将读取工具规则应用于任何读取文件的工具
        return FILE_READ_TOOL_NAME
    }
  })()

  const rules = getRuleByContentsForToolName(
    toolPermissionContext,
    toolName,
    behavior,
  )
  // 根据来源解析相对于路径的规则
  const patternsByRoot = new Map<string | null, Map<string, PermissionRule>>()
  for (const [pattern, rule] of rules.entries()) {
    const { relativePattern, root } = patternWithRoot(pattern, rule.source)
    let patternsForRoot = patternsByRoot.get(root)
    if (patternsForRoot === undefined) {
      patternsForRoot = new Map<string, PermissionRule>()
      patternsByRoot.set(root, patternsForRoot)
    }
    // 按根存储规则
    patternsForRoot.set(relativePattern, rule)
  }
  return patternsByRoot
}

export function matchingRuleForInput(
  path: string,
  toolPermissionContext: ToolPermissionContext,
  toolType: 'edit' | 'read',
  behavior: 'allow' | 'deny' | 'ask',
): PermissionRule | null {
  let fileAbsolutePath = expandPath(path)

  // 在 Windows 上，转换为 POSIX 格式以匹配权限模式
  if (getPlatform() === 'windows' && fileAbsolutePath.includes('\\')) {
    fileAbsolutePath = windowsPathToPosixPath(fileAbsolutePath)
  }

  const patternsByRoot = getPatternsByRoot(
    toolPermissionContext,
    toolType,
    behavior,
  )

  // 检查每个根以查找匹配的模式
  for (const [root, patternMap] of patternsByRoot.entries()) {
    // 为忽略库转换模式
    const patterns = Array.from(patternMap.keys()).map(pattern => {
      let adjustedPattern = pattern

      // 移除 /** 后缀——忽略库将 'path' 视为同时匹配
      // 路径本身和其内部的所有内容
      if (adjustedPattern.endsWith('/**')) {
        adjustedPattern = adjustedPattern.slice(0, -3)
      }

      return adjustedPattern
    })

    const ig = ignore().add(patterns)

    // 使用跨平台相对路径辅助函数生成 POSIX 风格的模式
    const relativePathStr = relativePath(
      root ?? getCwd(),
      fileAbsolutePath ?? getCwd(),
    )

    if (relativePathStr.startsWith(`..${DIR_SEP}`)) {
      // 路径在根之外，忽略它
      continue
    }

    // 重要：ig.test 如果给定空字符串会抛出异常
    if (!relativePathStr) {
      continue
    }

    const igResult = ig.test(relativePathStr)

    if (igResult.ignored && igResult.rule) {
      // 将匹配的模式映射回原始规则
      const originalPattern = igResult.rule.pattern

      // 检查这是否是我们简化的 /** 模式
      const withWildcard = originalPattern + '/**'
      if (patternMap.has(withWildcard)) {
        return patternMap.get(withWildcard) ?? null
      }

      return patternMap.get(originalPattern) ?? null
    }
  }

  // 未找到匹配规则
  return null
}

/**
 * 指定工具 & 工具输入的读取权限结果
 */
export function checkReadPermissionForTool(
  tool: Tool,
  input: { [key: string]: unknown },
  toolPermissionContext: ToolPermissionContext,
): PermissionDecision {
  if (typeof tool.getPath !== 'function') {
    return {
      behavior: 'ask',
      message: `Claude requested permissions to use ${tool.name}, but you haven't granted it yet.`,
    }
  }
  const path = tool.getPath(input)

  // 获取要检查的路径（包括原始路径和已解析的符号链接）。
  // 在此处计算一次并传递到 checkWritePermissionForTool →
  // checkPathSafetyForAutoEdit → pathInAllowedWorkingPath 以避免冗余的
  // existsSync/lstatSync/realpathSync 系统调用在同一 路径上（之前
  // 每次读取权限检查 6× = 30 次系统调用）。
  const pathsToCheck = getPathsForPermissionCheck(path)

  // 1. 纵深防御：提前阻止 UNC 路径（在其他检查之前）
  // 这捕获以 \\ 或 // 开头的路径，这些路径可能访问网络资源
  // 这可能会捕获 containsVulnerableUncPath 未检测到的一些 UNC 模式
  for (const pathToCheck of pathsToCheck) {
    if (pathToCheck.startsWith('\\\\') || pathToCheck.startsWith('//')) {
      return {
        behavior: 'ask',
        message: `Claude requested permissions to read from ${path}, which appears to be a UNC path that could access network resources.`,
        decisionReason: {
          type: 'other',
          reason: 'UNC path detected (defense-in-depth check)',
        },
      }
    }
  }

  // 2. 检查可疑的 Windows 路径模式（纵深防御）
  for (const pathToCheck of pathsToCheck) {
    if (hasSuspiciousWindowsPathPattern(pathToCheck)) {
      return {
        behavior: 'ask',
        message: `Claude requested permissions to read from ${path}, which contains a suspicious Windows path pattern that requires manual approval.`,
        decisionReason: {
          type: 'other',
          reason:
            'Path contains suspicious Windows-specific patterns (alternate data streams, short names, long path prefixes, or three or more consecutive dots) that require manual verification',
        },
      }
    }
  }

  // 3. 首先检查读取特定的拒绝规则——同时检查原始路径和已解析的符号链接路径
  // 安全性：这必须在任何允许检查之前（包括"编辑访问意味着读取访问"）
  // 以防止绕过显式读取拒绝规则
  for (const pathToCheck of pathsToCheck) {
    const denyRule = matchingRuleForInput(
      pathToCheck,
      toolPermissionContext,
      'read',
      'deny',
    )
    if (denyRule) {
      return {
        behavior: 'deny',
        message: `Permission to read ${path} has been denied.`,
        decisionReason: {
          type: 'rule',
          rule: denyRule,
        },
      }
    }
  }

  // 4. 检查读取特定的询问规则——同时检查原始路径和已解析的符号链接路径
  // 安全性：这必须在隐式允许检查之前，以确保遵守显式询问规则
  for (const pathToCheck of pathsToCheck) {
    const askRule = matchingRuleForInput(
      pathToCheck,
      toolPermissionContext,
      'read',
      'ask',
    )
    if (askRule) {
      return {
        behavior: 'ask',
        message: `Claude requested permissions to read from ${path}, but you haven't granted it yet.`,
        decisionReason: {
          type: 'rule',
          rule: askRule,
        },
      }
    }
  }

  // 5. 编辑访问意味着读取访问（但仅在没有读取特定的拒绝/询问规则时）
  // 我们在读取特定规则之后检查此项，以便显式读取限制优先
  const editResult = checkWritePermissionForTool(
    tool,
    input,
    toolPermissionContext,
    pathsToCheck,
  )
  if (editResult.behavior === 'allow') {
    return editResult
  }

  // 6. 允许在工作目录中读取
  const isInWorkingDir = pathInAllowedWorkingPath(
    path,
    toolPermissionContext,
    pathsToCheck,
  )
  if (isInWorkingDir) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'mode',
        mode: 'default',
      },
    }
  }

  // 7. 允许从内部工具路径读取（会话内存、计划、工具结果）
  const absolutePath = expandPath(path)
  const internalReadResult = checkReadableInternalPath(absolutePath, input)
  if (internalReadResult.behavior !== 'passthrough') {
    return internalReadResult
  }

  // 8. 检查允许规则
  const allowRule = matchingRuleForInput(
    path,
    toolPermissionContext,
    'read',
    'allow',
  )
  if (allowRule) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'rule',
        rule: allowRule,
      },
    }
  }

  // 12. 默认请求权限
  // 此时，isInWorkingDir 为 false（来自步骤 #6），因此路径在工作目录之外
  return {
    behavior: 'ask',
    message: `Claude requested permissions to read from ${path}, but you haven't granted it yet.`,
    suggestions: generateSuggestions(
      path,
      'read',
      toolPermissionContext,
      pathsToCheck,
    ),
    decisionReason: {
      type: 'workingDir',
      reason: 'Path is outside allowed working directories',
    },
  }
}

/**
 * 指定工具 & 工具输入的写入权限结果。
 *
 * @param precomputedPathsToCheck - 可选的缓存结果
 *   `getPathsForPermissionCheck(tool.getPath(input))`。调用者必须
 *   在同一同步帧中从相同的 `tool` 和 `input` 派生此值——`path`
 *   在内部重新派生用于错误消息和内部路径检查，因此过时的值
 *   会默默地检查错误路径的拒绝规则。
 */
export function checkWritePermissionForTool<Input extends AnyObject>(
  tool: Tool<Input>,
  input: z.infer<Input>,
  toolPermissionContext: ToolPermissionContext,
  precomputedPathsToCheck?: readonly string[],
): PermissionDecision {
  if (typeof tool.getPath !== 'function') {
    return {
      behavior: 'ask',
      message: `Claude requested permissions to use ${tool.name}, but you haven't granted it yet.`,
    }
  }
  const path = tool.getPath(input)

  // 1. 检查拒绝规则——同时检查原始路径和已解析的符号链接路径
  const pathsToCheck =
    precomputedPathsToCheck ?? getPathsForPermissionCheck(path)
  for (const pathToCheck of pathsToCheck) {
    const denyRule = matchingRuleForInput(
      pathToCheck,
      toolPermissionContext,
      'edit',
      'deny',
    )
    if (denyRule) {
      return {
        behavior: 'deny',
        message: `Permission to edit ${path} has been denied.`,
        decisionReason: {
          type: 'rule',
          rule: denyRule,
        },
      }
    }
  }

  // 1.5. 允许写入内部可编辑路径（计划文件、临时目录）
  // 这必须在 isDangerousFilePathToAutoEdit 检查之前，因为 .hclaude 是危险目录
  const absolutePathForEdit = expandPath(path)
  const internalEditResult = checkEditableInternalPath(
    absolutePathForEdit,
    input,
  )
  if (internalEditResult.behavior !== 'passthrough') {
    return internalEditResult
  }

  // 1.6. 在安全检查之前检查 .hclaude/** 允许规则
  // 这允许会话级权限绕过 .hclaude/ 的安全阻止
  // 我们只允许会话级规则，以防止用户意外地永久授予
  // 对其 .hclaude/ 文件夹的广泛访问。
  //
  // matchingRuleForInput 返回跨所有来源的第一个匹配。如果用户
  // 在 userSettings 中也有更广泛的 Edit(.hclaude) 规则（例如来自沙箱
  // 写入允许转换），该规则会首先被找到，其来源检查
  // 会失败。将搜索限定为仅会话规则，以便对话框的
  // "允许 Claude 在此会话中编辑其自己的设置"选项实际生效。
  const claudeFolderAllowRule = matchingRuleForInput(
    path,
    {
      ...toolPermissionContext,
      alwaysAllowRules: {
        session: toolPermissionContext.alwaysAllowRules.session ?? [],
      },
    },
    'edit',
    'allow',
  )
  if (claudeFolderAllowRule) {
    // 检查此规则是否限定在 .hclaude/ 下（项目级或全局级）。
    // 接受广泛模式（'/.hclaude/**'、'~/.hclaude/**'）和
    // 缩小模式（如 '/.hclaude/skills/my-skill/**'），这样用户可以
    // 授予单个技能的会话访问权限，而不暴露 settings.json
    // 或 hooks/。该规则已通过 matchingRuleForInput 匹配路径；
    // 这是额外的范围检查。拒绝 '..' 以防止像
    // '/.hclaude/../**' 这样的规则将此绕过泄漏到 .hclaude/ 之外。
    const ruleContent = claudeFolderAllowRule.ruleValue.ruleContent
    if (
      ruleContent &&
      (ruleContent.startsWith(CLAUDE_FOLDER_PERMISSION_PATTERN.slice(0, -2)) ||
        ruleContent.startsWith(
          GLOBAL_CLAUDE_FOLDER_PERMISSION_PATTERN.slice(0, -2),
        )) &&
      !ruleContent.includes('..') &&
      ruleContent.endsWith('/**')
    ) {
      return {
        behavior: 'allow',
        updatedInput: input,
        decisionReason: {
          type: 'rule',
          rule: claudeFolderAllowRule,
        },
      }
    }
  }

  // 1.7. 检查全面的安全验证（Windows 模式、Claude 配置、危险文件）
  // 这必须在检查允许规则之前，以防止用户意外授予
  // 编辑受保护文件的权限
  const safetyCheck = checkPathSafetyForAutoEdit(path, pathsToCheck)
  if (!safetyCheck.safe) {
    // SDK 建议：如果在 .hclaude/skills/{name}/ 下，发出步骤 1.6
    // 将在下次调用时遵守的缩小会话范围 addRules。
    // 其他一切（.hclaude/settings.json、.git/、.vscode/、.idea/）
    // 回退到 generateSuggestions——其 setMode 建议不会绕过
    // 此检查，但保留它可以避免意外的空数组。
    const skillScope = getClaudeSkillScope(path)
    const safetySuggestions: PermissionUpdate[] = skillScope
      ? [
          {
            type: 'addRules',
            rules: [
              {
                toolName: FILE_EDIT_TOOL_NAME,
                ruleContent: skillScope.pattern,
              },
            ],
            behavior: 'allow',
            destination: 'session',
          },
        ]
      : generateSuggestions(path, 'write', toolPermissionContext, pathsToCheck)
    const failedCheck = safetyCheck as {
      safe: false
      message: string
      classifierApprovable: boolean
    }
    return {
      behavior: 'ask',
      message: failedCheck.message,
      suggestions: safetySuggestions,
      decisionReason: {
        type: 'safetyCheck',
        reason: failedCheck.message,
        classifierApprovable: failedCheck.classifierApprovable,
      },
    }
  }

  // 2. 检查询问规则——同时检查原始路径和已解析的符号链接路径
  for (const pathToCheck of pathsToCheck) {
    const askRule = matchingRuleForInput(
      pathToCheck,
      toolPermissionContext,
      'edit',
      'ask',
    )
    if (askRule) {
      return {
        behavior: 'ask',
        message: `Claude requested permissions to write to ${path}, but you haven't granted it yet.`,
        decisionReason: {
          type: 'rule',
          rule: askRule,
        },
      }
    }
  }

  // 3. 如果处于 acceptEdits 或 sandboxBashMode 模式，允许在原始 cwd 中的所有写入
  const isInWorkingDir = pathInAllowedWorkingPath(
    path,
    toolPermissionContext,
    pathsToCheck,
  )
  if (toolPermissionContext.mode === 'acceptEdits' && isInWorkingDir) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'mode',
        mode: toolPermissionContext.mode,
      },
    }
  }

  // 4. 检查允许规则
  const allowRule = matchingRuleForInput(
    path,
    toolPermissionContext,
    'edit',
    'allow',
  )
  if (allowRule) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'rule',
        rule: allowRule,
      },
    }
  }

  // 5. 默认请求权限
  return {
    behavior: 'ask',
    message: `Claude requested permissions to write to ${path}, but you haven't granted it yet.`,
    suggestions: generateSuggestions(
      path,
      'write',
      toolPermissionContext,
      pathsToCheck,
    ),
    decisionReason: !isInWorkingDir
      ? {
          type: 'workingDir',
          reason: 'Path is outside allowed working directories',
        }
      : undefined,
  }
}

export function generateSuggestions(
  filePath: string,
  operationType: 'read' | 'write' | 'create',
  toolPermissionContext: ToolPermissionContext,
  precomputedPathsToCheck?: readonly string[],
): PermissionUpdate[] {
  const isOutsideWorkingDir = !pathInAllowedWorkingPath(
    filePath,
    toolPermissionContext,
    precomputedPathsToCheck,
  )

  if (operationType === 'read' && isOutsideWorkingDir) {
    // 对于工作目录外的读取操作，添加读取规则
    // 重要：同时包含符号链接路径和解析路径，以便后续检查通过
    const dirPath = getDirectoryForPath(filePath)
    const dirsToAdd = getPathsForPermissionCheck(dirPath)

    const suggestions = dirsToAdd
      .map(dir => createReadRuleSuggestion(dir, 'session'))
      .filter((s): s is PermissionUpdate => s !== undefined)

    return suggestions
  }

  // 仅当是升级时才建议 setMode:acceptEdits。在 auto 模式下，
  // 分类器已经自动批准编辑；在 bypassPermissions 下允许一切；
  // 在 acceptEdits 下是空操作。如果仍然建议并让 SDK 主机
  // 在"始终允许"时应用它，会静默降级 auto → acceptEdits，
  // 然后为 MCP/Bash 提示。
  const shouldSuggestAcceptEdits =
    toolPermissionContext.mode === 'default' ||
    toolPermissionContext.mode === 'plan'

  if (operationType === 'write' || operationType === 'create') {
    const updates: PermissionUpdate[] = shouldSuggestAcceptEdits
      ? [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]
      : []

    if (isOutsideWorkingDir) {
      // 对于工作目录外的写入操作，同时添加目录
      // 重要：同时包含符号链接路径和解析路径，以便后续检查通过
      const dirPath = getDirectoryForPath(filePath)
      const dirsToAdd = getPathsForPermissionCheck(dirPath)

      updates.push({
        type: 'addDirectories',
        directories: dirsToAdd,
        destination: 'session',
      })
    }

    return updates
  }

  // 对于工作目录内的读取操作，只需更改模式
  return shouldSuggestAcceptEdits
    ? [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]
    : []
}

/**
 * 检查路径是否为可以无需权限即可编辑的内部路径。
 * 返回 PermissionResult——如果匹配则为 'allow'，否则为 'passthrough' 以继续检查。
 */
export function checkEditableInternalPath(
  absolutePath: string,
  input: { [key: string]: unknown },
): PermissionResult {
  // 安全性：规范化路径以防止通过 .. 段绕过遍历
  // 这是纵深防御；各个辅助函数也会规范化
  const normalizedPath = normalize(absolutePath)

  // 当前会话的计划文件
  if (isSessionPlanFile(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Plan files for current session are allowed for writing',
      },
    }
  }

  // 当前会话的临时文件目录
  if (isScratchpadPath(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Scratchpad files for current session are allowed for writing',
      },
    }
  }

  // 模板任务自身的目录。环境变量键硬编码（而非从 jobs/state 导入
  // JOB_ENV_KEY），以便 tree-shaking 从外部构建中消除此字符串——
  // spawn.test.ts 断言字符串匹配。劫持保护：环境变量值
  // 本身必须在 ~/.hclaude/jobs/ 下可解析。符号链接保护：目标的
  // 每个解析形式（词法 + 符号链接链）必须落在任务目录的某个
  // 解析形式下，这样任务目录内指向例如
  // ~/.ssh/authorized_keys 的符号链接不会获得免费写入权限。
  // 解析双方可以处理 macOS /tmp → /private/tmp 的情况，
  // 其中配置目录位于符号链接根下。
  if (feature('TEMPLATES')) {
    const jobDir = process.env.CLAUDE_JOB_DIR
    if (jobDir) {
      const jobsRoot = join(getClaudeConfigHomeDir(), 'jobs')
      const jobDirForms = getPathsForPermissionCheck(jobDir).map(normalize)
      const jobsRootForms = getPathsForPermissionCheck(jobsRoot).map(normalize)
      // 劫持保护：任务目录的每个解析形式必须位于
      // 任务根的某个解析形式下。解析双方可以处理
      // ~/.hclaude 是符号链接（例如指向 /data/claude-config）的情况。
      const isUnderJobsRoot = jobDirForms.every(jd =>
        jobsRootForms.some(jr => jd.startsWith(jr + sep)),
      )
      if (isUnderJobsRoot) {
        const targetForms = getPathsForPermissionCheck(absolutePath)
        const allInsideJobDir = targetForms.every(p => {
          const np = normalize(p)
          return jobDirForms.some(jd => np === jd || np.startsWith(jd + sep))
        })
        if (allInsideJobDir) {
          return {
            behavior: 'allow',
            updatedInput: input,
            decisionReason: {
              type: 'other',
              reason:
                'Job directory files for current job are allowed for writing',
            },
          }
        }
      }
    }
  }

  // 代理内存目录（用于自我改进的代理）
  if (isAgentMemoryPath(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Agent memory files are allowed for writing',
      },
    }
  }

  // Memdir 目录（用于跨会话学习的持久内存）
  // 此安全检查前的例外存在是因为默认路径在
  // ~/.hclaude/ 下，这是 DANGEROUS_DIRECTORIES 中的。CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
  // 覆盖是任意的调用者指定目录，没有这种冲突，
  // 因此它在此处没有特殊权限处理——写入经过正常
  // 权限流程（步骤 5 → 询问）。想要静默内存的 SDK 调用者
  // 应该传递覆盖路径的允许规则。
  if (!hasAutoMemPathOverride() && isAutoMemPath(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'auto memory files are allowed for writing',
      },
    }
  }

  // .hclaude/launch.json——桌面预览配置（开发服务器命令 + 端口）。
  // 桌面的 preview_start MCP 工具指示 Claude 创建/更新
  // 此文件作为预览工作流的一部分。没有此例外的话，
  // .hclaude/ DANGEROUS_DIRECTORIES 检查会提示它，这在 SDK 模式下
  // 会级联：用户点击"始终允许"→ setMode:acceptEdits 建议
  // 应用→从 auto 模式静默降级。仅匹配项目级
  // .hclaude/（非 ~/.hclaude/），因为 launch.json 是每项目的。
  if (
    normalizeCaseForComparison(normalizedPath) ===
    normalizeCaseForComparison(
      join(getOriginalCwd(), CLAUDE_DIR_NAME, 'launch.json'),
    )
  ) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Preview launch config is allowed for writing',
      },
    }
  }

  return { behavior: 'passthrough', message: '' }
}

/**
 * 检查路径是否为可以无需权限即可读取的内部路径。
 * 返回 PermissionResult——如果匹配则为 'allow'，否则为 'passthrough' 以继续检查。
 */
export function checkReadableInternalPath(
  absolutePath: string,
  input: { [key: string]: unknown },
): PermissionResult {
  // 安全性：规范化路径以防止通过 .. 段绕过遍历
  // 这是纵深防御；各个辅助函数也会规范化
  const normalizedPath = normalize(absolutePath)

  // 会话内存目录
  if (isSessionMemoryPath(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Session memory files are allowed for reading',
      },
    }
  }

  // 项目目录（用于读取过去的会话内存）
  // 路径格式：~/.hclaude/projects/{sanitized-cwd}/...
  if (isProjectDirPath(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Project directory files are allowed for reading',
      },
    }
  }

  // 当前会话的计划文件
  if (isSessionPlanFile(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Plan files for current session are allowed for reading',
      },
    }
  }

  // 工具结果目录（持久化的大型输出）
  // 使用路径分隔符后缀以防止路径遍历（例如 tool-results-evil/）
  const toolResultsDir = getToolResultsDir()
  const toolResultsDirWithSep = toolResultsDir.endsWith(sep)
    ? toolResultsDir
    : toolResultsDir + sep
  if (
    normalizedPath === toolResultsDir ||
    normalizedPath.startsWith(toolResultsDirWithSep)
  ) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Tool result files are allowed for reading',
      },
    }
  }

  // 当前会话的临时文件目录
  if (isScratchpadPath(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Scratchpad files for current session are allowed for reading',
      },
    }
  }

  // 项目临时目录（/tmp/claude/{sanitized-cwd}/）
  // 故意允许读取此项目中所有会话的文件，而不仅是当前会话。
  // 这允许在同一项目的临时空间内进行跨会话文件访问。
  const projectTempDir = getProjectTempDir()
  if (normalizedPath.startsWith(projectTempDir)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Project temp directory files are allowed for reading',
      },
    }
  }

  // 代理内存目录（用于自我改进的代理）
  if (isAgentMemoryPath(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Agent memory files are allowed for reading',
      },
    }
  }

  // Memdir 目录（用于跨会话学习的持久内存）
  if (isAutoMemPath(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'auto memory files are allowed for reading',
      },
    }
  }

  // 任务目录（~/.hclaude/tasks/）用于群体任务协调
  const tasksDir = join(getClaudeConfigHomeDir(), 'tasks') + sep
  if (
    normalizedPath === tasksDir.slice(0, -1) ||
    normalizedPath.startsWith(tasksDir)
  ) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Task files are allowed for reading',
      },
    }
  }

  // 团队目录（~/.hclaude/teams/）用于群体协调
  const teamsReadDir = join(getClaudeConfigHomeDir(), 'teams') + sep
  if (
    normalizedPath === teamsReadDir.slice(0, -1) ||
    normalizedPath.startsWith(teamsReadDir)
  ) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Team files are allowed for reading',
      },
    }
  }

  // 首次调用时提取的捆绑技能参考文件。
  // 安全性：参见 getBundledSkillsRoot()——路径中的每进程 nonce
  // 是承重防御；uid/VERSION 单独是公开知识且可被占用。
  // 我们在调用时总是先写后读，因此此子树下的内容由工具控制。
  const bundledSkillsRoot = getBundledSkillsRoot() + sep
  if (normalizedPath.startsWith(bundledSkillsRoot)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Bundled skill reference files are allowed for reading',
      },
    }
  }

  return { behavior: 'passthrough', message: '' }
}
