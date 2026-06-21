// 自定义 Ink JSX 元素的类型声明
// 注意：详细的 prop 类型在 ink-jsx.d.ts 中通过 React 模块扩展定义。
// 本文件提供全局 JSX 命名空间的兜底声明。
import type { ReactNode, Ref } from 'react'
import type {
  ClickEvent,
  FocusEvent,
  KeyboardEvent,
  Styles,
  TextStyles,
  DOMElement,
} from '@anthropic/ink'

declare global {
  namespace JSX {
    interface IntrinsicElements {
      'ink-box': {
        ref?: Ref<DOMElement>
        tabIndex?: number
        autoFocus?: boolean
        onClick?: (event: ClickEvent) => void
        onFocus?: (event: FocusEvent) => void
        onFocusCapture?: (event: FocusEvent) => void
        onBlur?: (event: FocusEvent) => void
        onBlurCapture?: (event: FocusEvent) => void
        onMouseEnter?: () => void
        onMouseLeave?: () => void
        onKeyDown?: (event: KeyboardEvent) => void
        onKeyDownCapture?: (event: KeyboardEvent) => void
        style?: Styles
        stickyScroll?: boolean
        children?: ReactNode
      }
      'ink-text': {
        style?: Styles
        textStyles?: TextStyles
        children?: ReactNode
      }
      'ink-link': {
        href?: string
        children?: ReactNode
      }
      'ink-raw-ansi': {
        rawText?: string
        rawWidth?: number
        rawHeight?: number
      }
    }
  }
}

export {}
