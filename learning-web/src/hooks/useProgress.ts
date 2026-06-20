import { useState, useCallback, useEffect } from 'react'

const STORAGE_KEY = 'claude-code-learning-progress'

interface ProgressData {
  completedModules: string[]
  lastVisited: Record<string, number> // moduleId → timestamp
}

function loadProgress(): ProgressData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch {
    // ignore
  }
  return { completedModules: [], lastVisited: {} }
}

function saveProgress(data: ProgressData) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  } catch {
    // ignore
  }
}

export function useProgress() {
  const [progress, setProgress] = useState<ProgressData>(loadProgress)

  const toggleModule = useCallback((moduleId: string) => {
    setProgress(prev => {
      const completed = prev.completedModules.includes(moduleId)
        ? prev.completedModules.filter(id => id !== moduleId)
        : [...prev.completedModules, moduleId]
      const next = { ...prev, completedModules: completed }
      saveProgress(next)
      return next
    })
  }, [])

  const markVisited = useCallback((moduleId: string) => {
    setProgress(prev => {
      const next = {
        ...prev,
        lastVisited: { ...prev.lastVisited, [moduleId]: Date.now() },
      }
      saveProgress(next)
      return next
    })
  }, [])

  const isCompleted = useCallback(
    (moduleId: string) => progress.completedModules.includes(moduleId),
    [progress.completedModules],
  )

  const resetProgress = useCallback(() => {
    const empty: ProgressData = { completedModules: [], lastVisited: {} }
    setProgress(empty)
    saveProgress(empty)
  }, [])

  const exportProgress = useCallback(() => {
    const data = {
      version: 1,
      exportedAt: new Date().toISOString(),
      ...progress,
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `claude-code-learning-progress-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }, [progress])

  const importProgress = useCallback((json: string) => {
    try {
      const parsed = JSON.parse(json)
      if (!parsed.completedModules || !Array.isArray(parsed.completedModules)) {
        throw new Error('Invalid progress data')
      }
      const data: ProgressData = {
        completedModules: parsed.completedModules,
        lastVisited: parsed.lastVisited || {},
      }
      setProgress(data)
      saveProgress(data)
      return true
    } catch {
      return false
    }
  }, [])

  return {
    progress,
    toggleModule,
    markVisited,
    isCompleted,
    resetProgress,
    exportProgress,
    importProgress,
    completedCount: progress.completedModules.length,
  }
}
