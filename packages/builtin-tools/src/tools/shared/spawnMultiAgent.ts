import React from 'react'

/**
 * 用于创建 teammate 的共享 spawn 模块。
 * 从 TeammateTool 中抽取出来，以便 AgentTool 也能复用。
 */

import { getSessionId } from 'src/bootstrap/state.js'
import type { ToolUseContext } from 'src/Tool.js'
import { formatAgentId } from 'src/utils/agentId.js'
import { getGlobalConfig } from 'src/utils/config.js'
import { getCwd } from 'src/utils/cwd.js'
import { logForDebugging } from 'src/utils/debug.js'
import { parseUserSpecifiedModel } from 'src/utils/model/model.js'
import { getTeammateExecutor } from 'src/utils/swarm/backends/registry.js'
import type {
  BackendType,
  TeammateSpawnResult,
} from 'src/utils/swarm/backends/types.js'
import {
  SWARM_SESSION_NAME,
  TEAM_LEAD_NAME,
} from 'src/utils/swarm/constants.js'
import { It2SetupPrompt } from 'src/utils/swarm/It2SetupPrompt.js'
import {
  getTeamFilePath,
  readTeamFileAsync,
  sanitizeAgentName,
  writeTeamFileAsync,
  type TeamFile,
} from 'src/utils/swarm/teamHelpers.js'
import { assignTeammateColor } from 'src/utils/swarm/teammateLayoutManager.js'
import { getHardcodedTeammateModelFallback } from 'src/utils/swarm/teammateModel.js'
import type { CustomAgentDefinition } from '../AgentTool/loadAgentsDir.js'
import { isCustomAgent } from '../AgentTool/loadAgentsDir.js'

function getDefaultTeammateModel(leaderModel: string | null): string {
  const configured = getGlobalConfig().teammateDefaultModel
  if (configured === null) {
    // 用户在 /config 选择器中选择了 "Default" — 跟随 leader。
    return leaderModel ?? getHardcodedTeammateModelFallback()
  }
  if (configured !== undefined) {
    return parseUserSpecifiedModel(configured)
  }
  return getHardcodedTeammateModelFallback()
}

/**
 * 解析 teammate 的模型值。处理 'inherit' 别名（来自 agent
 * frontmatter），将其替换为 leader 的模型。gh-31069：'inherit' 曾被
 * 原样传给 --model，导致出现 "It may not exist or you may not have access"。
 * 如果 leader 模型为 null（尚未设置），则回退到默认值。
 *
 * 导出用于测试。
 */
export function resolveTeammateModel(
  inputModel: string | undefined,
  leaderModel: string | null,
): string {
  if (inputModel === 'inherit') {
    return leaderModel ?? getDefaultTeammateModel(leaderModel)
  }
  return inputModel ?? getDefaultTeammateModel(leaderModel)
}

// ============================================================================
// 类型
// ============================================================================

export type SpawnOutput = {
  teammate_id: string
  agent_id: string
  agent_type?: string
  model?: string
  name: string
  color?: string
  tmux_session_name: string
  tmux_window_name: string
  tmux_pane_id: string
  team_name?: string
  is_splitpane?: boolean
  plan_mode_required?: boolean
}

export type SpawnTeammateConfig = {
  name: string
  prompt: string
  team_name?: string
  cwd?: string
  use_splitpane?: boolean
  plan_mode_required?: boolean
  model?: string
  agent_type?: string
  description?: string
  /** API 调用的 request_id，该调用的响应中包含了生成此 teammate 的 tool_use。
   *  透传给 TeammateAgentContext，用于 tengu_api_* 事件的血缘追踪。 */
  invokingRequestId?: string
}

// 与 TeammateTool 的 spawn 参数对应的内部输入类型
type SpawnInput = {
  name: string
  prompt: string
  team_name?: string
  cwd?: string
  use_splitpane?: boolean
  plan_mode_required?: boolean
  model?: string
  agent_type?: string
  description?: string
  invokingRequestId?: string
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 通过检查已有团队成员，生成唯一的 teammate 名称。
 * 如果该名称已存在，则附加数字后缀（例如 tester-2、tester-3）。
 * @internal 导出用于测试
 */
export async function generateUniqueTeammateName(
  baseName: string,
  teamName: string | undefined,
): Promise<string> {
  if (!teamName) {
    return baseName
  }

  const teamFile = await readTeamFileAsync(teamName)
  if (!teamFile) {
    return baseName
  }

  const existingNames = new Set(teamFile.members.map(m => m.name.toLowerCase()))

  // 如果基础名称不存在，直接使用
  if (!existingNames.has(baseName.toLowerCase())) {
    return baseName
  }

  // 查找下一个可用的后缀
  let suffix = 2
  while (existingNames.has(`${baseName}-${suffix}`.toLowerCase())) {
    suffix++
  }

  return `${baseName}-${suffix}`
}

// ============================================================================
// Spawn 处理器
// ============================================================================

type ResolvedSpawn = {
  teamName: string
  teamFile: TeamFile
  sanitizedName: string
  teammateId: string
  model: string
  teammateColor: ReturnType<typeof assignTeammateColor>
  workingDir: string
  agentDefinition?: CustomAgentDefinition
}

async function resolveSpawn(
  input: SpawnInput,
  context: ToolUseContext,
): Promise<ResolvedSpawn> {
  if (!input.name || !input.prompt) {
    throw new Error('spawn 操作需要 name 和 prompt')
  }

  const appState = context.getAppState()
  const teamName = input.team_name || appState.teamContext?.teamName
  if (!teamName) {
    throw new Error(
      'spawn 操作需要 team_name。请在输入中提供 team_name，或先调用 TeamCreate 以建立团队上下文。',
    )
  }

  const teamFile = await readTeamFileAsync(teamName)
  if (!teamFile) {
    throw new Error(
      `团队 "${teamName}" 不存在。请先调用 TeamCreate 创建团队，然后再生成 teammate。`,
    )
  }

  const uniqueName = await generateUniqueTeammateName(input.name, teamName)
  const sanitizedName = sanitizeAgentName(uniqueName)
  const teammateId = formatAgentId(sanitizedName, teamName)
  const model = resolveTeammateModel(input.model, appState.mainLoopModel)
  const teammateColor = assignTeammateColor(teammateId)
  const workingDir = input.cwd || getCwd()

  let agentDefinition: CustomAgentDefinition | undefined
  if (input.agent_type) {
    const foundAgent = context.options.agentDefinitions.activeAgents.find(
      a => a.agentType === input.agent_type,
    )
    if (foundAgent && isCustomAgent(foundAgent)) {
      agentDefinition = foundAgent
    }
    logForDebugging(
      `[spawnTeammate] agent_type=${input.agent_type}, found=${!!agentDefinition}`,
    )
  }

  return {
    teamName,
    teamFile,
    sanitizedName,
    teammateId,
    model,
    teammateColor,
    workingDir,
    agentDefinition,
  }
}

function getBackendDisplay(result: TeammateSpawnResult): {
  sessionName: string
  windowName: string
  paneId: string
  isSplitPane: boolean
} {
  if (result.backendType === 'in-process') {
    return {
      sessionName: 'in-process',
      windowName: 'in-process',
      paneId: 'in-process',
      isSplitPane: false,
    }
  }

  return {
    sessionName: result.insideTmux ? 'current' : SWARM_SESSION_NAME,
    windowName:
      result.windowName ?? (result.insideTmux ? 'current' : 'swarm-view'),
    paneId: result.paneId ?? '',
    isSplitPane: result.isSplitPane ?? true,
  }
}

function updateTeamContext(
  context: ToolUseContext,
  spawn: ResolvedSpawn,
  result: TeammateSpawnResult,
): void {
  const display = getBackendDisplay(result)

  context.setAppState(prev => {
    const leadAgentId =
      prev.teamContext?.leadAgentId || spawn.teamFile.leadAgentId
    const existingTeammates = prev.teamContext?.teammates || {}
    const needsLeaderEntry = !(leadAgentId in existingTeammates)
    const leadMember = spawn.teamFile.members.find(
      m => m.name === TEAM_LEAD_NAME,
    )

    return {
      ...prev,
      teamContext: {
        ...prev.teamContext,
        teamName: spawn.teamName,
        teamFilePath:
          prev.teamContext?.teamFilePath || getTeamFilePath(spawn.teamName),
        leadAgentId,
        teammates: {
          ...existingTeammates,
          ...(needsLeaderEntry
            ? {
                [leadAgentId]: {
                  name: TEAM_LEAD_NAME,
                  agentType: leadMember?.agentType ?? TEAM_LEAD_NAME,
                  color: assignTeammateColor(leadAgentId),
                  tmuxSessionName:
                    leadMember?.backendType === 'in-process'
                      ? 'in-process'
                      : '',
                  tmuxPaneId: leadMember?.tmuxPaneId ?? '',
                  cwd: leadMember?.cwd ?? getCwd(),
                  spawnedAt: leadMember?.joinedAt ?? Date.now(),
                },
              }
            : {}),
          [spawn.teammateId]: {
            name: spawn.sanitizedName,
            agentType: spawn.agentDefinition?.agentType,
            color: spawn.teammateColor,
            tmuxSessionName: display.sessionName,
            tmuxPaneId: display.paneId,
            cwd: spawn.workingDir,
            spawnedAt: Date.now(),
          },
        },
      },
    }
  })
}

async function appendTeamMember(
  input: SpawnInput,
  spawn: ResolvedSpawn,
  result: TeammateSpawnResult,
): Promise<void> {
  const teamFile = await readTeamFileAsync(spawn.teamName)
  if (!teamFile) {
    throw new Error(
      `团队 "${spawn.teamName}" 在生成 teammate 期间消失了。`,
    )
  }

  const display = getBackendDisplay(result)
  teamFile.members.push({
    agentId: spawn.teammateId,
    name: spawn.sanitizedName,
    agentType: input.agent_type,
    model: spawn.model,
    prompt: input.prompt,
    color: spawn.teammateColor,
    planModeRequired: input.plan_mode_required,
    joinedAt: Date.now(),
    tmuxPaneId: display.paneId,
    cwd: spawn.workingDir,
    subscriptions: [],
    backendType: result.backendType,
  })
  await writeTeamFileAsync(spawn.teamName, teamFile)
}

async function handleSpawn(
  input: SpawnInput,
  context: ToolUseContext,
): Promise<{ data: SpawnOutput }> {
  const spawn = await resolveSpawn(input, context)
  const executor = await getTeammateExecutor(true, {
    onNeedsIt2Setup: context.setToolJSX
      ? tmuxAvailable =>
          new Promise(resolve => {
            context.setToolJSX!({
              jsx: React.createElement(It2SetupPrompt, {
                onDone: result => {
                  context.setToolJSX!(null)
                  resolve(result)
                },
                tmuxAvailable,
              }),
              shouldHidePromptInput: true,
            })
          })
      : undefined,
  })
  executor.setContext?.(context)

  const result = await executor.spawn({
    name: spawn.sanitizedName,
    teamName: spawn.teamName,
    color: spawn.teammateColor,
    prompt: input.prompt,
    cwd: spawn.workingDir,
    model: spawn.model,
    agentType: input.agent_type,
    agentDefinition: spawn.agentDefinition,
    description: input.description,
    planModeRequired: input.plan_mode_required ?? false,
    parentSessionId: getSessionId(),
    invokingRequestId: input.invokingRequestId,
    useSplitPane: input.use_splitpane !== false,
  })

  if (!result.success) {
    throw new Error(result.error ?? '生成 teammate 失败')
  }

  updateTeamContext(context, spawn, result)
  await appendTeamMember(input, spawn, result)

  const display = getBackendDisplay(result)
  return {
    data: {
      teammate_id: spawn.teammateId,
      agent_id: spawn.teammateId,
      agent_type: input.agent_type,
      model: spawn.model,
      name: spawn.sanitizedName,
      color: spawn.teammateColor,
      tmux_session_name: display.sessionName,
      tmux_window_name: display.windowName,
      tmux_pane_id: display.paneId,
      team_name: spawn.teamName,
      is_splitpane: display.isSplitPane,
      plan_mode_required: input.plan_mode_required,
    },
  }
}

// ============================================================================
// 主导出
// ============================================================================

/**
 * 使用给定配置生成一个新的 teammate。
 * 这是生成 teammate 的主入口，TeammateTool 和 AgentTool 都会使用它。
 */
export async function spawnTeammate(
  config: SpawnTeammateConfig,
  context: ToolUseContext,
): Promise<{ data: SpawnOutput }> {
  return handleSpawn(config, context)
}
