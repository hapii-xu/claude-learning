import { z } from 'zod/v4'
import { buildTool, type ToolDef } from 'src/Tool.js'
import { jsonStringify } from 'src/utils/slowOperations.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import {
  completeGoal,
  formatGoalElapsed,
  formatGoalStatusLabel,
  getGoal,
  recordBlockedAttempt,
} from 'src/services/goal/goalState.js'
import { persistCurrentGoal } from 'src/services/goal/goalStorage.js'
import { GOAL_TOOL_NAME } from './constants.js'
import { DESCRIPTION, generatePrompt } from './prompt.js'

function toolLog(msg: string): void {
  try {
    const { logForDebugging } =
      require('src/utils/debug.js') as typeof import('src/utils/debug.js')
    logForDebugging(`[goal] tool: ${msg}`)
  } catch {
    /* 调试不可用 */
  }
}

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(['get', 'update'])
      .optional()
      .describe(
        '要执行的操作："get" 用于读取状态，"update" 用于标记完成或受阻。如果提供了 status，则默认为 "update"，否则为 "get"。',
      ),
    status: z
      .enum(['complete', 'blocked'])
      .optional()
      .describe('"update" 时必填。仅接受 "complete" 或 "blocked"。'),
    reason: z.string().optional().describe('状态变更的说明。"update" 时必填。'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean(),
    goal: z
      .object({
        objective: z.string(),
        status: z.string(),
        tokensUsed: z.number(),
        tokenBudget: z.number().nullable(),
        elapsed: z.string(),
        turnsExecuted: z.number(),
      })
      .optional(),
    message: z.string().optional(),
    report: z.string().optional(),
    error: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Input = z.infer<InputSchema>
export type Output = z.infer<OutputSchema>

function buildGoalSnapshot() {
  const goal = getGoal()
  if (!goal) return undefined
  return {
    objective: goal.objective,
    status: formatGoalStatusLabel(goal.status),
    tokensUsed: goal.tokensUsed,
    tokenBudget: goal.tokenBudget,
    elapsed: formatGoalElapsed(goal),
    turnsExecuted: goal.turnsExecuted,
  }
}

function buildCompletionReport(): string {
  const goal = getGoal()
  if (!goal) return ''
  const budget =
    goal.tokenBudget !== null
      ? `Token 使用量：${goal.tokensUsed} / ${goal.tokenBudget}`
      : `Token 使用量：${goal.tokensUsed}`
  return [
    '目标已达成 —— 使用报告：',
    `  ${budget}`,
    `  活跃时长：${formatGoalElapsed(goal)}`,
    `  续作轮数：${goal.turnsExecuted}`,
  ].join('\n')
}

export const GoalTool = buildTool({
  name: GOAL_TOOL_NAME,
  searchHint: '获取或更新当前目标（complete/blocked）',
  maxResultSizeChars: 10_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return generatePrompt()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'Goal'
  },
  shouldDefer: true,
  isConcurrencySafe() {
    return true
  },
  isReadOnly(input: Input) {
    const action = input.action ?? (input.status ? 'update' : 'get')
    return action === 'get'
  },
  toAutoClassifierInput(input: Input) {
    const action = input.action ?? (input.status ? 'update' : 'get')
    if (action === 'get') return '获取目标状态'
    return `更新目标：${input.status} — ${input.reason ?? ''}`
  },
  async checkPermissions(input: Input) {
    return { behavior: 'allow' as const, updatedInput: input }
  },
  renderToolUseMessage(input: Input) {
    const action = input.action ?? (input.status ? 'update' : 'get')
    if (action === 'get') return '正在检查目标状态…'
    return `正在更新目标：${input.status}${input.reason ? ` — ${input.reason}` : ''}`
  },
  renderToolResultMessage(output: Output) {
    if (output.error) return `目标错误：${output.error}`
    if (output.report) return output.report
    if (output.goal) {
      return `目标"${output.goal.objective}" — ${output.goal.status}`
    }
    return output.message ?? '完成'
  },
  renderToolUseRejectedMessage() {
    return '目标操作被拒绝'
  },
  async call(input: Input): Promise<{ data: Output }> {
    const action = input.action ?? (input.status ? 'update' : 'get')
    toolLog(
      `called: action=${action}${input.status ? ` status=${input.status}` : ''}${input.reason ? ` reason="${input.reason.slice(0, 60)}"` : ''}`,
    )
    if (action === 'get') {
      const snapshot = buildGoalSnapshot()
      if (!snapshot) {
        return {
          data: {
            success: true,
            message: '没有活动目标。用户可以通过 `/goal <objective>` 来设置。',
          },
        }
      }
      return { data: { success: true, goal: snapshot } }
    }

    // action === 'update'
    if (!input.status) {
      return {
        data: {
          success: false,
          error: '更新时 "status" 字段必填。请使用 "complete" 或 "blocked"。',
        },
      }
    }

    const goal = getGoal()
    if (!goal) {
      return {
        data: {
          success: false,
          error: '没有可更新的活动目标。',
        },
      }
    }

    if (input.status === 'complete') {
      const report = buildCompletionReport()
      completeGoal()
      persistCurrentGoal()
      return {
        data: {
          success: true,
          goal: buildGoalSnapshot(),
          report,
        },
      }
    }

    // status === 'blocked'
    const reason = input.reason ?? '未指定的阻碍'
    const result = recordBlockedAttempt(reason)
    if (!result) {
      return {
        data: {
          success: false,
          error: '目标不处于可记录受阻尝试的状态。',
        },
      }
    }
    persistCurrentGoal()

    if (result.status === 'blocked') {
      return {
        data: {
          success: true,
          goal: buildGoalSnapshot(),
          message: `在连续 ${result.attempts} 次尝试后，目标被标记为受阻。原因：${reason}`,
        },
      }
    }

    return {
      data: {
        success: true,
        goal: buildGoalSnapshot(),
        message: `已记录第 ${result.attempts} 次受阻尝试。目标仍然有效 —— 相同条件必须连续保持 3 轮后才会被标记为受阻。`,
      },
    }
  },
  mapToolResultToToolResultBlockParam(content: Output, toolUseID: string) {
    if (content.error) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result' as const,
        content: `Error: ${content.error}`,
        is_error: true,
      }
    }
    const parts: string[] = []
    if (content.message) parts.push(content.message)
    if (content.report) parts.push(content.report)
    if (content.goal) parts.push(jsonStringify(content.goal))
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: parts.join('\n') || '完成',
    }
  },
} satisfies ToolDef<InputSchema, Output>)
