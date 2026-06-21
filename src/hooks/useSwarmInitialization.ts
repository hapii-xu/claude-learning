/**
 * Swarm 初始化 Hook
 *
 * 初始化 swarm 功能：teammate hook 和 context。
 * 处理新 spawn 和恢复的 teammate 会话。
 *
 * 此 hook 条件加载，以允许在 swarm 禁用时死代码消除。
 */

import { useEffect } from 'react'
import { getSessionId } from '../bootstrap/state.js'
import type { AppState } from '../state/AppState.js'
import type { Message } from '../types/message.js'
import { isAgentSwarmsEnabled } from '../utils/agentSwarmsEnabled.js'
import { initializeTeammateContextFromSession } from '../utils/swarm/reconnection.js'
import { readTeamFile } from '../utils/swarm/teamHelpers.js'
import { initializeTeammateHooks } from '../utils/swarm/teammateInit.js'
import { getDynamicTeamContext } from '../utils/teammate.js'

type SetAppState = (f: (prevState: AppState) => AppState) => void

/**
 * ENABLE_AGENT_SWARMS 为 true 时初始化 swarm 功能的 hook。
 *
 * 处理：
 * - 恢复的 teammate 会话（来自 --resume 或 /resume），teamName/agentName
 *   存储在 transcript 消息中
 * - 新 spawn，context 从环境变量读取
 */
export function useSwarmInitialization(
  setAppState: SetAppState,
  initialMessages: Message[] | undefined,
  { enabled = true }: { enabled?: boolean } = {},
): void {
  useEffect(() => {
    if (!enabled) return
    if (isAgentSwarmsEnabled()) {
      // 检查这是否是恢复的 agent 会话（来自 --resume 或 /resume）
      // 恢复的会话在 transcript 消息中存储 teamName/agentName
      const firstMessage = initialMessages?.[0]
      const teamName =
        firstMessage && 'teamName' in firstMessage
          ? (firstMessage.teamName as string | undefined)
          : undefined
      const agentName =
        firstMessage && 'agentName' in firstMessage
          ? (firstMessage.agentName as string | undefined)
          : undefined

      if (teamName && agentName) {
        // 恢复的 agent 会话 —— 从存储的信息设置 team context
        initializeTeammateContextFromSession(setAppState, teamName, agentName)

        // 从 team 文件获取 agentId 用于 hook 初始化
        const teamFile = readTeamFile(teamName)
        const member = teamFile?.members.find(
          (m: { name: string }) => m.name === agentName,
        )
        if (member) {
          initializeTeammateHooks(setAppState, getSessionId(), {
            teamName,
            agentId: member.agentId,
            agentName,
          })
        }
      } else {
        // 新 spawn 或独立会话
        // teamContext 已在 main.tsx 中通过 computeInitialTeamContext() 计算
        // 并包含在 initialState 中，所以我们这里只需初始化 hook
        const context = getDynamicTeamContext?.()
        if (context?.teamName && context?.agentId && context?.agentName) {
          initializeTeammateHooks(setAppState, getSessionId(), {
            teamName: context.teamName,
            agentId: context.agentId,
            agentName: context.agentName,
          })
        }
      }
    }
  }, [setAppState, initialMessages, enabled])
}
