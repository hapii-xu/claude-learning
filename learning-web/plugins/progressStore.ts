import fs from 'node:fs'
import path from 'node:path'

/**
 * 学习进度存储 v2
 *
 * 磁盘格式: LearningStore { entries, annotations, bookmarks, pathProgress, recentActivity }
 * 向后兼容：旧版为纯 Record<string, ProgressEntry>，读取时自动包装成 { entries: old }
 */

/* ─── 基础类型 ─────────────────────────────────────────────── */

export interface ProgressEntry {
  status: 'unstudied' | 'studying' | 'studied'
  note: string
  updatedAt: string
  firstSeenAt?: string
  completed?: boolean
  completedAt?: string
}

export type ProgressStore = Record<string, ProgressEntry>

export interface AnnotationStyles {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strikethrough?: boolean
}

export interface LineAnnotation {
  id: string
  filePath: string
  startLine: number
  endLine: number
  color: 'yellow' | 'red' | 'blue' | 'green'
  comment: string
  createdAt: string
  updatedAt: string
  startCol?: number
  endCol?: number
  styles?: AnnotationStyles
  selectedText?: string
}

export interface BookmarkEntry {
  filePath: string
  addedAt: string
  tag?: string
}

export interface StationProgress {
  summary: string
  completedAt: string
}

export interface PathProgressEntry {
  currentStation: number
  completedStations: Record<string, StationProgress>
}

export interface Activity {
  filePath: string
  symbol?: string
  visitedAt: string
}

export interface FileNoteEntry {
  filePath: string
  completed: boolean
  completedAt?: string
  note: string
  updatedAt: string
  firstSeenAt?: string
}

/* ─── 顶层 Store 结构 ──────────────────────────────────────── */

export interface LearningStore {
  entries: ProgressStore
  annotations: Record<string, LineAnnotation>
  bookmarks: Record<string, BookmarkEntry>
  pathProgress: Record<string, PathProgressEntry>
  recentActivity: Activity[]
  fileNotes: Record<string, FileNoteEntry>
}

/* ─── 持久化 ───────────────────────────────────────────────── */

const CACHE_DIR = '.cache/learning-web'
const PROGRESS_FILE = 'learning-progress.json'

function getStorePath(projectRoot: string): string {
  return path.join(projectRoot, CACHE_DIR, PROGRESS_FILE)
}

function ensureCacheDir(projectRoot: string): void {
  const dir = path.join(projectRoot, CACHE_DIR)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

/** 读取完整 LearningStore（含自动迁移） */
export function readStore(projectRoot: string): LearningStore {
  const storePath = getStorePath(projectRoot)
  try {
    const raw = JSON.parse(fs.readFileSync(storePath, 'utf-8'))

    // 旧版兼容：根对象若没有 entries 字段则视为纯 ProgressStore
    if (raw && typeof raw === 'object' && !('entries' in raw)) {
      return {
        entries: raw as ProgressStore,
        annotations: {},
        bookmarks: {},
        pathProgress: {},
        recentActivity: [],
        fileNotes: {},
      }
    }

    return {
      entries: raw.entries ?? {},
      annotations: raw.annotations ?? {},
      bookmarks: raw.bookmarks ?? {},
      pathProgress: raw.pathProgress ?? {},
      recentActivity: raw.recentActivity ?? [],
      fileNotes: raw.fileNotes ?? {},
    }
  } catch {
    return {
      entries: {},
      annotations: {},
      bookmarks: {},
      pathProgress: {},
      recentActivity: [],
      fileNotes: {},
    }
  }
}

/** 写入完整 LearningStore */
export function writeStore(projectRoot: string, store: LearningStore): void {
  ensureCacheDir(projectRoot)
  fs.writeFileSync(
    getStorePath(projectRoot),
    JSON.stringify(store, null, 2),
    'utf-8',
  )
}

/* ─── 向后兼容层（只操作 entries） ────────────────────────── */

/** @deprecated 向后兼容，只返回 entries 部分 */
export function readProgress(projectRoot: string): ProgressStore {
  return readStore(projectRoot).entries
}

export function writeProgress(
  projectRoot: string,
  entries: ProgressStore,
): void {
  const store = readStore(projectRoot)
  store.entries = entries
  writeStore(projectRoot, store)
}

export function getProgressEntry(
  projectRoot: string,
  key: string,
): ProgressEntry | undefined {
  return readProgress(projectRoot)[key]
}

export function setProgressEntry(
  projectRoot: string,
  key: string,
  entry: ProgressEntry,
): void {
  const store = readStore(projectRoot)
  const existing = store.entries[key]
  store.entries[key] = {
    ...entry,
    firstSeenAt: entry.firstSeenAt || existing?.firstSeenAt || entry.updatedAt,
  }
  writeStore(projectRoot, store)
}

export function getFileProgress(
  projectRoot: string,
  filePath: string,
): Record<string, ProgressEntry> {
  const entries = readProgress(projectRoot)
  const prefix = `${filePath}::`
  const result: Record<string, ProgressEntry> = {}
  for (const [key, entry] of Object.entries(entries)) {
    if (key.startsWith(prefix)) {
      result[key.slice(prefix.length)] = entry
    }
  }
  return result
}

/* ─── 笔记搜索 ─────────────────────────────────────────────── */

export interface NoteSearchResult {
  key: string
  filePath: string
  symbolName: string
  status: ProgressEntry['status']
  note: string
  updatedAt: string
  firstSeenAt?: string
}

export function searchNotes(
  projectRoot: string,
  query = '',
): NoteSearchResult[] {
  const entries = readProgress(projectRoot)
  const lower = query.toLowerCase()
  const results: NoteSearchResult[] = []

  for (const [key, entry] of Object.entries(entries)) {
    if (!entry.note) continue
    if (
      lower &&
      !key.toLowerCase().includes(lower) &&
      !entry.note.toLowerCase().includes(lower)
    )
      continue
    const sepIdx = key.indexOf('::')
    if (sepIdx === -1) continue
    results.push({
      key,
      filePath: key.slice(0, sepIdx),
      symbolName: key.slice(sepIdx + 2),
      status: entry.status,
      note: entry.note,
      updatedAt: entry.updatedAt,
      firstSeenAt: entry.firstSeenAt,
    })
  }

  results.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
  return results
}

/* ─── 聚合统计 ─────────────────────────────────────────────── */

export interface ProgressStats {
  total: number
  studied: number
  studying: number
  unstudied: number
  fileCount: number
  symbolCount: number
  notedCount: number
  methodCompletedCount: number
  fileCompletedCount: number
  fileNoteCount: number
  dailyActivity: Record<string, number>
  recentDays: { date: string; count: number }[]
}

export function getStats(
  projectRoot: string,
  recentDaysCount = 30,
  totalSymbolCount?: number,
): ProgressStats {
  const store = readStore(projectRoot)
  const entries = store.entries
  const files = new Set<string>()
  const symbols = new Set<string>()
  let studied = 0
  let studying = 0
  let notedCount = 0
  let methodCompletedCount = 0
  const daily: Record<string, number> = {}

  for (const [key, entry] of Object.entries(entries)) {
    const sepIdx = key.indexOf('::')
    if (sepIdx !== -1) {
      files.add(key.slice(0, sepIdx))
      symbols.add(key.slice(sepIdx + 2))
    }
    if (entry.status === 'studied') studied++
    else if (entry.status === 'studying') studying++
    if (entry.note) notedCount++
    if (entry.completed) methodCompletedCount++
    const day = (entry.updatedAt || '').slice(0, 10)
    if (day) daily[day] = (daily[day] || 0) + 1
  }

  let fileCompletedCount = 0
  let fileNoteCount = 0
  for (const fe of Object.values(store.fileNotes)) {
    if (fe.completed) fileCompletedCount++
    if (fe.note) fileNoteCount++
  }

  const today = new Date()
  const recent: { date: string; count: number }[] = []
  for (let i = recentDaysCount - 1; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    const iso = d.toISOString().slice(0, 10)
    recent.push({ date: iso, count: daily[iso] || 0 })
  }

  const trackedTotal = studied + studying
  const unstudied =
    totalSymbolCount != null
      ? Math.max(0, totalSymbolCount - studied - studying)
      : 0

  return {
    total: trackedTotal,
    studied,
    studying,
    unstudied,
    fileCount: files.size,
    symbolCount: symbols.size,
    notedCount,
    methodCompletedCount,
    fileCompletedCount,
    fileNoteCount,
    dailyActivity: daily,
    recentDays: recent,
  }
}

/* ─── 行级标注 ─────────────────────────────────────────────── */

export function listAnnotations(
  projectRoot: string,
  filePath?: string,
): LineAnnotation[] {
  const store = readStore(projectRoot)
  const all = Object.values(store.annotations)
  if (!filePath) return all
  return all.filter(a => a.filePath === filePath)
}

export function setAnnotation(
  projectRoot: string,
  annotation: LineAnnotation,
): void {
  const store = readStore(projectRoot)
  store.annotations[annotation.id] = annotation
  writeStore(projectRoot, store)
}

export function deleteAnnotation(projectRoot: string, id: string): void {
  const store = readStore(projectRoot)
  delete store.annotations[id]
  writeStore(projectRoot, store)
}

/* ─── 书签 ─────────────────────────────────────────────────── */

export function listBookmarks(projectRoot: string): BookmarkEntry[] {
  const store = readStore(projectRoot)
  return Object.values(store.bookmarks).sort((a, b) =>
    b.addedAt.localeCompare(a.addedAt),
  )
}

export function addBookmark(
  projectRoot: string,
  filePath: string,
  tag?: string,
): void {
  const store = readStore(projectRoot)
  store.bookmarks[filePath] = {
    filePath,
    addedAt: new Date().toISOString(),
    tag,
  }
  writeStore(projectRoot, store)
}

export function removeBookmark(projectRoot: string, filePath: string): void {
  const store = readStore(projectRoot)
  delete store.bookmarks[filePath]
  writeStore(projectRoot, store)
}

export function isBookmarked(projectRoot: string, filePath: string): boolean {
  return filePath in readStore(projectRoot).bookmarks
}

/* ─── 学习路径进度 ─────────────────────────────────────────── */

export function getPathProgress(
  projectRoot: string,
  pathId: string,
): PathProgressEntry {
  const store = readStore(projectRoot)
  return (
    store.pathProgress[pathId] ?? { currentStation: 0, completedStations: {} }
  )
}

export function completeStation(
  projectRoot: string,
  pathId: string,
  stationId: string,
  summary: string,
  nextStationIndex: number,
): void {
  const store = readStore(projectRoot)
  const pp = store.pathProgress[pathId] ?? {
    currentStation: 0,
    completedStations: {},
  }
  pp.completedStations[stationId] = {
    summary,
    completedAt: new Date().toISOString(),
  }
  pp.currentStation = nextStationIndex
  store.pathProgress[pathId] = pp
  writeStore(projectRoot, store)
}

/* ─── 最近活动 ─────────────────────────────────────────────── */

const MAX_ACTIVITY = 50

export function recordActivity(
  projectRoot: string,
  filePath: string,
  symbol?: string,
): void {
  const store = readStore(projectRoot)
  // 去重：移除同 filePath+symbol 的旧记录
  store.recentActivity = store.recentActivity.filter(
    a => !(a.filePath === filePath && a.symbol === symbol),
  )
  store.recentActivity.unshift({
    filePath,
    symbol,
    visitedAt: new Date().toISOString(),
  })
  if (store.recentActivity.length > MAX_ACTIVITY) {
    store.recentActivity = store.recentActivity.slice(0, MAX_ACTIVITY)
  }
  writeStore(projectRoot, store)
}

export function getRecentActivity(projectRoot: string, limit = 10): Activity[] {
  return readStore(projectRoot).recentActivity.slice(0, limit)
}

/* ─── 文件符号覆盖率（供 file-coverage API 使用） ─────────── */

export interface FileCoverageEntry {
  studied: number
  total: number
}

/* ─── 文件笔记 / 文件完成标记 ──────────────────────────────── */

export function getFileNote(
  projectRoot: string,
  filePath: string,
): FileNoteEntry | undefined {
  return readStore(projectRoot).fileNotes[filePath]
}

export function setFileNote(
  projectRoot: string,
  filePath: string,
  patch: Partial<Omit<FileNoteEntry, 'filePath'>>,
): FileNoteEntry {
  const store = readStore(projectRoot)
  const existing = store.fileNotes[filePath]
  const now = new Date().toISOString()
  const next: FileNoteEntry = {
    filePath,
    completed: patch.completed ?? existing?.completed ?? false,
    completedAt:
      patch.completed === true && !existing?.completedAt
        ? now
        : patch.completed === false
          ? undefined
          : (patch.completedAt ?? existing?.completedAt),
    note: patch.note ?? existing?.note ?? '',
    updatedAt: now,
    firstSeenAt: existing?.firstSeenAt ?? now,
  }
  store.fileNotes[filePath] = next
  writeStore(projectRoot, store)
  return next
}

export function listFileNotes(projectRoot: string): FileNoteEntry[] {
  return Object.values(readStore(projectRoot).fileNotes).sort((a, b) =>
    (b.updatedAt || '').localeCompare(a.updatedAt || ''),
  )
}

export function searchFileNotes(
  projectRoot: string,
  query = '',
): FileNoteEntry[] {
  const all = listFileNotes(projectRoot)
  const lower = query.toLowerCase()
  return all.filter(fe => {
    if (!fe.note) return false
    if (!lower) return true
    return (
      fe.filePath.toLowerCase().includes(lower) ||
      fe.note.toLowerCase().includes(lower)
    )
  })
}

export function getFileCoverage(
  projectRoot: string,
  symbolCountByFile: Record<string, number>,
): Record<string, FileCoverageEntry> {
  const entries = readProgress(projectRoot)
  const studiedByFile: Record<string, number> = {}

  for (const [key, entry] of Object.entries(entries)) {
    if (entry.status !== 'studied') continue
    const sep = key.indexOf('::')
    if (sep === -1) continue
    const fp = key.slice(0, sep)
    studiedByFile[fp] = (studiedByFile[fp] || 0) + 1
  }

  const result: Record<string, FileCoverageEntry> = {}
  for (const [fp, total] of Object.entries(symbolCountByFile)) {
    result[fp] = { studied: studiedByFile[fp] || 0, total }
  }
  // Include files that have studied entries but aren't in symbolCountByFile
  for (const [fp, count] of Object.entries(studiedByFile)) {
    if (!(fp in result)) {
      result[fp] = { studied: count, total: count }
    }
  }
  return result
}
