import { useEffect, useRef, useState } from 'react'
import { fetchSymbols } from '@/lib/api'
import type { SymbolsApiResponse, SymbolInfo } from '@/data/types'

interface UseSymbolsResult {
  symbols: SymbolInfo[]
  loading: boolean
  error: string | null
  refetch: () => void
}

export function useSymbols(filePath: string | null): UseSymbolsResult {
  const [data, setData] = useState<SymbolsApiResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const load = async () => {
    if (!filePath) {
      setData(null)
      setLoading(false)
      return
    }

    abortRef.current?.abort()
    abortRef.current = new AbortController()

    setLoading(true)
    setError(null)

    try {
      const result = await fetchSymbols(filePath)
      setData(result)
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        setError(err instanceof Error ? err.message : 'Unknown error')
      }
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    return () => {
      abortRef.current?.abort()
    }
  }, [filePath])

  return {
    symbols: data?.symbols ?? [],
    loading,
    error,
    refetch: load,
  }
}
