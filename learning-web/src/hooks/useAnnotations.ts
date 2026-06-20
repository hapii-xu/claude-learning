import { useState, useEffect, useCallback } from 'react'
import type { LineAnnotation } from '@/data/types'

interface UseAnnotationsReturn {
  annotations: LineAnnotation[]
  addAnnotation: (
    a: Omit<LineAnnotation, 'id' | 'createdAt' | 'updatedAt'>,
  ) => Promise<void>
  updateAnnotation: (a: LineAnnotation) => Promise<void>
  removeAnnotation: (id: string) => Promise<void>
  loading: boolean
}

export function useAnnotations(filePath: string | null): UseAnnotationsReturn {
  const [annotations, setAnnotations] = useState<LineAnnotation[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!filePath) {
      setAnnotations([])
      return
    }

    let cancelled = false
    setLoading(true)

    fetch(`/api/annotations?filePath=${encodeURIComponent(filePath)}`)
      .then(r => r.json())
      .then((d: { annotations: LineAnnotation[] }) => {
        if (!cancelled) {
          setAnnotations(d.annotations ?? [])
        }
      })
      .catch(() => {
        if (!cancelled) setAnnotations([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [filePath])

  const addAnnotation = useCallback(
    async (a: Omit<LineAnnotation, 'id' | 'createdAt' | 'updatedAt'>) => {
      // Optimistic: create a temp entry
      const tempId = `temp-${Date.now()}`
      const now = new Date().toISOString()
      const tempAnnotation: LineAnnotation = {
        ...a,
        id: tempId,
        createdAt: now,
        updatedAt: now,
      }
      setAnnotations(prev => [...prev, tempAnnotation])

      try {
        const res = await fetch('/api/annotations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(a),
        })
        const d: { annotation: LineAnnotation } = await res.json()
        setAnnotations(prev =>
          prev.map(ann => (ann.id === tempId ? d.annotation : ann)),
        )
      } catch {
        // Rollback on error
        setAnnotations(prev => prev.filter(ann => ann.id !== tempId))
      }
    },
    [],
  )

  const updateAnnotation = useCallback(async (a: LineAnnotation) => {
    // Optimistic update
    setAnnotations(prev =>
      prev.map(ann =>
        ann.id === a.id ? { ...a, updatedAt: new Date().toISOString() } : ann,
      ),
    )

    try {
      const res = await fetch('/api/annotations', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(a),
      })
      const d: { annotation: LineAnnotation } = await res.json()
      setAnnotations(prev =>
        prev.map(ann => (ann.id === d.annotation.id ? d.annotation : ann)),
      )
    } catch {
      // Fetch fresh state on error
      if (a.filePath) {
        fetch(`/api/annotations?filePath=${encodeURIComponent(a.filePath)}`)
          .then(r => r.json())
          .then((d: { annotations: LineAnnotation[] }) => {
            setAnnotations(d.annotations ?? [])
          })
          .catch(() => {})
      }
    }
  }, [])

  const removeAnnotation = useCallback(async (id: string) => {
    // Optimistic remove
    setAnnotations(prev => prev.filter(ann => ann.id !== id))

    try {
      await fetch(`/api/annotations?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
      })
    } catch {
      // If deletion fails, we can't easily rollback without keeping a snapshot.
      // Re-fetch annotations for the current filePath is handled by the caller if needed.
    }
  }, [])

  return {
    annotations,
    addAnnotation,
    updateAnnotation,
    removeAnnotation,
    loading,
  }
}
