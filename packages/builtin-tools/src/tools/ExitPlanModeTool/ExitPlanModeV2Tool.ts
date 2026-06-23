import { feature } from 'bun:bundle'
import { writeFile } from 'fs/promises'
import { z } from 'zod/v4'
import {
  getAllowedChannels,
  hasExitedPlanModeInSession,
  setHasExitedPlanMode,
  setNeedsAutoModeExitAttachment,
  setNeedsPlanModeExitAttachment,
} from 'src/bootstrap/state.js'
import { logEvent } from 'src/services/analytics/index.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from 'src/services/analytics/metadata.js'
import {
  buildTool,
  type Tool,
  type ToolDef,
  toolMatchesName,
} from 'src/Tool.js'
import { formatAgentId, generateRequestId } from 'src/utils/agentId.js'
import { isAgentSwarmsEnabled } from 'src/utils/agentSwarmsEnabled.js'
import { logForDebugging } from 'src/utils/debug.js'
import {
  findInProcessTeammateTaskId,
  setAwaitingPlanApproval,
} from 'src/utils/inProcessTeammateHelpers.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { logError } from 'src/utils/log.js'
import {
  getPlan,
  getPlanFilePath,
  persistFileSnapshotIfRemote,
} from 'src/utils/plans.js'
import { jsonStringify } from 'src/utils/slowOperations.js'
import {
  getAgentName,
  getTeamName,
  isPlanModeRequired,
  isTeammate,
} from 'src/utils/teammate.js'
import { writeToMailbox } from 'src/utils/teammateMailbox.js'
import { AGENT_TOOL_NAME } from '../AgentTool/constants.js'
import { TEAM_CREATE_TOOL_NAME } from '../TeamCreateTool/constants.js'
import { EXIT_PLAN_MODE_V2_TOOL_NAME } from './constants.js'
import { EXIT_PLAN_MODE_V2_TOOL_PROMPT } from './prompt.js'
import {
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseRejectedMessage,
} from './UI.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const autoModeStateModule = feature('TRANSCRIPT_CLASSIFIER')
  ? (require('src/utils/permissions/autoModeState.js') as typeof import('src/utils/permissions/autoModeState.js'))
  : null
const permissionSetupModule = feature('TRANSCRIPT_CLASSIFIER')
  ? (require('src/utils/permissions/permissionSetup.js') as typeof import('src/utils/permissions/permissionSetup.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * 基于提示词的权限请求 schema。
 * 由 Claude 用于在退出计划模式时请求语义化权限。
 */
const allowedPromptSchema = lazySchema(() =>
  z.object({
    tool: z.enum(['Bash']).describe('此提示词适用的工具'),
    prompt: z
      .string()
      .describe(
        '操作的语义化描述，例如 "run tests"、"install dependencies"',
      ),
  }),
)

export type AllowedPrompt = z.infer<ReturnType<typeof allowedPromptSchema>>

const inputSchema = lazySchema(() =>
  z
    .strictObject({
      // 计划请求的基于提示词的权限
      allowedPrompts: z
        .array(allowedPromptSchema())
        .optional()
        .describe(
          '实现计划所需的基于提示词的权限。这些描述的是操作类别而不是特定命令。',
        ),
    })
    .passthrough(),
)
type InputSchema = ReturnType<typeof inputSchema>

/**
 * SDK 面向的输入 schema - 包含由 normalizeToolInput 注入的字段。
 * 内部 inputSchema 没有这些字段，因为计划是从磁盘读取的，
 * 但 SDK/hooks 看到的是包含计划和文件路径的标准化版本。
 */
export const _sdkInputSchema = lazySchema(() =>
  inputSchema().extend({
    plan: z
      .string()
      .optional()
      .describe('计划内容（由 normalizeToolInput 从磁盘注入）'),
    planFilePath: z
      .string()
      .optional()
      .describe('计划文件路径（由 normalizeToolInput 注入）'),
  }),
)

export const outputSchema = lazySchema(() =>
  z.object({
    plan: z
      .string()
      .nullable()
      .describe('呈现给用户的计划'),
    isAgent: z.boolean(),
    filePath: z
      .string()
      .optional()
      .describe('计划保存到的文件路径'),
    hasTaskTool: z
      .boolean()
      .optional()
      .describe('当前上下文中是否可以使用 Agent 工具'),
    planWasEdited: z
      .boolean()
      .optional()
      .describe(
        '当用户编辑了计划时为 true（CCR web UI 或 Ctrl+G）；决定是否在 tool_result 中回显计划',
      ),
    awaitingLeaderApproval: z
      .boolean()
      .optional()
      .describe(
        '为 true 时，队友已向团队负责人发送了计划审批请求',
      ),
    requestId: z
      .string()
      .optional()
      .describe('计划审批请求的唯一标识符'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const ExitPlanModeV2Tool: Tool<InputSchema, Output> = buildTool({
  name: EXIT_PLAN_MODE_V2_TOOL_NAME,
  searchHint: '提交计划等待审批并开始编码（仅计划模式）',
  maxResultSizeChars: 100_000,
  async description() {
    return '提示用户退出计划模式并开始编码'
  },
  async prompt() {
    return EXIT_PLAN_MODE_V2_TOOL_PROMPT
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
    // 当 --channels 处于活动状态时，用户可能在 Telegram/Discord 上，
    // 而不是在观看 TUI。计划审批对话框会挂起。与 EnterPlanMode 上的
    // 相同门控配对，这样计划模式就不会成为陷阱。
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
    return false // 现在写入磁盘
  },
  requiresUserInteraction() {
    // 对于所有队友，不需要本地用户交互：
    // - 如果 isPlanModeRequired()：团队负责人通过邮箱审批
    // - 否则：无需审批在本地退出（自愿计划模式）
    if (isTeammate()) {
      return false
    }
    // 对于非队友，需要用户确认才能退出计划模式
    return true
  },
  async validateInput(_input, { getAppState, options }) {
    // 队友 AppState 可能显示负责人的模式（runAgent.ts 在
    // acceptEdits/bypassPermissions/auto 中跳过覆盖）；
    // isPlanModeRequired() 是真正的来源
    if (isTeammate()) {
      return { result: true }
    }
    // 延迟工具列表无论模式如何都会宣布此工具，这样模型
    // 可以在计划审批后调用它（压缩/清除后的新增量）。
    // 在 checkPermissions 之前拒绝以避免显示审批对话框。
    const mode = getAppState().toolPermissionContext.mode
    if (mode !== 'plan') {
      logEvent('tengu_exit_plan_mode_called_outside_plan', {
        model:
          options.mainLoopModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        mode: mode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        hasExitedPlanModeInSession: hasExitedPlanModeInSession(),
      })
      return {
        result: false,
        message:
          '你不在计划模式中。此工具仅用于在编写计划后退出计划模式。如果你的计划已经被批准，请继续实施。',
        errorCode: 1,
      }
    }
    return { result: true }
  },
  async checkPermissions(input, context) {
    // 对于所有队友，绕过权限 UI 以避免发送 permission_request
    // call() 方法处理适当的行为：
    // - 如果 isPlanModeRequired()：向负责人发送 plan_approval_request
    // - 否则：在本地退出计划模式（自愿计划模式）
    if (isTeammate()) {
      return {
        behavior: 'allow' as const,
        updatedInput: input,
      }
    }

    // 对于非队友，需要用户确认才能退出计划模式
    return {
      behavior: 'ask' as const,
      message: '退出计划模式？',
      updatedInput: input,
    }
  },
  renderToolUseMessage,
  renderToolResultMessage,
  renderToolUseRejectedMessage,
  async call(input, context) {
    const { logForDebugging } = await import('src/utils/debug.js')
    logForDebugging(
      `[Hapii] ExitPlanMode 退出计划模式 isAgent=${!!context.agentId}`,
      { level: 'info' },
    )
    const isAgent = !!context.agentId

    const filePath = getPlanFilePath(context.agentId)
    // CCR web UI 可能通过 permissionResult.updatedInput 发送编辑后的计划。
    // queryHelpers.ts 完全替换 finalInput，因此当 CCR 发送 {}（无编辑）时
    // input.plan 是 undefined -> 磁盘回退。内部 inputSchema 省略了
    // `plan`（通常由 normalizeToolInput 注入），因此需要类型收窄。
    const inputPlan =
      'plan' in input && typeof input.plan === 'string' ? input.plan : undefined
    const plan = inputPlan ?? getPlan(context.agentId)

    // 同步磁盘以便 VerifyPlanExecution / Read 看到编辑。之后重新快照：
    // 唯一其他的 persistFileSnapshotIfRemote 调用（api.ts）在
    // normalizeToolInput 中运行，权限之前——它捕获了旧计划。
    if (inputPlan !== undefined && filePath) {
      await writeFile(filePath, inputPlan, 'utf-8').catch(e => logError(e))
      void persistFileSnapshotIfRemote()
    }

    // 检查这是否是需要同伴审批的队友
    if (isTeammate() && isPlanModeRequired()) {
      // 对于 plan_mode_required 的队友，计划是必需的
      if (!plan) {
        throw new Error(
          `No plan file found at ${filePath}. Please write your plan to this file before calling ExitPlanMode.`,
        )
      }
      const agentName = getAgentName() || 'unknown'
      const teamName = getTeamName()
      const requestId = generateRequestId(
        'plan_approval',
        formatAgentId(agentName, teamName || 'default'),
      )

      const approvalRequest = {
        type: 'plan_approval_request',
        from: agentName,
        timestamp: new Date().toISOString(),
        planFilePath: filePath,
        planContent: plan,
        requestId,
      }

      await writeToMailbox(
        'team-lead',
        {
          from: agentName,
          text: jsonStringify(approvalRequest),
          timestamp: new Date().toISOString(),
        },
        teamName,
      )

      // 更新任务状态以显示等待审批（对于进程内队友）
      const appState = context.getAppState()
      const agentTaskId = findInProcessTeammateTaskId(agentName, appState)
      if (agentTaskId) {
        setAwaitingPlanApproval(agentTaskId, context.setAppState, true)
      }

      return {
        data: {
          plan,
          isAgent: true,
          filePath,
          awaitingLeaderApproval: true,
          requestId,
        },
      }
    }

    // 注意：后台验证 hook 在 REPL.tsx 中上下文清除之后通过
    // registerPlanVerificationHook() 注册。在此处注册会在上下文清除期间被清除。

    // 确保退出计划模式时模式已更改。
    // 处理权限流程未设置模式的情况
    //（例如，当 PermissionRequest hook 自动批准但未提供 updatedPermissions 时）。
    const appState = context.getAppState()
    // 在 setAppState 之前计算 gate-off 回退，以便通知用户。
    // 断路器防御：如果 prePlanMode 是 auto 类模式但
    // gate 现在关闭（断路器或设置禁用），则恢复到
    // 'default'。否则 ExitPlanMode 会通过直接调用 setAutoModeActive(true)
    // 绕过断路器。
    let gateFallbackNotification: string | null = null
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      const prePlanRaw = appState.toolPermissionContext.prePlanMode ?? 'default'
      if (
        prePlanRaw === 'auto' &&
        !(permissionSetupModule?.isAutoModeGateEnabled() ?? false)
      ) {
        const reason =
          permissionSetupModule?.getAutoModeUnavailableReason() ??
          'circuit-breaker'
        gateFallbackNotification =
          permissionSetupModule?.getAutoModeUnavailableNotification(reason) ??
          'auto mode unavailable'
        logForDebugging(
          `[auto-mode gate @ ExitPlanModeV2Tool] prePlanMode=${prePlanRaw} ` +
            `but gate is off (reason=${reason}) — falling back to default on plan exit`,
          { level: 'warn' },
        )
      }
    }
    if (gateFallbackNotification) {
      context.addNotification?.({
        key: 'auto-mode-gate-plan-exit-fallback',
        text: `plan exit → default · ${gateFallbackNotification}`,
        priority: 'immediate',
        color: 'warning',
        timeoutMs: 10000,
      })
    }

    context.setAppState(prev => {
      if (prev.toolPermissionContext.mode !== 'plan') return prev
      setHasExitedPlanMode(true)
      setNeedsPlanModeExitAttachment(true)
      let restoreMode = prev.toolPermissionContext.prePlanMode ?? 'default'
      if (feature('TRANSCRIPT_CLASSIFIER')) {
        if (
          restoreMode === 'auto' &&
          !(permissionSetupModule?.isAutoModeGateEnabled() ?? false)
        ) {
          restoreMode = 'default'
        }
        const finalRestoringAuto = restoreMode === 'auto'
        // 捕获恢复前的状态 — isAutoModeActive() 是权威信号
        //（prePlanMode/strippedDangerousRules 在 transitionPlanAutoMode 于计划中
        //途停用后已过期）。
        const autoWasUsedDuringPlan =
          autoModeStateModule?.isAutoModeActive() ?? false
        autoModeStateModule?.setAutoModeActive(finalRestoringAuto)
        if (autoWasUsedDuringPlan && !finalRestoringAuto) {
          setNeedsAutoModeExitAttachment(true)
        }
      }
      // 如果恢复到非 auto 模式且权限被剥离（无论是从 auto 进入计划，
      // 还是由 shouldPlanUseAutoMode 剥离），则恢复权限。
      // 如果恢复到 auto，则保持剥离状态。
      const restoringToAuto = restoreMode === 'auto'
      let baseContext = prev.toolPermissionContext
      if (restoringToAuto) {
        baseContext =
          permissionSetupModule?.stripDangerousPermissionsForAutoMode(
            baseContext,
          ) ?? baseContext
      } else if (prev.toolPermissionContext.strippedDangerousRules) {
        baseContext =
          permissionSetupModule?.restoreDangerousPermissions(baseContext) ??
          baseContext
      }
      return {
        ...prev,
        toolPermissionContext: {
          ...baseContext,
          mode: restoreMode,
          prePlanMode: undefined,
        },
      }
    })

    const hasTaskTool =
      isAgentSwarmsEnabled() &&
      context.options.tools.some(t => toolMatchesName(t, AGENT_TOOL_NAME))

    return {
      data: {
        plan,
        isAgent,
        filePath,
        hasTaskTool: hasTaskTool || undefined,
        planWasEdited: inputPlan !== undefined || undefined,
      },
    }
  },
  mapToolResultToToolResultBlockParam(
    {
      isAgent,
      plan,
      filePath,
      hasTaskTool,
      planWasEdited,
      awaitingLeaderApproval,
      requestId,
    },
    toolUseID,
  ) {
    // 处理等待负责人审批的队友
    if (awaitingLeaderApproval) {
      return {
        type: 'tool_result',
        content: `你的计划已提交给团队负责人审批。

计划文件：${filePath}

**接下来会发生什么：**
1. 等待团队负责人审阅你的计划
2. 你将在收件箱中收到批准/拒绝的消息
3. 如果批准，你可以继续实施
4. 如果拒绝，请根据反馈完善你的计划

**重要：** 在收到批准之前不要继续。请检查收件箱以获取响应。

请求 ID：${requestId}`,
        tool_use_id: toolUseID,
      }
    }

    if (isAgent) {
      return {
        type: 'tool_result',
        content:
          '用户已批准该计划。你现在不需要做其他事情。请回复 "ok"',
        tool_use_id: toolUseID,
      }
    }

    // 处理空计划
    if (!plan || plan.trim() === '') {
      return {
        type: 'tool_result',
        content: '用户已批准退出计划模式。你现在可以继续。',
        tool_use_id: toolUseID,
      }
    }

    const teamHint = hasTaskTool
      ? `\n\n如果此计划可以拆分为多个独立任务，考虑使用 ${TEAM_CREATE_TOOL_NAME} 工具创建团队并并行执行工作。`
      : ''

    // 始终包含计划 — Ultraplan CCR 流程中的 extractApprovedPlan()
    // 会解析 tool_result 以获取本地 CLI 的计划文本。
    // 标记已编辑的计划，让模型知道用户修改了内容。
    const planLabel = planWasEdited
      ? '已批准的计划（用户已编辑）'
      : '已批准的计划'

    return {
      type: 'tool_result',
      content: `用户已批准你的计划。你现在可以开始编码。如果适用，请先更新你的待办事项列表

你的计划已保存到：${filePath}
在实施过程中，如果需要，你可以参考它。${teamHint}

## ${planLabel}：
${plan}`,
      tool_use_id: toolUseID,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
