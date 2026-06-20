import { getPlatform } from '../utils/platform.js'

/**
 * 通常被操作系统、终端或 shell 拦截的快捷键，
 * 可能永远不会到达应用程序。
 */
export type ReservedShortcut = {
  key: string
  reason: string
  severity: 'error' | 'warning'
}

/**
 * 无法重新绑定的快捷键 - 它们在 Claude Code 中是硬编码的。
 */
export const NON_REBINDABLE: ReservedShortcut[] = [
  {
    key: 'ctrl+c',
    reason: 'Cannot be rebound - used for interrupt/exit (hardcoded)',
    severity: 'error',
  },
  {
    key: 'ctrl+d',
    reason: 'Cannot be rebound - used for exit (hardcoded)',
    severity: 'error',
  },
  {
    key: 'ctrl+m',
    reason:
      'Cannot be rebound - identical to Enter in terminals (both send CR)',
    severity: 'error',
  },
]

/**
 * 被终端/操作系统拦截的终端控制快捷键。
 * 这些可能永远不会到达应用程序。
 *
 * 注意：ctrl+s (XOFF) 和 ctrl+q (XON) 不包含在此处，因为：
 * - 大多数现代终端默认禁用流控制
 * - 我们将 ctrl+s 用于暂存功能
 */
export const TERMINAL_RESERVED: ReservedShortcut[] = [
  {
    key: 'ctrl+z',
    reason: 'Unix process suspend (SIGTSTP)',
    severity: 'warning',
  },
  {
    key: 'ctrl+\\',
    reason: 'Terminal quit signal (SIGQUIT)',
    severity: 'error',
  },
]

/**
 * 操作系统拦截的 macOS 特定快捷键。
 */
export const MACOS_RESERVED: ReservedShortcut[] = [
  { key: 'cmd+c', reason: 'macOS system copy', severity: 'error' },
  { key: 'cmd+v', reason: 'macOS system paste', severity: 'error' },
  { key: 'cmd+x', reason: 'macOS system cut', severity: 'error' },
  { key: 'cmd+q', reason: 'macOS quit application', severity: 'error' },
  { key: 'cmd+w', reason: 'macOS close window/tab', severity: 'error' },
  { key: 'cmd+tab', reason: 'macOS app switcher', severity: 'error' },
  { key: 'cmd+space', reason: 'macOS Spotlight', severity: 'error' },
]

/**
 * 获取当前平台的所有保留快捷键。
 * 包括不可重新绑定的快捷键和终端保留的快捷键。
 */
export function getReservedShortcuts(): ReservedShortcut[] {
  const platform = getPlatform()
  // 不可重新绑定的快捷键优先（最高优先级）
  const reserved = [...NON_REBINDABLE, ...TERMINAL_RESERVED]

  if (platform === 'macos') {
    reserved.push(...MACOS_RESERVED)
  }

  return reserved
}

/**
 * 规范化键字符串以进行比较（小写，排序修饰符）。
 * 和弦（空格分隔的步骤，如 "ctrl+x ctrl+b"）按每步规范化 ——
 * 先按 '+' 分割会将 "x ctrl" 混淆为主键，被下一步覆盖，
 * 将和弦折叠为其最后一个键。
 */
export function normalizeKeyForComparison(key: string): string {
  return key.trim().split(/\s+/).map(normalizeStep).join(' ')
}

function normalizeStep(step: string): string {
  const parts = step.split('+')
  const modifiers: string[] = []
  let mainKey = ''

  for (const part of parts) {
    const lower = part.trim().toLowerCase()
    if (
      [
        'ctrl',
        'control',
        'alt',
        'opt',
        'option',
        'meta',
        'cmd',
        'command',
        'shift',
      ].includes(lower)
    ) {
      // 规范化修饰符名称
      if (lower === 'control') modifiers.push('ctrl')
      else if (lower === 'option' || lower === 'opt') modifiers.push('alt')
      else if (lower === 'command' || lower === 'cmd') modifiers.push('cmd')
      else modifiers.push(lower)
    } else {
      mainKey = lower
    }
  }

  modifiers.sort()
  return [...modifiers, mainKey].join('+')
}
