import { useSyncExternalStore } from 'react'
import { compactWarningStore } from './compactWarningState.js'

/**
 * 订阅 compact 警告抑制状态的 React hook。
 *
 * 独立成文件是为了让 compactWarningState.ts 保持无 React 依赖：
 * microCompact.ts 只导入纯状态函数，若将 React 引入该模块图，
 * 会把 React 拖入 print-mode 启动路径。
 */
export function useCompactWarningSuppression(): boolean {
  return useSyncExternalStore(
    compactWarningStore.subscribe,
    compactWarningStore.getState,
  )
}
