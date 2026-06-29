/**
 * 工具调用摘要生成器
 *
 * 使用 Haiku 模型为已完成的工具批次生成人类可读的摘要。
 * 供 SDK 使用，向客户端提供高层级的进度更新。
 */

import { E_TOOL_USE_SUMMARY_GENERATION_FAILED } from '../../constants/errorIds.js'
import { toError } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { queryHaiku } from '../api/claude.js'

const TOOL_USE_SUMMARY_SYSTEM_PROMPT = `写一个简短的摘要标签，描述这些工具调用完成了什么。它以单行形式显示在移动应用中，约30个字符后截断，所以要写成 git commit 主题风格，而不是完整句子。

动词用过去式，保留最具辨识度的名词。优先省略冠词、连接词和冗长的路径上下文。

示例：
- 在 auth/ 中搜索
- 修复 UserService 中的 NPE
- 创建注册接口
- 读取 config.json
- 运行失败的测试`

type ToolInfo = {
  name: string
  input: unknown
  output: unknown
}

export type GenerateToolUseSummaryParams = {
  tools: ToolInfo[]
  signal: AbortSignal
  isNonInteractiveSession: boolean
  lastAssistantText?: string
}

/**
 * 为已完成的工具调用生成人类可读的摘要。
 *
 * @param params - 参数，包含已执行的工具及其结果
 * @returns 简短摘要字符串，生成失败时返回 null
 */
export async function generateToolUseSummary({
  tools,
  signal,
  isNonInteractiveSession,
  lastAssistantText,
}: GenerateToolUseSummaryParams): Promise<string | null> {
  if (tools.length === 0) {
    return null
  }

  try {
    // 构建工具执行情况的简洁描述
    const toolSummaries = tools
      .map(tool => {
        const inputStr = truncateJson(tool.input, 300)
        const outputStr = truncateJson(tool.output, 300)
        return `工具: ${tool.name}\n输入: ${inputStr}\n输出: ${outputStr}`
      })
      .join('\n\n')

    const contextPrefix = lastAssistantText
      ? `用户意图（来自助手的最后一条消息）: ${lastAssistantText.slice(0, 200)}\n\n`
      : ''

    const response = await queryHaiku({
      systemPrompt: asSystemPrompt([TOOL_USE_SUMMARY_SYSTEM_PROMPT]),
      userPrompt: `${contextPrefix}已完成的工具:\n\n${toolSummaries}\n\n标签:`,
      signal,
      options: {
        querySource: 'tool_use_summary_generation',
        enablePromptCaching: true,
        agents: [],
        isNonInteractiveSession,
        hasAppendSystemPrompt: false,
        mcpTools: [],
      },
    })

    const summary = (
      Array.isArray(response.message.content) ? response.message.content : []
    )
      .filter(block => block.type === 'text')
      .map(block => (block.type === 'text' ? block.text : ''))
      .join('')
      .trim()

    return summary || null
  } catch (error) {
    // 记录错误但不抛出——摘要生成属于非关键功能
    const err = toError(error)
    err.cause = { errorId: E_TOOL_USE_SUMMARY_GENERATION_FAILED }
    logError(err)
    return null
  }
}

/**
 * 将 JSON 值截断至提示词中允许的最大长度。
 */
function truncateJson(value: unknown, maxLength: number): string {
  try {
    const str = jsonStringify(value)
    if (str.length <= maxLength) {
      return str
    }
    return str.slice(0, maxLength - 3) + '...'
  } catch {
    return '[无法序列化]'
  }
}
