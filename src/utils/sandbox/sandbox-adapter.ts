/**
 * Adapter layer that wraps @anthropic-ai/sandbox-runtime with Claude CLI-specific integrations.
 * This file provides the bridge between the external sandbox-runtime package and Claude CLI's
 * settings system, tool integration, and additional features.
 */

import type {
  FsReadRestrictionConfig,
  FsWriteRestrictionConfig,
  IgnoreViolationsConfig,
  NetworkHostPattern,
  NetworkRestrictionConfig,
  SandboxAskCallback,
  SandboxDependencyCheck,
  SandboxRuntimeConfig,
  SandboxViolationEvent,
} from '@anthropic-ai/sandbox-runtime'
import {
  SandboxManager as BaseSandboxManager,
  SandboxRuntimeConfigSchema,
  SandboxViolationStore,
} from '@anthropic-ai/sandbox-runtime'
import { rmSync, statSync } from 'fs'
import { readFile } from 'fs/promises'
import { memoize } from 'lodash-es'
import { join, resolve, sep } from 'path'
import {
  getAdditionalDirectoriesForClaudeMd,
  getCwdState,
  getOriginalCwd,
} from '../../bootstrap/state.js'
import { logForDebugging } from '../debug.js'
import { expandPath } from '../path.js'
import { getPlatform, type Platform } from '../platform.js'
import { settingsChangeDetector } from '../settings/changeDetector.js'
import { SETTING_SOURCES, type SettingSource } from '../settings/constants.js'
import { getManagedSettingsDropInDir } from '../settings/managedPath.js'
import {
  getInitialSettings,
  getSettings_DEPRECATED,
  getSettingsFilePathForSource,
  getSettingsForSource,
  getSettingsRootPathForSource,
  updateSettingsForSource,
} from '../settings/settings.js'
import type { SettingsJson } from '../settings/types.js'

// ============================================================================
// Settings Converter
// ============================================================================

import { BASH_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/BashTool/toolName.js'
import { FILE_EDIT_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/FileReadTool/prompt.js'
import { WEB_FETCH_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/WebFetchTool/prompt.js'
import { errorMessage } from '../errors.js'
import { getClaudeTempDir } from '../permissions/filesystem.js'
import type { PermissionRuleValue } from '../permissions/PermissionRule.js'
import { ripgrepCommand } from '../ripgrep.js'

// 本地副本以避免循环依赖
// （permissions.ts 导入 SandboxManager，bashPermissions.ts 导入 permissions.ts）
function permissionRuleValueFromString(
  ruleString: string,
): PermissionRuleValue {
  const matches = ruleString.match(/^([^(]+)\(([^)]+)\)$/)
  if (!matches) {
    return { toolName: ruleString }
  }
  const toolName = matches[1]
  const ruleContent = matches[2]
  if (!toolName || !ruleContent) {
    return { toolName: ruleString }
  }
  return { toolName, ruleContent }
}

function permissionRuleExtractPrefix(permissionRule: string): string | null {
  const match = permissionRule.match(/^(.+):\*$/)
  return match?.[1] ?? null
}

/**
 * Resolve Claude Code-specific path patterns for sandbox-runtime.
 *
 * Claude Code uses special path prefixes in permission rules:
 * - `//path` → absolute from filesystem root (becomes `/path`)
 * - `/path` → relative to settings file directory (becomes `$SETTINGS_DIR/path`)
 * - `~/path` → passed through (sandbox-runtime handles this)
 * - `./path` or `path` → passed through (sandbox-runtime handles this)
 *
 * This function only handles CC-specific conventions (`//` and `/`).
 * Standard path patterns like `~/` and relative paths are passed through
 * for sandbox-runtime's normalizePathForSandbox to handle.
 *
 * @param pattern The path pattern from a permission rule
 * @param source The settings source this pattern came from (needed to resolve `/path` patterns)
 */
export function resolvePathPatternForSandbox(
  pattern: string,
  source: SettingSource,
): string {
  // Handle // prefix - absolute from root (CC-specific convention)
  if (pattern.startsWith('//')) {
    return pattern.slice(1) // "//.aws/**" → "/.aws/**"
  }

  // Handle / prefix - relative to settings file directory (CC-specific convention)
  // Note: ~/path and relative paths are passed through for sandbox-runtime to handle
  if (pattern.startsWith('/') && !pattern.startsWith('//')) {
    const root = getSettingsRootPathForSource(source)
    // 类似 "/foo/**" 的模式变为 "${root}/foo/**"
    return resolve(root, pattern.slice(1))
  }

  // 其他模式（~/path、./path、path）按原样传递
  // sandbox-runtime 的 normalizePathForSandbox 会处理它们
  return pattern
}

/**
 * 从 sandbox.filesystem.* 设置解析路径（allowWrite、denyWrite 等）。
 *
 * 与权限规则（Edit/Read）不同，这些设置使用标准路径语义：
 * - `/path` → 绝对路径（按书写方式，非 settings 相对路径）
 * - `~/path` → 展开为 home 目录
 * - `./path` 或 `path` → 相对于 settings 文件目录
 * - `//path` → 绝对路径（旧版权限规则语法，为兼容性接受）
 *
 * 修复 #30067：resolvePathPatternForSandbox 将 `/Users/foo/.cargo` 视为
 * settings 相对路径（权限规则约定）。用户合理期望
 * sandbox.filesystem.allowWrite 中的绝对路径能按原样工作。
 *
 * 同时在此处展开 `~`，而非依赖 sandbox-runtime，因为
 * sandbox-runtime 的 getFsWriteConfig() 不对 allowWrite 路径调用
 * normalizePathForSandbox（它只剥离尾部 glob 后缀）。
 */
export function resolveSandboxFilesystemPath(
  pattern: string,
  source: SettingSource,
): string {
  // 旧版权限规则转义：//path → /path。为使用 //Users/foo/.cargo 配置
  // 绕过 #30067 的用户保留兼容性。
  if (pattern.startsWith('//')) return pattern.slice(1)
  return expandPath(pattern, getSettingsRootPathForSource(source))
}

/**
 * 检查是否应仅使用托管的 sandbox 域。
 * 当 policySettings 中 sandbox.network.allowManagedDomainsOnly: true 时为真。
 */
export function shouldAllowManagedSandboxDomainsOnly(): boolean {
  return (
    getSettingsForSource('policySettings')?.sandbox?.network
      ?.allowManagedDomainsOnly === true
  )
}

function shouldAllowManagedReadPathsOnly(): boolean {
  return (
    getSettingsForSource('policySettings')?.sandbox?.filesystem
      ?.allowManagedReadPathsOnly === true
  )
}

/**
 * Convert Claude Code settings format to SandboxRuntimeConfig format
 * (Function exported for testing)
 *
 * @param settings Merged settings (used for sandbox config like network, ripgrep, etc.)
 */
export function convertToSandboxRuntimeConfig(
  settings: SettingsJson,
): SandboxRuntimeConfig {
  const permissions = settings.permissions || {}

  // 从 WebFetch 规则提取网络域
  const allowedDomains: string[] = []
  const deniedDomains: string[] = []

  // 当 allowManagedSandboxDomainsOnly 启用时，仅使用策略设置中的域
  if (shouldAllowManagedSandboxDomainsOnly()) {
    const policySettings = getSettingsForSource('policySettings')
    for (const domain of policySettings?.sandbox?.network?.allowedDomains ||
      []) {
      allowedDomains.push(domain)
    }
    for (const ruleString of policySettings?.permissions?.allow || []) {
      const rule = permissionRuleValueFromString(ruleString)
      if (
        rule.toolName === WEB_FETCH_TOOL_NAME &&
        rule.ruleContent?.startsWith('domain:')
      ) {
        allowedDomains.push(rule.ruleContent.substring('domain:'.length))
      }
    }
  } else {
    for (const domain of settings.sandbox?.network?.allowedDomains || []) {
      allowedDomains.push(domain)
    }
    for (const ruleString of permissions.allow || []) {
      const rule = permissionRuleValueFromString(ruleString)
      if (
        rule.toolName === WEB_FETCH_TOOL_NAME &&
        rule.ruleContent?.startsWith('domain:')
      ) {
        allowedDomains.push(rule.ruleContent.substring('domain:'.length))
      }
    }
  }

  for (const ruleString of permissions.deny || []) {
    const rule = permissionRuleValueFromString(ruleString)
    if (
      rule.toolName === WEB_FETCH_TOOL_NAME &&
      rule.ruleContent?.startsWith('domain:')
    ) {
      deniedDomains.push(rule.ruleContent.substring('domain:'.length))
    }
  }

  // 从 Edit 和 Read 规则提取文件系统路径
  // 始终包含当前目录和 Claude 临时目录作为可写
  // 临时目录用于 Shell.ts 的 cwd 跟踪文件
  const allowWrite: string[] = ['.', getClaudeTempDir()]
  const denyWrite: string[] = []
  const denyRead: string[] = []
  const allowRead: string[] = []

  // 始终拒绝写入 settings.json 文件以防止 sandbox 逃逸
  // 这会阻止原始工作目录（Claude Code 启动位置）中的 settings
  const settingsPaths = SETTING_SOURCES.map(source =>
    getSettingsFilePathForSource(source),
  ).filter((p): p is string => p !== undefined)
  denyWrite.push(...settingsPaths)
  denyWrite.push(getManagedSettingsDropInDir())

  // 若当前工作目录与原始目录不同，也阻止其中的 settings 文件
  // 这处理用户 cd 到不同目录的情况
  const cwd = getCwdState()
  const originalCwd = getOriginalCwd()
  if (cwd !== originalCwd) {
    denyWrite.push(resolve(cwd, '.claude', 'settings.json'))
    denyWrite.push(resolve(cwd, '.claude', 'settings.local.json'))
  }

  // 阻止在原始和当前工作目录中写入 .claude/skills。
  // sandbox-runtime 的 getDangerousDirectories() 保护 .claude/commands 和
  // .claude/agents，但不包括 .claude/skills。Skills 具有相同的权限级别
  // （自动发现、自动加载、完整 Claude 能力），因此需要相同的
  // OS 级 sandbox 保护。
  denyWrite.push(resolve(originalCwd, '.claude', 'skills'))
  if (cwd !== originalCwd) {
    denyWrite.push(resolve(cwd, '.claude', 'skills'))
  }

  // 安全性：Git 的 is_git_directory() 若 cwd 包含 HEAD + objects/ + refs/
  // 则将其视为裸仓库。攻击者植入这些文件（加上含 core.fsmonitor 的 config）
  // 会在 Claude 的无 sandbox git 运行时逃逸 sandbox。
  //
  // 无条件拒绝这些路径使 sandbox-runtime 在不存在的路径挂载 /dev/null，
  // 这会 (a) 在主机上留下 0 字节的 HEAD 存根，(b) 在 bwrap 内破坏
  // `git log HEAD`（"ambiguous argument"）。因此：若文件存在，用 denyWrite
  // （ro-bind 原位挂载，无存根）。若不存在，在 scrubBareGitRepoFiles()
  // 中事后清理 —— 植入的文件在无 sandbox git 运行前就被移除；
  // 在命令内部，git 本身也在 sandbox 中。
  bareGitRepoScrubPaths.length = 0
  const bareGitRepoFiles = ['HEAD', 'objects', 'refs', 'hooks', 'config']
  for (const dir of cwd === originalCwd ? [originalCwd] : [originalCwd, cwd]) {
    for (const gitFile of bareGitRepoFiles) {
      const p = resolve(dir, gitFile)
      try {
        // eslint-disable-next-line custom-rules/no-sync-fs -- refreshConfig() must be sync
        statSync(p)
        denyWrite.push(p)
      } catch {
        bareGitRepoScrubPaths.push(p)
      }
    }
  }

  // 若在 initialize() 期间检测到 git worktree，主仓库路径
  // 已缓存在 worktreeMainRepoPath。worktree 中的 Git 操作需要
  // 对主仓库 .git 目录的写入权限（用于 index.lock 等）。
  // 这在初始化时解析一次（worktree 状态不会在会话中途改变）。
  if (worktreeMainRepoPath && worktreeMainRepoPath !== cwd) {
    allowWrite.push(worktreeMainRepoPath)
  }

  // 包含通过 --add-dir CLI 标志或 /add-dir 命令添加的目录。
  // 这些必须在 allowWrite 中，使 Bash 命令（在 sandbox 内运行）
  // 能访问它们 —— 不仅是文件工具（后者通过 pathInAllowedWorkingPath()
  // 在应用层检查权限）。两个来源：settings 中持久化的，以及
  // bootstrap state 中仅会话作用域的。
  const additionalDirs = new Set([
    ...(settings.permissions?.additionalDirectories || []),
    ...getAdditionalDirectoriesForClaudeMd(),
  ])
  allowWrite.push(...additionalDirs)

  // 遍历每个 settings 来源以正确解析路径
  // 类似 `/foo` 的路径模式相对于 settings 文件目录，
  // 因此需要知道每条规则来自哪个来源
  for (const source of SETTING_SOURCES) {
    const sourceSettings = getSettingsForSource(source)

    // 从权限规则提取文件系统路径
    if (sourceSettings?.permissions) {
      for (const ruleString of sourceSettings.permissions.allow || []) {
        const rule = permissionRuleValueFromString(ruleString)
        if (rule.toolName === FILE_EDIT_TOOL_NAME && rule.ruleContent) {
          allowWrite.push(
            resolvePathPatternForSandbox(rule.ruleContent, source),
          )
        }
      }

      for (const ruleString of sourceSettings.permissions.deny || []) {
        const rule = permissionRuleValueFromString(ruleString)
        if (rule.toolName === FILE_EDIT_TOOL_NAME && rule.ruleContent) {
          denyWrite.push(resolvePathPatternForSandbox(rule.ruleContent, source))
        }
        if (rule.toolName === FILE_READ_TOOL_NAME && rule.ruleContent) {
          denyRead.push(resolvePathPatternForSandbox(rule.ruleContent, source))
        }
      }
    }

    // 从 sandbox.filesystem 设置提取文件系统路径
    // sandbox.filesystem.* 使用标准路径语义（/path = 绝对路径），
    // 而非权限规则约定（/path = settings 相对路径）。#30067
    const fs = sourceSettings?.sandbox?.filesystem
    if (fs) {
      for (const p of fs.allowWrite || []) {
        allowWrite.push(resolveSandboxFilesystemPath(p, source))
      }
      for (const p of fs.denyWrite || []) {
        denyWrite.push(resolveSandboxFilesystemPath(p, source))
      }
      for (const p of fs.denyRead || []) {
        denyRead.push(resolveSandboxFilesystemPath(p, source))
      }
      if (!shouldAllowManagedReadPathsOnly() || source === 'policySettings') {
        for (const p of fs.allowRead || []) {
          allowRead.push(resolveSandboxFilesystemPath(p, source))
        }
      }
    }
  }
  // sandbox 的 Ripgrep 配置。用户设置优先；否则传入我们的 rg。
  // 在嵌入模式（argv0='rg' 派发）下，sandbox-runtime 启动时设置 argv0。
  const { rgPath, rgArgs, argv0 } = ripgrepCommand()
  const ripgrepConfig = settings.sandbox?.ripgrep ?? {
    command: rgPath,
    args: rgArgs,
    argv0,
  }

  return {
    network: {
      allowedDomains,
      deniedDomains,
      allowUnixSockets: settings.sandbox?.network?.allowUnixSockets,
      allowAllUnixSockets: settings.sandbox?.network?.allowAllUnixSockets,
      allowLocalBinding: settings.sandbox?.network?.allowLocalBinding,
      httpProxyPort: settings.sandbox?.network?.httpProxyPort,
      socksProxyPort: settings.sandbox?.network?.socksProxyPort,
    },
    filesystem: {
      denyRead,
      allowRead,
      allowWrite,
      denyWrite,
    },
    ignoreViolations: settings.sandbox?.ignoreViolations,
    enableWeakerNestedSandbox: settings.sandbox?.enableWeakerNestedSandbox,
    enableWeakerNetworkIsolation:
      settings.sandbox?.enableWeakerNetworkIsolation,
    ripgrep: ripgrepConfig,
  }
}

// ============================================================================
// Claude CLI-specific state
// ============================================================================

let initializationPromise: Promise<void> | undefined
let settingsSubscriptionCleanup: (() => void) | undefined

// git worktree 的主仓库路径缓存，在 initialize() 期间解析一次。
// 在 worktree 中，.git 是一个文件，内容为 "gitdir: /path/to/main/repo/.git/worktrees/name"。
// undefined = 尚未解析；null = 不是 worktree 或检测失败。
let worktreeMainRepoPath: string | null | undefined

// cwd 中在配置时不存在的裸仓库文件，若沙箱命令后出现则应被清理。
// 参见 anthropics/claude-code#29316。
const bareGitRepoScrubPaths: string[] = []

/**
 * 删除在沙箱命令期间植入 cwd 的裸仓库文件，
 * 在 Claude 的无沙箱 git 调用看到它们之前执行。
 * 参见上方 bareGitRepoFiles 的 SECURITY 块。anthropics/claude-code#29316。
 */
function scrubBareGitRepoFiles(): void {
  for (const p of bareGitRepoScrubPaths) {
    try {
      // eslint-disable-next-line custom-rules/no-sync-fs -- cleanupAfterCommand must be sync (Shell.ts:367)
      rmSync(p, { recursive: true })
      logForDebugging(`[Sandbox] scrubbed planted bare-repo file: ${p}`)
    } catch {
      // ENOENT 是预期的常见情况 —— 未被植入任何文件
    }
  }
}

/**
 * 检测 cwd 是否为 git worktree 并解析主仓库路径。
 * 在 initialize() 期间调用一次并缓存整个会话。
 * 在 worktree 中，.git 是一个文件（非目录），内容含 "gitdir: ..."。
 * 若 .git 是目录，readFile 抛出 EISDIR，返回 null。
 */
async function detectWorktreeMainRepoPath(cwd: string): Promise<string | null> {
  const gitPath = join(cwd, '.git')
  try {
    const gitContent = await readFile(gitPath, { encoding: 'utf8' })
    const gitdirMatch = gitContent.match(/^gitdir:\s*(.+)$/m)
    if (!gitdirMatch?.[1]) {
      return null
    }
    // gitdir 可能是相对路径（罕见，但 git 接受）—— 相对于 cwd 解析
    const gitdir = resolve(cwd, gitdirMatch[1].trim())
    // gitdir 格式：/path/to/main/repo/.git/worktrees/worktree-name
    // 专门匹配 /.git/worktrees/ 段 —— 仅 indexOf('.git') 会
    // 误匹配类似 /home/user/.github-projects/... 的路径
    const marker = `${sep}.git${sep}worktrees${sep}`
    const markerIndex = gitdir.lastIndexOf(marker)
    if (markerIndex > 0) {
      return gitdir.substring(0, markerIndex)
    }
    return null
  } catch {
    // 不在 worktree 中，或 .git 是目录（EISDIR），或无法读取 .git 文件
    return null
  }
}

/**
 * Check if dependencies are available (memoized)
 * Returns { errors, warnings } - errors mean sandbox cannot run
 */
const checkDependencies = memoize((): SandboxDependencyCheck => {
  const { rgPath, rgArgs } = ripgrepCommand()
  return BaseSandboxManager.checkDependencies({
    command: rgPath,
    args: rgArgs,
  })
})

function getSandboxEnabledSetting(): boolean {
  try {
    const settings = getSettings_DEPRECATED()
    return settings?.sandbox?.enabled ?? false
  } catch (error) {
    logForDebugging(`Failed to get settings for sandbox check: ${error}`)
    return false
  }
}

function isAutoAllowBashIfSandboxedEnabled(): boolean {
  const settings = getSettings_DEPRECATED()
  return settings?.sandbox?.autoAllowBashIfSandboxed ?? true
}

function areUnsandboxedCommandsAllowed(): boolean {
  const settings = getSettings_DEPRECATED()
  return settings?.sandbox?.allowUnsandboxedCommands ?? true
}

function isSandboxRequired(): boolean {
  const settings = getSettings_DEPRECATED()
  return (
    getSandboxEnabledSetting() &&
    (settings?.sandbox?.failIfUnavailable ?? false)
  )
}

/**
 * Check if the current platform is supported for sandboxing (memoized)
 * Supports: macOS, Linux, and WSL2+ (WSL1 is not supported)
 */
const isSupportedPlatform = memoize((): boolean => {
  return BaseSandboxManager.isSupportedPlatform()
})

/**
 * Check if the current platform is in the enabledPlatforms list.
 *
 * This is an undocumented setting that allows restricting sandbox to specific platforms.
 * When enabledPlatforms is not set, all supported platforms are allowed.
 *
 * Added to unblock NVIDIA enterprise rollout: they want to enable autoAllowBashIfSandboxed
 * but only on macOS initially, since Linux/WSL sandbox support is newer. This allows
 * setting enabledPlatforms: ["macos"] to disable sandbox (and auto-allow) on other platforms.
 */
function isPlatformInEnabledList(): boolean {
  try {
    const settings = getInitialSettings()
    const enabledPlatforms = (
      settings?.sandbox as { enabledPlatforms?: Platform[] } | undefined
    )?.enabledPlatforms

    if (enabledPlatforms === undefined) {
      return true
    }

    if (enabledPlatforms.length === 0) {
      return false
    }

    const currentPlatform = getPlatform()
    return enabledPlatforms.includes(currentPlatform)
  } catch (error) {
    logForDebugging(`Failed to check enabledPlatforms: ${error}`)
    return true // Default to enabled if we can't read settings
  }
}

/**
 * Check if sandboxing is enabled
 * This checks the user's enabled setting, platform support, and enabledPlatforms restriction
 */
function isSandboxingEnabled(): boolean {
  if (!isSupportedPlatform()) {
    return false
  }

  if (checkDependencies().errors.length > 0) {
    return false
  }

  // Check if current platform is in the enabledPlatforms list (undocumented setting)
  if (!isPlatformInEnabledList()) {
    return false
  }

  return getSandboxEnabledSetting()
}

/**
 * If the user explicitly enabled sandbox (sandbox.enabled: true in settings)
 * but it cannot actually run, return a human-readable reason. Otherwise
 * return undefined.
 *
 * Fix for #34044: previously isSandboxingEnabled() silently returned false
 * when dependencies were missing, giving users zero feedback that their
 * explicit security setting was being ignored. This is a security footgun —
 * users configure allowedDomains expecting enforcement, get none.
 *
 * Call this once at startup (REPL/print) and surface the reason if present.
 * Does not cover the case where the user never enabled sandbox (no noise).
 */
function getSandboxUnavailableReason(): string | undefined {
  // Only warn if user explicitly asked for sandbox. If they didn't enable
  // it, missing deps are irrelevant.
  if (!getSandboxEnabledSetting()) {
    return undefined
  }

  if (!isSupportedPlatform()) {
    const platform = getPlatform()
    if (platform === 'wsl') {
      return 'sandbox.enabled is set but WSL1 is not supported (requires WSL2)'
    }
    return `sandbox.enabled is set but ${platform} is not supported (requires macOS, Linux, or WSL2)`
  }

  if (!isPlatformInEnabledList()) {
    return `sandbox.enabled is set but ${getPlatform()} is not in sandbox.enabledPlatforms`
  }

  const deps = checkDependencies()
  if (deps.errors.length > 0) {
    const platform = getPlatform()
    const hint =
      platform === 'macos'
        ? 'run /sandbox or /doctor for details'
        : 'install missing tools (e.g. apt install bubblewrap socat) or run /sandbox for details'
    return `sandbox.enabled is set but dependencies are missing: ${deps.errors.join(', ')} · ${hint}`
  }

  return undefined
}

/**
 * Get glob patterns that won't work fully on Linux/WSL
 */
function getLinuxGlobPatternWarnings(): string[] {
  // Only return warnings on Linux/WSL (bubblewrap doesn't support globs)
  const platform = getPlatform()
  if (platform !== 'linux' && platform !== 'wsl') {
    return []
  }

  try {
    const settings = getSettings_DEPRECATED()

    // Only return warnings when sandboxing is enabled (check settings directly, not cached value)
    if (!settings?.sandbox?.enabled) {
      return []
    }

    const permissions = settings?.permissions || {}
    const warnings: string[] = []

    // Helper to check if a path has glob characters (excluding trailing /**)
    const hasGlobs = (path: string): boolean => {
      const stripped = path.replace(/\/\*\*$/, '')
      return /[*?[\]]/.test(stripped)
    }

    // Check all permission rules
    for (const ruleString of [
      ...(permissions.allow || []),
      ...(permissions.deny || []),
    ]) {
      const rule = permissionRuleValueFromString(ruleString)
      if (
        (rule.toolName === FILE_EDIT_TOOL_NAME ||
          rule.toolName === FILE_READ_TOOL_NAME) &&
        rule.ruleContent &&
        hasGlobs(rule.ruleContent)
      ) {
        warnings.push(ruleString)
      }
    }

    return warnings
  } catch (error) {
    logForDebugging(`Failed to get Linux glob pattern warnings: ${error}`)
    return []
  }
}

/**
 * Check if sandbox settings are locked by policy
 */
function areSandboxSettingsLockedByPolicy(): boolean {
  // Check if sandbox settings are explicitly set in any source that overrides localSettings
  // These sources have higher priority than localSettings and would make local changes ineffective
  const overridingSources = ['flagSettings', 'policySettings'] as const

  for (const source of overridingSources) {
    const settings = getSettingsForSource(source)
    if (
      settings?.sandbox?.enabled !== undefined ||
      settings?.sandbox?.autoAllowBashIfSandboxed !== undefined ||
      settings?.sandbox?.allowUnsandboxedCommands !== undefined
    ) {
      return true
    }
  }

  return false
}

/**
 * Set sandbox settings
 */
async function setSandboxSettings(options: {
  enabled?: boolean
  autoAllowBashIfSandboxed?: boolean
  allowUnsandboxedCommands?: boolean
}): Promise<void> {
  const existingSettings = getSettingsForSource('localSettings')

  // Note: Memoized caches auto-invalidate when settings change because they use
  // the settings object as the cache key (new settings object = cache miss)

  updateSettingsForSource('localSettings', {
    sandbox: {
      ...existingSettings?.sandbox,
      ...(options.enabled !== undefined && { enabled: options.enabled }),
      ...(options.autoAllowBashIfSandboxed !== undefined && {
        autoAllowBashIfSandboxed: options.autoAllowBashIfSandboxed,
      }),
      ...(options.allowUnsandboxedCommands !== undefined && {
        allowUnsandboxedCommands: options.allowUnsandboxedCommands,
      }),
    },
  })
}

/**
 * Get excluded commands (commands that should not be sandboxed)
 */
function getExcludedCommands(): string[] {
  const settings = getSettings_DEPRECATED()
  return settings?.sandbox?.excludedCommands ?? []
}

/**
 * Wrap command with sandbox, optionally specifying the shell to use
 */
async function wrapWithSandbox(
  command: string,
  binShell?: string,
  customConfig?: Partial<SandboxRuntimeConfig>,
  abortSignal?: AbortSignal,
): Promise<string> {
  // If sandboxing is enabled, ensure initialization is complete
  if (isSandboxingEnabled()) {
    if (initializationPromise) {
      await initializationPromise
    } else {
      throw new Error('Sandbox failed to initialize. ')
    }
  }

  return BaseSandboxManager.wrapWithSandbox(
    command,
    binShell,
    customConfig,
    abortSignal,
  )
}

/**
 * Initialize sandbox with log monitoring enabled by default
 */
async function initialize(
  sandboxAskCallback?: SandboxAskCallback,
): Promise<void> {
  // If already initializing or initialized, return the promise
  if (initializationPromise) {
    return initializationPromise
  }

  // Check if sandboxing is enabled in settings
  if (!isSandboxingEnabled()) {
    return
  }

  // Wrap the callback to enforce allowManagedDomainsOnly policy.
  // This ensures all code paths (REPL, print/SDK) are covered.
  const wrappedCallback: SandboxAskCallback | undefined = sandboxAskCallback
    ? async (hostPattern: NetworkHostPattern) => {
        if (shouldAllowManagedSandboxDomainsOnly()) {
          logForDebugging(
            `[sandbox] Blocked network request to ${hostPattern.host} (allowManagedDomainsOnly)`,
          )
          return false
        }
        return sandboxAskCallback(hostPattern)
      }
    : undefined

  // Create the initialization promise synchronously (before any await) to prevent
  // race conditions where wrapWithSandbox() is called before the promise is assigned.
  initializationPromise = (async () => {
    try {
      // Resolve worktree main repo path once before building config.
      // Worktree status doesn't change mid-session, so this is cached for all
      // subsequent refreshConfig() calls (which must be synchronous to avoid
      // race conditions where pending requests slip through with stale config).
      if (worktreeMainRepoPath === undefined) {
        worktreeMainRepoPath = await detectWorktreeMainRepoPath(getCwdState())
      }

      const settings = getSettings_DEPRECATED()
      const runtimeConfig = convertToSandboxRuntimeConfig(settings)

      // Log monitor is automatically enabled for macOS
      await BaseSandboxManager.initialize(runtimeConfig, wrappedCallback)

      // Subscribe to settings changes to update sandbox config dynamically
      settingsSubscriptionCleanup = settingsChangeDetector.subscribe(() => {
        const settings = getSettings_DEPRECATED()
        const newConfig = convertToSandboxRuntimeConfig(settings)
        BaseSandboxManager.updateConfig(newConfig)
        logForDebugging('Sandbox configuration updated from settings change')
      })
    } catch (error) {
      // Clear the promise on error so initialization can be retried
      initializationPromise = undefined

      // Log error but don't throw - let sandboxing fail gracefully
      logForDebugging(`Failed to initialize sandbox: ${errorMessage(error)}`)
    }
  })()

  return initializationPromise
}

/**
 * Refresh sandbox config from current settings immediately
 * Call this after updating permissions to avoid race conditions
 */
function refreshConfig(): void {
  if (!isSandboxingEnabled()) return
  const settings = getSettings_DEPRECATED()
  const newConfig = convertToSandboxRuntimeConfig(settings)
  BaseSandboxManager.updateConfig(newConfig)
}

/**
 * Reset sandbox state and clear memoized values
 */
async function reset(): Promise<void> {
  // Clean up settings subscription
  settingsSubscriptionCleanup?.()
  settingsSubscriptionCleanup = undefined
  worktreeMainRepoPath = undefined
  bareGitRepoScrubPaths.length = 0

  // Clear memoized caches
  checkDependencies.cache.clear?.()
  isSupportedPlatform.cache.clear?.()
  initializationPromise = undefined

  // Reset the base sandbox manager
  return BaseSandboxManager.reset()
}

/**
 * Add a command to the excluded commands list (commands that should not be sandboxed)
 * This is a Claude CLI-specific function that updates local settings.
 */
export function addToExcludedCommands(
  command: string,
  permissionUpdates?: Array<{
    type: string
    rules: Array<{ toolName: string; ruleContent?: string }>
  }>,
): string {
  const existingSettings = getSettingsForSource('localSettings')
  const existingExcludedCommands =
    existingSettings?.sandbox?.excludedCommands || []

  // Determine the command pattern to add
  // If there are suggestions with Bash rules, extract the pattern (e.g., "npm run test" from "npm run test:*")
  // Otherwise use the exact command
  let commandPattern: string = command

  if (permissionUpdates) {
    const bashSuggestions = permissionUpdates.filter(
      update =>
        update.type === 'addRules' &&
        update.rules.some(rule => rule.toolName === BASH_TOOL_NAME),
    )

    if (bashSuggestions.length > 0 && bashSuggestions[0]!.type === 'addRules') {
      const firstBashRule = bashSuggestions[0]!.rules.find(
        rule => rule.toolName === BASH_TOOL_NAME,
      )
      if (firstBashRule?.ruleContent) {
        // Extract pattern from Bash(command) or Bash(command:*) format
        const prefix = permissionRuleExtractPrefix(firstBashRule.ruleContent)
        commandPattern = prefix || firstBashRule.ruleContent
      }
    }
  }

  // Add to excludedCommands if not already present
  if (!existingExcludedCommands.includes(commandPattern)) {
    updateSettingsForSource('localSettings', {
      sandbox: {
        ...existingSettings?.sandbox,
        excludedCommands: [...existingExcludedCommands, commandPattern],
      },
    })
  }

  return commandPattern
}

// ============================================================================
// Export interface and implementation
// ============================================================================

export interface ISandboxManager {
  initialize(sandboxAskCallback?: SandboxAskCallback): Promise<void>
  isSupportedPlatform(): boolean
  isPlatformInEnabledList(): boolean
  getSandboxUnavailableReason(): string | undefined
  isSandboxingEnabled(): boolean
  isSandboxEnabledInSettings(): boolean
  checkDependencies(): SandboxDependencyCheck
  isAutoAllowBashIfSandboxedEnabled(): boolean
  areUnsandboxedCommandsAllowed(): boolean
  isSandboxRequired(): boolean
  areSandboxSettingsLockedByPolicy(): boolean
  setSandboxSettings(options: {
    enabled?: boolean
    autoAllowBashIfSandboxed?: boolean
    allowUnsandboxedCommands?: boolean
  }): Promise<void>
  getFsReadConfig(): FsReadRestrictionConfig
  getFsWriteConfig(): FsWriteRestrictionConfig
  getNetworkRestrictionConfig(): NetworkRestrictionConfig
  getAllowUnixSockets(): string[] | undefined
  getAllowLocalBinding(): boolean | undefined
  getIgnoreViolations(): IgnoreViolationsConfig | undefined
  getEnableWeakerNestedSandbox(): boolean | undefined
  getExcludedCommands(): string[]
  getProxyPort(): number | undefined
  getSocksProxyPort(): number | undefined
  getLinuxHttpSocketPath(): string | undefined
  getLinuxSocksSocketPath(): string | undefined
  waitForNetworkInitialization(): Promise<boolean>
  wrapWithSandbox(
    command: string,
    binShell?: string,
    customConfig?: Partial<SandboxRuntimeConfig>,
    abortSignal?: AbortSignal,
  ): Promise<string>
  cleanupAfterCommand(): void
  getSandboxViolationStore(): SandboxViolationStore
  annotateStderrWithSandboxFailures(command: string, stderr: string): string
  getLinuxGlobPatternWarnings(): string[]
  refreshConfig(): void
  reset(): Promise<void>
}

/**
 * Claude CLI sandbox manager - wraps sandbox-runtime with Claude-specific features
 */
export const SandboxManager: ISandboxManager = {
  // Custom implementations
  initialize,
  isSandboxingEnabled,
  isSandboxEnabledInSettings: getSandboxEnabledSetting,
  isPlatformInEnabledList,
  getSandboxUnavailableReason,
  isAutoAllowBashIfSandboxedEnabled,
  areUnsandboxedCommandsAllowed,
  isSandboxRequired,
  areSandboxSettingsLockedByPolicy,
  setSandboxSettings,
  getExcludedCommands,
  wrapWithSandbox,
  refreshConfig,
  reset,
  checkDependencies,

  // Forward to base sandbox manager
  getFsReadConfig: BaseSandboxManager.getFsReadConfig,
  getFsWriteConfig: BaseSandboxManager.getFsWriteConfig,
  getNetworkRestrictionConfig: BaseSandboxManager.getNetworkRestrictionConfig,
  getIgnoreViolations: BaseSandboxManager.getIgnoreViolations,
  getLinuxGlobPatternWarnings,
  isSupportedPlatform,
  getAllowUnixSockets: BaseSandboxManager.getAllowUnixSockets,
  getAllowLocalBinding: BaseSandboxManager.getAllowLocalBinding,
  getEnableWeakerNestedSandbox: BaseSandboxManager.getEnableWeakerNestedSandbox,
  getProxyPort: BaseSandboxManager.getProxyPort,
  getSocksProxyPort: BaseSandboxManager.getSocksProxyPort,
  getLinuxHttpSocketPath: BaseSandboxManager.getLinuxHttpSocketPath,
  getLinuxSocksSocketPath: BaseSandboxManager.getLinuxSocksSocketPath,
  waitForNetworkInitialization: BaseSandboxManager.waitForNetworkInitialization,
  getSandboxViolationStore: BaseSandboxManager.getSandboxViolationStore,
  annotateStderrWithSandboxFailures:
    BaseSandboxManager.annotateStderrWithSandboxFailures,
  cleanupAfterCommand: (): void => {
    BaseSandboxManager.cleanupAfterCommand()
    scrubBareGitRepoFiles()
  },
}

// ============================================================================
// Re-export types from sandbox-runtime
// ============================================================================

export type {
  SandboxAskCallback,
  SandboxDependencyCheck,
  FsReadRestrictionConfig,
  FsWriteRestrictionConfig,
  NetworkRestrictionConfig,
  NetworkHostPattern,
  SandboxViolationEvent,
  SandboxRuntimeConfig,
  IgnoreViolationsConfig,
}

export { SandboxViolationStore, SandboxRuntimeConfigSchema }
