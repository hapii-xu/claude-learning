import { useCallback, useState } from 'react'
import { KeyboardEvent, useInput } from '@anthropic/ink'
// 向后兼容桥接，直到消费者将 handleKeyDown 连接到 <Box onKeyDown>
import {
  Cursor,
  getLastKill,
  pushToKillRing,
  recordYank,
  resetKillAccumulation,
  resetYankState,
  updateYankLength,
  yankPop,
} from '../utils/Cursor.js'
import { useTerminalSize } from './useTerminalSize.js'

type UseSearchInputOptions = {
  isActive: boolean
  onExit: () => void
  /** Esc + Ctrl+C 放弃（不同于 onExit = Enter 提交）。提供时：
   *  单次 Esc 直接调用此函数（无先清除再退出的
   *  双击）。未提供时：当前行为 —— Esc 清除非空
   *  查询，空时退出；Ctrl+C 静默吞掉（无 switch case）。 */
  onCancel?: () => void
  onExitUp?: () => void
  columns?: number
  passthroughCtrlKeys?: string[]
  initialQuery?: string
  /** 空查询上的 Backspace（和 ctrl+h）调用 onCancel ?? onExit ——
   *  less/vim "delete past the /" 约定。想要仅 Esc
   *  取消的对话框将此设为 false，使按住的 backspace 不会弹出用户。 */
  backspaceExitsOnEmpty?: boolean
}

type UseSearchInputReturn = {
  query: string
  setQuery: (q: string) => void
  cursorOffset: number
  handleKeyDown: (e: KeyboardEvent) => void
}

function isKillKey(e: KeyboardEvent): boolean {
  if (e.ctrl && (e.key === 'k' || e.key === 'u' || e.key === 'w')) {
    return true
  }
  if (e.meta && e.key === 'backspace') {
    return true
  }
  return false
}

function isYankKey(e: KeyboardEvent): boolean {
  return (e.ctrl || e.meta) && e.key === 'y'
}

// 穿过文本输入分支上方显式处理程序的特殊键名
// （return/escape/arrows/home/end/tab/backspace/delete
// 都提前返回）。拒绝这些键，使例如 PageUp 不会将 'pageup'
// 作为字面文本泄漏。下方的 length>=1 检查故意宽松 ——
// 批量输入如 stdin.write('abc') 作为单个多字符 e.key 到达，
// 匹配旧的 useInput(input) 行为，其中 cursor.insert(input)
// 插入完整块。
const UNHANDLED_SPECIAL_KEYS = new Set([
  'pageup',
  'pagedown',
  'insert',
  'wheelup',
  'wheeldown',
  'mouse',
  'f1',
  'f2',
  'f3',
  'f4',
  'f5',
  'f6',
  'f7',
  'f8',
  'f9',
  'f10',
  'f11',
  'f12',
])

export function useSearchInput({
  isActive,
  onExit,
  onCancel,
  onExitUp,
  columns,
  passthroughCtrlKeys = [],
  initialQuery = '',
  backspaceExitsOnEmpty = true,
}: UseSearchInputOptions): UseSearchInputReturn {
  const { columns: terminalColumns } = useTerminalSize()
  const effectiveColumns = columns ?? terminalColumns
  const [query, setQueryState] = useState(initialQuery)
  const [cursorOffset, setCursorOffset] = useState(initialQuery.length)

  const setQuery = useCallback((q: string) => {
    setQueryState(q)
    setCursorOffset(q.length)
  }, [])

  const handleKeyDown = (e: KeyboardEvent): void => {
    if (!isActive) return

    const cursor = Cursor.fromText(query, effectiveColumns, cursorOffset)

    // Check passthrough ctrl keys
    if (e.ctrl && passthroughCtrlKeys.includes(e.key.toLowerCase())) {
      return
    }

    // Reset kill accumulation for non-kill keys
    if (!isKillKey(e)) {
      resetKillAccumulation()
    }

    // Reset yank state for non-yank keys
    if (!isYankKey(e)) {
      resetYankState()
    }

    // Exit conditions
    if (e.key === 'return' || e.key === 'down') {
      e.preventDefault()
      onExit()
      return
    }
    if (e.key === 'up') {
      e.preventDefault()
      if (onExitUp) {
        onExitUp()
      }
      return
    }
    if (e.key === 'escape') {
      e.preventDefault()
      if (onCancel) {
        onCancel()
      } else if (query.length > 0) {
        setQueryState('')
        setCursorOffset(0)
      } else {
        onExit()
      }
      return
    }

    // Backspace/Delete
    if (e.key === 'backspace') {
      e.preventDefault()
      if (e.meta) {
        // Meta+Backspace: kill word before
        const { cursor: newCursor, killed } = cursor.deleteWordBefore()
        pushToKillRing(killed, 'prepend')
        setQueryState(newCursor.text)
        setCursorOffset(newCursor.offset)
        return
      }
      if (query.length === 0) {
        // Backspace past the / — cancel (clear + snap back), not commit.
        // less: same. vim: deletes the / and exits command mode.
        if (backspaceExitsOnEmpty) (onCancel ?? onExit)()
        return
      }
      const newCursor = cursor.backspace()
      setQueryState(newCursor.text)
      setCursorOffset(newCursor.offset)
      return
    }

    if (e.key === 'delete') {
      e.preventDefault()
      const newCursor = cursor.del()
      setQueryState(newCursor.text)
      setCursorOffset(newCursor.offset)
      return
    }

    // Arrow keys with modifiers (word jump)
    if (e.key === 'left' && (e.ctrl || e.meta || e.fn)) {
      e.preventDefault()
      const newCursor = cursor.prevWord()
      setCursorOffset(newCursor.offset)
      return
    }
    if (e.key === 'right' && (e.ctrl || e.meta || e.fn)) {
      e.preventDefault()
      const newCursor = cursor.nextWord()
      setCursorOffset(newCursor.offset)
      return
    }

    // Plain arrow keys
    if (e.key === 'left') {
      e.preventDefault()
      const newCursor = cursor.left()
      setCursorOffset(newCursor.offset)
      return
    }
    if (e.key === 'right') {
      e.preventDefault()
      const newCursor = cursor.right()
      setCursorOffset(newCursor.offset)
      return
    }

    // Home/End
    if (e.key === 'home') {
      e.preventDefault()
      setCursorOffset(0)
      return
    }
    if (e.key === 'end') {
      e.preventDefault()
      setCursorOffset(query.length)
      return
    }

    // Ctrl key bindings
    if (e.ctrl) {
      e.preventDefault()
      switch (e.key.toLowerCase()) {
        case 'a':
          setCursorOffset(0)
          return
        case 'e':
          setCursorOffset(query.length)
          return
        case 'b':
          setCursorOffset(cursor.left().offset)
          return
        case 'f':
          setCursorOffset(cursor.right().offset)
          return
        case 'd': {
          if (query.length === 0) {
            ;(onCancel ?? onExit)()
            return
          }
          const newCursor = cursor.del()
          setQueryState(newCursor.text)
          setCursorOffset(newCursor.offset)
          return
        }
        case 'h': {
          if (query.length === 0) {
            if (backspaceExitsOnEmpty) (onCancel ?? onExit)()
            return
          }
          const newCursor = cursor.backspace()
          setQueryState(newCursor.text)
          setCursorOffset(newCursor.offset)
          return
        }
        case 'k': {
          const { cursor: newCursor, killed } = cursor.deleteToLineEnd()
          pushToKillRing(killed, 'append')
          setQueryState(newCursor.text)
          setCursorOffset(newCursor.offset)
          return
        }
        case 'u': {
          const { cursor: newCursor, killed } = cursor.deleteToLineStart()
          pushToKillRing(killed, 'prepend')
          setQueryState(newCursor.text)
          setCursorOffset(newCursor.offset)
          return
        }
        case 'w': {
          const { cursor: newCursor, killed } = cursor.deleteWordBefore()
          pushToKillRing(killed, 'prepend')
          setQueryState(newCursor.text)
          setCursorOffset(newCursor.offset)
          return
        }
        case 'y': {
          const text = getLastKill()
          if (text.length > 0) {
            const startOffset = cursor.offset
            const newCursor = cursor.insert(text)
            recordYank(startOffset, text.length)
            setQueryState(newCursor.text)
            setCursorOffset(newCursor.offset)
          }
          return
        }
        case 'g':
        case 'c':
          // Cancel (abandon search). ctrl+g is less's cancel key. Only
          // fires if onCancel provided — otherwise falls through and
          // returns silently (11 call sites, most expect ctrl+c to no-op).
          if (onCancel) {
            onCancel()
            return
          }
      }
      return
    }

    // Meta key bindings
    if (e.meta) {
      e.preventDefault()
      switch (e.key.toLowerCase()) {
        case 'b':
          setCursorOffset(cursor.prevWord().offset)
          return
        case 'f':
          setCursorOffset(cursor.nextWord().offset)
          return
        case 'd': {
          const newCursor = cursor.deleteWordAfter()
          setQueryState(newCursor.text)
          setCursorOffset(newCursor.offset)
          return
        }
        case 'y': {
          const popResult = yankPop()
          if (popResult) {
            const { text, start, length } = popResult
            const before = query.slice(0, start)
            const after = query.slice(start + length)
            const newText = before + text + after
            const newOffset = start + text.length
            updateYankLength(text.length)
            setQueryState(newText)
            setCursorOffset(newOffset)
          }
          return
        }
      }
      return
    }

    // Tab: ignore
    if (e.key === 'tab') {
      return
    }

    // Regular character input. Accepts multi-char e.key so batched writes
    // (stdin.write('abc') in tests, or paste outside bracketed-paste mode)
    // insert the full chunk — matching the old useInput behavior.
    if (e.key.length >= 1 && !UNHANDLED_SPECIAL_KEYS.has(e.key)) {
      e.preventDefault()
      const newCursor = cursor.insert(e.key)
      setQueryState(newCursor.text)
      setCursorOffset(newCursor.offset)
    }
  }

  // Backward-compat bridge: existing consumers don't yet wire handleKeyDown
  // to <Box onKeyDown>. Subscribe via useInput and adapt InputEvent →
  // KeyboardEvent until all 11 call sites are migrated (separate PRs).
  // TODO(onKeyDown-migration): remove once all consumers pass handleKeyDown.
  useInput(
    (_input, _key, event) => {
      handleKeyDown(new KeyboardEvent(event.keypress))
    },
    { isActive },
  )

  return { query, setQuery, cursorOffset, handleKeyDown }
}
