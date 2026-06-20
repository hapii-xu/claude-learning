import type { LocalCommandCall } from '../../types/command.js'
import { getSlaveClient } from '../../hooks/useMasterMonitor.js'
import { getPipeIpc } from '../../utils/pipeTransport.js'
import {
  addSendOverride,
  removeSendOverride,
  removeMasterPipeMute,
} from '../../utils/pipeMuteState.js'

export const call: LocalCommandCall = async (args, context) => {
  const currentState = context.getAppState()

  if (getPipeIpc(currentState).role !== 'master') {
    return {
      type: 'text',
      value: 'Not in master mode. Use /attach <pipe-name> first.',
    }
  }

  // 解析：第一个词是 pipe 名称，其余为消息内容
  const trimmed = args.trim()
  const spaceIdx = trimmed.indexOf(' ')
  if (spaceIdx === -1) {
    return {
      type: 'text',
      value: 'Usage: /send <pipe-name> <message>',
    }
  }

  const targetName = trimmed.slice(0, spaceIdx)
  const message = trimmed.slice(spaceIdx + 1).trim()

  if (!message) {
    return {
      type: 'text',
      value: 'Usage: /send <pipe-name> <message>',
    }
  }

  const client = getSlaveClient(targetName)
  if (!client) {
    return {
      type: 'text',
      value: `Not attached to "${targetName}". Use /status to see connected sub sessions.`,
    }
  }

  if (!client.connected) {
    return {
      type: 'text',
      value: `Connection to "${targetName}" is closed. Use /detach ${targetName} and re-attach.`,
    }
  }

  try {
    // 临时为该 slave 取消静音，使其响应可见。
    // 该 override 持续生效，直到 slave 发出 'done' 或 'error'（由
    // useMasterMonitor 的 attachPipeEntryEmitter 处理器清除）。
    addSendOverride(targetName)
    removeMasterPipeMute(targetName)
    client.send({ type: 'relay_unmute' })
    client.send({
      type: 'prompt',
      data: message,
    })

    // 将已发送的 prompt 记录到历史中
    context.setAppState(prev => {
      const slave = getPipeIpc(prev).slaves[targetName]
      if (!slave) return prev
      return {
        ...prev,
        pipeIpc: {
          ...getPipeIpc(prev),
          slaves: {
            ...getPipeIpc(prev).slaves,
            [targetName]: {
              ...slave,
              status: 'busy' as const,
              lastActivityAt: new Date().toISOString(),
              lastSummary: `Queued: ${message}`,
              lastEventType: 'prompt',
              history: [
                ...slave.history,
                {
                  type: 'prompt' as const,
                  content: message,
                  from: getPipeIpc(currentState).serverName ?? 'master',
                  timestamp: new Date().toISOString(),
                },
              ],
            },
          },
        },
      }
    })

    return {
      type: 'text',
      value: `Sent to "${targetName}": ${message.slice(0, 100)}${message.length > 100 ? '...' : ''}`,
    }
  } catch (err) {
    // 发送失败时回滚 override，避免永久取消静音
    removeSendOverride(targetName)
    return {
      type: 'text',
      value: `Failed to send to "${targetName}": ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
