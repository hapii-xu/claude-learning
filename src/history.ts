import { appendFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { getProjectRoot, getSessionId } from './bootstrap/state.js'
import { registerCleanup } from './utils/cleanupRegistry.js'
import type { HistoryEntry, PastedContent } from './utils/config.js'
import { logForDebugging } from './utils/debug.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from './utils/envUtils.js'
import { getErrnoCode } from './utils/errors.js'
import { readLinesReverse } from './utils/fsOperations.js'
import { lock } from './utils/lockfile.js'
import {
  hashPastedText,
  retrievePastedText,
  storePastedText,
} from './utils/pasteStore.js'
import { sleep } from './utils/sleep.js'
import { jsonParse, jsonStringify } from './utils/slowOperations.js'

const MAX_HISTORY_ITEMS = 100
const MAX_PASTED_CONTENT_LENGTH = 1024

/**
 * 已存储的粘贴内容 —— 要么是内联内容，要么是指向 paste store 的哈希引用。
 */
type StoredPastedContent = {
  id: number
  type: 'text' | 'image'
  content?: string // 小段粘贴的内联内容
  contentHash?: string // 大段粘贴存放在外部时所用的哈希引用
  mediaType?: string
  filename?: string
}

/**
 * Claude Code 会解析 history 中的粘贴内容引用以还原对应的粘贴内容。
 * 这些引用形如：
 *   文本：[Pasted text #1 +10 lines]
 *   图片：[Image #2]
 * 要求数字 ID 在同一条 prompt 内唯一，但跨 prompt 可以重复。
 * 我们选择数字自增 ID，因为相比其他 ID 方案，它对用户更友好。
 */

// 注意：最初的文本粘贴实现认为形如
// "line1\nline2\nline3" 的输入有 +2 行，而不是 3 行。此处保留该行为。
export function getPastedTextRefNumLines(text: string): number {
  return (text.match(/\r\n|\r|\n/g) || []).length
}

export function formatPastedTextRef(id: number, numLines: number): string {
  if (numLines === 0) {
    return `[Pasted text #${id}]`
  }
  return `[Pasted text #${id} +${numLines} lines]`
}

export function formatImageRef(id: number): string {
  return `[Image #${id}]`
}

export function parseReferences(
  input: string,
): Array<{ id: number; match: string; index: number }> {
  const referencePattern =
    /\[(Pasted text|Image|\.\.\.Truncated text) #(\d+)(?: \+\d+ lines)?(\.)*\]/g
  const matches = [...input.matchAll(referencePattern)]
  return matches
    .map(match => ({
      id: parseInt(match[2] || '0', 10),
      match: match[0],
      index: match.index,
    }))
    .filter(match => match.id > 0)
}

/**
 * 将输入中的 [Pasted text #N] 占位符替换为实际内容。
 * 图片引用保持不变 —— 它们会作为 content block 出现，而不是内联文本。
 */
export function expandPastedTextRefs(
  input: string,
  pastedContents: Record<number, PastedContent>,
): string {
  const refs = parseReferences(input)
  let expanded = input
  // 在原始匹配偏移处进行拼接，这样粘贴内容内部形如占位符的字符串
  // 不会被误当作真实引用。逆序处理可保证后面的替换不会影响前面的偏移。
  for (let i = refs.length - 1; i >= 0; i--) {
    const ref = refs[i]!
    const content = pastedContents[ref.id]
    if (content?.type !== 'text') continue
    expanded =
      expanded.slice(0, ref.index) +
      content.content +
      expanded.slice(ref.index + ref.match.length)
  }
  return expanded
}

function deserializeLogEntry(line: string): LogEntry {
  return jsonParse(line) as LogEntry
}

async function* makeLogEntryReader(): AsyncGenerator<LogEntry> {
  const currentSession = getSessionId()

  // 先处理尚未 flush 到磁盘的条目
  for (let i = pendingEntries.length - 1; i >= 0; i--) {
    yield pendingEntries[i]!
  }

  // 从全局 history 文件读取（在所有项目间共享）
  const historyPath = join(getClaudeConfigHomeDir(), 'history.jsonl')

  try {
    for await (const line of readLinesReverse(historyPath)) {
      try {
        const entry = deserializeLogEntry(line)
        // removeLastFromHistory 慢路径：条目在被删除前就已 flush 到磁盘，
        // 因此这里过滤掉，让 getHistory（上箭头）与 makeHistoryReader
        //（ctrl+r 搜索）一致地跳过它。
        if (
          entry.sessionId === currentSession &&
          skippedTimestamps.has(entry.timestamp)
        ) {
          continue
        }
        yield entry
      } catch (error) {
        // 不是关键错误 —— 仅跳过格式错误的行
        logForDebugging(`Failed to parse history line: ${error}`)
      }
    }
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    if (code === 'ENOENT') {
      return
    }
    throw e
  }
}

export async function* makeHistoryReader(): AsyncGenerator<HistoryEntry> {
  for await (const entry of makeLogEntryReader()) {
    yield await logEntryToHistoryEntry(entry)
  }
}

export type TimestampedHistoryEntry = {
  display: string
  timestamp: number
  resolve: () => Promise<HistoryEntry>
}

/**
 * 用于 ctrl+r 选择器的当前项目 history：按展示文本去重，
 * 最新优先，并带时间戳。粘贴内容通过 `resolve()` 懒加载 ——
 * 选择器列表只读取 display + timestamp。
 */
export async function* getTimestampedHistory(): AsyncGenerator<TimestampedHistoryEntry> {
  const currentProject = getProjectRoot()
  const seen = new Set<string>()

  for await (const entry of makeLogEntryReader()) {
    if (!entry || typeof entry.project !== 'string') continue
    if (entry.project !== currentProject) continue
    if (seen.has(entry.display)) continue
    seen.add(entry.display)

    yield {
      display: entry.display,
      timestamp: entry.timestamp,
      resolve: () => logEntryToHistoryEntry(entry),
    }

    if (seen.size >= MAX_HISTORY_ITEMS) return
  }
}

/**
 * 获取当前项目的 history 条目，当前会话的条目排在最前。
 *
 * 当前会话的条目会先于其他会话的条目 yield，这样并发会话不会相互
 * 穿插彼此的上箭头 history。每一组内部按"最新优先"排序。
 * 扫描窗口仍是原先的 MAX_HISTORY_ITEMS —— 条目只是在该窗口内重排，
 * 不会越界。
 */
export async function* getHistory(): AsyncGenerator<HistoryEntry> {
  const currentProject = getProjectRoot()
  const currentSession = getSessionId()
  const otherSessionEntries: LogEntry[] = []
  let yielded = 0

  for await (const entry of makeLogEntryReader()) {
    // 跳过格式错误的条目（文件损坏、旧格式或无效的 JSON 结构）
    if (!entry || typeof entry.project !== 'string') continue
    if (entry.project !== currentProject) continue

    if (entry.sessionId === currentSession) {
      yield await logEntryToHistoryEntry(entry)
      yielded++
    } else {
      otherSessionEntries.push(entry)
    }

    // 扫描窗口与之前一致 MAX_HISTORY_ITEMS —— 只是在窗口内重排。
    if (yielded + otherSessionEntries.length >= MAX_HISTORY_ITEMS) break
  }

  for (const entry of otherSessionEntries) {
    if (yielded >= MAX_HISTORY_ITEMS) return
    yield await logEntryToHistoryEntry(entry)
    yielded++
  }
}

type LogEntry = {
  display: string
  pastedContents: Record<number, StoredPastedContent>
  timestamp: number
  project: string
  sessionId?: string
}

/**
 * 将已存储的粘贴内容还原为完整的 PastedContent，必要时从 paste store 取回。
 */
async function resolveStoredPastedContent(
  stored: StoredPastedContent,
): Promise<PastedContent | null> {
  // 若存在内联内容，则直接使用
  if (stored.content) {
    return {
      id: stored.id,
      type: stored.type,
      content: stored.content,
      mediaType: stored.mediaType,
      filename: stored.filename,
    }
  }

  // 若存在哈希引用，则从 paste store 取回
  if (stored.contentHash) {
    const content = await retrievePastedText(stored.contentHash)
    if (content) {
      return {
        id: stored.id,
        type: stored.type,
        content,
        mediaType: stored.mediaType,
        filename: stored.filename,
      }
    }
  }

  // 内容不可用
  return null
}

/**
 * 通过解析 paste store 引用，将 LogEntry 转换为 HistoryEntry。
 */
async function logEntryToHistoryEntry(entry: LogEntry): Promise<HistoryEntry> {
  const pastedContents: Record<number, PastedContent> = {}

  for (const [id, stored] of Object.entries(entry.pastedContents || {})) {
    const resolved = await resolveStoredPastedContent(stored)
    if (resolved) {
      pastedContents[Number(id)] = resolved
    }
  }

  return {
    display: entry.display,
    pastedContents,
  }
}

let pendingEntries: LogEntry[] = []
let isWriting = false
let currentFlushPromise: Promise<void> | null = null
let cleanupRegistered = false
let lastAddedEntry: LogEntry | null = null
// 已 flush 到磁盘、读取时应跳过的条目时间戳集合。
// 用于 removeLastFromHistory 在条目已抢先越过 pending 缓冲时的场景。
// 作用域为单个 session（模块状态在进程重启时重置）。
const skippedTimestamps = new Set<number>()

// 核心 flush 逻辑 —— 将 pending 条目写入磁盘
async function immediateFlushHistory(): Promise<void> {
  if (pendingEntries.length === 0) {
    return
  }

  let release
  try {
    const historyPath = join(getClaudeConfigHomeDir(), 'history.jsonl')

    // 获取锁前先确保文件存在（append 模式会在缺失时创建）
    await writeFile(historyPath, '', {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'a',
    })

    release = await lock(historyPath, {
      stale: 10000,
      retries: {
        retries: 3,
        minTimeout: 50,
      },
    })

    const jsonLines = pendingEntries.map(entry => jsonStringify(entry) + '\n')
    pendingEntries = []

    await appendFile(historyPath, jsonLines.join(''), { mode: 0o600 })
  } catch (error) {
    logForDebugging(`Failed to write prompt history: ${error}`)
  } finally {
    if (release) {
      await release()
    }
  }
}

async function flushPromptHistory(retries: number): Promise<void> {
  if (isWriting || pendingEntries.length === 0) {
    return
  }

  // 在下一个用户 prompt 之前停止尝试 flush history
  if (retries > 5) {
    return
  }

  isWriting = true

  try {
    await immediateFlushHistory()
  } finally {
    isWriting = false

    if (pendingEntries.length > 0) {
      // 避免在紧密循环中反复重试
      await sleep(500)

      void flushPromptHistory(retries + 1)
    }
  }
}

async function addToPromptHistory(
  command: HistoryEntry | string,
): Promise<void> {
  const entry =
    typeof command === 'string'
      ? { display: command, pastedContents: {} }
      : command

  const storedPastedContents: Record<number, StoredPastedContent> = {}
  if (entry.pastedContents) {
    for (const [id, content] of Object.entries(entry.pastedContents)) {
      // 过滤掉图片（它们单独存放在 image-cache 中）
      if (content.type === 'image') {
        continue
      }

      // 小段文本内容：内联存储
      if (content.content.length <= MAX_PASTED_CONTENT_LENGTH) {
        storedPastedContents[Number(id)] = {
          id: content.id,
          type: content.type,
          content: content.content,
          mediaType: content.mediaType,
          filename: content.filename,
        }
      } else {
        // 大段文本内容：同步计算哈希并存储引用
        // 实际的磁盘写入异步进行（fire-and-forget）
        const hash = hashPastedText(content.content)
        storedPastedContents[Number(id)] = {
          id: content.id,
          type: content.type,
          contentHash: hash,
          mediaType: content.mediaType,
          filename: content.filename,
        }
        // fire-and-forget 的磁盘写入 —— 不阻塞 history 条目的创建
        void storePastedText(hash, content.content)
      }
    }
  }

  const logEntry: LogEntry = {
    ...entry,
    pastedContents: storedPastedContents,
    timestamp: Date.now(),
    project: getProjectRoot(),
    sessionId: getSessionId(),
  }

  pendingEntries.push(logEntry)
  lastAddedEntry = logEntry
  currentFlushPromise = flushPromptHistory(0)
  void currentFlushPromise
}

export function addToHistory(command: HistoryEntry | string): void {
  // 当运行在由 Claude Code 的 Tungsten 工具 spawn 的 tmux 会话中时，跳过 history。
  // 这样可避免验证/测试会话污染用户真实的命令历史。
  if (isEnvTruthy(process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY)) {
    return
  }

  // 首次使用时注册 cleanup
  if (!cleanupRegistered) {
    cleanupRegistered = true
    registerCleanup(async () => {
      // 若仍有进行中的 flush，则等待其完成
      if (currentFlushPromise) {
        await currentFlushPromise
      }
      // 若 flush 完成后仍有未写入的 pending 条目，则再做一次最终 flush
      if (pendingEntries.length > 0) {
        await immediateFlushHistory()
      }
    })
  }

  void addToPromptHistory(command)
}

export function clearPendingHistoryEntries(): void {
  pendingEntries = []
  lastAddedEntry = null
  skippedTimestamps.clear()
}

/**
 * 撤销最近一次 addToHistory 调用。用于"中断时自动恢复"：
 * 当 Esc 在任何响应到来之前回退对话时，这次 submit 在语义上已被撤销 ——
 * 对应的 history 条目也应撤销，否则上箭头会把被恢复的文本显示两次
 *（一次来自输入框，一次来自磁盘）。
 *
 * 快路径直接从 pending 缓冲弹出。如果异步 flush 已经赢得竞态
 *（TTFT 通常远大于磁盘写入延迟），则把该条目的时间戳加入 skip-set，
 * 供 getHistory 查阅。一次性生效：会清除被追踪的条目，使第二次调用成为 no-op。
 */
export function removeLastFromHistory(): void {
  if (!lastAddedEntry) return
  const entry = lastAddedEntry
  lastAddedEntry = null

  const idx = pendingEntries.lastIndexOf(entry)
  if (idx !== -1) {
    pendingEntries.splice(idx, 1)
  } else {
    skippedTimestamps.add(entry.timestamp)
  }
}
