import type {
  ProviderBalance,
  ProviderUsage,
  ProviderUsageBucket,
} from './types.js'

type Listener = (snapshot: ProviderUsage) => void

let current: ProviderUsage = {
  providerId: 'unknown',
  buckets: [],
}

const listeners: Set<Listener> = new Set()

export function getProviderUsage(): ProviderUsage {
  return current
}

/**
 * 替换某个提供商的用量桶。传入空数组是合法的——这表示最新响应中没有可用的配额请求头。
 */
export function updateProviderBuckets(
  providerId: string,
  buckets: ProviderUsageBucket[],
): void {
  current = {
    ...current,
    providerId,
    buckets,
  }
  emit()
}

export function setProviderBalance(
  providerId: string,
  balance: ProviderBalance | null,
): void {
  current = {
    ...current,
    providerId,
    ...(balance === null ? { balance: undefined } : { balance }),
  }
  emit()
}

export function subscribeProviderUsage(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function resetProviderUsage(): void {
  current = { providerId: 'unknown', buckets: [] }
  emit()
}

function emit(): void {
  for (const listener of listeners) {
    try {
      listener(current)
    } catch {
      // 监听器错误不应中断发布循环。
    }
  }
}
