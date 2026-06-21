import { useEffect, useRef } from 'react'
import { useAppStateStore, useSetAppState } from '../state/AppState.js'
import { isTerminalTaskStatus } from '../Task.js'
import {
  findTeammateTaskByAgentId,
  injectUserMessageToTeammate,
} from '../tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import { isKairosCronEnabled } from '@claude-code-best/builtin-tools/tools/ScheduleCronTool/prompt.js'
import type { Message } from '../types/message.js'
import { getCwd } from '../utils/cwd.js'
import { getCronJitterConfig } from '../utils/cronJitterConfig.js'
import { createCronScheduler } from '../utils/cronScheduler.js'
import { removeCronTasks, type CronTask } from '../utils/cronTasks.js'
import {
  createAutonomyQueuedPrompt,
  createAutonomyQueuedPromptIfNoActiveSource,
  markAutonomyRunCancelled,
  markAutonomyRunFailed,
} from '../utils/autonomyRuns.js'
import { logForDebugging } from '../utils/debug.js'
import { enqueuePendingNotification } from '../utils/messageQueueManager.js'
import { createScheduledTaskFireMessage } from '../utils/messages.js'
import { WORKLOAD_CRON } from '../utils/workloadContext.js'
import type { QueuedCommand } from '../types/textInputTypes.js'

type Props = {
  isLoading: boolean
  /**
   * 为 true 时绕过 isLoading 门控，这样任务可以在查询流式传输时
   * 入队，而不是推迟到回合结束后的下一个 1 秒检查 tick。
   * 助手模式不再强制 --proactive（#20425），因此 isLoading 在回合间
   * 像普通 REPL 一样下降 — 此绕过现在是延迟优化，而非饥饿修复。
   * 无论如何提示以 'later' 优先级入队并在回合间排空。
   */
  assistantMode?: boolean
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>
}

export async function createScheduledTaskQueuedCommand(
  task: Pick<CronTask, 'id' | 'prompt'>,
  options?: {
    rootDir?: string
    currentDir?: string
    shouldCreate?: () => boolean
  },
): Promise<QueuedCommand | null> {
  const command = await createAutonomyQueuedPromptIfNoActiveSource({
    basePrompt: task.prompt,
    trigger: 'scheduled-task',
    rootDir: options?.rootDir,
    currentDir: options?.currentDir ?? getCwd(),
    sourceId: task.id,
    sourceLabel: task.prompt,
    workload: WORKLOAD_CRON,
    shouldCreate: options?.shouldCreate,
  })
  if (!command) {
    logForDebugging(
      `[ScheduledTasks] skipping ${task.id}: previous run still queued or running`,
    )
  }
  return command
}

/**
 * REPL wrapper for the cron scheduler. Mounts the scheduler once and tears
 * it down on unmount. Fired prompts go into the command queue as 'later'
 * priority, which the REPL drains via useCommandQueue between turns.
 *
 * Scheduler core (timer, file watcher, fire logic) lives in cronScheduler.ts
 * so SDK/-p mode can share it — see print.ts for the headless wiring.
 */
export function useScheduledTasks({
  isLoading,
  assistantMode = false,
  setMessages,
}: Props): void {
  // 最新值 ref，以便调度器的 isLoading() getter 不会捕获
  // 陈旧的闭包。effect 只挂载一次；isLoading 每轮都会变化。
  const isLoadingRef = useRef(isLoading)
  isLoadingRef.current = isLoading

  const store = useAppStateStore()
  const setAppState = useSetAppState()

  useEffect(() => {
    // 在此处检查运行时门控（而不是在 hook 调用点），以便 hook
    // 保持无条件挂载 —— rules-of-hooks 禁止将调用
    // 包裹在动态条件中。getFeatureValue_CACHED_WITH_REFRESH
    // 从磁盘读取；5 分钟 TTL 会触发后台重新获取，但
    // effect 不会在值翻转时重新运行（assistantMode 是唯一依赖），
    // 所以此守卫仅是启动粒度。会话中期的 killswitch 是
    // 下方的 isKilled 选项 —— check() 每 tick 轮询它。
    if (!isKairosCronEnabled()) return

    // 系统生成 —— 从队列预览和 transcript UI 中隐藏。
    // 在 brief 模式下，executeForkedSlashCommand 作为后台
    // subagent 运行并返回不可见的消息。在普通模式下，
    // isMeta 仅对纯文本提示传播（通过
    // processTextPrompt）；像 /context:fork 这样的斜杠命令不会
    // 转发 isMeta，所以它们的消息在
    // transcript 中保持可见。这是可接受的，因为普通模式不是
    // 计划任务的主要用例。
    let disposed = false
    const enqueueForLead = async (prompt: string) => {
      const command = await createAutonomyQueuedPrompt({
        basePrompt: prompt,
        trigger: 'scheduled-task',
        currentDir: getCwd(),
        workload: WORKLOAD_CRON,
        shouldCreate: () => !disposed,
      })
      if (!command) {
        return
      }
      if (disposed) {
        await markAutonomyRunCancelled(
          command.autonomy!.runId,
          command.autonomy!.rootDir,
        )
        return
      }
      enqueuePendingNotification(command)
    }

    const scheduler = createCronScheduler({
      // 遗漏任务浮现（onFire 回退）。Teammate cron 总是
      // 仅会话内（durable:false），所以它们永远不会出现在遗漏列表中，
      // 该列表在调度器启动时从磁盘填充 —— 此路径只
      // 处理 team-lead 的持久 cron。
      onFire: prompt => {
        void enqueueForLead(prompt).catch(error =>
          logForDebugging(
            `[ScheduledTasks] failed to enqueue missed task prompt: ${error}`,
            { level: 'error' },
          ),
        )
      },
      // 正常触发接收完整的 CronTask，以便我们可以按 agentId 路由。
      onFireTask: task => {
        void (async () => {
          if (task.agentId) {
            const teammate = findTeammateTaskByAgentId(
              task.agentId,
              store.getState().tasks,
            )
            if (teammate && !isTerminalTaskStatus(teammate.status)) {
              const command = await createScheduledTaskQueuedCommand(task, {
                shouldCreate: () => !disposed,
              })
              if (!command) {
                return
              }
              if (disposed) {
                await markAutonomyRunCancelled(
                  command.autonomy!.runId,
                  command.autonomy!.rootDir,
                )
                return
              }
              const injected = injectUserMessageToTeammate(
                teammate.id,
                command.value as string,
                {
                  autonomyRunId: command.autonomy?.runId,
                  autonomyRootDir: command.autonomy?.rootDir,
                  origin: command.origin,
                },
                setAppState,
              )
              if (!injected && command.autonomy?.runId) {
                await markAutonomyRunFailed(
                  command.autonomy.runId,
                  `Teammate ${task.agentId} exited before the scheduled message could be delivered.`,
                  command.autonomy.rootDir,
                )
              }
              return
            }
            // Teammate 已消失 —— 清理孤立的 cron，以免它每 tick
            // 继续向无处触发。一次性任务无论如何都会在触发时自动删除，
            // 但周期性 cron 会循环直到自动过期。
            logForDebugging(
              `[ScheduledTasks] teammate ${task.agentId} gone, removing orphaned cron ${task.id}`,
            )
            void removeCronTasks([task.id])
            return
          }

          const command = await createScheduledTaskQueuedCommand(task, {
            shouldCreate: () => !disposed,
          })
          if (!command) {
            return
          }
          if (disposed) {
            await markAutonomyRunCancelled(
              command.autonomy!.runId,
              command.autonomy!.rootDir,
            )
            return
          }

          const msg = createScheduledTaskFireMessage(
            `Running scheduled task (${formatCronFireTime(new Date())})`,
          )
          setMessages(prev => [...prev, msg])
          enqueuePendingNotification(command)
        })().catch(error =>
          logForDebugging(
            `[ScheduledTasks] failed to enqueue task ${task.id}: ${error}`,
            { level: 'error' },
          ),
        )
      },
      isLoading: () => isLoadingRef.current,
      assistantMode,
      getJitterConfig: getCronJitterConfig,
      isKilled: () => !isKairosCronEnabled(),
    })
    scheduler.start()
    return () => {
      disposed = true
      scheduler.stop()
    }
    // assistantMode 在会话生命周期内是稳定的；store/setAppState 是
    // 来自 useSyncExternalStore 的稳定 ref；setMessages 是稳定的 useCallback。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assistantMode])
}

function formatCronFireTime(d: Date): string {
  return d
    .toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
    .replace(/,? at |, /, ' ')
    .replace(/ ([AP]M)/, (_, ampm) => ampm.toLowerCase())
}
