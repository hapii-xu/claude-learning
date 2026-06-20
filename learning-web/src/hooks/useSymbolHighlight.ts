import { useCallback } from 'react'
import type { SymbolInfo } from '@/data/types'
import type { SymbolStatus } from './useLearningProgress'

/**
 * Hook to post-process Shiki HTML and add data attributes to symbol names
 * for hover/click detection and visual indicators
 */
export function useSymbolHighlight() {
  const highlightSymbols = useCallback(
    (
      codeElement: HTMLElement | null,
      symbols: SymbolInfo[],
      symbolStatusMap: Map<string, SymbolStatus>,
    ) => {
      if (!codeElement || symbols.length === 0) return

      // Find all .line spans (Shiki renders each line as a span with class "line")
      const lineSpans = codeElement.querySelectorAll('span.line')

      symbols.forEach(symbol => {
        const lineIndex = symbol.line - 1 // 0-based index
        if (lineIndex >= lineSpans.length) return

        const lineSpan = lineSpans[lineIndex]
        if (!lineSpan) return

        // Find child spans whose textContent matches the symbol name
        const childSpans = lineSpan.querySelectorAll('span')
        childSpans.forEach(span => {
          const text = span.textContent || ''
          // Check if this span contains the symbol name (word boundary match)
          const regex = new RegExp(`\\b${escapeRegExp(symbol.name)}\\b`)
          if (regex.test(text)) {
            // Add data attributes for symbol detection
            span.setAttribute('data-symbol-name', symbol.name)
            span.setAttribute('data-symbol-kind', symbol.kind)
            span.setAttribute('data-symbol-line', String(symbol.line))

            // Add class for cursor styling
            span.classList.add('symbol-marker')

            // Add status-based styling
            const status = symbolStatusMap.get(symbol.name) || 'unstudied'
            span.setAttribute('data-symbol-status', status)
          }
        })
      })
    },
    [],
  )

  return highlightSymbols
}

// Helper to escape regex special characters
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
