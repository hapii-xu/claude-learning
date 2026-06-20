import { useState, useMemo, useCallback } from 'react'
import Fuse from 'fuse.js'
import type { SymbolInfo, SymbolKind } from '@/data/types'
import type { SymbolStatus } from './useLearningProgress'

export interface SymbolFilterState {
  query: string
  kinds: Set<SymbolKind>
  statuses: Set<SymbolStatus>
}

export interface UseSymbolFilterReturn {
  query: string
  setQuery: (query: string) => void
  kinds: Set<SymbolKind>
  setKinds: (kinds: Set<SymbolKind>) => void
  toggleKind: (kind: SymbolKind) => void
  statuses: Set<SymbolStatus>
  setStatuses: (statuses: Set<SymbolStatus>) => void
  toggleStatus: (status: SymbolStatus) => void
  filtered: SymbolInfo[]
  clearAll: () => void
  hasActiveFilters: boolean
}

export function useSymbolFilter(
  symbols: SymbolInfo[],
  progressMap: Map<string, { status: SymbolStatus; completed: boolean }>,
): UseSymbolFilterReturn {
  const [query, setQuery] = useState('')
  const [kinds, setKinds] = useState<Set<SymbolKind>>(new Set())
  const [statuses, setStatuses] = useState<Set<SymbolStatus>>(new Set())

  // Build Fuse.js index (memoized)
  const fuse = useMemo(() => {
    return new Fuse(symbols, {
      keys: [
        { name: 'name', weight: 0.6 },
        { name: 'jsdoc', weight: 0.2 },
        { name: 'signature', weight: 0.2 },
      ],
      threshold: 0.4,
      includeScore: true,
      minMatchCharLength: 1,
    })
  }, [symbols])

  // Apply filters: fuse search -> kind filter -> status filter
  const filtered = useMemo(() => {
    let result = symbols

    // 1. Fuse search
    if (query.trim()) {
      const searchResults = fuse.search(query.trim())
      result = searchResults.map(r => r.item)
    }

    // 2. Kind filter
    if (kinds.size > 0) {
      result = result.filter(sym => kinds.has(sym.kind))
    }

    // 3. Status filter
    if (statuses.size > 0) {
      result = result.filter(sym => {
        const progress = progressMap.get(sym.name)
        const status = progress?.status ?? 'unstudied'
        return statuses.has(status)
      })
    }

    return result
  }, [symbols, query, kinds, statuses, fuse, progressMap])

  const toggleKind = useCallback((kind: SymbolKind) => {
    setKinds(prev => {
      const next = new Set(prev)
      if (next.has(kind)) {
        next.delete(kind)
      } else {
        next.add(kind)
      }
      return next
    })
  }, [])

  const toggleStatus = useCallback((status: SymbolStatus) => {
    setStatuses(prev => {
      const next = new Set(prev)
      if (next.has(status)) {
        next.delete(status)
      } else {
        next.add(status)
      }
      return next
    })
  }, [])

  const clearAll = useCallback(() => {
    setQuery('')
    setKinds(new Set())
    setStatuses(new Set())
  }, [])

  const hasActiveFilters =
    query.trim() !== '' || kinds.size > 0 || statuses.size > 0

  return {
    query,
    setQuery,
    kinds,
    setKinds,
    toggleKind,
    statuses,
    setStatuses,
    toggleStatus,
    filtered,
    clearAll,
    hasActiveFilters,
  }
}
