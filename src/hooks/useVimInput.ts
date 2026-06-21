import React, { useCallback, useState } from 'react'
import type { Key } from '@anthropic/ink'
import type { VimInputState, VimMode } from '../types/textInputTypes.js'
import { Cursor } from '../utils/Cursor.js'
import { lastGrapheme } from '../utils/intl.js'
import {
  executeIndent,
  executeJoin,
  executeOpenLine,
  executeOperatorFind,
  executeOperatorMotion,
  executeOperatorTextObj,
  executeReplace,
  executeToggleCase,
  executeX,
  type OperatorContext,
} from '../vim/operators.js'
import { type TransitionContext, transition } from '../vim/transitions.js'
import {
  createInitialPersistentState,
  createInitialVimState,
  type PersistentState,
  type RecordedChange,
  type VimState,
} from '../vim/types.js'
import { type UseTextInputProps, useTextInput } from './useTextInput.js'

type UseVimInputProps = Omit<UseTextInputProps, 'inputFilter'> & {
  onModeChange?: (mode: VimMode) => void
  onUndo?: () => void
  inputFilter?: UseTextInputProps['inputFilter']
}

export function useVimInput(props: UseVimInputProps): VimInputState {
  const vimStateRef = React.useRef<VimState>(createInitialVimState())
  const [mode, setMode] = useState<VimMode>('INSERT')

  const persistentRef = React.useRef<PersistentState>(
    createInitialPersistentState(),
  )

  // inputFilter 在 handleVimInput 顶部应用一次（而不是这里），以便
  // 未调用 textInput.onInput 就返回的 vim 处理路径仍能
  // 运行过滤器 —— 否则有状态过滤器（例如 lazy-space-after-
  // pill）会在 Escape → NORMAL → INSERT 往返之间保持武装状态。
  const textInput = useTextInput({ ...props, inputFilter: undefined })
  const { onModeChange, inputFilter } = props

  const switchToInsertMode = useCallback(
    (offset?: number): void => {
      if (offset !== undefined) {
        textInput.setOffset(offset)
      }
      vimStateRef.current = { mode: 'INSERT', insertedText: '' }
      setMode('INSERT')
      onModeChange?.('INSERT')
    },
    [textInput, onModeChange],
  )

  const switchToNormalMode = useCallback((): void => {
    const current = vimStateRef.current
    if (current.mode === 'INSERT' && current.insertedText) {
      persistentRef.current.lastChange = {
        type: 'insert',
        text: current.insertedText,
      }
    }

    // Vim 行为：退出插入模式时将光标左移 1 位
    //（除非在行首或 offset 0）
    const offset = textInput.offset
    if (offset > 0 && props.value[offset - 1] !== '\n') {
      textInput.setOffset(offset - 1)
    }

    vimStateRef.current = { mode: 'NORMAL', command: { type: 'idle' } }
    setMode('NORMAL')
    onModeChange?.('NORMAL')
  }, [onModeChange, textInput, props.value])

  function createOperatorContext(
    cursor: Cursor,
    isReplay: boolean = false,
  ): OperatorContext {
    return {
      cursor,
      text: props.value,
      setText: (newText: string) => props.onChange(newText),
      setOffset: (offset: number) => textInput.setOffset(offset),
      enterInsert: (offset: number) => switchToInsertMode(offset),
      getRegister: () => persistentRef.current.register,
      setRegister: (content: string, linewise: boolean) => {
        persistentRef.current.register = content
        persistentRef.current.registerIsLinewise = linewise
      },
      getLastFind: () => persistentRef.current.lastFind,
      setLastFind: (type, char) => {
        persistentRef.current.lastFind = { type, char }
      },
      recordChange: isReplay
        ? () => {}
        : (change: RecordedChange) => {
            persistentRef.current.lastChange = change
          },
    }
  }

  function replayLastChange(): void {
    const change = persistentRef.current.lastChange
    if (!change) return

    const cursor = Cursor.fromText(props.value, props.columns, textInput.offset)
    const ctx = createOperatorContext(cursor, true)

    switch (change.type) {
      case 'insert':
        if (change.text) {
          const newCursor = cursor.insert(change.text)
          props.onChange(newCursor.text)
          textInput.setOffset(newCursor.offset)
        }
        break

      case 'x':
        executeX(change.count, ctx)
        break

      case 'replace':
        executeReplace(change.char, change.count, ctx)
        break

      case 'toggleCase':
        executeToggleCase(change.count, ctx)
        break

      case 'indent':
        executeIndent(change.dir, change.count, ctx)
        break

      case 'join':
        executeJoin(change.count, ctx)
        break

      case 'openLine':
        executeOpenLine(change.direction, ctx)
        break

      case 'operator':
        executeOperatorMotion(change.op, change.motion, change.count, ctx)
        break

      case 'operatorFind':
        executeOperatorFind(
          change.op,
          change.find,
          change.char,
          change.count,
          ctx,
        )
        break

      case 'operatorTextObj':
        executeOperatorTextObj(
          change.op,
          change.scope,
          change.objType,
          change.count,
          ctx,
        )
        break
    }
  }

  function handleVimInput(rawInput: string, key: Key): void {
    const state = vimStateRef.current
    // 在所有模式中运行 inputFilter 以便有状态过滤器在任意按键上解除，
    // 但仅在 INSERT 模式应用转换后的输入 —— NORMAL 模式命令
    // 查找期望单个字符，前置空格会破坏它们。
    const filtered = inputFilter ? inputFilter(rawInput, key) : rawInput
    const input = state.mode === 'INSERT' ? filtered : rawInput
    const cursor = Cursor.fromText(props.value, props.columns, textInput.offset)

    if (key.ctrl) {
      textInput.onInput(input, key)
      return
    }

    // NOTE(keybindings)：此 escape 处理程序故意不迁移到 keybindings 系统。
    // 它是 vim 标准的 INSERT->NORMAL 模式切换 —— 一个不应通过
    // keybindings 配置的 vim 特定行为。Vim 用户期望 Esc 总是退出 INSERT 模式。
    if (key.escape && state.mode === 'INSERT') {
      switchToNormalMode()
      return
    }

    // NORMAL 模式下的 Escape 取消任何待处理命令（replace、operator 等）
    if (key.escape && state.mode === 'NORMAL') {
      vimStateRef.current = { mode: 'NORMAL', command: { type: 'idle' } }
      return
    }

    // 无论模式如何，将 Enter 传递给基础处理程序（允许从 NORMAL 提交）
    if (key.return) {
      textInput.onInput(input, key)
      return
    }

    if (state.mode === 'INSERT') {
      // 跟踪插入的文本用于 dot-repeat
      if (key.backspace || key.delete) {
        if (state.insertedText.length > 0) {
          vimStateRef.current = {
            mode: 'INSERT',
            insertedText: state.insertedText.slice(
              0,
              -(lastGrapheme(state.insertedText).length || 1),
            ),
          }
        }
      } else {
        vimStateRef.current = {
          mode: 'INSERT',
          insertedText: state.insertedText + input,
        }
      }
      textInput.onInput(input, key)
      return
    }

    if (state.mode !== 'NORMAL') {
      return
    }

    // 在空闲状态下，将方向键委托给基础处理程序以进行光标移动
    // 和历史回退（upOrHistoryUp / downOrHistoryDown）
    if (
      state.command.type === 'idle' &&
      (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow)
    ) {
      textInput.onInput(input, key)
      return
    }

    const ctx: TransitionContext = {
      ...createOperatorContext(cursor, false),
      onUndo: props.onUndo,
      onDotRepeat: replayLastChange,
    }

    // Backspace/Delete 仅在期望 motion 的状态中映射。在
    // 字面字符状态（replace、find、operatorFind）中，映射会将
    // r+Backspace 变成"替换为 h"，df+Delete 变成"删除到下一个 x"。
    // Delete 还跳过 count 状态：在 vim 中，N<Del> 移除一个 count
    // 数字而不是执行 Nx；我们不实现数字移除，但
    // 至少不应将取消变成破坏性的 Nx。
    const expectsMotion =
      state.command.type === 'idle' ||
      state.command.type === 'count' ||
      state.command.type === 'operator' ||
      state.command.type === 'operatorCount'

    // 在 NORMAL 模式下将方向键映射为 vim motions
    let vimInput = input
    if (key.leftArrow) vimInput = 'h'
    else if (key.rightArrow) vimInput = 'l'
    else if (key.upArrow) vimInput = 'k'
    else if (key.downArrow) vimInput = 'j'
    else if (expectsMotion && key.backspace) vimInput = 'h'
    else if (expectsMotion && state.command.type !== 'count' && key.delete)
      vimInput = 'x'

    const result = transition(state.command, vimInput, ctx)

    if (result.execute) {
      result.execute()
    }

    // 更新命令状态（仅当 execute 未切换到 INSERT 时）
    if (vimStateRef.current.mode === 'NORMAL') {
      if (result.next) {
        vimStateRef.current = { mode: 'NORMAL', command: result.next }
      } else if (result.execute) {
        vimStateRef.current = { mode: 'NORMAL', command: { type: 'idle' } }
      }
    }

    if (
      input === '?' &&
      state.mode === 'NORMAL' &&
      state.command.type === 'idle'
    ) {
      props.onChange('?')
    }
  }

  const setModeExternal = useCallback(
    (newMode: VimMode) => {
      if (newMode === 'INSERT') {
        vimStateRef.current = { mode: 'INSERT', insertedText: '' }
      } else {
        vimStateRef.current = { mode: 'NORMAL', command: { type: 'idle' } }
      }
      setMode(newMode)
      onModeChange?.(newMode)
    },
    [onModeChange],
  )

  return {
    ...textInput,
    onInput: handleVimInput,
    mode,
    setMode: setModeExternal,
  }
}
