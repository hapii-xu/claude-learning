import { env } from '../utils/env.js'

// 前者在垂直对齐上更好，但通常在 Windows/Linux 上不被支持
export const BLACK_CIRCLE = env.platform === 'darwin' ? '⏺' : '●'
export const BULLET_OPERATOR = '∙'
export const TEARDROP_ASTERISK = '✻'
export const UP_ARROW = '\u2191' // ↑ - 用于 opus 1m 合并通知
export const DOWN_ARROW = '\u2193' // ↓ - 用于滚动提示
export const LIGHTNING_BOLT = '↯' // \u21af - 用于 fast 模式指示器
export const EFFORT_LOW = '○' // \u25cb - 努力等级：低
export const EFFORT_MEDIUM = '◐' // \u25d0 - 努力等级：中
export const EFFORT_HIGH = '●' // \u25cf - 努力等级：高
export const EFFORT_XHIGH = '⦿' // \u29bf - 努力等级：超高（仅 Opus 4.7）
export const EFFORT_MAX = '◉' // \u25c9 - 努力等级：最大（仅 Opus 4.6/4.7）

// 媒体/触发器状态指示器
export const PLAY_ICON = '\u25b6' // ▶
export const PAUSE_ICON = '\u23f8' // ⏸

// MCP 订阅指示器
export const REFRESH_ARROW = '\u21bb' // ↻ - 用于资源更新指示器
export const CHANNEL_ARROW = '\u2190' // ← - 入站频道消息指示器
export const INJECTED_ARROW = '\u2192' // → - 跨会话注入消息指示器
export const FORK_GLYPH = '\u2442' // ⑂ - fork 指令指示器

// 评审状态指示器（ultrareview 菱形状态）
export const DIAMOND_OPEN = '\u25c7' // ◇ - 运行中
export const DIAMOND_FILLED = '\u25c6' // ◆ - 已完成/失败
export const REFERENCE_MARK = '\u203b' // ※ - komejirushi，离开摘要回顾标记

// Issue 标记指示器
export const FLAG_ICON = '\u2691' // ⚑ - 用于 issue 标记横幅

// 引用块指示器
export const BLOCKQUOTE_BAR = '\u258e' // ▎ - 左侧四分之一方块，用作引用块行首前缀
export const HEAVY_HORIZONTAL = '\u2501' // ━ - 粗实线框绘制水平线

// Bridge 状态指示器
export const BRIDGE_SPINNER_FRAMES = [
  '\u00b7|\u00b7',
  '\u00b7/\u00b7',
  '\u00b7\u2014\u00b7',
  '\u00b7\\\u00b7',
]
export const BRIDGE_READY_INDICATOR = '\u00b7\u2714\ufe0e\u00b7'
export const BRIDGE_FAILED_INDICATOR = '\u00d7'
