import { z } from 'zod/v4'
import type { ToolResultBlockParam } from 'src/Tool.js'
import { buildTool } from 'src/Tool.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { REPL_TOOL_NAME } from './constants.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    code: z
      .string()
      .describe(
        '在 REPL 中执行的代码。可通过 API 调用任何原始工具（Read、Write、Edit、Glob、Grep、Bash、NotebookEdit、Agent）。',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type REPLInput = z.infer<InputSchema>

type REPLOutput = { result: string; tool_calls: number }

export const REPLTool = buildTool({
  name: REPL_TOOL_NAME,
  searchHint: 'repl execute batch code read write edit glob grep bash',
  maxResultSizeChars: 100_000,
  strict: true,

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  async description() {
    return '在 REPL 环境中执行代码，可访问所有原始工具'
  },
  async prompt() {
    return `在 REPL 中执行代码——这是一个沙箱环境，可直接访问原始工具（Read、Write、Edit、Glob、Grep、Bash、NotebookEdit、Agent）。

当 REPL 模式启用时，原始工具只能通过本工具访问。可在以下场景使用 REPL：
- 跨多文件的批量操作
- 复杂的多步骤文件转换
- 受益于程序化控制流的操作
- 在单轮中合并搜索结果与编辑

REPL 在 VM 上下文中运行，工具 API 以函数形式提供。每次工具调用的结果会被收集并一并返回。`
  },

  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  isTransparentWrapper() {
    return true
  },

  userFacingName() {
    return REPL_TOOL_NAME
  },

  renderToolUseMessage(input: Partial<REPLInput>) {
    const code = input.code ?? ''
    const preview = code.length > 80 ? code.slice(0, 77) + '...' : code
    return `REPL: ${preview}`
  },

  mapToolResultToToolResultBlockParam(
    content: REPLOutput,
    toolUseID: string,
  ): ToolResultBlockParam {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: content.result,
    }
  },

  async call(_input: REPLInput) {
    // REPL 执行引擎由 ant 原生运行时提供。
    // 此存根仅满足工具接口；实际的 VM 分发
    // 在 ant 构建中连接。没有 ant 运行时的情况下，REPL 不可用，
    // 应告知调用方。
    return {
      data: {
        result:
          '错误：当前构建中 REPL 工具不可用。REPL 执行引擎需要 ant 原生运行时。',
        tool_calls: 0,
      },
    }
  },
})
