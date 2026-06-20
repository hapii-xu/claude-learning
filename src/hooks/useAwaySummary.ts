import { feature } from 'bun:bundle'
import { useEffect, useRef } from 'react'
import { getTerminalFocusState, subscribeTerminalFocus } from '@anthropic/ink'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { generateAwaySummary } from '../services/awaySummary.js'
import type { Message } from '../types/message.js'
import { createAwaySummaryMessage } from '../utils/messages.js'

const BLUR_DELAY_MS = 5 * 60_000

type SetMessages = (updater: (prev: Message[]) => Message[]) => void

function hasSummarySinceLastUserTurn(messages: readonly Message[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.type === 'user' && !m.isMeta && !m.isCompactSummary) return false
    if (m.type === 'system' && m.subtype === 'away_summary') return true
  }
  return false
}

/**
 * 在终端失去焦点 5 分钟后追加"你离开时"的摘要消息。
 * 仅在以下情况触发：(a) 失去焦点后 5 分钟，(b) 没有进行中的回合，
 * 且 (c) 自上次用户消息以来没有现有的 away_summary。
 *
 * 对于不支持 DECSET 1004 焦点事件的终端（CMD、PowerShell），
 * 回退到基于空闲的检测：在每个回合结束后启动空闲计时器，
 * 当用户开始新回合时重置它。
 */
export function useAwaySummary(
  messages: readonly Message[],
  setMessages: SetMessages,
  isLoading: boolean,
): void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const messagesRef = useRef(messages)
  const isLoadingRef = useRef(isLoading)
  const pendingRef = useRef(false)
  const generateRef = useRef<(() => Promise<void>) | null>(null)

  messagesRef.current = messages
  isLoadingRef.current = isLoading

  // 3P default: false
  const gbEnabled = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_sedge_lantern',
    false,
  )
  useEffect(() => {
    if (!feature('AWAY_SUMMARY')) return
    if (!gbEnabled) return

    function clearTimer(): void {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }

    function abortInFlight(): void {
      abortRef.current?.abort()
      abortRef.current = null
    }

    async function generate(): Promise<void> {
      pendingRef.current = false
      if (hasSummarySinceLastUserTurn(messagesRef.current)) return
      abortInFlight()
      const controller = new AbortController()
      abortRef.current = controller
      const text = await generateAwaySummary(
        messagesRef.current,
        controller.signal,
      )
      if (controller.signal.aborted || text === null) return
      setMessages(prev => [...prev, createAwaySummaryMessage(text)])
    }

    function onBlurTimerFire(): void {
      timerRef.current = null
      if (isLoadingRef.current) {
        pendingRef.current = true
        return
      }
      void generate()
    }

    function onFocusChange(): void {
      const state = getTerminalFocusState()
      if (state === 'blurred' || state === 'unknown') {
        // 对于"未知"终端（CMD、PowerShell），将挂载视为
        // 可能离开 —— 启动空闲计时器。下面的 isLoading 效果
        // 在每次回合转换时重置计时器。
        clearTimer()
        timerRef.current = setTimeout(onBlurTimerFire, BLUR_DELAY_MS)
      } else if (state === 'focused') {
        clearTimer()
        abortInFlight()
        pendingRef.current = false
      }
    }

    const unsubscribe = subscribeTerminalFocus(onFocusChange)
    // 处理效果挂载时我们已经失去焦点的情况
    onFocusChange()
    generateRef.current = generate

    return () => {
      unsubscribe()
      clearTimer()
      abortInFlight()
      generateRef.current = null
    }
  }, [gbEnabled, setMessages])

  // 计时器在回合中期触发 → 在回合结束时触发（如果仍然离开）
  useEffect(() => {
    if (isLoading) return
    if (!pendingRef.current) return
    const state = getTerminalFocusState()
    if (state !== 'blurred' && state !== 'unknown') return
    void generateRef.current?.()
  }, [isLoading])

  // 对于"未知"终端：使用 isLoading 转换作为存在信号。
  // 用户开始回合 → 他们在，取消空闲计时器。
  // 回合结束 → 重新启动空闲计时器。
  useEffect(() => {
    if (getTerminalFocusState() !== 'unknown') return
    if (!feature('AWAY_SUMMARY')) return
    if (!gbEnabled) return

    if (isLoading) {
      // 用户正在积极使用 —— 取消空闲计时器
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      abortRef.current?.abort()
      abortRef.current = null
      pendingRef.current = false
    } else {
      // 回合结束 —— 重新启动空闲计时器
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
      }
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        if (isLoadingRef.current) {
          pendingRef.current = true
          return
        }
        void generateRef.current?.()
      }, BLUR_DELAY_MS)
    }
  }, [isLoading, gbEnabled])
}
