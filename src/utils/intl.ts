/**
 * 共享的 Intl 对象实例，延迟初始化。
 *
 * Intl 构造器开销较大（每个约 0.05-0.1ms），因此我们缓存实例
 * 以供代码库中复用，而非每次创建新的。
 * 延迟初始化确保只在真正需要时才付出开销。
 */

// 用于 Unicode 文本处理的切词器（延迟初始化）
let graphemeSegmenter: Intl.Segmenter | null = null
let wordSegmenter: Intl.Segmenter | null = null

export function getGraphemeSegmenter(): Intl.Segmenter {
  if (!graphemeSegmenter) {
    graphemeSegmenter = new Intl.Segmenter(undefined, {
      granularity: 'grapheme',
    })
  }
  return graphemeSegmenter
}

/**
 * 从字符串中提取第一个字位簇。
 * 对空字符串返回 ''。
 */
export function firstGrapheme(text: string): string {
  if (!text) return ''
  const segments = getGraphemeSegmenter().segment(text)
  const first = segments[Symbol.iterator]().next().value
  return first?.segment ?? ''
}

/**
 * 从字符串中提取最后一个字位簇。
 * 对空字符串返回 ''。
 */
export function lastGrapheme(text: string): string {
  if (!text) return ''
  let last = ''
  for (const { segment } of getGraphemeSegmenter().segment(text)) {
    last = segment
  }
  return last
}

export function getWordSegmenter(): Intl.Segmenter {
  if (!wordSegmenter) {
    wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' })
  }
  return wordSegmenter
}

// RelativeTimeFormat 缓存（以 style:numeric 为键）
const rtfCache = new Map<string, Intl.RelativeTimeFormat>()

export function getRelativeTimeFormat(
  style: 'long' | 'short' | 'narrow',
  numeric: 'always' | 'auto',
): Intl.RelativeTimeFormat {
  const key = `${style}:${numeric}`
  let rtf = rtfCache.get(key)
  if (!rtf) {
    rtf = new Intl.RelativeTimeFormat('en', { style, numeric })
    rtfCache.set(key, rtf)
  }
  return rtf
}

// 时区在进程生命周期内为常量
let cachedTimeZone: string | null = null

export function getTimeZone(): string {
  if (!cachedTimeZone) {
    cachedTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  }
  return cachedTimeZone
}

// 系统 locale 语言子标签（如 'en'、'ja'）在进程生命周期内为常量。
// null = 尚未计算；undefined = 已计算但不可用（因此
// 剥离 ICU 的环境会失败一次，而非每次调用都重试）。
let cachedSystemLocaleLanguage: string | undefined | null = null

export function getSystemLocaleLanguage(): string | undefined {
  if (cachedSystemLocaleLanguage === null) {
    try {
      const locale = Intl.DateTimeFormat().resolvedOptions().locale
      cachedSystemLocaleLanguage = new Intl.Locale(locale).language
    } catch {
      cachedSystemLocaleLanguage = undefined
    }
  }
  return cachedSystemLocaleLanguage
}
