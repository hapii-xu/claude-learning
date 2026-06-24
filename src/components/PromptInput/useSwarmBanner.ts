import * as React from 'react'
import { useAppState, useAppStateStore } from '../../state/AppState.js'
import {
  getActiveAgentForInput,
  getViewedTeammateTask,
} from '../../state/selectors.js'
import {
  AGENT_COLOR_TO_THEME_COLOR,
  AGENT_COLORS,
  type AgentColorName,
  getAgentColor,
} from '@claude-code-best/builtin-tools/tools/AgentTool/agentColorManager.js'
import { getStandaloneAgentName } from '../../utils/standaloneAgent.js'
import { isInsideTmux } from '../../utils/swarm/backends/detection.js'
import {
  getCachedDetectionResult,
  isInProcessEnabled,
} from '../../utils/swarm/backends/registry.js'
import { getSwarmSocketName } from '../../utils/swarm/constants.js'
import {
  getAgentName,
  getTeammateColor,
  getTeamName,
  isTeammate,
} from '../../utils/teammate.js'
import { isInProcessTeammate } from '../../utils/teammateContext.js'
import type { Theme } from '../../utils/theme.js'

type SwarmBannerInfo = {
  text: string
  bgColor: keyof Theme
} | null

/**
 * 返回 swarm、独立 agent 或 --agent CLI 上下文中横幅信息的 hook。
 * - Leader（不在 tmux 中）：返回带青色背景的「tmux -L ... attach」命令
 * - Leader（在 tmux / 进程内）：转入独立 agent 检查 —— 如果设置了
 *   /rename 名称 + /color 背景则显示，否则返回 null
 * - 团队成员：返回「teammate@team」格式，使用其分配的颜色背景
 * - 查看后台 agent（CoordinatorTaskPanel）：返回 agent 名称及其颜色
 * - 独立 agent：返回带颜色背景的 agent 名称（无 @team）
 * - --agent CLI 标志：返回带青色背景的「@agentName」
 */
export function useSwarmBanner(): SwarmBannerInfo {
  const teamContext = useAppState(s => s.teamContext)
  const standaloneAgentContext = useAppState(s => s.standaloneAgentContext)
  const agent = useAppState(s => s.agent)
  // 订阅以便在进入/退出团队成员视图时更新横幅，
  // 即使 getActiveAgentForInput 从 store.getState() 读取。
  useAppState(s => s.viewingAgentTaskId)
  const store = useAppStateStore()
  const [insideTmux, setInsideTmux] = React.useState<boolean | null>(null)

  React.useEffect(() => {
    void isInsideTmux().then(setInsideTmux)
  }, [])

  const state = store.getState()

  // 团队成员进程：显示带分配颜色的 @agentName。
  // 进程内团队成员以无界面模式运行 —— 其横幅改在 leader UI 中显示。
  if (isTeammate() && !isInProcessTeammate()) {
    const agentName = getAgentName()
    if (agentName && getTeamName()) {
      return {
        text: `@${agentName}`,
        bgColor: toThemeColor(
          teamContext?.selfAgentColor ?? getTeammateColor(),
        ),
      }
    }
  }

  // 有已生成团队成员的 Leader：外部时显示 tmux-attach 提示，
  // 在 tmux / 原生面板 / 进程内时显示所查看团队成员的名称。
  const hasTeammates =
    teamContext?.teamName &&
    teamContext.teammates &&
    Object.keys(teamContext.teammates).length > 0
  if (hasTeammates) {
    const viewedTeammate = getViewedTeammateTask(state)
    const viewedColor = toThemeColor(viewedTeammate?.identity.color)
    const inProcessMode = isInProcessEnabled()
    const detection = getCachedDetectionResult()
    const nativePanes = detection?.isNative ?? false
    const backendType = detection?.backend.type

    if (insideTmux === false && !inProcessMode && !nativePanes) {
      const hint =
        backendType === 'windows-terminal'
          ? '在为每个队友生成的 Windows Terminal 标签页中查看队友'
          : `查看队友：\`tmux -L ${getSwarmSocketName()} a\``
      return {
        text: hint,
        bgColor: viewedColor,
      }
    }
    if (
      (insideTmux === true || inProcessMode || nativePanes) &&
      viewedTeammate
    ) {
      return {
        text: `@${viewedTeammate.identity.agentName}`,
        bgColor: viewedColor,
      }
    }
    // insideTmux === null：仍在加载中 —— 跳过。
    // 未查看团队成员：跳过，以便 /rename 和 /color 生效。
  }

  // 查看后台 agent（CoordinatorTaskPanel）：local_agent 任务不是
  // InProcessTeammates，因此 getViewedTeammateTask 会遗漏它们。
  // 以与 CoordinatorAgentStatus 相同的方式从 agentNameRegistry 反向查找名称。
  const active = getActiveAgentForInput(state)
  if (active.type === 'named_agent') {
    const task = active.task
    let name: string | undefined
    for (const [n, id] of state.agentNameRegistry) {
      if (id === task.id) {
        name = n
        break
      }
    }
    return {
      text: name ? `@${name}` : task.description,
      bgColor: getAgentColor(task.agentType) ?? 'cyan_FOR_SUBAGENTS_ONLY',
    }
  }

  // 独立 agent（/rename、/color）：名称和/或自定义颜色，无 @team。
  const standaloneName = getStandaloneAgentName(state)
  const standaloneColor = standaloneAgentContext?.color
  if (standaloneName || standaloneColor) {
    return {
      text: standaloneName ?? '',
      bgColor: toThemeColor(standaloneColor),
    }
  }

  // --agent CLI 标志（未在上方处理时）。
  if (agent) {
    const agentDef = state.agentDefinitions.activeAgents.find(
      a => a.agentType === agent,
    )
    return {
      text: agent,
      bgColor: toThemeColor(agentDef?.color, 'promptBorder'),
    }
  }

  return null
}

function toThemeColor(
  colorName: string | undefined,
  fallback: keyof Theme = 'cyan_FOR_SUBAGENTS_ONLY',
): keyof Theme {
  return colorName && AGENT_COLORS.includes(colorName as AgentColorName)
    ? AGENT_COLOR_TO_THEME_COLOR[colorName as AgentColorName]
    : fallback
}
