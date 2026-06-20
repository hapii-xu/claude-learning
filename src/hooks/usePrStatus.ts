import { useEffect, useRef, useState } from 'react'
import { getLastInteractionTime } from '../bootstrap/state.js'
import { fetchPrStatus, type PrReviewState } from '../utils/ghPrStatus.js'

const POLL_INTERVAL_MS = 60_000
const SLOW_GH_THRESHOLD_MS = 4_000
const IDLE_STOP_MS = 60 * 60_000 // 在 60 分钟空闲后停止轮询

export type PrStatusState = {
  number: number | null
  url: string | null
  reviewState: PrReviewState | null
  lastUpdated: number
}

const INITIAL_STATE: PrStatusState = {
  number: null,
  url: null,
  reviewState: null,
  lastUpdated: 0,
}

/**
 * 在会话活跃时每 60 秒轮询 PR 审查状态。
 * 当 60 分钟未检测到交互时，循环停止 —— 没有
 * 计时器残留。React 在 isLoading 变化时重新运行 effect
 * （回合开始/结束），重新启动循环。Effect 设置
 * 相对于上次获取时间安排下一次轮询，这样回合边界
 * 不会在每个间隔内生成超过一次 `gh`。
 * 如果获取超过 4 秒则永久禁用。
 *
 * 传递 `enabled: false` 完全跳过轮询（hook 仍必须
 * 无条件调用以满足 hooks 规则）。
 */
export function usePrStatus(isLoading: boolean, enabled = true): PrStatusState {
  const [prStatus, setPrStatus] = useState<PrStatusState>(INITIAL_STATE)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const disabledRef = useRef(false)
  const lastFetchRef = useRef(0)

  useEffect(() => {
    if (!enabled) return
    if (disabledRef.current) return

    let cancelled = false
    let lastSeenInteractionTime = -1
    let lastActivityTimestamp = Date.now()

    async function poll() {
      if (cancelled) return

      const currentInteractionTime = getLastInteractionTime()
      if (lastSeenInteractionTime !== currentInteractionTime) {
        lastSeenInteractionTime = currentInteractionTime
        lastActivityTimestamp = Date.now()
      } else if (Date.now() - lastActivityTimestamp >= IDLE_STOP_MS) {
        return
      }

      const start = Date.now()
      const result = await fetchPrStatus()
      if (cancelled) return
      lastFetchRef.current = start

      setPrStatus(prev => {
        const newNumber = result?.number ?? null
        const newReviewState = result?.reviewState ?? null
        if (prev.number === newNumber && prev.reviewState === newReviewState) {
          return prev
        }
        return {
          number: newNumber,
          url: result?.url ?? null,
          reviewState: newReviewState,
          lastUpdated: Date.now(),
        }
      })

      if (Date.now() - start > SLOW_GH_THRESHOLD_MS) {
        disabledRef.current = true
        return
      }

      if (!cancelled) {
        timeoutRef.current = setTimeout(poll, POLL_INTERVAL_MS)
      }
    }

    const elapsed = Date.now() - lastFetchRef.current
    if (elapsed >= POLL_INTERVAL_MS) {
      void poll()
    } else {
      timeoutRef.current = setTimeout(poll, POLL_INTERVAL_MS - elapsed)
    }

    return () => {
      cancelled = true
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
        timeoutRef.current = null
      }
    }
  }, [isLoading, enabled])

  return prStatus
}
