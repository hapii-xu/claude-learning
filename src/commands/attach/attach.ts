import { feature } from 'bun:bundle'
import type { LocalCommandCall } from '../../types/command.js'
import {
  connectToPipe,
  getPipeIpc,
  isPipeControlled,
  type PipeClient,
  type PipeMessage,
  type TcpEndpoint,
} from '../../utils/pipeTransport.js'
import { addSlaveClient } from '../../hooks/useMasterMonitor.js'

export const call: LocalCommandCall = async (args, context) => {
  const targetName = args.trim()
  if (!targetName) {
    return {
      type: 'text',
      value: 'Usage: /attach <pipe-name>\nUse /pipes to list available pipes.',
    }
  }

  const currentState = context.getAppState()

  // 检查是否已经 attach 到该 slave
  if (getPipeIpc(currentState).slaves[targetName]) {
    return {
      type: 'text',
      value: `Already attached to "${targetName}".`,
    }
  }

  // 被控的 sub 会话不能再 attach 到其他 sub 会话。
  if (isPipeControlled(getPipeIpc(currentState))) {
    return {
      type: 'text',
      value:
        'Cannot attach: this sub is currently controlled by a master. Detach it from the master first.',
    }
  }

  // 解析 LAN peer 的 TCP endpoint
  let tcpEndpoint: TcpEndpoint | undefined
  if (feature('LAN_PIPES')) {
    const pipeState = getPipeIpc(currentState)
    const discoveredPeer = pipeState.discoveredPipes.find(
      (p: { pipeName: string }) => p.pipeName === targetName,
    )
    if (discoveredPeer) {
      // 通过 beacon 数据判断该 peer 是否为 LAN peer
      const { getLanBeacon } =
        require('../../utils/lanBeacon.js') as typeof import('../../utils/lanBeacon.js')
      const beaconRef = getLanBeacon()
      if (beaconRef) {
        const lanPeers = beaconRef.getPeers()
        const lanPeer = lanPeers.get(targetName)
        if (lanPeer) {
          tcpEndpoint = { host: lanPeer.ip, port: lanPeer.tcpPort }
        }
      }
    }
  }

  // 连接到目标 pipe 服务器（UDS 或 TCP）
  let client: PipeClient
  try {
    const myName =
      getPipeIpc(currentState).serverName ?? `master-${process.pid}`
    client = await connectToPipe(targetName, myName, undefined, tcpEndpoint)
  } catch (err) {
    return {
      type: 'text',
      value: `Failed to connect to "${targetName}"${tcpEndpoint ? ` (TCP ${tcpEndpoint.host}:${tcpEndpoint.port})` : ''}: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  // 发送 attach 请求并等待响应
  return new Promise(resolve => {
    const timeout = setTimeout(() => {
      client.disconnect()
      resolve({
        type: 'text',
        value: `Attach to "${targetName}" timed out (no response within 5s).`,
      })
    }, 5000)

    client.onMessage((msg: PipeMessage) => {
      if (msg.type === 'attach_accept') {
        clearTimeout(timeout)

        // 在模块级注册表中登记这个 slave client
        addSlaveClient(targetName, client)

        // 更新 AppState：新增 slave 并切换到 master 角色
        context.setAppState(prev => ({
          ...prev,
          pipeIpc: {
            ...getPipeIpc(prev),
            role: 'master',
            displayRole: 'master',
            slaves: {
              ...getPipeIpc(prev).slaves,
              [targetName]: {
                name: targetName,
                connectedAt: new Date().toISOString(),
                status: 'idle' as const,
                unreadCount: 0,
                history: [],
              },
            },
          },
        }))

        const slaveCount =
          Object.keys(getPipeIpc(currentState).slaves).length + 1
        resolve({
          type: 'text',
          value: `Attached to "${targetName}" as master. Now monitoring ${slaveCount} sub session(s).\nUse /send ${targetName} <message> to send tasks.\nUse /status to see all connected subs.\nUse /detach ${targetName} to disconnect.`,
        })
      } else if (msg.type === 'attach_reject') {
        clearTimeout(timeout)
        client.disconnect()

        resolve({
          type: 'text',
          value: `Attach rejected by "${targetName}": ${msg.data ?? 'unknown reason'}`,
        })
      }
    })

    // 附带 machineId，使远端能区分 LAN peer 与本地 peer
    const pipeState = getPipeIpc(currentState)
    client.send({
      type: 'attach_request',
      meta: { machineId: pipeState.machineId },
    })
  })
}
