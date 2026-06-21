/**
 * 为 brief/chat 消息标签行格式化 ISO 时间戳。
 *
 * 显示随年龄缩放（类似聊天应用）：
 *   - 同一天：      "1:30 PM" 或 "13:30"（依赖 locale）
 *   - 6 天内：       "Sunday, 4:15 PM"（依赖 locale）
 *   - 更早：         "Sunday, Feb 20, 4:30 PM"（依赖 locale）
 *
 * 遵循 POSIX locale 环境变量（LC_ALL > LC_TIME > LANG）以决定时间格式
 * （12/24 小时制）、工作日名、月份名和整体结构。
 * Bun/V8 的 `toLocaleString(undefined)` 在 macOS 上会忽略这些，
 * 因此我们自行将它们转换为 BCP 47 标签。
 *
 * `now` 可注入以便测试。
 */
export function formatBriefTimestamp(
  isoString: string,
  now: Date = new Date(),
): string {
  const d = new Date(isoString)
  if (Number.isNaN(d.getTime())) {
    return ''
  }

  const locale = getLocale()
  const dayDiff = startOfDay(now) - startOfDay(d)
  const daysAgo = Math.round(dayDiff / 86_400_000)

  if (daysAgo === 0) {
    return d.toLocaleTimeString(locale, {
      hour: 'numeric',
      minute: '2-digit',
    })
  }

  if (daysAgo > 0 && daysAgo < 7) {
    return d.toLocaleString(locale, {
      weekday: 'long',
      hour: 'numeric',
      minute: '2-digit',
    })
  }

  return d.toLocaleString(locale, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/**
 * 从 POSIX 环境变量派生 BCP 47 locale 标签。
 * LC_ALL > LC_TIME > LANG，回退到 undefined（系统默认）。
 * 将 POSIX 格式（en_GB.UTF-8）转换为 BCP 47（en-GB）。
 */
function getLocale(): string | undefined {
  const raw =
    process.env.LC_ALL || process.env.LC_TIME || process.env.LANG || ''
  if (!raw || raw === 'C' || raw === 'POSIX') {
    return undefined
  }
  // 剥离 codeset（.UTF-8）和 modifier（@euro），将 _ 替换为 -
  const base = raw.split('.')[0]!.split('@')[0]!
  if (!base) {
    return undefined
  }
  const tag = base.replaceAll('_', '-')
  // 通过构造 Intl locale 进行校验 - 无效标签会抛出
  try {
    new Intl.DateTimeFormat(tag)
    return tag
  } catch {
    return undefined
  }
}

/** 返回 `d` 的本地日历日起点的 epoch 毫秒值。 */
function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}
