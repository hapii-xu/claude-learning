import { z } from 'zod/v4'
import { logEvent } from 'src/services/analytics/index.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from 'src/services/analytics/metadata.js'
import type { Tool } from 'src/Tool.js'
import { buildTool, type ToolDef } from 'src/Tool.js'
import { isAgentSwarmsEnabled } from 'src/utils/agentSwarmsEnabled.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { jsonStringify } from 'src/utils/slowOperations.js'
import { TEAM_LEAD_NAME } from 'src/utils/swarm/constants.js'
import {
  cleanupTeamDirectories,
  readTeamFile,
  unregisterTeamForSessionCleanup,
} from 'src/utils/swarm/teamHelpers.js'
import { clearTeammateColors } from 'src/utils/swarm/teammateLayoutManager.js'
import { clearLeaderTeamName } from 'src/utils/tasks.js'
import {
  ensureBackendsRegistered,
  getBackendByType,
  getInProcessBackend,
} from 'src/utils/swarm/backends/registry.js'
import { createPaneBackendExecutor } from 'src/utils/swarm/backends/PaneBackendExecutor.js'
import { isPaneBackend } from 'src/utils/swarm/backends/types.js'
import { sleep } from 'src/utils/sleep.js'
import { TEAM_DELETE_TOOL_NAME } from './constants.js'
import { getPrompt } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    wait_ms: z
      .number()
      .min(0)
      .max(30_000)
      .optional()
      .describe('可选：清理前等待活跃 teammate 确认关闭的时间。'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export type Output = {
  success: boolean
  message: string
  team_name?: string
}

export type Input = z.infer<InputSchema>

export const TeamDeleteTool: Tool<InputSchema, Output> = buildTool({
  name: TEAM_DELETE_TOOL_NAME,
  searchHint:
    'disband delete swarm team cleanup, remove team, end team collaboration, cleanup team resources',
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

  async description() {
    return '在 swarm 完成后清理团队和任务目录'
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
    const appState = getAppState()
    const teamName = appState.teamContext?.teamName

    if (teamName) {
      // 读取团队配置以检查活跃成员
      const teamFile = readTeamFile(teamName)
      if (teamFile) {
        // 过滤掉团队负责人 - 只统计非负责人成员
        const nonLeadMembers = teamFile.members.filter(
          m => m.name !== TEAM_LEAD_NAME,
        )

        // 把真正活跃的成员与空闲/已死成员分开
        // isActive === false 的成员是空闲的（已结束回合或已崩溃）
        const activeMembers = nonLeadMembers.filter(m => m.isActive !== false)

        if (activeMembers.length > 0) {
          const requested: string[] = []
          for (const member of activeMembers) {
            let sent = false
            if (member.backendType === 'in-process') {
              const executor = getInProcessBackend()
              executor.setContext?.(context)
              sent = await executor.terminate(
                member.agentId,
                '团队负责人请求清理团队',
              )
            } else if (
              member.backendType &&
              isPaneBackend(member.backendType)
            ) {
              await ensureBackendsRegistered()
              const executor = createPaneBackendExecutor(
                getBackendByType(member.backendType),
              )
              executor.setContext?.(context)
              sent = await executor.terminate(
                member.agentId,
                '团队负责人请求清理团队',
              )
            }
            if (sent) {
              requested.push(member.name)
            }
          }
          const waitMs = input.wait_ms ?? 0
          if (waitMs > 0 && requested.length > 0) {
            const deadline = Date.now() + waitMs
            while (Date.now() < deadline) {
              await sleep(Math.min(250, Math.max(0, deadline - Date.now())))
              const refreshed = readTeamFile(teamName)
              const stillActive =
                refreshed?.members.filter(
                  m => m.name !== TEAM_LEAD_NAME && m.isActive !== false,
                ) ?? []
              if (stillActive.length === 0) {
                break
              }
            }
            const refreshed = readTeamFile(teamName)
            const stillActive =
              refreshed?.members.filter(
                m => m.name !== TEAM_LEAD_NAME && m.isActive !== false,
              ) ?? []
            if (stillActive.length === 0) {
              // 继续执行清理，使用刷新后的团队文件状态。
            } else {
              const memberNames = stillActive.map(m => m.name).join(', ')
              return {
                data: {
                  success: false,
                  message: `已请求关闭活跃 teammate：${requested.join(', ')}。等待 ${waitMs}ms 后清理仍被阻塞：${memberNames}。`,
                  team_name: teamName,
                },
              }
            }
          }
          const latestTeamFile = readTeamFile(teamName)
          const latestActiveMembers =
            latestTeamFile?.members.filter(
              m => m.name !== TEAM_LEAD_NAME && m.isActive !== false,
            ) ?? []
          if (latestActiveMembers.length === 0) {
            // 继续执行下方清理。
          } else {
            const memberNames = latestActiveMembers.map(m => m.name).join(', ')
            return {
              data: {
                success: false,
                message:
                  requested.length > 0
                    ? `已请求关闭活跃 teammate：${requested.join(', ')}。清理在它们退出前被阻塞：${memberNames}。`
                    : `无法清理仍有 ${latestActiveMembers.length} 个活跃成员的团队：${memberNames}。请先使用 requestShutdown 优雅终止 teammate。`,
                team_name: teamName,
              },
            }
          }
        }
      }

      await cleanupTeamDirectories(teamName)
      // 已经清理 - 不要在 gracefulShutdown 时再次尝试。
      unregisterTeamForSessionCleanup(teamName)

      // 清除颜色分配，以便新团队从零开始
      clearTeammateColors()

      // 清除负责人团队名称，使 getTaskListId() 回退到 session ID
      clearLeaderTeamName()

      logEvent('tengu_team_deleted', {
        team_name:
          teamName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
    }

    // 从 app state 中清除团队上下文和 inbox
    setAppState(prev => ({
      ...prev,
      teamContext: undefined,
      inbox: {
        messages: [], // 清除所有排队消息
      },
    }))

    return {
      data: {
        success: true,
        message: teamName
          ? `已清理团队 "${teamName}" 的目录和 worktree`
          : '未找到团队名称，无需清理',
        team_name: teamName,
      },
    }
  },

  renderToolUseMessage,
  renderToolResultMessage,
} satisfies ToolDef<InputSchema, Output>)
