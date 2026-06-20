import { useCallback } from 'react'
import {
  GLOSSARY,
  buildGlossaryRegex,
  findTermByMatch,
  type GlossaryTerm,
} from '@/data/glossary'

/**
 * 返回一个函数：对指定容器内的所有文本节点做术语检测，
 * 把匹配的术语包裹为 <span class="glossary-term" title="定义" data-term="X">
 *
 * 用于 CodeViewer 的 Shiki 输出 DOM 后处理（原生 title tooltip 作为 MVP）
 */
export function useGlossaryHighlight(terms: GlossaryTerm[] = GLOSSARY) {
  return useCallback(
    (container: HTMLElement | null) => {
      if (!container) return

      const regex = buildGlossaryRegex(terms)

      // 第一遍：收集所有包含术语匹配的文本节点
      const textNodes: Text[] = []
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)

      while (walker.nextNode()) {
        const node = walker.currentNode as Text
        const text = node.textContent || ''
        if (regex.test(text)) {
          textNodes.push(node)
        }
        regex.lastIndex = 0
      }

      // 第二遍：对每个文本节点做分割并包裹
      for (const node of textNodes) {
        const text = node.textContent || ''
        const frag = document.createDocumentFragment()
        let lastIndex = 0

        const localRegex = buildGlossaryRegex(terms)
        let match: RegExpExecArray | null

        while ((match = localRegex.exec(text)) !== null) {
          const matched = match[0]
          const term = findTermByMatch(matched, terms)
          if (!term) continue

          // 匹配前的文本
          if (match.index > lastIndex) {
            frag.appendChild(
              document.createTextNode(text.slice(lastIndex, match.index)),
            )
          }

          const span = document.createElement('span')
          span.className = 'glossary-term'
          span.setAttribute('title', term.definition)
          span.setAttribute('data-term', term.term)
          span.textContent = matched
          frag.appendChild(span)

          lastIndex = match.index + matched.length
        }

        // 剩余文本
        if (lastIndex < text.length) {
          frag.appendChild(document.createTextNode(text.slice(lastIndex)))
        }

        node.parentNode?.replaceChild(frag, node)
      }
    },
    [terms],
  )
}
