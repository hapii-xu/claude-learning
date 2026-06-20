/**
 * 会话清理工具。
 * 此模块依赖较重，应尽可能懒加载。
 */
import { feature } from 'bun:bundle'
import { randomUUID, type UUID } from 'crypto'
import { getReplBridgeHandle } from '../../bridge/replBridgeHandle.js'
import {
  getLastMainRequestId,
  getOriginalCwd,
  getSessionId,
  regenerateSessionId,
  resetCostState,
  setLastAPIRequest,
  setLastAPIRequestMessages,
  setLastClassifierRequests,
} from '../../bootstrap/state.js'
import type { SDKStatusMessage } from '../../entrypoints/sdk/coreTypes.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import type { AppState } from '../../state/AppState.js'
import { isInProcessTeammateTask } from '../../tasks/InProcessTeammateTask/types.js'
import {
  isLocalAgentTask,
  type LocalAgentTaskState,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { isLocalShellTask } from '../../tasks/LocalShellTask/guards.js'
import { asAgentId } from '../../types/ids.js'
import type { Message } from '../../types/message.js'
import { createEmptyAttributionState } from '../../utils/commitAttribution.js'
import type { FileStateCache } from '../../utils/fileStateCache.js'
import {
  executeSessionEndHooks,
  getSessionEndHookTimeoutMs,
} from '../../utils/hooks.js'
import { logError } from '../../utils/log.js'
import { clearAllPlanSlugs } from '../../utils/plans.js'
import { setCwd } from '../../utils/Shell.js'
import { processSessionStartHooks } from '../../utils/sessionStart.js'
import {
  clearSessionMetadata,
  getAgentTranscriptPath,
  resetSessionFilePointer,
  saveWorktreeState,
} from '../../utils/sessionStorage.js'
import {
  evictTaskOutput,
  initTaskOutputAsSymlink,
} from '../../utils/task/diskOutput.js'
import { getCurrentWorktreeSession } from '../../utils/worktree.js'
import { clearSessionCaches } from './caches.js'

function notifyRemoteConversationCleared(): void {
  const handle = getReplBridgeHandle()
  if (!handle) return
  handle.markTranscriptReset?.()

  const message: SDKStatusMessage = {
    type: 'status',
    subtype: 'status',
    status: 'conversation_cleared',
    message: 'conversation_cleared',
    uuid: randomUUID(),
  }
  handle.writeSdkMessages([message])
}

export async function clearConversation({
  setMessages,
  readFileState,
  discoveredSkillNames,
  loadedNestedMemoryPaths,
  getAppState,
  setAppState,
  setConversationId,
}: {
  setMessages: (updater: (prev: Message[]) => Message[]) => void
  readFileState: FileStateCache
  discoveredSkillNames?: Set<string>
  loadedNestedMemoryPaths?: Set<string>
  getAppState?: () => AppState
  setAppState?: (f: (prev: AppState) => AppState) => void
  setConversationId?: (id: UUID) => void
}): Promise<void> {
  // 清理前执行 SessionEnd hooks（受
  // CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS 限制，默认 1.5s）
  const sessionEndTimeoutMs = getSessionEndHookTimeoutMs()
  await executeSessionEndHooks('clear', {
    getAppState,
    setAppState,
    signal: AbortSignal.timeout(sessionEndTimeoutMs),
    timeoutMs: sessionEndTimeoutMs,
  })

  // 向推理层发送信号，表明此会话的缓存可以被驱逐。
  const lastRequestId = getLastMainRequestId()
  if (lastRequestId) {
    logEvent('tengu_cache_eviction_hint', {
      scope:
        'conversation_clear' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      last_request_id:
        lastRequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  }

  // 预先计算需要保留的任务，以便它们的 per-agent 状态能在下面的
  // 缓存清理后存活。除非任务显式地将 isBackgrounded 设为 false，
  // 否则都会被保留。主会话任务（Ctrl+B）会被保留 ——
  // 它们写入隔离的 per-task transcript 并在 agent context 下运行，
  // 因此在 session ID 重新生成时是安全的。参见
  // LocalMainSessionTask.ts 的 startBackgroundSession。
  const preservedAgentIds = new Set<string>()
  const preservedLocalAgents: LocalAgentTaskState[] = []
  const shouldKillTask = (task: AppState['tasks'][string]): boolean =>
    'isBackgrounded' in task && task.isBackgrounded === false
  if (getAppState) {
    for (const task of Object.values(getAppState().tasks)) {
      if (shouldKillTask(task)) continue
      if (isLocalAgentTask(task)) {
        preservedAgentIds.add(task.agentId)
        preservedLocalAgents.push(task)
      } else if (isInProcessTeammateTask(task)) {
        preservedAgentIds.add(task.identity.agentId)
      }
    }
  }

  setMessages(() => [])
  notifyRemoteConversationCleared()

  // 清理 context-blocked 标志，以便 /clear 后恢复 proactive ticks
  if (feature('PROACTIVE') || feature('KAIROS')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { setContextBlocked } = require('../../proactive/index.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    setContextBlocked(false)
  }

  // 通过更新 conversationId 强制重新渲染 logo
  if (setConversationId) {
    setConversationId(randomUUID())
  }

  // 清理所有与会话相关的缓存。被保留的后台任务的 per-agent 状态
  //（已调用的 skills、待处理权限回调、dump 状态、cache-break 跟踪）
  // 会保留，以便这些 agent 继续正常工作。
  clearSessionCaches(preservedAgentIds)

  // 清理超出消息数组生命周期的 STATE 持有的大型数据。
  // lastAPIRequestMessages 可能为 /share 持有完整的 post-compaction 对话
  //（数百 KB–MB）；resetCostState 清理 modelUsage。
  setLastAPIRequest(null)
  setLastAPIRequestMessages(null)
  setLastClassifierRequests(null)
  resetCostState()

  setCwd(getOriginalCwd())
  readFileState.clear()
  discoveredSkillNames?.clear()
  loadedNestedMemoryPaths?.clear()

  // 从 App State 中清理必要的项
  if (setAppState) {
    setAppState(prev => {
      // 使用上面计算的同一谓词划分任务：
      // 杀掉并移除前台任务，保留其他所有任务。
      const nextTasks: AppState['tasks'] = {}
      for (const [taskId, task] of Object.entries(prev.tasks)) {
        if (!shouldKillTask(task)) {
          nextTasks[taskId] = task
          continue
        }
        // 前台任务：杀掉它并从状态中移除
        try {
          if (task.status === 'running') {
            if (isLocalShellTask(task)) {
              task.shellCommand?.kill()
              task.shellCommand?.cleanup()
              if (task.cleanupTimeoutId) {
                clearTimeout(task.cleanupTimeoutId)
              }
            }
            if ('abortController' in task) {
              task.abortController?.abort()
            }
            if ('unregisterCleanup' in task) {
              task.unregisterCleanup?.()
            }
          }
        } catch (error) {
          logError(error)
        }
        void evictTaskOutput(taskId)
      }

      return {
        ...prev,
        tasks: nextTasks,
        attribution: createEmptyAttributionState(),
        // 清理独立 agent context（由 /rename、/color 设置的 name/color），
        // 以便新会话不会显示旧会话的身份徽章
        standaloneAgentContext: undefined,
        fileHistory: {
          snapshots: [],
          trackedFiles: new Set(),
          snapshotSequence: 0,
        },
        // 将 MCP 状态重置为默认以触发重新初始化。
        // 保留 pluginReconnectKey，这样 /clear 不会变成 no-op
        //（它仅由 /reload-plugins 触发更新）。
        mcp: {
          clients: [],
          tools: [],
          commands: [],
          resources: {},
          pluginReconnectKey: prev.mcp.pluginReconnectKey,
        },
      }
    })
  }

  // 清理 plan slug 缓存，以便 /clear 后使用新的 plan 文件
  clearAllPlanSlugs()

  // 清理缓存的会话元数据（标题、tag、agent 名称/颜色），
  // 以便新会话不会继承前一会话的身份
  clearSessionMetadata()

  // 生成新的 session ID 以提供全新状态
  // 将旧会话设置为 parent 用于 analytics 血缘追踪
  regenerateSessionId({ setCurrentAsParent: true })
  // 更新环境变量以便子进程使用新的 session ID
  if (process.env.USER_TYPE === 'ant' && process.env.CLAUDE_CODE_SESSION_ID) {
    process.env.CLAUDE_CODE_SESSION_ID = getSessionId()
  }
  await resetSessionFilePointer()

  // 保留的 local_agent 任务在 spawn 时其 TaskOutput symlink 基于
  // 旧的 session ID 创建，但清理后的 transcript 写入会落到新的
  // 会话目录下（appendEntry 会重新读取 getSessionId()）。重新指向
  // symlink，以便 TaskOutput 读取实时文件而非清理前的冻结快照。
  // 只重新指向运行中的任务 —— 已完成的任务不会再写入，因此重新指向
  // 会把有效的 symlink 替换为悬空的链接。
  // 主会话任务使用相同的 per-agent 路径（它们通过
  // recordSidechainTranscript 写入 getAgentTranscriptPath），因此无需特殊处理。
  for (const task of preservedLocalAgents) {
    if (task.status !== 'running') continue
    void initTaskOutputAsSymlink(
      task.id,
      getAgentTranscriptPath(asAgentId(task.agentId)),
    )
  }

  // 清理后重新持久化 mode 和 worktree 状态，以便后续 --resume
  // 知道新的清理后会话处于什么状态。clearSessionMetadata
  // 从缓存中擦除了两者，但进程仍处于相同的 mode，
  // 且（如果适用）仍在相同的 worktree 目录中。
  if (feature('COORDINATOR_MODE')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { saveMode } = require('../../utils/sessionStorage.js')
    const {
      isCoordinatorMode,
    } = require('../../coordinator/coordinatorMode.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    saveMode(isCoordinatorMode() ? 'coordinator' : 'normal')
  }
  const worktreeSession = getCurrentWorktreeSession()
  if (worktreeSession) {
    saveWorktreeState(worktreeSession)
  }

  // 清理后执行 SessionStart hooks
  const hookMessages = await processSessionStartHooks('clear')

  // 用 hook 结果更新消息
  if (hookMessages.length > 0) {
    setMessages(() => hookMessages)
  }
}
