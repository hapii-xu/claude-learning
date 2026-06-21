import { useEffect, useRef } from 'react'
import { logError } from 'src/utils/log.js'
import { z } from 'zod/v4'
import type {
  ConnectedMCPServer,
  MCPServerConnection,
} from '../services/mcp/types.js'
import { getConnectedIdeClient } from '../utils/ide.js'
import type { AnyObjectSchema } from '@modelcontextprotocol/sdk/server/zod-compat.js'
import { lazySchema } from '../utils/lazySchema.js'
export type SelectionPoint = {
  line: number
  character: number
}

export type SelectionData = {
  selection: {
    start: SelectionPoint
    end: SelectionPoint
  } | null
  text?: string
  filePath?: string
}

export type IDESelection = {
  lineCount: number
  lineStart?: number
  text?: string
  filePath?: string
}

// 定义选区变更通知的 schema
const SelectionChangedSchema: () => AnyObjectSchema = lazySchema(() =>
  z.object({
    method: z.literal('selection_changed'),
    params: z.object({
      selection: z
        .object({
          start: z.object({
            line: z.number(),
            character: z.number(),
          }),
          end: z.object({
            line: z.number(),
            character: z.number(),
          }),
        })
        .nullable()
        .optional(),
      text: z.string().optional(),
      filePath: z.string().optional(),
    }),
  }),
)

/**
 * 通过直接注册 MCP 客户端通知处理器来跟踪 IDE 文本选区信息的 hook
 */
export function useIdeSelection(
  mcpClients: MCPServerConnection[],
  onSelect: (selection: IDESelection) => void,
): void {
  const handlersRegistered = useRef(false)
  const currentIDERef = useRef<ConnectedMCPServer | null>(null)

  useEffect(() => {
    // 从 MCP 客户端列表中查找 IDE 客户端
    const ideClient = getConnectedIdeClient(mcpClients)

    // 如果 IDE 客户端已变更，我们需要重新注册处理器。
    // 将 undefined 规范化为 null，以便初始 ref 值（null）与
    // "未找到 IDE"（undefined）匹配，避免每次 MCP 更新时的虚假重置。
    if (currentIDERef.current !== (ideClient ?? null)) {
      handlersRegistered.current = false
      currentIDERef.current = ideClient || null
      // 当 IDE 客户端变更时重置选区。
      onSelect({
        lineCount: 0,
        lineStart: undefined,
        text: undefined,
        filePath: undefined,
      })
    }

    // 如果我们已为当前 IDE 注册了处理器或没有 IDE 客户端则跳过
    if (handlersRegistered.current || !ideClient) {
      return
    }

    // 选区变更的处理器函数
    const selectionChangeHandler = (data: SelectionData) => {
      if (data.selection?.start && data.selection?.end) {
        const { start, end } = data.selection
        let lineCount = end.line - start.line + 1
        // 如果在行的第一个字符上，不要将该行计为
        // 已选中。
        if (end.character === 0) {
          lineCount--
        }
        const selection = {
          lineCount,
          lineStart: start.line,
          text: data.text,
          filePath: data.filePath,
        }

        onSelect(selection)
      }
    }

    // 为 selection_changed 事件注册通知处理器
    ideClient.client.setNotificationHandler(
      SelectionChangedSchema(),
      notification => {
        if (currentIDERef.current !== ideClient) {
          return
        }

        try {
          // 从通知参数中获取选区数据
          const selectionData = notification.params

          // 处理选区数据 —— 校验其是否具有必需属性
          if (
            selectionData.selection &&
            selectionData.selection.start &&
            selectionData.selection.end
          ) {
            // 处理选区变更
            selectionChangeHandler(selectionData as SelectionData)
          } else if (selectionData.text !== undefined) {
            // 处理空选区（当文本为空字符串时）
            selectionChangeHandler({
              selection: null,
              text: selectionData.text,
              filePath: selectionData.filePath,
            })
          }
        } catch (error) {
          logError(error as Error)
        }
      },
    )

    // 标记我们已注册处理器
    handlersRegistered.current = true

    // 不需要清理，因为 MCP 客户端管理自己的生命周期
  }, [mcpClients, onSelect])
}
