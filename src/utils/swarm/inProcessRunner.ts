/**
 * 进程内 teammate 运行器
 *
 * 为进程内 teammate 封装 runAgent()，提供：
 * - 通过 runWithTeammateContext() 实现基于 AsyncLocalStorage 的上下文隔离
 * - 进度追踪和 AppState 更新
 * - 完成时向 leader 发送空闲通知
 * - 计划模式审批流程支持
 * - 完成或中止时的清理工作
 */

import { feature } from 'bun:bundle'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { getSystemPrompt } from '../../constants/prompts.js'
import { TEAMMATE_MESSAGE_TAG } from '../../constants/xml.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import {
  processMailboxPermissionResponse,
  registerPermissionCallback,
  unregisterPermissionCallback,
} from '../../hooks/useSwarmPermissionPoller.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { getAutoCompactThreshold } from '../../services/compact/autoCompact.js'
import {
  buildPostCompactMessages,
  compactConversation,
  ERROR_MESSAGE_USER_ABORT,
} from '../../services/compact/compact.js'
import { resetMicrocompactState } from '../../services/compact/microCompact.js'
import type { AppState } from '../../state/AppState.js'
import type { Tool, ToolUseContext } from '../../Tool.js'
import { appendTeammateMessage } from '../../tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import type {
  InProcessTeammateTaskState,
  TeammateIdentity,
} from '../../tasks/InProcessTeammateTask/types.js'
import { appendCappedMessage } from '../../tasks/InProcessTeammateTask/types.js'
import {
  createActivityDescriptionResolver,
  createProgressTracker,
  getProgressUpdate,
  updateProgressFromMessage,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import type { CustomAgentDefinition } from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import { runAgent } from '@claude-code-best/builtin-tools/tools/AgentTool/runAgent.js'
import { awaitClassifierAutoApproval } from '@claude-code-best/builtin-tools/tools/BashTool/bashPermissions.js'
import type { AgentToolResult } from '@claude-code-best/builtin-tools/tools/AgentTool/agentToolUtils.js'
import { BASH_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/BashTool/toolName.js'
import { SEND_MESSAGE_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/SendMessageTool/constants.js'
import { TASK_CREATE_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/TaskCreateTool/constants.js'
import { TASK_GET_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/TaskGetTool/constants.js'
import { TASK_LIST_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/TaskListTool/constants.js'
import { TASK_UPDATE_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/TaskUpdateTool/constants.js'
import { TEAM_CREATE_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/TeamCreateTool/constants.js'
import { TEAM_DELETE_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/TeamDeleteTool/constants.js'
import type { Message } from '../../types/message.js'
import type { PermissionDecision } from '../../types/permissions.js'
import {
  createAssistantAPIErrorMessage,
  createUserMessage,
} from '../../utils/messages.js'
import { evictTaskOutput } from '../../utils/task/diskOutput.js'
import { evictTerminalTask } from '../../utils/task/framework.js'
import {
  tokenCountWithEstimation,
  getTokenCountFromUsage,
} from '../../utils/tokens.js'
import { createAbortController } from '../abortController.js'
import { type AgentContext, runWithAgentContext } from '../agentContext.js'
import {
  markAutonomyRunCompleted,
  markAutonomyRunFailed,
  markAutonomyRunRunning,
} from '../autonomyRuns.js'
import { count } from '../array.js'
import { logForDebugging } from '../debug.js'
import { cloneFileStateCache } from '../fileStateCache.js'
import {
  SUBAGENT_REJECT_MESSAGE,
  SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX,
} from '../messages.js'
import type { ModelAlias } from '../model/aliases.js'
import {
  applyPermissionUpdates,
  persistPermissionUpdates,
} from '../permissions/PermissionUpdate.js'
import type { PermissionUpdate } from '../permissions/PermissionUpdateSchema.js'
import { hasPermissionsToUseTool } from '../permissions/permissions.js'
import { emitTaskTerminatedSdk } from '../sdkEventQueue.js'
import { sleep } from '../sleep.js'
import { jsonStringify } from '../slowOperations.js'
import { asSystemPrompt } from '../systemPromptType.js'
import { claimTask, listTasks, type Task, updateTask } from '../tasks.js'
import type { TeammateContext } from '../teammateContext.js'
import { runWithTeammateContext } from '../teammateContext.js'
import {
  createIdleNotification,
  getLastPeerDmSummary,
  isPermissionResponse,
  isShutdownRequest,
  markMessageAsReadByIdentity,
  readMailbox,
  writeToMailbox,
} from '../teammateMailbox.js'
import { unregisterAgent as unregisterPerfettoAgent } from '../telemetry/perfettoTracing.js'
import { createContentReplacementState } from '../toolResultStorage.js'
import { TEAM_LEAD_NAME } from './constants.js'
import {
  getLeaderSetToolPermissionContext,
  getLeaderToolUseConfirmQueue,
} from './leaderPermissionBridge.js'
import {
  createPermissionRequest,
  sendPermissionRequestViaMailbox,
} from './permissionSync.js'
import { TEAMMATE_SYSTEM_PROMPT_ADDENDUM } from './teammatePromptAddendum.js'

type SetAppStateFn = (updater: (prev: AppState) => AppState) => void

const PERMISSION_POLL_INTERVAL_MS = 500

/**
 * 为进程内 teammate 创建一个 canUseTool 函数，正确解析
 * 'ask' 权限（通过 UI 展示）而不是直接视为拒绝。
 *
 * 当 bridge 可用时，始终使用带有 worker 徽章的 leader 的 ToolUseConfirm 对话框，
 * 为 teammate 提供与 leader 自身工具相同的工具特定 UI
 * （BashPermissionRequest、FileEditToolDiff 等）。
 *
 * 当 bridge 不可用时，回退到邮箱系统：
 * 向 leader 的收件箱发送权限请求，在 teammate 自己的
 * 邮箱中等待响应。
 */
function createInProcessCanUseTool(
  identity: TeammateIdentity,
  abortController: AbortController,
  onPermissionWaitMs?: (waitMs: number) => void,
): CanUseToolFn {
  return async (
    tool,
    input,
    toolUseContext,
    assistantMessage,
    toolUseID,
    forceDecision,
  ) => {
    const result =
      forceDecision ??
      (await hasPermissionsToUseTool(
        tool,
        input,
        toolUseContext,
        assistantMessage,
        toolUseID,
      ))

    // 直接传递 allow/deny 决定
    if (result.behavior !== 'ask') {
      return result
    }

    // 对于 bash 命令，在显示 leader 对话框之前先尝试分类器自动批准。
    // Agent 会等待分类器结果（不像主 agent 那样将其与用户
    // 操作并行竞争）。
    if (
      feature('BASH_CLASSIFIER') &&
      tool.name === BASH_TOOL_NAME &&
      result.pendingClassifierCheck
    ) {
      const classifierDecision = await awaitClassifierAutoApproval(
        result.pendingClassifierCheck,
        abortController.signal,
        toolUseContext.options.isNonInteractiveSession,
      )
      if (classifierDecision) {
        return {
          behavior: 'allow',
          updatedInput: input as Record<string, unknown>,
          decisionReason: classifierDecision,
        }
      }
    }

    // 在显示 UI 之前检查是否已中止
    if (abortController.signal.aborted) {
      return { behavior: 'ask', message: SUBAGENT_REJECT_MESSAGE }
    }

    const appState = toolUseContext.getAppState()

    const description = await (tool as Tool).description(input as never, {
      isNonInteractiveSession: toolUseContext.options.isNonInteractiveSession,
      toolPermissionContext: appState.toolPermissionContext,
      tools: toolUseContext.options.tools,
    })

    if (abortController.signal.aborted) {
      return { behavior: 'ask', message: SUBAGENT_REJECT_MESSAGE }
    }

    const setToolUseConfirmQueue = getLeaderToolUseConfirmQueue()

    // 标准路径：使用带有 worker 徽章的 ToolUseConfirm 对话框
    if (setToolUseConfirmQueue) {
      return new Promise<PermissionDecision>(resolve => {
        let decisionMade = false
        const permissionStartMs = Date.now()

        // 向调用者报告权限等待时间，以便从显示的
        // 已用时间中减去。
        const reportPermissionWait = () => {
          onPermissionWaitMs?.(Date.now() - permissionStartMs)
        }

        const onAbortListener = () => {
          if (decisionMade) return
          decisionMade = true
          reportPermissionWait()
          resolve({ behavior: 'ask', message: SUBAGENT_REJECT_MESSAGE })
          setToolUseConfirmQueue(queue =>
            queue.filter(item => item.toolUseID !== toolUseID),
          )
        }

        abortController.signal.addEventListener('abort', onAbortListener, {
          once: true,
        })

        setToolUseConfirmQueue(queue => [
          ...queue,
          {
            assistantMessage,
            tool: tool as Tool,
            description,
            input,
            toolUseContext,
            toolUseID,
            permissionResult: result,
            permissionPromptStartTimeMs: permissionStartMs,
            workerBadge: identity.color
              ? { name: identity.agentName, color: identity.color }
              : undefined,
            onUserInteraction() {
              // teammate 无操作（无分类器自动批准）
            },
            onAbort() {
              if (decisionMade) return
              decisionMade = true
              abortController.signal.removeEventListener(
                'abort',
                onAbortListener,
              )
              reportPermissionWait()
              resolve({ behavior: 'ask', message: SUBAGENT_REJECT_MESSAGE })
            },
            async onAllow(
              updatedInput: Record<string, unknown>,
              permissionUpdates: PermissionUpdate[],
              feedback?: string,
              contentBlocks?: ContentBlockParam[],
            ) {
              if (decisionMade) return
              decisionMade = true
              abortController.signal.removeEventListener(
                'abort',
                onAbortListener,
              )
              reportPermissionWait()
              persistPermissionUpdates(permissionUpdates)
              // 将权限更新回写到 leader 的共享上下文
              if (permissionUpdates.length > 0) {
                const setToolPermissionContext =
                  getLeaderSetToolPermissionContext()
                if (setToolPermissionContext) {
                  const currentAppState = toolUseContext.getAppState()
                  const updatedContext = applyPermissionUpdates(
                    currentAppState.toolPermissionContext,
                    permissionUpdates,
                  )
                  // 保留 leader 的模式，防止 worker 转换后的
                  // 'acceptEdits' 上下文泄漏回协调者
                  setToolPermissionContext(updatedContext, {
                    preserveMode: true,
                  })
                }
              }
              const trimmedFeedback = feedback?.trim()
              resolve({
                behavior: 'allow',
                updatedInput,
                userModified: false,
                acceptFeedback: trimmedFeedback || undefined,
                ...(contentBlocks &&
                  contentBlocks.length > 0 && { contentBlocks }),
              })
            },
            onReject(feedback?: string, contentBlocks?: ContentBlockParam[]) {
              if (decisionMade) return
              decisionMade = true
              abortController.signal.removeEventListener(
                'abort',
                onAbortListener,
              )
              reportPermissionWait()
              const message = feedback
                ? `${SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX}${feedback}`
                : SUBAGENT_REJECT_MESSAGE
              resolve({ behavior: 'ask', message, contentBlocks })
            },
            async recheckPermission() {
              if (decisionMade) return
              const freshResult = await hasPermissionsToUseTool(
                tool,
                input,
                toolUseContext,
                assistantMessage,
                toolUseID,
              )
              if (freshResult.behavior === 'allow') {
                decisionMade = true
                abortController.signal.removeEventListener(
                  'abort',
                  onAbortListener,
                )
                reportPermissionWait()
                setToolUseConfirmQueue(queue =>
                  queue.filter(item => item.toolUseID !== toolUseID),
                )
                resolve({
                  ...freshResult,
                  updatedInput: input,
                  userModified: false,
                })
              }
            },
          },
        ])
      })
    }

    // 回退方案：当 leader UI 队列不可用时使用邮箱系统
    return new Promise<PermissionDecision>(resolve => {
      const request = createPermissionRequest({
        toolName: (tool as Tool).name,
        toolUseId: toolUseID,
        input,
        description,
        permissionSuggestions: result.suggestions,
        workerId: identity.agentId,
        workerName: identity.agentName,
        workerColor: identity.color,
        teamName: identity.teamName,
      })

      // 注册回调，当 leader 响应时调用
      registerPermissionCallback({
        requestId: request.id,
        toolUseId: toolUseID,
        onAllow(
          updatedInput: Record<string, unknown> | undefined,
          permissionUpdates: PermissionUpdate[],
          _feedback?: string,
          contentBlocks?: ContentBlockParam[],
        ) {
          cleanup()
          persistPermissionUpdates(permissionUpdates)
          const finalInput =
            updatedInput && Object.keys(updatedInput).length > 0
              ? updatedInput
              : input
          resolve({
            behavior: 'allow',
            updatedInput: finalInput,
            userModified: false,
            ...(contentBlocks && contentBlocks.length > 0 && { contentBlocks }),
          })
        },
        onReject(feedback?: string, contentBlocks?: ContentBlockParam[]) {
          cleanup()
          const message = feedback
            ? `${SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX}${feedback}`
            : SUBAGENT_REJECT_MESSAGE
          resolve({ behavior: 'ask', message, contentBlocks })
        },
      })

      // 向 leader 的邮箱发送请求
      void sendPermissionRequestViaMailbox(request)

      // 轮询 teammate 的邮箱以获取响应
      const pollInterval = setInterval(
        async (abortController, cleanup, resolve, identity, request) => {
          if (abortController.signal.aborted) {
            cleanup()
            resolve({ behavior: 'ask', message: SUBAGENT_REJECT_MESSAGE })
            return
          }

          const allMessages = await readMailbox(
            identity.agentName,
            identity.teamName,
          )
          for (let i = 0; i < allMessages.length; i++) {
            const msg = allMessages[i]
            if (msg && !msg.read) {
              const parsed = isPermissionResponse(msg.text)
              if (parsed && parsed.request_id === request.id) {
                await markMessageAsReadByIdentity(
                  identity.agentName,
                  identity.teamName,
                  msg,
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
                return // 回调已经解析了 Promise
              }
            }
          }
        },
        PERMISSION_POLL_INTERVAL_MS,
        abortController,
        cleanup,
        resolve,
        identity,
        request,
      )

      const onAbortListener = () => {
        cleanup()
        resolve({ behavior: 'ask', message: SUBAGENT_REJECT_MESSAGE })
      }

      abortController.signal.addEventListener('abort', onAbortListener, {
        once: true,
      })

      function cleanup() {
        clearInterval(pollInterval)
        unregisterPermissionCallback(request.id)
        abortController.signal.removeEventListener('abort', onAbortListener)
      }
    })
  }
}

/**
 * 将消息格式化为 <teammate-message> XML，以便注入到对话中。
 * 这确保模型看到的消息格式与 tmux teammate 相同。
 */
function formatAsTeammateMessage(
  from: string,
  content: string,
  color?: string,
  summary?: string,
): string {
  const colorAttr = color ? ` color="${color}"` : ''
  const summaryAttr = summary ? ` summary="${summary}"` : ''
  return `<${TEAMMATE_MESSAGE_TAG} teammate_id="${from}"${colorAttr}${summaryAttr}>\n${content}\n</${TEAMMATE_MESSAGE_TAG}>`
}

/**
 * 运行进程内 teammate 的配置。
 */
export type InProcessRunnerConfig = {
  /** teammate 身份上下文 */
  identity: TeammateIdentity
  /** AppState 中的任务 ID */
  taskId: string
  /** teammate 的初始提示词 */
  prompt: string
  /** 可选的 agent 定义（用于专用 agent） */
  agentDefinition?: CustomAgentDefinition
  /** 用于 AsyncLocalStorage 的 teammate 上下文 */
  teammateContext: TeammateContext
  /** 父级的工具使用上下文 */
  toolUseContext: ToolUseContext
  /** 关联到父级的中止控制器 */
  abortController: AbortController
  /** 此 teammate 的可选模型覆盖 */
  model?: string
  /** 此 teammate 的可选系统提示词覆盖 */
  systemPrompt?: string
  /** 系统提示词的应用方式：'replace' 替换或 'append' 追加到默认提示词 */
  systemPromptMode?: 'default' | 'replace' | 'append'
  /** 此 teammate 自动允许的工具权限 */
  allowedTools?: string[]
  /** 此 teammate 是否可以显示未列出工具的权限提示。
   * 当为 false（默认）时，未列出的工具将被自动拒绝。 */
  allowPermissionPrompts?: boolean
  /** 任务的简短描述（用作初始提示词头部的摘要） */
  description?: string
  /** 生成此 teammate 的 API 调用的 request_id，用于 tengu_api_* 事件的血缘追踪。 */
  invokingRequestId?: string
}

/**
 * 运行进程内 teammate 的结果。
 */
export type InProcessRunnerResult = {
  /** 运行是否成功完成 */
  success: boolean
  /** 失败时的错误消息 */
  error?: string
  /** agent 生成的消息 */
  messages: Message[]
}

/**
 * 更新 AppState 中的任务状态。
 */
function updateTaskState(
  taskId: string,
  updater: (task: InProcessTeammateTaskState) => InProcessTeammateTaskState,
  setAppState: SetAppStateFn,
): void {
  setAppState(prev => {
    const task = prev.tasks[taskId]
    if (!task || task.type !== 'in_process_teammate') {
      return prev
    }
    const updated = updater(task)
    if (updated === task) {
      return prev
    }
    return {
      ...prev,
      tasks: {
        ...prev.tasks,
        [taskId]: updated,
      },
    }
  })
}

/**
 * 向 leader 的基于文件的邮箱发送消息。
 * 使用与 tmux teammate 相同的邮箱系统以保持一致性。
 */
async function sendMessageToLeader(
  from: string,
  text: string,
  color: string | undefined,
  teamName: string,
): Promise<void> {
  await writeToMailbox(
    TEAM_LEAD_NAME,
    {
      from,
      text,
      timestamp: new Date().toISOString(),
      color,
    },
    teamName,
  )
}

/**
 * 通过基于文件的邮箱向 leader 发送空闲通知。
 * 使用 agentName（而非 agentId）以与基于进程的 teammate 保持一致。
 */
async function sendIdleNotification(
  agentName: string,
  agentColor: string | undefined,
  teamName: string,
  options?: {
    idleReason?: 'available' | 'interrupted' | 'failed'
    summary?: string
    completedTaskId?: string
    completedStatus?: 'resolved' | 'blocked' | 'failed'
    failureReason?: string
  },
): Promise<void> {
  const notification = createIdleNotification(agentName, options)

  await sendMessageToLeader(
    agentName,
    jsonStringify(notification),
    agentColor,
    teamName,
  )
}

/**
 * 从团队的任务列表中查找可用的任务。
 * 任务可用条件：状态为 pending，没有所有者，且未被阻塞。
 */
function findAvailableTask(tasks: Task[]): Task | undefined {
  const unresolvedTaskIds = new Set(
    tasks.filter(t => t.status !== 'completed').map(t => t.id),
  )

  return tasks.find(task => {
    if (task.status !== 'pending') return false
    if (task.owner) return false
    return task.blockedBy.every(id => !unresolvedTaskIds.has(id))
  })
}

/**
 * 将任务格式化为提示词，供 teammate 执行。
 */
function formatTaskAsPrompt(task: Task): string {
  let prompt = `Complete all open tasks. Start with task #${task.id}: \n\n ${task.subject}`

  if (task.description) {
    prompt += `\n\n${task.description}`
  }

  return prompt
}

/**
 * 尝试从团队的任务列表中认领一个可用任务。
 * 如果成功认领则返回格式化的提示词，否则返回 undefined。
 */
async function tryClaimNextTask(
  taskListId: string,
  agentName: string,
): Promise<string | undefined> {
  try {
    const tasks = await listTasks(taskListId)
    const availableTask = findAvailableTask(tasks)

    if (!availableTask) {
      return undefined
    }

    const result = await claimTask(taskListId, availableTask.id, agentName)

    if (!result.success) {
      logForDebugging(
        `[inProcessRunner] Failed to claim task #${availableTask.id}: ${result.reason}`,
      )
      return undefined
    }

    // 同时设置状态为 in_progress，以便 UI 能立即反映
    await updateTask(taskListId, availableTask.id, { status: 'in_progress' })

    logForDebugging(
      `[inProcessRunner] Claimed task #${availableTask.id}: ${availableTask.subject}`,
    )

    return formatTaskAsPrompt(availableTask)
  } catch (err) {
    logForDebugging(`[inProcessRunner] Error checking task list: ${err}`)
    return undefined
  }
}

/**
 * 等待消息的结果。
 */
type WaitResult =
  | {
      type: 'shutdown_request'
      request: ReturnType<typeof isShutdownRequest>
      originalMessage: string
    }
  | {
      type: 'new_message'
      message: string
      autonomyRunId?: string
      autonomyRootDir?: string
      from: string
      color?: string
      summary?: string
    }
  | {
      type: 'aborted'
    }

/**
 * 等待新的提示词或关闭请求。
 * 每 500ms 轮询 teammate 的邮箱，检查：
 * - 来自 leader 的关闭请求（返回给调用者由模型决策）
 * - 来自 leader 的新消息/提示词
 * - 中止信号
 *
 * 这使 teammate 保持在 'idle' 状态而不是终止。
 * 不会自动批准关闭——应由模型做出该决定。
 */
async function waitForNextPromptOrShutdown(
  identity: TeammateIdentity,
  abortController: AbortController,
  taskId: string,
  getAppState: () => AppState,
  setAppState: SetAppStateFn,
  taskListId: string,
): Promise<WaitResult> {
  const POLL_INTERVAL_MS = 500

  logForDebugging(
    `[inProcessRunner] ${identity.agentName} starting poll loop (abort=${abortController.signal.aborted})`,
  )

  let pollCount = 0
  while (!abortController.signal.aborted) {
    // 每次迭代检查内存中待处理的消息（来自 transcript 查看）
    const appState = getAppState()
    const task = appState.tasks[taskId]
    if (
      task &&
      task.type === 'in_process_teammate' &&
      task.pendingUserMessages.length > 0
    ) {
      const pending = task.pendingUserMessages[0]! // 安全：已检查长度 > 0
      // 从队列中弹出消息
      setAppState(prev => {
        const prevTask = prev.tasks[taskId]
        if (!prevTask || prevTask.type !== 'in_process_teammate') {
          return prev
        }
        return {
          ...prev,
          tasks: {
            ...prev.tasks,
            [taskId]: {
              ...prevTask,
              pendingUserMessages: prevTask.pendingUserMessages.slice(1),
            },
          },
        }
      })
      logForDebugging(
        `[inProcessRunner] ${identity.agentName} found pending user message (poll #${pollCount})`,
      )
      if (pending.autonomyRunId) {
        await markAutonomyRunRunning(
          pending.autonomyRunId,
          pending.autonomyRootDir,
        )
      }
      return {
        type: 'new_message',
        message: pending.message,
        autonomyRunId: pending.autonomyRunId,
        autonomyRootDir: pending.autonomyRootDir,
        from: 'user',
      }
    }

    // 在下一次轮询前等待（首次迭代跳过以立即检查）
    if (pollCount > 0) {
      await sleep(POLL_INTERVAL_MS)
    }
    pollCount++

    // 检查是否已中止
    if (abortController.signal.aborted) {
      logForDebugging(
        `[inProcessRunner] ${identity.agentName} aborted while waiting (poll #${pollCount})`,
      )
      return { type: 'aborted' }
    }

    // 检查邮箱中的消息
    logForDebugging(
      `[inProcessRunner] ${identity.agentName} poll #${pollCount}: checking mailbox`,
    )
    try {
      // 读取所有消息并首先扫描未读的关闭请求。
      // 关闭请求优先于常规消息处理，以防止
      // 当点对点消息淹没队列时出现饥饿。
      const allMessages = await readMailbox(
        identity.agentName,
        identity.teamName,
      )

      // 扫描所有未读消息以查找关闭请求（最高优先级）。
      // readMailbox() 已从磁盘读取所有消息，因此此扫描
      // 仅增加约 1-2ms 的 JSON 解析开销。
      let shutdownIndex = -1
      let shutdownParsed: ReturnType<typeof isShutdownRequest> = null
      for (let i = 0; i < allMessages.length; i++) {
        const m = allMessages[i]
        if (m && !m.read) {
          const parsed = isShutdownRequest(m.text)
          if (parsed) {
            shutdownIndex = i
            shutdownParsed = parsed
            break
          }
        }
      }

      if (shutdownIndex !== -1) {
        const msg = allMessages[shutdownIndex]!
        const skippedUnread = count(
          allMessages.slice(0, shutdownIndex),
          m => !m.read,
        )
        logForDebugging(
          `[inProcessRunner] ${identity.agentName} received shutdown request from ${shutdownParsed?.from} (prioritized over ${skippedUnread} unread messages)`,
        )
        await markMessageAsReadByIdentity(
          identity.agentName,
          identity.teamName,
          msg,
        )
        return {
          type: 'shutdown_request',
          request: shutdownParsed,
          originalMessage: msg.text,
        }
      }

      // 未找到关闭请求。优先处理 team-lead 的消息而非
      // 对等消息——leader 代表用户意图和协调，
      // 因此其消息不应被点对点闲聊所淹没。
      // 对等消息按 FIFO 顺序处理。
      let selectedIndex = -1

      // 首先检查未读的 team-lead 消息
      for (let i = 0; i < allMessages.length; i++) {
        const m = allMessages[i]
        if (m && !m.read && m.from === TEAM_LEAD_NAME) {
          selectedIndex = i
          break
        }
      }

      // 回退到第一条未读消息（任何发送者）
      if (selectedIndex === -1) {
        selectedIndex = allMessages.findIndex(m => !m.read)
      }

      if (selectedIndex !== -1) {
        const msg = allMessages[selectedIndex]
        if (msg) {
          logForDebugging(
            `[inProcessRunner] ${identity.agentName} received new message from ${msg.from} (index ${selectedIndex})`,
          )
          await markMessageAsReadByIdentity(
            identity.agentName,
            identity.teamName,
            msg,
          )
          return {
            type: 'new_message',
            message: msg.text,
            from: msg.from,
            color: msg.color,
            summary: msg.summary,
          }
        }
      }
    } catch (err) {
      logForDebugging(
        `[inProcessRunner] ${identity.agentName} poll error: ${err}`,
      )
      // 即使某次读取失败也继续轮询
    }

    // 检查团队的任务列表中是否有未认领的任务
    const taskPrompt = await tryClaimNextTask(taskListId, identity.agentName)
    if (taskPrompt) {
      return {
        type: 'new_message',
        message: taskPrompt,
        from: 'task-list',
      }
    }
  }

  logForDebugging(
    `[inProcessRunner] ${identity.agentName} exiting poll loop (abort=${abortController.signal.aborted}, polls=${pollCount})`,
  )
  return { type: 'aborted' }
}

/**
 * 运行带有持续提示词循环的进程内 teammate。
 *
 * 在 teammate 的 AsyncLocalStorage 上下文中执行 runAgent()，
 * 追踪进度，更新任务状态，完成时发送空闲通知，
 * 然后等待新的提示词或关闭请求。
 *
 * 与后台任务不同，teammate 保持存活并可以接收多个提示词。
 * 循环仅在中止或模型批准关闭后退出。
 *
 * @param config - 运行器配置
 * @returns 包含消息和成功状态的结果
 */
export async function runInProcessTeammate(
  config: InProcessRunnerConfig,
): Promise<InProcessRunnerResult> {
  const {
    identity,
    taskId,
    prompt,
    description,
    agentDefinition,
    teammateContext,
    toolUseContext,
    abortController,
    model,
    systemPrompt,
    systemPromptMode,
    allowedTools,
    allowPermissionPrompts,
    invokingRequestId,
  } = config
  const { setAppState } = toolUseContext
  const startTime = Date.now()

  logForDebugging(
    `[inProcessRunner] Starting agent loop for ${identity.agentId}`,
  )

  // 创建 AgentContext 用于分析归因
  const agentContext: AgentContext = {
    agentId: identity.agentId,
    parentSessionId: identity.parentSessionId,
    agentName: identity.agentName,
    teamName: identity.teamName,
    agentColor: identity.color,
    planModeRequired: identity.planModeRequired,
    isTeamLead: false,
    agentType: 'teammate',
    invokingRequestId,
    invocationKind: 'spawn',
    invocationEmitted: false,
  }

  // 根据 systemPromptMode 构建系统提示词
  let teammateSystemPrompt: string
  if (systemPromptMode === 'replace' && systemPrompt) {
    teammateSystemPrompt = systemPrompt
  } else {
    const fullSystemPromptParts = await getSystemPrompt(
      toolUseContext.options.tools,
      toolUseContext.options.mainLoopModel,
      undefined,
      toolUseContext.options.mcpClients,
    )

    const systemPromptParts = [
      ...fullSystemPromptParts,
      TEAMMATE_SYSTEM_PROMPT_ADDENDUM,
    ]

    // 如果提供了自定义 agent 定义，追加其提示词
    if (agentDefinition) {
      const customPrompt = agentDefinition.getSystemPrompt()
      if (customPrompt) {
        systemPromptParts.push(`\n# Custom Agent Instructions\n${customPrompt}`)
      }

      // 为进程内 teammate 记录 agent memory loaded 事件
      if (agentDefinition.memory) {
        logEvent('tengu_agent_memory_loaded', {
          ...(process.env.USER_TYPE === 'ant'
            ? {
                agent_type:
                  agentDefinition.agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              }
            : {}),
          scope:
            agentDefinition.memory as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          source:
            'in-process-teammate' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
      }
    }

    // 追加模式：在默认提示词后添加提供的系统提示词
    if (systemPromptMode === 'append' && systemPrompt) {
      systemPromptParts.push(systemPrompt)
    }

    teammateSystemPrompt = systemPromptParts.join('\n')
  }

  // 解析 agent 定义 - 使用带有 teammate 附录的完整系统提示词
  // 重要：将 permissionMode 设置为 'default'，以便 teammate 始终获得完整的工具
  // 访问权限，不受 leader 权限模式的影响。
  const resolvedAgentDefinition: CustomAgentDefinition = {
    agentType: identity.agentName,
    whenToUse: `In-process teammate: ${identity.agentName}`,
    getSystemPrompt: () => teammateSystemPrompt,
    // 注入团队必需工具，使 teammate 始终能够响应
    // 关闭请求、发送消息，并通过任务列表进行协调，
    // 即使有明确的工具列表
    tools: agentDefinition?.tools
      ? [
          ...new Set([
            ...agentDefinition.tools,
            SEND_MESSAGE_TOOL_NAME,
            TEAM_CREATE_TOOL_NAME,
            TEAM_DELETE_TOOL_NAME,
            TASK_CREATE_TOOL_NAME,
            TASK_GET_TOOL_NAME,
            TASK_LIST_TOOL_NAME,
            TASK_UPDATE_TOOL_NAME,
          ]),
        ]
      : ['*'],
    source: 'projectSettings',
    permissionMode: 'default',
    // 从自定义 agent 定义传播模型，以便 getAgentModel()
    // 在未指定工具级模型时可用作回退
    ...(agentDefinition?.model ? { model: agentDefinition.model } : {}),
  }

  // 跨所有提示词的所有消息
  const allMessages: Message[] = []
  // 用 XML 包装初始提示词，以便在 transcript 视图中正确显示样式
  const wrappedInitialPrompt = formatAsTeammateMessage(
    'team-lead',
    prompt,
    undefined,
    description,
  )
  let currentPrompt = wrappedInitialPrompt
  let currentAutonomyRunId: string | undefined
  let currentAutonomyRootDir: string | undefined
  let shouldExit = false

  // 尝试立即认领一个可用任务，以便 UI 从一开始就
  // 显示活动。空闲循环处理后续任务的认领。
  // 使用 parentSessionId 作为任务列表 ID，因为 leader 在其
  // 会话 ID（而非团队名称）下创建任务。
  await tryClaimNextTask(identity.parentSessionId, identity.agentName)

  try {
    // 将初始提示词添加到 task.messages 以供显示（用 XML 包装）
    updateTaskState(
      taskId,
      task => ({
        ...task,
        messages: appendCappedMessage(
          task.messages,
          createUserMessage({ content: wrappedInitialPrompt }),
        ),
      }),
      setAppState,
    )

    // 每个 teammate 的内容替换状态。下面的 while 循环反复调用
    // runAgent，通过累积的 `allMessages` 缓冲区（包含完整的
    // 原始工具结果内容，而非预览——query() 生成
    // 原始内容，强制执行不修改）。如果不跨迭代持久化状态，
    // 每次调用都会从 createSubagentContext 获取一个新的空状态，
    // 并做出全局最大替换的整体决策，与之前迭代的
    // 增量冻结优先决策产生分歧 → wire 前缀
    // 不同 → 缓存未命中。依赖于父级以继承 feature-flag-off。
    let teammateReplacementState = toolUseContext.contentReplacementState
      ? createContentReplacementState()
      : undefined

    // 主 teammate 循环 - 运行直到中止或批准关闭
    while (!abortController.signal.aborted && !shouldExit) {
      logForDebugging(
        `[inProcessRunner] ${identity.agentId} processing prompt: ${currentPrompt.substring(0, 50)}...`,
      )

      // 为此次迭代创建每轮的 abort 控制器。
      // 这允许 Escape 停止当前工作而不杀死整个 teammate。
      // 生命周期 abortController 仍可在需要时杀死整个 teammate。
      const currentWorkAbortController = createAbortController()

      // 将工作控制器存储在任务状态中，以便 UI 可以中止它
      updateTaskState(
        taskId,
        task => ({ ...task, currentWorkAbortController }),
        setAppState,
      )

      // 为此次迭代准备提示词消息
      // 首次迭代从头开始
      // 后续迭代将累积的消息作为上下文传递
      const userMessage = createUserMessage({ content: currentPrompt })
      const promptMessages: Message[] = [userMessage]

      // 在构建上下文之前检查是否需要压缩
      let contextMessages = allMessages
      const tokenCount = tokenCountWithEstimation(allMessages)
      if (
        tokenCount >
        getAutoCompactThreshold(toolUseContext.options.mainLoopModel)
      ) {
        logForDebugging(
          `[inProcessRunner] ${identity.agentId} compacting history (${tokenCount} tokens)`,
        )
        // 创建 toolUseContext 的隔离副本，以便压缩
        // 不会清除主会话的 readFileState 缓存或
        // 触发主会话的 UI 回调。
        const isolatedContext: ToolUseContext = {
          ...toolUseContext,
          readFileState: cloneFileStateCache(toolUseContext.readFileState),
          onCompactProgress: undefined,
          setStreamMode: undefined,
        }
        const compactedSummary = await compactConversation(
          allMessages,
          isolatedContext,
          {
            systemPrompt: asSystemPrompt([]),
            userContext: {},
            systemContext: {},
            toolUseContext: isolatedContext,
            forkContextMessages: [],
          },
          true, // suppressFollowUpQuestions
          undefined, // customInstructions
          true, // isAutoCompact
        )
        contextMessages = buildPostCompactMessages(compactedSummary)
        // 重置 microcompact 状态，因为完整压缩替换了所有
        // 消息——旧的工具 ID 不再相关
        resetMicrocompactState()
        // 重置内容替换状态——压缩替换了所有消息
        // 因此旧的 tool_use_ids 已消失。陈旧的 Map 条目是无害的
        // （UUID 键永远不会匹配），但在长时间运行时会积累内存。
        if (teammateReplacementState) {
          teammateReplacementState = createContentReplacementState()
        }
        // 就地更新 allMessages 为压缩版本
        allMessages.length = 0
        allMessages.push(...contextMessages)

        // 同步压缩到 task.messages——否则 AppState
        // 镜像会无限增长（500 轮 = 500+ 消息，10-50MB）。
        // 替换为压缩后的消息，与 allMessages 一致。
        updateTaskState(
          taskId,
          task => ({ ...task, messages: [...contextMessages, userMessage] }),
          setAppState,
        )
      }

      // 将之前的消息作为上下文传递以保留对话历史
      // allMessages 累积所有之前迭代中的消息（用户 + 助手）
      const forkContextMessages =
        contextMessages.length > 0 ? [...contextMessages] : undefined

      // 将用户消息添加到 allMessages，以便包含在未来的上下文中
      // 这确保完整的对话（用户 + 助手轮次）被保留
      allMessages.push(userMessage)

      // 为此提示词创建新的进度追踪器
      const tracker = createProgressTracker()
      const resolveActivity = createActivityDescriptionResolver(
        toolUseContext.options.tools,
      )
      const iterationMessages: Message[] = []

      // 从任务状态读取当前权限模式（可能已被 leader 通过 Shift+Tab 切换）
      const currentAppState = toolUseContext.getAppState()
      const currentTask = currentAppState.tasks[taskId]
      const currentPermissionMode =
        currentTask && currentTask.type === 'in_process_teammate'
          ? currentTask.permissionMode
          : 'default'
      const iterationAgentDefinition = {
        ...resolvedAgentDefinition,
        permissionMode: currentPermissionMode,
      }

      // 追踪此次迭代是否被工作中止（非生命周期中止）
      let workWasAborted = false

      // 在上下文中运行 agent
      await runWithTeammateContext(teammateContext, async () => {
        return runWithAgentContext(agentContext, async () => {
          // 将任务标记为运行中（非空闲）
          updateTaskState(
            taskId,
            task => ({ ...task, status: 'running', isIdle: false }),
            setAppState,
          )

          // 运行正常的 agent 循环——与 AgentTool/subagent 使用的 runAgent() 相同。
          // 这在内部调用 query()，因此我们共享核心 API 基础设施。
          // 传递 forkContextMessages 以跨提示词保留对话历史。
          // 进程内 teammate 是异步的，但与 leader 运行在同一进程中，
          // 因此它们可以显示权限提示（不同于真正的后台 agent）。
          // 使用 currentWorkAbortController 以便 Escape 仅停止此轮次，而非整个 teammate。
          for await (const message of runAgent({
            agentDefinition: iterationAgentDefinition,
            promptMessages,
            toolUseContext,
            canUseTool: createInProcessCanUseTool(
              identity,
              currentWorkAbortController,
              (waitMs: number) => {
                updateTaskState(
                  taskId,
                  task => ({
                    ...task,
                    totalPausedMs: (task.totalPausedMs ?? 0) + waitMs,
                  }),
                  setAppState,
                )
              },
            ),
            isAsync: true,
            canShowPermissionPrompts: allowPermissionPrompts ?? true,
            forkContextMessages,
            querySource: 'agent:custom',
            override: { abortController: currentWorkAbortController },
            model: model as ModelAlias | undefined,
            preserveToolUseResults: true,
            availableTools: toolUseContext.options.tools,
            allowedTools,
            contentReplacementState: teammateReplacementState,
          })) {
            // 首先检查生命周期中止（杀死整个 teammate）
            if (abortController.signal.aborted) {
              logForDebugging(
                `[inProcessRunner] ${identity.agentId} lifecycle aborted`,
              )
              break
            }

            // 检查工作中止（仅停止当前轮次）
            if (currentWorkAbortController.signal.aborted) {
              logForDebugging(
                `[inProcessRunner] ${identity.agentId} current work aborted (Escape pressed)`,
              )
              workWasAborted = true
              break
            }

            iterationMessages.push(message)
            allMessages.push(message)

            updateProgressFromMessage(
              tracker,
              message,
              resolveActivity,
              toolUseContext.options.tools,
            )
            const progress = getProgressUpdate(tracker)

            updateTaskState(
              taskId,
              task => {
                // 追踪进行中的工具使用 ID，用于 transcript 视图中的动画
                let inProgressToolUseIDs = task.inProgressToolUseIDs
                if (message.type === 'assistant') {
                  for (const block of Array.isArray(message.message!.content)
                    ? message.message!.content
                    : []) {
                    if (
                      typeof block !== 'string' &&
                      block.type === 'tool_use'
                    ) {
                      inProgressToolUseIDs = new Set([
                        ...(inProgressToolUseIDs ?? []),
                        block.id,
                      ])
                    }
                  }
                } else if (message.type === 'user') {
                  const content = message.message!.content
                  if (Array.isArray(content)) {
                    for (const block of content) {
                      if (
                        typeof block === 'object' &&
                        'type' in block &&
                        block.type === 'tool_result'
                      ) {
                        if (inProgressToolUseIDs) {
                          inProgressToolUseIDs = new Set(inProgressToolUseIDs)
                          inProgressToolUseIDs.delete(block.tool_use_id)
                        }
                      }
                    }
                  }
                }

                return {
                  ...task,
                  progress,
                  messages: appendCappedMessage(task.messages, message),
                  inProgressToolUseIDs,
                }
              },
              setAppState,
            )
          }

          return { success: true, messages: iterationMessages }
        })
      })

      // 从状态中清除工作控制器（它已不再有效）
      updateTaskState(
        taskId,
        task => ({ ...task, currentWorkAbortController: undefined }),
        setAppState,
      )

      // 检查 agent 运行期间是否发生了生命周期中止（杀死整个 teammate）
      if (abortController.signal.aborted) {
        break
      }

      // 如果工作被中止（Escape），记录并添加中断消息，然后继续进入空闲状态
      if (workWasAborted) {
        logForDebugging(
          `[inProcessRunner] ${identity.agentId} work interrupted, returning to idle`,
        )

        // 将中断消息添加到 teammate 的消息中，以便显示在其滚动缓冲区中
        const interruptMessage = createAssistantAPIErrorMessage({
          content: ERROR_MESSAGE_USER_ABORT,
        })
        updateTaskState(
          taskId,
          task => ({
            ...task,
            messages: appendCappedMessage(task.messages, interruptMessage),
          }),
          setAppState,
        )
        if (currentAutonomyRunId) {
          await markAutonomyRunFailed(
            currentAutonomyRunId,
            ERROR_MESSAGE_USER_ABORT,
            currentAutonomyRootDir,
          )
          currentAutonomyRunId = undefined
          currentAutonomyRootDir = undefined
        }
      } else if (currentAutonomyRunId) {
        await markAutonomyRunCompleted(
          currentAutonomyRunId,
          currentAutonomyRootDir,
        )
        currentAutonomyRunId = undefined
        currentAutonomyRootDir = undefined
      }

      // 在更新前检查是否已空闲（以跳过重复通知）
      const prevAppState = toolUseContext.getAppState()
      const prevTask = prevAppState.tasks[taskId]
      const wasAlreadyIdle =
        prevTask?.type === 'in_process_teammate' && prevTask.isIdle

      // 将任务标记为空闲（非已完成）并通知任何等待者
      updateTaskState(
        taskId,
        task => {
          // 调用任何已注册的空闲回调
          task.onIdleCallbacks?.forEach(cb => cb())
          return { ...task, isIdle: true, onIdleCallbacks: [] }
        },
        setAppState,
      )

      // 注意：我们不会自动将 teammate 的响应发送给 leader。
      // Teammate 应使用 Teammate 工具与 leader 通信。
      // 这与基于进程的 teammate 一致，其输出对 leader 不可见。

      // 仅在转换为空闲状态时发送空闲通知（如果已空闲则不发送）
      if (!wasAlreadyIdle) {
        await sendIdleNotification(
          identity.agentName,
          identity.color,
          identity.teamName,
          {
            idleReason: workWasAborted ? 'interrupted' : 'available',
            summary: getLastPeerDmSummary(allMessages),
          },
        )
      } else {
        logForDebugging(
          `[inProcessRunner] Skipping duplicate idle notification for ${identity.agentName}`,
        )
      }

      logForDebugging(
        `[inProcessRunner] ${identity.agentId} finished prompt, waiting for next`,
      )

      // 等待下一条消息或关闭请求
      const waitResult = await waitForNextPromptOrShutdown(
        identity,
        abortController,
        taskId,
        toolUseContext.getAppState,
        setAppState,
        identity.parentSessionId,
      )

      switch (waitResult.type) {
        case 'shutdown_request':
          // 将关闭请求传递给模型进行决策
          // 格式化为 teammate-message，与 tmux teammate 接收方式保持一致
          // 模型将使用 approveShutdown 或 rejectShutdown 工具
          logForDebugging(
            `[inProcessRunner] ${identity.agentId} received shutdown request - passing to model`,
          )
          currentPrompt = formatAsTeammateMessage(
            waitResult.request?.from || 'team-lead',
            waitResult.originalMessage,
          )
          // 将关闭请求添加到 task.messages 以供 transcript 显示
          appendTeammateMessage(
            taskId,
            createUserMessage({ content: currentPrompt }),
            setAppState,
          )
          currentAutonomyRunId = undefined
          currentAutonomyRootDir = undefined
          break

        case 'new_message':
          // 来自 leader 或 teammate 的新提示词
          logForDebugging(
            `[inProcessRunner] ${identity.agentId} received new message from ${waitResult.from}`,
          )
          // 来自用户的消息应为纯文本（不用 XML 包装）
          // 来自其他 teammate 的消息用 XML 包装以便识别
          if (waitResult.from === 'user') {
            currentPrompt = waitResult.message
            currentAutonomyRunId = waitResult.autonomyRunId
            currentAutonomyRootDir = waitResult.autonomyRootDir
          } else {
            currentPrompt = formatAsTeammateMessage(
              waitResult.from,
              waitResult.message,
              waitResult.color,
              waitResult.summary,
            )
            // 添加到 task.messages 以供 transcript 显示（仅限非用户消息）
            // 来自 'user' 的消息来自 pendingUserMessages，已由
            // injectUserMessageToTeammate 添加
            appendTeammateMessage(
              taskId,
              createUserMessage({ content: currentPrompt }),
              setAppState,
            )
            currentAutonomyRunId = undefined
            currentAutonomyRootDir = undefined
          }
          break

        case 'aborted':
          logForDebugging(
            `[inProcessRunner] ${identity.agentId} aborted while waiting`,
          )
          shouldExit = true
          break
      }
    }

    // 退出循环时标记为已完成
    let alreadyTerminal = false
    let toolUseId: string | undefined

    // 计算结果以便详情对话框可以显示 token 使用情况。
    // 反向遍历以获取最后一次 API 使用情况（来自
    // Anthropic API 的累计 input_tokens 已包含所有先前上下文）。
    let completionTokens = 0
    let completionToolUseCount = 0
    let lastAssistantContent: AgentToolResult['content'] = []
    let lastUsage: AgentToolResult['usage'] | undefined
    for (let i = allMessages.length - 1; i >= 0; i--) {
      const m = allMessages[i]!
      if (m.type === 'assistant') {
        const blocks = (m.message?.content ?? []) as any[]
        for (const b of blocks) {
          if (b?.type === 'tool_use') completionToolUseCount++
        }
        const textBlocks = blocks.filter((b: any) => b?.type === 'text')
        if (textBlocks.length > 0 && lastAssistantContent.length === 0) {
          lastAssistantContent = textBlocks.map((b: any) => ({
            type: 'text' as const,
            text: b.text,
          }))
        }
        if (!lastUsage && m.message?.usage) {
          lastUsage = m.message.usage as AgentToolResult['usage']
          completionTokens = getTokenCountFromUsage(
            m.message.usage as Parameters<typeof getTokenCountFromUsage>[0],
          )
        }
        if (completionTokens > 0 && lastAssistantContent.length > 0) break
      }
    }

    const teammateResult: AgentToolResult = {
      agentId: identity.agentId,
      agentType: 'teammate',
      content: lastAssistantContent,
      totalToolUseCount: completionToolUseCount,
      totalDurationMs: Date.now() - startTime,
      totalTokens: completionTokens,
      usage: lastUsage as AgentToolResult['usage'],
    } as unknown as AgentToolResult

    updateTaskState(
      taskId,
      task => {
        // killInProcessTeammate 可能已设置 status:killed +
        // notified:true + 清除字段。不要覆盖（否则会将
        // killed 翻转为 completed 并重复发送 SDK 端点）。
        if (task.status !== 'running') {
          alreadyTerminal = true
          return task
        }
        toolUseId = task.toolUseId
        task.onIdleCallbacks?.forEach(cb => cb())
        task.unregisterCleanup?.()
        return {
          ...task,
          status: 'completed' as const,
          notified: true,
          endTime: Date.now(),
          result: teammateResult,
          messages: task.messages?.length ? [task.messages.at(-1)!] : undefined,
          pendingUserMessages: [],
          inProgressToolUseIDs: undefined,
          abortController: undefined,
          unregisterCleanup: undefined,
          currentWorkAbortController: undefined,
          onIdleCallbacks: [],
        }
      },
      setAppState,
    )
    void evictTaskOutput(taskId)
    // 由于任务已被消费，主动从 AppState 中驱逐
    evictTerminalTask(taskId, setAppState)
    // notified:true 已预设 → 无 XML 通知 → print.ts 不会发送
    // SDK task_notification。直接关闭 task_started 端点。
    if (!alreadyTerminal) {
      emitTaskTerminatedSdk(taskId, 'completed', {
        toolUseId,
        summary: identity.agentId,
      })
    }
    unregisterPerfettoAgent(identity.agentId)
    return { success: true, messages: allMessages }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error'

    logForDebugging(
      `[inProcessRunner] Agent ${identity.agentId} failed: ${errorMessage}`,
    )

    // 将任务标记为失败并通知任何等待者
    let alreadyTerminal = false
    let toolUseId: string | undefined
    updateTaskState(
      taskId,
      task => {
        if (task.status !== 'running') {
          alreadyTerminal = true
          return task
        }
        toolUseId = task.toolUseId
        task.onIdleCallbacks?.forEach(cb => cb())
        task.unregisterCleanup?.()
        return {
          ...task,
          status: 'failed' as const,
          notified: true,
          error: errorMessage,
          isIdle: true,
          endTime: Date.now(),
          onIdleCallbacks: [],
          messages: task.messages?.length ? [task.messages.at(-1)!] : undefined,
          pendingUserMessages: [],
          inProgressToolUseIDs: undefined,
          abortController: undefined,
          unregisterCleanup: undefined,
          currentWorkAbortController: undefined,
        }
      },
      setAppState,
    )
    void evictTaskOutput(taskId)
    // 由于任务已被消费，主动从 AppState 中驱逐
    evictTerminalTask(taskId, setAppState)
    // notified:true 已预设 → 无 XML 通知 → 直接关闭 SDK 端点。
    if (!alreadyTerminal) {
      emitTaskTerminatedSdk(taskId, 'failed', {
        toolUseId,
        summary: identity.agentId,
      })
    }
    if (currentAutonomyRunId) {
      await markAutonomyRunFailed(
        currentAutonomyRunId,
        errorMessage,
        currentAutonomyRootDir,
      )
    }

    // 通过基于文件的邮箱发送带有失败信息的空闲通知
    await sendIdleNotification(
      identity.agentName,
      identity.color,
      identity.teamName,
      {
        idleReason: 'failed',
        completedStatus: 'failed',
        failureReason: errorMessage,
      },
    )

    unregisterPerfettoAgent(identity.agentId)
    return {
      success: false,
      error: errorMessage,
      messages: allMessages,
    }
  }
}

/**
 * 在后台启动进程内 teammate。
 *
 * 这是 spawn 之后调用的主入口点。它以
 * fire-and-forget 方式启动 agent 执行循环。
 *
 * @param config - 运行器配置
 */
export function startInProcessTeammate(config: InProcessRunnerConfig): void {
  // 在闭包之前提取 agentId，这样 catch 处理程序在 Promise
  // 挂起时不会保留完整的 config 对象（包括 toolUseContext）
  // ——对于长时间运行的 teammate 可能是数小时。
  const agentId = config.identity.agentId
  void runInProcessTeammate(config).catch(error => {
    logForDebugging(`[inProcessRunner] Unhandled error in ${agentId}: ${error}`)
  })
}
