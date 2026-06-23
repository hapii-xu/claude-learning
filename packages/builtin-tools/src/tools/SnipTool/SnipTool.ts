import { z } from 'zod/v4'
import type { ToolResultBlockParam } from 'src/Tool.js'
import { buildTool } from 'src/Tool.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { SNIP_TOOL_NAME } from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    message_ids: z
      .array(z.string())
      .describe(
        '需要从历史中剪除的消息 ID。被剪除的消息会被替换为简短总结。',
      ),
    reason: z
      .string()
      .optional()
      .describe(
        '剪除这些消息的原因。用于总结替换。',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type SnipInput = z.infer<InputSchema>

type SnipOutput = { snipped_count: number; summary: string }

export const SnipTool = buildTool({
  name: SNIP_TOOL_NAME,
  searchHint: 'snip trim history remove old messages compact context',
  maxResultSizeChars: 5_000,
  strict: true,

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  async description() {
    return '从对话历史中剪除消息以释放上下文空间'
  },
  async prompt() {
    return `从对话历史中剪除消息以释放上下文窗口空间。被剪除的消息会被替换为紧凑的总结，让你在不保留完整内容的情况下仍能了解发生了什么。

使用场景：
- 上下文即将占满，需要腾出空间
- 较早的消息包含已不再需要完整保留的大型工具输出
- 想将一段冗长的探索过程压缩为总结

使用准则：
- 只剪除你确信不再需要逐字引用的消息
- 总结替换会保留关键信息（文件路径、决策、发现的错误）
- 剪除不可撤销——原始内容会从上下文中移除`
  },

  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },

  userFacingName() {
    return 'Snip'
  },

  renderToolUseMessage(input: Partial<SnipInput>) {
    const count = input.message_ids?.length ?? 0
    return `剪除：${count} 条消息`
  },

  mapToolResultToToolResultBlockParam(
    content: SnipOutput,
    toolUseID: string,
  ): ToolResultBlockParam {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `已剪除 ${content.snipped_count} 条消息。总结：${content.summary}`,
    }
  },

  async call(input: SnipInput) {
    // 剪除的实现由查询引擎的投影系统处理。
    // 工具调用本身仅记录意图；查询引擎会拦截
    // 剪除工具的结果，并相应调整其消息投影。
    return {
      data: {
        snipped_count: input.message_ids.length,
        summary: input.reason ?? `已剪除 ${input.message_ids.length} 条消息`,
      },
    }
  },
})
