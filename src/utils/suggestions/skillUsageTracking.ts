import { getGlobalConfig, saveGlobalConfig } from '../config.js'

const SKILL_USAGE_DEBOUNCE_MS = 60_000

// 进程生命周期内的防抖缓存 — 避免防抖调用时的锁竞争 + 读取 + 解析开销。
// 与 config.ts 中的 lastConfigStatTime / globalConfigWriteCount 采用相同模式。
const lastWriteBySkill = new Map<string, number>()

/**
 * 记录技能使用次数，用于排序。
 * 同时更新使用次数和最后使用时间。
 */
export function recordSkillUsage(skillName: string): void {
  const now = Date.now()
  const lastWrite = lastWriteBySkill.get(skillName)
  // 排序算法采用 7 天半衰期，因此分钟级精度毫无意义。
  // 在 saveGlobalConfig 之前提前返回，以避免锁竞争 + 文件 I/O。
  if (lastWrite !== undefined && now - lastWrite < SKILL_USAGE_DEBOUNCE_MS) {
    return
  }
  lastWriteBySkill.set(skillName, now)
  saveGlobalConfig(current => {
    const existing = current.skillUsage?.[skillName]
    return {
      ...current,
      skillUsage: {
        ...current.skillUsage,
        [skillName]: {
          usageCount: (existing?.usageCount ?? 0) + 1,
          lastUsedAt: now,
        },
      },
    }
  })
}

/**
 * 根据使用频率和最近使用情况，计算技能的得分。
 * 得分越高，表示该技能使用越频繁、越近期。
 *
 * 得分采用指数衰减，半衰期为 7 天，
 * 即 7 天前的使用量仅相当于今天使用量的一半。
 */
export function getSkillUsageScore(skillName: string): number {
  const config = getGlobalConfig()
  const usage = config.skillUsage?.[skillName]
  if (!usage) return 0

  // 最近使用衰减：每 7 天得分减半
  const daysSinceUse = (Date.now() - usage.lastUsedAt) / (1000 * 60 * 60 * 24)
  const recencyFactor = 0.5 ** (daysSinceUse / 7)

  // 最近使用因子最低为 0.1，避免将旧但高频使用的技能完全淘汰
  return usage.usageCount * Math.max(recencyFactor, 0.1)
}
