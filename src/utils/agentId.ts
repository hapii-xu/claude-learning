/**
 * 确定性 Agent ID 系统
 *
 * 本模块为群组/队友系统中使用的确定性 agent ID
 * 提供格式化和解析的辅助函数。
 *
 * ## ID 格式
 *
 * **Agent IDs**: `agentName@teamName`
 * - 示例：`team-lead@my-project`、`researcher@my-project`
 * - @ 符号作为 agent 名称和团队名称之间的分隔符
 *
 * **Request IDs**: `{requestType}-{timestamp}@{agentId}`
 * - 示例：`shutdown-1702500000000@researcher@my-project`
 * - 用于关闭请求、计划批准等
 *
 * ## 为什么使用确定性 ID？
 *
 * 确定性 ID 提供以下好处：
 *
 * 1. **可重现性**：在同一团队中以相同名称生成的相同 agent
 *    始终获得相同的 ID，从而在崩溃/重启后可以重新连接。
 *
 * 2. **人类可读**：ID 是有意义的且可调试的（例如，`tester@my-project`）。
 *
 * 3. **可预测**：团队负责人可以在不查找的情况下计算队友的 ID，
 *    简化消息路由和任务分配。
 *
 * ## 约束
 *
 * - Agent 名称不能包含 `@`（因为它用作分隔符）
 * - 使用 TeammateTool.ts 中的 `sanitizeAgentName()` 来从名称中去除 @
 */

/**
 * 以 `agentName@teamName` 格式格式化 agent ID。
 */
export function formatAgentId(agentName: string, teamName: string): string {
  return `${agentName}@${teamName}`
}

/**
 * 将 agent ID 解析为其组件。
 * 如果 ID 不包含 @ 分隔符则返回 null。
 */
export function parseAgentId(
  agentId: string,
): { agentName: string; teamName: string } | null {
  const atIndex = agentId.indexOf('@')
  if (atIndex === -1) {
    return null
  }
  return {
    agentName: agentId.slice(0, atIndex),
    teamName: agentId.slice(atIndex + 1),
  }
}

/**
 * 以 `{requestType}-{timestamp}@{agentId}` 格式格式化请求 ID。
 */
export function generateRequestId(
  requestType: string,
  agentId: string,
): string {
  const timestamp = Date.now()
  return `${requestType}-${timestamp}@${agentId}`
}
