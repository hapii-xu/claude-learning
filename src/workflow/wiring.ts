import {
  createWorkflowTool,
  workflowInputSchema,
  WORKFLOW_TOOL_NAME,
  type WorkflowToolDescriptor,
} from '@claude-code-best/workflow-engine'
import { buildTool, type Tool } from '../Tool.js'
import { getWorkflowService } from './service.js'

/**
 * 将引擎自包含的 descriptor 适配为 buildTool 兼容的 Tool。
 * descriptor 通过 service 单例路由（共享 ports/registry/store）。
 *
 * ports 解析推迟到第一次真实方法调用（懒加载）：tools.ts 在模块加载期间调用
 * createWorkflowToolCore()（feature-gated），如果立即解析 ports
 * 会触发 service 实例化，进而调用 getProjectRoot 等
 * 模块级副作用 —— 在 bootstrap 完成前拿到错误路径。
 * Tool 对象本身通过 createWorkflowToolCore 的 cached 成为单例（PermissionRequest
 * 按引用匹配），ports 单例由 getWorkflowService 保证。
 */
function buildWorkflowTool(): Tool {
  let cachedDescriptor: WorkflowToolDescriptor | null = null
  const descriptor = (): WorkflowToolDescriptor => {
    if (!cachedDescriptor) {
      const { ports } = getWorkflowService()
      cachedDescriptor = createWorkflowTool(ports)
    }
    return cachedDescriptor
  }
  return buildTool({
    name: WORKFLOW_TOOL_NAME,
    maxResultSizeChars: 50_000,
    inputSchema: workflowInputSchema,
    isEnabled: () => descriptor().isEnabled(),
    isReadOnly: input => descriptor().isReadOnly(input),
    isConcurrencySafe: () => true,
    async description() {
      return descriptor().description()
    },
    async prompt() {
      return descriptor().prompt()
    },
    async call(input, context, canUseTool, parentMessage, onProgress) {
      const result = await descriptor().call(
        input,
        context,
        canUseTool,
        parentMessage,
        onProgress,
      )
      return { data: result.data }
    },
    renderToolUseMessage: input => descriptor().renderToolUseMessage(input),
    mapToolResultToToolResultBlockParam: (data, toolUseId) =>
      descriptor().mapToolResultToToolResultBlockParam(data, toolUseId),
  })
}

// 单例：tools.ts 注册与 PermissionRequest 必须引用同一实例（switch 按引用匹配）。
let cached: Tool | null = null

export function createWorkflowToolCore(): Tool {
  if (!cached) cached = buildWorkflowTool()
  return cached
}
