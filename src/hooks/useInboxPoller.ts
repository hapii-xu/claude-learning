import { randomUUID } from 'crypto'
import { useCallback, useEffect, useRef } from 'react'
import { useInterval } from 'usehooks-ts'
import type { ToolUseConfirm } from '../components/permissions/PermissionRequest.js'
import { TEAMMATE_MESSAGE_TAG } from '../constants/xml.js'
import { useTerminalNotification } from '@anthropic/ink'
import { sendNotification } from '../services/notifier.js'
import {
  type AppState,
  useAppState,
  useAppStateStore,
  useSetAppState,
} from '../state/AppState.js'
import { findToolByName } from '../Tool.js'
import { isInProcessTeammateTask } from '../tasks/InProcessTeammateTask/types.js'
import { getAllBaseTools } from '../tools.js'
import type { PermissionUpdate } from '../types/permissions.js'
import { logForDebugging } from '../utils/debug.js'
import {
  findInProcessTeammateTaskId,
  handlePlanApprovalResponse,
} from '../utils/inProcessTeammateHelpers.js'
import { createAssistantMessage } from '../utils/messages.js'
import {
  permissionModeFromString,
  toExternalPermissionMode,
} from '../utils/permissions/PermissionMode.js'
import { applyPermissionUpdate } from '../utils/permissions/PermissionUpdate.js'
import { jsonStringify } from '../utils/slowOperations.js'
import { isInsideTmux } from '../utils/swarm/backends/detection.js'
import {
  ensureBackendsRegistered,
  getBackendByType,
} from '../utils/swarm/backends/registry.js'
import type { PaneBackendType } from '../utils/swarm/backends/types.js'
import { TEAM_LEAD_NAME } from '../utils/swarm/constants.js'
import { getLeaderToolUseConfirmQueue } from '../utils/swarm/leaderPermissionBridge.js'
import { sendPermissionResponseViaMailbox } from '../utils/swarm/permissionSync.js'
import {
  removeTeammateFromTeamFile,
  setMemberMode,
} from '../utils/swarm/teamHelpers.js'
import { unassignTeammateTasks } from '../utils/tasks.js'
import {
  getAgentName,
  isPlanModeRequired,
  isTeamLead,
  isTeammate,
} from '../utils/teammate.js'
import { isInProcessTeammate } from '../utils/teammateContext.js'
import {
  isModeSetRequest,
  isPermissionRequest,
  isPermissionResponse,
  isPlanApprovalRequest,
  isPlanApprovalResponse,
  isSandboxPermissionRequest,
  isSandboxPermissionResponse,
  isShutdownApproved,
  isShutdownRequest,
  isTeamPermissionUpdate,
  markMessagesAsRead,
  readUnreadMessages,
  type TeammateMessage,
  writeToMailbox,
} from '../utils/teammateMailbox.js'
import {
  hasPermissionCallback,
  hasSandboxPermissionCallback,
  processMailboxPermissionResponse,
  processSandboxPermissionResponse,
} from './useSwarmPermissionPoller.js'

/**
 * 获取要轮询消息的 agent 名称。
 * - 进程内 teammate 返回 undefined（它们改用 waitForNextPromptOrShutdown）
 * - 基于进程的 teammate 使用它们的 CLAUDE_CODE_AGENT_NAME
 * - 团队负责人使用 teamContext.teammates 中的名称
 * - 独立会话返回 undefined
 */
function getAgentNameToPoll(appState: AppState): string | undefined {
  // 进程内 teammate 不应使用 useInboxPoller - 它们有自己的
  // 通过 inProcessRunner.ts 中的 waitForNextPromptOrShutdown() 轮询机制。
  // 使用 useInboxPoller 会导致消息路由问题，因为进程内
  // teammate 与 leader 共享相同的 React 上下文和 AppState。
  //
  // 注意：这可能在 leader 的 REPL 重新渲染时被调用，而
  // 进程内 teammate 的 AsyncLocalStorage 上下文处于活跃状态（由于共享
  // setAppState）。我们返回 undefined 以优雅地跳过轮询而不是
  // 抛出，因为这是并发执行期间的正常现象。
  if (isInProcessTeammate()) {
    return undefined
  }
  if (isTeammate()) {
    return getAgentName()
  }
  // 团队负责人使用其 agent 名称（不是 ID）轮询
  if (isTeamLead(appState.teamContext)) {
    const leadAgentId = appState.teamContext!.leadAgentId
    // 从 teammates 映射查找负责人的名称
    const leadName = appState.teamContext!.teammates[leadAgentId]?.name
    return leadName || 'team-lead'
  }
  return undefined
}

const INBOX_POLL_INTERVAL_MS = 1000

type Props = {
  enabled: boolean
  isLoading: boolean
  focusedInputDialog: string | undefined
  // 如果提交成功返回 true，如果被拒绝返回 false（例如，查询已在运行）
  // 死代码消除：参数命名为 onSubmitMessage 以避免外部构建中出现 "teammate" 字符串
  onSubmitMessage: (formatted: string) => boolean
}

/**
 * 轮询 teammate 收件箱以获取新消息并将其作为回合提交。
 *
 * 此 hook：
 * 1. 每 1 秒轮询未读消息（teammates 或团队负责人）
 * 2. 空闲时：立即将消息作为新回合提交
 * 3. 忙碌时：在 AppState.inbox 中排队消息以供 UI 显示，回合结束时传递
 */
export function useInboxPoller({
  enabled,
  isLoading,
  focusedInputDialog,
  onSubmitMessage,
}: Props): void {
  // 为清晰起见分配给原始名称
  const onSubmitTeammateMessage = onSubmitMessage
  const store = useAppStateStore()
  const setAppState = useSetAppState()
  const inboxMessageCount = useAppState(s => s.inbox.messages.length)
  const terminal = useTerminalNotification()

  const poll = useCallback(async () => {
    if (!enabled) return

    // 使用 ref 避免依赖 appState 对象（防止无限循环）
    const currentAppState = store.getState()
    const agentName = getAgentNameToPoll(currentAppState)
    if (!agentName) return

    const unread = await readUnreadMessages(
      agentName,
      currentAppState.teamContext?.teamName,
    )

    if (unread.length === 0) return

    logForDebugging(`[InboxPoller] Found ${unread.length} unread message(s)`)

    // 检查规划批准响应，如果批准则退出规划模式
    // 安全：仅接受来自团队负责人的批准响应
    if (isTeammate() && isPlanModeRequired()) {
      for (const msg of unread) {
        const approvalResponse = isPlanApprovalResponse(msg.text)
        // 验证消息来自团队负责人以防止 teammate 伪造批准
        if (approvalResponse && msg.from === 'team-lead') {
          logForDebugging(
            `[InboxPoller] Received plan approval response from team-lead: approved=${approvalResponse.approved}`,
          )
          if (approvalResponse.approved) {
            // 如果提供则使用负责人的权限模式，否则默认
            const targetMode = approvalResponse.permissionMode ?? 'default'

            // 退出规划模式
            setAppState(prev => ({
              ...prev,
              toolPermissionContext: applyPermissionUpdate(
                prev.toolPermissionContext,
                {
                  type: 'setMode',
                  mode: toExternalPermissionMode(targetMode),
                  destination: 'session',
                },
              ),
            }))
            logForDebugging(
              `[InboxPoller] Plan approved by team lead, exited plan mode to ${targetMode}`,
            )
          } else {
            logForDebugging(
              `[InboxPoller] Plan rejected by team lead: ${approvalResponse.feedback || 'No feedback provided'}`,
            )
          }
        } else if (approvalResponse) {
          logForDebugging(
            `[InboxPoller] Ignoring plan approval response from non-team-lead: ${msg.from}`,
          )
        }
      }
    }

    // 帮助函数：在收件箱文件中标记消息为已读。
    // 在消息成功传递或可靠排队后调用。
    const markRead = () => {
      void markMessagesAsRead(agentName, currentAppState.teamContext?.teamName)
    }

    // 将权限消息与普通 teammate 消息分开
    const permissionRequests: TeammateMessage[] = []
    const permissionResponses: TeammateMessage[] = []
    const sandboxPermissionRequests: TeammateMessage[] = []
    const sandboxPermissionResponses: TeammateMessage[] = []
    const shutdownRequests: TeammateMessage[] = []
    const shutdownApprovals: TeammateMessage[] = []
    const teamPermissionUpdates: TeammateMessage[] = []
    const modeSetRequests: TeammateMessage[] = []
    const planApprovalRequests: TeammateMessage[] = []
    const regularMessages: TeammateMessage[] = []

    for (const m of unread) {
      const permReq = isPermissionRequest(m.text)
      const permResp = isPermissionResponse(m.text)
      const sandboxReq = isSandboxPermissionRequest(m.text)
      const sandboxResp = isSandboxPermissionResponse(m.text)
      const shutdownReq = isShutdownRequest(m.text)
      const shutdownApproval = isShutdownApproved(m.text)
      const teamPermUpdate = isTeamPermissionUpdate(m.text)
      const modeSetReq = isModeSetRequest(m.text)
      const planApprovalReq = isPlanApprovalRequest(m.text)

      if (permReq) {
        permissionRequests.push(m)
      } else if (permResp) {
        permissionResponses.push(m)
      } else if (sandboxReq) {
        sandboxPermissionRequests.push(m)
      } else if (sandboxResp) {
        sandboxPermissionResponses.push(m)
      } else if (shutdownReq) {
        shutdownRequests.push(m)
      } else if (shutdownApproval) {
        shutdownApprovals.push(m)
      } else if (teamPermUpdate) {
        teamPermissionUpdates.push(m)
      } else if (modeSetReq) {
        modeSetRequests.push(m)
      } else if (planApprovalReq) {
        planApprovalRequests.push(m)
      } else {
        regularMessages.push(m)
      }
    }

    // 处理权限请求（leader 侧）- 路由到 ToolUseConfirmQueue
    if (
      permissionRequests.length > 0 &&
      isTeamLead(currentAppState.teamContext)
    ) {
      logForDebugging(
        `[InboxPoller] Found ${permissionRequests.length} permission request(s)`,
      )

      const setToolUseConfirmQueue = getLeaderToolUseConfirmQueue()
      const teamName = currentAppState.teamContext?.teamName

      for (const m of permissionRequests) {
        const parsed = isPermissionRequest(m.text)
        if (!parsed) continue

        if (setToolUseConfirmQueue) {
          // 通过标准 ToolUseConfirmQueue 路由，这样 tmux worker
          // 获得与进程内 teammate 相同的工具特定 UI
          // （BashPermissionRequest、FileEditToolDiff 等）。
          const tool = findToolByName(getAllBaseTools(), parsed.tool_name)
          if (!tool) {
            logForDebugging(
              `[InboxPoller] Unknown tool ${parsed.tool_name}, skipping permission request`,
            )
            continue
          }

          const entry: ToolUseConfirm = {
            assistantMessage: createAssistantMessage({ content: '' }),
            tool,
            description: parsed.description,
            input: parsed.input,
            toolUseContext: {} as ToolUseConfirm['toolUseContext'],
            toolUseID: parsed.tool_use_id,
            permissionResult: {
              behavior: 'ask',
              message: parsed.description,
            },
            permissionPromptStartTimeMs: Date.now(),
            workerBadge: {
              name: parsed.agent_id,
              color: 'cyan',
            },
            onUserInteraction() {
              // tmux worker 无操作（无分类器自动批准）
            },
            onAbort() {
              void sendPermissionResponseViaMailbox(
                parsed.agent_id,
                { decision: 'rejected', resolvedBy: 'leader' },
                parsed.request_id,
                teamName,
              )
            },
            onAllow(
              updatedInput: Record<string, unknown>,
              permissionUpdates: PermissionUpdate[],
            ) {
              void sendPermissionResponseViaMailbox(
                parsed.agent_id,
                {
                  decision: 'approved',
                  resolvedBy: 'leader',
                  updatedInput,
                  permissionUpdates,
                },
                parsed.request_id,
                teamName,
              )
            },
            onReject(feedback?: string) {
              void sendPermissionResponseViaMailbox(
                parsed.agent_id,
                {
                  decision: 'rejected',
                  resolvedBy: 'leader',
                  feedback,
                },
                parsed.request_id,
                teamName,
              )
            },
            async recheckPermission() {
              // tmux worker 无操作 —— 权限状态在 worker 侧
            },
          }

          // 去重：如果 markMessagesAsRead 在前一次轮询失败，
          // 同一条消息会被重新读取 —— 如果已排队则跳过。
          setToolUseConfirmQueue(queue => {
            if (queue.some(q => q.toolUseID === parsed.tool_use_id)) {
              return queue
            }
            return [...queue, entry]
          })
        } else {
          logForDebugging(
            `[InboxPoller] ToolUseConfirmQueue unavailable, dropping permission request from ${parsed.agent_id}`,
          )
        }
      }

      // 为第一个请求发送桌面通知
      const firstParsed = isPermissionRequest(permissionRequests[0]?.text ?? '')
      if (firstParsed && !isLoading && !focusedInputDialog) {
        void sendNotification(
          {
            message: `${firstParsed.agent_id} needs permission for ${firstParsed.tool_name}`,
            notificationType: 'worker_permission_prompt',
          },
          terminal,
        )
      }
    }

    // 处理权限响应（worker 侧）- 调用注册的回调
    if (permissionResponses.length > 0 && isTeammate()) {
      logForDebugging(
        `[InboxPoller] Found ${permissionResponses.length} permission response(s)`,
      )

      for (const m of permissionResponses) {
        const parsed = isPermissionResponse(m.text)
        if (!parsed) continue

        if (hasPermissionCallback(parsed.request_id)) {
          logForDebugging(
            `[InboxPoller] Processing permission response for ${parsed.request_id}: ${parsed.subtype}`,
          )

          if (parsed.subtype === 'success') {
            processMailboxPermissionResponse({
              requestId: parsed.request_id,
              decision: 'approved',
              updatedInput: parsed.response?.updated_input,
              permissionUpdates: parsed.response?.permission_updates,
            })
          } else {
            processMailboxPermissionResponse({
              requestId: parsed.request_id,
              decision: 'rejected',
              feedback: parsed.error,
            })
          }
        }
      }
    }

    // 处理沙箱权限请求（leader 侧）- 添加到 workerSandboxPermissions 队列
    if (
      sandboxPermissionRequests.length > 0 &&
      isTeamLead(currentAppState.teamContext)
    ) {
      logForDebugging(
        `[InboxPoller] Found ${sandboxPermissionRequests.length} sandbox permission request(s)`,
      )

      const newSandboxRequests: Array<{
        requestId: string
        workerId: string
        workerName: string
        workerColor?: string
        host: string
        createdAt: number
      }> = []

      for (const m of sandboxPermissionRequests) {
        const parsed = isSandboxPermissionRequest(m.text)
        if (!parsed) continue

        // 验证必需的嵌套字段以防止畸形消息导致崩溃
        if (!parsed.hostPattern?.host) {
          logForDebugging(
            `[InboxPoller] Invalid sandbox permission request: missing hostPattern.host`,
          )
          continue
        }

        newSandboxRequests.push({
          requestId: parsed.requestId,
          workerId: parsed.workerId,
          workerName: parsed.workerName,
          workerColor: parsed.workerColor,
          host: parsed.hostPattern.host,
          createdAt: parsed.createdAt,
        })
      }

      if (newSandboxRequests.length > 0) {
        setAppState(prev => ({
          ...prev,
          workerSandboxPermissions: {
            ...prev.workerSandboxPermissions,
            queue: [
              ...prev.workerSandboxPermissions.queue,
              ...newSandboxRequests,
            ],
          },
        }))

        // Send desktop notification for the first new request
        const firstRequest = newSandboxRequests[0]
        if (firstRequest && !isLoading && !focusedInputDialog) {
          void sendNotification(
            {
              message: `${firstRequest.workerName} needs network access to ${firstRequest.host}`,
              notificationType: 'worker_permission_prompt',
            },
            terminal,
          )
        }
      }
    }

    // 处理沙箱权限响应（worker 侧）- 调用注册的回调
    if (sandboxPermissionResponses.length > 0 && isTeammate()) {
      logForDebugging(
        `[InboxPoller] Found ${sandboxPermissionResponses.length} sandbox permission response(s)`,
      )

      for (const m of sandboxPermissionResponses) {
        const parsed = isSandboxPermissionResponse(m.text)
        if (!parsed) continue

        // 检查我们是否为此请求注册了回调
        if (hasSandboxPermissionCallback(parsed.requestId)) {
          logForDebugging(
            `[InboxPoller] Processing sandbox permission response for ${parsed.requestId}: allow=${parsed.allow}`,
          )

          // 使用导出函数处理响应
          processSandboxPermissionResponse({
            requestId: parsed.requestId,
            host: parsed.host,
            allow: parsed.allow,
          })

          // 清除待处理的沙箱请求指示器
          setAppState(prev => ({
            ...prev,
            pendingSandboxRequest: null,
          }))
        }
      }
    }

    // 处理团队权限更新（teammate 侧）- 将权限应用于上下文
    if (teamPermissionUpdates.length > 0 && isTeammate()) {
      logForDebugging(
        `[InboxPoller] Found ${teamPermissionUpdates.length} team permission update(s)`,
      )

      for (const m of teamPermissionUpdates) {
        const parsed = isTeamPermissionUpdate(m.text)
        if (!parsed) {
          logForDebugging(
            `[InboxPoller] Failed to parse team permission update: ${m.text.substring(0, 100)}`,
          )
          continue
        }

        // 验证必需的嵌套字段以防止畸形消息导致崩溃
        if (
          !parsed.permissionUpdate?.rules ||
          !parsed.permissionUpdate?.behavior
        ) {
          logForDebugging(
            `[InboxPoller] Invalid team permission update: missing permissionUpdate.rules or permissionUpdate.behavior`,
          )
          continue
        }

        // 将权限更新应用于 teammate 的上下文
        logForDebugging(
          `[InboxPoller] Applying team permission update: ${parsed.toolName} allowed in ${parsed.directoryPath}`,
        )
        logForDebugging(
          `[InboxPoller] Permission update rules: ${jsonStringify(parsed.permissionUpdate.rules)}`,
        )

        setAppState(prev => {
          const updated = applyPermissionUpdate(prev.toolPermissionContext, {
            type: 'addRules',
            rules: parsed.permissionUpdate.rules,
            behavior: parsed.permissionUpdate.behavior,
            destination: 'session',
          })
          logForDebugging(
            `[InboxPoller] Updated session allow rules: ${jsonStringify(updated.alwaysAllowRules.session)}`,
          )
          return {
            ...prev,
            toolPermissionContext: updated,
          }
        })
      }
    }

    // 处理模式设置请求（teammate 侧）- 团队负责人更改 teammate 的模式
    if (modeSetRequests.length > 0 && isTeammate()) {
      logForDebugging(
        `[InboxPoller] Found ${modeSetRequests.length} mode set request(s)`,
      )

      for (const m of modeSetRequests) {
        // 仅接受来自 team-lead 的模式更改
        if (m.from !== 'team-lead') {
          logForDebugging(
            `[InboxPoller] Ignoring mode set request from non-team-lead: ${m.from}`,
          )
          continue
        }

        const parsed = isModeSetRequest(m.text)
        if (!parsed) {
          logForDebugging(
            `[InboxPoller] Failed to parse mode set request: ${m.text.substring(0, 100)}`,
          )
          continue
        }

        const targetMode = permissionModeFromString(parsed.mode)
        logForDebugging(
          `[InboxPoller] Applying mode change from team-lead: ${targetMode}`,
        )

        // 更新本地权限上下文
        setAppState(prev => ({
          ...prev,
          toolPermissionContext: applyPermissionUpdate(
            prev.toolPermissionContext,
            {
              type: 'setMode',
              mode: toExternalPermissionMode(targetMode),
              destination: 'session',
            },
          ),
        }))

        // 更新 config.json 以便团队负责人可以看到新模式
        const teamName = currentAppState.teamContext?.teamName
        const agentName = getAgentName()
        if (teamName && agentName) {
          setMemberMode(teamName, agentName, targetMode)
        }
      }
    }

    // 处理规划批准请求（leader 侧）- 自动批准并向 teammate 收件箱写入响应
    if (
      planApprovalRequests.length > 0 &&
      isTeamLead(currentAppState.teamContext)
    ) {
      logForDebugging(
        `[InboxPoller] Found ${planApprovalRequests.length} plan approval request(s), auto-approving`,
      )

      const teamName = currentAppState.teamContext?.teamName
      const leaderExternalMode = toExternalPermissionMode(
        currentAppState.toolPermissionContext.mode,
      )
      const modeToInherit =
        leaderExternalMode === 'plan' ? 'default' : leaderExternalMode

      for (const m of planApprovalRequests) {
        const parsed = isPlanApprovalRequest(m.text)
        if (!parsed) continue

        // 向 teammate 的收件箱写入批准响应
        const approvalResponse = {
          type: 'plan_approval_response',
          requestId: parsed.requestId,
          approved: true,
          timestamp: new Date().toISOString(),
          permissionMode: modeToInherit,
        }

        void writeToMailbox(
          m.from,
          {
            from: TEAM_LEAD_NAME,
            text: jsonStringify(approvalResponse),
            timestamp: new Date().toISOString(),
          },
          teamName,
        )

        // 如果适用，更新进程内 teammate 任务状态
        const taskId = findInProcessTeammateTaskId(m.from, currentAppState)
        if (taskId) {
          handlePlanApprovalResponse(
            taskId,
            {
              type: 'plan_approval_response',
              requestId: parsed.requestId,
              approved: true,
              timestamp: new Date().toISOString(),
              permissionMode: modeToInherit,
            },
            setAppState,
          )
        }

        logForDebugging(
          `[InboxPoller] Auto-approved plan from ${m.from} (request ${parsed.requestId})`,
        )

        // 仍然作为普通消息传递，以便模型有关于
        // teammate 正在做什么的上下文，但批准已发送
        regularMessages.push(m)
      }
    }

    // 处理关闭请求（teammate 侧）- 保留 JSON 用于 UI 渲染
    if (shutdownRequests.length > 0 && isTeammate()) {
      logForDebugging(
        `[InboxPoller] Found ${shutdownRequests.length} shutdown request(s)`,
      )

      // 传递关闭请求 - UI 组件将漂亮地渲染它们
      // 并且模型将通过工具提示文档接收指令
      for (const m of shutdownRequests) {
        regularMessages.push(m)
      }
    }

    // 处理关闭批准（leader 侧）- 杀死 teammate 的面板
    if (
      shutdownApprovals.length > 0 &&
      isTeamLead(currentAppState.teamContext)
    ) {
      logForDebugging(
        `[InboxPoller] Found ${shutdownApprovals.length} shutdown approval(s)`,
      )

      for (const m of shutdownApprovals) {
        const parsed = isShutdownApproved(m.text)
        if (!parsed) continue

        // 如果我们有信息则杀死面板（基于面板的 teammate）
        if (parsed.paneId && parsed.backendType) {
          void (async () => {
            try {
              // 确保后端类已导入（无子进程探测）
              await ensureBackendsRegistered()
              const insideTmux = await isInsideTmux()
              const backend = getBackendByType(
                parsed.backendType as PaneBackendType,
              )
              const success = await backend?.killPane(
                parsed.paneId!,
                !insideTmux,
              )
              logForDebugging(
                `[InboxPoller] Killed pane ${parsed.paneId} for ${parsed.from}: ${success}`,
              )
            } catch (error) {
              logForDebugging(
                `[InboxPoller] Failed to kill pane for ${parsed.from}: ${error}`,
              )
            }
          })()
        }

        // 从 teamContext.teammates 中移除 teammate 以便计数准确
        const teammateToRemove = parsed.from
        if (teammateToRemove && currentAppState.teamContext?.teammates) {
          // 按名称查找 teammate ID
          const teammateId = Object.entries(
            currentAppState.teamContext.teammates,
          ).find(([, t]) => t.name === teammateToRemove)?.[0]

          if (teammateId) {
            // 从团队文件中移除（leader 拥有团队文件变更）
            const teamName = currentAppState.teamContext?.teamName
            if (teamName) {
              removeTeammateFromTeamFile(teamName, {
                agentId: teammateId,
                name: teammateToRemove,
              })
            }

            // 取消分配任务并构建通知消息
            const { notificationMessage } = teamName
              ? await unassignTeammateTasks(
                  teamName,
                  teammateId,
                  teammateToRemove,
                  'shutdown',
                )
              : { notificationMessage: `${teammateToRemove} has shut down.` }

            setAppState(prev => {
              if (!prev.teamContext?.teammates) return prev
              if (!(teammateId in prev.teamContext.teammates)) return prev
              const { [teammateId]: _, ...remainingTeammates } =
                prev.teamContext.teammates

              // 将 teammate 的任务标记为已完成，以便 hasRunningTeammates
              // 变为 false 并且 spinner 停止。否则，进程外
              // （tmux）teammate 任务将永远保持 status:'running'，因为
              // 只有进程内 teammate 有设置 'completed' 的 runner。
              const updatedTasks = { ...prev.tasks }
              for (const [tid, task] of Object.entries(updatedTasks)) {
                if (
                  isInProcessTeammateTask(task) &&
                  task.identity.agentId === teammateId
                ) {
                  updatedTasks[tid] = {
                    ...task,
                    status: 'completed' as const,
                    endTime: Date.now(),
                  }
                }
              }

              return {
                ...prev,
                tasks: updatedTasks,
                teamContext: {
                  ...prev.teamContext,
                  teammates: remainingTeammates,
                },
                inbox: {
                  messages: [
                    ...prev.inbox.messages,
                    {
                      id: randomUUID(),
                      from: 'system',
                      text: jsonStringify({
                        type: 'teammate_terminated',
                        message: notificationMessage,
                      }),
                      timestamp: new Date().toISOString(),
                      status: 'pending' as const,
                    },
                  ],
                },
              }
            })
            logForDebugging(
              `[InboxPoller] Removed ${teammateToRemove} (${teammateId}) from teamContext`,
            )
          }
        }

        // 传递用于 UI 渲染 - 组件将漂亮地渲染它
        regularMessages.push(m)
      }
    }

    // 处理普通 teammate 消息（现有逻辑）
    if (regularMessages.length === 0) {
      // 没有普通消息，但我们可能已处理了非普通消息
      // （权限、关闭请求等）上面 —— 将它们标记为已读。
      markRead()
      return
    }

    // 使用 XML 包装器为 Claude 格式化消息（如果有颜色则包含）
    // 转换规划批准请求以包含对 Claude 的指令
    const formatted = regularMessages
      .map(m => {
        const colorAttr = m.color ? ` color="${m.color}"` : ''
        const summaryAttr = m.summary ? ` summary="${m.summary}"` : ''
        const messageContent = m.text

        return `<${TEAMMATE_MESSAGE_TAG} teammate_id="${m.from}"${colorAttr}${summaryAttr}>\n${messageContent}\n</${TEAMMATE_MESSAGE_TAG}>`
      })
      .join('\n\n')

    // 帮助函数：在 AppState 中排队消息以便稍后传递
    const queueMessages = () => {
      setAppState(prev => ({
        ...prev,
        inbox: {
          messages: [
            ...prev.inbox.messages,
            ...regularMessages.map(m => ({
              id: randomUUID(),
              from: m.from,
              text: m.text,
              timestamp: m.timestamp,
              status: 'pending' as const,
              color: m.color,
              summary: m.summary,
            })),
          ],
        },
      }))
    }

    if (!isLoading && !focusedInputDialog) {
      // 空闲：立即作为新回合提交
      logForDebugging(`[InboxPoller] Session idle, submitting immediately`)
      const submitted = onSubmitTeammateMessage(formatted)
      if (!submitted) {
        // 提交被拒绝（查询已在运行），排队等待稍后传递
        logForDebugging(
          `[InboxPoller] Submission rejected, queuing for later delivery`,
        )
        queueMessages()
      }
    } else {
      // 忙碌：添加到收件箱队列用于 UI 显示 + 稍后传递
      logForDebugging(`[InboxPoller] Session busy, queuing for later delivery`)
      queueMessages()
    }

    // 仅在消息成功传递或在 AppState 中可靠排队后
    // 标记消息为已读。这防止了会话忙碌时的永久消息丢失
    // —— 如果我们在此点之前崩溃，消息
    // 将在下一个轮询周期被重新读取而不是被悄悄丢弃。
    markRead()
  }, [
    enabled,
    isLoading,
    focusedInputDialog,
    onSubmitTeammateMessage,
    setAppState,
    terminal,
    store,
  ])

  // 当会话变为空闲时，传递任何待处理消息并清理已处理的消息
  useEffect(() => {
    if (!enabled) return

    // 如果忙碌或在对话框中则跳过
    if (isLoading || focusedInputDialog) {
      return
    }

    // 使用 ref 避免依赖 appState 对象（防止无限循环）
    const currentAppState = store.getState()
    const agentName = getAgentNameToPoll(currentAppState)
    if (!agentName) return

    const pendingMessages = currentAppState.inbox.messages.filter(
      m => m.status === 'pending',
    )
    const processedMessages = currentAppState.inbox.messages.filter(
      m => m.status === 'processed',
    )

    // 清理已处理消息（它们已作为附件在回合中途传递）
    if (processedMessages.length > 0) {
      logForDebugging(
        `[InboxPoller] Cleaning up ${processedMessages.length} processed message(s) that were delivered mid-turn`,
      )
      const processedIds = new Set(processedMessages.map(m => m.id))
      setAppState(prev => ({
        ...prev,
        inbox: {
          messages: prev.inbox.messages.filter(m => !processedIds.has(m.id)),
        },
      }))
    }

    // 没有待传递的消息
    if (pendingMessages.length === 0) return

    logForDebugging(
      `[InboxPoller] Session idle, delivering ${pendingMessages.length} pending message(s)`,
    )

    // 使用 XML 包装器为 Claude 格式化消息（如果有颜色则包含）
    const formatted = pendingMessages
      .map(m => {
        const colorAttr = m.color ? ` color="${m.color}"` : ''
        const summaryAttr = m.summary ? ` summary="${m.summary}"` : ''
        return `<${TEAMMATE_MESSAGE_TAG} teammate_id="${m.from}"${colorAttr}${summaryAttr}>\n${m.text}\n</${TEAMMATE_MESSAGE_TAG}>`
      })
      .join('\n\n')

    // 尝试提交 - 仅在成功时清除消息
    const submitted = onSubmitTeammateMessage(formatted)
    if (submitted) {
      // 通过 ID 清除我们刚提交的特定消息
      const submittedIds = new Set(pendingMessages.map(m => m.id))
      setAppState(prev => ({
        ...prev,
        inbox: {
          messages: prev.inbox.messages.filter(m => !submittedIds.has(m.id)),
        },
      }))
    } else {
      logForDebugging(
        `[InboxPoller] Submission rejected, keeping messages queued`,
      )
    }
  }, [
    enabled,
    isLoading,
    focusedInputDialog,
    onSubmitTeammateMessage,
    setAppState,
    inboxMessageCount,
    store,
  ])

  // 如果作为 teammate 或团队负责人运行则轮询
  const shouldPoll = enabled && !!getAgentNameToPoll(store.getState())
  useInterval(() => void poll(), shouldPoll ? INBOX_POLL_INTERVAL_MS : null)

  // 挂载时初始轮询（仅一次）
  const hasDoneInitialPollRef = useRef(false)
  useEffect(() => {
    if (!enabled) return
    if (hasDoneInitialPollRef.current) return
    // 使用 store.getState() 避免依赖 appState 对象
    if (getAgentNameToPoll(store.getState())) {
      hasDoneInitialPollRef.current = true
      void poll()
    }
    // 注意：poll 使用 store.getState()（不是 appState）所以它不会在 appState 更改时重新运行
    // ref 守卫是确保初始轮询仅发生一次的安全措施
  }, [enabled, poll, store])
}
