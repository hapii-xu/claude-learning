/**
 * 追踪 auto 模式分类器最近拒绝的命令。
 * 在 useCanUseTool.ts 中填充，在 /permissions 的 RecentDenialsTab.tsx 中读取。
 */

import { feature } from 'bun:bundle'

export type AutoModeDenial = {
  toolName: string
  /** 被拒绝命令的人类可读描述（例如 bash 命令字符串） */
  display: string
  reason: string
  timestamp: number
}

let DENIALS: readonly AutoModeDenial[] = []
const MAX_DENIALS = 20

export function recordAutoModeDenial(denial: AutoModeDenial): void {
  if (!feature('TRANSCRIPT_CLASSIFIER')) return
  DENIALS = [denial, ...DENIALS.slice(0, MAX_DENIALS - 1)]
}

export function getAutoModeDenials(): readonly AutoModeDenial[] {
  return DENIALS
}
