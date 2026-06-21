import axios from 'axios'
import { getOauthConfig } from '../../constants/oauth.js'
import { getOauthAccountInfo } from '../../utils/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { logError } from '../../utils/log.js'
import { isEssentialTrafficOnly } from '../../utils/privacyLevel.js'
import { getOAuthHeaders, prepareApiRequest } from '../../utils/teleport/api.js'

export type OverageCreditGrantInfo = {
  available: boolean
  eligible: boolean
  granted: boolean
  amount_minor_units: number | null
  currency: string | null
}

type CachedGrantEntry = {
  info: OverageCreditGrantInfo
  timestamp: number
}

const CACHE_TTL_MS = 60 * 60 * 1000 // 1 小时

/**
 * 从后端获取当前用户的 overage credit grant 资格。
 * 后端解析按套餐不同的金额和基于角色的领取权限，
 * CLI 只需读取响应，无需重复实现这套逻辑。
 */
async function fetchOverageCreditGrant(): Promise<OverageCreditGrantInfo | null> {
  try {
    const { accessToken, orgUUID } = await prepareApiRequest()
    const url = `${getOauthConfig().BASE_API_URL}/api/oauth/organizations/${orgUUID}/overage_credit_grant`
    const response = await axios.get<OverageCreditGrantInfo>(url, {
      headers: getOAuthHeaders(accessToken),
    })
    return response.data
  } catch (err) {
    logError(err)
    return null
  }
}

/**
 * 获取缓存的 grant 信息。无缓存或缓存过期时返回 null。
 * 当返回 null 时调用方应不渲染任何内容（不阻塞）——
 * refreshOverageCreditGrantCache 会懒触发去填充。
 */
export function getCachedOverageCreditGrant(): OverageCreditGrantInfo | null {
  const orgId = getOauthAccountInfo()?.organizationUuid
  if (!orgId) return null
  const cached = getGlobalConfig().overageCreditGrantCache?.[orgId]
  if (!cached) return null
  if (Date.now() - cached.timestamp > CACHE_TTL_MS) return null
  return cached.info
}

/**
 * 丢弃当前 org 的缓存条目，使下次读取时重新拉取。
 * 保留其他 org 的条目不动。
 */
export function invalidateOverageCreditGrantCache(): void {
  const orgId = getOauthAccountInfo()?.organizationUuid
  if (!orgId) return
  const cache = getGlobalConfig().overageCreditGrantCache
  if (!cache || !(orgId in cache)) return
  saveGlobalConfig(prev => {
    const next = { ...prev.overageCreditGrantCache }
    delete next[orgId]
    return { ...prev, overageCreditGrantCache: next }
  })
}

/**
 * 拉取并缓存 grant 信息。触发即忘；在某 upsell 界面即将渲染且缓存为空时调用。
 */
export async function refreshOverageCreditGrantCache(): Promise<void> {
  if (isEssentialTrafficOnly()) return
  const orgId = getOauthAccountInfo()?.organizationUuid
  if (!orgId) return
  const info = await fetchOverageCreditGrant()
  if (!info) return
  // 若 grant 数据未变化则跳过改写 —— 避免配置写入放大
  // （inc-4552 模式）。仍刷新时间戳，这样 getCachedOverageCreditGrant 中
  // 基于 TTL 的陈旧检查不会在每次组件挂载时反复触发 API 调用。
  saveGlobalConfig(prev => {
    // 从 prev（锁内最新）派生，而不是锁前的 getGlobalConfig() 读取 ——
    // saveConfigWithLock 会在文件锁下重新从磁盘读取配置，
    // 所以另一个 CLI 实例可能在外层读取和获取锁之间写入了内容。
    const prevCached = prev.overageCreditGrantCache?.[orgId]
    const existing = prevCached?.info
    const dataUnchanged =
      existing &&
      existing.available === info.available &&
      existing.eligible === info.eligible &&
      existing.granted === info.granted &&
      existing.amount_minor_units === info.amount_minor_units &&
      existing.currency === info.currency
    // 数据未变化且时间戳仍然新鲜时，完全跳过写入
    if (
      dataUnchanged &&
      prevCached &&
      Date.now() - prevCached.timestamp <= CACHE_TTL_MS
    ) {
      return prev
    }
    const entry: CachedGrantEntry = {
      info: dataUnchanged ? existing : info,
      timestamp: Date.now(),
    }
    return {
      ...prev,
      overageCreditGrantCache: {
        ...prev.overageCreditGrantCache,
        [orgId]: entry,
      },
    }
  })
}

/**
 * 格式化 grant 金额用于显示。若金额不可用（无资格，或我们不知道如何
 * 格式化的币种），返回 null。
 */
export function formatGrantAmount(info: OverageCreditGrantInfo): string | null {
  if (info.amount_minor_units == null || !info.currency) return null
  // 目前仅支持 USD；后端后续可能扩展
  if (info.currency.toUpperCase() === 'USD') {
    const dollars = info.amount_minor_units / 100
    return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`
  }
  return null
}

export type { CachedGrantEntry as OverageCreditGrantCacheEntry }
