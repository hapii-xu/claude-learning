import type { AgentColorName } from '@claude-code-best/builtin-tools/tools/AgentTool/agentColorManager.js'
import { AGENT_COLORS } from '@claude-code-best/builtin-tools/tools/AgentTool/agentColorManager.js'
import { detectAndGetBackend } from './backends/registry.js'
import type { PaneBackend } from './backends/types.js'

// 追踪 teammate 的颜色分配（每个会话持久化）
const teammateColorAssignments = new Map<string, AgentColorName>()
let colorIndex = 0

/**
 * 获取当前环境的适当后端。
 * detectAndGetBackend() 在内部缓存 — 这里不需要第二个缓存。
 */
async function getBackend(): Promise<PaneBackend> {
  return (await detectAndGetBackend()).backend
}

/**
 * 从可用调色板中为 teammate 分配唯一颜色。
 * 颜色按循环顺序分配。
 */
export function assignTeammateColor(teammateId: string): AgentColorName {
  const existing = teammateColorAssignments.get(teammateId)
  if (existing) {
    return existing
  }

  const color = AGENT_COLORS[colorIndex % AGENT_COLORS.length]!
  teammateColorAssignments.set(teammateId, color)
  colorIndex++

  return color
}

/** 获取 teammate 的已分配颜色（如果有）。 */
export function getTeammateColor(
  teammateId: string,
): AgentColorName | undefined {
  return teammateColorAssignments.get(teammateId)
}

/**
 * 清除所有 teammate 颜色分配。
 * 在团队清理期间调用以重置状态供潜在的新团队使用。
 */
export function clearTeammateColors(): void {
  teammateColorAssignments.clear()
  colorIndex = 0
}

/**
 * 检查当前是否在 tmux 会话内运行。
 * 直接使用检测模块进行此检查。
 */
export async function isInsideTmux(): Promise<boolean> {
  const { isInsideTmux: checkTmux } = await import('./backends/detection.js')
  return checkTmux()
}

/**
 * 在 swarm 视图中创建新的 teammate 面板。
 * 根据环境自动选择适当的后端（tmux 或 iTerm2）。
 *
 * 在 tmux 内部运行时：
 * - 使用 TmuxBackend 分割当前窗口
 * - Leader 在左侧（30%），teammate 在右侧（70%）
 *
 * 在 iTerm2 中（不在 tmux 中）且使用 it2 CLI 运行时：
 * - 使用 ITermBackend 进行原生 iTerm2 分割面板
 *
 * 在 tmux/iTerm2 外部运行时：
 * - 回退到 TmuxBackend 并使用外部 claude-swarm 会话
 */
export async function createTeammatePaneInSwarmView(
  teammateName: string,
  teammateColor: AgentColorName,
): Promise<{ paneId: string; isFirstTeammate: boolean }> {
  const backend = await getBackend()
  return backend.createTeammatePaneInSwarmView(teammateName, teammateColor)
}

/**
 * 启用窗口的面板边框状态（显示面板标题）。
 * 委托给检测到的后端。
 */
export async function enablePaneBorderStatus(
  windowTarget?: string,
  useSwarmSocket = false,
): Promise<void> {
  const backend = await getBackend()
  return backend.enablePaneBorderStatus(windowTarget, useSwarmSocket)
}

/**
 * 向特定面板发送命令。
 * 委托给检测到的后端。
 */
export async function sendCommandToPane(
  paneId: string,
  command: string,
  useSwarmSocket = false,
): Promise<void> {
  const backend = await getBackend()
  return backend.sendCommandToPane(paneId, command, useSwarmSocket)
}
