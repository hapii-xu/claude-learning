import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import type { ToolResultBlockParam } from 'src/Tool.js'
import { buildTool } from 'src/Tool.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { notifyAutomationStateChanged } from 'src/utils/sessionState.js'
import { SLEEP_TOOL_NAME, DESCRIPTION, SLEEP_TOOL_PROMPT } from './prompt.js'

const SLEEP_WAKE_CHECK_INTERVAL_MS = 500

const inputSchema = lazySchema(() =>
  z.strictObject({
    duration_seconds: z.number().describe('睡眠时长（秒）。用户可随时中断。'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type SleepInput = z.infer<InputSchema>

type SleepOutput = { slept_seconds: number; interrupted: boolean }

function isProactiveAutomationEnabled(): boolean {
  if (!(feature('PROACTIVE') || feature('KAIROS'))) {
    return false
  }

  const mod =
    require('src/proactive/index.js') as typeof import('src/proactive/index.js')
  return mod.isProactiveActive()
}

function isProactiveSleepAllowed(): boolean {
  if (!(feature('PROACTIVE') || feature('KAIROS'))) {
    return true
  }

  const mod =
    require('src/proactive/index.js') as typeof import('src/proactive/index.js')
  return mod.isProactiveActive()
}

function hasQueuedWakeSignal(): boolean {
  const queue =
    require('src/utils/messageQueueManager.js') as typeof import('src/utils/messageQueueManager.js')
  return queue.hasCommandsInQueue()
}

function shouldInterruptSleep(): boolean {
  return !isProactiveSleepAllowed() || hasQueuedWakeSignal()
}

export const SleepTool = buildTool({
  name: SLEEP_TOOL_NAME,
  searchHint: '等待 暂停 睡眠 休息 空闲 计时器',
  maxResultSizeChars: 1_000,
  strict: true,

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return SLEEP_TOOL_PROMPT
  },

  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  interruptBehavior() {
    return 'cancel'
  },

  userFacingName() {
    return SLEEP_TOOL_NAME
  },

  renderToolUseMessage(input: Partial<SleepInput>) {
    const secs = input.duration_seconds ?? '?'
    return `睡眠：${secs}s`
  },

  mapToolResultToToolResultBlockParam(
    content: SleepOutput,
    toolUseID: string,
  ): ToolResultBlockParam {
    const msg = content.interrupted
      ? `睡眠在 ${content.slept_seconds}s 后被中断`
      : `已睡眠 ${content.slept_seconds}s`
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: msg,
    }
  },

  async call(input: SleepInput, context) {
    // 如果在模型决定等待期间 proactive 被禁用或有新工作到来，则不进入睡眠。
    if (shouldInterruptSleep()) {
      return {
        data: {
          slept_seconds: 0,
          interrupted: true,
        },
      }
    }

    const { duration_seconds } = input
    const startTime = Date.now()
    const sleepUntil = startTime + duration_seconds * 1000

    if (isProactiveAutomationEnabled()) {
      notifyAutomationStateChanged({
        enabled: true,
        phase: 'sleeping',
        next_tick_at: null,
        sleep_until: sleepUntil,
      })
    }

    try {
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | null = null
        let wakeCheck: ReturnType<typeof setInterval> | null = null
        let settled = false

        const cleanup = () => {
          if (timer !== null) {
            clearTimeout(timer)
            timer = null
          }
          if (wakeCheck !== null) {
            clearInterval(wakeCheck)
            wakeCheck = null
          }
          context.abortController.signal.removeEventListener('abort', onAbort)
        }

        const finish = () => {
          if (settled) return
          settled = true
          cleanup()
          resolve()
        }

        const interrupt = () => {
          if (settled) return
          settled = true
          cleanup()
          reject(new Error('interrupted'))
        }

        const onAbort = () => {
          interrupt()
        }

        timer = setTimeout(finish, duration_seconds * 1000)

        // 通过用户中断中止
        if (context.abortController.signal.aborted) {
          interrupt()
          return
        }
        context.abortController.signal.addEventListener('abort', onAbort, {
          once: true,
        })

        // 轮询 proactive 状态和共享命令队列，使新工作无需
        // 等待完整时长即可唤醒 Sleep。
        wakeCheck = setInterval(() => {
          if (shouldInterruptSleep()) {
            interrupt()
          }
        }, SLEEP_WAKE_CHECK_INTERVAL_MS)
      })
      return {
        data: {
          slept_seconds: duration_seconds,
          interrupted: false,
        },
      }
    } catch {
      const elapsed = Math.round((Date.now() - startTime) / 1000)
      return {
        data: {
          slept_seconds: elapsed,
          interrupted: true,
        },
      }
    } finally {
      notifyAutomationStateChanged(
        isProactiveAutomationEnabled()
          ? {
              enabled: true,
              phase: null,
              next_tick_at: null,
              sleep_until: null,
            }
          : null,
      )
    }
  },
})
