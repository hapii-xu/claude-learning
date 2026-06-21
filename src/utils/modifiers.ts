export type ModifierKey = 'shift' | 'command' | 'control' | 'option'

let prewarmed = false

/**
 * 通过提前加载来预热原生模块。
 * 尽早调用以避免首次使用的延迟。
 */
export function prewarmModifiers(): void {
  if (prewarmed || process.platform !== 'darwin') {
    return
  }
  prewarmed = true
  void import('modifiers-napi').then(({ prewarm }) => prewarm()).catch(() => {})
}

/**
 * 检查特定修饰键当前是否被按下（同步）。
 */
export function isModifierPressed(modifier: ModifierKey): boolean {
  if (process.platform !== 'darwin') {
    return false
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { isModifierPressed: nativeIsModifierPressed } =
      require('modifiers-napi') as { isModifierPressed: (m: string) => boolean }
    return nativeIsModifierPressed(modifier)
  } catch {
    return false
  }
}
