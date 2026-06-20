import type { CSSProperties } from 'react'
import type { LineAnnotation } from '@/data/types'

export interface AnnotationCoords {
  startLine: number
  startCol: number
  endLine: number
  endCol: number
  selectedText: string
}

/**
 * Given a DOM Range inside a Shiki `.code-viewer.shiki-themes` container,
 * compute (startLine, startCol, endLine, endCol) using the same 1-based line
 * numbering as useSymbolHighlight (index of `span.line` + 1).
 *
 * Columns are 0-based, startCol inclusive, endCol exclusive.
 */
export function rangeToAnnotationCoords(
  range: Range,
  container: HTMLElement,
): AnnotationCoords | null {
  if (!container.contains(range.commonAncestorContainer)) return null

  const lineSpans = Array.from(container.querySelectorAll('span.line'))
  if (lineSpans.length === 0) return null

  const startResult = nodeOffsetInLine(
    range.startContainer,
    range.startOffset,
    lineSpans,
  )
  const endResult = nodeOffsetInLine(
    range.endContainer,
    range.endOffset,
    lineSpans,
  )

  if (!startResult || !endResult) return null

  // Ensure start ≤ end
  if (
    startResult.lineIndex > endResult.lineIndex ||
    (startResult.lineIndex === endResult.lineIndex &&
      startResult.col > endResult.col)
  ) {
    return null
  }

  return {
    startLine: startResult.lineIndex + 1,
    startCol: startResult.col,
    endLine: endResult.lineIndex + 1,
    endCol: endResult.col,
    selectedText: range.toString(),
  }
}

function nodeOffsetInLine(
  node: Node,
  offset: number,
  lineSpans: Element[],
): { lineIndex: number; col: number } | null {
  // Find which .line span contains this node
  const lineIndex = lineSpans.findIndex(span => span.contains(node))
  if (lineIndex === -1) return null

  const lineSpan = lineSpans[lineIndex]
  // Count chars in the line before `node`, up to `offset`
  const col = charOffsetInContainer(lineSpan, node, offset)
  return { lineIndex, col }
}

/**
 * Walk text nodes in `container` up to (and including up to offset in) `targetNode`,
 * return total char count = column.
 */
function charOffsetInContainer(
  container: Element,
  targetNode: Node,
  targetOffset: number,
): number {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  let total = 0

  while (walker.nextNode()) {
    const current = walker.currentNode as Text
    if (current === targetNode) {
      return total + targetOffset
    }
    total += current.length
  }

  // targetNode is not a text node (e.g. element node) — treat as after all text
  return total
}

/**
 * Compute the DOMRect that the floating toolbar should anchor to.
 * Places the toolbar above the anchor rect (or below if too close to top).
 */
export function floatAnchorStyle(
  anchorRect: DOMRect,
  tooltipWidth = 320,
  tooltipHeight = 40,
  margin = 8,
): CSSProperties {
  const vpW = window.innerWidth
  const vpH = window.innerHeight

  let top = anchorRect.top - tooltipHeight - margin
  if (top < margin) {
    top = anchorRect.bottom + margin
  }
  if (top + tooltipHeight > vpH - margin) {
    top = vpH - tooltipHeight - margin
  }

  let left = anchorRect.left + anchorRect.width / 2 - tooltipWidth / 2
  if (left < margin) left = margin
  if (left + tooltipWidth > vpW - margin) left = vpW - tooltipWidth - margin

  return { position: 'fixed', top, left, width: tooltipWidth, zIndex: 60 }
}

/** True when this annotation is a range annotation (not whole-line). */
export function isRangeAnnotation(a: LineAnnotation): boolean {
  return a.startCol !== undefined && a.endCol !== undefined
}
