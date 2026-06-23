import type { ProviderUsageAdapter, ProviderUsageBucket } from '../types.js'

/**
 * AWS Bedrock 限速 / 限流请求头。
 *
 * Bedrock 不像 OpenAI 或 Anthropic 那样暴露精确的每分钟配额——
 * 响应中唯一可靠存在的信号是 `x-amzn-bedrock-*` 元数据。
 * 仅当能推导出有意义的 0..1 信号时才将*限流压力*作为桶返回；否则返回 []。
 *
 *   x-amzn-bedrock-quota-remaining  （0..1 分数，部分模型响应中存在）
 *   x-amzn-bedrock-quota-reset      （Unix 秒）
 *   retry-after                     （秒，429 响应时存在）
 */
export const bedrockAdapter: ProviderUsageAdapter = {
  providerId: 'bedrock',
  parseHeaders(headers): ProviderUsageBucket[] {
    const buckets: ProviderUsageBucket[] = []

    const remainingRaw = headers.get('x-amzn-bedrock-quota-remaining')
    const resetRaw = headers.get('x-amzn-bedrock-quota-reset')

    if (remainingRaw !== null) {
      const remaining = Number(remainingRaw)
      if (Number.isFinite(remaining) && remaining >= 0 && remaining <= 1) {
        const resetsAt = resetRaw !== null ? Number(resetRaw) : 0
        buckets.push({
          kind: 'throttle',
          label: 'Throttle',
          utilization: 1 - remaining,
          ...(Number.isFinite(resetsAt) && resetsAt > 0 ? { resetsAt } : {}),
        })
      }
    }

    return buckets
  },
}
