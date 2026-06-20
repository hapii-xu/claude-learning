import { useState, useEffect, useCallback } from 'react'
import { fetchFileNote, updateFileNote } from '@/lib/api'
import type { FileNoteEntry } from '@/data/types'

export function useFileNote(filePath: string | null) {
  const [entry, setEntry] = useState<FileNoteEntry | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!filePath) {
      setEntry(null)
      return
    }
    setLoading(true)
    fetchFileNote(filePath)
      .then(data => {
        setEntry(data)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [filePath])

  const toggleCompleted = useCallback(async () => {
    if (!filePath) return
    const next = !(entry?.completed ?? false)
    const prev = entry

    // Optimistic update
    setEntry(e =>
      e
        ? { ...e, completed: next }
        : {
            filePath,
            completed: next,
            note: '',
            updatedAt: new Date().toISOString(),
          },
    )

    try {
      const updated = await updateFileNote(filePath, { completed: next })
      setEntry(updated)
    } catch {
      setEntry(prev)
    }
  }, [filePath, entry])

  const setNote = useCallback(
    async (note: string) => {
      if (!filePath) return
      const prev = entry

      // Optimistic update
      setEntry(e =>
        e
          ? { ...e, note }
          : {
              filePath,
              completed: false,
              note,
              updatedAt: new Date().toISOString(),
            },
      )

      try {
        const updated = await updateFileNote(filePath, { note })
        setEntry(updated)
      } catch {
        setEntry(prev)
      }
    },
    [filePath, entry],
  )

  return { entry, loading, toggleCompleted, setNote }
}
