import { useState, useEffect, useCallback } from 'react'
import { fetchFileProgress, updateProgress } from '@/lib/api'
import type { ProgressEntry } from '@/lib/api'

export type SymbolStatus = ProgressEntry['status']

export interface SymbolProgress {
  status: SymbolStatus
  note: string
  updatedAt: string
  completed?: boolean
}

/**
 * Per-file learning progress hook.
 * Loads all symbol progress for a given file, provides methods to
 * toggle status and save notes.
 */
export function useLearningProgress(filePath: string | null) {
  const [entries, setEntries] = useState<Record<string, SymbolProgress>>({})
  const [loading, setLoading] = useState(false)

  // Load progress for file
  useEffect(() => {
    if (!filePath) {
      setEntries({})
      return
    }
    setLoading(true)
    fetchFileProgress(filePath)
      .then(data => {
        setEntries(data)
        setLoading(false)
      })
      .catch(() => {
        setLoading(false)
      })
  }, [filePath])

  const getEntry = useCallback(
    (symbolName: string): SymbolProgress | null => {
      return entries[symbolName] || null
    },
    [entries],
  )

  const getStatus = useCallback(
    (symbolName: string): SymbolStatus => {
      return entries[symbolName]?.status || 'unstudied'
    },
    [entries],
  )

  const getNote = useCallback(
    (symbolName: string): string => {
      return entries[symbolName]?.note || ''
    },
    [entries],
  )

  const getCompleted = useCallback(
    (symbolName: string): boolean => {
      return entries[symbolName]?.completed ?? false
    },
    [entries],
  )

  // Toggle status cycle: unstudied → studying → studied → unstudied
  const toggleStatus = useCallback(
    async (symbolName: string) => {
      if (!filePath) return
      const current = getStatus(symbolName)
      const next: SymbolStatus =
        current === 'unstudied'
          ? 'studying'
          : current === 'studying'
            ? 'studied'
            : 'unstudied'
      const key = `${filePath}::${symbolName}`
      const existingNote = getNote(symbolName)

      const existingCompleted = getCompleted(symbolName)

      // Optimistic update
      setEntries(prev => ({
        ...prev,
        [symbolName]: {
          status: next,
          note: existingNote,
          updatedAt: new Date().toISOString(),
          completed: existingCompleted,
        },
      }))

      try {
        await updateProgress(key, { status: next, note: existingNote })
      } catch {
        // Revert on failure
        setEntries(prev => ({
          ...prev,
          [symbolName]: {
            status: current,
            note: existingNote,
            updatedAt: prev[symbolName]?.updatedAt || '',
            completed: existingCompleted,
          },
        }))
      }
    },
    [filePath, getStatus, getNote, getCompleted],
  )

  const setNote = useCallback(
    async (symbolName: string, note: string) => {
      if (!filePath) return
      const current = getStatus(symbolName)
      const key = `${filePath}::${symbolName}`

      // Optimistic update
      setEntries(prev => ({
        ...prev,
        [symbolName]: {
          status: current,
          note,
          updatedAt: new Date().toISOString(),
        },
      }))

      try {
        await updateProgress(key, { status: current, note })
      } catch {
        // silent
      }
    },
    [filePath, getStatus],
  )

  const toggleCompleted = useCallback(
    async (symbolName: string) => {
      if (!filePath) return
      const current = getCompleted(symbolName)
      const next = !current
      const key = `${filePath}::${symbolName}`

      // Optimistic update
      setEntries(prev => ({
        ...prev,
        [symbolName]: {
          ...prev[symbolName],
          status: prev[symbolName]?.status || 'unstudied',
          note: prev[symbolName]?.note || '',
          updatedAt: new Date().toISOString(),
          completed: next,
        },
      }))

      try {
        await updateProgress(key, { completed: next })
      } catch {
        // Revert on failure
        setEntries(prev => ({
          ...prev,
          [symbolName]: {
            ...prev[symbolName],
            status: prev[symbolName]?.status || 'unstudied',
            note: prev[symbolName]?.note || '',
            updatedAt: prev[symbolName]?.updatedAt || '',
            completed: current,
          },
        }))
      }
    },
    [filePath, getCompleted],
  )

  // Compute summary stats
  const stats = useCallback(() => {
    const symbols = Object.keys(entries)
    const total = symbols.length
    const studied = symbols.filter(s => entries[s]?.status === 'studied').length
    const studying = symbols.filter(
      s => entries[s]?.status === 'studying',
    ).length
    const completed = symbols.filter(s => entries[s]?.completed).length
    return {
      total,
      studied,
      studying,
      unstudied: total - studied - studying,
      completed,
    }
  }, [entries])

  return {
    entries,
    loading,
    getEntry,
    getStatus,
    getNote,
    getCompleted,
    toggleStatus,
    setNote,
    toggleCompleted,
    stats,
  }
}
