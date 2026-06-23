import { z } from 'zod/v4'
import { getSessionId } from 'src/bootstrap/state.js'
import { logEvent } from 'src/services/analytics/index.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from 'src/services/analytics/metadata.js'
import type { Tool } from 'src/Tool.js'
import { buildTool, type ToolDef } from 'src/Tool.js'
import { formatAgentId } from 'src/utils/agentId.js'
import { isAgentSwarmsEnabled } from 'src/utils/agentSwarmsEnabled.js'
import { getCwd } from 'src/utils/cwd.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import {
  getDefaultMainLoopModel,
  parseUserSpecifiedModel,
} from 'src/utils/model/model.js'
import { jsonStringify } from 'src/utils/slowOperations.js'
import { getResolvedTeammateMode } from 'src/utils/swarm/backends/registry.js'
import { TEAM_LEAD_NAME } from 'src/utils/swarm/constants.js'
import type { TeamFile } from 'src/utils/swarm/teamHelpers.js'
import {
  getTeamFilePath,
  readTeamFile,
  registerTeamForSessionCleanup,
  sanitizeName,
  writeTeamFileAsync,
} from 'src/utils/swarm/teamHelpers.js'
import { assignTeammateColor } from 'src/utils/swarm/teammateLayoutManager.js'
import {
  ensureTasksDir,
  resetTaskList,
  setLeaderTeamName,
} from 'src/utils/tasks.js'
import { generateWordSlug } from 'src/utils/words.js'
import { TEAM_CREATE_TOOL_NAME } from './constants.js'
import { getPrompt } from './prompt.js'
import { renderToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    team_name: z.string().describe('要创建的新团队名称。'),
    description: z.string().optional().describe('团队的描述/用途。'),
    agent_type: z
      .string()
      .optional()
      .describe(
        '团队负责人的类型/角色（例如 "researcher"、"test-runner"）。' +
          '用于团队文件和 agent 间的协调。',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export type Output = {
  team_name: string
  team_file_path: string
  lead_agent_id: string
}

export type Input = z.infer<InputSchema>

/**
 * 通过检查提供的名称是否已存在来生成唯一的团队名称。
 * 如果名称已存在，则生成一个新的 word slug。
 */
function generateUniqueTeamName(providedName: string): string {
  // 如果团队不存在，使用提供的名称
  if (!readTeamFile(providedName)) {
    return providedName
  }

  // 团队已存在，生成一个新的唯一名称
  return generateWordSlug()
}

export const TeamCreateTool: Tool<InputSchema, Output> = buildTool({
  name: TEAM_CREATE_TOOL_NAME,
  searchHint:
    'create multi-agent swarm team, collaborate, parallel agents, task distribution, agent coordination, team management',
  maxResultSizeChars: 100_000,
  shouldDefer: true,

  userFacingName() {
    return ''
  },

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  isEnabled() {
    return true
  },

  toAutoClassifierInput(input) {
    return input.team_name
  },

  async validateInput(input, _context) {
    if (!input.team_name || input.team_name.trim().length === 0) {
      return {
        result: false,
        message: 'TeamCreate 必须提供 team_name',
        errorCode: 9,
      }
    }
    return { result: true }
  },

  async description() {
    return '创建新团队用于协调多个 agent'
  },

  async prompt() {
    return getPrompt()
  },

  mapToolResultToToolResultBlockParam(data, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: [
        {
          type: 'text' as const,
          text: jsonStringify(data),
        },
      ],
    }
  },

  async call(input, context) {
    if (!isAgentSwarmsEnabled()) {
      throw new Error(
        'Agent Teams 功能未启用。请确保未设置 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS_DISABLED 环境变量。',
      )
    }

    const { setAppState, getAppState } = context
    const { team_name, description: _description, agent_type } = input

    // 检查是否已处于某团队中 - 每个负责人仅限一个团队
    const appState = getAppState()
    const existingTeam = appState.teamContext?.teamName

    if (existingTeam) {
      throw new Error(
        `已经在负责团队 "${existingTeam}"。一个负责人一次只能管理一个团队。请先使用 TeamDelete 结束当前团队，再创建新团队。`,
      )
    }

    // 如果团队已存在，生成一个唯一的名称而不报错
    const finalTeamName = generateUniqueTeamName(team_name)

    // 为团队负责人生成确定性 agent ID
    const leadAgentId = formatAgentId(TEAM_LEAD_NAME, finalTeamName)
    const leadAgentType = agent_type || TEAM_LEAD_NAME
    // 从 AppState 获取团队负责人的当前 model（处理会话 model、settings、CLI 覆盖）
    const leadModel = parseUserSpecifiedModel(
      appState.mainLoopModelForSession ??
        appState.mainLoopModel ??
        getDefaultMainLoopModel(),
    )

    const teamFilePath = getTeamFilePath(finalTeamName)

    const teamFile: TeamFile = {
      name: finalTeamName,
      description: _description,
      createdAt: Date.now(),
      leadAgentId,
      leadSessionId: getSessionId(), // 存储真实 session ID 以便团队发现
      members: [
        {
          agentId: leadAgentId,
          name: TEAM_LEAD_NAME,
          agentType: leadAgentType,
          model: leadModel,
          joinedAt: Date.now(),
          tmuxPaneId: '',
          cwd: getCwd(),
          subscriptions: [],
        },
      ],
    }

    await writeTeamFileAsync(finalTeamName, teamFile)
    // 登记以便会话结束时清理 - 之前除非显式 TeamDelete（gh-32730），
    // 团队会一直留在磁盘上。
    registerTeamForSessionCleanup(finalTeamName)

    // 重置并创建对应的任务列表目录（Team = Project = TaskList）
    // 这确保每个新 swarm 的任务编号从 1 重新开始
    const taskListId = sanitizeName(finalTeamName)
    await resetTaskList(taskListId)
    await ensureTasksDir(taskListId)

    // 注册团队名称，使 getTaskListId() 对负责人返回该名称。
    // 若不如此，负责人会回退到 getSessionId()，把任务写到与 tmux/iTerm2
    // teammate 期望不同的目录。
    setLeaderTeamName(sanitizeName(finalTeamName))

    // 用团队上下文更新 AppState
    setAppState(prev => ({
      ...prev,
      teamContext: {
        teamName: finalTeamName,
        teamFilePath,
        leadAgentId,
        teammates: {
          [leadAgentId]: {
            name: TEAM_LEAD_NAME,
            agentType: leadAgentType,
            color: assignTeammateColor(leadAgentId),
            tmuxSessionName: '',
            tmuxPaneId: '',
            cwd: getCwd(),
            spawnedAt: Date.now(),
          },
        },
      },
    }))

    logEvent('tengu_team_created', {
      team_name:
        finalTeamName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      teammate_count: 1,
      lead_agent_type:
        leadAgentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      teammate_mode:
        getResolvedTeammateMode() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })

    // 说明：我们有意不为团队负责人设置 CLAUDE_CODE_AGENT_ID，原因：
    // 1. 负责人不是 "teammate" - 对他们而言 isTeammate() 应返回 false
    // 2. 他们的 ID 是确定性的（team-lead@teamName），需要时可推导
    // 3. 设置它会让 isTeammate() 返回 true，破坏 inbox 轮询
    // 团队名称存放在 AppState.teamContext 中，而非 process.env

    return {
      data: {
        team_name: finalTeamName,
        team_file_path: teamFilePath,
        lead_agent_id: leadAgentId,
      },
    }
  },

  renderToolUseMessage,
} satisfies ToolDef<InputSchema, Output>)
