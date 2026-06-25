import { useEffect, useRef } from 'react'
import { normalizeFullWidthDigits } from '../../utils/stringUtils.js'

// 将数字作为响应接受前的延迟，防止用户以数字开头消息时误提交（如编号列表）。
// 间隔足够短，让有意按下时感觉即时；又足够长，让用户输入更多字符时可取消。
const DEFAULT_DEBOUNCE_MS = 400

/**
 * 检测用户在 prompt 输入框中键入单个合法数字，
 * 做防抖以避免误提交（如 "1. 第一项"），
 * 从输入中移除该数字，并触发回调。
 *
 * 供那些接受直接在主 prompt 输入框中键入数字响应的调查组件使用。
 */
export function useDebouncedDigitInput<T extends string = string>({
  inputValue,
  setInputValue,
  isValidDigit,
  onDigit,
  enabled = true,
  once = false,
  debounceMs = DEFAULT_DEBOUNCE_MS,
}: {
  inputValue: string
  setInputValue: (value: string) => void
  isValidDigit: (char: string) => char is T
  onDigit: (digit: T) => void
  enabled?: boolean
  once?: boolean
  debounceMs?: number
}): void {
  const initialInputValue = useRef(inputValue)
  const hasTriggeredRef = useRef(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Latest-ref 模式：让调用方可以传入内联回调，而不会导致 effect 重新运行
  // （否则每次渲染都会重置防抖计时器）。
  const callbacksRef = useRef({ setInputValue, isValidDigit, onDigit })
  callbacksRef.current = { setInputValue, isValidDigit, onDigit }

  useEffect(() => {
    if (!enabled || (once && hasTriggeredRef.current)) {
      return
    }

    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }

    if (inputValue !== initialInputValue.current) {
      const lastChar = normalizeFullWidthDigits(inputValue.slice(-1))
      if (callbacksRef.current.isValidDigit(lastChar)) {
        const trimmed = inputValue.slice(0, -1)
        debounceRef.current = setTimeout(
          (debounceRef, hasTriggeredRef, callbacksRef, trimmed, lastChar) => {
            debounceRef.current = null
            hasTriggeredRef.current = true
            callbacksRef.current.setInputValue(trimmed)
            callbacksRef.current.onDigit(lastChar)
          },
          debounceMs,
          debounceRef,
          hasTriggeredRef,
          callbacksRef,
          trimmed,
          lastChar,
        )
      }
    }

    return () => {
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current)
        debounceRef.current = null
      }
    }
  }, [inputValue, enabled, once, debounceMs])
}
