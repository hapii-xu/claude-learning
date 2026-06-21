import {
  clearBetaHeaderLatches,
  clearSystemPromptSectionState,
  getSystemPromptSectionCache,
  setSystemPromptSectionCacheEntry,
} from '../bootstrap/state.js'
import { logForDebugging } from '../utils/debug.js'

type ComputeFn = () => string | null | Promise<string | null>

type SystemPromptSection = {
  name: string
  compute: ComputeFn
  cacheBreak: boolean
}

/**
 * 创建一个已 memoize 的系统 prompt 段。
 * 计算一次，在 /clear 或 /compact 之前会被缓存。
 */
export function systemPromptSection(
  name: string,
  compute: ComputeFn,
): SystemPromptSection {
  return { name, compute, cacheBreak: false }
}

/**
 * 创建一个易失性的系统 prompt 段，每回合（turn）都会重新计算。
 * 当值变化时，这**会**击穿 prompt 缓存。
 * 需要提供理由，解释为何必须击穿缓存。
 */
export function DANGEROUS_uncachedSystemPromptSection(
  name: string,
  compute: ComputeFn,
  _reason: string,
): SystemPromptSection {
  return { name, compute, cacheBreak: true }
}

/**
 * 解析所有系统 prompt 段，返回 prompt 字符串。
 */
export async function resolveSystemPromptSections(
  sections: SystemPromptSection[],
): Promise<(string | null)[]> {
  const cache = getSystemPromptSectionCache()
  logForDebugging(
    `[Hapii] SystemPromptSections.resolve 开始 sectionCount=${sections.length} names=[${sections.map(s => s.name).join(', ')}]`,
    { level: 'info' },
  )

  const results = await Promise.all(
    sections.map(async s => {
      const cached = !s.cacheBreak && cache.has(s.name)
      if (cached) {
        logForDebugging(
          `[Hapii] SystemPromptSections section="${s.name}" 命中缓存`,
          { level: 'info' },
        )
        return cache.get(s.name) ?? null
      }
      logForDebugging(
        `[Hapii] SystemPromptSections section="${s.name}" ${s.cacheBreak ? '强制重算(cacheBreak)' : '首次计算'}`,
        { level: 'info' },
      )
      const value = await s.compute()
      setSystemPromptSectionCacheEntry(s.name, value)
      return value
    }),
  )

  logForDebugging(
    `[Hapii] SystemPromptSections.resolve 完成 nullCount=${results.filter(r => r === null).length}`,
    { level: 'info' },
  )
  return results
}

/**
 * 清除所有系统 prompt 段的状态。在 /clear 和 /compact 时调用。
 * 同时重置 beta header 锁存器，以便新会话能重新
 * 评估 AFK/fast-mode/cache-editing 等 header。
 */
export function clearSystemPromptSections(): void {
  logForDebugging(
    '[Hapii] SystemPromptSections.clear 清除所有 section 缓存 + beta header 锁存器',
    { level: 'info' },
  )
  clearSystemPromptSectionState()
  clearBetaHeaderLatches()
}
