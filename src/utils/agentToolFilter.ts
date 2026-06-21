/**
 * filterParentToolsForFork — 子代理工具继承的门控层 2。
 *
 * AgentTool 的 fork 路径（及其同级的 resumeAgent）设置
 * `useExactTools: true` 并将 `toolUseContext.options.tools` 作为
 * `availableTools` 传递给 `runAgent`。当 `useExactTools=true` 时，
 * runAgent 跳过 `resolveAgentTools`，这意味着门控层 1
 * （`ALL_AGENT_DISALLOWED_TOOLS`）—— 只在 `filterToolsForAgent` 内生效
 * —— 在 fork 路径上被完全绕过。
 *
 * 此过滤器在父工具数组到达 fork 之前应用相同的禁止列表。
 * 新 fork（AgentTool.tsx）和恢复 fork（resumeAgent.ts）路径都必须调用此函数。
 *
 * 设计理由参见 docs/jira/LOCAL-WIRING-DESIGN.md §4.5 / §5.5。
 */

import { ALL_AGENT_DISALLOWED_TOOLS } from '../constants/tools.js'
import type { Tool } from '../Tool.js'

export function filterParentToolsForFork(parentTools: readonly Tool[]): Tool[] {
  return parentTools.filter(t => !ALL_AGENT_DISALLOWED_TOOLS.has(t.name))
}
