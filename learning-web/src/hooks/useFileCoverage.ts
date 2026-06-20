import { useState, useEffect } from 'react'
import type { FileCoverageEntry } from '@/data/types'

type CoverageMap = Record<string, FileCoverageEntry>

// Module-level cache with TTL
let cachedData: CoverageMap | null = null
let cacheTimestamp = 0
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

// Pending promise to avoid duplicate in-flight requests
let pendingFetch: Promise<CoverageMap> | null = null

async function fetchCoverage(): Promise<CoverageMap> {
  if (pendingFetch) return pendingFetch

  pendingFetch = fetch('/api/progress/file-coverage')
    .then(r => r.json())
    .then((d: { coverage: CoverageMap }) => {
      cachedData = d.coverage ?? {}
      cacheTimestamp = Date.now()
      return cachedData
    })
    .catch(() => {
      return cachedData ?? {}
    })
    .finally(() => {
      pendingFetch = null
    })

  return pendingFetch
}

export function useFileCoverage(): CoverageMap {
  const [coverage, setCoverage] = useState<CoverageMap>(() => {
    if (cachedData && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
      return cachedData
    }
    return {}
  })

  useEffect(() => {
    // If cache is still valid, no need to fetch
    if (cachedData && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
      setCoverage(cachedData)
      return
    }

    let cancelled = false
    fetchCoverage().then(data => {
      if (!cancelled) setCoverage(data)
    })

    return () => {
      cancelled = true
    }
  }, [])

  return coverage
}
