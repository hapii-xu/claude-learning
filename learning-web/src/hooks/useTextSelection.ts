import { useCallback, useEffect, useRef } from 'react'

export interface TextSelectionState {
  active: boolean
  rect: DOMRect | null
  range: Range | null
}

export type SelectionCallback = (rect: DOMRect, range: Range) => void
export type ClearCallback = () => void

/**
 * Fires onSelect on every mouseup where a non-collapsed selection exists inside containerRef.
 * Fires onClear when the user clicks outside the container (mouseup with no valid selection).
 *
 * Deliberately does NOT listen to selectionchange — that event fires on every focus shift,
 * autoFocus, portal mount, and DOM mutation, which would incorrectly dismiss the annotation
 * toolbar/popover while the user is actively interacting with them.
 *
 * "User cancelled" is inferred exclusively from mouseup with a collapsed/out-of-container
 * selection, and from Escape handled by the toolbar/popover themselves.
 */
export function useTextSelection(
  containerRef: React.RefObject<HTMLElement | null>,
  onSelect: SelectionCallback,
  onClear: ClearCallback,
) {
  const onSelectRef = useRef(onSelect)
  const onClearRef = useRef(onClear)
  onSelectRef.current = onSelect
  onClearRef.current = onClear

  const check = useCallback(() => {
    // If focus is inside annotation UI (toolbar/popover portal), the native selection
    // may have been disturbed by autoFocus or button clicks — ignore those events.
    const ae = document.activeElement
    if (ae && ae.closest('[data-annot-ui]')) return

    const sel = window.getSelection()
    const container = containerRef.current
    if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !container) {
      onClearRef.current()
      return
    }
    const range = sel.getRangeAt(0)
    if (!container.contains(range.commonAncestorContainer)) {
      onClearRef.current()
      return
    }
    const rect = range.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) {
      onClearRef.current()
      return
    }
    onSelectRef.current(rect, range)
  }, [containerRef])

  // Activate on mouseup — selection is finalized at this point.
  // If the mouseup was a plain click (collapsed selection) on an existing
  // annotation span, skip check() so the user's previous selection ghost
  // survives opening the annotation editor.
  useEffect(() => {
    const onMouseUp = (e: MouseEvent) => {
      setTimeout(() => {
        const sel = window.getSelection()
        const collapsed = !sel || sel.isCollapsed || sel.rangeCount === 0
        if (collapsed) {
          const target = e.target as Element | null
          if (target?.closest?.('[data-annotation-id]')) return
        }
        check()
      }, 0)
    }
    document.addEventListener('mouseup', onMouseUp)
    return () => document.removeEventListener('mouseup', onMouseUp)
  }, [check])

  // Activate on dblclick — browser finalizes word selection before firing dblclick,
  // so this is more reliable than relying solely on the second mouseup timing
  useEffect(() => {
    const onDblClick = () => setTimeout(check, 0)
    document.addEventListener('dblclick', onDblClick)
    return () => document.removeEventListener('dblclick', onDblClick)
  }, [check])
}
