import { z } from 'zod/v4'
import { buildTool, type ToolDef } from 'src/Tool.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import type { PermissionResult } from 'src/utils/permissions/PermissionResult.js'
import { isOutputLineTruncated } from 'src/utils/terminal.js'
import { logForDebugging } from 'src/utils/debug.js'
import { DESCRIPTION, PROMPT } from './prompt.js'
import {
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
} from './UI.js'

// 允许任意输入对象，因为 MCP 工具定义自己的 schema
export const inputSchema = lazySchema(() => z.object({}).passthrough())
type InputSchema = ReturnType<typeof inputSchema>

export const outputSchema = lazySchema(() =>
  z.string().describe('MCP tool execution result'),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

// 从集中类型重新导出 MCPProgress 以打破导入循环
export type { MCPProgress } from 'src/types/tools.js'

export const MCPTool = buildTool({
  isMcp: true,
  // 在 mcpClient.ts 中用真实的 MCP 工具名称 + 参数覆盖
  isOpenWorld() {
    return false
  },
  // 在 mcpClient.ts 中覆盖
  name: 'mcp',
  maxResultSizeChars: 100_000,
  // 在 mcpClient.ts 中覆盖
  async description() {
    return DESCRIPTION
  },
  // 在 mcpClient.ts 中覆盖
  async prompt() {
    return PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  // 在 mcpClient.ts 中覆盖
  async call() {
    logForDebugging(
      '[MCP Tool] 警告：stub call() 被触发！说明 MCP client 未正确覆盖此工具，请检查 client.ts',
      { level: 'error' },
    )
    return {
      data: '',
    }
  },
  async checkPermissions(): Promise<PermissionResult> {
    return {
      behavior: 'passthrough',
      message: 'MCPTool requires permission.',
    }
  },
  renderToolUseMessage,
  // 在 mcpClient.ts 中覆盖
  userFacingName: () => 'mcp',
  renderToolUseProgressMessage,
  renderToolResultMessage,
  isResultTruncated(output: Output): boolean {
    return isOutputLineTruncated(output)
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
