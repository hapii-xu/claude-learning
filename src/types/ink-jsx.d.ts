/**
 * Ink 自定义 JSX intrinsic elements。
 *
 * 当 "jsx": "react-jsx" 时，TypeScript 从 react/jsx-runtime 解析 JSX 类型，
 * 其 IntrinsicElements 继承自 React.JSX.IntrinsicElements。我们对
 * 'react' 模块做扩展，把自定义元素注入到 React.JSX.IntrinsicElements。
 *
 * 该文件必须是一个模块（含有 import/export）才能让 `declare module`
 * 扩展正确工作。
 */
import type { ReactNode, Ref } from 'react'
import type {
  ClickEvent,
  FocusEvent,
  KeyboardEvent,
  Styles,
  TextStyles,
  DOMElement,
} from '@anthropic/ink'

declare module 'react' {
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
