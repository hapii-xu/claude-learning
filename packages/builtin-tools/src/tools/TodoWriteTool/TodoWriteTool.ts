import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import { getSessionId } from 'src/bootstrap/state.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import { buildTool, type ToolDef } from 'src/Tool.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { isTodoV2Enabled } from 'src/utils/tasks.js'
import { TodoListSchema } from 'src/utils/todo/types.js'
import { VERIFICATION_AGENT_TYPE } from '../AgentTool/constants.js'
import { TODO_WRITE_TOOL_NAME } from './constants.js'
import { DESCRIPTION, PROMPT } from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    todos: TodoListSchema().describe('更新后的待办列表'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    oldTodos: TodoListSchema().describe('更新前的待办列表'),
    newTodos: TodoListSchema().describe('更新后的待办列表'),
    verificationNudgeNeeded: z.boolean().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const TodoWriteTool = buildTool({
  name: TODO_WRITE_TOOL_NAME,
  searchHint: 'manage the session task checklist',
  maxResultSizeChars: 100_000,
  strict: true,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return ''
  },
  shouldDefer: true,
  isEnabled() {
    return !isTodoV2Enabled()
  },
  toAutoClassifierInput(input) {
    return `${input.todos.length} items`
  },
  async checkPermissions(input) {
    // 待办操作不需要权限检查
    return { behavior: 'allow', updatedInput: input }
  },
  renderToolUseMessage() {
    return null
  },
  async call({ todos }, context) {
    const appState = context.getAppState()
    const todoKey = context.agentId ?? getSessionId()
    const oldTodos = appState.todos[todoKey] ?? []
    const allDone = todos.every(_ => _.status === 'completed')
    const newTodos = allDone ? [] : todos

    // 结构性提示：如果主线程 agent 正在收尾一个包含 3 个及以上条目的列表，
    // 且其中没有任何一个条目是验证步骤，则在工具结果中追加一条提醒。
    // 它恰好在循环退出的那一刻触发（也就是最常发生跳过的时机——
    // "当最后一个任务关闭时，循环随之退出"）。
    let verificationNudgeNeeded = false
    if (
      feature('VERIFICATION_AGENT') &&
      getFeatureValue_CACHED_MAY_BE_STALE('tengu_hive_evidence', false) &&
      !context.agentId &&
      allDone &&
      todos.length >= 3 &&
      !todos.some(t => /verif/i.test(t.content))
    ) {
      verificationNudgeNeeded = true
    }

    context.setAppState(prev => ({
      ...prev,
      todos: {
        ...prev.todos,
        [todoKey]: newTodos,
      },
    }))

    return {
      data: {
        oldTodos,
        newTodos: todos,
        verificationNudgeNeeded,
      },
    }
  },
  mapToolResultToToolResultBlockParam({ verificationNudgeNeeded }, toolUseID) {
    const base = `\u5f85\u529e\u5217\u8868\u5df2\u6210\u529f\u66f4\u65b0\u3002\u8bf7\u7ee7\u7eed\u4f7f\u7528\u5f85\u529e\u5217\u8868\u8ddf\u8e2a\u4f60\u7684\u8fdb\u5ea6\u3002\u5982\u6709\u9002\u7528\u7684\u4efb\u52a1\uff0c\u8bf7\u7ee7\u7eed\u6267\u884c\u3002`
    const nudge = verificationNudgeNeeded
      ? `\n\n\u6ce8\u610f\uff1a\u4f60\u521a\u521a\u6536\u5c3e\u4e86 3 \u4e2a\u53ca\u4ee5\u4e0a\u7684\u4efb\u52a1\uff0c\u4f46\u5176\u4e2d\u6ca1\u6709\u4e00\u4e2a\u9a8c\u8bc1\u6b65\u9aa4\u3002\u5728\u64b0\u5199\u6700\u7ec8\u603b\u7ed3\u4e4b\u524d\uff0c\u8bf7\u751f\u6210 verification agent\uff08subagent_type="${VERIFICATION_AGENT_TYPE}"\uff09\u3002\u4f60\u65e0\u6cd5\u901a\u8fc7\u5728\u603b\u7ed3\u4e2d\u5217\u51fa\u79cd\u79cd\u9650\u5b9a\u6765\u4e3a\u81ea\u5df1\u5224\u5b9a PARTIAL\u2014\u2014\u53ea\u6709\u9a8c\u8bc1 agent \u624d\u80fd\u4e0b\u8fbe\u5224\u5b9a\u3002`
      : ''
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: base + nudge,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
