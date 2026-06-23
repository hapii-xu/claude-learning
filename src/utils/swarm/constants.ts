export const TEAM_LEAD_NAME = 'team-lead'
export const SWARM_SESSION_NAME = 'claude-swarm'
export const SWARM_VIEW_WINDOW_NAME = 'swarm-view'
export const TMUX_COMMAND = 'tmux'
export const HIDDEN_SESSION_NAME = 'claude-hidden'

/**
 * 获取外部 swarm 会话的 socket 名称（当用户不在 tmux 中时）。
 * 使用独立的 socket 将 swarm 操作与用户的 tmux 会话隔离开来。
 * 包含 PID 以确保多个 Claude 实例不会冲突。
 */
export function getSwarmSocketName(): string {
  return `claude-swarm-${process.pid}`
}

/**
 * 用于覆盖生成 teammate 实例所用命令的环境变量。
 * 如未设置，则默认使用 process.execPath（当前 Claude 二进制文件）。
 * 允许针对不同环境或测试进行自定义。
 */
export const TEAMMATE_COMMAND_ENV_VAR = 'CLAUDE_CODE_TEAMMATE_COMMAND'

/**
 * 在生成的 teammate 上设置的环境变量，用于指示其分配的颜色。
 * 用于彩色输出和面板识别。
 */
export const TEAMMATE_COLOR_ENV_VAR = 'CLAUDE_CODE_AGENT_COLOR'

/**
 * 在生成的 teammate 上设置的环境变量，用于要求在实现前进入计划模式。
 * 当设置为 'true' 时，teammate 必须进入计划模式并在编写代码前获得批准。
 */
export const PLAN_MODE_REQUIRED_ENV_VAR = 'CLAUDE_CODE_PLAN_MODE_REQUIRED'
