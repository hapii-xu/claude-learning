/**
 * Companion 反应系统 — 对齐官方 ZUK + Dc8 模式。
 *
 * 由 REPL.tsx 在每轮查询结束后调用。检查静音状态、频率限制和
 * @-提及检测，然后调用 buddy_react API 生成反应文本，
 * 展示在 CompanionSprite 的对话气泡中。
 */
import { getCompanion } from './companion.js'
import { getGlobalConfig } from '../utils/config.js'
import { getClaudeAIOAuthTokens } from '../utils/auth.js'
import { getOauthConfig } from '../constants/oauth.js'
import { getUserAgent } from '../utils/http.js'
import type { Message } from '../types/message.js'

// ─── 频率限制 ──────────────────────────────────

let lastReactTime = 0
const MIN_INTERVAL_MS = 45_000 // 官方大约是 30-60 秒

// ─── 最近反应记录（避免重复）────────────────────

const recentReactions: string[] = []
const MAX_RECENT = 8

// ─── 对外 API ─────────────────────────────────────

/**
 * 在一轮查询结束后触发 companion 反应。
 *
 * 对齐官方的 `ZUK()`：
 *  1. 检查 companion 是否存在且未静音
 *  2. 检测用户是否按名字 @-提及了 companion
 *  3. 应用频率限制（未被提及时若间隔太短则跳过）
 *  4. 构建对话 transcript
 *  5. 调用 buddy_react API
 *  6. 将反应文本传给 setReaction 回调
 */
export function triggerCompanionReaction(
  messages: Message[],
  setReaction: (text: string | undefined) => void,
): void {
  const companion = getCompanion()
  if (!companion || getGlobalConfig().companionMuted) return

  const addressed = isAddressed(messages, companion.name)

  const now = Date.now()
  if (!addressed && now - lastReactTime < MIN_INTERVAL_MS) return

  const transcript = buildTranscript(messages)
  if (!transcript.trim()) return

  lastReactTime = now

  void callBuddyReactAPI(companion, transcript, addressed)
    .then(reaction => {
      if (!reaction) return
      recentReactions.push(reaction)
      if (recentReactions.length > MAX_RECENT) recentReactions.shift()
      setReaction(reaction)
    })
    .catch(() => {})
}

// ─── 辅助函数 ────────────────────────────────────────

function isAddressed(messages: Message[], name: string): boolean {
  const pattern = new RegExp(`\\b${escapeRegex(name)}\\b`, 'i')
  for (
    let i = messages.length - 1;
    i >= Math.max(0, messages.length - 3);
    i--
  ) {
    const m = messages[i]
    if (m?.type !== 'user') continue
    const content = m.message?.content
    if (typeof content === 'string' && pattern.test(content)) return true
  }
  return false
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildTranscript(messages: Message[]): string {
  return messages
    .slice(-12)
    .filter(m => m.type === 'user' || m.type === 'assistant')
    .map(m => {
      const role = m.type === 'user' ? 'user' : 'claude'
      const content = m.message?.content
      const text =
        typeof content === 'string'
          ? content.slice(0, 300)
          : Array.isArray(content)
            ? content
                .filter((b: any) => b?.type === 'text')
                .map((b: any) => b.text)
                .join(' ')
                .slice(0, 300)
            : ''
      return `${role}: ${text}`
    })
    .join('\n')
    .slice(0, 5000)
}

// ─── API 调用 ───────────────────────────────────────

async function callBuddyReactAPI(
  companion: {
    name: string
    personality: string
    species: string
    rarity: string
    stats: Record<string, number>
  },
  transcript: string,
  addressed: boolean,
): Promise<string | null> {
  const tokens = getClaudeAIOAuthTokens()
  if (!tokens?.accessToken) return null

  const orgId = getGlobalConfig().oauthAccount?.organizationUuid
  if (!orgId) return null

  const baseUrl = getOauthConfig().BASE_API_URL
  const url = `${baseUrl}/api/organizations/${orgId}/claude_code/buddy_react`

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokens.accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': getUserAgent(),
    },
    body: JSON.stringify({
      name: companion.name.slice(0, 32),
      personality: companion.personality.slice(0, 200),
      species: companion.species,
      rarity: companion.rarity,
      stats: companion.stats,
      transcript,
      reason: addressed ? 'addressed' : 'turn',
      recent: recentReactions.map(r => r.slice(0, 200)),
      addressed,
    }),
    signal: AbortSignal.timeout(10_000),
  })

  if (!resp.ok) return null

  try {
    const data = (await resp.json()) as { reaction?: string }
    return data.reaction?.trim() || null
  } catch {
    return null
  }
}
