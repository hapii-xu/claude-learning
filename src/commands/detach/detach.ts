import type { LocalCommandCall } from '../../types/command.js'
import {
  removeSlaveClient,
  getAllSlaveClients,
} from '../../hooks/useMasterMonitor.js'
import { getPipeIpc, isPipeControlled } from '../../utils/pipeTransport.js'

export const call: LocalCommandCall = async (args, context) => {
  const currentState = context.getAppState()

  if (getPipeIpc(currentState).role === 'main') {
    return { type: 'text', value: 'Not attached to any CLI.' }
  }

  if (isPipeControlled(getPipeIpc(currentState))) {
    return {
      type: 'text',
      value:
        'This sub session is controlled by a master. The master must detach.',
    }
  }

  // 主控模式
  const targetName = args.trim()

  if (targetName) {
    // 从特定的从属会话分离
    const client = removeSlaveClient(targetName)
    if (!client) {
      return {
        type: 'text',
        value: `Not attached to "${targetName}". Use /status to see connected sub sessions.`,
      }
    }

    try {
      client.send({ type: 'detach' })
    } catch {
      // Socket 可能已关闭
    }
    client.disconnect()

    // 从状态中移除从属会话
    context.setAppState(prev => {
      const { [targetName]: _removed, ...remainingSlaves } =
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

    return {
      type: 'text',
      value: `Detached from "${targetName}".`,
    }
  }

  // 未指定目标 — 从所有从属会话分离
  const allClients = getAllSlaveClients()
  const slaveNames = Array.from(allClients.keys())

  for (const name of slaveNames) {
    const client = removeSlaveClient(name)
    if (client) {
      try {
        client.send({ type: 'detach' })
      } catch {
        // 忽略
      }
      client.disconnect()
    }
  }

  context.setAppState(prev => ({
    ...prev,
    pipeIpc: {
      ...getPipeIpc(prev),
      role: 'main',
      displayRole: 'main',
      slaves: {},
    },
  }))

  return {
    type: 'text',
    value: `Detached from ${slaveNames.length} sub session(s): ${slaveNames.join(', ')}. Back to main mode.`,
  }
}
