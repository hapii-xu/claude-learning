import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { sanitizeToolNameForAnalytics } from 'src/services/analytics/metadata.js'
import type z from 'zod/v4'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { AnyObject, Tool, ToolUseContext } from '../../Tool.js'
import type { HookProgress } from '../../types/hooks.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  ProgressMessage,
} from '../../types/message.js'
import type { PermissionDecision } from '../../types/permissions.js'
import { createAttachmentMessage } from '../../utils/attachments.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  executePostToolHooks,
  executePostToolUseFailureHooks,
  executePreToolHooks,
  getPreToolHookBlockingMessage,
} from '../../utils/hooks.js'
import { logError } from '../../utils/log.js'
import {
  getRuleBehaviorDescription,
  type PermissionDecisionReason,
  type PermissionResult,
} from '../../utils/permissions/PermissionResult.js'
import { checkRuleBasedPermissions } from '../../utils/permissions/permissions.js'
import { formatError } from '../../utils/toolErrors.js'
import { isMcpTool } from '../mcp/utils.js'
import type { McpServerType, MessageUpdateLazy } from './toolExecution.js'

export type PostToolUseHooksResult<Output> =
  | MessageUpdateLazy<AttachmentMessage | ProgressMessage<HookProgress>>
  | { updatedMCPToolOutput: Output }

export async function* runPostToolUseHooks<Input extends AnyObject, Output>(
  toolUseContext: ToolUseContext,
  tool: Tool<Input, Output>,
  toolUseID: string,
  messageId: string,
  toolInput: Record<string, unknown>,
  toolResponse: Output,
  requestId: string | undefined,
  mcpServerType: McpServerType,
  _mcpServerBaseUrl: string | undefined,
): AsyncGenerator<PostToolUseHooksResult<Output>> {
  const postToolStartTime = Date.now()
  try {
    const appState = toolUseContext.getAppState()
    const permissionMode = appState.toolPermissionContext.mode

    let toolOutput = toolResponse
    for await (const result of executePostToolHooks(
      tool.name,
      toolUseID,
      toolInput,
      toolOutput,
      toolUseContext,
      permissionMode,
      toolUseContext.abortController.signal,
    )) {
      try {
        // 检查在 hook 执行期间是否被中止
        // 重要：每个 hook 发出一次 cancelled 事件
        if (
          result.message?.type === 'attachment' &&
          result.message.attachment!.type === 'hook_cancelled'
        ) {
          logEvent('tengu_post_tool_hooks_cancelled', {
            toolName: sanitizeToolNameForAnalytics(tool.name),

            queryChainId: toolUseContext.queryTracking
              ?.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            queryDepth: toolUseContext.queryTracking?.depth,
          })
          yield {
            message: createAttachmentMessage({
              type: 'hook_cancelled',
              hookName: `PostToolUse:${tool.name}`,
              toolUseID,
              hookEvent: 'PostToolUse',
            }),
          }
          continue
        }

        // For JSON {decision:"block"} hooks, executeHooks yields two results:
        // {blockingError} and {message: hook_blocking_error attachment}. The
        // blockingError path below creates that same attachment, so skip it
        // here to avoid displaying the block reason twice (#31301). The
        // exit-code-2 path only yields {blockingError}, so it's unaffected.
        if (
          result.message &&
          !(
            result.message.type === 'attachment' &&
            result.message.attachment!.type === 'hook_blocking_error'
          )
        ) {
          yield {
            message: result.message as
              | AttachmentMessage
              | ProgressMessage<HookProgress>,
          }
        }

        if (result.blockingError) {
          yield {
            message: createAttachmentMessage({
              type: 'hook_blocking_error',
              hookName: `PostToolUse:${tool.name}`,
              toolUseID: toolUseID,
              hookEvent: 'PostToolUse',
              blockingError: result.blockingError,
            }),
          }
        }

        // 若 hook 指示阻止继续，yield 一个停止原因消息
        if (result.preventContinuation) {
          yield {
            message: createAttachmentMessage({
              type: 'hook_stopped_continuation',
              message:
                result.stopReason || 'Execution stopped by PostToolUse hook',
              hookName: `PostToolUse:${tool.name}`,
              toolUseID: toolUseID,
              hookEvent: 'PostToolUse',
            }),
          }
          return
        }

        // 若 hook 提供了额外上下文，将其作为消息添加
        if (result.additionalContexts && result.additionalContexts.length > 0) {
          yield {
            message: createAttachmentMessage({
              type: 'hook_additional_context',
              content: result.additionalContexts,
              hookName: `PostToolUse:${tool.name}`,
              toolUseID: toolUseID,
              hookEvent: 'PostToolUse',
            }),
          }
        }

        // 若 hook 提供了 updatedMCPToolOutput，且这是 MCP tool 则 yield
        if (result.updatedMCPToolOutput && isMcpTool(tool)) {
          toolOutput = result.updatedMCPToolOutput as Output
          yield {
            updatedMCPToolOutput: toolOutput,
          }
        }
      } catch (error) {
        const postToolDurationMs = Date.now() - postToolStartTime
        logEvent('tengu_post_tool_hook_error', {
          messageID:
            messageId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          toolName: sanitizeToolNameForAnalytics(tool.name),
          isMcp: tool.isMcp ?? false,
          duration: postToolDurationMs,

          queryChainId: toolUseContext.queryTracking
            ?.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          queryDepth: toolUseContext.queryTracking?.depth,
          ...(mcpServerType
            ? {
                mcpServerType:
                  mcpServerType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              }
            : {}),
          ...(requestId
            ? {
                requestId:
                  requestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              }
            : {}),
        })
        yield {
          message: createAttachmentMessage({
            type: 'hook_error_during_execution',
            content: formatError(error),
            hookName: `PostToolUse:${tool.name}`,
            toolUseID: toolUseID,
            hookEvent: 'PostToolUse',
          }),
        }
      }
    }
  } catch (error) {
    logError(error)
  }
}

export async function* runPostToolUseFailureHooks<Input extends AnyObject>(
  toolUseContext: ToolUseContext,
  tool: Tool<Input, unknown>,
  toolUseID: string,
  messageId: string,
  processedInput: z.infer<Input>,
  error: string,
  isInterrupt: boolean | undefined,
  requestId: string | undefined,
  mcpServerType: McpServerType,
  _mcpServerBaseUrl: string | undefined,
): AsyncGenerator<
  MessageUpdateLazy<AttachmentMessage | ProgressMessage<HookProgress>>
> {
  const postToolStartTime = Date.now()
  try {
    const appState = toolUseContext.getAppState()
    const permissionMode = appState.toolPermissionContext.mode

    for await (const result of executePostToolUseFailureHooks(
      tool.name,
      toolUseID,
      processedInput,
      error,
      toolUseContext,
      isInterrupt,
      permissionMode,
      toolUseContext.abortController.signal,
    )) {
      try {
        // 检查在 hook 执行期间是否被中止
        if (
          result.message?.type === 'attachment' &&
          result.message.attachment!.type === 'hook_cancelled'
        ) {
          logEvent('tengu_post_tool_failure_hooks_cancelled', {
            toolName: sanitizeToolNameForAnalytics(tool.name),
            queryChainId: toolUseContext.queryTracking
              ?.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            queryDepth: toolUseContext.queryTracking?.depth,
          })
          yield {
            message: createAttachmentMessage({
              type: 'hook_cancelled',
              hookName: `PostToolUseFailure:${tool.name}`,
              toolUseID,
              hookEvent: 'PostToolUseFailure',
            }),
          }
          continue
        }

        // 跳过 result.message 中的 hook_blocking_error —— 下方 blockingError 路径
        // 会创建相同的附件（参见 #31301 / PostToolUse 上方）。
        if (
          result.message &&
          !(
            result.message.type === 'attachment' &&
            result.message.attachment!.type === 'hook_blocking_error'
          )
        ) {
          yield {
            message: result.message as
              | AttachmentMessage
              | ProgressMessage<HookProgress>,
          }
        }

        if (result.blockingError) {
          yield {
            message: createAttachmentMessage({
              type: 'hook_blocking_error',
              hookName: `PostToolUseFailure:${tool.name}`,
              toolUseID: toolUseID,
              hookEvent: 'PostToolUseFailure',
              blockingError: result.blockingError,
            }),
          }
        }

        // 若 hook 提供了额外上下文，将其作为消息添加
        if (result.additionalContexts && result.additionalContexts.length > 0) {
          yield {
            message: createAttachmentMessage({
              type: 'hook_additional_context',
              content: result.additionalContexts,
              hookName: `PostToolUseFailure:${tool.name}`,
              toolUseID: toolUseID,
              hookEvent: 'PostToolUseFailure',
            }),
          }
        }
      } catch (hookError) {
        const postToolDurationMs = Date.now() - postToolStartTime
        logEvent('tengu_post_tool_failure_hook_error', {
          messageID:
            messageId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          toolName: sanitizeToolNameForAnalytics(tool.name),
          isMcp: tool.isMcp ?? false,
          duration: postToolDurationMs,
          queryChainId: toolUseContext.queryTracking
            ?.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          queryDepth: toolUseContext.queryTracking?.depth,
          ...(mcpServerType
            ? {
                mcpServerType:
                  mcpServerType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              }
            : {}),
          ...(requestId
            ? {
                requestId:
                  requestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              }
            : {}),
        })
        yield {
          message: createAttachmentMessage({
            type: 'hook_error_during_execution',
            content: formatError(hookError),
            hookName: `PostToolUseFailure:${tool.name}`,
            toolUseID: toolUseID,
            hookEvent: 'PostToolUseFailure',
          }),
        }
      }
    }
  } catch (outerError) {
    logError(outerError)
  }
}

/**
 * Resolve a PreToolUse hook's permission result into a final PermissionDecision.
 *
 * Encapsulates the invariant that hook 'allow' does NOT bypass settings.json
 * deny/ask rules — checkRuleBasedPermissions still applies (inc-4788 analog).
 * Also handles the requiresUserInteraction/requireCanUseTool guards and the
 * 'ask' forceDecision passthrough.
 *
 * Shared by toolExecution.ts (main query loop) and REPLTool/toolWrappers.ts
 * (REPL inner calls) so the permission semantics stay in lockstep.
 */
export async function resolveHookPermissionDecision(
  hookPermissionResult: PermissionResult | undefined,
  tool: Tool,
  input: Record<string, unknown>,
  toolUseContext: ToolUseContext,
  canUseTool: CanUseToolFn,
  assistantMessage: AssistantMessage,
  toolUseID: string,
): Promise<{
  decision: PermissionDecision
  input: Record<string, unknown>
}> {
  const requiresInteraction = tool.requiresUserInteraction?.()
  const requireCanUseTool = toolUseContext.requireCanUseTool

  if (hookPermissionResult?.behavior === 'allow') {
    const hookInput = hookPermissionResult.updatedInput ?? input

    // Hook 为交互式工具提供了 updatedInput —— hook 本身就是
    // 用户交互（例如收集 AskUserQuestion 答案的无头包装器）。
    // 在规则检查路径中视为非交互。
    const interactionSatisfied =
      requiresInteraction && hookPermissionResult.updatedInput !== undefined

    if ((requiresInteraction && !interactionSatisfied) || requireCanUseTool) {
      logForDebugging(
        `Hook approved tool use for ${tool.name}, but canUseTool is required`,
      )
      return {
        decision: await canUseTool(
          tool,
          hookInput,
          toolUseContext,
          assistantMessage,
          toolUseID,
        ),
        input: hookInput,
      }
    }

    // Hook allow 跳过交互提示，但 deny/ask 规则仍然生效。
    const ruleCheck = await checkRuleBasedPermissions(
      tool,
      hookInput,
      toolUseContext,
    )
    if (ruleCheck === null) {
      logForDebugging(
        interactionSatisfied
          ? `Hook satisfied user interaction for ${tool.name} via updatedInput`
          : `Hook approved tool use for ${tool.name}, bypassing permission prompt`,
      )
      return { decision: hookPermissionResult, input: hookInput }
    }
    if (ruleCheck.behavior === 'deny') {
      logForDebugging(
        `Hook approved tool use for ${tool.name}, but deny rule overrides: ${ruleCheck.message}`,
      )
      return { decision: ruleCheck, input: hookInput }
    }
    // ask rule — dialog required despite hook approval
    logForDebugging(
      `Hook approved tool use for ${tool.name}, but ask rule requires prompt`,
    )
    return {
      decision: await canUseTool(
        tool,
        hookInput,
        toolUseContext,
        assistantMessage,
        toolUseID,
      ),
      input: hookInput,
    }
  }

  if (hookPermissionResult?.behavior === 'deny') {
    logForDebugging(`Hook denied tool use for ${tool.name}`)
    return { decision: hookPermissionResult, input }
  }

  // 无 hook 决策或 'ask' —— 正常权限流程，可能带 forceDecision
  // 使对话框显示 hook 的 ask 消息。
  const forceDecision =
    hookPermissionResult?.behavior === 'ask' ? hookPermissionResult : undefined
  const askInput =
    hookPermissionResult?.behavior === 'ask' &&
    hookPermissionResult.updatedInput
      ? hookPermissionResult.updatedInput
      : input
  return {
    decision: await canUseTool(
      tool,
      askInput,
      toolUseContext,
      assistantMessage,
      toolUseID,
      forceDecision,
    ),
    input: askInput,
  }
}

export async function* runPreToolUseHooks(
  toolUseContext: ToolUseContext,
  tool: Tool,
  processedInput: Record<string, unknown>,
  toolUseID: string,
  messageId: string,
  requestId: string | undefined,
  mcpServerType: McpServerType,
  _mcpServerBaseUrl: string | undefined,
): AsyncGenerator<
  | {
      type: 'message'
      message: MessageUpdateLazy<
        AttachmentMessage | ProgressMessage<HookProgress>
      >
    }
  | { type: 'hookPermissionResult'; hookPermissionResult: PermissionResult }
  | { type: 'hookUpdatedInput'; updatedInput: Record<string, unknown> }
  | { type: 'preventContinuation'; shouldPreventContinuation: boolean }
  | { type: 'stopReason'; stopReason: string }
  | {
      type: 'additionalContext'
      message: MessageUpdateLazy<AttachmentMessage>
    }
  // stop execution
  | { type: 'stop' }
> {
  const hookStartTime = Date.now()
  try {
    const appState = toolUseContext.getAppState()

    for await (const result of executePreToolHooks(
      tool.name,
      toolUseID,
      processedInput,
      toolUseContext,
      appState.toolPermissionContext.mode,
      toolUseContext.abortController.signal,
      undefined, // timeoutMs - use default
      toolUseContext.requestPrompt,
      tool.getToolUseSummary?.(processedInput),
    )) {
      try {
        if (result.message) {
          yield {
            type: 'message',
            message: {
              message: result.message as
                | AttachmentMessage
                | ProgressMessage<HookProgress>,
            },
          }
        }
        if (result.blockingError) {
          const denialMessage = getPreToolHookBlockingMessage(
            `PreToolUse:${tool.name}`,
            result.blockingError,
          )
          yield {
            type: 'hookPermissionResult',
            hookPermissionResult: {
              behavior: 'deny',
              message: denialMessage,
              decisionReason: {
                type: 'hook',
                hookName: `PreToolUse:${tool.name}`,
                reason: denialMessage,
              },
            },
          }
        }
        // 检查 hook 是否希望阻止继续
        if (result.preventContinuation) {
          yield {
            type: 'preventContinuation',
            shouldPreventContinuation: true,
          }
          if (result.stopReason) {
            yield { type: 'stopReason', stopReason: result.stopReason }
          }
        }
        // 检查 hook 定义的权限行为
        if (result.permissionBehavior !== undefined) {
          logForDebugging(
            `Hook result has permissionBehavior=${result.permissionBehavior}`,
          )
          const decisionReason: PermissionDecisionReason = {
            type: 'hook',
            hookName: `PreToolUse:${tool.name}`,
            hookSource: result.hookSource,
            reason: result.hookPermissionDecisionReason,
          }
          if (result.permissionBehavior === 'allow') {
            yield {
              type: 'hookPermissionResult',
              hookPermissionResult: {
                behavior: 'allow',
                updatedInput: result.updatedInput,
                decisionReason,
              },
            }
          } else if (result.permissionBehavior === 'ask') {
            yield {
              type: 'hookPermissionResult',
              hookPermissionResult: {
                behavior: 'ask',
                updatedInput: result.updatedInput,
                message:
                  result.hookPermissionDecisionReason ||
                  `Hook PreToolUse:${tool.name} ${getRuleBehaviorDescription(result.permissionBehavior)} this tool`,
                decisionReason,
              },
            }
          } else {
            // deny - updatedInput is irrelevant since tool won't run
            yield {
              type: 'hookPermissionResult',
              hookPermissionResult: {
                behavior: result.permissionBehavior,
                message:
                  result.hookPermissionDecisionReason ||
                  `Hook PreToolUse:${tool.name} ${getRuleBehaviorDescription(result.permissionBehavior)} this tool`,
                decisionReason,
              },
            }
          }
        }

        // 对透传情况 yield updatedInput（无权限决策时）
        // 这允许 hook 修改输入同时让正常权限流程继续
        if (result.updatedInput && result.permissionBehavior === undefined) {
          yield {
            type: 'hookUpdatedInput',
            updatedInput: result.updatedInput,
          }
        }

        // 若 hook 提供了额外上下文，将其作为消息添加
        if (result.additionalContexts && result.additionalContexts.length > 0) {
          yield {
            type: 'additionalContext',
            message: {
              message: createAttachmentMessage({
                type: 'hook_additional_context',
                content: result.additionalContexts,
                hookName: `PreToolUse:${tool.name}`,
                toolUseID,
                hookEvent: 'PreToolUse',
              }),
            },
          }
        }

        // 检查在 hook 执行期间是否被中止
        if (toolUseContext.abortController.signal.aborted) {
          logEvent('tengu_pre_tool_hooks_cancelled', {
            toolName: sanitizeToolNameForAnalytics(tool.name),

            queryChainId: toolUseContext.queryTracking
              ?.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            queryDepth: toolUseContext.queryTracking?.depth,
          })
          yield {
            type: 'message',
            message: {
              message: createAttachmentMessage({
                type: 'hook_cancelled',
                hookName: `PreToolUse:${tool.name}`,
                toolUseID,
                hookEvent: 'PreToolUse',
              }),
            },
          }
          yield { type: 'stop' }
          return
        }
      } catch (error) {
        logError(error)
        const durationMs = Date.now() - hookStartTime
        logEvent('tengu_pre_tool_hook_error', {
          messageID:
            messageId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          toolName: sanitizeToolNameForAnalytics(tool.name),
          isMcp: tool.isMcp ?? false,
          duration: durationMs,

          queryChainId: toolUseContext.queryTracking
            ?.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          queryDepth: toolUseContext.queryTracking?.depth,
          ...(mcpServerType
            ? {
                mcpServerType:
                  mcpServerType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              }
            : {}),
          ...(requestId
            ? {
                requestId:
                  requestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              }
            : {}),
        })
        yield {
          type: 'message',
          message: {
            message: createAttachmentMessage({
              type: 'hook_error_during_execution',
              content: formatError(error),
              hookName: `PreToolUse:${tool.name}`,
              toolUseID: toolUseID,
              hookEvent: 'PreToolUse',
            }),
          },
        }
        yield { type: 'stop' }
      }
    }
  } catch (error) {
    logError(error)
    yield { type: 'stop' }
    return
  }
}
