import { createStore } from '../../state/store.js'

/**
 * 跟踪"距离 autocompact 剩余 context"警告是否应被抑制。
 * 成功压缩后立即抑制，因为此时还没有准确的 token 计数，需等下一次 API 响应才能获取。
 */
export const compactWarningStore = createStore<boolean>(false)

/** 抑制 compact 警告。在成功压缩后调用。 */
export function suppressCompactWarning(): void {
  compactWarningStore.setState(() => true)
}

/** 清除 compact 警告抑制。在新的 compact 尝试开始时调用。 */
export function clearCompactWarningSuppression(): void {
  compactWarningStore.setState(() => false)
}
