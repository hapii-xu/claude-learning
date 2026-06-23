/**
 * 进程内 teammate 生成
 *
 * 创建并注册一个进程内 teammate 任务。与基于进程的
 * teammate（tmux/iTerm2）不同，进程内 teammate 在同一 Node.js
 * 进程中运行，使用 AsyncLocalStorage 进行上下文隔离。
 *
 * 实际的 agent 执行循环由 InProcessTeammateTask
 * 组件处理（任务 #14）。本模块负责：
 * 1. 创建 TeammateContext
 * 2. 创建关联的 AbortController
 * 3. 在 AppState 中注册 InProcessTeammateTaskState
 * 4. 返回生成结果给后端
 */

import sample from 'lodash-es/sample.js'
import { getSessionId } from '../../bootstrap/state.js'
import { getSpinnerVerbs } from '../../constants/spinnerVerbs.js'
import { TURN_COMPLETION_VERBS } from '../../constants/turnCompletionVerbs.js'
import type { AppState } from '../../state/AppState.js'
import { createTaskStateBase, generateTaskId } from '../../Task.js'
import type {
  InProcessTeammateTaskState,
  TeammateIdentity,
} from '../../tasks/InProcessTeammateTask/types.js'
import { createAbortController } from '../abortController.js'
import { markAutonomyRunFailed } from '../autonomyRuns.js'
import { formatAgentId } from '../agentId.js'
import { registerCleanup } from '../cleanupRegistry.js'
import { logForDebugging } from '../debug.js'
import { emitTaskTerminatedSdk } from '../sdkEventQueue.js'
import { evictTaskOutput } from '../task/diskOutput.js'
import {
  evictTerminalTask,
  registerTask,
  STOPPED_DISPLAY_MS,
} from '../task/framework.js'
import { createTeammateContext } from '../teammateContext.js'
import {
  isPerfettoTracingEnabled,
  registerAgent as registerPerfettoAgent,
  unregisterAgent as unregisterPerfettoAgent,
} from '../telemetry/perfettoTracing.js'
import { removeMemberByAgentId } from './teamHelpers.js'

type SetAppStateFn = (updater: (prev: AppState) => AppState) => void

/**
 * 生成进程内 teammate 所需的最小上下文。
 * 这是 ToolUseContext 的子集 - 仅包含 spawnInProcessTeammate 实际使用的部分。
 */
export type SpawnContext = {
  setAppState: SetAppStateFn
  toolUseId?: string
}

/**
 * 生成进程内 teammate 的配置。
 */
export type InProcessSpawnConfig = {
  /** teammate 的显示名称，例如 "researcher" */
  name: string
  /** 此 teammate 所属的团队 */
  teamName: string
  /** teammate 的初始提示词/任务 */
  prompt: string
  /** teammate 的可选 UI 颜色 */
  color?: string
  /** teammate 是否必须在实现前进入计划模式 */
  planModeRequired: boolean
  /** 此 teammate 的可选模型覆盖 */
  model?: string
}

/**
 * 生成进程内 teammate 的结果。
 */
export type InProcessSpawnOutput = {
  /** 生成是否成功 */
  success: boolean
  /** 完整 agent ID（格式："name@team"） */
  agentId: string
  /** 用于 AppState 追踪的任务 ID */
  taskId?: string
  /** 此 teammate 的 AbortController（关联到父级） */
  abortController?: AbortController
  /** 用于 AsyncLocalStorage 的 teammate 上下文 */
  teammateContext?: ReturnType<typeof createTeammateContext>
  /** 生成失败时的错误消息 */
  error?: string
}

/**
 * 生成一个进程内 teammate。
 *
 * 创建 teammate 的上下文，在 AppState 中注册任务，并返回
 * 生成结果。实际的 agent 执行由 InProcessTeammateTask 组件驱动，
 * 该组件使用 runWithTeammateContext() 以正确的身份隔离执行 agent 循环。
 *
 * @param config - 生成配置
 * @param context - 包含 setAppState 的上下文，用于注册任务
 * @returns 包含 teammate 信息的生成结果
 */
export async function spawnInProcessTeammate(
  config: InProcessSpawnConfig,
  context: SpawnContext,
): Promise<InProcessSpawnOutput> {
  const { name, teamName, prompt, color, planModeRequired, model } = config
  const { setAppState } = context

  // 生成确定性的 agent ID
  const agentId = formatAgentId(name, teamName)
  const taskId = generateTaskId('in_process_teammate')

  logForDebugging(
    `[spawnInProcessTeammate] Spawning ${agentId} (taskId: ${taskId})`,
  )

  try {
    // 为此 teammate 创建独立的 AbortController
    // 当 leader 的查询被中断时，teammate 不应被中止
    const abortController = createAbortController()

    // 获取父级会话 ID 用于 transcript 关联
    const parentSessionId = getSessionId()

    // 创建 teammate 身份（作为纯数据存储在 AppState 中）
    const identity: TeammateIdentity = {
      agentId,
      agentName: name,
      teamName,
      color,
      planModeRequired,
      parentSessionId,
    }

    // 为 AsyncLocalStorage 创建 teammate 上下文
    // 在 agent 执行期间由 runWithTeammateContext() 使用
    const teammateContext = createTeammateContext({
      agentId,
      agentName: name,
      teamName,
      color,
      planModeRequired,
      parentSessionId,
      abortController,
    })

    // 在 Perfetto 追踪中注册 agent 以进行层级可视化
    if (isPerfettoTracingEnabled()) {
      registerPerfettoAgent(agentId, name, parentSessionId)
    }

    // 创建任务状态
    const description = `${name}: ${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}`

    const taskState: InProcessTeammateTaskState = {
      ...createTaskStateBase(
        taskId,
        'in_process_teammate',
        description,
        context.toolUseId,
      ),
      type: 'in_process_teammate',
      status: 'running',
      identity,
      prompt,
      model,
      abortController,
      awaitingPlanApproval: false,
      spinnerVerb: sample(getSpinnerVerbs()),
      pastTenseVerb: sample(TURN_COMPLETION_VERBS),
      permissionMode: planModeRequired ? 'plan' : 'default',
      isIdle: false,
      shutdownRequested: false,
      lastReportedToolCount: 0,
      lastReportedTokenCount: 0,
      pendingUserMessages: [],
      messages: [], // 初始化为空数组以便 getDisplayedMessages 立即生效
    }

    // 注册清理处理程序以实现优雅关闭
    const unregisterCleanup = registerCleanup(async () => {
      logForDebugging(`[spawnInProcessTeammate] Cleanup called for ${agentId}`)
      abortController.abort()
      // 执行循环在检测到中止时会更新任务状态
    })
    taskState.unregisterCleanup = unregisterCleanup

    // 在 AppState 中注册任务
    registerTask(taskState, setAppState)

    logForDebugging(
      `[spawnInProcessTeammate] Registered ${agentId} in AppState`,
    )

    return {
      success: true,
      agentId,
      taskId,
      abortController,
      teammateContext,
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error during spawn'
    logForDebugging(
      `[spawnInProcessTeammate] Failed to spawn ${agentId}: ${errorMessage}`,
    )
    return {
      success: false,
      agentId,
      error: errorMessage,
    }
  }
}

/**
 * 通过中止其控制器来杀死进程内 teammate。
 *
 * 注意：这是由 InProcessBackend.kill() 调用的实现。
 *
 * @param taskId - 要杀死的 teammate 的任务 ID
 * @param setAppState - AppState 设置器
 * @returns 如果成功杀死则返回 true
 */
export function killInProcessTeammate(
  taskId: string,
  setAppState: SetAppStateFn,
): boolean {
  let killed = false
  let teamName: string | null = null
  let agentId: string | null = null
  let toolUseId: string | undefined
  let description: string | undefined
  let pendingAutonomyRuns: Array<{ runId: string; rootDir?: string }> = []

  setAppState((prev: AppState) => {
    const task = prev.tasks[taskId]
    if (!task || task.type !== 'in_process_teammate') {
      return prev
    }

    const teammateTask = task as InProcessTeammateTaskState

    if (teammateTask.status !== 'running') {
      return prev
    }

    // 捕获身份信息用于状态更新后的清理
    teamName = teammateTask.identity.teamName
    agentId = teammateTask.identity.agentId
    toolUseId = teammateTask.toolUseId
    description = teammateTask.description

    // 在清除前捕获待处理的自治运行 ID
    pendingAutonomyRuns = teammateTask.pendingUserMessages.flatMap(message =>
      message.autonomyRunId
        ? [
            {
              runId: message.autonomyRunId,
              ...(message.autonomyRootDir
                ? { rootDir: message.autonomyRootDir }
                : {}),
            },
          ]
        : [],
    )

    // 中止控制器以停止执行
    teammateTask.abortController?.abort()

    // 调用清理处理程序
    teammateTask.unregisterCleanup?.()

    // 更新任务状态并从 teamContext.teammates 中移除
    killed = true

    // 调用待处理的空闲回调以解除任何等待者（例如 engine.waitForIdle）
    teammateTask.onIdleCallbacks?.forEach(cb => cb())

    // 使用 agentId 从 teamContext.teammates 中移除
    let updatedTeamContext = prev.teamContext
    if (prev.teamContext && prev.teamContext.teammates && agentId) {
      const { [agentId]: _, ...remainingTeammates } = prev.teamContext.teammates
      updatedTeamContext = {
        ...prev.teamContext,
        teammates: remainingTeammates,
      }
    }

    return {
      ...prev,
      teamContext: updatedTeamContext,
      tasks: {
        ...prev.tasks,
        [taskId]: {
          ...teammateTask,
          status: 'killed' as const,
          notified: true,
          endTime: Date.now(),
          onIdleCallbacks: [], // 清除回调以防止过时引用
          messages: teammateTask.messages?.length
            ? [teammateTask.messages[teammateTask.messages.length - 1]!]
            : undefined,
          pendingUserMessages: [],
          inProgressToolUseIDs: undefined,
          abortController: undefined,
          unregisterCleanup: undefined,
          currentWorkAbortController: undefined,
        },
      },
    }
  })

  // 从团队文件中移除（在状态更新器外部以避免在回调中进行文件 I/O）
  if (teamName && agentId) {
    removeMemberByAgentId(teamName, agentId)
  }

  if (killed) {
    for (const run of pendingAutonomyRuns) {
      void markAutonomyRunFailed(
        run.runId,
        `Teammate ${agentId ?? taskId} was stopped before it could consume the queued autonomy prompt.`,
        run.rootDir,
      )
    }
    void evictTaskOutput(taskId)
    // notified:true 已预设因此不会触发 XML 通知；直接关闭 SDK
    // task_started 端点。进程内运行器自身的
    // 完成/失败发射会在 status==='running' 时守卫，因此在看到
    // status:killed 后不会重复发射。
    emitTaskTerminatedSdk(taskId, 'stopped', {
      toolUseId,
      summary: description,
    })
    setTimeout(
      evictTerminalTask.bind(null, taskId, setAppState),
      STOPPED_DISPLAY_MS,
    )
  }

  // 释放 perfetto agent 注册条目
  if (agentId) {
    unregisterPerfettoAgent(agentId)
  }

  return killed
}

/**
 * 通过逻辑 agent ID 杀死进程内 teammate。
 * 用于团队级 UI/操作，其中稳定标识符是
 * "name@team"，而非 AppState 任务 id。
 */
export function killInProcessTeammateByAgentId(
  agentIdToKill: string,
  setAppState: SetAppStateFn,
): boolean {
  let taskIdToKill: string | undefined

  setAppState((prev: AppState) => {
    for (const [taskId, task] of Object.entries(prev.tasks)) {
      if (
        task.type === 'in_process_teammate' &&
        task.identity.agentId === agentIdToKill &&
        task.status === 'running'
      ) {
        taskIdToKill = taskId
        break
      }
    }
    return prev
  })

  if (!taskIdToKill) {
    return false
  }

  return killInProcessTeammate(taskIdToKill, setAppState)
}
