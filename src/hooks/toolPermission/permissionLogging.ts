// 工具权限决策的集中分析/遥测日志。
// 所有权限批准/拒绝事件都流经 logPermissionDecision()，
// 它扇出到 Statsig 分析、OTel 遥测和代码编辑指标。
import { feature } from 'bun:bundle'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { sanitizeToolNameForAnalytics } from 'src/services/analytics/metadata.js'
import { getCodeEditToolDecisionCounter } from '../../bootstrap/state.js'
import type { Tool as ToolType, ToolUseContext } from '../../Tool.js'
import { getLanguageName } from '../../utils/cliHighlight.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import { logOTelEvent } from '../../utils/telemetry/events.js'
import type {
  PermissionApprovalSource,
  PermissionRejectionSource,
} from './PermissionContext.js'

type PermissionLogContext = {
  tool: ToolType
  input: unknown
  toolUseContext: ToolUseContext
  messageId: string
  toolUseID: string
}

// 判别联合：'accept' 与批准源配对，'reject' 与拒绝源配对
type PermissionDecisionArgs =
  | { decision: 'accept'; source: PermissionApprovalSource | 'config' }
  | { decision: 'reject'; source: PermissionRejectionSource | 'config' }

const CODE_EDITING_TOOLS = ['Edit', 'Write', 'NotebookEdit']

function isCodeEditingTool(toolName: string): boolean {
  return CODE_EDITING_TOOLS.includes(toolName)
}

// 为代码编辑工具构建 OTel 计数器属性，当可以从输入中提取
// 工具的目标文件路径时使用语言丰富
async function buildCodeEditToolAttributes(
  tool: ToolType,
  input: unknown,
  decision: 'accept' | 'reject',
  source: string,
): Promise<Record<string, string>> {
  // 如果工具公开文件路径则从中派生语言（例如，Edit、Write）
  let language: string | undefined
  if (tool.getPath && input) {
    const parseResult = tool.inputSchema.safeParse(input)
    if (parseResult.success) {
      const filePath = tool.getPath(parseResult.data)
      if (filePath) {
        language = await getLanguageName(filePath)
      }
    }
  }

  return {
    decision,
    source,
    tool_name: tool.name,
    ...(language && { language }),
  }
}

// 将结构化源扁平化为分析/OTel 事件的字符串标签
function sourceToString(
  source: PermissionApprovalSource | PermissionRejectionSource,
): string {
  if (
    (feature('BASH_CLASSIFIER') || feature('TRANSCRIPT_CLASSIFIER')) &&
    source.type === 'classifier'
  ) {
    return 'classifier'
  }
  switch (source.type) {
    case 'hook':
      return 'hook'
    case 'user':
      return source.permanent ? 'user_permanent' : 'user_temporary'
    case 'user_abort':
      return 'user_abort'
    case 'user_reject':
      return 'user_reject'
    default:
      return 'unknown'
  }
}

function baseMetadata(
  messageId: string,
  toolName: string,
  waitMs: number | undefined,
): { [key: string]: boolean | number | undefined } {
  return {
    messageID:
      messageId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    toolName: sanitizeToolNameForAnalytics(toolName),
    sandboxEnabled: SandboxManager.isSandboxingEnabled(),
    // 仅当用户实际被提示时包含等待时间（不是自动批准）
    ...(waitMs !== undefined && { waiting_for_user_permission_ms: waitMs }),
  }
}

// 为每个批准源发出不同的分析事件名称以进行漏斗分析
function logApprovalEvent(
  tool: ToolType,
  messageId: string,
  source: PermissionApprovalSource | 'config',
  waitMs: number | undefined,
): void {
  if (source === 'config') {
    // 被设置中的允许列表自动批准 —— 无用户等待时间
    logEvent(
      'tengu_tool_use_granted_in_config',
      baseMetadata(messageId, tool.name, undefined),
    )
    return
  }
  if (
    (feature('BASH_CLASSIFIER') || feature('TRANSCRIPT_CLASSIFIER')) &&
    source.type === 'classifier'
  ) {
    logEvent(
      'tengu_tool_use_granted_by_classifier',
      baseMetadata(messageId, tool.name, waitMs),
    )
    return
  }
  switch (source.type) {
    case 'user':
      logEvent(
        source.permanent
          ? 'tengu_tool_use_granted_in_prompt_permanent'
          : 'tengu_tool_use_granted_in_prompt_temporary',
        baseMetadata(messageId, tool.name, waitMs),
      )
      break
    case 'hook':
      logEvent('tengu_tool_use_granted_by_permission_hook', {
        ...baseMetadata(messageId, tool.name, waitMs),
        permanent: source.permanent ?? false,
      })
      break
    default:
      break
  }
}

// 拒绝共享单个事件名称，通过元数据字段区分
function logRejectionEvent(
  tool: ToolType,
  messageId: string,
  source: PermissionRejectionSource | 'config',
  waitMs: number | undefined,
): void {
  if (source === 'config') {
    // 被设置中的拒绝列表拒绝
    logEvent(
      'tengu_tool_use_denied_in_config',
      baseMetadata(messageId, tool.name, undefined),
    )
    return
  }
  logEvent('tengu_tool_use_rejected_in_prompt', {
    ...baseMetadata(messageId, tool.name, waitMs),
    // 通过单独的字段区分 hook 拒绝和用户拒绝
    ...(source.type === 'hook'
      ? { isHook: true }
      : {
          hasFeedback:
            source.type === 'user_reject' ? source.hasFeedback : false,
        }),
  })
}

// 所有权限决策日志的单入口点。由权限处理器在每次
// 批准/拒绝后调用。扇出到：分析事件、OTel 遥测、
// 代码编辑 OTel 计数器和 toolUseContext 决策存储。
function logPermissionDecision(
  ctx: PermissionLogContext,
  args: PermissionDecisionArgs,
  permissionPromptStartTimeMs?: number,
): void {
  const { tool, input, toolUseContext, messageId, toolUseID } = ctx
  const { decision, source } = args

  const waiting_for_user_permission_ms =
    permissionPromptStartTimeMs !== undefined
      ? Date.now() - permissionPromptStartTimeMs
      : undefined

  // 记录分析事件
  if (args.decision === 'accept') {
    logApprovalEvent(
      tool,
      messageId,
      args.source,
      waiting_for_user_permission_ms,
    )
  } else {
    logRejectionEvent(
      tool,
      messageId,
      args.source,
      waiting_for_user_permission_ms,
    )
  }

  const sourceString = source === 'config' ? 'config' : sourceToString(source)

  // 跟踪代码编辑工具指标
  if (isCodeEditingTool(tool.name)) {
    void buildCodeEditToolAttributes(tool, input, decision, sourceString).then(
      attributes => getCodeEditToolDecisionCounter()?.add(1, attributes),
    )
  }

  // 将决策持久化到上下文，以便下游代码可以检查发生了什么
  if (!toolUseContext.toolDecisions) {
    toolUseContext.toolDecisions = new Map()
  }
  toolUseContext.toolDecisions.set(toolUseID, {
    source: sourceString,
    decision,
    timestamp: Date.now(),
  })

  void logOTelEvent('tool_decision', {
    decision,
    source: sourceString,
    tool_name: sanitizeToolNameForAnalytics(tool.name),
  })
}

export { isCodeEditingTool, buildCodeEditToolAttributes, logPermissionDecision }
export type { PermissionLogContext, PermissionDecisionArgs }
