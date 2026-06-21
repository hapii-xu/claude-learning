/**
 * 为精简输出模式转换 SDK 消息。
 *
 * 精简模式是一种紧凑的输出格式：
 * - 保持文本消息不变
 * - 用累积计数摘要工具调用（文本出现时重置）
 * - 省略思考内容
 * - 从 init 消息中剥离工具列表和模型信息
 */

import type { SDKAssistantMessage } from 'src/entrypoints/agentSdkTypes.js'
import type { StdoutMessage } from 'src/entrypoints/sdk/controlTypes.js'
import { FILE_EDIT_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/GrepTool/prompt.js'
import { LIST_MCP_RESOURCES_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/ListMcpResourcesTool/prompt.js'
import { LSP_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/LSPTool/prompt.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/NotebookEditTool/constants.js'
import { TASK_STOP_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/TaskStopTool/prompt.js'
import { WEB_SEARCH_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/WebSearchTool/prompt.js'
import { extractTextContent } from 'src/utils/messages.js'
import { SHELL_TOOL_NAMES } from 'src/utils/shell/shellToolUtils.js'
import { capitalize } from 'src/utils/stringUtils.js'

type ToolCounts = {
  searches: number
  reads: number
  writes: number
  commands: number
  other: number
}

/**
 * 用于摘要的工具分类。
 */
const SEARCH_TOOLS = [
  GREP_TOOL_NAME,
  GLOB_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  LSP_TOOL_NAME,
]
const READ_TOOLS = [FILE_READ_TOOL_NAME, LIST_MCP_RESOURCES_TOOL_NAME]
const WRITE_TOOLS = [
  FILE_WRITE_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
]
const COMMAND_TOOLS = [...SHELL_TOOL_NAMES, 'Tmux', TASK_STOP_TOOL_NAME]

function categorizeToolName(toolName: string): keyof ToolCounts {
  if (SEARCH_TOOLS.some(t => toolName.startsWith(t))) return 'searches'
  if (READ_TOOLS.some(t => toolName.startsWith(t))) return 'reads'
  if (WRITE_TOOLS.some(t => toolName.startsWith(t))) return 'writes'
  if (COMMAND_TOOLS.some(t => toolName.startsWith(t))) return 'commands'
  return 'other'
}

function createEmptyToolCounts(): ToolCounts {
  return {
    searches: 0,
    reads: 0,
    writes: 0,
    commands: 0,
    other: 0,
  }
}

/**
 * 为工具计数生成摘要文本。
 */
function getToolSummaryText(counts: ToolCounts): string | undefined {
  const parts: string[] = []

  // 使用与 collapseReadSearch.ts 类似的措辞
  if (counts.searches > 0) {
    parts.push(
      `searched ${counts.searches} ${counts.searches === 1 ? 'pattern' : 'patterns'}`,
    )
  }
  if (counts.reads > 0) {
    parts.push(`read ${counts.reads} ${counts.reads === 1 ? 'file' : 'files'}`)
  }
  if (counts.writes > 0) {
    parts.push(
      `wrote ${counts.writes} ${counts.writes === 1 ? 'file' : 'files'}`,
    )
  }
  if (counts.commands > 0) {
    parts.push(
      `ran ${counts.commands} ${counts.commands === 1 ? 'command' : 'commands'}`,
    )
  }
  if (counts.other > 0) {
    parts.push(`${counts.other} other ${counts.other === 1 ? 'tool' : 'tools'}`)
  }

  if (parts.length === 0) {
    return undefined
  }

  return capitalize(parts.join(', '))
}

/**
 * 统计 assistant 消息中的工具使用并添加到现有计数。
 */
function accumulateToolUses(
  message: SDKAssistantMessage,
  counts: ToolCounts,
): void {
  const content = message.message!.content
  if (!Array.isArray(content)) {
    return
  }

  for (const block of content) {
    if (block.type === 'tool_use' && 'name' in block) {
      const category = categorizeToolName(block.name as string)
      counts[category]++
    }
  }
}

/**
 * 创建一个有状态的转换器，在文本消息之间累积工具计数。
 * 当遇到包含文本内容的消息时，工具计数重置。
 */
export function createStreamlinedTransformer(): (
  message: StdoutMessage,
) => StdoutMessage | null {
  let cumulativeCounts = createEmptyToolCounts()

  return function transformToStreamlined(
    message: StdoutMessage,
  ): StdoutMessage | null {
    switch (message.type) {
      case 'assistant': {
        const messageContent = (message as unknown as SDKAssistantMessage)
          .message
        const content = messageContent?.content
        const text = Array.isArray(content)
          ? extractTextContent(content, '\n').trim()
          : ''

        // 从此消息累积工具计数
        accumulateToolUses(
          message as unknown as SDKAssistantMessage,
          cumulativeCounts,
        )

        if (text.length > 0) {
          // 文本消息：仅发射文本，重置计数
          cumulativeCounts = createEmptyToolCounts()
          return {
            type: 'streamlined_text',
            text,
            session_id: message.session_id,
            uuid: message.uuid,
          }
        }

        // 仅工具消息：发射累积工具摘要
        const toolSummary = getToolSummaryText(cumulativeCounts)
        if (!toolSummary) {
          return null
        }

        return {
          type: 'streamlined_tool_use_summary',
          tool_summary: toolSummary,
          session_id: message.session_id,
          uuid: message.uuid,
        }
      }

      case 'result':
        // 保持 result 消息原样（它们有 structured_output、permission_denials）
        return message

      case 'system':
      case 'user':
      case 'stream_event':
      case 'tool_progress':
      case 'auth_status':
      case 'rate_limit_event':
      case 'control_response':
      case 'control_request':
      case 'control_cancel_request':
      case 'keep_alive':
        return null

      default:
        return null
    }
  }
}

/**
 * 检查消息是否应包含在精简输出中。
 * 用于转换前的过滤。
 */
export function shouldIncludeInStreamlined(message: StdoutMessage): boolean {
  return message.type === 'assistant' || message.type === 'result'
}
