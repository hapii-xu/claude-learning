/**
 * usePipeIpc — Pipe IPC 生命周期 hook。
 *
 * 从 REPL.tsx 的 575 行内联 useEffect 中提取。管理：
 * 1. 服务器创建（UDS + 可选 TCP 用于 LAN）
 * 2. LAN 信标启动
 * 3. 消息处理程序（ping、attach、prompt、permission、detach）
 * 4. 心跳循环（main：自动附加 + 清理；sub：检测 main 存活）
 * 5. 卸载时清理
 *
 * 由 UDS_INBOX 功能门控。LAN 扩展由 LAN_PIPES 门控。
 */
import { feature } from 'bun:bundle'
import { useEffect } from 'react'
import * as pt from '../utils/pipeTransport.js'
import * as pr from '../utils/pipeRegistry.js'
import * as mm from './useMasterMonitor.js'
import { getSessionId as _getSessionId } from '../bootstrap/state.js'
import * as lb from '../utils/lanBeacon.js'
import * as pp from '../utils/pipePermissionRelay.js'
import * as osm from 'os'
import type {
  PipeMessage,
  PipeServer,
  PipeIpcState,
} from '../utils/pipeTransport.js'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

type StoreApi = {
  getState: () => any
  setState: (updater: (prev: any) => any) => void
}

export type UsePipeIpcOptions = {
  store: StoreApi
  handleIncomingPrompt: (content: string) => boolean
}

// ---------------------------------------------------------------------------
// 辅助函数：从注册表 + 状态中移除死亡的 slave
// ---------------------------------------------------------------------------

function removeDeadSlave(slaveName: string, store: StoreApi): void {
  mm.removeSlaveClient(slaveName)
  store.setState((prev: any) => {
    const pipeIpc = pt.getPipeIpc(prev)
    const { [slaveName]: _removed, ...remainingSlaves } = pipeIpc.slaves
    return {
      ...prev,
      pipeIpc: {
        ...pipeIpc,
        role: Object.keys(remainingSlaves).length > 0 ? 'master' : 'main',
        displayRole:
          Object.keys(remainingSlaves).length > 0 ? 'master' : 'main',
        slaves: remainingSlaves,
        selectedPipes: (pipeIpc.selectedPipes ?? []).filter(
          (name: string) => name !== slaveName,
        ),
        discoveredPipes: (pipeIpc.discoveredPipes ?? []).filter(
          (pipe: { pipeName: string }) => pipe.pipeName !== slaveName,
        ),
      },
    }
  })
}

// ---------------------------------------------------------------------------
// 辅助函数：刷新已发现的 pipes（本地订阅 + LAN 对等方）
// ---------------------------------------------------------------------------

function refreshDiscoveredPipes(
  pipeName: string,
  aliveSubs: Array<{
    id: string
    pipeName: string
    subIndex: number
    machineId: string
    ip: string
    hostname: string
  }>,
  store: StoreApi,
): void {
  const freshDiscovered = aliveSubs
    .filter(sub => sub.pipeName !== pipeName)
    .map(sub => ({
      id: sub.id,
      pipeName: sub.pipeName,
      role: `sub-${sub.subIndex}`,
      machineId: sub.machineId,
      ip: sub.ip,
      hostname: sub.hostname,
      alive: true,
    }))

  // 包含 LAN 信标对等方，这样它们不会被心跳清除
  let lanDiscovered: typeof freshDiscovered = []
  if (feature('LAN_PIPES')) {
    const beacon = lb.getLanBeacon()
    if (beacon) {
      const localNames = new Set(freshDiscovered.map(p => p.pipeName))
      localNames.add(pipeName)
      for (const [pName, peer] of beacon.getPeers()) {
        if (!localNames.has(pName)) {
          lanDiscovered.push({
            id: `lan-${pName}`,
            pipeName: pName,
            role: peer.role,
            machineId: peer.machineId,
            ip: peer.ip,
            hostname: peer.hostname,
            alive: true,
          })
        }
      }
    }
  }

  const allDiscovered = [...freshDiscovered, ...lanDiscovered]

  // 仅在列表实际变化时更新状态
  const prev = pt.getPipeIpc(store.getState())
  const prevNames = (prev.discoveredPipes ?? [])
    .map((p: any) => p.pipeName)
    .join(',')
  const newNames = allDiscovered.map(p => p.pipeName).join(',')
  if (prevNames === newNames) return

  store.setState((prev: any) => {
    const pipeIpc = pt.getPipeIpc(prev)
    const aliveNames = new Set(allDiscovered.map(pipe => pipe.pipeName))
    return {
      ...prev,
      pipeIpc: {
        ...pipeIpc,
        discoveredPipes: allDiscovered,
        selectedPipes: (pipeIpc.selectedPipes ?? []).filter((name: string) =>
          aliveNames.has(name),
        ),
      },
    }
  })
}

// ---------------------------------------------------------------------------
// 阶段：在服务器上注册消息处理程序
// ---------------------------------------------------------------------------

function registerMessageHandlers(
  server: PipeServer,
  pipeName: string,
  machineId: string,
  store: StoreApi,
  handleIncomingPrompt: (content: string) => boolean,
): void {
  // 自动回复 ping 用于健康检查
  server.onMessage((msg: PipeMessage, reply) => {
    if (msg.type === 'ping') reply({ type: 'pong' })
  })

  // 处理 attach 请求
  server.onMessage((msg: PipeMessage, reply) => {
    if (msg.type !== 'attach_request') return
    const state = store.getState()
    const currentPipeState = pt.getPipeIpc(state)
    if (pt.isPipeControlled(currentPipeState)) {
      reply({ type: 'attach_reject', data: 'Already controlled' })
      return
    }
    // 允许 LAN 对等方（不同 machineId）附加，无论角色如何。
    const isLanPeer = msg.meta?.machineId && msg.meta.machineId !== machineId
    if (!isLanPeer && currentPipeState.role !== 'sub') {
      reply({
        type: 'attach_reject',
        data: 'Only sub sessions can be attached.',
      })
      return
    }
    reply({ type: 'attach_accept' })

    const clients = Array.from((server as any).clients as Set<any>)
    const masterSocket = clients[clients.length - 1]
    pp.setPipeRelay((relayMsg: any) => {
      if (masterSocket && !masterSocket.destroyed) {
        relayMsg.from = relayMsg.from ?? pipeName
        relayMsg.ts = relayMsg.ts ?? new Date().toISOString()
        masterSocket.write(JSON.stringify(relayMsg) + '\n')
      }
    })

    store.setState((prev: any) => ({
      ...prev,
      pipeIpc: {
        ...pt.getPipeIpc(prev),
        role: 'sub',
        displayRole: pt.getPipeDisplayRole(pt.getPipeIpc(prev)),
        attachedBy: msg.from ?? 'unknown',
      },
    }))
  })

  // 处理来自 master 的提示
  server.onMessage((msg: PipeMessage, reply) => {
    if (msg.type === 'prompt' && msg.data) {
      const accepted = handleIncomingPrompt(msg.data)
      if (accepted) {
        reply({ type: 'prompt_ack', data: 'accepted' })
      } else {
        reply({
          type: 'error',
          data: 'Slave is busy and could not accept the prompt.',
        })
      }
    }
  })

  // 处理来自 master 的权限决定
  server.onMessage((msg: PipeMessage, _reply) => {
    if (msg.type !== 'permission_response' && msg.type !== 'permission_cancel')
      return
    const { resolvePipePermissionResponse, cancelPipePermissionRequest } = pp

    try {
      const payload = msg.data ? JSON.parse(msg.data) : undefined
      if (!payload?.requestId) return
      if (msg.type === 'permission_response') {
        resolvePipePermissionResponse(payload)
      } else {
        cancelPipePermissionRequest(payload.requestId, payload.reason)
      }
    } catch {
      // 畸形 —— 忽略
    }
  })

  // 处理来自 master 的中继静音/取消静音
  server.onMessage((msg: PipeMessage, _reply) => {
    if (msg.type === 'relay_mute') {
      pp.setRelayMuted(true)
    } else if (msg.type === 'relay_unmute') {
      pp.setRelayMuted(false)
    }
  })

  // 处理 detach
  server.onMessage((msg: PipeMessage, _reply) => {
    if (msg.type !== 'detach') return
    const { clearPendingPipePermissions } = pp
    clearPendingPipePermissions('Pipe detached before permission was resolved.')
    pp.setPipeRelay(null)
    store.setState((prev: any) => ({
      ...prev,
      pipeIpc: (() => {
        const pipeIpc = pt.getPipeIpc(prev)
        const nextRole = pipeIpc.subIndex != null ? 'sub' : 'main'
        const nextPipeState = { ...pipeIpc, role: nextRole, attachedBy: null }
        return {
          ...nextPipeState,
          displayRole: pt.getPipeDisplayRole(nextPipeState as PipeIpcState),
        }
      })(),
    }))
  })
}

// ---------------------------------------------------------------------------
// 阶段：心跳
// ---------------------------------------------------------------------------

function runMainHeartbeat(
  pipeName: string,
  machineId: string,
  store: StoreApi,
  disposed: { current: boolean },
): void {
  void (async () => {
    try {
      await pr.cleanupStaleEntries()
      const aliveSubs = await pr.getAliveSubs()
      refreshDiscoveredPipes(pipeName, aliveSubs, store)

      const connectedSlaves = mm.getAllSlaveClients()
      const aliveSubNames = new Set(aliveSubs.map(sub => sub.pipeName))

      // 构建统一的附加目标列表：本地 subs + LAN 对等方
      type AttachTarget = {
        pipeName: string
        tcpEndpoint?: { host: string; port: number }
      }
      const attachTargets: AttachTarget[] = aliveSubs.map(sub => ({
        pipeName: sub.pipeName,
      }))

      // 添加 LAN 对等方作为附加目标
      if (feature('LAN_PIPES')) {
        const beacon = lb.getLanBeacon()
        if (beacon) {
          const localNames = new Set(attachTargets.map(t => t.pipeName))
          localNames.add(pipeName)
          for (const [pName, peer] of beacon.getPeers()) {
            if (!localNames.has(pName)) {
              attachTargets.push({
                pipeName: pName,
                tcpEndpoint: { host: peer.ip, port: peer.tcpPort },
              })
              aliveSubNames.add(pName)
            }
          }
        }
      }

      const currentPipeState = pt.getPipeIpc(store.getState())

      for (const target of attachTargets) {
        if (target.pipeName === pipeName) continue
        if (connectedSlaves.has(target.pipeName)) continue

        try {
          const myName = currentPipeState.serverName ?? pipeName
          const client = await pt.connectToPipe(
            target.pipeName,
            myName,
            3000,
            target.tcpEndpoint,
          )

          const attached = await new Promise<boolean>(resolve => {
            const timeout = setTimeout(() => {
              client.disconnect()
              resolve(false)
            }, 3000)

            client.onMessage((msg: any) => {
              if (msg.type === 'attach_accept') {
                clearTimeout(timeout)
                resolve(true)
              } else if (msg.type === 'attach_reject') {
                clearTimeout(timeout)
                client.disconnect()
                resolve(false)
              }
            })

            client.send({
              type: 'attach_request',
              meta: { machineId },
            })
          })

          if (attached && !disposed.current) {
            mm.addSlaveClient(target.pipeName, client)

            client.on('disconnect', () => {
              removeDeadSlave(target.pipeName, store)
            })

            store.setState((prev: any) => ({
              ...prev,
              pipeIpc: {
                ...pt.getPipeIpc(prev),
                role: 'master',
                displayRole: 'master',
                slaves: {
                  ...pt.getPipeIpc(prev).slaves,
                  [target.pipeName]: {
                    name: target.pipeName,
                    connectedAt: new Date().toISOString(),
                    status: 'idle',
                    unreadCount: 0,
                    history: [],
                  },
                },
              },
            }))
          }
        } catch {
          // 连接失败 —— 跳过此周期
        }
      }

      // 清理不再存活的 slaves
      let lanPeerNames: Set<string> | null = null
      if (feature('LAN_PIPES')) {
        const beacon = lb.getLanBeacon()
        if (beacon) {
          lanPeerNames = new Set(beacon.getPeers().keys())
        }
      }
      for (const [slaveName, client] of connectedSlaves.entries()) {
        const inLocalRegistry = aliveSubNames.has(slaveName)
        const inLanBeacon = lanPeerNames?.has(slaveName) ?? false
        if (!client.connected || (!inLocalRegistry && !inLanBeacon)) {
          removeDeadSlave(slaveName, store)
        }
      }
    } catch {
      // 心跳周期错误 —— 非致命
    }
  })()
}

function runSubHeartbeat(
  pipeName: string,
  machineId: string,
  entry: any,
  store: StoreApi,
  disposed: { current: boolean },
): void {
  void (async () => {
    try {
      const mainAlive = await pr.isMainAlive()
      if (!mainAlive && !disposed.current) {
        const registry = await pr.readRegistry()
        const isSameMachine = pr.isMainMachine(machineId, registry)

        if (isSameMachine) {
          await pr.registerAsMain(entry)
        } else {
          await pr.revertToIndependent(pipeName)
        }

        store.setState((prev: any) => ({
          ...prev,
          pipeIpc: {
            ...pt.getPipeIpc(prev),
            role: 'main',
            subIndex: null,
            displayRole: 'main',
            attachedBy: null,
          },
        }))
        pp.setPipeRelay(null)
      }
    } catch {
      // 心跳检查错误 —— 非致命
    }
  })()
}

// ---------------------------------------------------------------------------
// 主 hook
// ---------------------------------------------------------------------------

export function usePipeIpc({
  store,
  handleIncomingPrompt,
}: UsePipeIpcOptions): void {
  if (!feature('UDS_INBOX')) return

  useEffect(() => {
    const sessionId = _getSessionId()
    if (!sessionId) return
    const pipeName = `cli-${sessionId.slice(0, 8)}`
    const disposed = { current: false }
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null
    let heartbeatBusy = false
    let pipeServer: PipeServer | null = null

    void (async () => {
      try {
        // --- 阶段 1：角色确定 ---
        const machId = await pr.getMachineId()
        const mac = pr.getMacAddress()
        const localIp = pt.getLocalIp()
        const host = osm.hostname()
        const roleResult = await pr.determineRole(machId)

        const entry = {
          id: pipeName,
          pid: process.pid,
          machineId: machId,
          startedAt: Date.now(),
          ip: localIp,
          mac,
          hostname: host,
          pipeName,
        }

        let initialRole: 'main' | 'sub' = 'main'
        let subIndex: number | null = null
        let displayRole = 'main'

        if (roleResult.role === 'main' || roleResult.role === 'main-recover') {
          await pr.registerAsMain(entry)
        } else {
          subIndex = roleResult.subIndex
          await pr.registerAsSub(entry, subIndex)
          initialRole = 'sub'
          displayRole = `sub-${subIndex}`
        }

        // --- 阶段 2：服务器创建 ---
        const server = await pt.createPipeServer(
          pipeName,
          feature('LAN_PIPES') ? { enableTcp: true, tcpPort: 0 } : undefined,
        )
        pipeServer = server
        if (disposed.current) {
          await server.close()
          await pr.unregister(pipeName)
          return
        }

        // --- 阶段 3：LAN 信标 ---
        if (feature('LAN_PIPES') && server.tcpAddress) {
          const beacon = new lb.LanBeacon({
            pipeName,
            machineId: machId,
            hostname: host,
            ip: localIp,
            tcpPort: server.tcpAddress.port,
            role: initialRole,
          })
          beacon.start()
          lb.setLanBeacon(beacon)

          const entryWithTcp = {
            ...entry,
            tcpPort: server.tcpAddress.port,
            lanVisible: true,
          }
          if (initialRole === 'main') {
            await pr.registerAsMain(entryWithTcp)
          } else if (subIndex != null) {
            await pr.registerAsSub(entryWithTcp, subIndex)
          }
        }

        // 更新 store
        store.setState((prev: any) => ({
          ...prev,
          pipeIpc: {
            ...pt.getPipeIpc(prev),
            serverName: pipeName,
            role: initialRole,
            subIndex,
            displayRole,
            localIp,
            hostname: host,
            machineId: machId,
            mac,
          },
        }))

        // --- 阶段 4：消息处理程序 ---
        registerMessageHandlers(
          server,
          pipeName,
          machId,
          store,
          handleIncomingPrompt,
        )

        // --- 阶段 5：心跳 ---
        const HEARTBEAT_INTERVAL_MS = 5000

        heartbeatTimer = setInterval(() => {
          if (disposed.current || heartbeatBusy) return
          heartbeatBusy = true

          const currentPipeState = pt.getPipeIpc(store.getState())

          if (
            currentPipeState.role === 'main' ||
            currentPipeState.role === 'master'
          ) {
            runMainHeartbeat(pipeName, machId, store, disposed)
          } else if (currentPipeState.role === 'sub') {
            runSubHeartbeat(pipeName, machId, entry, store, disposed)
          }

          // 在短暂延迟后重置忙碌标志，以允许异步工作完成
          setTimeout(() => {
            heartbeatBusy = false
          }, 4000)
        }, HEARTBEAT_INTERVAL_MS)
      } catch {
        // PipeServer 创建失败 —— 非致命
      }
    })()

    // --- 阶段 6：清理 ---
    return () => {
      disposed.current = true
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer)
        heartbeatTimer = null
      }

      // 向所有 slaves 发送 detach
      const allClients = mm.getAllSlaveClients()
      for (const [name, client] of allClients.entries()) {
        try {
          client.send({ type: 'detach' })
        } catch {}
        client.disconnect()
        removeDeadSlave(name, store)
      }

      // 停止 LAN 信标
      const beacon = lb.getLanBeacon()
      if (beacon) {
        try {
          beacon.stop()
        } catch {}
        lb.setLanBeacon(null)
      }

      // 注销 + 关闭服务器
      pr.unregister(pipeName).catch(() => {})
      if (pipeServer) {
        void pipeServer.close().catch(() => {})
        pipeServer = null
      }
      pp.setPipeRelay(null)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
}
