import { z } from 'zod/v4'
import type { ToolResultBlockParam } from 'src/Tool.js'
import { buildTool } from 'src/Tool.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { VERIFY_PLAN_EXECUTION_TOOL_NAME } from './constants.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    plan_summary: z.string().describe('已执行计划的摘要。'),
    verification_notes: z
      .string()
      .optional()
      .describe('关于验证了什么、以及验证过程中发现的问题的说明。'),
    all_steps_completed: z.boolean().describe('是否已成功完成所有计划步骤。'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type VerifyInput = z.infer<InputSchema>

type VerifyOutput = { verified: boolean; summary: string }

export const VerifyPlanExecutionTool = buildTool({
  name: VERIFY_PLAN_EXECUTION_TOOL_NAME,
  searchHint: '校验计划执行 检查完成情况',
  maxResultSizeChars: 10_000,
  strict: true,

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  async description() {
    return '在退出 plan 模式之前验证计划是否被正确执行'
  },
  async prompt() {
    return `验证某个计划是否已被正确执行。在退出 plan 模式之前调用此工具，确认所有步骤都已完成。

指引：
- 概述已执行的计划
- 说明是否所有步骤都已成功完成
- 附上任何验证说明（测试通过、创建了文件等）
- 如果有步骤被跳过或失败，请在 verification_notes 中解释原因`
  },

  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },

  userFacingName() {
    return 'VerifyPlan'
  },

  renderToolUseMessage(input: Partial<VerifyInput>) {
    if (input.all_steps_completed === true) {
      return '验证计划：所有步骤已完成'
    }
    if (input.all_steps_completed === false) {
      return '验证计划：未完成'
    }
    return '验证计划'
  },

  mapToolResultToToolResultBlockParam(
    content: VerifyOutput,
    toolUseID: string,
  ): ToolResultBlockParam {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: content.verified
        ? `计划已验证：${content.summary}`
        : `计划验证失败：${content.summary}`,
    }
  },

  async call(input: VerifyInput) {
    return {
      data: {
        verified: input.all_steps_completed,
        summary: input.plan_summary,
      },
    }
  },
})
