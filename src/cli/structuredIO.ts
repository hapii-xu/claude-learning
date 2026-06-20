import { feature } from 'bun:bundle'
import type {
  ElicitResult,
  JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js'
import { randomUUID } from 'crypto'
import type { AssistantMessage } from 'src//types/message.js'
import type {
  HookInput,
  HookJSONOutput,
  PermissionUpdate as SDKPermissionUpdate,
  SDKMessage,
  SDKUserMessage,
} from 'src/entrypoints/agentSdkTypes.js'
import { SDKControlElicitationResponseSchema } from 'src/entrypoints/sdk/controlSchemas.js'
import type {
  SDKControlRequest,
  SDKControlResponse,
  StdinMessage,
  StdoutMessage,
} from 'src/entrypoints/sdk/controlTypes.js'
import type { PermissionUpdate as InternalPermissionUpdate } from 'src/types/permissions.js'
import type { CanUseToolFn } from 'src/hooks/useCanUseTool.js'
import type { Tool, ToolUseContext } from 'src/Tool.js'
import { type HookCallback, hookJSONOutputSchema } from 'src/types/hooks.js'
import { logForDebugging } from 'src/utils/debug.js'
import { logForDiagnosticsNoPII } from 'src/utils/diagLogs.js'
import { AbortError } from 'src/utils/errors.js'
import {
  type Output as PermissionToolOutput,
  permissionPromptToolResultToPermissionDecision,
  outputSchema as permissionToolOutputSchema,
} from 'src/utils/permissions/PermissionPromptToolResultSchema.js'
import type {
  PermissionDecision,
  PermissionDecisionReason,
} from 'src/utils/permissions/PermissionResult.js'
import { hasPermissionsToUseTool } from 'src/utils/permissions/permissions.js'
import { writeToStdout } from 'src/utils/process.js'
import { jsonStringify } from 'src/utils/slowOperations.js'
import { z } from 'zod/v4'
import { notifyCommandLifecycle } from '../utils/commandLifecycle.js'
import { normalizeControlMessageKeys } from '../utils/controlMessageCompat.js'
import { executePermissionRequestHooks } from '../utils/hooks.js'
import {
  applyPermissionUpdates,
  persistPermissionUpdates,
} from '../utils/permissions/PermissionUpdate.js'
import {
  notifySessionStateChanged,
  type RequiresActionDetails,
  type SessionExternalMetadata,
} from '../utils/sessionState.js'
import { jsonParse } from '../utils/slowOperations.js'
import { Stream } from '../utils/stream.js'
import { ndjsonSafeStringify } from './ndjsonSafeStringify.js'

/**
 * 通过 can_use_tool control_request 协议转发沙箱网络权限请求时使用的
 * 合成工具名。SDK 宿主会把它当作一个普通的工具权限提示。
 */
export const SANDBOX_NETWORK_ACCESS_TOOL_NAME = 'SandboxNetworkAccess'

function serializeDecisionReason(
  reason: PermissionDecisionReason | undefined,
): string | undefined {
  if (!reason) {
    return undefined
  }

  if (
    (feature('BASH_CLASSIFIER') || feature('TRANSCRIPT_CLASSIFIER')) &&
    reason.type === 'classifier'
  ) {
    return reason.reason
  }
  switch (reason.type) {
    case 'rule':
    case 'mode':
    case 'subcommandResults':
    case 'permissionPromptTool':
      return undefined
    case 'hook':
    case 'asyncAgent':
    case 'sandboxOverride':
    case 'workingDir':
    case 'safetyCheck':
    case 'other':
      return reason.reason
  }
}

function buildRequiresActionDetails(
  tool: Tool,
  input: Record<string, unknown>,
  toolUseID: string,
  requestId: string,
): RequiresActionDetails {
  // 针对单个工具的摘要方法在面对异常输入时可能抛错；权限处理不能因为
  // 一个错误的描述而中断。
  let description: string
  try {
    description =
      tool.getActivityDescription?.(input) ??
      tool.getToolUseSummary?.(input) ??
      tool.userFacingName(input)
  } catch {
    description = tool.name
  }
  return {
    tool_name: tool.name,
    action_description: description,
    tool_use_id: toolUseID,
    request_id: requestId,
    input,
  }
}

type PendingRequest<T> = {
  resolve: (result: T) => void
  reject: (error: unknown) => void
  schema?: z.Schema
  request: SDKControlRequest
}

/**
 * 提供一种结构化的方式从 stdio 读写 SDK 消息，
 * 捕获 SDK 协议。
 */
// 跟踪已解决 tool_use ID 的最大数量。一旦超过，最旧的条目会被淘汰。
// 这样可以在超长会话中限制内存占用，同时保留足够的历史记录来
// 捕获重复的 control_response 投递。
const MAX_RESOLVED_TOOL_USE_IDS = 1000

export class StructuredIO {
  readonly structuredInput: AsyncGenerator<StdinMessage | SDKMessage>
  private readonly pendingRequests = new Map<string, PendingRequest<unknown>>()

  // 在 worker 启动时读取的 CCR external_metadata；当传输层不恢复时为 null。
  // 由 RemoteIO 赋值。
  restoredWorkerState: Promise<SessionExternalMetadata | null> =
    Promise.resolve(null)

  private inputClosed = false
  private unexpectedResponseCallback?: (
    response: SDKControlResponse,
  ) => Promise<void>

  // 跟踪已通过正常权限流程解决（或被 hook 中止）的 tool_use ID。当
  // 重复的 control_response 在原始请求已被处理之后到达时，这个 Set
  // 可以避免孤儿处理器再次处理它 — 否则会向 mutableMessages 推入重复的
  // assistant 消息，导致 API 报 400 "tool_use ids must be unique" 错误。
  private readonly resolvedToolUseIds = new Set<string>()
  private prependedLines: string[] = []
  private onControlRequestSent?: (request: SDKControlRequest) => void
  private onControlRequestResolved?: (requestId: string) => void

  // sendRequest() 和 print.ts 都会在这里入队；只有 drain 循环是唯一的写入方。
  // 防止 control_request 超越已入队的 stream_events。
  readonly outbound = new Stream<StdoutMessage>()

  constructor(
    private readonly input: AsyncIterable<string>,
    private readonly replayUserMessages?: boolean,
  ) {
    this.input = input
    this.structuredInput = this.read()
  }

  /**
   * 将一个 tool_use ID 记录为已解决，这样对于同一工具的迟到/重复
   * control_response 消息会被孤儿处理器忽略。
   */
  private trackResolvedToolUseId(request: SDKControlRequest): void {
    const inner = request.request as { subtype?: string; tool_use_id?: string }
    if (inner.subtype === 'can_use_tool') {
      this.resolvedToolUseIds.add(inner.tool_use_id as string)
      if (this.resolvedToolUseIds.size > MAX_RESOLVED_TOOL_USE_IDS) {
        // 淘汰最旧的条目（Set 按插入顺序迭代）
        const first = this.resolvedToolUseIds.values().next().value
        if (first !== undefined) {
          this.resolvedToolUseIds.delete(first)
        }
      }
    }
  }

  /** 刷新待处理的内部事件。对非远程 IO 是空操作。由 RemoteIO 覆写。 */
  flushInternalEvents(): Promise<void> {
    return Promise.resolve()
  }

  /** 内部事件队列深度。由 RemoteIO 覆写；其他情况下为 0。 */
  get internalEventsPending(): number {
    return 0
  }

  /**
   * 排队一个用户轮次，使其在 this.input 的下一条消息之前被 yield。
   * 在迭代开始前和流处理过程中都有效 — read() 会在
   * 每条 yield 的消息之间重新检查 prependedLines。
   */
  prependUserMessage(content: string): void {
    this.prependedLines.push(
      jsonStringify({
        type: 'user',
        content,
        uuid: '',
        session_id: '',
        message: { role: 'user', content },
        parent_tool_use_id: null,
      } satisfies SDKUserMessage) + '\n',
    )
  }

  private async *read() {
    let content = ''

    // 在 for-await 之前调用一次（否则空的 this.input 会完全跳过
    // 循环体），然后每个块再调用一次。prependedLines 的重新检查位于
    // while 内部，这样即使在同一个块的两条消息之间插入的 prepend 也
    // 仍会排在最前。
    const splitAndProcess = async function* (this: StructuredIO) {
      for (;;) {
        if (this.prependedLines.length > 0) {
          content = this.prependedLines.join('') + content
          this.prependedLines = []
        }
        const newline = content.indexOf('\n')
        if (newline === -1) break
        const line = content.slice(0, newline)
        content = content.slice(newline + 1)
        const message = await this.processLine(line)
        if (message) {
          logForDiagnosticsNoPII('info', 'cli_stdin_message_parsed', {
            type: message.type,
          })
          yield message
        }
      }
    }.bind(this)

    yield* splitAndProcess()

    for await (const block of this.input) {
      content += block
      yield* splitAndProcess()
    }
    if (content) {
      const message = await this.processLine(content)
      if (message) {
        yield message
      }
    }
    this.inputClosed = true
    for (const request of this.pendingRequests.values()) {
      // 如果输入流关闭，拒绝所有待处理请求
      request.reject(
        new Error('Tool permission stream closed before response received'),
      )
    }
  }

  getPendingPermissionRequests() {
    return Array.from(this.pendingRequests.values())
      .map(entry => entry.request)
      .filter(
        pr => (pr.request as { subtype?: string }).subtype === 'can_use_tool',
      )
  }

  setUnexpectedResponseCallback(
    callback: (response: SDKControlResponse) => Promise<void>,
  ): void {
    this.unexpectedResponseCallback = callback
  }

  /**
   * 注入一条 control_response 消息以解决一个待处理的权限请求。
   * 由 bridge 用来把来自 claude.ai 的权限响应喂入
   * SDK 权限流程。
   *
   * 同时向 SDK 消费者发送一条 control_cancel_request，让其 canUseTool
   * 回调通过 signal 被中止 — 否则回调会一直挂起。
   */
  injectControlResponse(response: SDKControlResponse): void {
    const responseInner = response.response as
      | {
          request_id?: string
          subtype?: string
          error?: string
          response?: unknown
        }
      | undefined
    const requestId = responseInner?.request_id
    if (!requestId) return
    const request = this.pendingRequests.get(requestId as string)
    if (!request) return
    this.trackResolvedToolUseId(request.request)
    this.pendingRequests.delete(requestId as string)
    // 取消 SDK 消费者的 canUseTool 回调 — bridge 获胜。
    void this.write({
      type: 'control_cancel_request',
      request_id: requestId,
    })
    if (responseInner.subtype === 'error') {
      request.reject(new Error(responseInner.error as string))
    } else {
      const result = responseInner.response
      if (request.schema) {
        try {
          request.resolve(request.schema.parse(result))
        } catch (error) {
          request.reject(error)
        }
      } else {
        request.resolve({})
      }
    }
  }

  /**
   * 注册一个回调，每当 can_use_tool control_request 被写入 stdout 时调用。
   * 由 bridge 用于把权限请求转发给 claude.ai。
   */
  setOnControlRequestSent(
    callback: ((request: SDKControlRequest) => void) | undefined,
  ): void {
    this.onControlRequestSent = callback
  }

  /**
   * 注册一个回调，当 can_use_tool control_response 从 SDK 消费者（通过 stdin）
   * 到达时调用。由 bridge 用于在 SDK 消费者赢得竞态时
   * 取消 claude.ai 上过期的权限提示。
   */
  setOnControlRequestResolved(
    callback: ((requestId: string) => void) | undefined,
  ): void {
    this.onControlRequestResolved = callback
  }

  private async processLine(
    line: string,
  ): Promise<StdinMessage | SDKMessage | undefined> {
    // 跳过空行（例如来自管道 stdin 中的双换行）
    if (!line) {
      return undefined
    }
    try {
      const message = normalizeControlMessageKeys(jsonParse(line)) as
        | StdinMessage
        | SDKMessage
      if (message.type === 'keep_alive') {
        // 静默忽略 keep-alive 消息
        return undefined
      }
      if (message.type === 'update_environment_variables') {
        // 直接将环境变量更新应用到 process.env。
        // 由 bridge session runner 用于 auth token 刷新
        //（CLAUDE_CODE_SESSION_ACCESS_TOKEN），该 token 必须能被
        // REPL 进程自身读取，而不仅仅是子 Bash 命令。
        const variables = message.variables ?? {}
        const keys = Object.keys(variables)
        for (const [key, value] of Object.entries(variables)) {
          process.env[key] = value
        }
        logForDebugging(
          `[structuredIO] applied update_environment_variables: ${keys.join(', ')}`,
        )
        return undefined
      }
      if (message.type === 'control_response') {
        // 为每一条 control_response 关闭生命周期，包括重复和孤儿消息 —
        // 孤儿消息不会进入 print.ts 的主循环，所以这里是唯一能看到它们的路径。
        // uuid 由服务器注入到 payload 中。
        const uuid =
          'uuid' in message && typeof message.uuid === 'string'
            ? message.uuid
            : undefined
        if (uuid) {
          notifyCommandLifecycle(uuid, 'completed')
        }
        const resp = message.response as {
          request_id: string
          subtype: string
          response?: Record<string, unknown>
          error?: string
        }
        const request = this.pendingRequests.get(resp.request_id)
        if (!request) {
          // 检查这个 tool_use 是否已通过正常权限流程被解决。重复的
          // control_response 投递（例如来自 WebSocket 重连）会在原始请求
          // 处理完之后才到达，如果再次处理它们，会向会话推入重复的
          // assistant 消息，导致 API 报 400 错误。
          const responsePayload =
            resp.subtype === 'success' ? resp.response : undefined
          const toolUseID = responsePayload?.toolUseID
          if (
            typeof toolUseID === 'string' &&
            this.resolvedToolUseIds.has(toolUseID)
          ) {
            logForDebugging(
              `Ignoring duplicate control_response for already-resolved toolUseID=${toolUseID} request_id=${resp.request_id}`,
            )
            return undefined
          }
          if (this.unexpectedResponseCallback) {
            await this.unexpectedResponseCallback(
              message as SDKControlResponse & { uuid?: string },
            )
          }
          return undefined // 忽略未知请求的响应
        }
        this.trackResolvedToolUseId(request.request)
        this.pendingRequests.delete(resp.request_id)
        // 当 SDK 消费者解决一个 can_use_tool 请求时通知 bridge，
        // 以便它能取消 claude.ai 上过期的权限提示。
        if (
          (request.request.request as { subtype?: string }).subtype ===
            'can_use_tool' &&
          this.onControlRequestResolved
        ) {
          this.onControlRequestResolved(resp.request_id)
        }

        if (resp.subtype === 'error') {
          request.reject(new Error(resp.error ?? 'Unknown error'))
          return undefined
        }
        const result = resp.response
        if (request.schema) {
          try {
            request.resolve(request.schema.parse(result))
          } catch (error) {
            request.reject(error)
          }
        } else {
          request.resolve({})
        }
        // 当启用 replay 时传播 control 响应
        if (this.replayUserMessages) {
          return message
        }
        return undefined
      }
      if (
        message.type !== 'user' &&
        message.type !== 'control_request' &&
        message.type !== 'assistant' &&
        message.type !== 'system'
      ) {
        logForDebugging(`Ignoring unknown message type: ${message.type}`, {
          level: 'warn',
        })
        return undefined
      }
      if (message.type === 'control_request') {
        if (!message.request) {
          exitWithMessage(`Error: Missing request on control_request`)
        }
        return message
      }
      if (message.type === 'assistant' || message.type === 'system') {
        return message
      }
      if (
        (message as { message?: { role?: string } }).message?.role !== 'user'
      ) {
        exitWithMessage(
          `Error: Expected message role 'user', got '${(message as { message?: { role?: string } }).message?.role}'`,
        )
      }
      return message
    } catch (error) {
      console.error(`Error parsing streaming input line: ${line}: ${error}`)
      // eslint-disable-next-line custom-rules/no-process-exit
      process.exit(1)
    }
  }

  async write(message: StdoutMessage): Promise<void> {
    writeToStdout(ndjsonSafeStringify(message) + '\n')
  }

  private async sendRequest<Response>(
    request: SDKControlRequest['request'],
    schema: z.Schema,
    signal?: AbortSignal,
    requestId: string = randomUUID(),
  ): Promise<Response> {
    const message: SDKControlRequest = {
      type: 'control_request',
      request_id: requestId,
      request,
    }
    if (this.inputClosed) {
      throw new Error('Stream closed')
    }
    if (signal?.aborted) {
      throw new Error('Request aborted')
    }
    this.outbound.enqueue(message)
    if (
      (request as { subtype?: string }).subtype === 'can_use_tool' &&
      this.onControlRequestSent
    ) {
      this.onControlRequestSent(message)
    }
    const aborted = () => {
      this.outbound.enqueue({
        type: 'control_cancel_request',
        request_id: requestId,
      })
      // 立即拒绝未完成的 promise，无需
      // 等待宿主确认取消。
      const request = this.pendingRequests.get(requestId)
      if (request) {
        // 在 reject 之前将 tool_use ID 标记为已解决，这样宿主的
        // 迟到响应会被孤儿处理器忽略。
        this.trackResolvedToolUseId(request.request)
        request.reject(new AbortError())
      }
    }
    if (signal) {
      signal.addEventListener('abort', aborted, {
        once: true,
      })
    }
    try {
      return await new Promise<Response>((resolve, reject) => {
        this.pendingRequests.set(requestId, {
          request: {
            type: 'control_request',
            request_id: requestId,
            request,
          },
          resolve: result => {
            resolve(result as Response)
          },
          reject,
          schema,
        })
      })
    } finally {
      if (signal) {
        signal.removeEventListener('abort', aborted)
      }
      this.pendingRequests.delete(requestId)
    }
  }

  createCanUseTool(
    onPermissionPrompt?: (details: RequiresActionDetails) => void,
  ): CanUseToolFn {
    return async (
      tool: Tool,
      input: { [key: string]: unknown },
      toolUseContext: ToolUseContext,
      assistantMessage: AssistantMessage,
      toolUseID: string,
      forceDecision?: PermissionDecision,
    ): Promise<PermissionDecision> => {
      const mainPermissionResult =
        forceDecision ??
        (await hasPermissionsToUseTool(
          tool,
          input,
          toolUseContext,
          assistantMessage,
          toolUseID,
        ))
      // 如果工具被允许或拒绝，则返回结果
      if (
        mainPermissionResult.behavior === 'allow' ||
        mainPermissionResult.behavior === 'deny'
      ) {
        return mainPermissionResult
      }

      // 与 SDK 权限提示并行运行 PermissionRequest hooks。在终端 CLI 中，
      // hooks 会与交互式提示竞争，例如一个 --delay 20 的 hook 不会阻塞 UI。
      // 这里需要相同的行为：SDK 宿主（VS Code 等）会立即弹出其权限对话框，
      // 同时 hooks 在后台运行。谁先解决谁获胜；失败方被取消/忽略。

      // AbortController 用于在 hook 先决定时取消 SDK 请求
      const hookAbortController = new AbortController()
      const parentSignal = toolUseContext.abortController.signal
      // 将父级的 abort 转发到本地 controller
      const onParentAbort = () => hookAbortController.abort()
      parentSignal.addEventListener('abort', onParentAbort, { once: true })

      try {
        // 启动 hook 评估（在后台运行）
        const hookPromise = executePermissionRequestHooksForSDK(
          tool.name,
          toolUseID,
          input,
          toolUseContext,
          mainPermissionResult.suggestions,
        ).then(decision => ({ source: 'hook' as const, decision }))

        // 立即启动 SDK 权限提示（不等 hooks）
        const requestId = randomUUID()
        onPermissionPrompt?.(
          buildRequiresActionDetails(tool, input, toolUseID, requestId),
        )
        const sdkPromise = this.sendRequest<PermissionToolOutput>(
          {
            subtype: 'can_use_tool',
            tool_name: tool.name,
            input,
            permission_suggestions: mainPermissionResult.suggestions,
            blocked_path: mainPermissionResult.blockedPath,
            decision_reason: serializeDecisionReason(
              mainPermissionResult.decisionReason,
            ),
            tool_use_id: toolUseID,
            agent_id: toolUseContext.agentId,
          },
          permissionToolOutputSchema(),
          hookAbortController.signal,
          requestId,
        ).then(result => ({ source: 'sdk' as const, result }))

        // 竞态：hook 完成与 SDK 提示响应。
        // hook promise 总是 resolve（从不 reject），如果没有 hook 做出决定
        // 则返回 undefined。
        const winner = await Promise.race([hookPromise, sdkPromise])

        if (winner.source === 'hook') {
          if (winner.decision) {
            // hook 做出了决定 — 中止待处理的 SDK 请求。
            // 抑制 sdkPromise 预期会抛出的 AbortError rejection。
            sdkPromise.catch(() => {})
            hookAbortController.abort()
            return winner.decision
          }
          // hook 放行（无决定）— 等待 SDK 提示
          const sdkResult = await sdkPromise
          return permissionPromptToolResultToPermissionDecision(
            sdkResult.result,
            tool,
            input,
            toolUseContext,
          )
        }

        // SDK 提示先响应 — 使用其结果（hook 仍在后台运行，
        // 但其结果会被忽略）
        return permissionPromptToolResultToPermissionDecision(
          winner.result,
          tool,
          input,
          toolUseContext,
        )
      } catch (error) {
        return permissionPromptToolResultToPermissionDecision(
          {
            behavior: 'deny',
            message: `Tool permission request failed: ${error}`,
            toolUseID,
          },
          tool,
          input,
          toolUseContext,
        )
      } finally {
        // 只有在没有其他权限提示待处理时才切回 'running' 状态
        //（并发工具执行时可能同时有多个进行中）。
        if (this.getPendingPermissionRequests().length === 0) {
          notifySessionStateChanged('running')
        }
        parentSignal.removeEventListener('abort', onParentAbort)
      }
    }
  }

  createHookCallback(callbackId: string, timeout?: number): HookCallback {
    return {
      type: 'callback',
      timeout,
      callback: async (
        input: HookInput,
        toolUseID: string | null,
        abort: AbortSignal | undefined,
      ): Promise<HookJSONOutput> => {
        try {
          const result = await this.sendRequest<HookJSONOutput>(
            {
              subtype: 'hook_callback',
              callback_id: callbackId,
              input: input as any,
              tool_use_id: toolUseID || undefined,
            },
            hookJSONOutputSchema(),
            abort,
          )
          return result
        } catch (error) {
          console.error(`Error in hook callback ${callbackId}:`, error)
          return {}
        }
      },
    }
  }

  /**
   * 向 SDK 消费者发送 elicitation 请求并返回响应。
   */
  async handleElicitation(
    serverName: string,
    message: string,
    requestedSchema?: Record<string, unknown>,
    signal?: AbortSignal,
    mode?: 'form' | 'url',
    url?: string,
    elicitationId?: string,
  ): Promise<ElicitResult> {
    try {
      const result = await this.sendRequest<ElicitResult>(
        {
          subtype: 'elicitation',
          mcp_server_name: serverName,
          message,
          mode,
          url,
          elicitation_id: elicitationId,
          requested_schema: requestedSchema,
        },
        SDKControlElicitationResponseSchema(),
        signal,
      )
      return result
    } catch {
      return { action: 'cancel' as const }
    }
  }

  /**
   * 创建一个 SandboxAskCallback，把沙箱网络权限请求作为
   * can_use_tool control_requests 转发给 SDK 宿主。
   *
   * 这里借助现有的 can_use_tool 协议并使用一个合成工具名，使 SDK 宿主
   *（VS Code、CCR 等）可以提示用户授予网络访问权限，而无需引入新的协议
   * 子类型。
   */
  createSandboxAskCallback(): (hostPattern: {
    host: string
    port?: number
  }) => Promise<boolean> {
    return async (hostPattern): Promise<boolean> => {
      try {
        const result = await this.sendRequest<PermissionToolOutput>(
          {
            subtype: 'can_use_tool',
            tool_name: SANDBOX_NETWORK_ACCESS_TOOL_NAME,
            input: { host: hostPattern.host },
            tool_use_id: randomUUID(),
            description: `Allow network connection to ${hostPattern.host}?`,
          },
          permissionToolOutputSchema(),
        )
        return result.behavior === 'allow'
      } catch {
        // 如果请求失败（流关闭、中止等），拒绝连接
        return false
      }
    }
  }

  /**
   * 向 SDK server 发送 MCP 消息并等待响应
   */
  async sendMcpMessage(
    serverName: string,
    message: JSONRPCMessage,
  ): Promise<JSONRPCMessage> {
    const response = await this.sendRequest<{ mcp_response: JSONRPCMessage }>(
      {
        subtype: 'mcp_message',
        server_name: serverName,
        message,
      },
      z.object({
        mcp_response: z.any() as z.Schema<JSONRPCMessage>,
      }),
    )
    return response.mcp_response
  }
}

function exitWithMessage(message: string): never {
  console.error(message)
  // eslint-disable-next-line custom-rules/no-process-exit
  process.exit(1)
}

/**
 * 执行 PermissionRequest hooks 并在做出决定时返回该决定。
 * 如果没有 hook 做出决定则返回 undefined。
 */
async function executePermissionRequestHooksForSDK(
  toolName: string,
  toolUseID: string,
  input: Record<string, unknown>,
  toolUseContext: ToolUseContext,
  suggestions: InternalPermissionUpdate[] | undefined,
): Promise<PermissionDecision | undefined> {
  const appState = toolUseContext.getAppState()
  const permissionMode = appState.toolPermissionContext.mode

  // 直接迭代生成器，而不是使用 `all`
  const hookGenerator = executePermissionRequestHooks(
    toolName,
    toolUseID,
    input,
    toolUseContext,
    permissionMode,
    suggestions as unknown as SDKPermissionUpdate[] | undefined,
    toolUseContext.abortController.signal,
  )

  for await (const hookResult of hookGenerator) {
    if (
      hookResult.permissionRequestResult &&
      (hookResult.permissionRequestResult.behavior === 'allow' ||
        hookResult.permissionRequestResult.behavior === 'deny')
    ) {
      const decision = hookResult.permissionRequestResult
      if (decision.behavior === 'allow') {
        const finalInput = decision.updatedInput || input

        // 如果 hook 提供了权限更新则应用（"always allow"）
        const permissionUpdates = (decision.updatedPermissions ??
          []) as unknown as InternalPermissionUpdate[]
        if (permissionUpdates.length > 0) {
          persistPermissionUpdates(permissionUpdates)
          const currentAppState = toolUseContext.getAppState()
          const updatedContext = applyPermissionUpdates(
            currentAppState.toolPermissionContext,
            permissionUpdates,
          )
          // 通过 setAppState 更新权限上下文
          toolUseContext.setAppState(prev => {
            if (prev.toolPermissionContext === updatedContext) return prev
            return { ...prev, toolPermissionContext: updatedContext }
          })
        }

        return {
          behavior: 'allow',
          updatedInput: finalInput,
          userModified: false,
          decisionReason: {
            type: 'hook',
            hookName: 'PermissionRequest',
          },
        }
      } else {
        // hook 拒绝了该权限
        return {
          behavior: 'deny',
          message:
            decision.message || 'Permission denied by PermissionRequest hook',
          decisionReason: {
            type: 'hook',
            hookName: 'PermissionRequest',
          },
        }
      }
    }
  }

  return undefined
}
