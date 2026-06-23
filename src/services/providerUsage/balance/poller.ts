import { setProviderBalance } from '../store.js'
import { deepseekBalanceProvider } from './deepseek.js'
import { genericBalanceProvider } from './generic.js'
import type { BalanceProvider } from './types.js'

const DEFAULT_INTERVAL_MIN = 10

// 注册顺序即优先级。第一个启用的提供商胜出。通用提供商（用户自定义 URL）
// 排在最前面，以便操作员覆盖内置的 DeepSeek 检测。
const PROVIDERS: BalanceProvider[] = [
  genericBalanceProvider,
  deepseekBalanceProvider,
]

function selectProvider(): BalanceProvider | null {
  if (process.env.CLAUDE_CODE_BALANCE_PROVIDER === 'none') return null
  return PROVIDERS.find(p => p.isEnabled()) ?? null
}

function intervalMs(): number {
  const raw = process.env.CLAUDE_CODE_BALANCE_POLL_INTERVAL_MINUTES
  const n = raw ? Number(raw) : DEFAULT_INTERVAL_MIN
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_INTERVAL_MIN * 60_000
  return Math.floor(n * 60_000)
}

let timer: ReturnType<typeof setInterval> | null = null
let inflight: AbortController | null = null
let active: BalanceProvider | null = null

const FETCH_TIMEOUT_MS = 10_000

async function tick(): Promise<void> {
  if (!active) return
  inflight?.abort()
  inflight = new AbortController()
  const timeout = setTimeout(() => inflight?.abort(), FETCH_TIMEOUT_MS)
  try {
    const balance = await active.fetchBalance(inflight.signal)
    setProviderBalance(active.providerId, balance)
  } catch {
    // Never bubble into the host process.
  } finally {
    clearTimeout(timeout)
  }
}

/** 如果已配置提供商则开始轮询。幂等操作。 */
export function startBalancePolling(): void {
  if (timer !== null) return
  active = selectProvider()
  if (!active) return
  // 立即启动一次，然后按间隔轮询。
  void tick()
  timer = setInterval(() => {
    void tick()
  }, intervalMs())
  // 不要仅为轮询器保持事件循环存活。
  if (
    typeof (timer as unknown as { unref?: () => void }).unref === 'function'
  ) {
    ;(timer as unknown as { unref: () => void }).unref()
  }
}

export function stopBalancePolling(): void {
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
  inflight?.abort()
  inflight = null
  active = null
}

export function getActiveBalanceProviderId(): string | null {
  return active?.providerId ?? null
}
