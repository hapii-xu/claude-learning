import { z } from 'zod/v4'
import type { ToolResultBlockParam } from 'src/Tool.js'
import { buildTool } from 'src/Tool.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { TERMINAL_CAPTURE_TOOL_NAME } from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    lines: z.number().optional().describe('要从终端捕获的行数。默认为 50。'),
    panel_id: z
      .string()
      .optional()
      .describe('要从其捕获输出的终端面板 ID。默认为当前激活的面板。'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type CaptureInput = z.infer<InputSchema>

type CaptureOutput = { content: string; line_count: number }

export const TerminalCaptureTool = buildTool({
  name: TERMINAL_CAPTURE_TOOL_NAME,
  searchHint: '终端 捕获 屏幕 输出 面板 读取',
  maxResultSizeChars: 100_000,
  strict: true,

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  async description() {
    return '从终端面板捕获输出'
  },
  async prompt() {
    return `捕获某个终端面板的当前内容。可用此工具读取运行在终端面板 UI 中的终端会话的输出。

指引：
- 指定要捕获的行数（默认 50）
- 可选：通过 ID 指定目标面板
- 内容以纯文本形式返回`
  },

  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },

  userFacingName() {
    return 'TerminalCapture'
  },

  renderToolUseMessage(input: Partial<CaptureInput>) {
    const lines = input.lines ?? 50
    return `终端捕获：${lines} 行`
  },

  mapToolResultToToolResultBlockParam(
    content: CaptureOutput,
    toolUseID: string,
  ): ToolResultBlockParam {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: content.content || '（终端为空）',
    }
  },

  async call(input: CaptureInput) {
    // 终端面板捕获由 TERMINAL_PANEL 运行时提供。
    return {
      data: {
        content: '',
        line_count: 0,
      },
    }
  },
})
