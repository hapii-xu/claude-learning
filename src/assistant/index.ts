import { readFileSync } from 'fs'
import { join } from 'path'
import { getKairosActive, getSessionId } from '../bootstrap/state.js'
import type { AppState } from '../state/AppState.js'
import { formatAgentId } from '../utils/agentId.js'
import { getCwd } from '../utils/cwd.js'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { TEAM_LEAD_NAME } from '../utils/swarm/constants.js'
import {
  getTeamFilePath,
  registerTeamForSessionCleanup,
  sanitizeName,
  writeTeamFileAsync,
  type TeamFile,
} from '../utils/swarm/teamHelpers.js'
import { assignTeammateColor } from '../utils/swarm/teammateLayoutManager.js'
import {
  ensureTasksDir,
  resetTaskList,
  setLeaderTeamName,
} from '../utils/tasks.js'

let _assistantForced = false

/**
 * 当前会话是否处于 assistant（KAIROS）daemon 模式。
 * 封装 bootstrap 中的 kairosActive 状态，该状态由 main.tsx 在门控检查后设置。
 */
export function isAssistantMode(): boolean {
  return getKairosActive()
}

/**
 * 将当前会话标记为强制 assistant 模式（--assistant flag）。
 * 跳过 GrowthBook 门控检查 — daemon 已预先授权。
 */
export function markAssistantForced(): void {
  _assistantForced = true
}

export function isAssistantForced(): boolean {
  return _assistantForced
}

/**
 * 预创建一个进程内 team，使 Agent(name) 无需 TeamCreate 即可派生 teammates。
 *
 * 创建一个会话级 assistant team 文件，并返回一个与 AppState.teamContext
 * 匹配的完整 team context 对象。
 */
export async function initializeAssistantTeam(): Promise<
  AppState['teamContext']
> {
  const sessionId = getSessionId()
  const teamName = sanitizeName(`assistant-${sessionId.slice(0, 8)}`)
  const leadAgentId = formatAgentId(TEAM_LEAD_NAME, teamName)
  const teamFilePath = getTeamFilePath(teamName)
  const now = Date.now()
  const cwd = getCwd()
  const color = assignTeammateColor(leadAgentId)

  const teamFile: TeamFile = {
    name: teamName,
    description: 'Assistant mode in-process team',
    createdAt: now,
    leadAgentId,
    leadSessionId: sessionId,
    members: [
      {
        agentId: leadAgentId,
        name: TEAM_LEAD_NAME,
        agentType: 'assistant',
        color,
        joinedAt: now,
        tmuxPaneId: '',
        cwd,
        subscriptions: [],
        backendType: 'in-process',
      },
    ],
  }

  await writeTeamFileAsync(teamName, teamFile)
  registerTeamForSessionCleanup(teamName)
  await resetTaskList(teamName)
  await ensureTasksDir(teamName)
  setLeaderTeamName(teamName)

  return {
    teamName,
    teamFilePath,
    leadAgentId,
    selfAgentId: leadAgentId,
    selfAgentName: TEAM_LEAD_NAME,
    isLeader: true,
    selfAgentColor: color,
    teammates: {
      [leadAgentId]: {
        name: TEAM_LEAD_NAME,
        agentType: 'assistant',
        color,
        tmuxSessionName: 'in-process',
        tmuxPaneId: 'leader',
        cwd,
        spawnedAt: now,
      },
    },
  }
}

/**
 * 从 ~/.hclaude/agents/assistant.md 加载的 assistant 专属 system prompt 补充内容。
 * 文件不存在时返回空字符串。
 */
export function getAssistantSystemPromptAddendum(): string {
  try {
    return readFileSync(
      join(getClaudeConfigHomeDir(), 'agents', 'assistant.md'),
      'utf-8',
    )
  } catch {
    return ''
  }
}

/**
 * assistant 模式的激活方式。用于诊断/分析。
 * - 'daemon'：通过 --assistant flag（Agent SDK daemon）
 * - 'gate'：通过 GrowthBook 门控检查
 */
export function getAssistantActivationPath(): string | undefined {
  if (!isAssistantMode()) return undefined
  return _assistantForced ? 'daemon' : 'gate'
}
