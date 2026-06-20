import { useState, useCallback } from 'react'
import { fetchReferences } from '@/lib/api'
import type {
  ReferencesApiResponse,
  ReferenceLocation,
  CalleeInfo,
} from '@/data/types'

interface UseReferencesResult {
  callers: ReferenceLocation[]
  callees: CalleeInfo[]
  loading: boolean
  error: string | null
  selectedSymbol: string | null
  loadReferences: (filePath: string, symbol: string) => void
  clear: () => void
}

export function useReferences(): UseReferencesResult {
  const [data, setData] = useState<ReferencesApiResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null)

  const loadReferences = useCallback(
    async (filePath: string, symbol: string) => {
      setSelectedSymbol(symbol)
      setLoading(true)
      setError(null)

      try {
        const result = await fetchReferences(filePath, symbol)
        setData(result)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error')
        setData(null)
      } finally {
        setLoading(false)
      }
    },
    [],
  )

  const clear = useCallback(() => {
    setData(null)
    setSelectedSymbol(null)
    setError(null)
  }, [])

  return {
    callers: data?.callers ?? [],
    callees: data?.callees ?? [],
    loading,
    error,
    selectedSymbol,
    loadReferences,
    clear,
  }
}
