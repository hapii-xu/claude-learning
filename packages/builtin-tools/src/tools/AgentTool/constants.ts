export const AGENT_TOOL_NAME = 'Agent'
// 向后兼容的旧名称（权限规则、hooks、恢复的会话）
export const LEGACY_AGENT_TOOL_NAME = 'Task'
export const VERIFICATION_AGENT_TYPE = 'verification'

// 运行一次并返回报告的内置代理——父代理永远不会
// 通过 SendMessages 继续它们。跳过这些代理的 agentId/SendMessage/usage
// 尾部信息以节省 token（约 135 字符 × 每周 3400 万次 Explore 运行）。
export const ONE_SHOT_BUILTIN_AGENT_TYPES: ReadonlySet<string> = new Set([
  'Explore',
  'Plan',
])
