import { useEffect, useRef } from 'react'
import { useTheme } from '@anthropic/ink'
import type { useSelection } from '@anthropic/ink'
import { getGlobalConfig } from '../utils/config.js'
import { getTheme } from '../utils/theme.js'

type Selection = ReturnType<typeof useSelection>

/**
 * 当用户完成拖动（带有非空选择的鼠标抬起）或
 * 多次点击选择单词/行时，自动将选择复制到剪贴板。
 * 模仿 iTerm2 的"选择时复制到粘贴板" —— 高亮保持
 * 完整，以便用户可以看到复制了什么。仅在备用屏幕模式下触发
 * （选择状态由 ink 实例拥有；在备用屏幕外，原生
 * 终端处理选择，此 hook 通过 ink 存根是无操作）。
 *
 * selection.subscribe 在每次变化时触发（start/update/finish/clear/
 * multiclick）。字符拖动和多次点击在按下时都设置 isDragging=true，
 * 因此以 isDragging=false 出现的选择总是拖动结束。
 * copiedRef 防止在虚假通知上重复触发。
 *
 * onCopied 是可选的 —— 省略时，复制是静默的（剪贴板被写入
 * 但不触发 toast/通知）。FleetView 使用此静默模式；
 * 全屏 REPL 传递 showCopiedToast 以提供用户反馈。
 */
export function useCopyOnSelect(
  selection: Selection,
  isActive: boolean,
  onCopied?: (text: string) => void,
): void {
  // 跟踪*先前*通知是否具有可见选择且
  // isDragging=false（即，我们已经自动复制了它）。没有这个，
  // finish→clear 转换会看起来像新的选择空闲
  // 事件，我们会为单次拖动触发两次 toast。
  const copiedRef = useRef(false)
  // onCopied 每次渲染都是新的闭包；通过 ref 读取，以便
  // 效果不会重新订阅（这会通过卸载重置 copiedRef）。
  const onCopiedRef = useRef(onCopied)
  onCopiedRef.current = onCopied

  useEffect(() => {
    if (!isActive) return

    const unsubscribe = selection.subscribe(() => {
      const sel = selection.getState()
      const has = selection.hasSelection()
      // 拖动进行中 —— 等待完成。重置复制标志，以便
      // 在同一范围结束的新拖动仍然触发新的复制。
      if (sel?.isDragging) {
        copiedRef.current = false
        return
      }
      // 没有选择（已清除，或点击但未拖动）—— 重置。
      if (!has) {
        copiedRef.current = false
        return
      }
      // 选择已确定（拖动完成或多次点击）。已复制
      // 这一个 —— 再次到达这里的唯一方式是不经过
      // isDragging 或 !has，这是虚假通知（不应该发生，但安全）。
      if (copiedRef.current) return

      // 默认为真：macOS 用户期望 cmd+c 工作。它不能 ——
      // 终端的 Edit > Copy 在 pty 看到之前拦截它，且
      // 找不到原生选择（鼠标跟踪禁用了它）。鼠标抬起时
      // 自动复制使 cmd+c 成为无操作，保持剪贴板完好
      // 并带有正确的内容，因此粘贴按预期工作。
      const enabled = getGlobalConfig().copyOnSelect ?? true
      if (!enabled) return

      const text = selection.copySelectionNoClear()
      // 仅空白（例如，空行多次点击）—— 不值得
      // 剪贴板写入或 toast。仍然设置 copiedRef 以便我们不重试。
      if (!text || !text.trim()) {
        copiedRef.current = true
        return
      }
      copiedRef.current = true
      onCopiedRef.current?.(text)
    })
    return unsubscribe
  }, [isActive, selection])
}

/**
 * 将主题的 selectionBg 颜色导入 Ink StylePool，以便
 * 选择覆盖层渲染实心蓝色背景而不是 SGR-7 反转。
 * Ink 是主题无关的（分层：colorize.ts "主题解析发生在
 * 组件层，而不是这里"）—— 这是桥接。在挂载时触发
 * （在任何鼠标输入可能之前）且每当 /theme 翻转时再次触发，
 * 因此选择颜色实时跟踪主题。
 */
export function useSelectionBgColor(selection: Selection): void {
  const [themeName] = useTheme()
  useEffect(() => {
    selection.setSelectionBgColor(getTheme(themeName).selectionBg)
  }, [selection, themeName])
}
