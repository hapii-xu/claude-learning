import { BASH_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/BashTool/toolName.js'
import { POWERSHELL_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/PowerShellTool/toolName.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../envUtils.js'
import { getPlatform } from '../platform.js'

export const SHELL_TOOL_NAMES: string[] = [BASH_TOOL_NAME, POWERSHELL_TOOL_NAME]

/**
 * PowerShellTool 的运行时门控。仅限 Windows（权限引擎使用 Win32 专属的
 * 路径规范化）。Ant 用户默认启用（通过 env=0 关闭）；
 * 外部用户默认关闭（通过 env=1 开启）。
 *
 * 被 tools.ts（工具列表可见性）、processBashCommand（! 路由）以及
 * promptShellExecution（skill frontmatter 路由）使用，保证所有调用
 * PowerShellTool.call() 的路径都应用一致的门控。
 */
export function isPowerShellToolEnabled(): boolean {
  if (getPlatform() !== 'windows') return false
  return process.env.USER_TYPE === 'ant'
    ? !isEnvDefinedFalsy(process.env.CLAUDE_CODE_USE_POWERSHELL_TOOL)
    : isEnvTruthy(process.env.CLAUDE_CODE_USE_POWERSHELL_TOOL)
}
