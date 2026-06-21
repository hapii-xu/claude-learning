import { useEffect, useRef } from 'react'
import { logError } from 'src/utils/log.js'
import { z } from 'zod/v4'
import type {
  ConnectedMCPServer,
  MCPServerConnection,
} from '../services/mcp/types.js'
import { getConnectedIdeClient } from '../utils/ide.js'
import { lazySchema } from '../utils/lazySchema.js'
export type IDEAtMentioned = {
  filePath: string
  lineStart?: number
  lineEnd?: number
}

const NOTIFICATION_METHOD = 'at_mentioned'

const AtMentionedSchema = lazySchema(() =>
  z.object({
    method: z.literal(NOTIFICATION_METHOD),
    params: z.object({
      filePath: z.string(),
      lineStart: z.number().optional(),
      lineEnd: z.number().optional(),
    }),
  }),
)

/**
 * 通过直接注册 MCP 客户端通知处理器来跟踪 IDE at-mention 通知的 hook。
 */
export function useIdeAtMentioned(
  mcpClients: MCPServerConnection[],
  onAtMentioned: (atMentioned: IDEAtMentioned) => void,
): void {
  const ideClientRef = useRef<ConnectedMCPServer | undefined>(undefined)

  useEffect(() => {
    // 从 MCP 客户端列表中查找 IDE 客户端
    const ideClient = getConnectedIdeClient(mcpClients)

    if (ideClientRef.current !== ideClient) {
      ideClientRef.current = ideClient
    }

    // 如果找到了已连接的 IDE 客户端，注册我们的处理器
    if (ideClient) {
      ideClient.client.setNotificationHandler(
        AtMentionedSchema() as any,
        notification => {
          if (ideClientRef.current !== ideClient) {
            return
          }
          try {
            const data = notification.params
            // 将行号调整为从 1 开始（而不是从 0 开始）
            const lineStart =
              data.lineStart !== undefined ? data.lineStart + 1 : undefined
            const lineEnd =
              data.lineEnd !== undefined ? data.lineEnd + 1 : undefined
            onAtMentioned({
              filePath: data.filePath,
              lineStart: lineStart,
              lineEnd: lineEnd,
            })
          } catch (error) {
            logError(error as Error)
          }
        },
      )
    }

    // 不需要清理，因为 MCP 客户端管理自己的生命周期
  }, [mcpClients, onAtMentioned])
}
