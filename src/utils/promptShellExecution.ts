import { randomUUID } from 'crypto'
import type { Tool, ToolUseContext } from '../Tool.js'
import { BashTool } from '@claude-code-best/builtin-tools/tools/BashTool/BashTool.js'
import { logForDebugging } from './debug.js'
import { errorMessage, MalformedCommandError, ShellError } from './errors.js'
import type { FrontmatterShell } from './frontmatterParser.js'
import { createAssistantMessage } from './messages.js'
import { hasPermissionsToUseTool } from './permissions/permissions.js'
import { processToolResultBlock } from './toolResultStorage.js'

// BashTool 和 PowerShellTool 均满足的结构性窄切片。不能使用
// 基础 Tool 类型：它将 call() 的 canUseTool/parentMessage 标记为
// 必需，但两个具体工具都将它们设为可选，且原始代码
// 仅以 2 个参数调用 BashTool.call({ command }, ctx)。也不能使用
// `typeof BashTool`：BashTool 的 input schema 有 PowerShellTool
// 没有的字段（如 _simulatedSedEdit）。
// 注意：call() 在此直接调用，绕过 validateInput — 任何关键
// 校验必须位于 call() 本身（见 PR #23311）。
type ShellOut = { stdout: string; stderr: string; interrupted: boolean }
type PromptShellTool = Tool & {
  call(
    input: { command: string },
    context: ToolUseContext,
  ): Promise<{ data: ShellOut }>
}

import { isPowerShellToolEnabled } from './shell/shellToolUtils.js'

// 惰性：此文件在启动导入链上（main → commands →
// loadSkillsDir → 此文件）。静态导入会在所有平台的启动时
// 加载 PowerShellTool.ts（以及传递的 parser.ts、validators 等），
// 使 tools.ts 的惰性 require 失效。延迟到首个带
// `shell: powershell` 的 skill 实际运行时。
/* eslint-disable @typescript-eslint/no-require-imports */
const getPowerShellTool = (() => {
  let cached: PromptShellTool | undefined
  return (): PromptShellTool => {
    if (!cached) {
      cached = (
        require('@claude-code-best/builtin-tools/tools/PowerShellTool/PowerShellTool.js') as typeof import('@claude-code-best/builtin-tools/tools/PowerShellTool/PowerShellTool.js')
      ).PowerShellTool
    }
    return cached
  }
})()
/* eslint-enable @typescript-eslint/no-require-imports */

// 代码块模式：```! command ```
const BLOCK_PATTERN = /```!\s*\n?([\s\S]*?)\n?```/g

// 行内模式：!`command`
// 使用正向后瞻要求在 ! 前为空白或行首。
// 这防止在 markdown 行内代码块如 `!!` 或相邻块
// 如 `foo`!`bar` 以及 shell 变量如 $! 中产生错误匹配。
// eslint-disable-next-line custom-rules/no-lookbehind-regex -- gated by text.includes('!`') below (PR#22986)
const INLINE_PATTERN = /(?<=^|\s)!`([^`]+)`/gm

/**
 * 解析提示文本并执行任何嵌入的 shell 命令。
 * 支持两种语法：
 * - 代码块：```! command ```
 * - 行内：!`command`
 *
 * @param shell - 路由命令的 shell。默认为 bash。
 *   此值*永不*从 settings.defaultShell 读取 — 它来自 .md
 *   frontmatter（作者选择）或对内置命令为 undefined。
 *   见 docs/design/ps-shell-selection.md §5.3。
 */
export async function executeShellCommandsInPrompt(
  text: string,
  context: ToolUseContext,
  slashCommandName: string,
  shell?: FrontmatterShell,
): Promise<string> {
  let result = text

  // 一次性解析工具。`shell === undefined` 和 `shell === 'bash'` 都
  // 使用 BashTool。仅当运行时门控允许时使用 PowerShell —
  // skill 作者的 frontmatter 选择不覆盖用户的 opt-in/out。
  const shellTool: PromptShellTool =
    shell === 'powershell' && isPowerShellToolEnabled()
      ? getPowerShellTool()
      : BashTool

  // INLINE_PATTERN 的后瞻在大型 skill 内容上比 BLOCK_PATTERN 慢约 100 倍
  // (265µs vs 2µs @ 17KB)。93% 的 skill 根本没有 !`，因此将昂贵的
  // 扫描门控在廉价的子串检查上。BLOCK_PATTERN（```!）不需要
  // 文本中有 !`，因此总是扫描。
  const blockMatches = text.matchAll(BLOCK_PATTERN)
  const inlineMatches = text.includes('!`') ? text.matchAll(INLINE_PATTERN) : []

  await Promise.all(
    [...blockMatches, ...inlineMatches].map(async match => {
      const command = match[1]?.trim()
      if (command) {
        try {
          // 执行前检查权限
          const permissionResult = await hasPermissionsToUseTool(
            shellTool,
            { command },
            context,
            createAssistantMessage({ content: [] }),
            '',
          )

          if (permissionResult.behavior !== 'allow') {
            logForDebugging(
              `Shell command permission check failed for command in ${slashCommandName}: ${command}. Error: ${permissionResult.message}`,
            )
            throw new MalformedCommandError(
              `Shell command permission check failed for pattern "${match[0]}": ${permissionResult.message || 'Permission denied'}`,
            )
          }

          const { data } = await shellTool.call({ command }, context)
          // 复用与常规 Bash 工具调用相同的持久化流程
          const toolResultBlock = await processToolResultBlock(
            shellTool,
            data,
            randomUUID(),
          )
          // 从块中提取字符串内容
          const output =
            typeof toolResultBlock.content === 'string'
              ? toolResultBlock.content
              : formatBashOutput(data.stdout, data.stderr)
          // 函数替换器 — String.replace 在替换字符串中即使使用
          // 字符串搜索模式也会解释 $$、$&、$`、$'。Shell 输出
          //（尤其是 PowerShell：$env:PATH、$$、$PSVersionTable）
          // 是任意用户数据；裸字符串参数会损坏它。
          result = result.replace(match[0], () => output)
        } catch (e) {
          if (e instanceof MalformedCommandError) {
            throw e
          }
          formatBashError(e, match[0])
        }
      }
    }),
  )

  return result
}

function formatBashOutput(
  stdout: string,
  stderr: string,
  inline = false,
): string {
  const parts: string[] = []

  if (stdout.trim()) {
    parts.push(stdout.trim())
  }

  if (stderr.trim()) {
    if (inline) {
      parts.push(`[stderr: ${stderr.trim()}]`)
    } else {
      parts.push(`[stderr]\n${stderr.trim()}`)
    }
  }

  return parts.join(inline ? ' ' : '\n')
}

function formatBashError(e: unknown, pattern: string, inline = false): never {
  if (e instanceof ShellError) {
    if (e.interrupted) {
      throw new MalformedCommandError(
        `Shell command interrupted for pattern "${pattern}": [Command interrupted]`,
      )
    }
    const output = formatBashOutput(e.stdout, e.stderr, inline)
    throw new MalformedCommandError(
      `Shell command failed for pattern "${pattern}": ${output}`,
    )
  }

  const message = errorMessage(e)
  const formatted = inline ? `[Error: ${message}]` : `[Error]\n${message}`
  throw new MalformedCommandError(formatted)
}
