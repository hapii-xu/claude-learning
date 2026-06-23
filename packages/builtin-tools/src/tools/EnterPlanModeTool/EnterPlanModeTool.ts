import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import {
  getAllowedChannels,
  handlePlanModeTransition,
} from 'src/bootstrap/state.js'
import type { Tool } from 'src/Tool.js'
import { buildTool, type ToolDef } from 'src/Tool.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { applyPermissionUpdate } from 'src/utils/permissions/PermissionUpdate.js'
import { prepareContextForPlanMode } from 'src/utils/permissions/permissionSetup.js'
import { isPlanModeInterviewPhaseEnabled } from 'src/utils/planModeV2.js'
import { ENTER_PLAN_MODE_TOOL_NAME } from './constants.js'
import { getEnterPlanModeToolPrompt } from './prompt.js'
import {
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseRejectedMessage,
} from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    // 不需要参数
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    message: z.string().describe('确认已进入计划模式'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export const EnterPlanModeTool: Tool<InputSchema, Output> = buildTool({
  name: ENTER_PLAN_MODE_TOOL_NAME,
  searchHint: '切换到 plan mode，在编码前设计实现方案',
  maxResultSizeChars: 100_000,
  async description() {
    return '请求权限以进入计划模式，用于需要探索和设计的复杂任务'
  },
  async prompt() {
    return getEnterPlanModeToolPrompt()
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
    // 当 --channels 处于活动状态时，ExitPlanMode 被禁用（其审批
    // 对话框需要终端）。也禁用进入，这样计划模式就不会成为模型
    // 可以进入但永远无法离开的陷阱。
    if (
      (feature('KAIROS') || feature('KAIROS_CHANNELS')) &&
      getAllowedChannels().length > 0
    ) {
      return false
    }
    return true
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  renderToolUseMessage,
  renderToolResultMessage,
  renderToolUseRejectedMessage,
  async call(_input, context) {
    const { logForDebugging } = await import('src/utils/debug.js')
    logForDebugging('[Hapii] EnterPlanMode 进入计划模式', { level: 'info' })
    if (context.agentId) {
      throw new Error('EnterPlanMode 工具不能在 agent 上下文中使用')
    }

    const appState = context.getAppState()
    handlePlanModeTransition(appState.toolPermissionContext.mode, 'plan')

    // 将权限模式更新为 'plan'。当用户的 defaultMode 为
    // 'auto' 时，prepareContextForPlanMode 会运行分类器激活副作用——
    // 有关完整生命周期，请参阅 permissionSetup.ts。
    context.setAppState(prev => ({
      ...prev,
      toolPermissionContext: applyPermissionUpdate(
        prepareContextForPlanMode(prev.toolPermissionContext),
        { type: 'setMode', mode: 'plan', destination: 'session' },
      ),
    }))

    return {
      data: {
        message: '已进入计划模式。现在请专注于探索代码库并设计实现方案。',
      },
    }
  },
  mapToolResultToToolResultBlockParam({ message }, toolUseID) {
    const instructions = isPlanModeInterviewPhaseEnabled()
      ? `${message}

除计划文件外，不要写入或编辑任何文件。详细的工作流说明稍后下发。`
      : `${message}

在 plan mode 中，你应该：
1. 彻底探索代码库，理解现有的代码模式
2. 识别相似功能和架构方案
3. 考虑多种实现方式及其权衡
4. 如需澄清方案，使用 AskUserQuestion
5. 设计具体的实现策略
6. 准备好后，使用 ExitPlanMode 提交计划以供审批

注意：现在不要写入或编辑任何文件。这是一个只读的探索和规划阶段。`

    return {
      type: 'tool_result',
      content: instructions,
      tool_use_id: toolUseID,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
