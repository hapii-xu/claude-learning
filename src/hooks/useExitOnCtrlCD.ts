import { useCallback, useMemo, useState } from 'react'
import { useApp } from '@anthropic/ink'
import type { KeybindingContextName } from '../keybindings/types.js'
import { useDoublePress } from './useDoublePress.js'

export type ExitState = {
  pending: boolean
  keyName: 'Ctrl-C' | 'Ctrl-D' | null
}

type KeybindingOptions = {
  context?: KeybindingContextName
  isActive?: boolean
}

type UseKeybindingsHook = (
  handlers: Record<string, () => void>,
  options?: KeybindingOptions,
) => void

/**
 * 处理 ctrl+c 和 ctrl+d 退出应用程序。
 *
 * 使用基于时间的双击机制：
 * - 第一次按下：显示 "再按 X 退出" 消息
 * - 超时内的第二次按下：退出应用程序
 *
 * 注意：我们使用基于时间的双击而不是和弦系统，因为
 * 我们希望第一次 ctrl+c 也触发中断（在其他地方处理）。
 * 和弦系统会阻止第一次按下触发任何操作。
 *
 * 这些键是硬编码的，不能通过 keybindings.json 重新绑定。
 *
 * @param useKeybindingsHook - 用于注册处理程序的 useKeybindings hook
 *                            （依赖注入以避免导入循环）
 * @param onInterrupt - 可选回调，让功能处理中断 (ctrl+c)。
 *                      返回 true 表示已处理，false 则回退到双击退出。
 * @param onExit - 可选自定义退出处理程序
 * @param isActive - 快捷键是否活跃（默认 true）。在嵌入式
 *                   TextInput 获得焦点时设为 false —— TextInput 自己的
 *                   ctrl+c/d 处理程序将管理取消/退出，否则 Dialog 的
 *                   处理程序会重复触发（子级 useInput 在父级 useKeybindings
 *                   之前运行，所以两者都会看到每次按键）。
 */
export function useExitOnCtrlCD(
  useKeybindingsHook: UseKeybindingsHook,
  onInterrupt?: () => boolean,
  onExit?: () => void,
  isActive = true,
): ExitState {
  const { exit } = useApp()
  const [exitState, setExitState] = useState<ExitState>({
    pending: false,
    keyName: null,
  })

  const exitFn = useMemo(() => onExit ?? exit, [onExit, exit])

  // ctrl+c 的双击处理程序
  const handleCtrlCDoublePress = useDoublePress(
    pending => setExitState({ pending, keyName: 'Ctrl-C' }),
    exitFn,
  )

  // ctrl+d 的双击处理程序
  const handleCtrlDDoublePress = useDoublePress(
    pending => setExitState({ pending, keyName: 'Ctrl-D' }),
    exitFn,
  )

  // app:interrupt 的处理程序（默认 ctrl+c）
  // 让功能先通过回调处理中断
  const handleInterrupt = useCallback(() => {
    if (onInterrupt?.()) return // 功能已处理
    handleCtrlCDoublePress()
  }, [handleCtrlCDoublePress, onInterrupt])

  // app:exit 的处理程序（默认 ctrl+d）
  // 这也使用双击确认退出
  const handleExit = useCallback(() => {
    handleCtrlDDoublePress()
  }, [handleCtrlDDoublePress])

  const handlers = useMemo(
    () => ({
      'app:interrupt': handleInterrupt,
      'app:exit': handleExit,
    }),
    [handleInterrupt, handleExit],
  )

  useKeybindingsHook(handlers, { context: 'Global', isActive })

  return exitState
}
