import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'

/**
 * /ultrareview 的运行时门控。GB 配置中的 `enabled` 字段控制
 * 可见性 — 命令上的 isEnabled() 在其为 false 时会通过 getCommands()
 * 将其过滤掉，因此未获得门控权限的用户根本看不到该命令。
 */
export function isUltrareviewEnabled(): boolean {
  const cfg = getFeatureValue_CACHED_MAY_BE_STALE<Record<
    string,
    unknown
  > | null>('tengu_review_bughunter_config', null)
  return cfg?.enabled === true
}
