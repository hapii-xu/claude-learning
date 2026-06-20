/**
 * useGoalContinuation — React hook，驱动 `/goal` 功能的
 * 自动继续循环。
 *
 * 在 feature('GOAL') 启用时挂载在 REPL.tsx 内部。每次
 * 回合完成（queryGuard 转换为空闲）后，检查活跃
 * 目标是否应触发另一个回合：
 *
 *   1. GOAL 功能标志启用
 *   2. 目标存在且 status === 'active'
 *   3. 查询刚刚完成（isLoading 转换为 false）
 *   4. 无活跃的 local-JSX UI（模态对话框）
 *   5. 不在规划模式
 *   6. turnsExecuted < MAX_GOAL_TURNS
 *   7. 队列中没有用户消息（用户输入始终优先）
 *
 * 当用户在目标回合期间排队消息时，hook 始终
 * 让位以让它们先处理。在用户消息被
 * 处理后，下一次空闲将再次触发 hook 继续。
 * 这确保像 `/goal pause` 这样的命令永远不会被
 * 自动继续饥饿。
 *
 * hook 有意保持简单：单个 useEffect 在
 * `isLoading` 翻转为 false 时触发。没有计时器，没有间隔 ——
 * 空闲→入队→处理→查询→空闲 循环是自维持的。
 */
import { useLayoutEffect, useRef } from 'react'

import { logForDebugging } from 'src/utils/debug.js'
import {
  markGoalMaxTurnsReached,
  getGoal,
  incrementGoalTurns,
  MAX_GOAL_TURNS,
} from 'src/services/goal/goalState.js'
import { persistCurrentGoal } from 'src/services/goal/goalStorage.js'
import {
  buildBudgetLimitPrompt,
  buildContinuationPrompt,
} from 'src/services/goal/prompts.js'
import {
  enqueue,
  getCommandQueueSnapshot,
} from 'src/utils/messageQueueManager.js'

function hookLog(msg: string): void {
  logForDebugging(`[goal] hook: ${msg}`)
}

export type UseGoalContinuationOpts = {
  isLoading: boolean
  wasAborted: boolean
  queuedCommandsLength: number
  hasActiveLocalJsxUI: boolean
  isInPlanMode: boolean
  isQueryActiveNow?: () => boolean
  onMaxTurnsReached?: () => void
  onContinuationEnqueued?: (payload: {
    turn: number
    objective: string
  }) => void
}

export function useGoalContinuation(opts: UseGoalContinuationOpts): void {
  const optsRef = useRef(opts)
  optsRef.current = opts

  // 跟踪我们是否已为当前空闲窗口入队。
  // 每次 isLoading 变为 true（新回合开始）时重置为 false。
  const enqueuedRef = useRef(false)
  // 每次 budget 转换时精确触发一次 budget_limit 提示。
  const budgetLimitFiredRef = useRef(false)

  useLayoutEffect(() => {
    if (opts.isLoading) {
      enqueuedRef.current = false
      return
    }

    // 避免过时渲染竞争：队列处理可能在同一提交的
    // 较早 effect 中预留 QueryGuard。决定前读取实时状态。
    if (opts.isQueryActiveNow?.()) {
      hookLog('skip: queryActiveNow=true')
      return
    }

    // Codex 对等：仅在正常完成后继续。
    // 中止的回合（Ctrl+C / Escape）不得触发新回合。
    if (opts.wasAborted) {
      hookLog('skip: wasAborted=true')
      return
    }

    // 已为此空闲窗口入队
    if (enqueuedRef.current) return

    // 用户消息始终优先于自动继续。
    // 如果用户在回合运行时输入了某些内容（例如 `/goal pause`），
    // 让他们的消息先处理。完成后，
    // 下一个空闲周期将重新评估是否继续。
    const liveQueueLength = getCommandQueueSnapshot().length
    if (liveQueueLength > 0) {
      hookLog('skip: yielding to queued user messages')
      return
    }
    if (opts.hasActiveLocalJsxUI) {
      hookLog('skip: activeLocalJsxUI')
      return
    }
    if (opts.isInPlanMode) {
      hookLog('skip: planMode')
      return
    }

    const goal = getGoal()
    if (!goal) {
      budgetLimitFiredRef.current = false
      return
    }
    if (goal.status === 'active') {
      budgetLimitFiredRef.current = false
    }

    // 预算受限：注入一个最终引导提示，让模型
    // 知道停止实质性工作并总结进度。
    if (goal.status === 'budget_limited' && !budgetLimitFiredRef.current) {
      budgetLimitFiredRef.current = true
      enqueuedRef.current = true
      const prompt = buildBudgetLimitPrompt(goal)
      logForDebugging(
        '[goal] hook: budget limit reached, injecting wrap-up prompt',
      )
      enqueue({
        value: prompt,
        mode: 'prompt',
        priority: 'now',
        isMeta: true,
        origin: 'goal-budget-limit',
        skipSlashCommands: true,
      })
      return
    }

    // 仅对活跃目标继续
    if (goal.status !== 'active') {
      hookLog(`skip: status="${goal.status}" (not active)`)
      return
    }

    if (goal.turnsExecuted >= MAX_GOAL_TURNS) {
      const marked = markGoalMaxTurnsReached()
      if (marked) {
        persistCurrentGoal()
        opts.onMaxTurnsReached?.()
      }
      logForDebugging(
        `[goal] hook: MAX_GOAL_TURNS (${MAX_GOAL_TURNS}) reached, stopping`,
      )
      return
    }

    // 所有条件满足 —— 入队一个继续回合
    enqueuedRef.current = true

    const turns = incrementGoalTurns()
    persistCurrentGoal()

    const prompt = buildContinuationPrompt(goal)
    logForDebugging(
      `[goal] hook: enqueuing turn ${turns} for "${goal.objective.slice(0, 60)}"`,
    )

    enqueue({
      value: prompt,
      mode: 'prompt',
      priority: 'now',
      isMeta: true,
      origin: 'goal-continuation',
      skipSlashCommands: true,
    })
    opts.onContinuationEnqueued?.({
      turn: turns,
      objective: goal.objective,
    })
  }, [
    opts.isLoading,
    opts.wasAborted,
    opts.queuedCommandsLength,
    opts.hasActiveLocalJsxUI,
    opts.isInPlanMode,
  ])
}
