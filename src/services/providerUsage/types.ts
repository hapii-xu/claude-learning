/**
 * 统一的提供商用量模型。
 *
 * 每个 API 客户端（Anthropic、OpenAI、Bedrock 等）通过 `ProviderUsageAdapter`
 * 解析自身的响应头，并将桶推送到 store 中。
 * 余额轮询器还可以额外填充 `ProviderBalance`。
 */

export type BucketKind =
  | 'session' // Anthropic 5 小时窗口
  | 'weekly' // Anthropic 7 天窗口
  | 'requests' // OpenAI 风格的 RPM 桶
  | 'tokens' // OpenAI 风格的 TPM 桶
  | 'throttle' // Bedrock / 通用限流
  | 'custom'

export interface ProviderUsageBucket {
  kind: BucketKind
  label: string
  utilization: number
  resetsAt?: number
}

export interface ProviderBalance {
  currency: string
  remaining: number
  total?: number
  updatedAt?: number
}

export interface ProviderUsage {
  providerId: string
  buckets: ProviderUsageBucket[]
  balance?: ProviderBalance
}

export interface ProviderUsageAdapter {
  providerId: string
  parseHeaders(headers: globalThis.Headers): ProviderUsageBucket[]
}
