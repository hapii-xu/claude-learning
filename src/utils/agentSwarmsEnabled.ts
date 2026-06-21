import { isEnvTruthy } from './envUtils.js'

/**
 * agent 团队/队友功能的集中运行时检查。
 * 这是在所有引用队友的地方（提示、代码、工具 isEnabled、UI 等）
 * 应该检查的唯一网关。
 *
 * Fork 构建：默认启用。可以通过
 * CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=0 禁用（如需要）。
 */
export function isAgentSwarmsEnabled(): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS_DISABLED)) {
    return false
  }

  return true
}
