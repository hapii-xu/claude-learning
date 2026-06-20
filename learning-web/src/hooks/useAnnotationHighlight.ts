import { useCallback } from 'react'
import type { AnnotationStyles, LineAnnotation } from '@/data/types'

const COLOR_CLASS: Record<string, string> = {
  yellow: 'bg-yellow-300/40',
  red: 'bg-red-300/40',
  blue: 'bg-blue-400/30',
  green: 'bg-green-300/40',
}

function stylesToClasses(styles?: AnnotationStyles): string {
  if (!styles) return ''
  const out: string[] = []
  if (styles.bold) out.push('font-bold')
  if (styles.italic) out.push('italic')
  if (styles.underline) out.push('underline decoration-current')
  if (styles.strikethrough) out.push('line-through')
  return out.join(' ')
}

interface Segment {
  start: number
  end: number
  colorClass: string
  styleClass: string
  annotationId: string
  hasComment: boolean
  commentPreview: string
}

function computeSegments(
  lineIndex: number,
  annotations: LineAnnotation[],
  lineLen: number,
): Segment[] {
  const lineNum = lineIndex + 1

  const relevant = annotations.filter(
    a =>
      a.startCol !== undefined &&
      a.endCol !== undefined &&
      a.startLine <= lineNum &&
      a.endLine >= lineNum,
  )
  if (relevant.length === 0) return []

  const intervals = relevant.map(a => {
    const start = a.startLine === lineNum ? (a.startCol ?? 0) : 0
    const end = a.endLine === lineNum ? (a.endCol ?? lineLen) : lineLen
    return { start, end, annotation: a }
  })

  const points = new Set<number>([0, lineLen])
  for (const { start, end } of intervals) {
    points.add(start)
    points.add(end)
  }
  const sorted = Array.from(points).sort((a, b) => a - b)

  const segments: Segment[] = []
  for (let i = 0; i < sorted.length - 1; i++) {
    const segStart = sorted[i]
    const segEnd = sorted[i + 1]
    if (segStart >= segEnd) continue

    const covering = intervals.filter(
      ({ start, end }) => start <= segStart && end >= segEnd,
    )
    if (covering.length === 0) continue

    covering.sort((a, b) =>
      b.annotation.updatedAt.localeCompare(a.annotation.updatedAt),
    )
    const primary = covering[0].annotation
    const mergedStyles: AnnotationStyles = {}
    for (const { annotation: a } of covering) {
      if (a.styles?.bold) mergedStyles.bold = true
      if (a.styles?.italic) mergedStyles.italic = true
      if (a.styles?.underline) mergedStyles.underline = true
      if (a.styles?.strikethrough) mergedStyles.strikethrough = true
    }

    const hasComment = !!(primary.comment && primary.comment.trim().length > 0)

    segments.push({
      start: segStart,
      end: segEnd,
      colorClass: COLOR_CLASS[primary.color] ?? COLOR_CLASS.yellow,
      styleClass: stylesToClasses(mergedStyles),
      annotationId: primary.id,
      hasComment,
      commentPreview: hasComment ? primary.comment : '',
    })
  }

  return segments
}

/** Unwrap any previously injected annot spans on a line, restoring plain text nodes. */
function unwrapSegments(lineSpan: Element) {
  const wrappers = lineSpan.querySelectorAll('span[data-annot-segment="1"]')
  for (const w of Array.from(wrappers)) {
    const parent = w.parentNode
    if (!parent) continue
    while (w.firstChild) parent.insertBefore(w.firstChild, w)
    parent.removeChild(w)
  }
  // Merge adjacent text nodes so the TreeWalker sees the original structure.
  lineSpan.normalize()
}

/**
 * Post-processes a Shiki container element to render range annotations
 * as inline highlighted spans. Call this in a useEffect after Shiki renders.
 *
 * Idempotent: computes a content hash per line and skips re-mutation if the
 * segments haven't changed, preventing adjacent regions from being disturbed
 * when unrelated annotations are added/removed.
 */
export function useAnnotationHighlight() {
  return useCallback(
    (container: HTMLElement | null, annotations: LineAnnotation[]) => {
      if (!container) return

      const rangeAnnotations = annotations.filter(
        a => a.startCol !== undefined && a.endCol !== undefined,
      )

      const lineSpans = Array.from(container.querySelectorAll('span.line'))

      lineSpans.forEach((lineSpan, lineIndex) => {
        const lineEl = lineSpan as HTMLElement
        const lineText = lineSpan.textContent ?? ''
        const segments = computeSegments(
          lineIndex,
          rangeAnnotations,
          lineText.length,
        )

        // Build a stable hash of the segments to skip no-op DOM mutations.
        const hash =
          segments.length === 0
            ? ''
            : segments
                .map(
                  s =>
                    `${s.start}-${s.end}-${s.annotationId}-${s.colorClass}-${s.styleClass}-${s.hasComment}`,
                )
                .join('|')

        const prevHash = lineEl.dataset.annotHash ?? null

        if (prevHash === hash) return // segments unchanged — no DOM mutation needed

        // Hash changed: restore original text nodes first, then re-inject.
        unwrapSegments(lineSpan)
        lineEl.dataset.annotHash = hash

        if (segments.length === 0) return

        // Re-read text nodes after unwrap+normalize.
        const textNodes: Text[] = []
        const walker = document.createTreeWalker(lineSpan, NodeFilter.SHOW_TEXT)
        while (walker.nextNode()) textNodes.push(walker.currentNode as Text)

        // Identify the last segment per annotationId so we can mark it for
        // the trailing-dot CSS rule.
        const lastSegIndexByAnnotId = new Map<string, number>()
        segments.forEach((s, idx) => {
          lastSegIndexByAnnotId.set(s.annotationId, idx)
        })

        let charOffset = 0
        for (const textNode of textNodes) {
          const nodeText = textNode.textContent ?? ''
          const nodeStart = charOffset
          const nodeEnd = charOffset + nodeText.length
          charOffset = nodeEnd

          const overlapping = segments.filter(
            s => s.start < nodeEnd && s.end > nodeStart,
          )
          if (overlapping.length === 0) continue

          const splitPoints = new Set<number>([0, nodeText.length])
          for (const seg of overlapping) {
            const localStart = Math.max(0, seg.start - nodeStart)
            const localEnd = Math.min(nodeText.length, seg.end - nodeStart)
            splitPoints.add(localStart)
            splitPoints.add(localEnd)
          }
          const sorted = Array.from(splitPoints).sort((a, b) => a - b)

          const frag = document.createDocumentFragment()
          for (let i = 0; i < sorted.length - 1; i++) {
            const segLocalStart = sorted[i]
            const segLocalEnd = sorted[i + 1]
            const piece = nodeText.slice(segLocalStart, segLocalEnd)
            if (!piece) continue

            const globalStart = nodeStart + segLocalStart
            const globalEnd = nodeStart + segLocalEnd

            const covering = segments.find(
              s => s.start <= globalStart && s.end >= globalEnd,
            )
            if (covering) {
              const span = document.createElement('span')
              const classes = [
                'annot',
                covering.colorClass,
                covering.styleClass,
              ]
              if (covering.hasComment) {
                classes.push('annot-with-comment')
                // Mark only the last segment of this annotation for the tail dot.
                const coveringIdx = segments.indexOf(covering)
                if (
                  coveringIdx ===
                  lastSegIndexByAnnotId.get(covering.annotationId)
                ) {
                  classes.push('annot-tail')
                }
              }
              span.className = classes.filter(Boolean).join(' ')
              span.setAttribute('data-annotation-id', covering.annotationId)
              span.setAttribute('data-annot-segment', '1')
              if (covering.hasComment) {
                span.setAttribute('data-has-comment', '1')
                span.title = covering.commentPreview
              }
              span.textContent = piece
              frag.appendChild(span)
            } else {
              frag.appendChild(document.createTextNode(piece))
            }
          }

          textNode.parentNode?.replaceChild(frag, textNode)
        }
      })
    },
    [],
  )
}
