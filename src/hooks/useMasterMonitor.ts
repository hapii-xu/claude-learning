/**
 * useMasterMonitor — master 侧的 slave 注册表辅助函数加一个可选 hook
 *
 * 模块级注册表辅助函数是 attach/send/status 流使用的活跃集成点。
 * 如果调用者希望 AppState 镜像 slave 会话事件，该 hook 仍可用于历史同步。
 *
 * master CLI 本身保持完全功能 —— 此 hook 仅为通过 /history 和 /status
 * 命令审查而从 slave 收集数据。
 */

import { useEffect, useSyncExternalStore } from 'react'
import { useAppState, useSetAppState } from '../state/AppState.js'
import {
  getPipeIpc,
  type PipeClient,
  type PipeMessage,
  type PipeIpcSlaveState,
} from '../utils/pipeTransport.js'
import { logForDebugging } from '../utils/debug.js'
import {
  isMasterPipeMuted,
  hasSendOverride,
  removeSendOverride,
} from '../utils/pipeMuteState.js'

/** pipe IPC 监控的会话历史条目。 */
export type SessionEntry = {
  type: string
  content: string
  from: string
  timestamp: string
  meta?: Record<string, unknown>
}

function summarizePipeEntry(entry: SessionEntry): string | undefined {
  const content = entry.content.trim()
  switch (entry.type) {
    case 'prompt':
      return content ? `Queued: ${content}` : 'Queued prompt'
    case 'prompt_ack':
      return content || 'Accepted'
    case 'stream':
      return content || undefined
    case 'tool_start':
      return content ? `Tool: ${content}` : 'Tool started'
    case 'tool_result':
      return content ? `Tool result: ${content}` : 'Tool completed'
    case 'done':
      return content || 'Completed'
    case 'error':
      return content || 'Error'
    default:
      return content || undefined
  }
}

function statusForPipeEntry(
  currentStatus: PipeIpcSlaveState['status'],
  entryType: SessionEntry['type'],
): PipeIpcSlaveState['status'] {
  switch (entryType) {
    case 'prompt':
    case 'prompt_ack':
    case 'stream':
    case 'tool_start':
    case 'tool_result':
      return 'busy'
    case 'done':
      return 'idle'
    case 'error':
      return 'error'
    default:
      return currentStatus
  }
}

export function applyPipeEntryToSlaveState(
  slave: PipeIpcSlaveState,
  entry: SessionEntry,
): PipeIpcSlaveState {
  return {
    ...slave,
    status: statusForPipeEntry(slave.status, entry.type),
    lastActivityAt: entry.timestamp,
    lastSummary: summarizePipeEntry(entry),
    lastEventType: entry.type as PipeIpcSlaveState['lastEventType'],
    unreadCount: (slave.unreadCount ?? 0) + 1,
    history: [...slave.history, entry],
  }
}

/**
 * 已连接 slave PipeClient 的模块级注册表。
 * 以 slave pipe 名称为键。由 /attach 和 /detach 命令管理。
 */
const _slaveClients = new Map<string, PipeClient>()
const _slaveClientRegistryListeners = new Set<() => void>()
const _pipeEntryListeners = new Set<
  (slaveName: string, entry: SessionEntry) => void
>()
const _pipeEntryHandlers = new Map<string, (msg: PipeMessage) => void>()
let _slaveClientRegistryVersion = 0

const MONITORED_PIPE_ENTRY_TYPES = [
  'prompt_ack',
  'stream',
  'tool_start',
  'tool_result',
  'done',
  'error',
  'prompt',
  'permission_request',
  'permission_cancel',
]

function isMonitoredPipeEntryType(type: string): boolean {
  return MONITORED_PIPE_ENTRY_TYPES.includes(type)
}

/** slave 被静音时应丢弃的业务消息类型。 */
const MUTED_DROPPABLE_TYPES = new Set([
  'prompt_ack',
  'stream',
  'tool_start',
  'tool_result',
  'done',
  'error',
  'permission_request',
  'permission_cancel',
])

/**
 * 集中式静音检查，被 attachPipeEntryEmitter 和
 * useMasterMonitor 的内联处理程序使用 —— 保持两个门控同步。
 */
export function shouldDropMutedMessage(
  slaveName: string,
  msgType: string,
): boolean {
  if (hasSendOverride(slaveName)) return false
  if (!isMasterPipeMuted(slaveName)) return false
  return MUTED_DROPPABLE_TYPES.has(msgType)
}

function pipeMessageToSessionEntry(
  slaveName: string,
  msg: PipeMessage,
): SessionEntry {
  return {
    type: msg.type as SessionEntry['type'],
    content: msg.data ?? '',
    from: msg.from ?? slaveName,
    timestamp: msg.ts ?? new Date().toISOString(),
    meta: msg.meta,
  }
}

function emitPipeEntry(slaveName: string, entry: SessionEntry): void {
  for (const listener of _pipeEntryListeners) {
    listener(slaveName, entry)
  }
}

export function subscribePipeEntries(
  listener: (slaveName: string, entry: SessionEntry) => void,
): () => void {
  _pipeEntryListeners.add(listener)
  return () => {
    _pipeEntryListeners.delete(listener)
  }
}

function detachPipeEntryEmitter(name: string, client?: PipeClient): void {
  const handler = _pipeEntryHandlers.get(name)
  if (!handler) return
  client?.removeListener?.('message', handler)
  _pipeEntryHandlers.delete(name)
}

function attachPipeEntryEmitter(name: string, client: PipeClient): void {
  detachPipeEntryEmitter(name, _slaveClients.get(name))
  if (typeof client.on !== 'function') return
  const handler = (msg: PipeMessage) => {
    if (!isMonitoredPipeEntryType(msg.type)) return

    // 静音门控：丢弃来自已静音 slave 的业务消息
    if (shouldDropMutedMessage(name, msg.type)) {
      // 自动拒绝 permission_request 以防止 slave 死锁
      if (msg.type === 'permission_request') {
        try {
          const payload = JSON.parse(msg.data ?? '{}')
          if (payload.requestId) {
            client.send({
              type: 'permission_response',
              data: JSON.stringify({
                requestId: payload.requestId,
                behavior: 'deny',
                feedback:
                  'Permission auto-denied: pipe is logically disconnected.',
              }),
            })
          }
        } catch {
          // 畸形载荷 —— 可安全忽略
        }
      }
      return
    }

    // 当 slave 回合完成时清除 /send 覆盖
    if (
      (msg.type === 'done' || msg.type === 'error') &&
      hasSendOverride(name)
    ) {
      removeSendOverride(name)
    }

    emitPipeEntry(name, pipeMessageToSessionEntry(name, msg))
  }
  _pipeEntryHandlers.set(name, handler)
  client.on('message', handler)
}

function emitSlaveClientRegistryChanged(): void {
  _slaveClientRegistryVersion += 1
  for (const listener of _slaveClientRegistryListeners) {
    listener()
  }
}

export function subscribeToSlaveClientRegistry(
  listener: () => void,
): () => void {
  _slaveClientRegistryListeners.add(listener)
  return () => {
    _slaveClientRegistryListeners.delete(listener)
  }
}

export function getSlaveClientRegistryVersion(): number {
  return _slaveClientRegistryVersion
}

export function addSlaveClient(name: string, client: PipeClient): void {
  attachPipeEntryEmitter(name, client)
  _slaveClients.set(name, client)
  emitSlaveClientRegistryChanged()
}

export function removeSlaveClient(name: string): PipeClient | undefined {
  const client = _slaveClients.get(name)
  detachPipeEntryEmitter(name, client)
  _slaveClients.delete(name)
  emitSlaveClientRegistryChanged()
  return client
}

export function getSlaveClient(name: string): PipeClient | undefined {
  return _slaveClients.get(name)
}

export function getAllSlaveClients(): Map<string, PipeClient> {
  return _slaveClients
}

export type ConnectedSlaveTarget = {
  name: string
  client: PipeClient
}

/**
 * 将选择列表解析为当前已连接的 slave 客户端。
 *
 * pipe 选择器可以包含已发现但未附加的名称。路由
 * 应仅将已附加、已连接的客户端视为广播目标。
 */
export function getConnectedSlaveTargets(
  selectedNames: string[],
): ConnectedSlaveTarget[] {
  const targets: ConnectedSlaveTarget[] = []
  for (const name of selectedNames) {
    const client = _slaveClients.get(name)
    if (client?.connected) {
      targets.push({ name, client })
    }
  }
  return targets
}

export function resetSlaveClientsForTesting(): void {
  for (const [name, client] of _slaveClients.entries()) {
    detachPipeEntryEmitter(name, client)
  }
  _slaveClients.clear()
  emitSlaveClientRegistryChanged()
}

export function useMasterMonitor(): void {
  const role = useAppState(s => getPipeIpc(s).role)
  const setAppState = useSetAppState()
  const registryVersion = useSyncExternalStore(
    subscribeToSlaveClientRegistry,
    getSlaveClientRegistryVersion,
    getSlaveClientRegistryVersion,
  )

  useEffect(() => {
    if (role !== 'master' && _slaveClients.size === 0) return

    // 为每个已连接的 slave 客户端设置监听器
    const cleanups: (() => void)[] = []

    for (const [slaveName, client] of _slaveClients.entries()) {
      const handler = (msg: PipeMessage) => {
        // 仅记录相关的消息类型
        if (!isMonitoredPipeEntryType(msg.type)) {
          return
        }

        // 静音门控（第二个门控，与 attachPipeEntryEmitter 相同的辅助函数）
        if (shouldDropMutedMessage(slaveName, msg.type)) {
          return
        }

        // 当 slave 回合完成时清除 /send 覆盖
        if (
          (msg.type === 'done' || msg.type === 'error') &&
          hasSendOverride(slaveName)
        ) {
          removeSendOverride(slaveName)
        }

        const entry = pipeMessageToSessionEntry(slaveName, msg)

        setAppState(prev => {
          const slave = getPipeIpc(prev).slaves[slaveName]
          if (!slave) return prev

          const newStatus =
            msg.type === 'done' || msg.type === 'error'
              ? 'idle'
              : msg.type === 'prompt'
                ? 'busy'
                : slave.status

          return {
            ...prev,
            pipeIpc: {
              ...getPipeIpc(prev),
              slaves: {
                ...getPipeIpc(prev).slaves,
                [slaveName]: applyPipeEntryToSlaveState(
                  {
                    ...slave,
                    status: newStatus,
                  },
                  entry,
                ),
              },
            },
          }
        })

        if (msg.type === 'done') {
          logForDebugging(`[MasterMonitor] Slave "${slaveName}" turn complete`)
        }
      }

      client.on('message', handler)

      // 处理 slave 断开连接
      const onDisconnect = () => {
        logForDebugging(`[MasterMonitor] Slave "${slaveName}" disconnected`)
        // 在移除客户端之前清除任何残留的 /send 覆盖
        removeSendOverride(slaveName)
        removeSlaveClient(slaveName)
        setAppState(prev => {
          const { [slaveName]: _removed, ...remainingSlaves } =
            getPipeIpc(prev).slaves
          const hasSlaves = Object.keys(remainingSlaves).length > 0
          return {
            ...prev,
            pipeIpc: {
              ...getPipeIpc(prev),
              role: hasSlaves ? 'master' : 'main',
              displayRole: hasSlaves ? 'master' : 'main',
              slaves: remainingSlaves,
            },
          }
        })
      }

      client.on('disconnect', onDisconnect)
      cleanups.push(() => {
        client.removeListener('message', handler)
        client.removeListener('disconnect', onDisconnect)
      })
    }

    return () => {
      for (const cleanup of cleanups) {
        cleanup()
      }
    }
  }, [registryVersion, role, setAppState])
}
