/**
 * classifierApprovals 存储的 React hook。
 * 从 classifierApprovals.ts 分离，以便纯状态导入者（permissions.ts、
 * toolExecution.ts、postCompactCleanup.ts）不会将 React 拉入 print.ts。
 */

import { useSyncExternalStore } from 'react'
import {
  isClassifierChecking,
  subscribeClassifierChecking,
} from './classifierApprovals.js'

export function useIsClassifierChecking(toolUseID: string): boolean {
  return useSyncExternalStore(subscribeClassifierChecking, () =>
    isClassifierChecking(toolUseID),
  )
}
