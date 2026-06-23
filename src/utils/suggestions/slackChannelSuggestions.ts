import { z } from 'zod'
import type { SuggestionItem } from '../../components/PromptInput/PromptInputFooterSuggestions.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'
import { logForDebugging } from '../debug.js'
import { lazySchema } from '../lazySchema.js'
import { createSignal } from '../signal.js'
import { jsonParse } from '../slowOperations.js'

const SLACK_SEARCH_TOOL = 'slack_search_channels'

// 使用普通 Map（而非 LRUCache）— findReusableCacheEntry 需要遍历所有
// 条目进行前缀匹配，而 LRUCache 无法简洁地支持这种操作。
const cache = new Map<string, string[]>()
// 存储 MCP 返回过的所有频道名的扁平集合 — 用于控制高亮显示，
// 只有确认真实的频道才会在输入框中变蓝。
const knownChannels = new Set<string>()
let knownChannelsVersion = 0
const knownChannelsChanged = createSignal()
export const subscribeKnownChannels = knownChannelsChanged.subscribe
let inflightQuery: string | null = null
let inflightPromise: Promise<string[]> | null = null

function findSlackClient(
  clients: MCPServerConnection[],
): MCPServerConnection | undefined {
  return clients.find(c => c.type === 'connected' && c.name.includes('slack'))
}

async function fetchChannels(
  clients: MCPServerConnection[],
  query: string,
): Promise<string[]> {
  const slackClient = findSlackClient(clients)
  if (!slackClient || slackClient.type !== 'connected') {
    return []
  }

  try {
    const result = await slackClient.client.callTool(
      {
        name: SLACK_SEARCH_TOOL,
        arguments: {
          query,
          limit: 20,
          channel_types: 'public_channel,private_channel',
        },
      },
      undefined,
      { timeout: 5000 },
    )

    const content = result.content
    if (!Array.isArray(content)) return []

    const rawText = content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map(c => c.text)
      .join('\n')

    return parseChannels(unwrapResults(rawText))
  } catch (error) {
    logForDebugging(`Failed to fetch Slack channels: ${error}`)
    return []
  }
}

// Slack MCP 服务器将 markdown 包装在 JSON 信封中：
// {"results":"# Search Results...\nName: #chan\n..."}
const resultsEnvelopeSchema = lazySchema(() =>
  z.object({ results: z.string() }),
)

function unwrapResults(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) return text
  try {
    const parsed = resultsEnvelopeSchema().safeParse(jsonParse(trimmed))
    if (parsed.success) return parsed.data.results
  } catch {
    // jsonParse 抛出异常 — 继续执行
  }
  return text
}

// 从 slack_search_channels 的文本输出中解析频道名。
// Slack MCP 服务器返回的 markdown 中包含 "Name: #channel-name" 行。
function parseChannels(text: string): string[] {
  const channels: string[] = []
  const seen = new Set<string>()

  for (const line of text.split('\n')) {
    const m = line.match(/^Name:\s*#?([a-z0-9][a-z0-9_-]{0,79})\s*$/)
    if (m && !seen.has(m[1]!)) {
      seen.add(m[1]!)
      channels.push(m[1]!)
    }
  }

  return channels
}

export function hasSlackMcpServer(clients: MCPServerConnection[]): boolean {
  return findSlackClient(clients) !== undefined
}

export function getKnownChannelsVersion(): number {
  return knownChannelsVersion
}

export function findSlackChannelPositions(
  text: string,
): Array<{ start: number; end: number }> {
  const positions: Array<{ start: number; end: number }> = []
  const re = /(^|\s)#([a-z0-9][a-z0-9_-]{0,79})(?=\s|$)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (!knownChannels.has(m[2]!)) continue
    const start = m.index + m[1]!.length
    positions.push({ start, end: start + 1 + m[2]!.length })
  }
  return positions
}

// Slack 的搜索会按连字符分词并要求完整单词匹配，因此
// "claude-code-team-en" 会返回 0 条结果。移除末尾的不完整片段，
// 使 MCP 查询变为 "claude-code-team"（仅包含完整单词），然后在本地过滤。
// 这样既能让查询尽可能具体（避免 20 条结果上限），
// 又不会发送会破坏搜索的不完整单词。
function mcpQueryFor(searchToken: string): string {
  const lastSep = Math.max(
    searchToken.lastIndexOf('-'),
    searchToken.lastIndexOf('_'),
  )
  return lastSep > 0 ? searchToken.slice(0, lastSep) : searchToken
}

// 查找缓存中键为 mcpQuery 前缀且仍包含 searchToken 匹配项的条目。
// 这样输入 "c"→"cl"→"cla" 时可以复用 "c" 的缓存，
// 而不需要每次按键都发起新的 MCP 调用。
function findReusableCacheEntry(
  mcpQuery: string,
  searchToken: string,
): string[] | undefined {
  let best: string[] | undefined
  let bestLen = 0
  for (const [key, channels] of cache) {
    if (
      mcpQuery.startsWith(key) &&
      key.length > bestLen &&
      channels.some(c => c.startsWith(searchToken))
    ) {
      best = channels
      bestLen = key.length
    }
  }
  return best
}

export async function getSlackChannelSuggestions(
  clients: MCPServerConnection[],
  searchToken: string,
): Promise<SuggestionItem[]> {
  if (!searchToken) return []

  const mcpQuery = mcpQueryFor(searchToken)
  const lower = searchToken.toLowerCase()

  let channels = cache.get(mcpQuery) ?? findReusableCacheEntry(mcpQuery, lower)
  if (!channels) {
    if (inflightQuery === mcpQuery && inflightPromise) {
      channels = await inflightPromise
    } else {
      inflightQuery = mcpQuery
      inflightPromise = fetchChannels(clients, mcpQuery)
      channels = await inflightPromise
      cache.set(mcpQuery, channels)
      const before = knownChannels.size
      for (const c of channels) knownChannels.add(c)
      if (knownChannels.size !== before) {
        knownChannelsVersion++
        knownChannelsChanged.emit()
      }
      if (cache.size > 50) {
        cache.delete(cache.keys().next().value!)
      }
      if (inflightQuery === mcpQuery) {
        inflightQuery = null
        inflightPromise = null
      }
    }
  }

  return channels
    .filter(c => c.startsWith(lower))
    .sort()
    .slice(0, 10)
    .map(c => ({
      id: `slack-channel-${c}`,
      displayText: `#${c}`,
    }))
}

export function clearSlackChannelCache(): void {
  cache.clear()
  knownChannels.clear()
  knownChannelsVersion = 0
  inflightQuery = null
  inflightPromise = null
}
