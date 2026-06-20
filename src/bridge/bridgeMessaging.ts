/**
 * bridge 消息处理的共享 transport 层辅助函数。
 *
 * 从 replBridge.ts 抽出，让 env-based core（initBridgeCore）和
 * env-less core（initEnvLessBridgeCore）共用同一套 ingress 解析、
 * control-request 处理和 echo 去重机制。
 *
 * 这里全是纯函数 —— 不闭包任何 bridge 相关状态。所有协作对象
 * （transport、sessionId、UUID 集合、回调）都通过参数传入。
 */

import { randomUUID } from 'crypto'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import type {
  SDKControlRequest,
  SDKControlResponse,
} from '../entrypoints/sdk/controlTypes.js'
import type { SDKResultSuccess } from '../entrypoints/sdk/coreTypes.js'
import { logEvent } from '../services/analytics/index.js'
import { EMPTY_USAGE } from '@ant/model-provider'
import type { Message } from '../types/message.js'
import { normalizeControlMessageKeys } from '../utils/controlMessageCompat.js'
import { logForDebugging } from '../utils/debug.js'
import { rcLog } from './rcDebugLog.js'
import { stripDisplayTagsAllowEmpty } from '../utils/displayTags.js'
import { errorMessage } from '../utils/errors.js'
import type { PermissionMode } from '../utils/permissions/PermissionMode.js'
import { jsonParse } from '../utils/slowOperations.js'
import type { ReplBridgeTransport } from './replBridgeTransport.js'
import {
  BASH_INPUT_TAG,
  CHANNEL_MESSAGE_TAG,
  CROSS_SESSION_MESSAGE_TAG,
  LOCAL_COMMAND_CAVEAT_TAG,
  REMOTE_REVIEW_PROGRESS_TAG,
  REMOTE_REVIEW_TAG,
  TASK_NOTIFICATION_TAG,
  TEAMMATE_MESSAGE_TAG,
  TICK_TAG,
  ULTRAPLAN_TAG,
} from '../constants/xml.js'

// ─── 类型守卫 ─────────────────────────────────────────────────────────────

/** 解析 WebSocket 消息的类型谓词。SDKMessage 是基于 `type` 的可辨识联合，
 *  校验可辨识字段即可满足谓词；调用方再通过联合类型进一步收窄。 */
export function isSDKMessage(value: unknown): value is SDKMessage {
  return (
    value !== null &&
    typeof value === 'object' &&
    'type' in value &&
    typeof value.type === 'string'
  )
}

/** 服务器下发的 control_response 消息的类型谓词。 */
export function isSDKControlResponse(
  value: unknown,
): value is SDKControlResponse {
  return (
    value !== null &&
    typeof value === 'object' &&
    'type' in value &&
    value.type === 'control_response' &&
    'response' in value
  )
}

/** 服务器下发的 control_request 消息的类型谓词。 */
export function isSDKControlRequest(
  value: unknown,
): value is SDKControlRequest {
  return (
    value !== null &&
    typeof value === 'object' &&
    'type' in value &&
    value.type === 'control_request' &&
    'request_id' in value &&
    'request' in value
  )
}

/**
 * 为应转发到 bridge transport 的消息类型返回 true。
 * 服务器只想要 user/assistant 回合以及 slash-command 的 system 事件；
 * 其他消息（tool_result、progress 等）都是 REPL 内部杂项。
 */
export function isEligibleBridgeMessage(m: Message): boolean {
  // Virtual 消息（REPL 内部调用）只用于展示 —— bridge/SDK
  // 消费方看到的是总结了工作的 REPL tool_use/result。
  if ((m.type === 'user' || m.type === 'assistant') && m.isVirtual) {
    return false
  }
  return (
    m.type === 'user' ||
    m.type === 'assistant' ||
    (m.type === 'system' && m.subtype === 'local_command')
  )
}

/**
 * 从 Message 中提取可用于 onUserMessage 的标题候选文本。对于不应用作
 * 标题的消息返回 undefined：非 user、meta（nudge）、tool result、
 * compact 摘要、非人类来源（task notification、channel message），
 * 或纯 display-tag 内容（<ide_opened_file>、<session-start-hook> 等）。
 *
 * 合成的 interrupt（[Request interrupted by user]）不在这里过滤 ——
 * isSyntheticMessage 位于 messages.ts（重依赖，会拉入 command registry）。
 * initReplBridge 的 initialMessages 路径会单独检查它；走 writeMessages
 * 路径时，把 interrupt 当作*第一条*消息几乎不可能（interrupt 必然意味着
 * 之前已有 prompt 流经过）。
 */
export function extractTitleText(m: Message): string | undefined {
  if (m.type !== 'user' || m.isMeta || m.toolUseResult || m.isCompactSummary)
    return undefined
  if (m.origin && (m.origin as { kind?: string }).kind !== 'human')
    return undefined
  const content = m.message!.content
  let raw: string | undefined
  if (typeof content === 'string') {
    raw = content
  } else {
    for (const block of content ?? []) {
      if (block.type === 'text') {
        raw = block.text
        break
      }
    }
  }
  if (!raw) return undefined
  const clean = stripDisplayTagsAllowEmpty(raw)
  return clean || undefined
}

const SYSTEM_REMINDER_TAG = 'system-reminder'
const XML_BLOCK_PATTERN = /\s*<([a-z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>\s*/gy
const RUNNING_STATE_META_TAGS = new Set([
  BASH_INPUT_TAG,
  CHANNEL_MESSAGE_TAG,
  CROSS_SESSION_MESSAGE_TAG,
  REMOTE_REVIEW_PROGRESS_TAG,
  REMOTE_REVIEW_TAG,
  TASK_NOTIFICATION_TAG,
  TEAMMATE_MESSAGE_TAG,
  TICK_TAG,
  ULTRAPLAN_TAG,
])

function extractUserMessageText(message: Message): string {
  const content = message.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      (
        block,
      ): block is {
        type: 'text'
        text: string
      } =>
        !!block &&
        typeof block === 'object' &&
        block.type === 'text' &&
        typeof block.text === 'string',
    )
    .map(block => block.text)
    .join('')
}

function getEnvelopeTagNames(text: string): string[] | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  XML_BLOCK_PATTERN.lastIndex = 0
  const tags: string[] = []
  while (XML_BLOCK_PATTERN.lastIndex < trimmed.length) {
    const match = XML_BLOCK_PATTERN.exec(trimmed)
    if (!match) return null
    tags.push(match[1]!)
  }
  return tags.length > 0 ? tags : null
}

/**
 * Remote Control 在服务器不主动给出"当前回合正在跑"状态时，会用
 * user 消息来推断。隐式的本地 slash-command 脚手架（例如
 * `<local-command-caveat>` 以及 `/proactive` 的纯 `<system-reminder>`
 * 包裹）不应该在命令已经结束后把 session 重新翻回 running 状态。
 */
export function shouldReportRunningForMessage(message: Message): boolean {
  if (message.type !== 'user') return false
  if (message.isVisibleInTranscriptOnly) return false
  if (message.toolUseResult !== undefined) return true
  if (!message.isMeta) return true

  const tags = getEnvelopeTagNames(extractUserMessageText(message))
  if (!tags) return true

  return tags.some(
    tag =>
      tag !== LOCAL_COMMAND_CAVEAT_TAG &&
      tag !== SYSTEM_REMINDER_TAG &&
      RUNNING_STATE_META_TAGS.has(tag),
  )
}

export function shouldReportRunningForMessages(
  messages: readonly Message[],
): boolean {
  return messages.some(shouldReportRunningForMessage)
}

// ─── Ingress 路由 ─────────────────────────────────────────────────────────

/**
 * 解析 ingress WebSocket 消息，并将其路由到相应的处理器。
 * 忽略 UUID 在 recentPostedUUIDs（我们发出的回声）或
 * recentInboundUUIDs（已转发过的重复下发 —— 例如 transport 切换丢失
 * seq-num 游标后服务器重放历史）中的消息。
 */
export function handleIngressMessage(
  data: string,
  recentPostedUUIDs: BoundedUUIDSet,
  recentInboundUUIDs: BoundedUUIDSet,
  onInboundMessage: ((msg: SDKMessage) => void | Promise<void>) | undefined,
  onPermissionResponse?: ((response: SDKControlResponse) => void) | undefined,
  onControlRequest?: ((request: SDKControlRequest) => void) | undefined,
): void {
  try {
    const parsed: unknown = normalizeControlMessageKeys(jsonParse(data))

    // control_response 不是 SDKMessage —— 先于类型守卫检查
    if (isSDKControlResponse(parsed)) {
      logForDebugging('[bridge:repl] Ingress message type=control_response')
      onPermissionResponse?.(parsed)
      return
    }

    // 来自服务器的 control_request（initialize、set_model、can_use_tool）。
    // 必须及时响应，否则服务器会杀掉 WS（约 10-14s 超时）。
    if (isSDKControlRequest(parsed)) {
      logForDebugging(
        `[bridge:repl] Inbound control_request subtype=${(parsed.request as { subtype?: string }).subtype}`,
      )
      onControlRequest?.(parsed)
      return
    }

    if (!isSDKMessage(parsed)) return

    // 通过 UUID 检测我们自己发出的回声
    const uuid =
      'uuid' in parsed && typeof parsed.uuid === 'string'
        ? parsed.uuid
        : undefined

    if (uuid && recentPostedUUIDs.has(uuid)) {
      logForDebugging(
        `[bridge:repl] Ignoring echo: type=${parsed.type} uuid=${uuid}`,
      )
      return
    }

    // 防御性去重：丢弃已转发过的 inbound prompt。SSE seq-num 携带
    //（lastTransportSequenceNum）是处理 history-replay 的主要方案；
    // 这里用来兜底协商失败的边缘场景（服务器忽略 from_sequence_num、
    // transport 还没收到任何 frame 就挂了等）。
    if (uuid && recentInboundUUIDs.has(uuid)) {
      logForDebugging(
        `[bridge:repl] Ignoring re-delivered inbound: type=${parsed.type} uuid=${uuid}`,
      )
      return
    }

    logForDebugging(
      `[bridge:repl] Ingress message type=${parsed.type}${uuid ? ` uuid=${uuid}` : ''}`,
    )

    if (parsed.type === 'user') {
      if (uuid) recentInboundUUIDs.add(uuid)
      logEvent('tengu_bridge_message_received', {
        is_repl: true,
      })
      // Fire-and-forget —— handler 可能是 async（附件解析等）。
      void onInboundMessage?.(parsed)
    } else {
      logForDebugging(
        `[bridge:repl] Ignoring non-user inbound message: type=${parsed.type}`,
      )
    }
  } catch (err) {
    logForDebugging(
      `[bridge:repl] Failed to parse ingress message: ${errorMessage(err)}`,
    )
  }
}

// ─── 服务器发起的 control request ───────────────────────────────────────

export type ServerControlRequestHandlers = {
  transport: ReplBridgeTransport | null
  sessionId: string
  /**
   * 为 true 时，所有可变请求（interrupt、set_model、set_permission_mode、
   * set_max_thinking_tokens）都以错误而非伪成功回应。
   * initialize 仍回复成功 —— 否则服务器会杀掉连接。
   * 被 outbound-only bridge 模式和 SDK 的 /bridge 子路径使用，让 claude.ai
   * 看到真正的错误，而不是"操作成功但本地没发生任何事"。
   */
  outboundOnly?: boolean
  onInterrupt?: () => void
  onSetModel?: (model: string | undefined) => void
  onSetMaxThinkingTokens?: (maxTokens: number | null) => void
  onSetPermissionMode?: (
    mode: PermissionMode,
  ) => { ok: true } | { ok: false; error: string }
}

const OUTBOUND_ONLY_ERROR =
  'This session is outbound-only. Enable Remote Control locally to allow inbound control.'

/**
 * 响应来自服务器的 inbound control_request。服务器为 session 生命周期
 * 事件（initialize、set_model）以及回合级协调（interrupt、
 * set_max_thinking_tokens）下发这些请求。不响应的话服务器会挂起，
 * 约 10-14s 后杀掉 WS。
 *
 * 之前是 initBridgeCore 的 onWorkReceived 内部闭包；现在把协作对象
 * 改为参数传入，让两个 core 都能复用。
 */
export function handleServerControlRequest(
  request: SDKControlRequest,
  handlers: ServerControlRequestHandlers,
): void {
  const {
    transport,
    sessionId,
    outboundOnly,
    onInterrupt,
    onSetModel,
    onSetMaxThinkingTokens,
    onSetPermissionMode,
  } = handlers
  if (!transport) {
    logForDebugging(
      '[bridge:repl] Cannot respond to control_request: transport not configured',
    )
    return
  }

  let response: SDKControlResponse

  // Outbound-only：对可变请求回复错误，避免 claude.ai 显示伪成功。
  // initialize 仍要成功（否则服务器会杀掉连接 —— 见上文注释）。
  const req = request.request as {
    subtype: string
    model?: string
    max_thinking_tokens?: number | null
    mode?: string
    [key: string]: unknown
  }
  if (outboundOnly && req.subtype !== 'initialize') {
    response = {
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: request.request_id,
        error: OUTBOUND_ONLY_ERROR,
      },
    }
    const event = { ...response, session_id: sessionId }
    void transport.write(event)
    logForDebugging(
      `[bridge:repl] Rejected ${req.subtype} (outbound-only) request_id=${request.request_id}`,
    )
    return
  }

  switch (req.subtype) {
    case 'initialize':
      // 以最小能力返回 —— REPL 自己处理 commands、models、account info。
      response = {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: request.request_id,
          response: {
            commands: [],
            output_style: 'normal',
            available_output_styles: ['normal'],
            models: [],
            account: {},
            pid: process.pid,
          },
        },
      }
      break

    case 'set_model':
      onSetModel?.(req.model)
      response = {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: request.request_id,
        },
      }
      break

    case 'set_max_thinking_tokens':
      onSetMaxThinkingTokens?.(req.max_thinking_tokens ?? null)
      response = {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: request.request_id,
        },
      }
      break

    case 'set_permission_mode': {
      // 回调返回 policy verdict，让我们能在不 import isAutoModeGateEnabled /
      // isBypassPermissionsModeDisabled 的前提下（bootstrap 隔离）发送 error
      // control_response。如果没有注册回调（daemon 上下文不接这个 ——
      // 见 daemonBridge.ts），返回 error verdict 而不是静默的伪成功：
      // 该模式下从来不会真正应用，成功会让客户端被误导。
      const verdict = onSetPermissionMode?.(req.mode as PermissionMode) ?? {
        ok: false,
        error:
          'set_permission_mode is not supported in this context (onSetPermissionMode callback not registered)',
      }
      if (verdict.ok) {
        response = {
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: request.request_id,
          },
        }
      } else {
        response = {
          type: 'control_response',
          response: {
            subtype: 'error',
            request_id: request.request_id,
            error: (verdict as { ok: false; error: string }).error,
          },
        }
      }
      break
    }

    case 'interrupt':
      onInterrupt?.()
      response = {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: request.request_id,
        },
      }
      break

    default:
      // 未知 subtype —— 回复错误，避免服务器等一个永远不来的响应而挂起。
      response = {
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: request.request_id,
          error: `REPL bridge does not handle control_request subtype: ${req.subtype}`,
        },
      }
  }

  const event = { ...response, session_id: sessionId }
  void transport.write(event)
  rcLog(
    `control_response: subtype=${req.subtype}` +
      ` request_id=${request.request_id}` +
      ` result=${(response.response as { subtype?: string }).subtype}`,
  )
  logForDebugging(
    `[bridge:repl] Sent control_response for ${req.subtype} request_id=${request.request_id} result=${(response.response as { subtype?: string }).subtype}`,
  )
}

// ─── Result 消息（用于 teardown 时的 session 归档） ───────────────────────

/**
 * 构造一个最小的 `SDKResultSuccess` 消息用于 session 归档。
 * 服务器在 WS 关闭前需要这个事件来触发归档。
 */
export function makeResultMessage(sessionId: string): SDKResultSuccess {
  return {
    type: 'result_success',
    subtype: 'success',
    duration_ms: 0,
    duration_api_ms: 0,
    is_error: false,
    num_turns: 0,
    result: '',
    stop_reason: null,
    total_cost_usd: 0,
    usage: { ...EMPTY_USAGE },
    modelUsage: {},
    permission_denials: [],
    session_id: sessionId,
    uuid: randomUUID(),
  }
}

// ─── BoundedUUIDSet（echo 去重环形缓冲） ─────────────────────────────────

/**
 * 基于环形缓冲的 FIFO 有界集合。容量达到上限时淘汰最旧条目，
 * 内存占用保持在 O(capacity)。
 *
 * 消息按时间顺序加入，因此被淘汰的永远是最旧的条目。调用方依赖外部的
 * 排序（hook 的 lastWrittenIndexRef）作为主去重 —— 这个 set 是
 * echo 过滤和竞态去重的二级安全网。
 */
export class BoundedUUIDSet {
  private readonly capacity: number
  private readonly ring: (string | undefined)[]
  private readonly set = new Set<string>()
  private writeIdx = 0

  constructor(capacity: number) {
    this.capacity = capacity
    this.ring = new Array<string | undefined>(capacity)
  }

  add(uuid: string): void {
    if (this.set.has(uuid)) return
    // 淘汰当前写位置的条目（如果有）
    const evicted = this.ring[this.writeIdx]
    if (evicted !== undefined) {
      this.set.delete(evicted)
    }
    this.ring[this.writeIdx] = uuid
    this.set.add(uuid)
    this.writeIdx = (this.writeIdx + 1) % this.capacity
  }

  has(uuid: string): boolean {
    return this.set.has(uuid)
  }

  clear(): void {
    this.set.clear()
    this.ring.fill(undefined)
    this.writeIdx = 0
  }
}
