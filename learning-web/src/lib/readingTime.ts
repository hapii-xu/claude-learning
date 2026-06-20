import type { LearningModule } from '@/data/types'

/**
 * 计算模块的预计阅读时间（分钟）
 * 基于：
 * - 文件数量（每个文件约 2 分钟阅读）
 * - 文档数量（每篇文档约 5 分钟阅读）
 * - 描述长度（每 500 字约 1 分钟）
 */
export function estimateReadingTime(mod: LearningModule): number {
  const fileTime = mod.files.length * 2
  const docTime = (mod.docPaths?.length || 0) * 5
  const descTime = Math.ceil(mod.description.length / 500)
  const conceptTime = (mod.keyConcepts?.length || 0) * 0.5

  return Math.max(1, Math.round(fileTime + docTime + descTime + conceptTime))
}

/**
 * 格式化阅读时间为可读字符串
 */
export function formatReadingTime(minutes: number): string {
  if (minutes < 1) return '< 1 分钟'
  if (minutes < 60) return `约 ${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const remainingMins = minutes % 60
  if (remainingMins === 0) return `约 ${hours} 小时`
  return `约 ${hours} 小时 ${remainingMins} 分钟`
}
