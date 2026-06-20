/**
 * LocalMainSessionTask —— 处理主会话查询的后台化。
 *
 * 当用户在查询过程中按两次 Ctrl+B 时，会话会被「后台化」：
 * - 查询继续在后台运行
 * - UI 清空为新的输入提示
 * - 查询完成时会发送一条通知
 *
 * 由于行为类似，这里复用了 LocalAgentTask 的状态结构。
 */

import type { UUID } from 'crypto'
import { randomBytes } from 'crypto'
import {
  OUTPUT_FILE_TAG,
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
  TOOL_USE_ID_TAG,
} from '../constants/xml.js'
import { type QueryParams, query } from '../query.js'
import { roughTokenCountEstimation } from '../services/tokenEstimation.js'
import type { SetAppState } from '../Task.js'
import { createTaskStateBase } from '../Task.js'
import type {
  AgentDefinition,
  CustomAgentDefinition,
} from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import { asAgentId } from '../types/ids.js'
import type { Message } from '../types/message.js'
import { createAbortController } from '../utils/abortController.js'
import {
  runWithAgentContext,
  type SubagentContext,
} from '../utils/agentContext.js'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import { logForDebugging } from '../utils/debug.js'
import { logError } from '../utils/log.js'
import { enqueuePendingNotification } from '../utils/messageQueueManager.js'
import { emitTaskTerminatedSdk } from '../utils/sdkEventQueue.js'
import {
  getAgentTranscriptPath,
  recordSidechainTranscript,
} from '../utils/sessionStorage.js'
import {
  evictTaskOutput,
  getTaskOutputPath,
  initTaskOutputAsSymlink,
} from '../utils/task/diskOutput.js'
import { registerTask, updateTaskState } from '../utils/task/framework.js'
import type { LocalAgentTaskState } from './LocalAgentTask/LocalAgentTask.js'

// main session 任务使用 LocalAgentTaskState，其 agentType='main-session'
export type LocalMainSessionTaskState = LocalAgentTaskState & {
  agentType: 'main-session'
}

/**
 * main session 任务在未指定 agent 时使用的默认 agent 定义。
 */
const DEFAULT_MAIN_SESSION_AGENT: CustomAgentDefinition = {
  agentType: 'main-session',
  whenToUse: 'Main session query',
  source: 'userSettings',
  getSystemPrompt: () => '',
}

/**
 * 为 main session 任务生成唯一的任务 ID。
 * 使用 's' 前缀以便与 agent 任务（'a' 前缀）区分。
 */
const TASK_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

function generateMainSessionTaskId(): string {
  const bytes = randomBytes(8)
  let id = 's'
  for (let i = 0; i < 8; i++) {
    id += TASK_ID_ALPHABET[bytes[i]! % TASK_ID_ALPHABET.length]
  }
  return id
}

/**
 * 注册一个已后台化的 main session 任务。
 * 由用户后台化当前会话查询时调用。
 *
 * @param description - 任务描述
 * @param setAppState - 状态设置函数
 * @param mainThreadAgentDefinition - 可选的 agent 定义（当以 --agent 运行时使用）
 * @param existingAbortController - 可选的复用 abort controller（用于后台化正在进行的查询）
 * @returns 包含任务 ID 和用于停止后台查询的 abort 信号的对象
 */
export function registerMainSessionTask(
  description: string,
  setAppState: SetAppState,
  mainThreadAgentDefinition?: AgentDefinition,
  existingAbortController?: AbortController,
): { taskId: string; abortSignal: AbortSignal } {
  const taskId = generateMainSessionTaskId()

  // 将输出链接到按任务隔离的对话记录文件（布局与子 agent 一致）。
  // 不要使用 getTranscriptPath() —— 那是主会话的文件，在 /clear 之后
  // 从后台查询往里写会破坏 clear 之后的对话。隔离的路径让此任务能够
  // 跨越 /clear 存活：clearConversation 中的符号链接重链接会处理会话 ID 变更。
  void initTaskOutputAsSymlink(
    taskId,
    getAgentTranscriptPath(asAgentId(taskId)),
  )

  // 如果提供了已存在的 abort controller 就复用（对后台化进行中的查询非常重要）
  // 这样保证终止该任务就等于终止实际的查询
  const abortController = existingAbortController ?? createAbortController()

  const unregisterCleanup = registerCleanup(async () => {
    // 进程退出时清理
    setAppState(prev => {
      const { [taskId]: removed, ...rest } = prev.tasks
      return { ...prev, tasks: rest }
    })
  })

  // 使用传入的 agent 定义或默认值
  const selectedAgent = mainThreadAgentDefinition ?? DEFAULT_MAIN_SESSION_AGENT

  // 创建任务状态 —— 由于是在用户后台化时调用，所以一开始就是后台化状态
  const taskState: LocalMainSessionTaskState = {
    ...createTaskStateBase(taskId, 'local_agent', description),
    type: 'local_agent',
    status: 'running',
    agentId: taskId,
    prompt: description,
    selectedAgent,
    agentType: 'main-session',
    abortController,
    unregisterCleanup,
    retrieved: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    isBackgrounded: true, // 已经后台化
    pendingMessages: [],
    retain: false,
    diskLoaded: false,
  }

  logForDebugging(
    `[LocalMainSessionTask] Registering task ${taskId} with description: ${description}`,
  )
  registerTask(taskState, setAppState)

  // 通过检查状态验证任务已注册
  setAppState(prev => {
    const hasTask = taskId in prev.tasks
    logForDebugging(
      `[LocalMainSessionTask] After registration, task ${taskId} exists in state: ${hasTask}`,
    )
    return prev
  })

  return { taskId, abortSignal: abortController.signal }
}

/**
 * 完成 main session 任务并发送通知。
 * 在后台化的查询完成时调用。
 */
export function completeMainSessionTask(
  taskId: string,
  success: boolean,
  setAppState: SetAppState,
): void {
  let wasBackgrounded = true
  let toolUseId: string | undefined

  updateTaskState<LocalMainSessionTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') {
      return task
    }

    // 跟踪任务是否已后台化（用于决定是否发通知）
    wasBackgrounded = task.isBackgrounded ?? true
    toolUseId = task.toolUseId

    task.unregisterCleanup?.()

    return {
      ...task,
      status: success ? 'completed' : 'failed',
      endTime: Date.now(),
      messages: task.messages?.length ? [task.messages.at(-1)!] : undefined,
    }
  })

  void evictTaskOutput(taskId)

  // 只有任务仍处于后台化（没有被切回前台）才发送通知
  // 如果已切到前台，用户正在直接查看 —— 无需通知
  if (wasBackgrounded) {
    enqueueMainSessionNotification(
      taskId,
      'Background session',
      success ? 'completed' : 'failed',
      setAppState,
      toolUseId,
    )
  } else {
    // 前台状态：无 XML 通知（TUI 用户正在查看），但 SDK 消费者
    // 仍然需要看到 task_started 这一对儿事件的收尾。
    // 设置 notified 以通过 evictTerminalTask/generateTaskAttachments 的驱逐
    // 校验；后台化路径在 enqueueMainSessionNotification 的 check-and-set
    // 中已经设置了该字段。
    updateTaskState<LocalMainSessionTaskState>(taskId, setAppState, task => ({
      ...task,
      notified: true,
    }))
    emitTaskTerminatedSdk(taskId, success ? 'completed' : 'failed', {
      toolUseId,
      summary: 'Background session',
    })
  }
}

/**
 * 将一条关于后台化会话完成的通知入队。
 */
function enqueueMainSessionNotification(
  taskId: string,
  description: string,
  status: 'completed' | 'failed',
  setAppState: SetAppState,
  toolUseId?: string,
): void {
  // 原子地检查并设置 notified 标志，防止重复通知。
  let shouldEnqueue = false
  updateTaskState<LocalMainSessionTaskState>(taskId, setAppState, task => {
    if (task.notified) {
      return task
    }
    shouldEnqueue = true
    return { ...task, notified: true }
  })

  if (!shouldEnqueue) {
    return
  }

  const summary =
    status === 'completed'
      ? `Background session "${description}" completed`
      : `Background session "${description}" failed`

  const toolUseIdLine = toolUseId
    ? `\n<${TOOL_USE_ID_TAG}>${toolUseId}</${TOOL_USE_ID_TAG}>`
    : ''

  const outputPath = getTaskOutputPath(taskId)
  const message = `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${taskId}</${TASK_ID_TAG}>${toolUseIdLine}
<${OUTPUT_FILE_TAG}>${outputPath}</${OUTPUT_FILE_TAG}>
<${STATUS_TAG}>${status}</${STATUS_TAG}>
<${SUMMARY_TAG}>${summary}</${SUMMARY_TAG}>
</${TASK_NOTIFICATION_TAG}>`

  enqueuePendingNotification({ value: message, mode: 'task-notification' })
}

/**
 * 将一个 main session 任务切回前台 —— 标记为前台状态，使其输出
 * 显示在主视图中。后台查询继续运行。
 * 返回该任务已积累的消息，找不到任务时返回 undefined。
 */
export function foregroundMainSessionTask(
  taskId: string,
  setAppState: SetAppState,
): Message[] | undefined {
  let taskMessages: Message[] | undefined

  setAppState(prev => {
    const task = prev.tasks[taskId]
    if (!task || task.type !== 'local_agent') {
      return prev
    }

    taskMessages = (task as LocalMainSessionTaskState).messages

    // 如果存在之前的前台任务，则将其恢复为后台
    const prevId = prev.foregroundedTaskId
    const prevTask = prevId ? prev.tasks[prevId] : undefined
    const restorePrev =
      prevId && prevId !== taskId && prevTask?.type === 'local_agent'

    return {
      ...prev,
      foregroundedTaskId: taskId,
      tasks: {
        ...prev.tasks,
        ...(restorePrev && { [prevId]: { ...prevTask, isBackgrounded: true } }),
        [taskId]: { ...task, isBackgrounded: false },
      },
    }
  })

  return taskMessages
}

/**
 * 判断任务是否为 main session 任务（相对于普通的 agent 任务）。
 */
export function isMainSessionTask(
  task: unknown,
): task is LocalMainSessionTaskState {
  if (
    typeof task !== 'object' ||
    task === null ||
    !('type' in task) ||
    !('agentType' in task)
  ) {
    return false
  }
  return (
    task.type === 'local_agent' &&
    (task as LocalMainSessionTaskState).agentType === 'main-session'
  )
}

// 用于显示的最近 activity 最大数量
const MAX_RECENT_ACTIVITIES = 5

type ToolActivity = {
  toolName: string
  input: Record<string, unknown>
}

/**
 * 用给定消息启动一个新的后台会话。
 *
 * 用当前消息发起一个独立的 query() 调用，并将其注册为后台任务。
 * 调用方的前台查询会继续正常运行。
 */
export function startBackgroundSession({
  messages,
  queryParams,
  description,
  setAppState,
  agentDefinition,
}: {
  messages: Message[]
  queryParams: Omit<QueryParams, 'messages'>
  description: string
  setAppState: SetAppState
  agentDefinition?: AgentDefinition
}): string {
  const { taskId, abortSignal } = registerMainSessionTask(
    description,
    setAppState,
    agentDefinition,
  )

  // 把后台化之前的对话持久化到任务隔离的对话记录中，让 TaskOutput 能立即显示上下文。
  // 后续消息会在下方增量写入。
  void recordSidechainTranscript(messages, taskId).catch(err =>
    logForDebugging(`bg-session initial transcript write failed: ${err}`),
  )

  // 用 agent context 包裹，让 skill 调用作用域绑到此任务的 agentId
  // （而不是 null）。这样 clearInvokedSkills(preservedAgentIds) 就能在
  // /clear 时选择性地保留此任务的 skill。AsyncLocalStorage 隔离并发异步链
  // —— 此包装不会影响前台。
  const agentContext: SubagentContext = {
    agentId: taskId,
    agentType: 'subagent',
    subagentName: 'main-session',
    isBuiltIn: true,
  }

  void runWithAgentContext(agentContext, async () => {
    try {
      const bgMessages: Message[] = [...messages]
      const recentActivities: ToolActivity[] = []
      let toolCount = 0
      let tokenCount = 0
      let lastRecordedUuid: UUID | null = messages.at(-1)?.uuid ?? null

      for await (const event of query({
        messages: bgMessages,
        ...queryParams,
      })) {
        if (abortSignal.aborted) {
          // 流式过程中被 abort —— 此时不会走到 completeMainSessionTask。
          // chat:killAgents 路径已标记 notified 并发送事件；stopTask 路径则没有。
          let alreadyNotified = false
          updateTaskState<LocalMainSessionTaskState>(
            taskId,
            setAppState,
            task => {
              alreadyNotified = task.notified === true
              return alreadyNotified ? task : { ...task, notified: true }
            },
          )
          if (!alreadyNotified) {
            emitTaskTerminatedSdk(taskId, 'stopped', {
              summary: description,
            })
          }
          return
        }

        if (
          event.type !== 'user' &&
          event.type !== 'assistant' &&
          event.type !== 'system'
        ) {
          continue
        }

        const msg = event as Message
        bgMessages.push(msg)

        // 按消息写入（与 runAgent.ts 的模式一致）—— 既提供实时 TaskOutput 进度，
        // 也保证 /clear 中途重链接符号链接时对话记录文件依然是最新的。
        void recordSidechainTranscript([msg], taskId, lastRecordedUuid).catch(
          err => logForDebugging(`bg-session transcript write failed: ${err}`),
        )
        lastRecordedUuid = msg.uuid

        if (msg.type === 'assistant') {
          const contentBlocks = (msg.message?.content ?? []) as Array<{
            type: string
            text?: string
            name?: string
            input?: unknown
          }>
          for (const block of contentBlocks) {
            if (block.type === 'text') {
              tokenCount += roughTokenCountEstimation(block.text ?? '')
            } else if (block.type === 'tool_use') {
              toolCount++
              const activity: ToolActivity = {
                toolName: block.name ?? '',
                input: block.input as Record<string, unknown>,
              }
              recentActivities.push(activity)
              if (recentActivities.length > MAX_RECENT_ACTIVITIES) {
                recentActivities.shift()
              }
            }
          }
        }

        setAppState(prev => {
          const task = prev.tasks[taskId]
          if (!task || task.type !== 'local_agent') return prev
          const prevProgress = task.progress
          if (
            prevProgress?.tokenCount === tokenCount &&
            prevProgress.toolUseCount === toolCount &&
            task.messages === bgMessages
          ) {
            return prev
          }
          return {
            ...prev,
            tasks: {
              ...prev.tasks,
              [taskId]: {
                ...task,
                progress: {
                  tokenCount,
                  toolUseCount: toolCount,
                  recentActivities:
                    prevProgress?.toolUseCount === toolCount
                      ? prevProgress.recentActivities
                      : [...recentActivities],
                },
                messages: bgMessages,
              },
            },
          }
        })
      }

      completeMainSessionTask(taskId, true, setAppState)
    } catch (error) {
      logError(error)
      completeMainSessionTask(taskId, false, setAppState)
    }
  })

  return taskId
}
