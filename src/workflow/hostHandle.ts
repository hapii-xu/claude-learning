import {
  createHostHandle,
  unwrapHostHandle,
  type HostHandle,
} from '@claude-code-best/workflow-engine'
import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import type { AssistantMessage } from '../types/message.js'
import type { AgentId } from '../types/ids.js'
import type { ToolUseContext } from '../Tool.js'

/** 封装在 HostHandle 内的不透明 bundle（由 core 侧解包）。 */
export type WorkflowHostBundle = {
  toolUseContext: ToolUseContext
  canUseTool: CanUseToolFn
  parentMessage?: AssistantMessage
  agentId?: AgentId
}

/**
 * 共用：从 toolUseContext/canUseTool 构建 host bundle。
 * parentMessage 是可选的（面板启动路径下缺失 —— claudeCodeBackend 从不读取它）。
 */
export function buildHostBundle(
  toolUseContext: WorkflowHostBundle['toolUseContext'],
  canUseTool: WorkflowHostBundle['canUseTool'],
  parentMessage?: AssistantMessage,
): WorkflowHostBundle {
  return {
    toolUseContext,
    canUseTool,
    ...(parentMessage !== undefined ? { parentMessage } : {}),
    agentId: toolUseContext.agentId,
  }
}

export function makeHostHandle(bundle: WorkflowHostBundle): HostHandle {
  return createHostHandle(bundle)
}

export function readHostBundle(handle: HostHandle): WorkflowHostBundle {
  return unwrapHostHandle(handle) as WorkflowHostBundle
}
