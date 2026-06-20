import { useState, useEffect, useCallback } from 'react'
import { fetchFile } from '@/lib/api'
import type { FileApiResponse } from '@/data/types'

interface UseFileContentResult {
  data: FileApiResponse | null
  loading: boolean
  error: string | null
  refetch: () => void
}

export function useFileContent(filePath: string | null): UseFileContentResult {
  const [data, setData] = useState<FileApiResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetch = useCallback(async () => {
    if (!filePath) {
      setData(null)
      setLoading(false)
      setError(null)
      return
    }

    setData(null)
    setLoading(true)
    setError(null)

    try {
      const result = await fetchFile(filePath)
      setData(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [filePath])

  useEffect(() => {
    fetch()
  }, [fetch])

  return { data, loading, error, refetch: fetch }
}
