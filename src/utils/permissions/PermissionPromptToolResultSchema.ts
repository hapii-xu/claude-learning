import type { Tool, ToolUseContext } from 'src/Tool.js'
import z from 'zod/v4'
import { logForDebugging } from '../debug.js'
import { lazySchema } from '../lazySchema.js'
import type {
  PermissionDecision,
  PermissionDecisionReason,
} from './PermissionResult.js'
import {
  applyPermissionUpdates,
  persistPermissionUpdates,
} from './PermissionUpdate.js'
import { permissionUpdateSchema } from './PermissionUpdateSchema.js'

export const inputSchema = lazySchema(() =>
  z.object({
    tool_name: z
      .string()
      .describe('The name of the tool requesting permission'),
    input: z.record(z.string(), z.unknown()).describe('The input for the tool'),
    tool_use_id: z
      .string()
      .optional()
      .describe('The unique tool use request ID'),
  }),
)

export type Input = z.infer<ReturnType<typeof inputSchema>>

// 权限结果的 Zod schema
// 此 schema 用于验证 MCP 权限提示工具，
// 因此我们将其维护为真实 PermissionDecision 类型的子集

// 匹配 entrypoints/sdk/coreSchemas.ts 中的 PermissionDecisionClassificationSchema。
// 格式错误的值会回退到 undefined（与下面的 updatedPermissions
// 相同的模式），这样来自 SDK 主机的错误字符串不会拒绝整个决策。
const decisionClassificationField = lazySchema(() =>
  z
    .enum(['user_temporary', 'user_permanent', 'user_reject'])
    .optional()
    .catch(undefined),
)

const PermissionAllowResultSchema = lazySchema(() =>
  z.object({
    behavior: z.literal('allow'),
    updatedInput: z.record(z.string(), z.unknown()),
    // SDK 主机可能发送格式错误的条目；回退到 undefined 而非
    // 拒绝整个允许决策（anthropics/claude-code#29440）
    updatedPermissions: z
      .array(permissionUpdateSchema())
      .optional()
      .catch(ctx => {
        logForDebugging(
          `Malformed updatedPermissions from SDK host ignored: ${ctx.error.issues[0]?.message ?? 'unknown'}`,
          { level: 'warn' },
        )
        return undefined
      }),
    toolUseID: z.string().optional(),
    decisionClassification: decisionClassificationField(),
  }),
)

const PermissionDenyResultSchema = lazySchema(() =>
  z.object({
    behavior: z.literal('deny'),
    message: z.string(),
    interrupt: z.boolean().optional(),
    toolUseID: z.string().optional(),
    decisionClassification: decisionClassificationField(),
  }),
)

export const outputSchema = lazySchema(() =>
  z.union([PermissionAllowResultSchema(), PermissionDenyResultSchema()]),
)

export type Output = z.infer<ReturnType<typeof outputSchema>>

/**
 * 将权限提示工具的结果规范化为 PermissionDecision。
 */
export function permissionPromptToolResultToPermissionDecision(
  result: Output,
  tool: Tool,
  input: { [key: string]: unknown },
  toolUseContext: ToolUseContext,
): PermissionDecision {
  const decisionReason: PermissionDecisionReason = {
    type: 'permissionPromptTool',
    permissionPromptToolName: tool.name,
    toolResult: result,
  }
  if (result.behavior === 'allow') {
    const updatedPermissions = result.updatedPermissions
    if (updatedPermissions) {
      toolUseContext.setAppState(prev => ({
        ...prev,
        toolPermissionContext: applyPermissionUpdates(
          prev.toolPermissionContext,
          updatedPermissions,
        ),
      }))
      persistPermissionUpdates(updatedPermissions)
    }
    // 通过推送通知响应的移动客户端没有原始工具输入，
    // 因此它们发送 `{}` 以满足 schema。将空对象
    // 视为"使用原始输入"，这样工具不会在没有参数的情况下运行。
    const updatedInput =
      Object.keys(result.updatedInput).length > 0 ? result.updatedInput : input
    return {
      ...result,
      updatedInput,
      decisionReason,
    }
  } else if (result.behavior === 'deny' && result.interrupt) {
    logForDebugging(
      `SDK permission prompt deny+interrupt: tool=${tool.name} message=${result.message}`,
    )
    toolUseContext.abortController.abort()
  }
  return {
    ...result,
    decisionReason,
  }
}
