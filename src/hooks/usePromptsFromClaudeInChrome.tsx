import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs';
import { useEffect, useRef } from 'react';
import { logError } from 'src/utils/log.js';
import { z } from 'zod/v4';
import { callIdeRpc } from '../services/mcp/client.js';
import type { ConnectedMCPServer, MCPServerConnection } from '../services/mcp/types.js';
import type { PermissionMode } from '../types/permissions.js';
import { CLAUDE_IN_CHROME_MCP_SERVER_NAME, isTrackedClaudeInChromeTabId } from '../utils/claudeInChrome/common.js';
import type { AnyObjectSchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { lazySchema } from '../utils/lazySchema.js';
import { enqueuePendingNotification } from '../utils/messageQueueManager.js';

// Chrome 扩展发送的提示通知 Schema（JSON-RPC 2.0 格式）
const ClaudeInChromePromptNotificationSchema: () => AnyObjectSchema = lazySchema(() =>
  z.object({
    method: z.literal('notifications/message'),
    params: z.object({
      prompt: z.string(),
      image: z
        .object({
          type: z.literal('base64'),
          media_type: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
          data: z.string(),
        })
        .optional(),
      tabId: z.number().optional(),
    }),
  }),
);

/**
 * 监听 Claude for Chrome 扩展发送的提示通知的 Hook，
 * 将其加入用户提示队列，并将权限模式变更同步到扩展。
 */
export function usePromptsFromClaudeInChrome(
  mcpClients: MCPServerConnection[],
  toolPermissionMode: PermissionMode,
): void {
  const mcpClientRef = useRef<ConnectedMCPServer | undefined>(undefined);

  useEffect(() => {
    if (process.env.USER_TYPE !== 'ant') {
      return;
    }

    const mcpClient = findChromeClient(mcpClients);
    if (mcpClientRef.current !== mcpClient) {
      mcpClientRef.current = mcpClient;
    }

    if (mcpClient) {
      mcpClient.client.setNotificationHandler(ClaudeInChromePromptNotificationSchema(), notification => {
        if (mcpClientRef.current !== mcpClient) {
          return;
        }
        const { tabId, prompt, image } = notification.params;

        // 处理我们正在追踪的标签页的通知，因为通知是广播发送的
        if (typeof tabId !== 'number' || !isTrackedClaudeInChromeTabId(tabId)) {
          return;
        }

        try {
          // 如果有图片则构建内容块，否则直接使用提示字符串
          if (image) {
            const contentBlocks: ContentBlockParam[] = [
              { type: 'text', text: prompt },
              {
                type: 'image',
                source: {
                  type: image.type,
                  media_type: image.media_type,
                  data: image.data,
                },
              },
            ];
            enqueuePendingNotification({
              value: contentBlocks,
              mode: 'prompt',
            });
          } else {
            enqueuePendingNotification({ value: prompt, mode: 'prompt' });
          }
        } catch (error) {
          logError(error as Error);
        }
      });
    }
  }, [mcpClients]);

  // 当权限模式变化时，同步更新 Chrome 扩展的权限模式
  useEffect(() => {
    const chromeClient = findChromeClient(mcpClients);
    if (!chromeClient) return;

    const chromeMode = toolPermissionMode === 'bypassPermissions' ? 'skip_all_permission_checks' : 'ask';

    void callIdeRpc('set_permission_mode', { mode: chromeMode }, chromeClient);
  }, [mcpClients, toolPermissionMode]);
}

function findChromeClient(clients: MCPServerConnection[]): ConnectedMCPServer | undefined {
  return clients.find(
    (client): client is ConnectedMCPServer =>
      client.type === 'connected' && client.name === CLAUDE_IN_CHROME_MCP_SERVER_NAME,
  );
}
