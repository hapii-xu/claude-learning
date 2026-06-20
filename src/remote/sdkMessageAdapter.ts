import type {
  SDKAssistantMessage,
  SDKCompactBoundaryMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKStatusMessage,
  SDKSystemMessage,
  SDKToolProgressMessage,
  SDKUserMessage,
} from '../entrypoints/agentSdkTypes.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemMessage,
} from '../types/message.js'
import { logForDebugging } from '../utils/debug.js'
import { fromSDKCompactMetadata } from '../utils/messages/mappers.js'
import { createUserMessage } from '../utils/messages.js'

/**
 * 将 CCR 的 SDKMessage 转换为 REPL 的 Message 类型。
 *
 * CCR 后端通过 WebSocket 发送 SDK 格式的消息，而 REPL 期望使用
 * 内部 Message 类型进行渲染。此适配器用于桥接两者。
 */

/**
 * 将 SDKAssistantMessage 转换为 AssistantMessage
 */
function convertAssistantMessage(msg: SDKAssistantMessage): AssistantMessage {
  return {
    type: 'assistant',
    message: msg.message!,
    uuid: msg.uuid!,
    requestId: undefined,
    timestamp: new Date().toISOString(),
    error: msg.error,
  }
}

/**
 * 将 SDKPartialAssistantMessage（流式）转换为 StreamEvent
 */
function convertStreamEvent(msg: SDKPartialAssistantMessage): StreamEvent {
  return {
    type: 'stream_event',
    event: msg.event,
  }
}

/**
 * 将 SDKResultMessage 转换为 SystemMessage
 */
function convertResultMessage(msg: SDKResultMessage): SystemMessage {
  const isError = msg.subtype !== 'success'
  const content = isError
    ? msg.errors?.join(', ') || 'Unknown error'
    : 'Session completed successfully'

  return {
    type: 'system',
    subtype: 'informational',
    content,
    level: isError ? 'warning' : 'info',
    uuid: msg.uuid!,
    timestamp: new Date().toISOString(),
  }
}

/**
 * 将 SDKSystemMessage（init）转换为 SystemMessage
 */
function convertInitMessage(msg: SDKSystemMessage): SystemMessage {
  return {
    type: 'system',
    subtype: 'informational',
    content: `Remote session initialized (model: ${msg.model})`,
    level: 'info',
    uuid: msg.uuid!,
    timestamp: new Date().toISOString(),
  }
}

/**
 * 将 SDKStatusMessage 转换为 SystemMessage
 */
function convertStatusMessage(msg: SDKStatusMessage): SystemMessage | null {
  if (!msg.status) {
    return null
  }

  return {
    type: 'system',
    subtype: 'informational',
    content:
      msg.status === 'compacting'
        ? 'Compacting conversation…'
        : `Status: ${msg.status}`,
    level: 'info',
    uuid: msg.uuid!,
    timestamp: new Date().toISOString(),
  }
}

/**
 * 将 SDKToolProgressMessage 转换为 SystemMessage。
 * 我们使用系统消息而不是 ProgressMessage，因为 Progress 类型
 * 是一个复杂的联合类型，需要从 CCR 获取我们没有的工具特定数据。
 */
function convertToolProgressMessage(
  msg: SDKToolProgressMessage,
): SystemMessage {
  return {
    type: 'system',
    subtype: 'informational',
    content: `Tool ${msg.tool_name} running for ${msg.elapsed_time_seconds}s…`,
    level: 'info',
    uuid: msg.uuid!,
    timestamp: new Date().toISOString(),
    toolUseID: msg.tool_use_id,
  }
}

/**
 * 将 SDKCompactBoundaryMessage 转换为 SystemMessage
 */
function convertCompactBoundaryMessage(
  msg: SDKCompactBoundaryMessage,
): SystemMessage {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    level: 'info',
    uuid: msg.uuid!,
    timestamp: new Date().toISOString(),
    compactMetadata: fromSDKCompactMetadata(msg.compact_metadata),
  }
}

/**
 * 转换 SDKMessage 的结果
 */
export type ConvertedMessage =
  | { type: 'message'; message: Message }
  | { type: 'stream_event'; event: StreamEvent }
  | { type: 'ignored' }

type ConvertOptions = {
  /** 将包含 tool_result 内容块的 user 消息转换为 UserMessages。
   * 用于 direct connect 模式 —— 该模式下工具结果来自远程服务器，
   * 需要在本地渲染。CCR 模式忽略 user 消息，因为它们的处理方式不同。 */
  convertToolResults?: boolean
  /**
   * 将用户文本消息转换为 UserMessages 以便显示。用于转换历史事件的场景，
   * 此时用户输入的消息需要被展示。
   * 在实时 WS 模式下，这些消息已经由 REPL 在本地添加，因此默认会被忽略。
   */
  convertUserTextMessages?: boolean
}

/**
 * 将 SDKMessage 转换为 REPL 消息格式
 */
export function convertSDKMessage(
  msg: SDKMessage,
  opts?: ConvertOptions,
): ConvertedMessage {
  switch (msg.type) {
    case 'assistant':
      return {
        type: 'message',
        message: convertAssistantMessage(msg as SDKAssistantMessage),
      }

    case 'user': {
      const userMsg = msg as SDKUserMessage
      const content = userMsg.message?.content
      // 来自远程服务器的工具结果消息需要被转换，以便
      // 它们像本地工具结果一样渲染和折叠。通过内容形状
      // （tool_result 块）来检测 —— parent_tool_use_id 不可靠：
      // agent 端的 normalizeMessage() 将其硬编码为 null（针对顶级
      // 工具结果），所以无法用它区分工具结果和提示回显。
      const isToolResult =
        Array.isArray(content) && content.some(b => b.type === 'tool_result')
      if (opts?.convertToolResults && isToolResult) {
        return {
          type: 'message',
          message: createUserMessage({
            content,
            toolUseResult: userMsg.tool_use_result,
            uuid: userMsg.uuid,
            timestamp: userMsg.timestamp,
          }),
        }
      }
      // 转换历史事件时，用户输入的消息需要被渲染
      // （它们没有被 REPL 在本地添加）。这里跳过 tool_results —— 已在上面处理。
      if (opts?.convertUserTextMessages && !isToolResult) {
        if (typeof content === 'string' || Array.isArray(content)) {
          return {
            type: 'message',
            message: createUserMessage({
              content,
              toolUseResult: userMsg.tool_use_result,
              uuid: userMsg.uuid,
              timestamp: userMsg.timestamp,
            }),
          }
        }
      }
      // 用户输入的消息（字符串内容）已由 REPL 在本地添加。
      // 在 CCR 模式下，所有 user 消息都会被忽略（工具结果的处理方式不同）。
      return { type: 'ignored' }
    }

    case 'stream_event':
      return {
        type: 'stream_event',
        event: convertStreamEvent(msg as SDKPartialAssistantMessage),
      }

    case 'result':
      // 仅在出错时显示 result 消息。在多轮会话中，成功结果是噪音
      // （isLoading=false 已经是充分的信号）。
      if ((msg as SDKResultMessage).subtype !== 'success') {
        return {
          type: 'message',
          message: convertResultMessage(msg as SDKResultMessage),
        }
      }
      return { type: 'ignored' }

    case 'system': {
      const sysMsg = msg as SDKSystemMessage
      if (sysMsg.subtype === 'init') {
        return { type: 'message', message: convertInitMessage(sysMsg) }
      }
      if (sysMsg.subtype === 'status') {
        const statusMsg = convertStatusMessage(msg as SDKStatusMessage)
        return statusMsg
          ? { type: 'message', message: statusMsg }
          : { type: 'ignored' }
      }
      if (sysMsg.subtype === 'compact_boundary') {
        return {
          type: 'message',
          message: convertCompactBoundaryMessage(
            msg as SDKCompactBoundaryMessage,
          ),
        }
      }
      // hook_response 及其他子类型
      logForDebugging(
        `[sdkMessageAdapter] Ignoring system message subtype: ${sysMsg.subtype}`,
      )
      return { type: 'ignored' }
    }

    case 'tool_progress':
      return {
        type: 'message',
        message: convertToolProgressMessage(msg as SDKToolProgressMessage),
      }

    case 'auth_status':
      // auth status 单独处理，不转换为可显示的消息
      logForDebugging('[sdkMessageAdapter] Ignoring auth_status message')
      return { type: 'ignored' }

    case 'tool_use_summary':
      // tool_use_summary 是 SDK 专用事件，不在 REPL 中显示
      logForDebugging('[sdkMessageAdapter] Ignoring tool_use_summary message')
      return { type: 'ignored' }

    case 'rate_limit_event':
      // rate_limit_event 是 SDK 专用事件，不在 REPL 中显示
      logForDebugging('[sdkMessageAdapter] Ignoring rate_limit_event message')
      return { type: 'ignored' }

    case 'task_state':
      // bridge 专用的任务快照由 web 面板消费，不提供给 REPL UI。
      logForDebugging('[sdkMessageAdapter] Ignoring task_state message')
      return { type: 'ignored' }

    default: {
      // 优雅地忽略未知消息类型。后端可能在客户端更新之前
      // 发送新类型；记录日志有助于调试，同时不会崩溃或丢失会话。
      logForDebugging(
        `[sdkMessageAdapter] Unknown message type: ${(msg as { type: string }).type}`,
      )
      return { type: 'ignored' }
    }
  }
}

/**
 * 检查 SDKMessage 是否表示会话已结束
 */
export function isSessionEndMessage(msg: SDKMessage): boolean {
  return msg.type === 'result'
}

/**
 * 检查 SDKResultMessage 是否表示成功
 */
export function isSuccessResult(msg: SDKResultMessage): boolean {
  return msg.subtype === 'success'
}

/**
 * 从成功的 SDKResultMessage 中提取结果文本
 */
export function getResultText(msg: SDKResultMessage): string | null {
  if (msg.subtype === 'success') {
    return msg.result ?? null
  }
  return null
}
