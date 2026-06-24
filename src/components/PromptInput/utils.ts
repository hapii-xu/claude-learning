import {
  hasUsedBackslashReturn,
  isShiftEnterKeyBindingInstalled,
} from '../../commands/terminalSetup/terminalSetup.js'
import type { Key } from '@anthropic/ink'
import { getGlobalConfig } from '../../utils/config.js'
import { env } from '../../utils/env.js'
/**
 * 检查当前是否启用了 vim 模式的辅助函数
 * @returns 表示 vim 模式是否激活的布尔值
 */
export function isVimModeEnabled(): boolean {
  const config = getGlobalConfig()
  return config.editorMode === 'vim'
}

export function getNewlineInstructions(): string {
  // macOS 上的 Apple Terminal 使用原生修饰键检测 Shift+Enter
  if (env.terminal === 'Apple_Terminal' && process.platform === 'darwin') {
    return 'shift + ⏎ 换行'
  }

  // 对于 iTerm2 和 VSCode，如果已安装则显示 Shift+Enter 说明
  if (isShiftEnterKeyBindingInstalled()) {
    return 'shift + ⏎ 换行'
  }

  // 否则显示反斜杠+回车说明
  return hasUsedBackslashReturn() ? '\\⏎ 换行' : '反斜杠 (\\) + 回车 (⏎) 换行'
}

/**
 * 当按键是不以空白字符开头的可打印字符时返回 true，
 * 即用户输入的普通字母/数字/符号。
 * 用于控制图片 pill 后插入的惰性空格。
 */
export function isNonSpacePrintable(input: string, key: Key): boolean {
  if (
    key.ctrl ||
    key.meta ||
    key.escape ||
    key.return ||
    key.tab ||
    key.backspace ||
    key.delete ||
    key.upArrow ||
    key.downArrow ||
    key.leftArrow ||
    key.rightArrow ||
    key.pageUp ||
    key.pageDown ||
    key.home ||
    key.end
  ) {
    return false
  }
  return input.length > 0 && !/^\s/.test(input) && !input.startsWith('\x1b')
}
