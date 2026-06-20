import { feature } from 'bun:bundle'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'

/**
 * /assistant 命令可见性的运行时门控。
 *
 * 构建期：feature('KAIROS') 必须开启。
 * 运行期：tengu_kairos_assistant GrowthBook flag（远程 kill switch）。
 *
 * 不要求 kairosActive —— /assistant 命令在激活前也可见，
 * 这样用户可以通过调用它来激活 KAIROS。
 */
export function isAssistantEnabled(): boolean {
  if (!feature('KAIROS')) {
    return false
  }
  if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_kairos_assistant', false)) {
    return false
  }
  return true
}
