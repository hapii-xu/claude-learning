import type { LogOption, SerializedMessage } from '../types/logs.js'
import { count } from './array.js'
import { logForDebugging } from './debug.js'
import { getLogDisplayTitle, logError } from './log.js'
import { getSmallFastModel } from './model/model.js'
import { isLiteLog, loadFullLog } from './sessionStorage.js'
import { sideQuery } from './sideQuery.js'
import { jsonParse } from './slowOperations.js'

// 转录提取的限制
const MAX_TRANSCRIPT_CHARS = 2000 // 每个会话的最大转录字符数
const MAX_MESSAGES_TO_SCAN = 100 // 从开始/结束扫描的最大消息数
const MAX_SESSIONS_TO_SEARCH = 100 // 发送到 API 的最大会话数

const SESSION_SEARCH_SYSTEM_PROMPT = `Your goal is to find relevant sessions based on a user's search query.

You will be given a list of sessions with their metadata and a search query. Identify which sessions are most relevant to the query.

Each session may include:
- Title (display name or custom title)
- Tag (user-assigned category, shown as [tag: name] - users tag sessions with /tag command to categorize them)
- Branch (git branch name, shown as [branch: name])
- Summary (AI-generated summary)
- First message (beginning of the conversation)
- Transcript (excerpt of conversation content)

IMPORTANT: Tags are user-assigned labels that indicate the session's topic or category. If the query matches a tag exactly or partially, those sessions should be highly prioritized.

For each session, consider (in order of priority):
1. Exact tag matches (highest priority - user explicitly categorized this session)
2. Partial tag matches or tag-related terms
3. Title matches (custom titles or first message content)
4. Branch name matches
5. Summary and transcript content matches
6. Semantic similarity and related concepts

CRITICAL: Be VERY inclusive in your matching. Include sessions that:
- Contain the query term anywhere in any field
- Are semantically related to the query (e.g., "testing" matches sessions about "tests", "unit tests", "QA", etc.)
- Discuss topics that could be related to the query
- Have transcripts that mention the concept even in passing

When in doubt, INCLUDE the session. It's better to return too many results than too few. The user can easily scan through results, but missing relevant sessions is frustrating.

Return sessions ordered by relevance (most relevant first). If truly no sessions have ANY connection to the query, return an empty array - but this should be rare.

Respond with ONLY the JSON object, no markdown formatting:
{"relevant_indices": [2, 5, 0]}`

type AgenticSearchResult = {
  relevant_indices: number[]
}

/**
 * 从消息中提取可搜索的文本内容。
 */
function extractMessageText(message: SerializedMessage): string {
  if (message.type !== 'user' && message.type !== 'assistant') {
    return ''
  }

  const content = 'message' in message ? message.message?.content : undefined
  if (!content) return ''

  if (typeof content === 'string') {
    return content
  }

  if (Array.isArray(content)) {
    return content
      .map(block => {
        if (typeof block === 'string') return block
        if ('text' in block && typeof block.text === 'string') return block.text
        return ''
      })
      .filter(Boolean)
      .join(' ')
  }

  return ''
}

/**
 * 从会话消息中提取截断的转录。
 */
function extractTranscript(messages: SerializedMessage[]): string {
  if (messages.length === 0) return ''

  // 从开始和结束获取消息以获取上下文
  const messagesToScan =
    messages.length <= MAX_MESSAGES_TO_SCAN
      ? messages
      : [
          ...messages.slice(0, MAX_MESSAGES_TO_SCAN / 2),
          ...messages.slice(-MAX_MESSAGES_TO_SCAN / 2),
        ]

  const text = messagesToScan
    .map(extractMessageText)
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()

  return text.length > MAX_TRANSCRIPT_CHARS
    ? text.slice(0, MAX_TRANSCRIPT_CHARS) + '…'
    : text
}

/**
 * 检查日志是否在任何可搜索字段中包含查询词。
 */
function logContainsQuery(log: LogOption, queryLower: string): boolean {
  // 检查标题
  const title = getLogDisplayTitle(log).toLowerCase()
  if (title.includes(queryLower)) return true

  // 检查自定义标题
  if (log.customTitle?.toLowerCase().includes(queryLower)) return true

  // 检查标签
  if (log.tag?.toLowerCase().includes(queryLower)) return true

  // 检查分支
  if (log.gitBranch?.toLowerCase().includes(queryLower)) return true

  // 检查摘要
  if (log.summary?.toLowerCase().includes(queryLower)) return true

  // 检查首次提示
  if (log.firstPrompt?.toLowerCase().includes(queryLower)) return true

  // 检查转录（更耗时，最后检查）
  if (log.messages && log.messages.length > 0) {
    const transcript = extractTranscript(log.messages).toLowerCase()
    if (transcript.includes(queryLower)) return true
  }

  return false
}

/**
 * 执行代理搜索，使用 Claude 基于对查询的语义理解
 * 查找相关会话。
 */
export async function agenticSessionSearch(
  query: string,
  logs: LogOption[],
  signal?: AbortSignal,
): Promise<LogOption[]> {
  if (!query.trim() || logs.length === 0) {
    return []
  }

  const queryLower = query.toLowerCase()

  // 预过滤：查找包含查询词的会话
  // 这确保我们搜索相关会话，而不仅仅是最近的
  const matchingLogs = logs.filter(log => logContainsQuery(log, queryLower))

  // 最多取 MAX_SESSIONS_TO_SEARCH 个匹配的日志
  // 如果匹配较少，用最近的不匹配日志填充剩余位置以提供上下文
  let logsToSearch: LogOption[]
  if (matchingLogs.length >= MAX_SESSIONS_TO_SEARCH) {
    logsToSearch = matchingLogs.slice(0, MAX_SESSIONS_TO_SEARCH)
  } else {
    const nonMatchingLogs = logs.filter(
      log => !logContainsQuery(log, queryLower),
    )
    const remainingSlots = MAX_SESSIONS_TO_SEARCH - matchingLogs.length
    logsToSearch = [
      ...matchingLogs,
      ...nonMatchingLogs.slice(0, remainingSlots),
    ]
  }

  // 调试：记录我们拥有的数据
  logForDebugging(
    `Agentic search: ${logsToSearch.length}/${logs.length} logs, query="${query}", ` +
      `matching: ${matchingLogs.length}, with messages: ${count(logsToSearch, l => l.messages?.length > 0)}`,
  )

  // 为轻量日志加载完整日志以获取转录内容
  const logsWithTranscriptsPromises = logsToSearch.map(async log => {
    if (isLiteLog(log)) {
      try {
        return await loadFullLog(log)
      } catch (error) {
        logError(error as Error)
        // 如果加载失败，使用轻量日志（无转录）
        return log
      }
    }
    return log
  })
  const logsWithTranscripts = await Promise.all(logsWithTranscriptsPromises)

  logForDebugging(
    `Agentic search: loaded ${count(logsWithTranscripts, l => l.messages?.length > 0)}/${logsToSearch.length} logs with transcripts`,
  )

  // 为提示构建包含所有可搜索元数据的会话列表
  const sessionList = logsWithTranscripts
    .map((log, index) => {
      const parts: string[] = [`${index}:`]

      // 标题（显示标题，可能是自定义的或来自首次提示）
      const displayTitle = getLogDisplayTitle(log)
      parts.push(displayTitle)

      // 如果自定义标题与显示标题不同则添加
      if (log.customTitle && log.customTitle !== displayTitle) {
        parts.push(`[custom title: ${log.customTitle}]`)
      }

      // 标签
      if (log.tag) {
        parts.push(`[tag: ${log.tag}]`)
      }

      // Git 分支
      if (log.gitBranch) {
        parts.push(`[branch: ${log.gitBranch}]`)
      }

      // 摘要
      if (log.summary) {
        parts.push(`- Summary: ${log.summary}`)
      }

      // 首次提示内容（截断）
      if (log.firstPrompt && log.firstPrompt !== 'No prompt') {
        parts.push(`- First message: ${log.firstPrompt.slice(0, 300)}`)
      }

      // 转录摘录（如果有可用消息）
      if (log.messages && log.messages.length > 0) {
        const transcript = extractTranscript(log.messages)
        if (transcript) {
          parts.push(`- Transcript: ${transcript}`)
        }
      }

      return parts.join(' ')
    })
    .join('\n')

  const userMessage = `Sessions:
${sessionList}

Search query: "${query}"

Find the sessions that are most relevant to this query.`

  // 调试：记录会话列表的第一部分
  logForDebugging(
    `Agentic search prompt (first 500 chars): ${userMessage.slice(0, 500)}...`,
  )

  try {
    const model = getSmallFastModel()
    logForDebugging(`Agentic search using model: ${model}`)

    const response = await sideQuery({
      model,
      system: SESSION_SEARCH_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
      signal,
      querySource: 'session_search',
    })

    // 从响应中提取文本内容
    const textContent = response.content.find(block => block.type === 'text')
    if (!textContent || textContent.type !== 'text') {
      logForDebugging('No text content in agentic search response')
      return []
    }

    // 调试：记录响应
    logForDebugging(`Agentic search response: ${textContent.text}`)

    // 解析 JSON 响应
    const jsonMatch = textContent.text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      logForDebugging('Could not find JSON in agentic search response')
      return []
    }

    const result: AgenticSearchResult = jsonParse(jsonMatch[0])
    const relevantIndices = result.relevant_indices || []

    // 将索引映射回日志（索引相对于 logsWithTranscripts）
    const relevantLogs = relevantIndices
      .filter(index => index >= 0 && index < logsWithTranscripts.length)
      .map(index => logsWithTranscripts[index]!)

    logForDebugging(
      `Agentic search found ${relevantLogs.length} relevant sessions`,
    )

    return relevantLogs
  } catch (error) {
    logError(error as Error)
    logForDebugging(`Agentic search error: ${error}`)
    return []
  }
}
