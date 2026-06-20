import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import { loadKeybindingsSync } from './loadUserBindings.js'
import { getBindingDisplayText } from './resolver.js'
import type { KeybindingContextName } from './types.js'

// TODO(keybindings-migration): 迁移完成后移除 fallback 参数，
// 并确认没有 'keybinding_fallback_used' 事件被记录。
// fallback 作为迁移期间的安全网存在 - 如果绑定加载失败
// 或找不到操作，我们会回退到硬编码值。一旦稳定，调用方
// 应该可以信任 getBindingDisplayText 对已知操作始终返回值，
// 我们可以移除这种防御性模式。

// 跟踪已经记录过 fallback 事件的 action+context 对，
// 以避免在非 React 上下文中重复调用时产生重复事件。
const LOGGED_FALLBACKS = new Set<string>()

/**
 * 获取已配置快捷键的显示文本，不使用 React hooks。
 * 在非 React 上下文中使用（命令、服务等）。
 *
 * 此函数位于独立模块（而非 useShortcutDisplay.ts），
 * 以便非 React 调用方（如 query/stopHooks.ts）不会通过
 * 同级 hook 将 React 拉入其模块图。
 *
 * @param action - 操作名称（例如 'app:toggleTranscript'）
 * @param context - 快捷键上下文（例如 'Global'）
 * @param fallback - 未找到绑定时的备选文本
 * @returns 已配置的快捷键显示文本
 *
 * @example
 * const expandShortcut = getShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o')
 * // 返回用户配置的绑定，或默认值 'ctrl+o'
 */
export function getShortcutDisplay(
  action: string,
  context: KeybindingContextName,
  fallback: string,
): string {
  const bindings = loadKeybindingsSync()
  const resolved = getBindingDisplayText(action, context, bindings)
  if (resolved === undefined) {
    const key = `${action}:${context}`
    if (!LOGGED_FALLBACKS.has(key)) {
      LOGGED_FALLBACKS.add(key)
      logEvent('tengu_keybinding_fallback_used', {
        action:
          action as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        context:
          context as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        fallback:
          fallback as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        reason:
          'action_not_found' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
    }
    return fallback
  }
  return resolved
}
