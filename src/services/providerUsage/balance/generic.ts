import type { ProviderBalance } from '../types.js'
import type { BalanceProvider } from './types.js'

/**
 * 通用 URL + 密钥余额提供商。
 *
 * 环境变量：
 *   CLAUDE_CODE_BALANCE_URL        — 返回 JSON 的 GET 端点（必填）
 *   CLAUDE_CODE_BALANCE_KEY        — 可选的 Bearer 令牌（回退到 OPENAI_API_KEY / ANTHROPIC_API_KEY）
 *   CLAUDE_CODE_BALANCE_JSON_PATH  — JSON 中余额数字的点分路径（默认："balance"）
 *                                    允许数组索引，例如 "data.0.credit"
 *   CLAUDE_CODE_BALANCE_CURRENCY   — 显示货币标签（默认："USD"）
 *
 * 有意保持宽松，以便任何 OpenAI 兼容的"我的余额"端点
 * 都能直接接入，无需编写新代码。
 */

function pickAtPath(obj: unknown, path: string): unknown {
  if (!path) return obj
  const parts = path.split('.').filter(Boolean)
  let cur: unknown = obj
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined
    if (Array.isArray(cur)) {
      const idx = Number(part)
      if (!Number.isFinite(idx)) return undefined
      cur = cur[idx]
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[part]
    } else {
      return undefined
    }
  }
  return cur
}

const PRIVATE_IP_RE =
  /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|127\.|0\.0\.0\.0|fc|fd|\[::1\]|\[fe80:)/

function assertSafeBalanceUrl(raw: string): URL {
  const parsed = new URL(raw)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`unsupported protocol: ${parsed.protocol}`)
  }
  if (
    parsed.protocol === 'http:' &&
    !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
  ) {
    throw new Error(`http only allowed for localhost, got ${parsed.hostname}`)
  }
  if (PRIVATE_IP_RE.test(parsed.hostname)) {
    throw new Error(`private/reserved IP not allowed: ${parsed.hostname}`)
  }
  return parsed
}

export const genericBalanceProvider: BalanceProvider = {
  providerId: 'generic',

  isEnabled(): boolean {
    return Boolean(process.env.CLAUDE_CODE_BALANCE_URL)
  },

  async fetchBalance(signal?: AbortSignal): Promise<ProviderBalance | null> {
    const rawUrl = process.env.CLAUDE_CODE_BALANCE_URL
    if (!rawUrl) return null

    let url: URL
    try {
      url = assertSafeBalanceUrl(rawUrl)
    } catch {
      return null
    }

    // 回退链：BALANCE_KEY → OPENAI_API_KEY → ANTHROPIC_API_KEY。
    // 警告：回退密钥将作为 Bearer 令牌发送到 CLAUDE_CODE_BALANCE_URL。
    // 如果该 URL 不可信，你的提供商密钥将泄露。推荐使用 CLAUDE_CODE_BALANCE_KEY。
    const key =
      process.env.CLAUDE_CODE_BALANCE_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.ANTHROPIC_API_KEY ||
      ''
    const path = process.env.CLAUDE_CODE_BALANCE_JSON_PATH || 'balance'
    const currency = process.env.CLAUDE_CODE_BALANCE_CURRENCY || 'USD'

    let res: Response
    try {
      res = await fetch(url.href, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
        signal,
      })
    } catch {
      return null
    }
    if (!res.ok) return null

    let data: unknown
    try {
      data = await res.json()
    } catch {
      return null
    }

    const raw = pickAtPath(data, path)
    const remaining = typeof raw === 'number' ? raw : Number(raw)
    if (!Number.isFinite(remaining)) return null

    return {
      currency,
      remaining,
      updatedAt: Math.floor(Date.now() / 1000),
    }
  },
}
