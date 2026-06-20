import { getInitialSettings } from '../settings/settings.js'

/**
 * 解析输入框 `!` 命令使用的默认 shell。
 *
 * 解析顺序（见 docs/design/ps-shell-selection.md §4.2）：
 *   settings.defaultShell → 'bash'
 *
 * 全平台默认都是 'bash' — 我们不会自动把 Windows 切换为
 * PowerShell（否则会破坏已有依赖 bash hook 的 Windows 用户）。
 */
export function resolveDefaultShell(): 'bash' | 'powershell' {
  return getInitialSettings().defaultShell ?? 'bash'
}
