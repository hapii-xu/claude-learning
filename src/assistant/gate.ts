import { feature } from 'bun:bundle'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'

/**
 * KAIROS 功能的运行时门控。
 *
 * 两层门控：
 *   1. 构建期：feature('KAIROS') 必须开启
 *   2. 运行期：tengu_kairos_assistant GrowthBook 标志（远程 kill switch）
 *
 * 由 main.tsx 在 setKairosActive(true) 之前调用 — 绝不能检查
 * kairosActive（否则会死锁：gate 依赖 active，active 又依赖 gate）。
 * 调用方（main.tsx L1826-1832）在此返回 true 后才会设置 kairosActive。
 */
export async function isKairosEnabled(): Promise<boolean> {
  if (!feature('KAIROS')) {
    return false
  }
  if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_kairos_assistant', false)) {
    return false
  }
  return true
}
