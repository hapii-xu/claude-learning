import { z } from 'zod/v4'
import type { TaskStateBase } from 'src/Task.js'
import { buildTool, type ToolDef } from 'src/Tool.js'
import { stopTask } from 'src/tasks/stopTask.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { jsonStringify } from 'src/utils/slowOperations.js'
import { DESCRIPTION, TASK_STOP_TOOL_NAME } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    task_id: z.string().optional().describe('要停止的后台任务 ID'),
    // 为了向后兼容已废弃的 KillShell 工具而保留 shell_id
    shell_id: z.string().optional().describe('已废弃：请改用 task_id'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    message: z.string().describe('操作的状态消息'),
    task_id: z.string().describe('被停止任务的 ID'),
    task_type: z.string().describe('被停止任务的类型'),
    // 可选：工具输出会持久化到记录并在 --resume 时回放，且不重新校验，
    // 因此该字段出现之前的会话没有这个字段。
    command: z.string().optional().describe('被停止任务的命令或描述'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const TaskStopTool = buildTool({
  name: TASK_STOP_TOOL_NAME,
  searchHint: 'kill a running background task',
  // KillShell 是已废弃的名称 - 作为别名保留是为了向后兼容已有的记录和 SDK 用户
  aliases: ['KillShell'],
  maxResultSizeChars: 100_000,
  userFacingName: () => (process.env.USER_TYPE === 'ant' ? '' : 'Stop Task'),
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  shouldDefer: true,
  isConcurrencySafe() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.task_id ?? input.shell_id ?? ''
  },
  async validateInput({ task_id, shell_id }, { getAppState }) {
    // 同时支持 task_id 和 shell_id（已废弃 KillShell 的兼容）
    const id = task_id ?? shell_id
    if (!id) {
      return {
        result: false,
        message: '缺少必填参数：task_id',
        errorCode: 1,
      }
    }

    const appState = getAppState()
    const task = appState.tasks?.[id] as TaskStateBase | undefined

    if (!task) {
      return {
        result: false,
        message: `未找到 ID 为 ${id} 的任务`,
        errorCode: 1,
      }
    }

    if (task.status !== 'running') {
      return {
        result: false,
        message: `任务 ${id} 未运行（状态：${task.status}）`,
        errorCode: 3,
      }
    }

    return { result: true }
  },
  async description() {
    return `根据 ID 停止运行中的后台任务`
  },
  async prompt() {
    return DESCRIPTION
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: jsonStringify(output),
    }
  },
  renderToolUseMessage,
  renderToolResultMessage,
  async call(
    { task_id, shell_id },
    { getAppState, setAppState, abortController },
  ) {
    // 同时支持 task_id 和 shell_id（已废弃 KillShell 的兼容）
    const id = task_id ?? shell_id
    if (!id) {
      throw new Error('缺少必填参数：task_id')
    }

    const result = await stopTask(id, {
      getAppState,
      setAppState,
    })

    return {
      data: {
        message: `成功停止任务：${result.taskId} (${result.command})`,
        task_id: result.taskId,
        task_type: result.taskType,
        command: result.command,
      },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
