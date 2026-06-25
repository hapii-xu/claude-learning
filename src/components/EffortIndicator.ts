import {
  EFFORT_HIGH,
  EFFORT_LOW,
  EFFORT_MAX,
  EFFORT_MEDIUM,
  EFFORT_XHIGH,
} from '../constants/figures.js'
import {
  type EffortLevel,
  type EffortValue,
  getDisplayedEffortLevel,
  modelSupportsEffort,
} from '../utils/effort.js'

/**
 * 构建 effort 变更通知的文本，例如 "◐ medium · /effort"。
 * 若模型不支持 effort，则返回 undefined。
 */
export function getEffortNotificationText(
  effortValue: EffortValue | undefined,
  model: string,
): string | undefined {
  if (!modelSupportsEffort(model)) return undefined
  const level = getDisplayedEffortLevel(model, effortValue)
  return `${effortLevelToSymbol(level)} ${level} · /effort`
}

export function effortLevelToSymbol(level: EffortLevel): string {
  switch (level) {
    case 'low':
      return EFFORT_LOW
    case 'medium':
      return EFFORT_MEDIUM
    case 'high':
      return EFFORT_HIGH
    case 'xhigh':
      return EFFORT_XHIGH
    case 'max':
      return EFFORT_MAX
    default:
      // 防御式：level 可能来自远程配置。若有未知值漏过，
      // 渲染 high 档符号而非 undefined。
      return EFFORT_HIGH
  }
}
