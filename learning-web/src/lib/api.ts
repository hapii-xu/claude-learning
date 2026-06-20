import type {
  FileApiResponse,
  DocApiResponse,
  FileTreeNode,
  SymbolsApiResponse,
  ReferencesApiResponse,
  ImportsApiResponse,
  ExecRunRequest,
  ExecRunResponse,
  ExecCommand,
  LogSource,
  GraphApiResponse,
  NoteSearchResult,
  FileNoteEntry,
  ProgressStats,
  ExplainRequest,
  ExplainResponse,
  CodeSearchResponse,
  ChatMessage,
} from '@/data/types'

const BASE = ''

export async function fetchFile(filePath: string): Promise<FileApiResponse> {
  const res = await fetch(
    `${BASE}/api/file?path=${encodeURIComponent(filePath)}`,
  )
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }))
    throw new Error(err.error || `Failed to fetch file: ${filePath}`)
  }
  return res.json()
}

export async function writeFile(
  filePath: string,
  content: string,
): Promise<{ success: boolean }> {
  const res = await fetch(`${BASE}/api/file/write`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath, content }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }))
    throw new Error(err.error || `Failed to write file: ${filePath}`)
  }
  return res.json()
}

export async function fetchDoc(docPath: string): Promise<DocApiResponse> {
  const res = await fetch(`${BASE}/api/doc?path=${encodeURIComponent(docPath)}`)
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }))
    throw new Error(err.error || `Failed to fetch doc: ${docPath}`)
  }
  return res.json()
}

export async function fetchFileTree(): Promise<FileTreeNode[]> {
  const res = await fetch(`${BASE}/api/file-tree`)
  if (!res.ok) throw new Error('Failed to fetch file tree')
  const data = await res.json()
  return data.tree
}

// ─── Symbols ───

export async function fetchSymbols(
  filePath: string,
): Promise<SymbolsApiResponse> {
  const res = await fetch(
    `${BASE}/api/symbols?path=${encodeURIComponent(filePath)}`,
  )
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }))
    throw new Error(err.error || `Failed to fetch symbols: ${filePath}`)
  }
  return res.json()
}

// ─── References ───

export async function fetchReferences(
  filePath: string,
  symbol: string,
): Promise<ReferencesApiResponse> {
  const res = await fetch(
    `${BASE}/api/references?path=${encodeURIComponent(filePath)}&symbol=${encodeURIComponent(symbol)}`,
  )
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }))
    throw new Error(err.error || `Failed to fetch references: ${symbol}`)
  }
  return res.json()
}

// ─── Imports ───

export async function fetchImports(
  filePath: string,
): Promise<ImportsApiResponse> {
  const res = await fetch(
    `${BASE}/api/imports?path=${encodeURIComponent(filePath)}`,
  )
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }))
    throw new Error(err.error || `Failed to fetch imports: ${filePath}`)
  }
  return res.json()
}

// ─── Exec ───

export async function fetchCommands(): Promise<ExecCommand[]> {
  const res = await fetch(`${BASE}/api/exec/commands`)
  if (!res.ok) throw new Error('Failed to fetch commands')
  const data = await res.json()
  return data.commands
}

export async function runExec(cmd: ExecRunRequest): Promise<ExecRunResponse> {
  const res = await fetch(`${BASE}/api/exec/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }))
    throw new Error(err.error || 'Failed to run command')
  }
  return res.json()
}

export async function cancelExec(execId: string): Promise<void> {
  await fetch(`${BASE}/api/exec/cancel?execId=${encodeURIComponent(execId)}`, {
    method: 'POST',
  })
}

// ─── Logs ───

export async function fetchLogSources(): Promise<LogSource[]> {
  const res = await fetch(`${BASE}/api/logs/sources`)
  if (!res.ok) throw new Error('Failed to fetch log sources')
  const data = await res.json()
  return data.sources
}

// ─── Learning Progress ───

export interface ProgressEntry {
  status: 'unstudied' | 'studying' | 'studied'
  note: string
  updatedAt: string
  completed?: boolean
  completedAt?: string
}

export async function fetchAllProgress(): Promise<
  Record<string, ProgressEntry>
> {
  const res = await fetch(`${BASE}/api/progress`)
  if (!res.ok) throw new Error('Failed to fetch progress')
  const data = await res.json()
  return data.progress
}

export async function updateProgress(
  key: string,
  opts:
    | ProgressEntry['status']
    | { status?: ProgressEntry['status']; note?: string; completed?: boolean },
  note?: string,
): Promise<void> {
  // Legacy positional-arg support: updateProgress(key, status, note)
  const body =
    typeof opts === 'string' ? { key, status: opts, note } : { key, ...opts }
  const res = await fetch(`${BASE}/api/progress`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error('Failed to update progress')
}

export async function fetchFileProgress(
  filePath: string,
): Promise<Record<string, ProgressEntry>> {
  const res = await fetch(
    `${BASE}/api/progress/file?path=${encodeURIComponent(filePath)}`,
  )
  if (!res.ok) throw new Error('Failed to fetch file progress')
  const data = await res.json()
  return data.entries
}

// ─── File Notes / File Completion ───

export async function fetchFileNote(
  filePath: string,
): Promise<FileNoteEntry | null> {
  const res = await fetch(
    `${BASE}/api/progress/file-meta?path=${encodeURIComponent(filePath)}`,
  )
  if (!res.ok) throw new Error('Failed to fetch file note')
  const data = await res.json()
  return data.entry
}

export async function updateFileNote(
  filePath: string,
  patch: { completed?: boolean; note?: string },
): Promise<FileNoteEntry> {
  const res = await fetch(`${BASE}/api/progress/file-meta`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filePath, ...patch }),
  })
  if (!res.ok) throw new Error('Failed to update file note')
  const data = await res.json()
  return data.entry
}

export async function fetchAllFileNotes(): Promise<FileNoteEntry[]> {
  const res = await fetch(`${BASE}/api/progress/file-meta/list`)
  if (!res.ok) throw new Error('Failed to fetch file notes')
  const data = await res.json()
  return data.entries
}

// ─── Knowledge Graph ───

export async function fetchGraph(
  opts: {
    file?: string
    dir?: string
    relations?: string
    limit?: number
  } = {},
): Promise<GraphApiResponse> {
  const params = new URLSearchParams()
  if (opts.file) params.set('file', opts.file)
  if (opts.dir) params.set('dir', opts.dir)
  if (opts.relations) params.set('relations', opts.relations)
  if (opts.limit) params.set('limit', String(opts.limit))
  const qs = params.toString()
  const res = await fetch(`${BASE}/api/graph${qs ? `?${qs}` : ''}`)
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }))
    throw new Error(err.error || 'Failed to fetch graph')
  }
  return res.json()
}

export async function triggerGraphRegen(): Promise<{
  success: boolean
  message: string
}> {
  const res = await fetch(`${BASE}/api/graph/regen`, { method: 'POST' })
  if (!res.ok) throw new Error('Failed to trigger graph regen')
  return res.json()
}

// ─── Notes Search ───

export async function searchNotesApi(
  query = '',
  kind: 'symbol' | 'file' | 'all' = 'symbol',
): Promise<NoteSearchResult[]> {
  const params = new URLSearchParams({ q: query, kind })
  const res = await fetch(`${BASE}/api/progress/search?${params}`)
  if (!res.ok) throw new Error('Failed to search notes')
  const data = await res.json()
  return data.results
}

// ─── Dashboard Stats ───

export async function fetchProgressStats(days = 30): Promise<ProgressStats> {
  const res = await fetch(`${BASE}/api/progress/stats?days=${days}`)
  if (!res.ok) throw new Error('Failed to fetch stats')
  return res.json()
}

// ─── AI Explain ───

export async function explainCode(
  req: ExplainRequest,
): Promise<ExplainResponse> {
  const res = await fetch(`${BASE}/api/ai/explain`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }))
    throw new Error(err.error || 'Failed to explain code')
  }
  return res.json()
}

// ─── Code Search (ripgrep) ───

export async function searchCodeApi(opts: {
  q: string
  path?: string
  glob?: string
  regex?: boolean
}): Promise<CodeSearchResponse> {
  const params = new URLSearchParams({ q: opts.q })
  if (opts.path) params.set('path', opts.path)
  if (opts.glob) params.set('glob', opts.glob)
  if (opts.regex) params.set('regex', '1')
  const res = await fetch(`${BASE}/api/code-search?${params}`)
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }))
    throw new Error(err.error || 'Failed to search code')
  }
  return res.json()
}

// ─── Chat (streaming SSE) ───

export interface ChatUsage {
  input_tokens: number
  output_tokens: number
  cache_read: number
  cache_creation: number
}

/**
 * 流式调用 /api/ai/chat。
 * 返回 AbortController，调用 `.abort()` 可中止流。
 * onDelta 在每次收到 token 时触发；onDone 在流结束时触发；onError 在失败时触发。
 */
export function chatWithClaude(
  messages: ChatMessage[],
  context: { currentFile?: string },
  onDelta: (text: string) => void,
  onDone: (usage: ChatUsage) => void,
  onError: (err: string) => void,
): AbortController {
  const ctrl = new AbortController()

  ;(async () => {
    const res = await fetch(`${BASE}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        context,
      }),
      signal: ctrl.signal,
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: '请求失败' }))
      onError(err.error || `HTTP ${res.status}`)
      return
    }
    if (!res.body) {
      onError('No response body')
      return
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // 按 \n\n 切分 SSE 事件
      const events = buffer.split('\n\n')
      buffer = events.pop() ?? ''
      for (const event of events) {
        if (!event.trim()) continue
        // 取最后一个 data: 行
        const dataLine = event.split('\n').find(l => l.startsWith('data: '))
        if (!dataLine) continue
        try {
          const data = JSON.parse(dataLine.slice(6)) as {
            text?: string
            usage?: ChatUsage
            error?: string
          }
          if (data.text) onDelta(data.text)
          if (data.usage) onDone(data.usage)
          if (data.error) onError(data.error)
        } catch {
          // 忽略解析错误
        }
      }
    }
  })().catch(err => {
    if (err.name !== 'AbortError') {
      onError(err instanceof Error ? err.message : 'Chat failed')
    }
  })

  return ctrl
}
