import { useMemo } from 'react'
import { type DOMElement, useAnimationFrame, stringWidth } from '@anthropic/ink'
import type { SpinnerMode } from './types.js'

export function useShimmerAnimation(
  mode: SpinnerMode,
  message: string,
  isStalled: boolean,
): [ref: (element: DOMElement | null) => void, glimmerIndex: number] {
  const glimmerSpeed = mode === 'requesting' ? 50 : 200
  // 停滞时传入 null 以取消订阅时钟 — 否则即使微光不可见，
  // setInterval 也会以 20fps 持续触发。
  // 值得注意的是，如果调用方从未挂载 `ref`（例如条件 JSX），
  // useTerminalViewport 会停留在初始的 isVisible:true，视口暂停
  // 永不生效，所以这是唯一的停止机制。
  const [ref, time] = useAnimationFrame(isStalled ? null : glimmerSpeed)
  const messageWidth = useMemo(() => stringWidth(message), [message])

  if (isStalled) {
    return [ref, -100]
  }

  const cyclePosition = Math.floor(time / glimmerSpeed)
  const cycleLength = messageWidth + 20

  if (mode === 'requesting') {
    return [ref, (cyclePosition % cycleLength) - 10]
  }
  return [ref, messageWidth + 10 - (cyclePosition % cycleLength)]
}
