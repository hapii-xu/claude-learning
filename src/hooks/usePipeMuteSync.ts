/**
 * usePipeMuteSync — 将 master 的 UI 选择状态同步到 slave 中继静音标志。
 *
 * 监听 routeMode、selectedPipes、slave 客户端注册表和 send-override
 * 变化。当 slave 被取消选择或 routeMode 切换到 'local' 时，发送
 * relay_mute。当重新选择时，发送 relay_unmute。还维护
 * master 侧的静音集合用于飞行中消息过滤。
 *
 * 由 UDS_INBOX 功能门控（REPL.tsx 中的条件导入）。
 */
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { useAppState } from '../state/AppState.js'
import { getPipeIpc } from '../utils/pipeTransport.js'
import {
  setMasterMutedPipes,
  clearMasterMutedPipes,
  hasSendOverride,
  clearSendOverrides,
  subscribeSendOverride,
  getSendOverrideVersion,
} from '../utils/pipeMuteState.js'
import {
  getAllSlaveClients,
  subscribeToSlaveClientRegistry,
  getSlaveClientRegistryVersion,
} from './useMasterMonitor.js'

type UsePipeMuteSyncDeps = {
  setToolUseConfirmQueue: (
    action: React.SetStateAction<Record<string, unknown>[]>,
  ) => void
}

export function usePipeMuteSync({
  setToolUseConfirmQueue,
}: UsePipeMuteSyncDeps): void {
  // 订阅单独标量以避免对象选择器重新渲染抖动
  // （AppState.tsx 警告不要使用返回对象的选择器）
  const routeMode = useAppState(
    s => (getPipeIpc(s).routeMode as 'selected' | 'local') ?? 'selected',
  )
  const selectedPipes: string[] = useAppState(
    s => (getPipeIpc(s).selectedPipes as string[]) ?? [],
  )

  // 订阅 slave 客户端注册表变化
  const registryVersion = useSyncExternalStore(
    subscribeToSlaveClientRegistry,
    getSlaveClientRegistryVersion,
    getSlaveClientRegistryVersion,
  )

  // 订阅 send-override 变化，以便静音在 /send 完成后重新计算
  const sendOverrideVersion = useSyncExternalStore(
    subscribeSendOverride,
    getSendOverrideVersion,
    getSendOverrideVersion,
  )

  const prevMutedRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const slaves = getAllSlaveClients()

    // 计算现在哪些 slaves 应该被静音
    const nextMuted = new Set<string>()
    if (routeMode === 'local') {
      // 所有已连接的 slaves 静音
      for (const name of slaves.keys()) {
        if (!hasSendOverride(name)) {
          nextMuted.add(name)
        }
      }
    } else {
      // routeMode === 'selected'：静音不在 selectedPipes 中的 slaves
      const selectedSet = new Set(selectedPipes)
      for (const name of slaves.keys()) {
        if (!selectedSet.has(name) && !hasSendOverride(name)) {
          nextMuted.add(name)
        }
      }
    }

    // 步骤 1：首先更新 master 侧静音集合（在发送控制包之前）
    setMasterMutedPipes(nextMuted)

    const prevMuted = prevMutedRef.current

    // 步骤 2：对于新静音的 slaves —— 中止待处理的权限，然后发送 relay_mute
    for (const name of nextMuted) {
      if (!prevMuted.has(name)) {
        // 中止此 slave 的待处理权限提示
        setToolUseConfirmQueue((queue: Record<string, unknown>[]) => {
          const toAbort = queue.filter(
            (item: Record<string, unknown>) => item.pipeName === name,
          )
          for (const item of toAbort) {
            try {
              ;(item.onAbort as (() => void) | undefined)?.()
            } catch {
              // 如果客户端断开连接，onAbort 可能抛出 —— 可安全忽略
            }
          }
          return queue.filter(
            (item: Record<string, unknown>) => item.pipeName !== name,
          )
        })

        // 向 slave 发送 relay_mute
        const client = slaves.get(name)
        if (client?.connected) {
          try {
            client.send({ type: 'relay_mute' })
          } catch {
            // 如果 socket 正在关闭，send 可能失败 —— 非致命
          }
        }
      }
    }

    // 步骤 3：对于新取消静音的 slaves —— 发送 relay_unmute
    for (const name of prevMuted) {
      if (!nextMuted.has(name)) {
        const client = slaves.get(name)
        if (client?.connected) {
          try {
            client.send({ type: 'relay_unmute' })
          } catch {
            // 非致命
          }
        }
      }
    }

    prevMutedRef.current = nextMuted
  }, [
    routeMode,
    selectedPipes,
    registryVersion,
    sendOverrideVersion,
    setToolUseConfirmQueue,
  ])

  // 卸载时清理：清除所有 master 侧静音状态
  useEffect(() => {
    return () => {
      clearMasterMutedPipes()
      clearSendOverrides()
    }
  }, [])
}
