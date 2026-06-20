import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  parseMermaidSource,
  buildParticipantMap,
  getUpstreamChain,
  getSubsequentChain,
  type ParsedDiagram,
} from '@/lib/mermaidParser'
import { resolveParticipantFile } from '@/lib/resolveParticipantFile'

export type Selection =
  | { type: 'participant'; id: string }
  | { type: 'message'; index: number }

export interface MermaidInteractivity {
  containerRef: React.RefObject<HTMLDivElement | null>
  parsed: ParsedDiagram
  participantMap: Map<string, string>
  selection: Selection | null
  setSelection: (s: Selection | null) => void
  clearSelection: () => void
  /** participant id → resolved file path (or null) */
  fileMap: Map<string, string | null>
  hoveredParticipant: string | null
}

/**
 * 为 mermaid 渲染后的 SVG 添加交互能力
 * - 点击参与者 → 高亮 + 设置 selection
 * - 点击消息箭头 → 高亮 + 设置 selection
 * - 点击空白 → 清除选中
 * - hover 参与者 → hoveredParticipant
 * - Esc 清除选中；←/→ 在消息列表中切换
 */
export function useMermaidInteractivity(
  mermaidSource: string,
  knownFiles: string[],
  svgVersion: number,
): MermaidInteractivity {
  const containerRef = useRef<HTMLDivElement>(null)
  const [selection, setSelectionState] = useState<Selection | null>(null)
  const [hoveredParticipant, setHoveredParticipant] = useState<string | null>(
    null,
  )

  const parsed = useMemo(
    () => parseMermaidSource(mermaidSource),
    [mermaidSource],
  )

  const participantMap = useMemo(
    () => buildParticipantMap(parsed.participants),
    [parsed.participants],
  )

  const fileMap = useMemo(() => {
    const map = new Map<string, string | null>()
    for (const p of parsed.participants) {
      map.set(p.id, resolveParticipantFile(p.displayName, knownFiles))
    }
    return map
  }, [parsed.participants, knownFiles])

  const clearSelection = useCallback(() => setSelectionState(null), [])
  const setSelection = useCallback(
    (s: Selection | null) => setSelectionState(s),
    [],
  )

  // SVG 事件绑定（依赖 svgVersion 触发重绑）
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const svg = container.querySelector('svg')
    if (!svg) return

    svg.classList.add('mermaid-interactive-svg')

    const msgElements = svg.querySelectorAll<SVGElement>('[data-et="message"]')
    const textElements = svg.querySelectorAll<SVGElement>('text.messageText')
    const msgTextMap = new Map<SVGElement, number>()
    msgElements.forEach((el, i) => {
      msgTextMap.set(el, i)
      if (textElements[i]) msgTextMap.set(textElements[i], i)
    })

    const ctrl = new AbortController()
    const { signal } = ctrl

    // 参与者点击 + hover
    svg.querySelectorAll<SVGElement>('[data-et="participant"]').forEach(el => {
      const id = el.getAttribute('data-id')
      if (!id) return
      el.addEventListener(
        'click',
        e => {
          e.stopPropagation()
          setSelectionState({ type: 'participant', id })
        },
        { signal },
      )
      el.addEventListener('mouseenter', () => setHoveredParticipant(id), {
        signal,
      })
      el.addEventListener('mouseleave', () => setHoveredParticipant(null), {
        signal,
      })
    })

    // 消息箭头 + 文本点击
    const allClickable = new Set<SVGElement>()
    msgElements.forEach(el => allClickable.add(el))
    textElements.forEach(el => allClickable.add(el))
    allClickable.forEach(el => {
      const idx = msgTextMap.get(el)
      if (idx === undefined) return
      el.addEventListener(
        'click',
        e => {
          e.stopPropagation()
          setSelectionState({ type: 'message', index: idx })
        },
        { signal },
      )
    })

    svg.addEventListener('click', () => setSelectionState(null), { signal })

    return () => ctrl.abort()
  }, [svgVersion, parsed])

  // 键盘快捷键
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setSelectionState(null)
        return
      }
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        setSelectionState(prev => {
          if (!prev || prev.type !== 'message') return prev
          const count = parsed.messages.length
          if (count === 0) return prev
          const dir = e.key === 'ArrowRight' ? 1 : -1
          const next = (prev.index + dir + count) % count
          return { type: 'message', index: next }
        })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [parsed.messages.length])

  // 选中态 + 上下游链路高亮
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const svg = container.querySelector('svg')
    if (!svg) return

    const clearAll = () => {
      for (const el of svg.querySelectorAll(
        '.participant-selected,.participant-related,.message-selected,.message-related,.message-text-selected,.message-text-related,.chain-upstream,.chain-downstream',
      )) {
        el.classList.remove(
          'participant-selected',
          'participant-related',
          'message-selected',
          'message-related',
          'message-text-selected',
          'message-text-related',
          'chain-upstream',
          'chain-downstream',
        )
      }
      svg.classList.remove('has-selection')
    }

    clearAll()
    if (!selection) return

    svg.classList.add('has-selection')
    const msgEls = svg.querySelectorAll<SVGElement>('[data-et="message"]')
    const textEls = svg.querySelectorAll<SVGElement>('text.messageText')

    function markParticipant(pid: string, cls: string) {
      svg
        ?.querySelector<SVGElement>(
          `[data-et="participant"][data-id="${CSS.escape(pid)}"]`,
        )
        ?.classList.add(cls)
    }

    if (selection.type === 'participant') {
      const { id } = selection
      markParticipant(id, 'participant-selected')

      const relatedIds = new Set<string>([id])
      msgEls.forEach((el, i) => {
        const from = el.getAttribute('data-from')
        const to = el.getAttribute('data-to')
        if (from === id || to === id) {
          el.classList.add('message-related')
          if (from) relatedIds.add(from)
          if (to) relatedIds.add(to)
          if (textEls[i]) textEls[i].classList.add('message-text-related')
        }
      })
      for (const rid of relatedIds) {
        if (rid !== id) markParticipant(rid, 'participant-related')
      }
    } else {
      const { index } = selection
      const msg = parsed.messages[index]
      if (!msg) return

      // Selected message
      msgEls[index]?.classList.add('message-selected')
      if (textEls[index]) textEls[index].classList.add('message-text-selected')
      markParticipant(msg.from, 'participant-selected')
      markParticipant(msg.to, 'participant-selected')

      // Upstream chain (blue)
      for (const m of getUpstreamChain(parsed.messages, index)) {
        msgEls[m.index]?.classList.add('chain-upstream')
        if (textEls[m.index]) textEls[m.index].classList.add('chain-upstream')
        markParticipant(m.from, 'participant-related')
        markParticipant(m.to, 'participant-related')
      }

      // Downstream chain (brand orange)
      for (const m of getSubsequentChain(parsed.messages, index)) {
        msgEls[m.index]?.classList.add('chain-downstream')
        if (textEls[m.index]) textEls[m.index].classList.add('chain-downstream')
        markParticipant(m.from, 'participant-related')
        markParticipant(m.to, 'participant-related')
      }
    }
  }, [selection, parsed.messages])

  return {
    containerRef,
    parsed,
    participantMap,
    selection,
    setSelection,
    clearSelection,
    fileMap,
    hoveredParticipant,
  }
}
