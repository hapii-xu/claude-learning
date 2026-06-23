/**
 * 技能搜索的意图归一化层
 *
 * 问题：当用户查询是中文而大多数技能描述是英文时，
 * TF-IDF 词袋模型会丢失含义。CJK 二元组的 DF=1（语言
 * 不匹配，而非真正的稀有性），产生的 IDF 值会促进虚假
 * 匹配，如对 `帮我优化代码的性能` 返回 `prompt-optimizer`。
 *
 * 修复：在将查询交给 `searchSkills()` 之前，请 Haiku 将其归一化
 * 为 3-6 个英文任务/对象关键词。将归一化形式与
 * 原始查询拼接，以便 TF-IDF 能看到两者 —— 英文关键词携带真正的匹配
 * 信号，原始文本作为回退保留。
 *
 * 设计：
 * - 仅零回合（阻塞用户输入）：每个会话唯一查询一次 Haiku 调用。
 *   不在回合间预取中调用（预取按工具循环重复）。
 * - 进程级缓存：会话中相同查询重用结果。
 * - 优雅回退：Haiku 失败/超时/空 → 返回原始查询。
 * - ASCII-only 快速路径：无 CJK 字符的查询完全跳过 LLM。
 * - 功能标志：设置 `SKILL_SEARCH_INTENT_ENABLED=1` 以启用。
 */

import { queryHaiku } from '../api/claude.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { logForDebugging } from '../../utils/debug.js'

const INTENT_SYSTEM_PROMPT = `你是一个技能搜索索引的查询归一化器。

给定用户的自然语言请求（通常为中文，可能较长），提取 3-6 个能捕捉以下信息的英文关键词：
1. 任务动词（optimize, review, debug, refactor, test, deploy, analyze, write, audit, design, research, cleanup, implement）
2. 操作对象（code, prompt, test, UI, API, database, documentation, performance, security, architecture）
3. 上下文/领域（frontend, backend, mobile, python, go, rust, typescript）（如语义清晰则提取）

仅输出以空格分隔的小写英文关键词。无散文、无 JSON、无标点、无代码围栏。

示例：
- "帮我优化代码的性能" -> optimize code performance refactor
- "研究当前代码的实现然后分析优化思路" -> analyze code research refactor architecture
- "优化 prompt 的表达" -> optimize prompt refine writing
- "帮我做 code review" -> code review audit
- "清理代码里的 TODO" -> cleanup refactor dead-code
- "重构这个模块的代码" -> refactor code modularize
- "帮我写个 Go 单元测试" -> write test golang unit

仅输出关键词，不含其他内容。`

const DEFAULT_TIMEOUT_MS = 6_000
const MAX_QUERY_CHARS = 500
const MAX_KEYWORDS_CHARS = 120
/**
 * 进程级 query→keywords 缓存的上限。插入顺序 LRU ——
 * Map 迭代顺序是插入顺序，因此当大小超过上限时我们从前面淘汰。
 * 约 200 个条目 × 约 600 字节（查询 + 关键词）≈
 * 120 KB 最坏情况。没有这个上限，缓存会随着长会话中
 * 中文查询的多样性单调增长。
 */
const CACHE_MAX_ENTRIES = 200
const CACHE_TRIM_TO = 150

/** 进程级缓存。以原始（修剪后的）查询为键。 */
const cache = new Map<string, string>()

function setCachedQueryIntent(key: string, value: string): void {
  // 在命中后写入时刷新插入顺序，以便常用键
  // 保持存活（delete + set 是规范的 Map-LRU 习语）。
  if (cache.has(key)) cache.delete(key)
  cache.set(key, value)
  if (cache.size > CACHE_MAX_ENTRIES) {
    const toDrop = cache.size - CACHE_TRIM_TO
    const iter = cache.keys()
    for (let i = 0; i < toDrop; i++) {
      const next = iter.next()
      if (next.done) break
      cache.delete(next.value)
    }
  }
}

export function isIntentNormalizeEnabled(): boolean {
  return process.env.SKILL_SEARCH_INTENT_ENABLED === '1'
}

/** 仅在测试之间重置。 */
export function clearIntentNormalizeCache(): void {
  cache.clear()
}

/**
 * 归一化用户查询以便 TF-IDF 能看到英文任务关键词。
 * 成功时返回 `<原始> <关键词>`，任何失败路径返回原始字符串。永不抛出。
 */
export async function normalizeQueryIntent(query: string): Promise<string> {
  const trimmed = query.trim()
  if (!trimmed) return trimmed
  if (!isIntentNormalizeEnabled()) return trimmed

  // 仅 ASCII 查询已经是索引所需的正确形式。
  if (!/[\u4e00-\u9fff]/.test(trimmed)) return trimmed

  const cached = cache.get(trimmed)
  if (cached !== undefined) {
    // 刷新 LRU 位置以便频繁查询的字符串能在淘汰中存活。
    cache.delete(trimmed)
    cache.set(trimmed, cached)
    return cached
  }

  const capped = trimmed.slice(0, MAX_QUERY_CHARS)
  const keywords = await callHaiku(capped)
  const result = keywords ? `${trimmed} ${keywords}` : trimmed
  setCachedQueryIntent(trimmed, result)
  logForDebugging(
    `[skill-search] intent normalized: "${trimmed.slice(0, 40)}" -> "${keywords}"`,
  )
  return result
}

async function callHaiku(query: string): Promise<string> {
  const timeoutMs = getTimeoutMs()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await queryHaiku({
      systemPrompt: asSystemPrompt([INTENT_SYSTEM_PROMPT]),
      userPrompt: query,
      signal: controller.signal,
      options: {
        querySource: 'skill_search_intent',
        enablePromptCaching: true,
        agents: [],
        isNonInteractiveSession: true,
        hasAppendSystemPrompt: false,
        mcpTools: [],
      },
    })
    const text = extractResponseText(response?.message?.content)
    return sanitizeKeywords(text)
  } catch (error) {
    logForDebugging(`[skill-search] intent normalize failed: ${error}`)
    return ''
  } finally {
    clearTimeout(timer)
  }
}

function getTimeoutMs(): number {
  const raw = process.env.SKILL_SEARCH_INTENT_TIMEOUT_MS
  if (!raw) return DEFAULT_TIMEOUT_MS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS
  return parsed
}

function extractResponseText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const record = block as Record<string, unknown>
    if (record.type !== 'text') continue
    if (typeof record.text === 'string') parts.push(record.text)
  }
  return parts.join('').trim()
}

function sanitizeKeywords(raw: string): string {
  if (!raw) return ''
  // 去除任何不是关键词字符的内容。保留 ascii 字母、数字、
  // 连字符和空格。折叠空白。
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9\- ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return ''
  return cleaned.slice(0, MAX_KEYWORDS_CHARS)
}
