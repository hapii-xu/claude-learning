import { useRef } from 'react'

// 处理 token 停止流入时过渡到红色的 Hook。
// 由父组件的动画时钟时间驱动，而非独立的 interval，
// 因此当终端失去焦点时会变慢。
export function useStalledAnimation(
  time: number,
  currentResponseLength: number,
  hasActiveTools = false,
  reducedMotion = false,
): {
  isStalled: boolean
  stalledIntensity: number
} {
  const lastTokenTime = useRef(time)
  const lastResponseLength = useRef(currentResponseLength)
  const mountTime = useRef(time)
  const stalledIntensityRef = useRef(0)
  const lastSmoothTime = useRef(time)

  // 当新 token 到达时重置计时器（检查实际长度变化）
  if (currentResponseLength > lastResponseLength.current) {
    lastTokenTime.current = time
    lastResponseLength.current = currentResponseLength
    stalledIntensityRef.current = 0
    lastSmoothTime.current = time
  }

  // 从动画时钟派生距上一个 token 的时间
  let timeSinceLastToken: number
  if (hasActiveTools) {
    timeSinceLastToken = 0
    lastTokenTime.current = time
  } else if (currentResponseLength > 0) {
    timeSinceLastToken = time - lastTokenTime.current
  } else {
    timeSinceLastToken = time - mountTime.current
  }

  // 根据距上一个 token 的时间计算停滞强度
  // 3 秒没有新 token 后开始变红（仅在没有活跃工具时）
  const isStalled = timeSinceLastToken > 3000 && !hasActiveTools
  const intensity = isStalled
    ? Math.min((timeSinceLastToken - 3000) / 2000, 1) // 2 秒内淡入
    : 0

  // 由动画帧 tick 驱动的平滑强度过渡
  if (!reducedMotion && (intensity > 0 || stalledIntensityRef.current > 0)) {
    const dt = time - lastSmoothTime.current
    if (dt >= 50) {
      const steps = Math.floor(dt / 50)
      let current = stalledIntensityRef.current
      for (let i = 0; i < steps; i++) {
        const diff = intensity - current
        if (Math.abs(diff) < 0.01) {
          current = intensity
          break
        }
        current += diff * 0.1
      }
      stalledIntensityRef.current = current
      lastSmoothTime.current = time
    }
  } else {
    stalledIntensityRef.current = intensity
    lastSmoothTime.current = time
  }

  // 启用 reducedMotion 时使用瞬时强度变化
  const effectiveIntensity = reducedMotion
    ? intensity
    : stalledIntensityRef.current

  return { isStalled, stalledIntensity: effectiveIntensity }
}
