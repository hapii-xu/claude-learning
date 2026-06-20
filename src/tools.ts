// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { toolMatchesName, type Tool, type Tools } from './Tool.js'
import { AgentTool } from '@claude-code-best/builtin-tools/tools/AgentTool/AgentTool.js'
import { SkillTool } from '@claude-code-best/builtin-tools/tools/SkillTool/SkillTool.js'
import { BashTool } from '@claude-code-best/builtin-tools/tools/BashTool/BashTool.js'
import { FileEditTool } from '@claude-code-best/builtin-tools/tools/FileEditTool/FileEditTool.js'
import { FileReadTool } from '@claude-code-best/builtin-tools/tools/FileReadTool/FileReadTool.js'
import { FileWriteTool } from '@claude-code-best/builtin-tools/tools/FileWriteTool/FileWriteTool.js'
import { GlobTool } from '@claude-code-best/builtin-tools/tools/GlobTool/GlobTool.js'
import { NotebookEditTool } from '@claude-code-best/builtin-tools/tools/NotebookEditTool/NotebookEditTool.js'
import { WebFetchTool } from '@claude-code-best/builtin-tools/tools/WebFetchTool/WebFetchTool.js'
import { TaskStopTool } from '@claude-code-best/builtin-tools/tools/TaskStopTool/TaskStopTool.js'
import { BriefTool } from '@claude-code-best/builtin-tools/tools/BriefTool/BriefTool.js'
// 死代码消除：ant-only 工具的条件导入
/* eslint-disable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
const REPLTool =
  process.env.USER_TYPE === 'ant'
    ? require('@claude-code-best/builtin-tools/tools/REPLTool/REPLTool.js')
        .REPLTool
    : null
const SuggestBackgroundPRTool =
  process.env.USER_TYPE === 'ant'
    ? require('@claude-code-best/builtin-tools/tools/SuggestBackgroundPRTool/SuggestBackgroundPRTool.js')
        .SuggestBackgroundPRTool
    : null
const SleepTool =
  feature('PROACTIVE') || feature('KAIROS')
    ? require('@claude-code-best/builtin-tools/tools/SleepTool/SleepTool.js')
        .SleepTool
    : null
const cronTools = [
  require('@claude-code-best/builtin-tools/tools/ScheduleCronTool/CronCreateTool.js')
    .CronCreateTool,
  require('@claude-code-best/builtin-tools/tools/ScheduleCronTool/CronDeleteTool.js')
    .CronDeleteTool,
  require('@claude-code-best/builtin-tools/tools/ScheduleCronTool/CronListTool.js')
    .CronListTool,
]
const RemoteTriggerTool = feature('AGENT_TRIGGERS_REMOTE')
  ? require('@claude-code-best/builtin-tools/tools/RemoteTriggerTool/RemoteTriggerTool.js')
      .RemoteTriggerTool
  : null
const MonitorTool = feature('MONITOR_TOOL')
  ? require('@claude-code-best/builtin-tools/tools/MonitorTool/MonitorTool.js')
      .MonitorTool
  : null
const SendUserFileTool = feature('KAIROS')
  ? require('@claude-code-best/builtin-tools/tools/SendUserFileTool/SendUserFileTool.js')
      .SendUserFileTool
  : null
const PushNotificationTool =
  feature('KAIROS') || feature('KAIROS_PUSH_NOTIFICATION')
    ? require('@claude-code-best/builtin-tools/tools/PushNotificationTool/PushNotificationTool.js')
        .PushNotificationTool
    : null
const SubscribePRTool = feature('KAIROS_GITHUB_WEBHOOKS')
  ? require('@claude-code-best/builtin-tools/tools/SubscribePRTool/SubscribePRTool.js')
      .SubscribePRTool
  : null
/* eslint-enable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
import { TaskOutputTool } from '@claude-code-best/builtin-tools/tools/TaskOutputTool/TaskOutputTool.js'
import { WebSearchTool } from '@claude-code-best/builtin-tools/tools/WebSearchTool/WebSearchTool.js'
import { TodoWriteTool } from '@claude-code-best/builtin-tools/tools/TodoWriteTool/TodoWriteTool.js'
import { ExitPlanModeV2Tool } from '@claude-code-best/builtin-tools/tools/ExitPlanModeTool/ExitPlanModeV2Tool.js'
import { TestingPermissionTool } from '@claude-code-best/builtin-tools/tools/testing/TestingPermissionTool.js'
import { GrepTool } from '@claude-code-best/builtin-tools/tools/GrepTool/GrepTool.js'
import { TungstenTool } from '@claude-code-best/builtin-tools/tools/TungstenTool/TungstenTool.js'
// 延迟 require 以打破循环依赖：tools.ts -> TeamCreateTool/TeamDeleteTool -> ... -> tools.ts
/* eslint-disable @typescript-eslint/no-require-imports */
const getTeamCreateTool = () =>
  require('@claude-code-best/builtin-tools/tools/TeamCreateTool/TeamCreateTool.js')
    .TeamCreateTool as typeof import('@claude-code-best/builtin-tools/tools/TeamCreateTool/TeamCreateTool.js').TeamCreateTool
const getTeamDeleteTool = () =>
  require('@claude-code-best/builtin-tools/tools/TeamDeleteTool/TeamDeleteTool.js')
    .TeamDeleteTool as typeof import('@claude-code-best/builtin-tools/tools/TeamDeleteTool/TeamDeleteTool.js').TeamDeleteTool
const getSendMessageTool = () =>
  require('@claude-code-best/builtin-tools/tools/SendMessageTool/SendMessageTool.js')
    .SendMessageTool as typeof import('@claude-code-best/builtin-tools/tools/SendMessageTool/SendMessageTool.js').SendMessageTool
/* eslint-enable @typescript-eslint/no-require-imports */
import { AskUserQuestionTool } from '@claude-code-best/builtin-tools/tools/AskUserQuestionTool/AskUserQuestionTool.js'
import { LSPTool } from '@claude-code-best/builtin-tools/tools/LSPTool/LSPTool.js'
import { ListMcpResourcesTool } from '@claude-code-best/builtin-tools/tools/ListMcpResourcesTool/ListMcpResourcesTool.js'
import { ReadMcpResourceTool } from '@claude-code-best/builtin-tools/tools/ReadMcpResourceTool/ReadMcpResourceTool.js'
import { SearchExtraToolsTool } from '@claude-code-best/builtin-tools/tools/SearchExtraToolsTool/SearchExtraToolsTool.js'
import { ExecuteTool } from '@claude-code-best/builtin-tools/tools/ExecuteTool/ExecuteTool.js'
import { EnterPlanModeTool } from '@claude-code-best/builtin-tools/tools/EnterPlanModeTool/EnterPlanModeTool.js'
import { EnterWorktreeTool } from '@claude-code-best/builtin-tools/tools/EnterWorktreeTool/EnterWorktreeTool.js'
import { ExitWorktreeTool } from '@claude-code-best/builtin-tools/tools/ExitWorktreeTool/ExitWorktreeTool.js'
import { ConfigTool } from '@claude-code-best/builtin-tools/tools/ConfigTool/ConfigTool.js'
const GoalTool = feature('GOAL')
  ? require('@claude-code-best/builtin-tools/tools/GoalTool/GoalTool.js')
      .GoalTool
  : null
import { LocalMemoryRecallTool } from '@claude-code-best/builtin-tools/tools/LocalMemoryRecallTool/LocalMemoryRecallTool.js'
import { VaultHttpFetchTool } from '@claude-code-best/builtin-tools/tools/VaultHttpFetchTool/VaultHttpFetchTool.js'
import { TaskCreateTool } from '@claude-code-best/builtin-tools/tools/TaskCreateTool/TaskCreateTool.js'
import { TaskGetTool } from '@claude-code-best/builtin-tools/tools/TaskGetTool/TaskGetTool.js'
import { TaskUpdateTool } from '@claude-code-best/builtin-tools/tools/TaskUpdateTool/TaskUpdateTool.js'
import { TaskListTool } from '@claude-code-best/builtin-tools/tools/TaskListTool/TaskListTool.js'
import uniqBy from 'lodash-es/uniqBy.js'
import { isSearchExtraToolsEnabledOptimistic } from './utils/searchExtraTools.js'
import { isTodoV2Enabled } from './utils/tasks.js'
// 死代码消除：CLAUDE_CODE_VERIFY_PLAN 的条件导入
/* eslint-disable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
const VerifyPlanExecutionTool =
  process.env.CLAUDE_CODE_VERIFY_PLAN === 'true'
    ? require('@claude-code-best/builtin-tools/tools/VerifyPlanExecutionTool/VerifyPlanExecutionTool.js')
        .VerifyPlanExecutionTool
    : null
/* eslint-enable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
import { SYNTHETIC_OUTPUT_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/SyntheticOutputTool/SyntheticOutputTool.js'
export {
  ALL_AGENT_DISALLOWED_TOOLS,
  CUSTOM_AGENT_DISALLOWED_TOOLS,
  ASYNC_AGENT_ALLOWED_TOOLS,
  COORDINATOR_MODE_ALLOWED_TOOLS,
} from './constants/tools.js'
import { feature } from 'bun:bundle'
// 死代码消除：OVERFLOW_TEST_TOOL 的条件导入
/* eslint-disable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
const OverflowTestTool = feature('OVERFLOW_TEST_TOOL')
  ? require('@claude-code-best/builtin-tools/tools/OverflowTestTool/OverflowTestTool.js')
      .OverflowTestTool
  : null
const CtxInspectTool = feature('CONTEXT_COLLAPSE')
  ? require('@claude-code-best/builtin-tools/tools/CtxInspectTool/CtxInspectTool.js')
      .CtxInspectTool
  : null
const TerminalCaptureTool = feature('TERMINAL_PANEL')
  ? require('@claude-code-best/builtin-tools/tools/TerminalCaptureTool/TerminalCaptureTool.js')
      .TerminalCaptureTool
  : null
const WebBrowserTool = feature('WEB_BROWSER_TOOL')
  ? require('@claude-code-best/builtin-tools/tools/WebBrowserTool/WebBrowserTool.js')
      .WebBrowserTool
  : null
const coordinatorModeModule = feature('COORDINATOR_MODE')
  ? (require('./coordinator/coordinatorMode.js') as typeof import('./coordinator/coordinatorMode.js'))
  : null
const SnipTool = feature('HISTORY_SNIP')
  ? require('@claude-code-best/builtin-tools/tools/SnipTool/SnipTool.js')
      .SnipTool
  : null
const DiscoverSkillsTool = feature('EXPERIMENTAL_SKILL_SEARCH')
  ? require('@claude-code-best/builtin-tools/tools/DiscoverSkillsTool/DiscoverSkillsTool.js')
      .DiscoverSkillsTool
  : null
const ReviewArtifactTool = feature('REVIEW_ARTIFACT')
  ? require('@claude-code-best/builtin-tools/tools/ReviewArtifactTool/ReviewArtifactTool.js')
      .ReviewArtifactTool
  : null
const ListPeersTool = feature('UDS_INBOX')
  ? require('@claude-code-best/builtin-tools/tools/ListPeersTool/ListPeersTool.js')
      .ListPeersTool
  : null
const WorkflowTool = feature('WORKFLOW_SCRIPTS')
  ? require('./workflow/wiring.js').createWorkflowToolCore()
  : null
/* eslint-enable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
import type { ToolPermissionContext } from './Tool.js'
import { getDenyRuleForTool } from './utils/permissions/permissions.js'
import { hasEmbeddedSearchTools } from './utils/embeddedTools.js'
import { isEnvTruthy } from './utils/envUtils.js'
import { logForDebugging } from './utils/debug.js'
import { isPowerShellToolEnabled } from './utils/shell/shellToolUtils.js'
import { isAgentSwarmsEnabled } from './utils/agentSwarmsEnabled.js'
import { isWorktreeModeEnabled } from './utils/worktreeModeEnabled.js'
import {
  REPL_TOOL_NAME,
  REPL_ONLY_TOOLS,
  isReplModeEnabled,
} from '@claude-code-best/builtin-tools/tools/REPLTool/constants.js'
export { REPL_ONLY_TOOLS }
/* eslint-disable @typescript-eslint/no-require-imports */
const getPowerShellTool = () => {
  if (!isPowerShellToolEnabled()) return null
  return (
    require('@claude-code-best/builtin-tools/tools/PowerShellTool/PowerShellTool.js') as typeof import('@claude-code-best/builtin-tools/tools/PowerShellTool/PowerShellTool.js')
  ).PowerShellTool
}
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * 可与 --tools 标志一起使用的预定义工具预设
 */
export const TOOL_PRESETS = ['default'] as const

export type ToolPreset = (typeof TOOL_PRESETS)[number]

export function parseToolPreset(preset: string): ToolPreset | null {
  const presetString = preset.toLowerCase()
  if (!TOOL_PRESETS.includes(presetString as ToolPreset)) {
    return null
  }
  return presetString as ToolPreset
}

/**
 * 获取给定预设的工具名称列表
 * 通过 isEnabled() 检查过滤掉禁用的工具
 * @param preset 预设名称
 * @returns 工具名称数组
 */
export function getToolsForDefaultPreset(): string[] {
  const tools = getAllBaseTools()
  const isEnabled = tools.map(tool => tool.isEnabled())
  return tools.filter((_, i) => isEnabled[i]).map(tool => tool.name)
}

/**
 * 获取当前环境中所有可能可用的工具的完整详尽列表
 * （尊重 process.env 标志）。
 * 这是所有工具的权威来源。
 */
/**
 * 注意：这必须与 https://console.statsig.com/4aF3Ewatb6xPVpCwxb5nA3/dynamic_configs/claude_code_global_system_caching 保持同步，
 * 以便跨用户缓存系统提示。
 */
export function getAllBaseTools(): Tools {
  const tools = [
    AgentTool,
    TaskOutputTool,
    BashTool,
    // Ant 原生构建将 bfs/ugrep 嵌入到 bun 二进制文件中（与 ripgrep 相同的 ARGV0
    // 技巧）。当可用时，Claude shell 中的 find/grep 会别名到这些快速工具，
    // 因此不需要专门的 Glob/Grep 工具。
    ...(hasEmbeddedSearchTools() ? [] : [GlobTool, GrepTool]),
    ExitPlanModeV2Tool,
    FileReadTool,
    FileEditTool,
    FileWriteTool,
    NotebookEditTool,
    WebFetchTool,
    TodoWriteTool,
    WebSearchTool,
    TaskStopTool,
    AskUserQuestionTool,
    SkillTool,
    EnterPlanModeTool,
    LocalMemoryRecallTool,
    VaultHttpFetchTool,
    ...(process.env.USER_TYPE === 'ant' ? [ConfigTool] : []),
    ...(GoalTool ? [GoalTool] : []),
    ...(process.env.USER_TYPE === 'ant' ? [TungstenTool] : []),
    ...(SuggestBackgroundPRTool ? [SuggestBackgroundPRTool] : []),
    ...(WebBrowserTool ? [WebBrowserTool] : []),
    ...(isTodoV2Enabled()
      ? [TaskCreateTool, TaskGetTool, TaskUpdateTool, TaskListTool]
      : []),
    ...(OverflowTestTool ? [OverflowTestTool] : []),
    ...(CtxInspectTool ? [CtxInspectTool] : []),
    ...(TerminalCaptureTool ? [TerminalCaptureTool] : []),
    ...(isEnvTruthy(process.env.ENABLE_LSP_TOOL) ? [LSPTool] : []),
    ...(isWorktreeModeEnabled() ? [EnterWorktreeTool, ExitWorktreeTool] : []),
    getSendMessageTool(),
    ...(ListPeersTool ? [ListPeersTool] : []),
    getTeamCreateTool(),
    getTeamDeleteTool(),
    ...(VerifyPlanExecutionTool ? [VerifyPlanExecutionTool] : []),
    ...(process.env.USER_TYPE === 'ant' && REPLTool ? [REPLTool] : []),
    ...(WorkflowTool ? [WorkflowTool] : []),
    ...(SleepTool ? [SleepTool] : []),
    ...cronTools,
    ...(RemoteTriggerTool ? [RemoteTriggerTool] : []),
    ...(MonitorTool ? [MonitorTool] : []),
    BriefTool,
    ...(SendUserFileTool ? [SendUserFileTool] : []),
    ...(PushNotificationTool ? [PushNotificationTool] : []),
    ...(SubscribePRTool ? [SubscribePRTool] : []),
    ...(ReviewArtifactTool ? [ReviewArtifactTool] : []),
    ...(getPowerShellTool() ? [getPowerShellTool()] : []),
    ...(SnipTool ? [SnipTool] : []),
    ...(DiscoverSkillsTool ? [DiscoverSkillsTool] : []),
    ...(process.env.NODE_ENV === 'test' ? [TestingPermissionTool] : []),
    ListMcpResourcesTool,
    ReadMcpResourceTool,
    // 当工具搜索可能启用时包含 SearchExtraToolsTool（乐观检查）
    // 实际的延迟工具决策发生在 claude.ts 的请求时
    ...(isSearchExtraToolsEnabledOptimistic() ? [SearchExtraToolsTool] : []),
    // ExecuteExtraTool（ExecuteTool）是一等工具 — 始终可用，不延迟。
    // 模型使用它来调用通过 SearchExtraTools 发现的延迟工具。
    ExecuteTool,
  ]
  logForDebugging(
    `[工具注册] getAllBaseTools 加载完成，共 ${tools.length} 个内置工具`,
    { level: 'info' },
  )
  return tools
}

/**
 * 过滤掉被权限上下文完全拒绝的工具。
 * 如果存在匹配其名称的规则且没有 ruleContent（即该工具的完全拒绝），
 * 则工具被过滤掉。
 *
 * 使用与运行时权限检查（步骤 1a）相同的匹配器，因此 MCP 服务器前缀规则
 * 如 `mcp__server` 会在模型看到它们之前从该服务器剥离所有工具
 * — 而不仅仅是在调用时。
 */
export function filterToolsByDenyRules<
  T extends {
    name: string
    mcpInfo?: { serverName: string; toolName: string }
  },
>(tools: readonly T[], permissionContext: ToolPermissionContext): T[] {
  return tools.filter(tool => !getDenyRuleForTool(permissionContext, tool))
}

export const getTools = (permissionContext: ToolPermissionContext): Tools => {
  // 简单模式：仅 Bash、Read 和 Edit 工具
  if (isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
    logForDebugging(
      '[工具注册] CLAUDE_CODE_SIMPLE 模式：仅保留 Bash/Read/Edit 等简化工具集',
      { level: 'info' },
    )
    // --bare + REPL 模式：REPL 在 VM 内部包装 Bash/Read/Edit 等，
    // 因此返回 REPL 而不是原始工具。匹配下方的非 bare 路径，
    // 该路径在启用 REPL 时也会隐藏 REPL_ONLY_TOOLS。
    if (isReplModeEnabled() && REPLTool) {
      const replSimple: Tool[] = [REPLTool]
      if (
        feature('COORDINATOR_MODE') &&
        coordinatorModeModule?.isCoordinatorMode()
      ) {
        replSimple.push(TaskStopTool, getSendMessageTool())
      }
      return filterToolsByDenyRules(replSimple, permissionContext)
    }
    const simpleTools: Tool[] = [BashTool, FileReadTool, FileEditTool]
    // 当 coordinator 模式也激活时，包含 AgentTool 和 TaskStopTool
    // 以便 coordinator 获得 Task+TaskStop（通过 useMergedTools 过滤），
    // workers 获得 Bash/Read/Edit（通过 filterToolsForAgent 过滤）。
    if (
      feature('COORDINATOR_MODE') &&
      coordinatorModeModule?.isCoordinatorMode()
    ) {
      simpleTools.push(AgentTool, TaskStopTool, getSendMessageTool())
    }
    return filterToolsByDenyRules(simpleTools, permissionContext)
  }

  // 获取所有基础工具并过滤掉条件添加的特殊工具
  const specialTools = new Set([
    ListMcpResourcesTool.name,
    ReadMcpResourceTool.name,
    SYNTHETIC_OUTPUT_TOOL_NAME,
  ])

  const tools = getAllBaseTools().filter(tool => !specialTools.has(tool.name))

  // 过滤掉被拒绝规则拒绝的工具
  let allowedTools = filterToolsByDenyRules(tools, permissionContext)

  // 当启用 REPL 模式时，隐藏原始工具以供直接使用。
  // 它们仍然可以通过 VM 上下文在 REPL 内部访问。
  if (isReplModeEnabled()) {
    const replEnabled = allowedTools.some(tool =>
      toolMatchesName(tool, REPL_TOOL_NAME),
    )
    if (replEnabled) {
      allowedTools = allowedTools.filter(
        tool => !REPL_ONLY_TOOLS.has(tool.name),
      )
    }
  }

  const isEnabled = allowedTools.map(_ => _.isEnabled())
  const finalTools = allowedTools.filter((_, i) => isEnabled[i])
  logForDebugging(
    `[工具注册] getTools 过滤完成，最终工具数 ${finalTools.length}`,
    { level: 'info' },
  )
  return finalTools
}

/**
 * 为给定的权限上下文和 MCP 工具组装完整的工具池。
 *
 * 这是将内置工具与 MCP 工具组合的唯一权威来源。
 * REPL.tsx（通过 useMergedTools hook）和 runAgent.ts（用于 coordinator workers）
 * 都使用此函数以确保一致的工具池组装。
 *
 * 此函数：
 * 1. 通过 getTools() 获取内置工具（尊重模式过滤）
 * 2. 通过拒绝规则过滤 MCP 工具
 * 3. 按工具名称去重（内置工具优先）
 *
 * @param permissionContext - 用于过滤内置工具的权限上下文
 * @param mcpTools - 来自 appState.mcp.tools 的 MCP 工具
 * @returns 内置和 MCP 工具的组合、去重数组
 */
export function assembleToolPool(
  permissionContext: ToolPermissionContext,
  mcpTools: Tools,
): Tools {
  const builtInTools = getTools(permissionContext)

  // 过滤掉在拒绝列表中的 MCP 工具
  const allowedMcpTools = filterToolsByDenyRules(mcpTools, permissionContext)

  // 对每个分区排序以保持提示缓存稳定性，将内置工具保持为连续前缀。
  // 服务器的 claude_code_system_cache_policy 在最后一个前缀匹配的内置工具之后
  // 放置全局缓存断点；扁平排序会将 MCP 工具交错到内置工具中，并在 MCP 工具
  // 排序到现有内置工具之间时使所有下游缓存键失效。uniqBy 保留插入顺序，
  // 因此内置工具在名称冲突时获胜。
  // 避免使用 Array.toSorted（Node 20+）— 我们支持 Node 18。builtInTools 是
  // readonly 所以复制后排序；allowedMcpTools 是新的 .filter() 结果。
  logForDebugging(
    `[工具注册] assembleToolPool：内置 ${builtInTools.length} + MCP ${allowedMcpTools.length}`,
    { level: 'info' },
  )
  const byName = (a: Tool, b: Tool) => a.name.localeCompare(b.name)
  return uniqBy(
    [...builtInTools].sort(byName).concat(allowedMcpTools.sort(byName)),
    'name',
  )
}

/**
 * 获取包括内置工具和 MCP 工具在内的所有工具。
 *
 * 当您需要完整的工具列表时，这是首选函数：
 * - 工具搜索阈值计算（isSearchExtraToolsEnabled）
 * - 包括 MCP 工具的 token 计数
 * - 任何应考虑 MCP 工具的上下文
 *
 * 仅当您特别需要内置工具时才使用 getTools()。
 *
 * @param permissionContext - 用于过滤内置工具的权限上下文
 * @param mcpTools - 来自 appState.mcp.tools 的 MCP 工具
 * @returns 内置和 MCP 工具的组合数组
 */
export function getMergedTools(
  permissionContext: ToolPermissionContext,
  mcpTools: Tools,
): Tools {
  const builtInTools = getTools(permissionContext)
  return [...builtInTools, ...mcpTools]
}
