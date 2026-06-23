import type { ProviderUsageAdapter, ProviderUsageBucket } from '../types.js'

export const anthropicAdapter: ProviderUsageAdapter = {
  providerId: 'anthropic',

  /**
   * 解析 Anthropic 统一限速请求头。
   *
   *   anthropic-ratelimit-unified-5h-utilization   （0..1）
   *   anthropic-ratelimit-unified-5h-reset         （Unix 秒）
   *   anthropic-ratelimit-unified-7d-utilization
   *   anthropic-ratelimit-unified-7d-reset
   *
   * 仅对 OAuth（Claude AI Pro/Max）订阅者存在。使用原始 API 密钥时
   * 这些请求头不存在，此适配器返回 []。
   */
  parseHeaders(headers): ProviderUsageBucket[] {
    const buckets: ProviderUsageBucket[] = []
    for (const [abbrev, kind, label] of [
      ['5h', 'session', 'Session'],
      ['7d', 'weekly', 'Weekly'],
    ] as const) {
      const util = headers.get(
        `anthropic-ratelimit-unified-${abbrev}-utilization`,
      )
      const reset = headers.get(`anthropic-ratelimit-unified-${abbrev}-reset`)
      if (util === null || reset === null) continue
      const utilization = Number(util)
      const resetsAt = Number(reset)
      if (!Number.isFinite(utilization)) continue
      buckets.push({
        kind,
        label,
        utilization,
        ...(Number.isFinite(resetsAt) && resetsAt > 0 ? { resetsAt } : {}),
      })
    }
    return buckets
  },
}
