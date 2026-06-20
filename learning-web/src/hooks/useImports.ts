import { useEffect, useRef, useState } from 'react'
import { fetchImports } from '@/lib/api'
import type {
  ImportsApiResponse,
  ImportEntry,
  ImportedByEntry,
} from '@/data/types'

interface UseImportsResult {
  imports: ImportEntry[]
  importedBy: ImportedByEntry[]
  loading: boolean
  error: string | null
  refetch: () => void
}

export function useImports(filePath: string | null): UseImportsResult {
  const [data, setData] = useState<ImportsApiResponse | null>(null)
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
      const result = await fetchImports(filePath)
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
    imports: data?.imports ?? [],
    importedBy: data?.importedBy ?? [],
    loading,
    error,
    refetch: load,
  }
}
