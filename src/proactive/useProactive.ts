/**
 * useProactive —— 驱动 proactive 模式 tick 生成的 React hook。
 *
 * 在 feature('PROACTIVE') || feature('KAIROS') 时挂载到 REPL.tsx 中。
 * 在 proactive 模式激活且未阻塞时，以固定间隔生成
 * <tick>HH:MM:SS</tick> 提示。
 */
import { useEffect, useRef } from 'react'
import type { QueuedCommand } from '../types/textInputTypes.js'
import { TICK_TAG } from '../constants/xml.js'
import { getCwd } from '../utils/cwd.js'
import { cancelQueuedAutonomyCommands } from '../utils/autonomyQueueLifecycle.js'
import { createProactiveAutonomyCommands } from '../utils/autonomyRuns.js'
import { logForDebugging } from '../utils/debug.js'
import {
  isProactiveActive,
  isProactivePaused,
  isContextBlocked,
  setNextTickAt,
  shouldTick,
} from './index.js'

/** tick 之间的默认间隔（毫秒）。提示缓存 TTL 约为 5 分钟，因此我们
 *  远低于此值以保持缓存温热。 */
const TICK_INTERVAL_MS = 30_000

type UseProactiveOpts = {
  isLoading: boolean
  queuedCommandsLength: number
  hasActiveLocalJsxUI: boolean
  isInPlanMode: boolean
  onQueueTick: (command: QueuedCommand) => void
}

export function useProactive(opts: UseProactiveOpts): void {
  const optsRef = useRef(opts)
  optsRef.current = opts

  useEffect(() => {
    if (!isProactiveActive()) return

    let timer: ReturnType<typeof setTimeout> | null = null
    let disposed = false
    let generating = false

    function scheduleTick(): void {
      const nextTs = Date.now() + TICK_INTERVAL_MS
      setNextTickAt(nextTs)

      timer = setTimeout(() => {
        timer = null

        // 守卫：遇到任何阻塞条件时跳过 tick
        if (!shouldTick()) {
          // 重新安排——条件稍后可能清除
          scheduleTick()
          return
        }

        const {
          isLoading,
          queuedCommandsLength,
          hasActiveLocalJsxUI,
          isInPlanMode,
        } = optsRef.current

        // 当查询正在进行、计划模式激活、本地 JSX UI 显示中
        // 或有命令排队时不触发
        if (
          isLoading ||
          isInPlanMode ||
          hasActiveLocalJsxUI ||
          queuedCommandsLength > 0 ||
          generating
        ) {
          scheduleTick()
          return
        }

        generating = true
        void (async () => {
          const commands = await createProactiveAutonomyCommands({
            basePrompt: `<${TICK_TAG}>${new Date().toLocaleTimeString()}</${TICK_TAG}>`,
            currentDir: getCwd(),
            shouldCreate: () => !disposed,
          })
          if (disposed) {
            await cancelQueuedAutonomyCommands({ commands })
            return
          }
          const queuedCommands: QueuedCommand[] = []
          try {
            for (const command of commands) {
              // 始终排队 proactive 回合。这避免了以下竞态：提示异步构建中，
              // 同时开始了用户回合，而直接提交路径会在消费其心跳到期状态后
              // 静默丢弃自主回合。
              optsRef.current.onQueueTick(command)
              queuedCommands.push(command)
            }
          } catch (error) {
            await cancelQueuedAutonomyCommands({
              commands: commands.filter(
                command => !queuedCommands.includes(command),
              ),
            })
            throw error
          }
        })()
          .catch(error =>
            logForDebugging(`[Proactive] failed to create tick: ${error}`, {
              level: 'error',
            }),
          )
          .finally(() => {
            generating = false
          })

        // 安排下一次 tick
        scheduleTick()
      }, TICK_INTERVAL_MS)
    }

    scheduleTick()

    return () => {
      disposed = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      setNextTickAt(null)
    }
  }, [
    // proactive 状态变化时重新挂载
    isProactiveActive(),
    isProactivePaused(),
    isContextBlocked(),
  ])
}
