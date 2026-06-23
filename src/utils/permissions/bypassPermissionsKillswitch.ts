import { feature } from 'bun:bundle'
import { useEffect, useRef } from 'react'
import { toError } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { getIsRemoteMode } from '../../bootstrap/state.js'
import {
  useAppState,
  useAppStateStore,
  useSetAppState,
} from '../../state/AppState.js'
import type { ToolPermissionContext } from '../../Tool.js'
import { verifyAutoModeGateAccess } from './permissionSetup.js'

/**
 * 空操作 — bypass permissions 始终可用。
 */
export async function checkAndDisableBypassPermissionsIfNeeded(
  _toolPermissionContext: ToolPermissionContext,
  _setAppState: (
    f: (
      prev: import('../../state/AppState.js').AppState,
    ) => import('../../state/AppState.js').AppState,
  ) => void,
): Promise<void> {
  // Bypass permissions 始终可用 — 无需门控检查
}

/**
 * 重置桩 — 保留以保持接口兼容。
 */
export function resetBypassPermissionsCheck(): void {
  // 空操作
}

/**
 * 空操作 hook — bypass permissions 始终可用。
 */
export function useKickOffCheckAndDisableBypassPermissionsIfNeeded(): void {
  // 空操作
}

let autoModeCheckRan = false

export async function checkAndDisableAutoModeIfNeeded(
  toolPermissionContext: ToolPermissionContext,
  setAppState: (
    f: (
      prev: import('../../state/AppState.js').AppState,
    ) => import('../../state/AppState.js').AppState,
  ) => void,
  fastMode?: boolean,
): Promise<void> {
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    if (autoModeCheckRan) {
      return
    }
    autoModeCheckRan = true

    const { updateContext, notification } = await verifyAutoModeGateAccess(
      toolPermissionContext,
      fastMode,
    )
    setAppState(prev => {
      const nextCtx = updateContext(prev.toolPermissionContext)
      const newState =
        nextCtx === prev.toolPermissionContext
          ? prev
          : { ...prev, toolPermissionContext: nextCtx }
      if (!notification) return newState
      return {
        ...newState,
        notifications: {
          ...newState.notifications,
          queue: [
            ...newState.notifications.queue,
            {
              key: 'auto-mode-gate-notification',
              text: notification,
              color: 'warning' as const,
              priority: 'high' as const,
            },
          ],
        },
      }
    })
  }
}

/**
 * 重置 checkAndDisableAutoModeIfNeeded 的单次运行标志。
 * 在 /login 之后调用此函数，以便使用新组织重新执行门控检查。
 */
export function resetAutoModeGateCheck(): void {
  autoModeCheckRan = false
}

export function useKickOffCheckAndDisableAutoModeIfNeeded(): void {
  const mainLoopModel = useAppState(s => s.mainLoopModel)
  const mainLoopModelForSession = useAppState(s => s.mainLoopModelForSession)
  const fastMode = useAppState(s => s.fastMode)
  const setAppState = useSetAppState()
  const store = useAppStateStore()
  const isFirstRunRef = useRef(true)

  // 在挂载时（启动检查）以及模型或 fast mode 变化时运行
  useEffect(() => {
    if (getIsRemoteMode()) return
    if (isFirstRunRef.current) {
      isFirstRunRef.current = false
    } else {
      resetAutoModeGateCheck()
    }
    void checkAndDisableAutoModeIfNeeded(
      store.getState().toolPermissionContext,
      setAppState,
      fastMode,
    ).catch(error => {
      logError(
        new Error('Auto mode gate check failed', { cause: toError(error) }),
      )
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mainLoopModel, mainLoopModelForSession, fastMode])
}
