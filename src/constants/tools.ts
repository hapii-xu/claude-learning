// biome-ignore-all assist/source/organizeImports: ANT 专用导入标记不得重排序
import { feature } from 'bun:bundle'
import { TASK_OUTPUT_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/TaskOutputTool/constants.js'
import { EXIT_PLAN_MODE_V2_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/ExitPlanModeTool/constants.js'
import { ENTER_PLAN_MODE_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/EnterPlanModeTool/constants.js'
import { AGENT_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/AgentTool/constants.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/AskUserQuestionTool/prompt.js'
import { TASK_STOP_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/TaskStopTool/prompt.js'
import { FILE_READ_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/FileReadTool/prompt.js'
import { WEB_SEARCH_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/WebSearchTool/prompt.js'
import { TODO_WRITE_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/TodoWriteTool/constants.js'
import { GREP_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/GrepTool/prompt.js'
import { WEB_FETCH_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/WebFetchTool/prompt.js'
import { GLOB_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/GlobTool/prompt.js'
import { SHELL_TOOL_NAMES } from '../utils/shell/shellToolUtils.js'
import { FILE_EDIT_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/FileWriteTool/prompt.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/NotebookEditTool/constants.js'
import { SKILL_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/SkillTool/constants.js'
import { SEND_MESSAGE_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/SendMessageTool/constants.js'
import { TASK_CREATE_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/TaskCreateTool/constants.js'
import { TASK_GET_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/TaskGetTool/constants.js'
import { TASK_LIST_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/TaskListTool/constants.js'
import { TASK_UPDATE_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/TaskUpdateTool/constants.js'
import { SEARCH_EXTRA_TOOLS_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/SearchExtraToolsTool/constants.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/SyntheticOutputTool/SyntheticOutputTool.js'
import { SLEEP_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/SleepTool/prompt.js'
import { LSP_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/LSPTool/prompt.js'
import { VERIFY_PLAN_EXECUTION_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/VerifyPlanExecutionTool/constants.js'
import { TEAM_CREATE_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/TeamCreateTool/constants.js'
import { TEAM_DELETE_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/TeamDeleteTool/constants.js'
import { EXECUTE_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/ExecuteTool/constants.js'
import { ENTER_WORKTREE_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/EnterWorktreeTool/constants.js'
import { EXIT_WORKTREE_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/ExitWorktreeTool/constants.js'
import { WORKFLOW_TOOL_NAME } from '@claude-code-best/workflow-engine'
import {
  CRON_CREATE_TOOL_NAME,
  CRON_DELETE_TOOL_NAME,
  CRON_LIST_TOOL_NAME,
} from '@claude-code-best/builtin-tools/tools/ScheduleCronTool/prompt.js'
import { LOCAL_MEMORY_RECALL_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/LocalMemoryRecallTool/constants.js'
import { VAULT_HTTP_FETCH_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/VaultHttpFetchTool/constants.js'

export const ALL_AGENT_DISALLOWED_TOOLS = new Set([
  TASK_OUTPUT_TOOL_NAME,
  EXIT_PLAN_MODE_V2_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
  // 当用户是 ant 时允许 Agent 工具用于代理（启用嵌套代理）
  ...(process.env.USER_TYPE === 'ant' ? [] : [AGENT_TOOL_NAME]),
  ASK_USER_QUESTION_TOOL_NAME,
  TASK_STOP_TOOL_NAME,
  // 防止子代理内部的递归工作流执行。
  ...(feature('WORKFLOW_SCRIPTS') ? [WORKFLOW_TOOL_NAME] : []),
  // LOCAL-WIRING PR-1：仅在主线程保留本地内存回忆。
  // 跨会话用户笔记不应被生成的子代理抽取。
  // 门控的第 2 层（fork 路径 useExactTools）由 src/utils/agentToolFilter.ts
  // 中的 filterParentToolsForFork 单独强制执行。
  LOCAL_MEMORY_RECALL_TOOL_NAME,
  // LOCAL-WIRING PR-2：vault HTTP fetch 更加敏感（涉及用户密钥）。
  // 应用相同的两层门控 — 仅保留在主线程。
  VAULT_HTTP_FETCH_TOOL_NAME,
])

export const CUSTOM_AGENT_DISALLOWED_TOOLS = new Set([
  ...ALL_AGENT_DISALLOWED_TOOLS,
])

/*
 * 异步代理工具可用性状态（权威来源）
 */
export const ASYNC_AGENT_ALLOWED_TOOLS = new Set([
  FILE_READ_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  TODO_WRITE_TOOL_NAME,
  GREP_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  GLOB_TOOL_NAME,
  ...SHELL_TOOL_NAMES,
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
  SKILL_TOOL_NAME,
  SYNTHETIC_OUTPUT_TOOL_NAME,
  SEARCH_EXTRA_TOOLS_TOOL_NAME,
  EXECUTE_TOOL_NAME,
  ENTER_WORKTREE_TOOL_NAME,
  EXIT_WORKTREE_TOOL_NAME,
])
/**
 * 仅允许进程内队友使用的工具（不是一般异步代理）。
 * 这些由 inProcessRunner.ts 注入，并通过 filterToolsForAgent 中的
 * isInProcessTeammate() 检查允许。
 */
export const IN_PROCESS_TEAMMATE_ALLOWED_TOOLS = new Set([
  TASK_CREATE_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  // 队友创建的 cron 任务用创建者 agentId 标记，并路由到该队友的
  // pendingUserMessages 队列（参见 useScheduledTasks.ts）。
  CRON_CREATE_TOOL_NAME,
  CRON_DELETE_TOOL_NAME,
  CRON_LIST_TOOL_NAME,
])

/*
 * 异步代理阻止的工具：
 * - AgentTool：阻止以防止递归
 * - TaskOutputTool：阻止以防止递归
 * - ExitPlanModeTool：计划模式是主线程抽象。
 * - TaskStopTool：需要访问主线程任务状态。
 * - TungstenTool：使用单例虚拟终端抽象，在代理之间冲突。
 *
 * 稍后启用（需要工作）：
 * - MCPTool：待定
 * - ListMcpResourcesTool：待定
 * - ReadMcpResourceTool：待定
 */

/**
 * coordinator 模式中允许的工具 — 仅 coordinator 的输出和代理管理工具
 */
export const COORDINATOR_MODE_ALLOWED_TOOLS = new Set([
  AGENT_TOOL_NAME,
  TASK_STOP_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  SYNTHETIC_OUTPUT_TOOL_NAME,
])

/**
 * 初始化时始终加载完整 schema 的核心工具。
 * 这些工具永不被延迟 — 它们出现在初始提示中。
 * 所有其他工具（非核心内置 + 所有 MCP 工具）被延迟，
 * 必须通过 SearchExtraToolsTool / ExecuteExtraTool 发现。
 */
export const CORE_TOOLS = new Set([
  // 文件操作
  ...SHELL_TOOL_NAMES, // 'Bash', 'Shell'
  FILE_READ_TOOL_NAME, // 'Read'
  FILE_EDIT_TOOL_NAME, // 'Edit'
  FILE_WRITE_TOOL_NAME, // 'Write'
  GLOB_TOOL_NAME, // 'Glob'
  GREP_TOOL_NAME, // 'Grep'
  NOTEBOOK_EDIT_TOOL_NAME, // 'NotebookEdit'
  // 代理与交互
  AGENT_TOOL_NAME, // 'Agent'
  ASK_USER_QUESTION_TOOL_NAME, // 'AskUserQuestion'
  // 任务管理
  TASK_OUTPUT_TOOL_NAME, // 'TaskOutput'
  TASK_STOP_TOOL_NAME, // 'TaskStop'
  TASK_CREATE_TOOL_NAME, // 'TaskCreate'
  TASK_GET_TOOL_NAME, // 'TaskGet'
  TASK_LIST_TOOL_NAME, // 'TaskList'
  TASK_UPDATE_TOOL_NAME, // 'TaskUpdate'
  TODO_WRITE_TOOL_NAME, // 'TodoWrite'
  // 计划
  ENTER_PLAN_MODE_TOOL_NAME, // 'EnterPlanMode'
  EXIT_PLAN_MODE_V2_TOOL_NAME, // 'ExitPlanMode'
  VERIFY_PLAN_EXECUTION_TOOL_NAME, // 'VerifyPlanExecution'
  // Web 相关
  WEB_FETCH_TOOL_NAME, // 'WebFetch'
  WEB_SEARCH_TOOL_NAME, // 'WebSearch'
  // 代码智能
  LSP_TOOL_NAME, // 'LSP'
  // 技能
  SKILL_TOOL_NAME, // 'Skill'
  // 工作流编排 — 一等原语 /ultracode 指示模型直接调用。
  // 保持为核心（不延迟），以便始终可见且可调用，无需
  // SearchExtraTools 往返。注册本身仍在 tools.ts 中
  // 受功能标志控制（feature('WORKFLOW_SCRIPTS')）。
  WORKFLOW_TOOL_NAME, // 'Workflow'
  // 调度与监控
  SLEEP_TOOL_NAME, // 'Sleep'
  // 工具发现（始终加载）
  SEARCH_EXTRA_TOOLS_TOOL_NAME, // 'SearchExtraTools'
  EXECUTE_TOOL_NAME, // 'ExecuteExtraTool'
  SYNTHETIC_OUTPUT_TOOL_NAME, // 'SyntheticOutput'
]) as ReadonlySet<string>
