import memoize from 'lodash-es/memoize.js'
import { homedir } from 'os'
import { isAbsolute, join, normalize, sep } from 'path'
import {
  getIsNonInteractiveSession,
  getProjectRoot,
} from '../bootstrap/state.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import {
  getClaudeConfigHomeDir,
  isEnvDefinedFalsy,
  isEnvTruthy,
} from '../utils/envUtils.js'
import { findCanonicalGitRoot } from '../utils/git.js'
import { sanitizePath } from '../utils/path.js'
import {
  getInitialSettings,
  getSettingsForSource,
} from '../utils/settings/settings.js'

/**
 * 是否启用自动记忆功能（memdir、代理记忆、过去会话搜索）。
 * 默认启用。优先级链（首个定义生效）：
 *   1. CLAUDE_CODE_DISABLE_AUTO_MEMORY 环境变量（1/true → 关闭，0/false → 开启）
 *   2. CLAUDE_CODE_SIMPLE (--bare) → 关闭
 *   3. 没有持久存储的 CCR → 关闭（无 CLAUDE_CODE_REMOTE_MEMORY_DIR）
 *   4. settings.json 中的 autoMemoryEnabled（支持项目级选择退出）
 *   5. 默认：启用
 */
export function isAutoMemoryEnabled(): boolean {
  const envVal = process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
  if (isEnvTruthy(envVal)) {
    return false
  }
  if (isEnvDefinedFalsy(envVal)) {
    return true
  }
  // --bare / SIMPLE：prompts.ts 已通过其 SIMPLE 提前返回从系统提示中丢弃了
  // 记忆部分；此门控停止另一半（extractMemories 回合结束分支、autoDream、
  // /remember、/dream、团队同步）。
  if (isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
    return false
  }
  if (
    isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) &&
    !process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR
  ) {
    return false
  }
  const settings = getInitialSettings()
  if (settings.autoMemoryEnabled !== undefined) {
    return settings.autoMemoryEnabled
  }
  return true
}

/**
 * extract-memories 后台代理是否将在本次会话中运行。
 *
 * 主代理的提示始终包含完整的保存指令，无论此门控如何 -
 * 当主代理写入记忆时，后台代理跳过该范围
 * （extractMemories.ts 中的 hasMemoryWritesSince）；当主代理未写入时，
 * 后台代理捕获任何遗漏。
 *
 * 调用者还必须门控 feature('EXTRACT_MEMORIES') - 该检查不能放在此辅助函数内，
 * 因为 feature() 仅当直接用于 `if` 条件时才进行 tree-shake。
 */
export function isExtractModeActive(): boolean {
  if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_passport_quail', false)) {
    return false
  }
  return (
    !getIsNonInteractiveSession() ||
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_slate_thimble', false)
  )
}

/**
 * 返回持久化记忆存储的基础目录。
 * 解析顺序：
 *   1. CLAUDE_CODE_REMOTE_MEMORY_DIR 环境变量（显式覆盖，在 CCR 中设置）
 *   2. ~/.hclaude（默认配置主目录）
 */
export function getMemoryBaseDir(): string {
  if (process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR) {
    return process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR
  }
  return getClaudeConfigHomeDir()
}

const AUTO_MEM_DIRNAME = 'memory'
const AUTO_MEM_ENTRYPOINT_NAME = 'MEMORY.md'

/**
 * 规范化并验证候选自动记忆目录路径。
 *
 * 安全性：拒绝作为读取允许列表根目录会有危险或 normalize() 无法完全解析的路径：
 * - 相对路径（!isAbsolute）："../foo" - 将被解释为相对于 CWD
 * - 根目录/接近根目录（长度 < 3）："/" → 剥离后为 ""；"/a" 太短
 * - Windows 驱动器根（C: 正则）："C:\" → 剥离后为 "C:"
 * - UNC 路径（\\server\share）：网络路径 - 不透明的信任边界
 * - 空字节：可存活 normalize()，可在系统调用中截断
 *
 * 返回带恰好一个尾部分隔符的规范化路径，
 * 或当路径未设置/为空/被拒绝时返回 undefined。
 */
function validateMemoryPath(
  raw: string | undefined,
  expandTilde: boolean,
): string | undefined {
  if (!raw) {
    return undefined
  }
  let candidate = raw
  // Settings.json 路径支持 ~/ 展开（用户友好）。环境变量覆盖不支持
  // （它由 Cowork/SDK 以编程方式设置，应始终传递绝对路径）。裸 "~"、
  // "~/"、"~/."、"~/.." 等不展开 —— 它们会使 isAutoMemPath() 匹配
  // $HOME 或其父级的全部内容（与 "/" 或 "C:\" 同类危险）。
  if (
    expandTilde &&
    (candidate.startsWith('~/') || candidate.startsWith('~\\'))
  ) {
    const rest = candidate.slice(2)
    // 拒绝会展开为 $HOME 或其祖先的琐碎剩余部分。normalize('') = '.'，
    // normalize('.') = '.'，normalize('foo/..') = '.'，normalize('..') = '..'，
    // normalize('foo/../..') = '..'
    const restNorm = normalize(rest || '.')
    if (restNorm === '.' || restNorm === '..') {
      return undefined
    }
    candidate = join(homedir(), rest)
  }
  // normalize() 可能保留尾部分隔符；在精确添加一个之前剥离以匹配
  // getAutoMemPath() 的尾部分隔符约定
  const normalized = normalize(candidate).replace(/[/\\]+$/, '')
  if (
    !isAbsolute(normalized) ||
    normalized.length < 3 ||
    /^[A-Za-z]:$/.test(normalized) ||
    normalized.startsWith('\\\\') ||
    normalized.startsWith('//') ||
    normalized.includes('\0')
  ) {
    return undefined
  }
  return (normalized + sep).normalize('NFC')
}

/**
 * 通过环境变量直接覆盖完整的自动记忆目录路径。
 * 设置后，getAutoMemPath()/getAutoMemEntrypoint() 直接返回此路径，
 * 而非计算 `{base}/projects/{sanitized-cwd}/memory/`。
 *
 * Cowork 使用此功能将记忆重定向到空间作用域的挂载点，
 * 因为每会话的 cwd（包含 VM 进程名称）否则会
 * 为每个会话生成不同的项目键。
 */
function getAutoMemPathOverride(): string | undefined {
  return validateMemoryPath(
    process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE,
    false,
  )
}

/**
 * settings.json 对完整自动记忆目录路径的覆盖。
 * 支持 ~/ 展开以方便用户使用。
 *
 * 安全性：projectSettings（提交到仓库的 .hclaude/settings.json）被有意排除 -
 * 否则恶意仓库可以设置 autoMemoryDirectory: "~/.ssh" 并通过 filesystem.ts
 * 写入豁免（当 isAutoMemPath() 匹配且 hasAutoMemPathOverride() 为 false 时触发）
 * 获得对敏感目录的静默写入权限。这遵循 hasSkipDangerousModePermissionPrompt()
 * 等的相同模式。
 */
function getAutoMemPathSetting(): string | undefined {
  const dir =
    getSettingsForSource('policySettings')?.autoMemoryDirectory ??
    getSettingsForSource('flagSettings')?.autoMemoryDirectory ??
    getSettingsForSource('localSettings')?.autoMemoryDirectory ??
    getSettingsForSource('userSettings')?.autoMemoryDirectory
  return validateMemoryPath(dir, true)
}

/**
 * 检查 CLAUDE_COWORK_MEMORY_PATH_OVERRIDE 是否设置为有效覆盖。
 * 使用此作为信号表明 SDK 调用者已显式选择自动记忆机制 -
 * 例如，当自定义系统提示替换默认提示时，决定是否注入记忆提示。
 */
export function hasAutoMemPathOverride(): boolean {
  return getAutoMemPathOverride() !== undefined
}

/**
 * 返回规范 git 仓库根（如果可用），否则回退到稳定的项目根。
 * 使用 findCanonicalGitRoot 以便同一仓库的所有工作树
 * 共享一个自动记忆目录（anthropics/claude-code#24382）。
 */
function getAutoMemBase(): string {
  return findCanonicalGitRoot(getProjectRoot()) ?? getProjectRoot()
}

/**
 * 返回自动记忆目录路径。
 *
 * 解析顺序：
 *   1. CLAUDE_COWORK_MEMORY_PATH_OVERRIDE 环境变量（完整路径覆盖，Cowork 使用）
 *   2. settings.json 中的 autoMemoryDirectory（仅受信任来源：policy/local/user）
 *   3. <memoryBase>/projects/<sanitized-git-root>/memory/
 *      其中 memoryBase 由 getMemoryBaseDir() 解析
 *
 * 已记忆化：渲染路径调用者（collapseReadSearchGroups → isAutoManagedMemoryFile）
 * 在每次 Messages 重新渲染时的每条工具使用消息触发；每次未命中成本为
 * getSettingsForSource × 4 → parseSettingsFile（realpathSync + readFileSync）。
 * 以 projectRoot 为键，以便在块中间更改其 mock 的测试重新计算；
 * 环境变量 / settings.json / CLAUDE_CONFIG_DIR 在生产中是会话稳定的，
 * 并通过每测试 cache.clear 覆盖。
 */
export const getAutoMemPath = memoize(
  (): string => {
    const override = getAutoMemPathOverride() ?? getAutoMemPathSetting()
    if (override) {
      return override
    }
    const projectsDir = join(getMemoryBaseDir(), 'projects')
    return (
      join(projectsDir, sanitizePath(getAutoMemBase()), AUTO_MEM_DIRNAME) + sep
    ).normalize('NFC')
  },
  () => getProjectRoot(),
)

/**
 * 返回给定日期（默认为今天）的每日日志文件路径。
 * 形状：<autoMemPath>/logs/YYYY/MM/YYYY-MM-DD.md
 *
 * 由助手模式（feature('KAIROS')）使用：代理在工作时追加到以日期命名的
 * 日志文件，而非维护 MEMORY.md 作为实时索引。单独的每晚 /dream 技能
 * 将这些日志提炼为主题文件 + MEMORY.md。
 */
export function getAutoMemDailyLogPath(date: Date = new Date()): string {
  const yyyy = date.getFullYear().toString()
  const mm = (date.getMonth() + 1).toString().padStart(2, '0')
  const dd = date.getDate().toString().padStart(2, '0')
  return join(getAutoMemPath(), 'logs', yyyy, mm, `${yyyy}-${mm}-${dd}.md`)
}

/**
 * 返回自动记忆入口点（自动记忆目录内的 MEMORY.md）。
 * 遵循与 getAutoMemPath() 相同的解析顺序。
 */
export function getAutoMemEntrypoint(): string {
  return join(getAutoMemPath(), AUTO_MEM_ENTRYPOINT_NAME)
}

/**
 * 检查绝对路径是否在自动记忆目录内。
 *
 * 当 CLAUDE_COWORK_MEMORY_PATH_OVERRIDE 设置时，这与环境变量覆盖目录匹配。
 * 注意，此处返回 true 并不表示在这种情况下具有写入权限 - filesystem.ts
 * 写入豁免由 !hasAutoMemPathOverride() 门控（它存在是为了绕过
 * DANGEROUS_DIRECTORIES）。
 *
 * settings.json 的 autoMemoryDirectory 确实获得写入豁免：它是用户从受信任
 * 设置来源做出的明确选择（projectSettings 被排除 - 参见 getAutoMemPathSetting），
 * 且 hasAutoMemPathOverride() 对其保持为 false。
 */
export function isAutoMemPath(absolutePath: string): boolean {
  // 安全性：规范化以防止通过 .. 段绕过路径遍历
  const normalizedPath = normalize(absolutePath)
  return normalizedPath.startsWith(getAutoMemPath())
}
