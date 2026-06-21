import { useEffect } from 'react'
import { logEvent } from 'src/services/analytics/index.js'
import { z } from 'zod/v4'
import type { MCPServerConnection } from '../services/mcp/types.js'
import { getConnectedIdeClient } from '../utils/ide.js'
import type { AnyObjectSchema } from '@modelcontextprotocol/sdk/server/zod-compat.js'
import { lazySchema } from '../utils/lazySchema.js'

const LogEventSchema: () => AnyObjectSchema = lazySchema(() =>
  z.object({
    method: z.literal('log_event'),
    params: z.object({
      eventName: z.string(),
      eventData: z.object({}).passthrough(),
    }),
  }),
)

export function useIdeLogging(mcpClients: MCPServerConnection[]): void {
  useEffect(() => {
    // 如果没有客户端则跳过
    if (!mcpClients.length) {
      return
    }

    // 从 MCP 客户端列表中查找 IDE 客户端
    const ideClient = getConnectedIdeClient(mcpClients)
    if (ideClient) {
      // 注册日志事件处理器
      ideClient.client.setNotificationHandler(
        LogEventSchema(),
        notification => {
          const { eventName, eventData } = notification.params
          logEvent(
            `tengu_ide_${eventName}`,
            eventData as { [key: string]: boolean | number | undefined },
          )
        },
      )
    }
  }, [mcpClients])
}
