import { z } from 'zod/v4'
import { setScheduledTasksEnabled } from 'src/bootstrap/state.js'
import type { ValidationResult } from 'src/Tool.js'
import { buildTool, type ToolDef } from 'src/Tool.js'
import { cronToHuman, parseCronExpression } from 'src/utils/cron.js'
import {
  addCronTask,
  getCronFilePath,
  listAllCronTasks,
  nextCronRunMs,
} from 'src/utils/cronTasks.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { semanticBoolean } from 'src/utils/semanticBoolean.js'
import { getTeammateContext } from 'src/utils/teammateContext.js'
import {
  buildCronCreateDescription,
  buildCronCreatePrompt,
  CRON_CREATE_TOOL_NAME,
  DEFAULT_MAX_AGE_DAYS,
  isDurableCronEnabled,
  isKairosCronEnabled,
} from './prompt.js'
import { renderCreateResultMessage, renderCreateToolUseMessage } from './UI.js'

const MAX_JOBS = 50

const inputSchema = lazySchema(() =>
  z.strictObject({
    cron: z
      .string()
      .describe(
        '本地时间的标准 5 字段 cron 表达式："M H DoM Mon DoW"（例如 "*/5 * * * *" = 每 5 分钟，"30 14 28 2 *" = 本地时间 2 月 28 日下午 2:30 触发一次）。',
      ),
    prompt: z.string().describe('在每次触发时要入队的 prompt。'),
    recurring: semanticBoolean(z.boolean().optional()).describe(
      `true（默认）= 每次匹配 cron 都会触发，直到被删除或在 ${DEFAULT_MAX_AGE_DAYS} 天后自动过期。false = 在下一次匹配时触发一次，然后自动删除。对于固定 minute/hour/dom/month 的 "在 X 时提醒我" 一次性请求应使用 false。`,
    ),
    durable: semanticBoolean(z.boolean().optional()).describe(
      'true = 持久化到 .claude/scheduled_tasks.json，并在重启后保留。false（默认）= 仅存于内存，当本次 Claude 会话结束时消失。仅当用户要求任务跨会话保留时才使用 true。',
    ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    id: z.string(),
    humanSchedule: z.string(),
    recurring: z.boolean(),
    durable: z.boolean().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type CreateOutput = z.infer<OutputSchema>

export const CronCreateTool = buildTool({
  name: CRON_CREATE_TOOL_NAME,
  searchHint: '安排一个周期性或一次性的 prompt',
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    return isKairosCronEnabled()
  },
  toAutoClassifierInput(input) {
    return `${input.cron}: ${input.prompt}`
  },
  async description() {
    return buildCronCreateDescription(isDurableCronEnabled())
  },
  async prompt() {
    return buildCronCreatePrompt(isDurableCronEnabled())
  },
  getPath() {
    return getCronFilePath()
  },
  async validateInput(input): Promise<ValidationResult> {
    if (!parseCronExpression(input.cron)) {
      return {
        result: false,
        message: `无效的 cron 表达式 '${input.cron}'。应为 5 个字段：M H DoM Mon DoW。`,
        errorCode: 1,
      }
    }
    if (nextCronRunMs(input.cron, Date.now()) === null) {
      return {
        result: false,
        message: `cron 表达式 '${input.cron}' 在未来一年内不匹配任何日历日期。`,
        errorCode: 2,
      }
    }
    const tasks = await listAllCronTasks()
    if (tasks.length >= MAX_JOBS) {
      return {
        result: false,
        message: `已调度的任务过多（最多 ${MAX_JOBS} 个）。请先取消一个。`,
        errorCode: 3,
      }
    }
    // teammate 不会跨会话保留，因此 durable 的 teammate cron 在重启后会变成
    // 孤儿（agentId 会指向一个不存在的 teammate）。
    if (input.durable && getTeammateContext()) {
      return {
        result: false,
        message: 'teammate 不支持 durable cron（teammate 不会跨会话保留）',
        errorCode: 4,
      }
    }
    return { result: true }
  },
  async call({ cron, prompt, recurring = true, durable = false }) {
    // Kill 开关强制仅本次会话；schema 保持稳定，这样即便开关在会话中途切换，
    // 模型也不会看到校验错误。
    const effectiveDurable = durable && isDurableCronEnabled()
    const id = await addCronTask(
      cron,
      prompt,
      recurring,
      effectiveDurable,
      getTeammateContext()?.agentId,
    )
    // 启用调度器，使任务在本次会话中触发。
    // useScheduledTasks hook 会轮询该标志，并在下一 tick 开始监听。
    // 对于 durable: false 的任务，文件从不改变 —— check() 直接读取会话存储 ——
    // 但 enable 标志依然是启动 tick 循环的入口。
    setScheduledTasksEnabled(true)
    return {
      data: {
        id,
        humanSchedule: cronToHuman(cron),
        recurring,
        durable: effectiveDurable,
      },
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const where = output.durable
      ? '已持久化到 .claude/scheduled_tasks.json'
      : '仅本次会话（不写入磁盘，Claude 退出时消失）'
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: output.recurring
        ? `已安排周期性任务 ${output.id}（${output.humanSchedule}）。${where}。${DEFAULT_MAX_AGE_DAYS} 天后自动过期。如需提前取消请使用 CronDelete。`
        : `已安排一次性任务 ${output.id}（${output.humanSchedule}）。${where}。它将触发一次后自动删除。`,
    }
  },
  renderToolUseMessage: renderCreateToolUseMessage,
  renderToolResultMessage: renderCreateResultMessage,
} satisfies ToolDef<InputSchema, CreateOutput>)
