/**
 * session ID 与 agent ID 的 branded 类型。
 * 这些类型在编译期防止把 session ID 与 agent ID 混用。
 */

/**
 * session ID 唯一标识一个 Claude Code session。
 * 由 getSessionId() 返回。
 */
export type SessionId = string & { readonly __brand: 'SessionId' }

/**
 * agent ID 唯一标识 session 内的一个 subagent。
 * 由 createAgentId() 返回。
 * 存在时表示上下文是 subagent（而非主 session）。
 */
export type AgentId = string & { readonly __brand: 'AgentId' }

/**
 * 将原始字符串转换为 SessionId。
 * 谨慎使用 —— 可能的话优先使用 getSessionId()。
 */
export function asSessionId(id: string): SessionId {
  return id as SessionId
}

/**
 * 将原始字符串转换为 AgentId。
 * 谨慎使用 —— 可能的话优先使用 createAgentId()。
 */
export function asAgentId(id: string): AgentId {
  return id as AgentId
}

const AGENT_ID_PATTERN = /^a(?:.+-)?[0-9a-f]{16}$/

/**
 * 校验字符串并将其 brand 为 AgentId。
 * 匹配 createAgentId() 产出的格式：`a` + 可选 `<label>-` + 16 位 hex 字符。
 * 字符串不匹配时（例如 teammate 名、team 寻址）返回 null。
 */
export function toAgentId(s: string): AgentId | null {
  return AGENT_ID_PATTERN.test(s) ? (s as AgentId) : null
}
