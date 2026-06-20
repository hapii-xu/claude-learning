import { feature } from 'bun:bundle'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  getModeFromInput,
  getValueFromInput,
} from '../components/PromptInput/inputModes.js'
import { makeHistoryReader } from '../history.js'
import { KeyboardEvent, useInput } from '@anthropic/ink'
// 向后兼容桥接，直到使用者将 handleKeyDown 连接到 <Box onKeyDown>
import { useKeybinding, useKeybindings } from '../keybindings/useKeybinding.js'
import type { PromptInputMode } from '../types/textInputTypes.js'
import type { HistoryEntry } from '../utils/config.js'

export function useHistorySearch(
  onAcceptHistory: (entry: HistoryEntry) => void,
  currentInput: string,
  onInputChange: (input: string) => void,
  onCursorChange: (cursorOffset: number) => void,
  currentCursorOffset: number,
  onModeChange: (mode: PromptInputMode) => void,
  currentMode: PromptInputMode,
  isSearching: boolean,
  setIsSearching: (isSearching: boolean) => void,
  setPastedContents: (pastedContents: HistoryEntry['pastedContents']) => void,
  currentPastedContents: HistoryEntry['pastedContents'],
): {
  historyQuery: string
  setHistoryQuery: (query: string) => void
  historyMatch: HistoryEntry | undefined
  historyFailedMatch: boolean
  handleKeyDown: (e: KeyboardEvent) => void
} {
  const [historyQuery, setHistoryQuery] = useState('')
  const [historyFailedMatch, setHistoryFailedMatch] = useState(false)
  const [originalInput, setOriginalInput] = useState('')
  const [originalCursorOffset, setOriginalCursorOffset] = useState(0)
  const [originalMode, setOriginalMode] = useState<PromptInputMode>('prompt')
  const [originalPastedContents, setOriginalPastedContents] = useState<
    HistoryEntry['pastedContents']
  >({})
  const [historyMatch, setHistoryMatch] = useState<HistoryEntry | undefined>(
    undefined,
  )
  const historyReader = useRef<AsyncGenerator<HistoryEntry> | undefined>(
    undefined,
  )
  const seenPrompts = useRef<Set<string>>(new Set())
  const searchAbortController = useRef<AbortController | null>(null)

  const closeHistoryReader = useCallback((): void => {
    if (historyReader.current) {
      // 必须显式调用 .return() 以触发 readLinesReverse 中的 finally 块，
      // 它关闭文件句柄。没有这个，文件描述符会泄漏。
      void historyReader.current.return(undefined)
      historyReader.current = undefined
    }
  }, [])

  const reset = useCallback((): void => {
    setIsSearching(false)
    setHistoryQuery('')
    setHistoryFailedMatch(false)
    setOriginalInput('')
    setOriginalCursorOffset(0)
    setOriginalMode('prompt')
    setOriginalPastedContents({})
    setHistoryMatch(undefined)
    closeHistoryReader()
    seenPrompts.current.clear()
  }, [setIsSearching, closeHistoryReader])

  const searchHistory = useCallback(
    async (resume: boolean, signal?: AbortSignal): Promise<void> => {
      if (!isSearching) {
        return
      }

      if (historyQuery.length === 0) {
        closeHistoryReader()
        seenPrompts.current.clear()
        setHistoryMatch(undefined)
        setHistoryFailedMatch(false)
        onInputChange(originalInput)
        onCursorChange(originalCursorOffset)
        onModeChange(originalMode)
        setPastedContents(originalPastedContents)
        return
      }

      if (!resume) {
        closeHistoryReader()
        historyReader.current = makeHistoryReader()
        seenPrompts.current.clear()
      }

      if (!historyReader.current) {
        return
      }

      while (true) {
        if (signal?.aborted) {
          return
        }

        const item = await historyReader.current.next()
        if (item.done) {
          // 未找到匹配 —— 保留上次匹配但标记为失败
          setHistoryFailedMatch(true)
          return
        }

        const display = item.value.display

        const matchPosition = display.lastIndexOf(historyQuery)
        if (matchPosition !== -1 && !seenPrompts.current.has(display)) {
          seenPrompts.current.add(display)
          setHistoryMatch(item.value)
          setHistoryFailedMatch(false)
          const mode = getModeFromInput(display)
          onModeChange(mode)
          onInputChange(display)
          setPastedContents(item.value.pastedContents)

          // 相对于干净值定位光标，而不是显示
          const value = getValueFromInput(display)
          const cleanMatchPosition = value.lastIndexOf(historyQuery)
          onCursorChange(
            cleanMatchPosition !== -1 ? cleanMatchPosition : matchPosition,
          )
          return
        }
      }
    },
    [
      isSearching,
      historyQuery,
      closeHistoryReader,
      onInputChange,
      onCursorChange,
      onModeChange,
      setPastedContents,
      originalInput,
      originalCursorOffset,
      originalMode,
      originalPastedContents,
    ],
  )

  // 处理器：开始历史搜索（未搜索时）
  const handleStartSearch = useCallback(() => {
    setIsSearching(true)
    setOriginalInput(currentInput)
    setOriginalCursorOffset(currentCursorOffset)
    setOriginalMode(currentMode)
    setOriginalPastedContents(currentPastedContents)
    historyReader.current = makeHistoryReader()
    seenPrompts.current.clear()
  }, [
    setIsSearching,
    currentInput,
    currentCursorOffset,
    currentMode,
    currentPastedContents,
  ])

  // 处理器：查找下一个匹配（搜索时）
  const handleNextMatch = useCallback(() => {
    void searchHistory(true)
  }, [searchHistory])

  // 处理器：接受当前匹配并退出搜索
  const handleAccept = useCallback(() => {
    if (historyMatch) {
      const mode = getModeFromInput(historyMatch.display)
      const value = getValueFromInput(historyMatch.display)
      onInputChange(value)
      onModeChange(mode)
      setPastedContents(historyMatch.pastedContents)
    } else {
      // 无匹配 —— 恢复原始粘贴内容
      setPastedContents(originalPastedContents)
    }
    reset()
  }, [
    historyMatch,
    onInputChange,
    onModeChange,
    setPastedContents,
    originalPastedContents,
    reset,
  ])

  // 处理器：取消搜索并恢复原始输入
  const handleCancel = useCallback(() => {
    onInputChange(originalInput)
    onCursorChange(originalCursorOffset)
    setPastedContents(originalPastedContents)
    reset()
  }, [
    onInputChange,
    onCursorChange,
    setPastedContents,
    originalInput,
    originalCursorOffset,
    originalPastedContents,
    reset,
  ])

  // 处理器：执行（接受并提交）
  const handleExecute = useCallback(() => {
    if (historyQuery.length === 0) {
      onAcceptHistory({
        display: originalInput,
        pastedContents: originalPastedContents,
      })
    } else if (historyMatch) {
      const mode = getModeFromInput(historyMatch.display)
      const value = getValueFromInput(historyMatch.display)
      onModeChange(mode)
      onAcceptHistory({
        display: value,
        pastedContents: historyMatch.pastedContents,
      })
    }
    reset()
  }, [
    historyQuery,
    historyMatch,
    onAcceptHistory,
    onModeChange,
    originalInput,
    originalPastedContents,
    reset,
  ])

  // 在 HISTORY_PICKER 下被门控关闭 —— 模态对话框在那里拥有 ctrl+r。
  useKeybinding('history:search', handleStartSearch, {
    context: 'Global',
    isActive: feature('HISTORY_PICKER') ? false : !isSearching,
  })

  // 历史搜索上下文快捷键（仅在搜索时活动）
  const historySearchHandlers = useMemo(
    () => ({
      'historySearch:next': handleNextMatch,
      'historySearch:accept': handleAccept,
      'historySearch:cancel': handleCancel,
      'historySearch:execute': handleExecute,
    }),
    [handleNextMatch, handleAccept, handleCancel, handleExecute],
  )

  useKeybindings(historySearchHandlers, {
    context: 'HistorySearch',
    isActive: isSearching,
  })

  // 当查询为空时处理退格（取消搜索）
  // 这是不适合快捷键模型的条件行为
  // （退格仅在查询为空时取消）
  const handleKeyDown = (e: KeyboardEvent): void => {
    if (!isSearching) return
    if (e.key === 'backspace' && historyQuery === '') {
      e.preventDefault()
      handleCancel()
    }
  }

  // 向后兼容桥接：PromptInput 尚未将 handleKeyDown 连接到
  // <Box onKeyDown>。通过 useInput 订阅并适配 InputEvent →
  // KeyboardEvent 直到使用者迁移（单独的 PR）。
  // TODO(onKeyDown-migration)：一旦 PromptInput 传递 handleKeyDown 则移除。
  useInput(
    (_input, _key, event) => {
      handleKeyDown(new KeyboardEvent(event.keypress))
    },
    { isActive: isSearching },
  )

  // 保留对 searchHistory 的 ref 以避免它成为 useEffect 的依赖
  const searchHistoryRef = useRef(searchHistory)
  searchHistoryRef.current = searchHistory

  // 当查询更改时重置历史搜索
  useEffect(() => {
    searchAbortController.current?.abort()
    const controller = new AbortController()
    searchAbortController.current = controller
    void searchHistoryRef.current(false, controller.signal)
    return () => {
      controller.abort()
    }
  }, [historyQuery])

  return {
    historyQuery,
    setHistoryQuery,
    historyMatch,
    historyFailedMatch,
    handleKeyDown,
  }
}
