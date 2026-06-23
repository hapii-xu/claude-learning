import type { ProviderBalance } from '../types.js'

export interface BalanceProvider {
  readonly providerId: string
  /** 用户是否已配置此提供商（环境变量等）。 */
  isEnabled(): boolean
  /** 获取最新快照；任何软性失败时返回 null。 */
  fetchBalance(signal?: AbortSignal): Promise<ProviderBalance | null>
}
