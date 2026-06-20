/**
 * Coordinator 模式下的 worker agent 定义。
 *
 * 当 COORDINATOR_MODE 激活时，getBuiltInAgents() 只返回
 * getCoordinatorAgents() 提供的 agent。coordinator 的系统提示会指示
 * 它在通过 Agent 工具派发任务时使用 `subagent_type: "worker"`。
 *
 * Worker 拥有完整的标准工具集（去掉 TeamCreate/SendMessage 这类内部编排工具），
 * 以便能够自主地完成研究、实现和验证工作。
 */
import { ASYNC_AGENT_ALLOWED_TOOLS } from '../constants/tools.js'
import { SEND_MESSAGE_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/SendMessageTool/constants.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/SyntheticOutputTool/SyntheticOutputTool.js'
import { TEAM_CREATE_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/TeamCreateTool/constants.js'
import { TEAM_DELETE_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/TeamDeleteTool/constants.js'
import type { BuiltInAgentDefinition } from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js'

/**
 * Worker 不允许拥有的工具 —— 这些是 coordinator 专用的编排原语。
 */
const INTERNAL_ORCHESTRATION_TOOLS = new Set([
  TEAM_CREATE_TOOL_NAME,
  TEAM_DELETE_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  SYNTHETIC_OUTPUT_TOOL_NAME,
])

/**
 * 基于 ASYNC_AGENT_ALLOWED_TOOLS 构建 worker 允许使用的工具列表，
 * 排除内部编排工具。
 */
function getWorkerTools(): string[] {
  return Array.from(ASYNC_AGENT_ALLOWED_TOOLS).filter(
    name => !INTERNAL_ORCHESTRATION_TOOLS.has(name),
  )
}

const WORKER_AGENT: BuiltInAgentDefinition = {
  agentType: 'worker',
  whenToUse:
    'Worker agent for coordinator mode. Executes research, implementation, and verification tasks autonomously with the full standard tool set.',
  tools: getWorkerTools(),
  source: 'built-in',
  baseDir: 'built-in',
  getSystemPrompt: () =>
    `You are a worker agent spawned by a coordinator. Your job is to complete the task described in the prompt thoroughly and report back with a concise summary of what you did and what you found.

Guidelines:
- Complete the task fully — don't leave it half-done, but don't gold-plate either.
- Use tools proactively: read files, search code, run commands, edit files.
- Be thorough in research: check multiple locations, consider different naming conventions.
- For implementation: make targeted changes, run tests to verify, commit if appropriate.
- Report back with actionable findings — the coordinator will synthesize your results.
- If you encounter errors, investigate and attempt to fix them before reporting failure.
- NEVER create documentation files unless explicitly instructed.`,
}

/**
 * 返回 coordinator 模式下可用的 agent 定义。
 * 当 COORDINATOR_MODE 激活时由 getBuiltInAgents() 调用。
 */
export function getCoordinatorAgents(): BuiltInAgentDefinition[] {
  return [WORKER_AGENT]
}
