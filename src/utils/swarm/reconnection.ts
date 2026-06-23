/**
 * Swarm 重连模块
 *
 * 处理 teammate 的 swarm 上下文初始化。
 * - 全新生成：从 CLI 参数初始化（在 main.tsx 中通过 dynamicTeamContext 设置）
 * - 恢复的会话：从 transcript 中存储的 teamName/agentName 初始化
 */

import type { AppState } from '../../state/AppState.js'
import { logForDebugging } from '../debug.js'
import { logError } from '../log.js'
import { getDynamicTeamContext } from '../teammate.js'
import { getTeamFilePath, readTeamFile } from './teamHelpers.js'

/**
 * 计算 AppState 的初始 teamContext。
 *
 * 这在 main.tsx 中同步调用，在首次渲染之前计算 teamContext，
 * 无需 useEffect 变通方案。
 *
 * @returns 要包含在 initialState 中的 teamContext 对象，如果不是 teammate 则返回 undefined
 */
export function computeInitialTeamContext():
  | AppState['teamContext']
  | undefined {
  // dynamicTeamContext is set in main.tsx from CLI args
  const context = getDynamicTeamContext()

  if (!context?.teamName || !context?.agentName) {
    logForDebugging(
      '[Reconnection] computeInitialTeamContext: No teammate context set (not a teammate)',
    )
    return undefined
  }

  const { teamName, agentId, agentName } = context

  // 读取团队文件以获取 leader agent ID
  const teamFile = readTeamFile(teamName)
  if (!teamFile) {
    logError(
      new Error(
        `[computeInitialTeamContext] Could not read team file for ${teamName}`,
      ),
    )
    return undefined
  }

  const teamFilePath = getTeamFilePath(teamName)

  const isLeader = !agentId

  logForDebugging(
    `[Reconnection] Computed initial team context for ${isLeader ? 'leader' : `teammate ${agentName}`} in team ${teamName}`,
  )

  return {
    teamName,
    teamFilePath,
    leadAgentId: teamFile.leadAgentId,
    selfAgentId: agentId,
    selfAgentName: agentName,
    isLeader,
    teammates: {},
  }
}

/**
 * 从恢复的会话初始化 teammate 上下文。
 *
 * 当恢复在 transcript 中存储了 teamName/agentName 的会话时调用。
 * 它在 AppState 中设置 teamContext 以便心跳和其他 swarm 功能正常工作。
 */
export function initializeTeammateContextFromSession(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  teamName: string,
  agentName: string,
): void {
  // 读取团队文件以获取 leader agent ID
  const teamFile = readTeamFile(teamName)
  if (!teamFile) {
    logError(
      new Error(
        `[initializeTeammateContextFromSession] Could not read team file for ${teamName} (agent: ${agentName})`,
      ),
    )
    return
  }

  // 在团队文件中查找成员以获取其 agentId
  const member = teamFile.members.find(m => m.name === agentName)
  if (!member) {
    logForDebugging(
      `[Reconnection] Member ${agentName} not found in team ${teamName} - may have been removed`,
    )
  }
  const agentId = member?.agentId

  const teamFilePath = getTeamFilePath(teamName)

  // 在 AppState 中设置 teamContext
  setAppState(prev => ({
    ...prev,
    teamContext: {
      teamName,
      teamFilePath,
      leadAgentId: teamFile.leadAgentId,
      selfAgentId: agentId,
      selfAgentName: agentName,
      isLeader: false,
      teammates: {},
    },
  }))

  logForDebugging(
    `[Reconnection] Initialized agent context from session for ${agentName} in team ${teamName}`,
  )
}
