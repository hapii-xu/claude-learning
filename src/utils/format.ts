// 纯显示格式化工具 — 叶子安全（无 Ink）。宽度感知截断位于 ./truncate.ts。

import { getRelativeTimeFormat, getTimeZone } from './intl.js'

/**
 * 将字节数格式化为人类可读的字符串（KB、MB、GB）。
 * @example formatFileSize(1536) → "1.5KB"
 */
export function formatFileSize(sizeInBytes: number): string {
  const kb = sizeInBytes / 1024
  if (kb < 1) {
    return `${sizeInBytes} bytes`
  }
  if (kb < 1024) {
    return `${kb.toFixed(1).replace(/\.0$/, '')}KB`
  }
  const mb = kb / 1024
  if (mb < 1024) {
    return `${mb.toFixed(1).replace(/\.0$/, '')}MB`
  }
  const gb = mb / 1024
  return `${gb.toFixed(1).replace(/\.0$/, '')}GB`
}

/**
 * 将毫秒格式化为保留 1 位小数的秒数（如 `1234` → `"1.2s"`）。
 * 与 formatDuration 不同，始终保留小数 — 用于分钟以内的计时，
 * 其中小数秒有意义（TTFT、钩子持续时间等）。
 */
export function formatSecondsShort(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

export function formatDuration(
  ms: number,
  options?: { hideTrailingZeros?: boolean; mostSignificantOnly?: boolean },
): string {
  if (ms < 60000) {
    // 0 的特殊处理
    if (ms === 0) {
      return '0s'
    }
    // 对于 < 1s 的时长，显示 1 位小数（如 0.5s）
    if (ms < 1) {
      const s = (ms / 1000).toFixed(1)
      return `${s}s`
    }
    const s = Math.floor(ms / 1000).toString()
    return `${s}s`
  }

  let days = Math.floor(ms / 86400000)
  let hours = Math.floor((ms % 86400000) / 3600000)
  let minutes = Math.floor((ms % 3600000) / 60000)
  let seconds = Math.round((ms % 60000) / 1000)

  // 处理进位（如 59.5s 四舍五入为 60s）
  if (seconds === 60) {
    seconds = 0
    minutes++
  }
  if (minutes === 60) {
    minutes = 0
    hours++
  }
  if (hours === 24) {
    hours = 0
    days++
  }

  const hide = options?.hideTrailingZeros

  if (options?.mostSignificantOnly) {
    if (days > 0) return `${days}d`
    if (hours > 0) return `${hours}h`
    if (minutes > 0) return `${minutes}m`
    return `${seconds}s`
  }

  if (days > 0) {
    if (hide && hours === 0 && minutes === 0) return `${days}d`
    if (hide && minutes === 0) return `${days}d ${hours}h`
    return `${days}d ${hours}h ${minutes}m`
  }
  if (hours > 0) {
    if (hide && minutes === 0 && seconds === 0) return `${hours}h`
    if (hide && seconds === 0) return `${hours}h ${minutes}m`
    return `${hours}h ${minutes}m ${seconds}s`
  }
  if (minutes > 0) {
    if (hide && seconds === 0) return `${minutes}m`
    return `${minutes}m ${seconds}s`
  }
  return `${seconds}s`
}

// `new Intl.NumberFormat` 开销较大，因此缓存格式化器以复用
let numberFormatterForConsistentDecimals: Intl.NumberFormat | null = null
let numberFormatterForInconsistentDecimals: Intl.NumberFormat | null = null
const getNumberFormatter = (
  useConsistentDecimals: boolean,
): Intl.NumberFormat => {
  if (useConsistentDecimals) {
    if (!numberFormatterForConsistentDecimals) {
      numberFormatterForConsistentDecimals = new Intl.NumberFormat('en-US', {
        notation: 'compact',
        maximumFractionDigits: 1,
        minimumFractionDigits: 1,
      })
    }
    return numberFormatterForConsistentDecimals
  } else {
    if (!numberFormatterForInconsistentDecimals) {
      numberFormatterForInconsistentDecimals = new Intl.NumberFormat('en-US', {
        notation: 'compact',
        maximumFractionDigits: 1,
        minimumFractionDigits: 0,
      })
    }
    return numberFormatterForInconsistentDecimals
  }
}

export function formatNumber(number: number): string {
  // 仅对将以紧凑记法显示的数字使用 minimumFractionDigits
  const shouldUseConsistentDecimals = number >= 1000

  return getNumberFormatter(shouldUseConsistentDecimals)
    .format(number) // 如 "1321" => "1.3K"，"900" => "900"
    .toLowerCase() // 如 "1.3K" => "1.3k"，"1.0K" => "1.0k"
}

export function formatTokens(count: number): string {
  return formatNumber(count).replace('.0', '')
}

type RelativeTimeStyle = 'long' | 'short' | 'narrow'

type RelativeTimeOptions = {
  style?: RelativeTimeStyle
  numeric?: 'always' | 'auto'
}

export function formatRelativeTime(
  date: Date,
  options: RelativeTimeOptions & { now?: Date } = {},
): string {
  const { style = 'narrow', numeric = 'always', now = new Date() } = options
  const diffInMs = date.getTime() - now.getTime()
  // 使用 Math.trunc 对正负值均向零截断
  const diffInSeconds = Math.trunc(diffInMs / 1000)

  // 定义带自定义短单位的时间间隔
  const intervals = [
    { unit: 'year', seconds: 31536000, shortUnit: 'y' },
    { unit: 'month', seconds: 2592000, shortUnit: 'mo' },
    { unit: 'week', seconds: 604800, shortUnit: 'w' },
    { unit: 'day', seconds: 86400, shortUnit: 'd' },
    { unit: 'hour', seconds: 3600, shortUnit: 'h' },
    { unit: 'minute', seconds: 60, shortUnit: 'm' },
    { unit: 'second', seconds: 1, shortUnit: 's' },
  ] as const

  // 找到合适的单位
  for (const { unit, seconds: intervalSeconds, shortUnit } of intervals) {
    if (Math.abs(diffInSeconds) >= intervalSeconds) {
      const value = Math.trunc(diffInSeconds / intervalSeconds)
      // 对于短样式，使用自定义格式
      if (style === 'narrow') {
        return diffInSeconds < 0
          ? `${Math.abs(value)}${shortUnit} ago`
          : `in ${value}${shortUnit}`
      }
      // 对于天及更长时间，无论 style 参数如何，均使用 long 样式
      return getRelativeTimeFormat('long', numeric).format(value, unit)
    }
  }

  // 对于不足 1 秒的值
  if (style === 'narrow') {
    return diffInSeconds <= 0 ? '0s ago' : 'in 0s'
  }
  return getRelativeTimeFormat(style, numeric).format(0, 'second')
}

export function formatRelativeTimeAgo(
  date: Date,
  options: RelativeTimeOptions & { now?: Date } = {},
): string {
  const { now = new Date(), ...restOptions } = options
  if (date > now) {
    // 对于将来的日期，只返回相对时间，不加"ago"
    return formatRelativeTime(date, { ...restOptions, now })
  }

  // 对于过去的日期，强制 numeric: 'always' 以确保得到"X 单位前"格式
  return formatRelativeTime(date, { ...restOptions, numeric: 'always', now })
}

/**
 * 格式化日志元数据用于显示（时间、大小或消息数、分支、标签、PR）
 */
export function formatLogMetadata(log: {
  modified: Date
  messageCount: number
  fileSize?: number
  gitBranch?: string
  tag?: string
  agentSetting?: string
  prNumber?: number
  prRepository?: string
}): string {
  const sizeOrCount =
    log.fileSize !== undefined
      ? formatFileSize(log.fileSize)
      : `${log.messageCount} messages`
  const parts = [
    formatRelativeTimeAgo(log.modified, { style: 'short' }),
    ...(log.gitBranch ? [log.gitBranch] : []),
    sizeOrCount,
  ]
  if (log.tag) {
    parts.push(`#${log.tag}`)
  }
  if (log.agentSetting) {
    parts.push(`@${log.agentSetting}`)
  }
  if (log.prNumber) {
    parts.push(
      log.prRepository
        ? `${log.prRepository}#${log.prNumber}`
        : `#${log.prNumber}`,
    )
  }
  return parts.join(' · ')
}

export function formatResetTime(
  timestampInSeconds: number | undefined,
  showTimezone: boolean = false,
  showTime: boolean = true,
): string | undefined {
  if (!timestampInSeconds) return undefined

  const date = new Date(timestampInSeconds * 1000)
  const now = new Date()
  const minutes = date.getMinutes()

  // 计算到重置的小时数
  const hoursUntilReset = (date.getTime() - now.getTime()) / (1000 * 60 * 60)

  // 若重置时间超过 24 小时，同时显示日期
  if (hoursUntilReset > 24) {
    // 对超过一天后才重置的情况，显示日期和时间
    const dateOptions: Intl.DateTimeFormatOptions = {
      month: 'short',
      day: 'numeric',
      hour: showTime ? 'numeric' : undefined,
      minute: !showTime || minutes === 0 ? undefined : '2-digit',
      hour12: showTime ? true : undefined,
    }

    // 若不是当前年份则添加年份
    if (date.getFullYear() !== now.getFullYear()) {
      dateOptions.year = 'numeric'
    }

    const dateString = date.toLocaleString('en-US', dateOptions)

    // 删除 AM/PM 前的空格并转为小写
    return (
      dateString.replace(/ ([AP]M)/i, (_match, ampm) => ampm.toLowerCase()) +
      (showTimezone ? ` (${getTimeZone()})` : '')
    )
  }

  // 对于 24 小时内的重置，只显示时间（现有行为）
  const timeString = date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: minutes === 0 ? undefined : '2-digit',
    hour12: true,
  })

  // 删除 AM/PM 前的空格并转为小写，然后添加时区
  return (
    timeString.replace(/ ([AP]M)/i, (_match, ampm) => ampm.toLowerCase()) +
    (showTimezone ? ` (${getTimeZone()})` : '')
  )
}

export function formatResetText(
  resetsAt: string,
  showTimezone: boolean = false,
  showTime: boolean = true,
): string {
  const dt = new Date(resetsAt)
  return `${formatResetTime(Math.floor(dt.getTime() / 1000), showTimezone, showTime)}`
}

// 向后兼容：截断辅助函数已移至 ./truncate.ts（需要 ink/stringWidth）
export {
  truncate,
  truncatePathMiddle,
  truncateStartToWidth,
  truncateToWidth,
  truncateToWidthNoEllipsis,
  wrapText,
} from './truncate.js'
