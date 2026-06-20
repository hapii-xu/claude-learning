// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { useMemo } from 'react'
import type { Tools, ToolPermissionContext } from '../Tool.js'
import { assembleToolPool } from '../tools.js'
import { mergeAndFilterTools } from '../utils/toolPool.js'
import { logForDebugging } from '../utils/debug.js'

/**
 * React hook，为 REPL 组装完整的工具池。
 *
 * 使用 assembleToolPool()（REPL 和 runAgent 共用的纯函数）
 * 将内置工具与 MCP 工具组合，应用拒绝规则和去重。
 * 任何额外的 initialTools 会被合并到顶部。
 *
 * @param initialTools - 要包含的额外工具（内置 + 来自 props 的启动 MCP）。
 *   这些与组装的工具池合并，在去重时优先。
 * @param mcpTools - 动态发现的 MCP 工具（来自 mcp 状态）
 * @param toolPermissionContext - 用于过滤的权限上下文
 */
export function useMergedTools(
  initialTools: Tools,
  mcpTools: Tools,
  toolPermissionContext: ToolPermissionContext,
): Tools {
  let replBridgeEnabled = false
  let replBridgeOutboundOnly = false
  return useMemo(() => {
    // assembleToolPool 是 REPL 和 runAgent 共用的函数。
    // 它处理：getTools() + MCP 拒绝规则过滤 + 去重 + MCP CLI 排除。
    const assembled = assembleToolPool(toolPermissionContext, mcpTools)

    const merged = mergeAndFilterTools(
      initialTools,
      assembled,
      toolPermissionContext.mode,
    )
    logForDebugging(
      `[Tool 合并] useMergedTools 内置 ${initialTools.length} + MCP ${assembled.length} → 合并后 ${merged.length} 个工具`,
      { level: 'info' },
    )
    return merged
  }, [
    initialTools,
    mcpTools,
    toolPermissionContext,
    replBridgeEnabled,
    replBridgeOutboundOnly,
  ])
}
