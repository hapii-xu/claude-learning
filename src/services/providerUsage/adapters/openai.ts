import type { ProviderUsageAdapter, ProviderUsageBucket } from '../types.js'

/**
 * 将 Retry-After 风格的时间字符串（如 "6m0s"、"1h30m"、"500ms"）
 * 解析为*从现在起*的 Unix 纪元秒数。无法解析时返回 0。
 */
function parseResetAt(value: string | null): number {
  if (!value) return 0
  let seconds = 0
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(value)) !== null) {
    const n = Number(match[1])
    const unit = match[2]
    switch (unit) {
      case 'ms':
        seconds += n / 1000
        break
      case 's':
        seconds += n
        break
      case 'm':
        seconds += n * 60
        break
      case 'h':
        seconds += n * 3600
        break
      case 'd':
        seconds += n * 86400
        break
    }
  }
  if (seconds === 0) {
    const n = Number(value)
    if (Number.isFinite(n)) seconds = n
  }
  if (seconds <= 0) return 0
  return Math.floor(Date.now() / 1000) + seconds
}

function computeUtilization(
  remaining: string | null,
  limit: string | null,
): number | null {
  if (remaining === null || limit === null) return null
  const r = Number(remaining)
  const l = Number(limit)
  if (!Number.isFinite(r) || !Number.isFinite(l) || l <= 0) return null
  const used = Math.max(0, l - r)
  return Math.min(1, Math.max(0, used / l))
}

/**
 * OpenAI 兼容的限速请求头。
 *
 *   x-ratelimit-limit-requests     / x-ratelimit-remaining-requests     / x-ratelimit-reset-requests
 *   x-ratelimit-limit-tokens       / x-ratelimit-remaining-tokens       / x-ratelimit-reset-tokens
 *
 * 适用于 OpenAI、DeepSeek、Moonshot、Grok（xAI）以及许多自托管的
 * OpenAI 兼容网关。
 */
export const openaiAdapter: ProviderUsageAdapter = {
  providerId: 'openai',
  parseHeaders(headers): ProviderUsageBucket[] {
    const buckets: ProviderUsageBucket[] = []

    const reqUtil = computeUtilization(
      headers.get('x-ratelimit-remaining-requests'),
      headers.get('x-ratelimit-limit-requests'),
    )
    if (reqUtil !== null) {
      buckets.push({
        kind: 'requests',
        label: 'RPM',
        utilization: reqUtil,
        resetsAt:
          parseResetAt(headers.get('x-ratelimit-reset-requests')) || undefined,
      })
    }

    const tokUtil = computeUtilization(
      headers.get('x-ratelimit-remaining-tokens'),
      headers.get('x-ratelimit-limit-tokens'),
    )
    if (tokUtil !== null) {
      buckets.push({
        kind: 'tokens',
        label: 'TPM',
        utilization: tokUtil,
        resetsAt:
          parseResetAt(headers.get('x-ratelimit-reset-tokens')) || undefined,
      })
    }

    return buckets
  },
}
