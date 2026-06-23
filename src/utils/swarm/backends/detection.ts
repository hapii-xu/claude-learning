import { env } from '../../../utils/env.js'
import { execFileNoThrow } from '../../../utils/execFileNoThrow.js'
import { TMUX_COMMAND } from '../constants.js'

/**
 * 在模块加载时捕获，用于检测用户是否从 tmux 内部启动了 Claude。
 * Shell.ts 可能在后续覆盖 TMUX 环境变量，因此我们在此处捕获原始值。
 */
// eslint-disable-next-line custom-rules/no-process-env-top-level
const ORIGINAL_USER_TMUX = process.env.TMUX

/**
 * 在模块加载时捕获，用于获取 leader 的 tmux pane ID。
 * TMUX_PANE 由 tmux 设置（例如 %0、%1），表示进程所在的 pane ID。
 * 我们在启动时捕获此值，以便始终知道 leader 的原始 pane，
 * 即使用户后续切换到其他 pane 也不受影响。
 */
// eslint-disable-next-line custom-rules/no-process-env-top-level
const ORIGINAL_TMUX_PANE = process.env.TMUX_PANE

/** isInsideTmux 的缓存结果 */
let isInsideTmuxCached: boolean | null = null

/** isInITerm2 的缓存结果 */
let isInITerm2Cached: boolean | null = null

/** isInWindowsTerminal 的缓存结果 */
let isInWindowsTerminalCached: boolean | null = null

/**
 * 检查当前是否正在 tmux 会话中运行（同步版本）。
 * 使用模块加载时捕获的原始 TMUX 值，而非 process.env.TMUX，
 * 因为 Shell.ts 在初始化 Claude socket 时会覆盖 TMUX。
 *
 * 重要：我们仅检查 TMUX 环境变量，不使用 `tmux display-message`
 * 作为备选方案，因为如果系统上运行了任何 tmux 服务器，该命令都会成功，
 * 而不仅仅是当前进程是否在 tmux 内部。
 */
export function isInsideTmuxSync(): boolean {
  return !!ORIGINAL_USER_TMUX
}

/**
 * 检查当前是否正在 tmux 会话中运行。
 * 使用模块加载时捕获的原始 TMUX 值，而非 process.env.TMUX，
 * 因为 Shell.ts 在初始化 Claude socket 时会覆盖 TMUX。
 * 结果会被缓存，因为在进程生命周期内不会变化。
 *
 * 重要：我们仅检查 TMUX 环境变量，不使用 `tmux display-message`
 * 作为备选方案，因为如果系统上运行了任何 tmux 服务器，该命令都会成功，
 * 而不仅仅是当前进程是否在 tmux 内部。
 */
export async function isInsideTmux(): Promise<boolean> {
  if (isInsideTmuxCached !== null) {
    return isInsideTmuxCached
  }

  // 检查原始的 TMUX 环境变量（在模块加载时捕获）
  // 这告诉我们用户是否从 tmux 会话中启动了 Claude
  // 如果 TMUX 未设置，我们就不在 tmux 内部——就这么简单
  isInsideTmuxCached = !!ORIGINAL_USER_TMUX
  return isInsideTmuxCached
}

/**
 * 获取模块加载时捕获的 leader tmux pane ID。
 * 如果未在 tmux 中运行则返回 null。
 */
export function getLeaderPaneId(): string | null {
  return ORIGINAL_TMUX_PANE || null
}

/**
 * 检查系统上是否可用 tmux（已安装且在 PATH 中）。
 */
export async function isTmuxAvailable(): Promise<boolean> {
  const result = await execFileNoThrow(TMUX_COMMAND, ['-V'])
  return result.code === 0
}

/**
 * 检查 wt.exe 是否可用，但不执行它。
 * 不要运行 `wt.exe --version` —— wt.exe 是一个 UWP 应用桥接程序，
 * 会打开 Windows Terminal GUI 来渲染版本信息，导致每次检查可用性时
 * 都会出现一个幽灵般的"Windows 终端 1.24.x"窗口。
 */
export async function isWindowsTerminalAvailable(): Promise<boolean> {
  if (process.env.WT_SESSION) {
    return true
  }
  const result = await execFileNoThrow('where.exe', ['wt.exe'])
  return result.code === 0
}

/**
 * 检查当前是否正在 iTerm2 中运行。
 * 使用多种检测方法：
 * 1. TERM_PROGRAM 环境变量设置为 "iTerm.app"
 * 2. ITERM_SESSION_ID 环境变量存在
 * 3. utils/env.ts 中的 env.terminal 检测
 *
 * 结果会被缓存，因为在进程生命周期内不会变化。
 *
 * 注意：iTerm2 backend 使用 AppleScript (osascript)，这是 macOS 内置的，
 * 因此不需要安装外部 CLI 工具。
 */
export function isInITerm2(): boolean {
  if (isInITerm2Cached !== null) {
    return isInITerm2Cached
  }

  // 检查 iTerm2 的多个指标
  const termProgram = process.env.TERM_PROGRAM
  const hasItermSessionId = !!process.env.ITERM_SESSION_ID
  const terminalIsITerm = env.terminal === 'iTerm.app'

  isInITerm2Cached =
    termProgram === 'iTerm.app' || hasItermSessionId || terminalIsITerm

  return isInITerm2Cached
}

/**
 * 检查当前是否正在 Windows Terminal 中运行。
 * Windows Terminal 会为子进程设置 WT_SESSION。
 */
export function isInWindowsTerminal(): boolean {
  if (isInWindowsTerminalCached !== null) {
    return isInWindowsTerminalCached
  }
  isInWindowsTerminalCached = !!process.env.WT_SESSION
  return isInWindowsTerminalCached
}

/**
 * it2 CLI 命令名称。
 */
export const IT2_COMMAND = 'it2'

/**
 * 检查 it2 CLI 工具是否可用并且可以访问 iTerm2 Python API。
 * 使用 'session list'（而非 '--version'），因为即使 iTerm2 偏好设置中
 * 禁用了 Python API，--version 也会成功——这会导致后续
 * 'session split' 失败且没有备选方案。
 */
export async function isIt2CliAvailable(): Promise<boolean> {
  const result = await execFileNoThrow(IT2_COMMAND, ['session', 'list'])
  return result.code === 0
}

/**
 * 重置所有缓存的检测结果。用于测试。
 */
export function resetDetectionCache(): void {
  isInsideTmuxCached = null
  isInITerm2Cached = null
  isInWindowsTerminalCached = null
}
