import type { SystemMemorySavedMessage } from '../../types/message.js'

/**
 * 返回记忆已保存 UI 的团队记忆片段，以及计数，
 * 使调用方无需直接访问 teamCount 即可计算私有计数。
 * 普通函数（非 React 组件），防止 React Compiler 将
 * teamCount 属性访问提升做 memoization。
 * 仅在 feature('TEAMMEM') 为 true 时加载此模块。
 */
export function teamMemSavedPart(
  message: SystemMemorySavedMessage,
): { segment: string; count: number } | null {
  const count = (message.teamCount as number | undefined) ?? 0
  if (count === 0) return null
  return {
    segment: `${count} 条团队记忆`,
    count,
  }
}
