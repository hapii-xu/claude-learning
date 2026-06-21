// 最小化的 cron 表达式解析和下次运行时间计算。
//
// 支持标准 5 字段 cron 子集：
//   minute hour day-of-month month day-of-week
//
// 字段语法：通配符、N、步进（star-slash-N）、范围（N-M）、列表（N,M,...）。
// 不支持 L、W、? 或名称别名。所有时间按进程本地时区解释 ——
// "0 9 * * *" 表示 CLI 运行所在时区的上午 9 点。

export type CronFields = {
  minute: number[]
  hour: number[]
  dayOfMonth: number[]
  month: number[]
  dayOfWeek: number[]
}

type FieldRange = { min: number; max: number }

const FIELD_RANGES: FieldRange[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // dayOfMonth
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 }, // dayOfWeek（0=周日；7 作为周日的别名也可接受）
]

// 将单个 cron 字段解析为排序后的匹配值数组。
// 支持：通配符、N、star-slash-N（步进）、N-M（范围）和逗号列表。
// 无效时返回 null。
function expandField(field: string, range: FieldRange): number[] | null {
  const { min, max } = range
  const out = new Set<number>()

  for (const part of field.split(',')) {
    // 通配符或 star-slash-N
    const stepMatch = part.match(/^\*(?:\/(\d+))?$/)
    if (stepMatch) {
      const step = stepMatch[1] ? parseInt(stepMatch[1], 10) : 1
      if (step < 1) return null
      for (let i = min; i <= max; i += step) out.add(i)
      continue
    }

    // N-M 或 N-M/S
    const rangeMatch = part.match(/^(\d+)-(\d+)(?:\/(\d+))?$/)
    if (rangeMatch) {
      const lo = parseInt(rangeMatch[1]!, 10)
      const hi = parseInt(rangeMatch[2]!, 10)
      const step = rangeMatch[3] ? parseInt(rangeMatch[3], 10) : 1
      // dayOfWeek：在范围中接受 7 作为周日别名（如 5-7 = 周五,周六,周日 → [5,6,0]）
      const isDow = min === 0 && max === 6
      const effMax = isDow ? 7 : max
      if (lo > hi || step < 1 || lo < min || hi > effMax) return null
      for (let i = lo; i <= hi; i += step) {
        out.add(isDow && i === 7 ? 0 : i)
      }
      continue
    }

    // 单个 N
    const singleMatch = part.match(/^\d+$/)
    if (singleMatch) {
      let n = parseInt(part, 10)
      // dayOfWeek：接受 7 作为周日别名 → 0
      if (min === 0 && max === 6 && n === 7) n = 0
      if (n < min || n > max) return null
      out.add(n)
      continue
    }

    return null
  }

  if (out.size === 0) return null
  return Array.from(out).sort((a, b) => a - b)
}

/**
 * 将 5 字段 cron 表达式解析为展开后的数字数组。
 * 无效或不支持的语法时返回 null。
 */
export function parseCronExpression(expr: string): CronFields | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null

  const expanded: number[][] = []
  for (let i = 0; i < 5; i++) {
    const result = expandField(parts[i]!, FIELD_RANGES[i]!)
    if (!result) return null
    expanded.push(result)
  }

  return {
    minute: expanded[0]!,
    hour: expanded[1]!,
    dayOfMonth: expanded[2]!,
    month: expanded[3]!,
    dayOfWeek: expanded[4]!,
  }
}

/**
 * 计算严格晚于 `from` 且匹配 cron 字段的下一个 Date，
 * 使用进程的本地时区。逐分钟向前推进。上限为 366 天；
 * 无匹配时返回 null（对有效 cron 不可能发生，但可满足类型要求）。
 *
 * 标准 cron 语义：当 dayOfMonth 和 dayOfWeek 都被约束
 *（两者都不是完整范围）时，任一匹配即可（OR 语义）。
 *
 * 夏令时：针对前移间隙的固定小时 cron（如美国时区中的
 * `30 2 * * *`）会跳过转换日 —— 间隙小时在本地时间中
 * 从不出现，因此小时集检查失败，循环继续。通配符小时 cron
 *（`30 * * * *`）在间隙后的第一个有效分钟触发。后向重复
 * 仅触发一次（步进逻辑跳过第二次出现）。这与 vixie-cron
 * 行为一致。
 */
export function computeNextCronRun(
  fields: CronFields,
  from: Date,
): Date | null {
  const minuteSet = new Set(fields.minute)
  const hourSet = new Set(fields.hour)
  const domSet = new Set(fields.dayOfMonth)
  const monthSet = new Set(fields.month)
  const dowSet = new Set(fields.dayOfWeek)

  // 字段是否为通配符（完整范围）？
  const domWild = fields.dayOfMonth.length === 31
  const dowWild = fields.dayOfWeek.length === 7

  // 向上取整到下一个整分钟（严格晚于 `from`）
  const t = new Date(from.getTime())
  t.setSeconds(0, 0)
  t.setMinutes(t.getMinutes() + 1)

  const maxIter = 366 * 24 * 60
  for (let i = 0; i < maxIter; i++) {
    const month = t.getMonth() + 1
    if (!monthSet.has(month)) {
      // 跳到下个月的第一天
      t.setMonth(t.getMonth() + 1, 1)
      t.setHours(0, 0, 0, 0)
      continue
    }

    const dom = t.getDate()
    const dow = t.getDay()
    // 当 dom/dow 都被约束时，任一匹配即可（OR 语义）
    const dayMatches =
      domWild && dowWild
        ? true
        : domWild
          ? dowSet.has(dow)
          : dowWild
            ? domSet.has(dom)
            : domSet.has(dom) || dowSet.has(dow)

    if (!dayMatches) {
      // 跳到下一天
      t.setDate(t.getDate() + 1)
      t.setHours(0, 0, 0, 0)
      continue
    }

    if (!hourSet.has(t.getHours())) {
      t.setHours(t.getHours() + 1, 0, 0, 0)
      continue
    }

    if (!minuteSet.has(t.getMinutes())) {
      t.setMinutes(t.getMinutes() + 1)
      continue
    }

    return t
  }

  return null
}

// --- cronToHuman ------------------------------------------------------------
// 有意缩小范围：覆盖常见模式；其他情况回退到原始 cron 字符串。
// `utc` 选项用于 CCR 远程触发器（agents-platform.tsx），它们在服务器上运行
// 并始终使用 UTC cron 字符串 —— 该路径将 UTC→本地时间转换用于显示，
// 并需要工作日情况的跨午夜逻辑。本地计划任务（默认）两者都不需要。

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
]

function formatLocalTime(minute: number, hour: number): string {
  // 1 月 1 日 —— 任何地方都没有夏令时间隙。使用 `new Date()`（今天）
  // 会在每年一次的前移日将 2am→3am。
  const d = new Date(2000, 0, 1, hour, minute)
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

function formatUtcTimeAsLocal(minute: number, hour: number): string {
  // 以 UTC 创建日期并以用户本地时区格式化
  const d = new Date()
  d.setUTCHours(hour, minute, 0, 0)
  return d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  })
}

export function cronToHuman(cron: string, opts?: { utc?: boolean }): string {
  const utc = opts?.utc ?? false
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return cron

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [
    string,
    string,
    string,
    string,
    string,
  ]

  // 每 N 分钟：step/N * * * *
  const everyMinMatch = minute.match(/^\*\/(\d+)$/)
  if (
    everyMinMatch &&
    hour === '*' &&
    dayOfMonth === '*' &&
    month === '*' &&
    dayOfWeek === '*'
  ) {
    const n = parseInt(everyMinMatch[1]!, 10)
    return n === 1 ? 'Every minute' : `Every ${n} minutes`
  }

  // 每小时：0 * * * *
  if (
    minute.match(/^\d+$/) &&
    hour === '*' &&
    dayOfMonth === '*' &&
    month === '*' &&
    dayOfWeek === '*'
  ) {
    const m = parseInt(minute, 10)
    if (m === 0) return 'Every hour'
    return `Every hour at :${m.toString().padStart(2, '0')}`
  }

  // 每 N 小时：0 step/N * * *
  const everyHourMatch = hour.match(/^\*\/(\d+)$/)
  if (
    minute.match(/^\d+$/) &&
    everyHourMatch &&
    dayOfMonth === '*' &&
    month === '*' &&
    dayOfWeek === '*'
  ) {
    const n = parseInt(everyHourMatch[1]!, 10)
    const m = parseInt(minute, 10)
    const suffix = m === 0 ? '' : ` at :${m.toString().padStart(2, '0')}`
    return n === 1 ? `Every hour${suffix}` : `Every ${n} hours${suffix}`
  }

  // --- 剩余情况引用小时+分钟：按 utc 分支 ----------------

  if (!minute.match(/^\d+$/) || !hour.match(/^\d+$/)) return cron
  const m = parseInt(minute, 10)
  const h = parseInt(hour, 10)
  const fmtTime = utc ? formatUtcTimeAsLocal : formatLocalTime

  // 每天特定时间：M H * * *
  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `Every day at ${fmtTime(m, h)}`
  }

  // 特定星期几：M H * * D
  if (dayOfMonth === '*' && month === '*' && dayOfWeek.match(/^\d$/)) {
    const dayIndex = parseInt(dayOfWeek, 10) % 7 // 规范化 7（周日别名）-> 0
    let dayName: string | undefined
    if (utc) {
      // UTC 日期+时间可能落在不同的本地日期（跨午夜）。
      // 通过构造 UTC 时刻来计算实际的本地星期几。
      const ref = new Date()
      const daysToAdd = (dayIndex - ref.getUTCDay() + 7) % 7
      ref.setUTCDate(ref.getUTCDate() + daysToAdd)
      ref.setUTCHours(h, m, 0, 0)
      dayName = DAY_NAMES[ref.getDay()]
    } else {
      dayName = DAY_NAMES[dayIndex]
    }
    if (dayName) return `Every ${dayName} at ${fmtTime(m, h)}`
  }

  // 工作日：M H * * 1-5
  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '1-5') {
    return `Weekdays at ${fmtTime(m, h)}`
  }

  return cron
}
