import memoize from 'lodash-es/memoize.js'

// 本函数用于获取本地日期的 ISO 格式
export function getLocalISODate(): string {
  // 检查仅限 ant 内部使用的日期覆盖
  if (process.env.CLAUDE_CODE_OVERRIDE_DATE) {
    return process.env.CLAUDE_CODE_OVERRIDE_DATE
  }

  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

// 通过 memoize 保持 prompt 缓存稳定性 —— 在会话开始时捕获一次日期。
// 主交互路径在 context.ts 中通过 memoize(getUserContext) 已经具备此行为；
// 简单模式（--bare）每次请求都会调用 getSystemPrompt，需要显式缓存日期，
// 以免午夜时缓存前缀被击穿。午夜过后，getDateChangeAttachments
// 会在末尾追加新日期（但简单模式禁用了 attachments，因此这里的权衡是：
// 午夜后日期过期 vs. 几乎整段对话的缓存击穿 —— 选择前者）。
export const getSessionStartDate = memoize(getLocalISODate)

// 以用户本地时区返回「月份 年份」（例如「February 2026」）。
// 按月变化而非按日变化 —— 用于工具 prompt 以尽量减少缓存击穿。
export function getLocalMonthYear(): string {
  const date = process.env.CLAUDE_CODE_OVERRIDE_DATE
    ? new Date(process.env.CLAUDE_CODE_OVERRIDE_DATE)
    : new Date()
  return date.toLocaleString('en-US', { month: 'long', year: 'numeric' })
}
