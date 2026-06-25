/**
 * goal 完成与阻塞评估的审计规则常量。
 * 由 prompt 模板和集成测试共用。
 */
import { BLOCKED_CONSECUTIVE_THRESHOLD, MAX_GOAL_TURNS } from './goalState.js'
import type { GoalStatus } from '../../types/logs.js'

export { BLOCKED_CONSECUTIVE_THRESHOLD, MAX_GOAL_TURNS }

export const COMPLETION_AUDIT_RULES = [
  '从目标和任何引用文件中推导出具体需求。',
  '保持原始 scope——不要根据已完成的内容重新定义成功标准。',
  '对每个明确需求，找出权威证据（测试输出、文件内容、命令结果）。',
  '只有在确认测试、manifest 和验证器确实覆盖该需求后，才将其视为证据。',
  '将不确定或间接的证据视为"未达成"。',
  '审计必须证明完成，而不仅仅是未找到剩余工作。',
] as const

export const BLOCKED_AUDIT_RULES = [
  '相同的阻塞条件必须在至少 3 个连续 continuation turn 中持续存在。',
  '"困难"、"缓慢"或"部分未完成"不算被阻塞。',
  '只有真正无法克服的障碍才符合条件（缺少凭证、外部服务宕机等）。',
] as const

export function isGoalTerminal(status: GoalStatus): boolean {
  return (
    status === 'complete' ||
    status === 'blocked' ||
    status === 'budget_limited' ||
    status === 'usage_limited' ||
    status === 'max_turns'
  )
}
