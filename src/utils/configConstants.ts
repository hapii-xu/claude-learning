// 这些常量放在单独的文件中以避免循环依赖问题。
// 不要向此文件添加 import —— 必须保持无依赖。

export const NOTIFICATION_CHANNELS = [
  'auto',
  'iterm2',
  'iterm2_with_bell',
  'terminal_bell',
  'kitty',
  'ghostty',
  'notifications_disabled',
] as const

// 有效的编辑器模式（不包括已废弃的 'emacs'，它会自动迁移到 'normal'）
export const EDITOR_MODES = ['normal', 'vim'] as const

// 用于生成 teammate 的有效 teammate 模式
// 'tmux' = 传统的基于 tmux 的 teammate
// 'in-process' = 在同一进程中运行的进程内 teammate
// 'auto' = 根据上下文自动选择（默认）
export const TEAMMATE_MODES = ['auto', 'tmux', 'in-process'] as const
