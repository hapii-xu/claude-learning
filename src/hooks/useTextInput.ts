import { isInputModeCharacter } from 'src/components/PromptInput/inputModes.js'
import { useNotifications } from 'src/context/notifications.js'
import stripAnsi from 'strip-ansi'
import { markBackslashReturnUsed } from '../commands/terminalSetup/terminalSetup.js'
import { addToHistory } from '../history.js'
import type { Key } from '@anthropic/ink'
import type {
  InlineGhostText,
  TextInputState,
} from '../types/textInputTypes.js'
import {
  Cursor,
  getLastKill,
  pushToKillRing,
  recordYank,
  resetKillAccumulation,
  resetYankState,
  updateYankLength,
  yankPop,
} from '../utils/Cursor.js'
import { env } from '../utils/env.js'
import { isFullscreenEnvEnabled } from '../utils/fullscreen.js'
import type { ImageDimensions } from '../utils/imageResizer.js'
import { isModifierPressed, prewarmModifiers } from '../utils/modifiers.js'
import { useDoublePress } from './useDoublePress.js'

// biome-ignore lint/suspicious/noConfusingVoidType: void is the correct return type for cursor handlers that return nothing
type MaybeCursor = void | Cursor
type InputHandler = (input: string) => MaybeCursor
type InputMapper = (input: string) => MaybeCursor
const NOOP_HANDLER: InputHandler = () => {}
function mapInput(input_map: Array<[string, InputHandler]>): InputMapper {
  const map = new Map(input_map)
  return function (input: string): MaybeCursor {
    return (map.get(input) ?? NOOP_HANDLER)(input)
  }
}

export type UseTextInputProps = {
  value: string
  onChange: (value: string) => void
  onSubmit?: (value: string) => void
  onExit?: () => void
  onExitMessage?: (show: boolean, key?: string) => void
  onHistoryUp?: () => void
  onHistoryDown?: () => void
  onHistoryReset?: () => void
  onClearInput?: () => void
  focus?: boolean
  mask?: string
  multiline?: boolean
  cursorChar: string
  highlightPastedText?: boolean
  invert: (text: string) => string
  themeText: (text: string) => string
  columns: number
  onImagePaste?: (
    base64Image: string,
    mediaType?: string,
    filename?: string,
    dimensions?: ImageDimensions,
    sourcePath?: string,
  ) => void
  disableCursorMovementForUpDownKeys?: boolean
  disableEscapeDoublePress?: boolean
  maxVisibleLines?: number
  externalOffset: number
  onOffsetChange: (offset: number) => void
  inputFilter?: (input: string, key: Key) => string
  inlineGhostText?: InlineGhostText
  dim?: (text: string) => string
}

export function useTextInput({
  value: originalValue,
  onChange,
  onSubmit,
  onExit,
  onExitMessage,
  onHistoryUp,
  onHistoryDown,
  onHistoryReset,
  onClearInput,
  mask = '',
  multiline = false,
  cursorChar,
  invert,
  columns,
  onImagePaste: _onImagePaste,
  disableCursorMovementForUpDownKeys = false,
  disableEscapeDoublePress = false,
  maxVisibleLines,
  externalOffset,
  onOffsetChange,
  inputFilter,
  inlineGhostText,
  dim,
}: UseTextInputProps): TextInputState {
  // Pre-warm the modifiers module for Apple Terminal (has internal guard, safe to call multiple times)
  if (env.terminal === 'Apple_Terminal') {
    prewarmModifiers()
  }

  const offset = externalOffset
  const setOffset = onOffsetChange
  const cursor = Cursor.fromText(originalValue, columns, offset)
  const { addNotification, removeNotification } = useNotifications()

  const handleCtrlC = useDoublePress(
    show => {
      onExitMessage?.(show, 'Ctrl-C')
    },
    () => onExit?.(),
    () => {
      if (originalValue) {
        onChange('')
        setOffset(0)
        onHistoryReset?.()
      }
    },
  )

  // NOTE(keybindings): This escape handler is intentionally NOT migrated to the keybindings system.
  // It's a text-level double-press escape for clearing input, not an action-level keybinding.
  // Double-press Esc clears the input and saves to history - this is text editing behavior,
  // not dialog dismissal, and needs the double-press safety mechanism.
  const handleEscape = useDoublePress(
    (show: boolean) => {
      if (!originalValue || !show) {
        return
      }
      addNotification({
        key: 'escape-again-to-clear',
        text: 'Esc again to clear',
        priority: 'immediate',
        timeoutMs: 1000,
      })
    },
    () => {
      // Remove the "Esc again to clear" notification immediately
      removeNotification('escape-again-to-clear')
      onClearInput?.()
      if (originalValue) {
        // Track double-escape usage for feature discovery
        // Save to history before clearing
        if (originalValue.trim() !== '') {
          addToHistory(originalValue)
        }
        onChange('')
        setOffset(0)
        onHistoryReset?.()
      }
    },
  )

  const handleEmptyCtrlD = useDoublePress(
    show => {
      if (originalValue !== '') {
        return
      }
      onExitMessage?.(show, 'Ctrl-D')
    },
    () => {
      if (originalValue !== '') {
        return
      }
      onExit?.()
    },
  )

  function handleCtrlD(): MaybeCursor {
    if (cursor.text === '') {
      // When input is empty, handle double-press
      handleEmptyCtrlD()
      return cursor
    }
    // When input is not empty, delete forward like iPython
    return cursor.del()
  }

  function killToLineEnd(): Cursor {
    const { cursor: newCursor, killed } = cursor.deleteToLineEnd()
    pushToKillRing(killed, 'append')
    return newCursor
  }

  function killToLineStart(): Cursor {
    const { cursor: newCursor, killed } = cursor.deleteToLineStart()
    pushToKillRing(killed, 'prepend')
    return newCursor
  }

  function killWordBefore(): Cursor {
    const { cursor: newCursor, killed } = cursor.deleteWordBefore()
    pushToKillRing(killed, 'prepend')
    return newCursor
  }

  function yank(): Cursor {
    const text = getLastKill()
    if (text.length > 0) {
      const startOffset = cursor.offset
      const newCursor = cursor.insert(text)
      recordYank(startOffset, text.length)
      return newCursor
    }
    return cursor
  }

  function handleYankPop(): Cursor {
    const popResult = yankPop()
    if (!popResult) {
      return cursor
    }
    const { text, start, length } = popResult
    // Replace the previously yanked text with the new one
    const before = cursor.text.slice(0, start)
    const after = cursor.text.slice(start + length)
    const newText = before + text + after
    const newOffset = start + text.length
    updateYankLength(text.length)
    return Cursor.fromText(newText, columns, newOffset)
  }

  const handleCtrl = mapInput([
    ['a', () => cursor.startOfLine()],
    ['b', () => cursor.left()],
    ['c', handleCtrlC],
    ['d', handleCtrlD],
    ['e', () => cursor.endOfLine()],
    ['f', () => cursor.right()],
    ['h', () => cursor.deleteTokenBefore() ?? cursor.backspace()],
    ['k', killToLineEnd],
    ['n', () => downOrHistoryDown()],
    ['p', () => upOrHistoryUp()],
    ['u', killToLineStart],
    ['w', killWordBefore],
    ['y', yank],
  ])

  const handleMeta = mapInput([
    ['b', () => cursor.prevWord()],
    ['f', () => cursor.nextWord()],
    ['d', () => cursor.deleteWordAfter()],
    ['y', handleYankPop],
  ])

  function handleEnter(key: Key) {
    if (
      multiline &&
      cursor.offset > 0 &&
      cursor.text[cursor.offset - 1] === '\\'
    ) {
      // Track that the user has used backslash+return
      markBackslashReturnUsed()
      return cursor.backspace().insert('\n')
    }
    // Meta+Enter or Shift+Enter inserts a newline
    if (key.meta || key.shift) {
      return cursor.insert('\n')
    }
    // Apple Terminal doesn't support custom Shift+Enter keybindings,
    // so we use native macOS modifier detection to check if Shift is held
    if (env.terminal === 'Apple_Terminal' && isModifierPressed('shift')) {
      return cursor.insert('\n')
    }
    onSubmit?.(originalValue)
  }

  function upOrHistoryUp() {
    if (disableCursorMovementForUpDownKeys) {
      onHistoryUp?.()
      return cursor
    }
    // Try to move by wrapped lines first
    const cursorUp = cursor.up()
    if (!cursorUp.equals(cursor)) {
      return cursorUp
    }

    // If we can't move by wrapped lines and this is multiline input,
    // try to move by logical lines (to handle paragraph boundaries)
    if (multiline) {
      const cursorUpLogical = cursor.upLogicalLine()
      if (!cursorUpLogical.equals(cursor)) {
        return cursorUpLogical
      }
    }

    // Can't move up at all - trigger history navigation
    onHistoryUp?.()
    return cursor
  }
  function downOrHistoryDown() {
    if (disableCursorMovementForUpDownKeys) {
      onHistoryDown?.()
      return cursor
    }
    // Try to move by wrapped lines first
    const cursorDown = cursor.down()
    if (!cursorDown.equals(cursor)) {
      return cursorDown
    }

    // If we can't move by wrapped lines and this is multiline input,
    // try to move by logical lines (to handle paragraph boundaries)
    if (multiline) {
      const cursorDownLogical = cursor.downLogicalLine()
      if (!cursorDownLogical.equals(cursor)) {
        return cursorDownLogical
      }
    }

    // Can't move down at all - trigger history navigation
    onHistoryDown?.()
    return cursor
  }

  function mapKey(key: Key): InputMapper {
    switch (true) {
      case key.escape:
        return () => {
          // Skip when a keybinding context (e.g. Autocomplete) owns escape.
          // useKeybindings can't shield us via stopImmediatePropagation —
          // BaseTextInput's useInput registers first (child effects fire
          // before parent effects), so this handler has already run by the
          // time the keybinding's handler stops propagation.
          if (disableEscapeDoublePress) return cursor
          handleEscape()
          // Return the current cursor unchanged - handleEscape manages state internally
          return cursor
        }
      case key.leftArrow && (key.ctrl || key.meta || key.fn):
        return () => cursor.prevWord()
      case key.rightArrow && (key.ctrl || key.meta || key.fn):
        return () => cursor.nextWord()
      case key.backspace:
        return key.meta || key.ctrl
          ? killWordBefore
          : () => cursor.deleteTokenBefore() ?? cursor.backspace()
      case key.delete:
        return key.meta ? killToLineEnd : () => cursor.del()
      case key.ctrl:
        return handleCtrl
      case key.home:
        return () => cursor.startOfLine()
      case key.end:
        return () => cursor.endOfLine()
      case key.pageDown:
        // In fullscreen mode, PgUp/PgDn scroll the message viewport instead
        // of moving the cursor — no-op here, ScrollKeybindingHandler handles it.
        if (isFullscreenEnvEnabled()) {
          return NOOP_HANDLER
        }
        return () => cursor.endOfLine()
      case key.pageUp:
        if (isFullscreenEnvEnabled()) {
          return NOOP_HANDLER
        }
        return () => cursor.startOfLine()
      case key.wheelUp:
      case key.wheelDown:
        // 鼠标滚轮事件仅在启用全屏鼠标跟踪时存在。
        // ScrollKeybindingHandler 处理它们；此处无操作以避免将
        // 原始 SGR 序列作为文本插入。
        return NOOP_HANDLER
      case key.return:
        // 必须在 key.meta 之前，以便 Option+Return 插入换行符
        return () => handleEnter(key)
      case key.meta:
        return handleMeta
      case key.tab:
        return () => cursor
      case key.upArrow && !key.shift:
        return upOrHistoryUp
      case key.downArrow && !key.shift:
        return downOrHistoryDown
      case key.leftArrow:
        return () => cursor.left()
      case key.rightArrow:
        return () => cursor.right()
      default: {
        return function (input: string) {
          switch (true) {
            // Home 键
            case input === '\x1b[H' || input === '\x1b[1~':
              return cursor.startOfLine()
            // End 键
            case input === '\x1b[F' || input === '\x1b[4~':
              return cursor.endOfLine()
            default: {
              // 文本后的尾随 \r 是 SSH 合并的 Enter（"o\r"）——
              // 剥离它以免 Enter 作为内容插入。此处的单独 \r
              // 是 Alt+Enter 漏过来的（META_KEY_CODE_RE 不匹配
              // \x1b\r）—— 留给下方的 \r→\n 处理。嵌入的 \r
              // 是来自没有 bracketed paste 的终端的多行粘贴
              // —— 转换为 \n。Backslash+\r 是陈旧的 VS Code
              // Shift+Enter 绑定（pre-#8991 /terminal-setup 向
              // keybindings.json 写入了 args.text "\\\r\n"）；保留 \r 以便
              // 在下方变为 \n（anthropics/claude-code#31316）。
              const text = stripAnsi(input)
                // eslint-disable-next-line custom-rules/no-lookbehind-regex -- .replace(re, str) on 1-2 char keystrokes: no-match returns same string (Object.is), regex never runs
                .replace(/(?<=[^\\\r\n])\r$/, '')
                .replace(/\r/g, '\n')
              if (cursor.isAtStart() && isInputModeCharacter(input)) {
                return cursor.insert(text).left()
              }
              return cursor.insert(text)
            }
          }
        }
      }
    }
  }

  // 检查这是否是一个 kill 命令（Ctrl+K、Ctrl+U、Ctrl+W 或 Meta+Backspace/Delete）
  function isKillKey(key: Key, input: string): boolean {
    if (key.ctrl && (input === 'k' || input === 'u' || input === 'w')) {
      return true
    }
    if (key.meta && (key.backspace || key.delete)) {
      return true
    }
    return false
  }

  // 检查这是否是一个 yank 命令（Ctrl+Y 或 Alt+Y）
  function isYankKey(key: Key, input: string): boolean {
    return (key.ctrl || key.meta) && input === 'y'
  }

  function onInput(input: string, key: Key): void {
    // 注意：图像粘贴快捷键（chat:imagePaste）通过 PromptInput 中的 useKeybindings 处理

    // 如果提供了过滤器则应用
    const filteredInput = inputFilter ? inputFilter(input, key) : input

    // 如果输入被过滤掉，什么都不做
    if (filteredInput === '' && input !== '') {
      return
    }

    // 修复 Issue #1853：过滤在 SSH/tmux 中干扰 backspace 的 DEL 字符
    // 在 SSH/tmux 环境中，backspace 同时生成按键事件和原始 DEL 字符
    if (!key.backspace && !key.delete && input.includes('\x7f')) {
      const delCount = (input.match(/\x7f/g) || []).length

      // 同步地将所有 DEL 字符应用为 backspace 操作
      // 首先尝试删除 token，回退到字符 backspace
      let currentCursor = cursor
      for (let i = 0; i < delCount; i++) {
        currentCursor =
          currentCursor.deleteTokenBefore() ?? currentCursor.backspace()
      }

      // 用最终结果更新状态一次
      if (!cursor.equals(currentCursor)) {
        if (cursor.text !== currentCursor.text) {
          onChange(currentCursor.text)
        }
        setOffset(currentCursor.offset)
      }
      resetKillAccumulation()
      resetYankState()
      return
    }

    // 对非 kill 键重置 kill 累积
    if (!isKillKey(key, filteredInput)) {
      resetKillAccumulation()
    }

    // 对非 yank 键重置 yank 状态（中断 yank-pop 链）
    if (!isYankKey(key, filteredInput)) {
      resetYankState()
    }

    const nextCursor = mapKey(key)(filteredInput)
    if (nextCursor) {
      if (!cursor.equals(nextCursor)) {
        if (cursor.text !== nextCursor.text) {
          onChange(nextCursor.text)
        }
        setOffset(nextCursor.offset)
      }
      // SSH 合并的 Enter：在慢速链路上，"o" + Enter 可能作为一个
      // 块 "o\r" 到达。parseKeypress 只匹配 s === '\r'，所以它走到了
      // 上方的默认处理程序（剥离了尾随的 \r）。带有
      // 恰好一个尾随 \r 的文本是合并的 Enter；单独的 \r 是 Alt+Enter
      //（换行符）；嵌入的 \r 是多行粘贴。
      if (
        filteredInput.length > 1 &&
        filteredInput.endsWith('\r') &&
        !filteredInput.slice(0, -1).includes('\r') &&
        // Backslash+CR 是陈旧的 VS Code Shift+Enter 绑定，不是
        // 合并的 Enter。见上方的默认处理程序。
        filteredInput[filteredInput.length - 2] !== '\\'
      ) {
        onSubmit?.(nextCursor.text)
      }
    }
  }

  // 为渲染准备 ghost 文本 —— 校验 insertPosition 匹配当前
  // 光标 offset 以防之前按键导致的陈旧 ghost 文本造成
  // 一帧抖动（ghost 文本状态在渲染后通过 useEffect 更新）
  const ghostTextForRender =
    inlineGhostText && dim && inlineGhostText.insertPosition === offset
      ? { text: inlineGhostText.text, dim }
      : undefined

  const cursorPos = cursor.getPosition()

  return {
    onInput,
    renderedValue: cursor.render(
      cursorChar,
      mask,
      invert,
      ghostTextForRender,
      maxVisibleLines,
    ),
    offset,
    setOffset,
    cursorLine: cursorPos.line - cursor.getViewportStartLine(maxVisibleLines),
    cursorColumn: cursorPos.column,
    viewportCharOffset: cursor.getViewportCharOffset(maxVisibleLines),
    viewportCharEnd: cursor.getViewportCharEnd(maxVisibleLines),
  }
}
