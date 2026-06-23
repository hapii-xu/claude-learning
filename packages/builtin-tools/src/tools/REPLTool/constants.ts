import { isEnvDefinedFalsy, isEnvTruthy } from 'src/utils/envUtils.js'
import { AGENT_TOOL_NAME } from '../AgentTool/constants.js'
import { BASH_TOOL_NAME } from '../BashTool/toolName.js'
import { FILE_EDIT_TOOL_NAME } from '../FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '../GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '../GrepTool/prompt.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../NotebookEditTool/constants.js'

export const REPL_TOOL_NAME = 'REPL'

/**
 * REPL 模式在交互式 CLI 中对 ant 用户默认开启（可通过
 * CLAUDE_CODE_REPL=0 关闭）。旧版的 CLAUDE_REPL_MODE=1 也可强制开启。
 *
 * SDK 入口（sdk-ts、sdk-py、sdk-cli）默认不开启——SDK
 * 使用者会脚本化直接调用工具（Bash、Read 等），而 REPL 模式
 * 会隐藏这些工具。USER_TYPE 是构建时的 --define，如果不加判断，
 * ant 原生二进制会对每个 SDK 子进程强制开启 REPL 模式，
 * 忽略调用方传入的环境变量。
 */
export function isReplModeEnabled(): boolean {
  if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_REPL)) return false
  if (isEnvTruthy(process.env.CLAUDE_REPL_MODE)) return true
  return (
    process.env.USER_TYPE === 'ant' &&
    process.env.CLAUDE_CODE_ENTRYPOINT === 'cli'
  )
}

/**
 * 仅在 REPL 模式启用时可通过 REPL 访问的工具。
 * 当 REPL 模式开启时，这些工具对 Claude 的直接调用会被隐藏，
 * 迫使 Claude 使用 REPL 执行批量操作。
 */
export const REPL_ONLY_TOOLS = new Set([
  FILE_READ_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  BASH_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
  AGENT_TOOL_NAME,
])
