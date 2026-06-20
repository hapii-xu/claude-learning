import { useMemo, useCallback, useState, useEffect, useRef } from 'react'
import Fuse from 'fuse.js'
import { modules } from '@/data/modules'
import { fileDescriptions } from '@/data/fileDescriptions'

export interface SearchResult {
  type: 'module' | 'file' | 'doc'
  title: string
  subtitle: string
  path: string
  description?: string
  score?: number
}

function buildSearchIndex(): SearchResult[] {
  const items: SearchResult[] = []

  // 1. 模块
  for (const mod of modules) {
    items.push({
      type: 'module',
      title: mod.title,
      subtitle: mod.titleEn,
      path: `/module/${mod.id}`,
      description: mod.description,
    })
  }

  // 2. 文件（从 modules 中的核心文件 + fileDescriptions 中的全部文件）
  const addedFiles = new Set<string>()

  // 模块中的核心文件（优先添加，有更丰富的描述）
  for (const mod of modules) {
    for (const file of mod.files) {
      if (file.path.endsWith('/')) continue // 跳过目录
      addedFiles.add(file.path)
      items.push({
        type: 'file',
        title: file.path.split('/').pop() || file.path,
        subtitle: file.path,
        path: `/file/${file.path}`,
        description: file.description,
      })
    }
  }

  // fileDescriptions 中的全部文件
  for (const [filePath, desc] of Object.entries(fileDescriptions)) {
    if (addedFiles.has(filePath)) continue
    addedFiles.add(filePath)
    items.push({
      type: 'file',
      title: filePath.split('/').pop() || filePath,
      subtitle: filePath,
      path: `/file/${filePath}`,
      description: desc,
    })
  }

  // 3. 文档
  for (const mod of modules) {
    if (!mod.docPaths) continue
    for (const docPath of mod.docPaths) {
      const docName =
        docPath
          .split('/')
          .pop()
          ?.replace(/\.\w+$/, '')
          .replace(/-/g, ' ') || docPath
      items.push({
        type: 'doc',
        title: docName,
        subtitle: docPath,
        path: `/doc/${docPath}`,
        description: `${mod.title} 的相关文档`,
      })
    }
  }

  return items
}

let cachedIndex: { fuse: Fuse<SearchResult>; items: SearchResult[] } | null =
  null

function getSearchIndex() {
  if (cachedIndex) return cachedIndex

  const items = buildSearchIndex()
  const fuse = new Fuse(items, {
    keys: [
      { name: 'title', weight: 0.4 },
      { name: 'subtitle', weight: 0.3 },
      { name: 'description', weight: 0.2 },
      { name: 'path', weight: 0.1 },
    ],
    threshold: 0.4,
    includeScore: true,
    minMatchCharLength: 2,
  })

  cachedIndex = { fuse, items }
  return cachedIndex
}

export function useSearch() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])

  const search = useCallback((q: string) => {
    setQuery(q)
    if (!q.trim() || q.length < 2) {
      setResults([])
      return
    }

    const { fuse } = getSearchIndex()
    const fuseResults = fuse.search(q, { limit: 20 })
    setResults(fuseResults.map(r => ({ ...r.item, score: r.score })))
  }, [])

  const allItems = useMemo(() => getSearchIndex().items, [])

  return { query, results, search, allItems }
}

/**
 * 获取搜索结果（同步版本，用于 Command 面板）
 */
export function searchSync(query: string): SearchResult[] {
  if (!query.trim() || query.length < 2) return []
  const { fuse } = getSearchIndex()
  return fuse
    .search(query, { limit: 20 })
    .map(r => ({ ...r.item, score: r.score }))
}

/**
 * 键盘快捷键 Hook — Cmd+K 触发搜索
 */
export function useCommandPalette(onOpen: () => void) {
  const onOpenRef = useRef(onOpen)
  onOpenRef.current = onOpen

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        onOpenRef.current()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])
}
