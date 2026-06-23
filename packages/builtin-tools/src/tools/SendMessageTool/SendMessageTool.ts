import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import { isReplBridgeActive } from 'src/bootstrap/state.js'
import { getReplBridgeHandle } from 'src/bridge/replBridgeHandle.js'
import type { Tool, ToolUseContext } from 'src/Tool.js'
import { buildTool, type ToolDef } from 'src/Tool.js'
import { findTeammateTaskByAgentId } from 'src/tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import {
  isLocalAgentTask,
  queuePendingMessage,
} from 'src/tasks/LocalAgentTask/LocalAgentTask.js'
import { isMainSessionTask } from 'src/tasks/LocalMainSessionTask.js'
import { toAgentId } from 'src/types/ids.js'
import { generateRequestId } from 'src/utils/agentId.js'
import { isAgentSwarmsEnabled } from 'src/utils/agentSwarmsEnabled.js'
import { logForDebugging } from 'src/utils/debug.js'
import { errorMessage } from 'src/utils/errors.js'
import { truncate } from 'src/utils/format.js'
import { gracefulShutdown } from 'src/utils/gracefulShutdown.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { parseAddress } from 'src/utils/peerAddress.js'
import { semanticBoolean } from 'src/utils/semanticBoolean.js'
import { jsonStringify } from 'src/utils/slowOperations.js'
import type { BackendType } from 'src/utils/swarm/backends/types.js'
import { TEAM_LEAD_NAME } from 'src/utils/swarm/constants.js'
import { readTeamFileAsync } from 'src/utils/swarm/teamHelpers.js'
import {
  getAgentId,
  getAgentName,
  getTeammateColor,
  getTeamName,
  isTeamLead,
  isTeammate,
} from 'src/utils/teammate.js'
import {
  createShutdownApprovedMessage,
  createShutdownRejectedMessage,
  createShutdownRequestMessage,
  writeToMailbox,
} from 'src/utils/teammateMailbox.js'
import { resumeAgentBackground } from '../AgentTool/resumeAgent.js'
import { SEND_MESSAGE_TOOL_NAME } from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

const StructuredMessage = lazySchema(() =>
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('shutdown_request'),
      reason: z.string().optional(),
    }),
    z.object({
      type: z.literal('shutdown_response'),
      request_id: z.string(),
      approve: semanticBoolean(),
      reason: z.string().optional(),
    }),
    z.object({
      type: z.literal('plan_approval_response'),
      request_id: z.string(),
      approve: semanticBoolean(),
      feedback: z.string().optional(),
    }),
  ]),
)

const inputSchema = lazySchema(() =>
  z.object({
    to: z
      .string()
      .describe(
        feature('UDS_INBOX')
          ? `收件人：teammate 名称、"*" 表示广播、"uds:<socket-path>" 表示本地 peer、"bridge:<session-id>" 表示 Remote Control peer${feature('LAN_PIPES') ? '，或 "tcp:<host>:<port>" 表示 LAN peer' : ''}（使用 ListPeers 发现目标）`
          : '收件人：teammate 名称，或 "*" 表示广播给所有 teammate',
      ),
    summary: z
      .string()
      .optional()
      .describe(
        '5-10 个词的摘要，在 UI 中作为预览显示（当 message 为字符串时必填）',
      ),
    message: z.union([
      z.string().describe('纯文本消息内容'),
      StructuredMessage(),
    ]),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export type Input = z.infer<InputSchema>

export type MessageRouting = {
  sender: string
  senderColor?: string
  target: string
  targetColor?: string
  summary?: string
  content?: string
}

export type MessageOutput = {
  success: boolean
  message: string
  routing?: MessageRouting
}

export type BroadcastOutput = {
  success: boolean
  message: string
  recipients: string[]
  routing?: MessageRouting
}

export type RequestOutput = {
  success: boolean
  message: string
  request_id: string
  target: string
}

export type ResponseOutput = {
  success: boolean
  message: string
  request_id?: string
}

export type SendMessageToolOutput =
  | MessageOutput
  | BroadcastOutput
  | RequestOutput
  | ResponseOutput

const UDS_INLINE_TOKEN_MARKER = '#token='

function stripInlineUdsToken(target: string): string {
  const markerIndex = target.indexOf(UDS_INLINE_TOKEN_MARKER)
  return markerIndex === -1 ? target : target.slice(0, markerIndex)
}

function hasInlineUdsToken(to: string): boolean {
  const addr = parseAddress(to)
  // 空 token 标记也属于 inline-token 尝试。可观察输入的脱敏保留了
  // "#token="，因此被克隆的输入仍会被拒绝。
  return addr.scheme === 'uds' && addr.target.includes(UDS_INLINE_TOKEN_MARKER)
}

function recipientForDisplay(to: string): string {
  const addr = parseAddress(to)
  if (addr.scheme !== 'uds') return to
  return `uds:${stripInlineUdsToken(addr.target)}`
}

function redactInlineUdsTokenForRejection(to: string): string {
  const addr = parseAddress(to)
  if (addr.scheme !== 'uds') return to
  const markerIndex = addr.target.indexOf(UDS_INLINE_TOKEN_MARKER)
  if (markerIndex === -1) return to
  return `uds:${addr.target.slice(0, markerIndex)}${UDS_INLINE_TOKEN_MARKER}`
}

function redactObservableInlineUdsToken(input: { to: string }): void {
  if (!hasInlineUdsToken(input.to)) return
  input.to = redactInlineUdsTokenForRejection(input.to)
}

function findTeammateColor(
  appState: {
    teamContext?: { teammates: { [id: string]: { color?: string } } }
  },
  name: string,
): string | undefined {
  const teammates = appState.teamContext?.teammates
  if (!teammates) return undefined
  for (const teammate of Object.values(teammates)) {
    if ('name' in teammate && (teammate as { name: string }).name === name) {
      return teammate.color
    }
  }
  return undefined
}

async function handleMessage(
  recipientName: string,
  content: string,
  summary: string | undefined,
  context: ToolUseContext,
): Promise<{ data: MessageOutput }> {
  const appState = context.getAppState()
  const teamName = getTeamName(appState.teamContext)
  const senderName =
    getAgentName() || (isTeammate() ? 'teammate' : TEAM_LEAD_NAME)
  const senderColor = getTeammateColor()

  await writeToMailbox(
    recipientName,
    {
      from: senderName,
      text: content,
      summary,
      timestamp: new Date().toISOString(),
      color: senderColor,
    },
    teamName,
  )

  const recipientColor = findTeammateColor(appState, recipientName)

  return {
    data: {
      success: true,
      message: `消息已发送到 ${recipientName} 的收件箱`,
      routing: {
        sender: senderName,
        senderColor,
        target: `@${recipientName}`,
        targetColor: recipientColor,
        summary,
        content,
      },
    },
  }
}

async function handleBroadcast(
  content: string,
  summary: string | undefined,
  context: ToolUseContext,
): Promise<{ data: BroadcastOutput }> {
  const appState = context.getAppState()
  const teamName = getTeamName(appState.teamContext)

  if (!teamName) {
    throw new Error(
      '不在 team 上下文中。请先用 Teammate spawnTeam 创建一个 team，或设置 CLAUDE_CODE_TEAM_NAME。',
    )
  }

  const teamFile = await readTeamFileAsync(teamName)
  if (!teamFile) {
    throw new Error(`Team "${teamName}" 不存在`)
  }

  const senderName =
    getAgentName() || (isTeammate() ? 'teammate' : TEAM_LEAD_NAME)
  if (!senderName) {
    throw new Error(
      '无法广播：需要发送者名称。请设置 CLAUDE_CODE_AGENT_NAME。',
    )
  }

  const senderColor = getTeammateColor()

  const recipients: string[] = []
  for (const member of teamFile.members) {
    if (member.name.toLowerCase() === senderName.toLowerCase()) {
      continue
    }
    recipients.push(member.name)
  }

  if (recipients.length === 0) {
    return {
      data: {
        success: true,
        message: '没有可广播的 teammate（你是 team 中唯一的成员）',
        recipients: [],
      },
    }
  }

  for (const recipientName of recipients) {
    await writeToMailbox(
      recipientName,
      {
        from: senderName,
        text: content,
        summary,
        timestamp: new Date().toISOString(),
        color: senderColor,
      },
      teamName,
    )
  }

  return {
    data: {
      success: true,
      message: `消息已广播给 ${recipients.length} 个 teammate：${recipients.join(', ')}`,
      recipients,
      routing: {
        sender: senderName,
        senderColor,
        target: '@team',
        summary,
        content,
      },
    },
  }
}

async function handleShutdownRequest(
  targetName: string,
  reason: string | undefined,
  context: ToolUseContext,
): Promise<{ data: RequestOutput }> {
  const appState = context.getAppState()
  const teamName = getTeamName(appState.teamContext)
  const senderName = getAgentName() || TEAM_LEAD_NAME
  const requestId = generateRequestId('shutdown', targetName)

  const shutdownMessage = createShutdownRequestMessage({
    requestId,
    from: senderName,
    reason,
  })

  await writeToMailbox(
    targetName,
    {
      from: senderName,
      text: jsonStringify(shutdownMessage),
      timestamp: new Date().toISOString(),
      color: getTeammateColor(),
    },
    teamName,
  )

  return {
    data: {
      success: true,
      message: `已向 ${targetName} 发送关闭请求。请求 ID：${requestId}`,
      request_id: requestId,
      target: targetName,
    },
  }
}

async function handleShutdownApproval(
  requestId: string,
  context: ToolUseContext,
): Promise<{ data: ResponseOutput }> {
  const teamName = getTeamName()
  const agentId = getAgentId()
  const agentName = getAgentName() || 'teammate'

  logForDebugging(
    `[SendMessageTool] handleShutdownApproval: teamName=${teamName}, agentId=${agentId}, agentName=${agentName}`,
  )

  let ownPaneId: string | undefined
  let ownBackendType: BackendType | undefined
  if (teamName) {
    const teamFile = await readTeamFileAsync(teamName)
    if (teamFile && agentId) {
      const selfMember = teamFile.members.find(m => m.agentId === agentId)
      if (selfMember) {
        ownPaneId = selfMember.tmuxPaneId
        ownBackendType = selfMember.backendType
      }
    }
  }

  const approvedMessage = createShutdownApprovedMessage({
    requestId,
    from: agentName,
    paneId: ownPaneId,
    backendType: ownBackendType,
  })

  await writeToMailbox(
    TEAM_LEAD_NAME,
    {
      from: agentName,
      text: jsonStringify(approvedMessage),
      timestamp: new Date().toISOString(),
      color: getTeammateColor(),
    },
    teamName,
  )

  if (ownBackendType === 'in-process') {
    logForDebugging(
      `[SendMessageTool] In-process teammate ${agentName} approving shutdown - signaling abort`,
    )

    if (agentId) {
      const appState = context.getAppState()
      const task = findTeammateTaskByAgentId(agentId, appState.tasks)
      if (task?.abortController) {
        task.abortController.abort()
        logForDebugging(
          `[SendMessageTool] Aborted controller for in-process teammate ${agentName}`,
        )
      } else {
        logForDebugging(
          `[SendMessageTool] Warning: Could not find task/abortController for ${agentName}`,
        )
      }
    }
  } else {
    if (agentId) {
      const appState = context.getAppState()
      const task = findTeammateTaskByAgentId(agentId, appState.tasks)
      if (task?.abortController) {
        logForDebugging(
          `[SendMessageTool] Fallback: Found in-process task for ${agentName} via AppState, aborting`,
        )
        task.abortController.abort()

        return {
          data: {
            success: true,
            message: `关闭已批准（fallback 路径）。Agent ${agentName} 正在退出。`,
            request_id: requestId,
          },
        }
      }
    }

    setImmediate(async () => {
      await gracefulShutdown(0, 'other')
    })
  }

  return {
    data: {
      success: true,
      message: `关闭已批准。已向 team-lead 发送确认。Agent ${agentName} 正在退出。`,
      request_id: requestId,
    },
  }
}

async function handleShutdownRejection(
  requestId: string,
  reason: string,
): Promise<{ data: ResponseOutput }> {
  const teamName = getTeamName()
  const agentName = getAgentName() || 'teammate'

  const rejectedMessage = createShutdownRejectedMessage({
    requestId,
    from: agentName,
    reason,
  })

  await writeToMailbox(
    TEAM_LEAD_NAME,
    {
      from: agentName,
      text: jsonStringify(rejectedMessage),
      timestamp: new Date().toISOString(),
      color: getTeammateColor(),
    },
    teamName,
  )

  return {
    data: {
      success: true,
      message: `关闭已拒绝。原因："${reason}"。继续工作中。`,
      request_id: requestId,
    },
  }
}

async function handlePlanApproval(
  recipientName: string,
  requestId: string,
  context: ToolUseContext,
): Promise<{ data: ResponseOutput }> {
  const appState = context.getAppState()
  const teamName = appState.teamContext?.teamName

  if (!isTeamLead(appState.teamContext)) {
    throw new Error(
      '只有 team lead 可以批准 plan。Teammate 不能批准自己或其他的 plan。',
    )
  }

  const leaderMode = appState.toolPermissionContext.mode
  const modeToInherit = leaderMode === 'plan' ? 'default' : leaderMode

  const approvalResponse = {
    type: 'plan_approval_response',
    requestId,
    approved: true,
    timestamp: new Date().toISOString(),
    permissionMode: modeToInherit,
  }

  await writeToMailbox(
    recipientName,
    {
      from: TEAM_LEAD_NAME,
      text: jsonStringify(approvalResponse),
      timestamp: new Date().toISOString(),
    },
    teamName,
  )

  return {
    data: {
      success: true,
      message: `已为 ${recipientName} 批准 plan。他们将收到批准并可以开始实现。`,
      request_id: requestId,
    },
  }
}

async function handlePlanRejection(
  recipientName: string,
  requestId: string,
  feedback: string,
  context: ToolUseContext,
): Promise<{ data: ResponseOutput }> {
  const appState = context.getAppState()
  const teamName = appState.teamContext?.teamName

  if (!isTeamLead(appState.teamContext)) {
    throw new Error(
      '只有 team lead 可以拒绝 plan。Teammate 不能拒绝自己或其他的 plan。',
    )
  }

  const rejectionResponse = {
    type: 'plan_approval_response',
    requestId,
    approved: false,
    feedback,
    timestamp: new Date().toISOString(),
  }

  await writeToMailbox(
    recipientName,
    {
      from: TEAM_LEAD_NAME,
      text: jsonStringify(rejectionResponse),
      timestamp: new Date().toISOString(),
    },
    teamName,
  )

  return {
    data: {
      success: true,
      message: `已为 ${recipientName} 拒绝 plan，反馈："${feedback}"`,
      request_id: requestId,
    },
  }
}

export const SendMessageTool: Tool<InputSchema, SendMessageToolOutput> =
  buildTool({
    name: SEND_MESSAGE_TOOL_NAME,
    searchHint:
      '向 teammate agent 发送消息、广播、agent 间通信、swarm 消息传递、agent 协作',
    maxResultSizeChars: 100_000,

    userFacingName() {
      return 'SendMessage'
    },

    get inputSchema(): InputSchema {
      return inputSchema()
    },
    shouldDefer: true,
    alwaysLoad: isAgentSwarmsEnabled(),

    isEnabled() {
      return true
    },

    isReadOnly(input) {
      return typeof input.message === 'string'
    },

    backfillObservableInput(input) {
      if (typeof input.to !== 'string') return

      redactObservableInlineUdsToken(input as { to: string })
      if ('type' in input) return

      if (input.to === '*') {
        input.type = 'broadcast'
        if (typeof input.message === 'string') input.content = input.message
      } else if (typeof input.message === 'string') {
        input.type = 'message'
        input.recipient = recipientForDisplay(input.to)
        input.content = input.message
      } else if (typeof input.message === 'object' && input.message !== null) {
        const msg = input.message as {
          type?: string
          request_id?: string
          approve?: boolean
          reason?: string
          feedback?: string
        }
        input.type = msg.type
        input.recipient = recipientForDisplay(input.to)
        if (msg.request_id !== undefined) input.request_id = msg.request_id
        if (msg.approve !== undefined) input.approve = msg.approve
        const content = msg.reason ?? msg.feedback
        if (content !== undefined) input.content = content
      }
    },

    toAutoClassifierInput(input) {
      const recipient = recipientForDisplay(input.to)
      if (typeof input.message === 'string') {
        return `to ${recipient}: ${input.message}`
      }
      switch (input.message.type) {
        case 'shutdown_request':
          return `shutdown_request to ${recipient}`
        case 'shutdown_response':
          return `shutdown_response ${input.message.approve ? 'approve' : 'reject'} ${input.message.request_id}`
        case 'plan_approval_response':
          return `plan_approval ${input.message.approve ? 'approve' : 'reject'} to ${recipient}`
      }
    },

    async checkPermissions(input, _context) {
      if (feature('UDS_INBOX') && parseAddress(input.to).scheme === 'bridge') {
        return {
          behavior: 'ask' as const,
          message: `向 Remote Control 会话 ${input.to} 发送消息？它将通过 Anthropic 的服务器作为 user prompt 发送到接收方 Claude（可能在另一台机器上）。`,
          decisionReason: {
            type: 'safetyCheck',
            reason:
              '跨机器 bridge 消息需要用户明确同意',
            classifierApprovable: false,
          },
        }
      }
      if (feature('LAN_PIPES') && parseAddress(input.to).scheme === 'tcp') {
        return {
          behavior: 'ask' as const,
          message: `向 LAN peer ${input.to} 发送消息？它将通过 TCP 直接连接到你本地网络中的一台机器。`,
          decisionReason: {
            type: 'safetyCheck',
            reason: '跨机器 LAN 消息需要用户明确同意',
            classifierApprovable: false,
          },
        }
      }
      return { behavior: 'allow' as const, updatedInput: input }
    },

    async validateInput(input, _context) {
      if (input.to.trim().length === 0) {
        return {
          result: false,
          message: 'to 不能为空',
          errorCode: 9,
        }
      }
      const addr = parseAddress(input.to)
      if (
        (addr.scheme === 'bridge' ||
          addr.scheme === 'uds' ||
          addr.scheme === 'tcp') &&
        addr.target.trim().length === 0
      ) {
        return {
          result: false,
          message: 'address 的 target 不能为空',
          errorCode: 9,
        }
      }
      if (addr.scheme === 'uds' && hasInlineUdsToken(input.to)) {
        return {
          result: false,
          message:
            'uds 地址不能包含 inline auth token；请使用 ListPeers 提供的地址',
          errorCode: 9,
        }
      }
      if (input.to.includes('@')) {
        return {
          result: false,
          message:
            'to 必须是裸 teammate 名称或 "*" —— 每个会话只有一个 team',
          errorCode: 9,
        }
      }
      if (feature('UDS_INBOX') && parseAddress(input.to).scheme === 'bridge') {
        // 结构化消息拒绝检查优先 —— 这是永久的约束。
        // 如果先显示 "not connected"，会让用户重连后重试时才遇到此错误。
        if (typeof input.message !== 'string') {
          return {
            result: false,
            message:
              '结构化消息不能跨会话发送 —— 只支持纯文本',
            errorCode: 9,
          }
        }
        // postInterClaudeMessage 通过 getReplBridgeHandle() 推导 from= ——
        // 直接检查 handle 以覆盖 init 时间窗口。同时检查
        // isReplBridgeActive()，以拒绝只写（CCR mirror）模式 ——
        // 该模式下 bridge 是只写的，不支持 peer 消息。
        if (!getReplBridgeHandle() || !isReplBridgeActive()) {
          return {
            result: false,
            message:
              'Remote Control 未连接 —— 无法发送到 bridge: 目标。请先用 /remote-control 重连。',
            errorCode: 9,
          }
        }
        return { result: true }
      }
      if (
        feature('UDS_INBOX') &&
        parseAddress(input.to).scheme === 'uds' &&
        typeof input.message === 'string'
      ) {
        return { result: true }
      }
      if (
        feature('LAN_PIPES') &&
        parseAddress(input.to).scheme === 'tcp' &&
        typeof input.message === 'string'
      ) {
        return { result: true }
      }
      if (typeof input.message === 'string') {
        if (!input.summary || input.summary.trim().length === 0) {
          return {
            result: false,
            message: '当 message 为字符串时，summary 为必填',
            errorCode: 9,
          }
        }
        return { result: true }
      }

      if (input.to === '*') {
        return {
          result: false,
          message: '结构化消息不能广播（to: "*"）',
          errorCode: 9,
        }
      }
      if (feature('UDS_INBOX') && parseAddress(input.to).scheme !== 'other') {
        return {
          result: false,
          message:
            '结构化消息不能跨会话发送 —— 只支持纯文本',
          errorCode: 9,
        }
      }

      if (
        input.message.type === 'shutdown_response' &&
        input.to !== TEAM_LEAD_NAME
      ) {
        return {
          result: false,
          message: `shutdown_response 必须发送给 "${TEAM_LEAD_NAME}"`,
          errorCode: 9,
        }
      }

      if (
        input.message.type === 'shutdown_response' &&
        !input.message.approve &&
        (!input.message.reason || input.message.reason.trim().length === 0)
      ) {
        return {
          result: false,
          message: '拒绝 shutdown 请求时 reason 必填',
          errorCode: 9,
        }
      }

      return { result: true }
    },

    async description() {
      return DESCRIPTION
    },

    async prompt() {
      return getPrompt()
    },

    mapToolResultToToolResultBlockParam(data, toolUseID) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result' as const,
        content: [
          {
            type: 'text' as const,
            text: jsonStringify(data),
          },
        ],
      }
    },

    async call(input, context, canUseTool, assistantMessage) {
      if (typeof input.message === 'string') {
        const addr = parseAddress(input.to)
        if (addr.scheme === 'uds' && hasInlineUdsToken(input.to)) {
          return {
            data: {
              success: false,
              message:
                'uds addresses must not include inline auth tokens; use the ListPeers address',
            },
          }
        }
      }

      if (feature('UDS_INBOX') && typeof input.message === 'string') {
        const addr = parseAddress(input.to)
        if (addr.scheme === 'bridge') {
          // 重新检查 handle —— checkPermissions 会阻塞等待用户批准（可能
          // 需要数分钟）。如果在等待 prompt 期间 bridge 断开，
          // validateInput 的检查结果就过期了；不重新检查就会发送 from="unknown"。
          // 同时也重新检查 isReplBridgeActive，以覆盖只写模式。
          if (!getReplBridgeHandle() || !isReplBridgeActive()) {
            return {
              data: {
                success: false,
                message: `Remote Control 在发送前已断开 —— 无法投递到 ${input.to}`,
              },
            }
          }
          /* eslint-disable @typescript-eslint/no-require-imports */
          const { postInterClaudeMessage } =
            require('src/bridge/peerSessions.js') as typeof import('src/bridge/peerSessions.js')
          /* eslint-enable @typescript-eslint/no-require-imports */
          const result = (await postInterClaudeMessage(
            addr.target,
            input.message,
          )) as { ok: boolean; error?: string }
          const preview = input.summary || truncate(input.message, 50)
          return {
            data: {
              success: result.ok,
              message: result.ok
                ? `”${preview}” → ${input.to}`
                : `发送到 ${input.to} 失败：${result.error ?? '未知错误'}`,
            },
          }
        }
        if (addr.scheme === 'uds') {
          const recipient = recipientForDisplay(input.to)
          /* eslint-disable @typescript-eslint/no-require-imports */
          const { sendToUdsSocket } =
            require('src/utils/udsClient.js') as typeof import('src/utils/udsClient.js')
          /* eslint-enable @typescript-eslint/no-require-imports */
          try {
            await sendToUdsSocket(addr.target, input.message)
            const preview = input.summary || truncate(input.message, 50)
            return {
              data: {
                success: true,
                message: `”${preview}” → ${recipient}`,
              },
            }
          } catch (e) {
            return {
              data: {
                success: false,
                message: `发送到 ${recipient} 失败：${errorMessage(e)}`,
              },
            }
          }
        }
        if (addr.scheme === 'tcp' && feature('LAN_PIPES')) {
          const { parseTcpTarget } =
            require('src/utils/peerAddress.js') as typeof import('src/utils/peerAddress.js')
          const { PipeClient } =
            require('src/utils/pipeTransport.js') as typeof import('src/utils/pipeTransport.js')
          const ep = parseTcpTarget(addr.target)
          if (!ep) {
            return {
              data: {
                success: false,
                message: `无效的 TCP target 格式：${addr.target}。应为 host:port`,
              },
            }
          }
          try {
            const client = new PipeClient(input.to, `send-${process.pid}`, ep)
            await client.connect(5000)
            client.send({ type: 'chat', data: input.message })
            client.disconnect()
            const preview = input.summary || truncate(input.message, 50)
            return {
              data: {
                success: true,
                message: `”${preview}” → ${input.to} (TCP ${ep.host}:${ep.port})`,
              },
            }
          } catch (e) {
            return {
              data: {
                success: false,
                message: `通过 TCP 发送到 ${input.to} 失败：${errorMessage(e)}`,
              },
            }
          }
        }
      }

      // 在回退到 ambient-team 解析之前，先按名称或原始 agentId 路由到
      // in-process 子 agent。已停止的 agent 会自动恢复。
      if (typeof input.message === 'string' && input.to !== '*') {
        const appState = context.getAppState()
        const registered = appState.agentNameRegistry.get(input.to)
        const agentId = registered ?? toAgentId(input.to)
        if (agentId) {
          const task = appState.tasks[agentId]
          if (isLocalAgentTask(task) && !isMainSessionTask(task)) {
            if (task.status === 'running') {
              queuePendingMessage(
                agentId,
                input.message,
                context.setAppStateForTasks ?? context.setAppState,
              )
              return {
                data: {
                  success: true,
                  message: `消息已排队，将在 ${input.to} 的下一个工具轮次投递。`,
                },
              }
            }
            // task 存在但已停止 —— 自动恢复
            try {
              const result = await resumeAgentBackground({
                agentId,
                prompt: input.message,
                toolUseContext: context,
                canUseTool,
                invokingRequestId: assistantMessage?.requestId as
                  | string
                  | undefined,
              })
              return {
                data: {
                  success: true,
                  message: `Agent "${input.to}" 已停止（${task.status}）；已在后台携带你的消息恢复运行。完成时会通知你。输出文件：${result.outputFile}`,
                },
              }
            } catch (e) {
              return {
                data: {
                  success: false,
                  message: `Agent "${input.to}" 已停止（${task.status}）且无法恢复：${errorMessage(e)}`,
                },
              }
            }
          } else {
            // task 已从 state 中移除 —— 尝试从磁盘 transcript 恢复。
            // agentId 要么是已注册的名称，要么是格式匹配的原始 ID
            // （toAgentId 会校验 createAgentId 格式，因此 teammate 名称
            // 不会进入此分支）。
            try {
              const result = await resumeAgentBackground({
                agentId,
                prompt: input.message,
                toolUseContext: context,
                canUseTool,
                invokingRequestId: assistantMessage?.requestId as
                  | string
                  | undefined,
              })
              return {
                data: {
                  success: true,
                  message: `Agent "${input.to}" 没有活跃的任务；已从 transcript 在后台携带你的消息恢复运行。完成时会通知你。输出文件：${result.outputFile}`,
                },
              }
            } catch (e) {
              return {
                data: {
                  success: false,
                  message: `Agent "${input.to}" 已注册但没有可恢复的 transcript。它可能已被清理。(${errorMessage(e)})`,
                },
              }
            }
          }
        }
      }

      if (typeof input.message === 'string') {
        if (input.to === '*') {
          return handleBroadcast(input.message, input.summary, context)
        }
        return handleMessage(input.to, input.message, input.summary, context)
      }

      if (input.to === '*') {
        throw new Error('结构化消息不能广播')
      }

      switch (input.message.type) {
        case 'shutdown_request':
          return handleShutdownRequest(input.to, input.message.reason, context)
        case 'shutdown_response':
          if (input.message.approve) {
            return handleShutdownApproval(input.message.request_id, context)
          }
          return handleShutdownRejection(
            input.message.request_id,
            input.message.reason!,
          )
        case 'plan_approval_response':
          if (input.message.approve) {
            return handlePlanApproval(
              input.to,
              input.message.request_id,
              context,
            )
          }
          return handlePlanRejection(
            input.to,
            input.message.request_id,
            input.message.feedback ?? 'Plan 需要修改',
            context,
          )
      }
    },

    renderToolUseMessage,
    renderToolResultMessage,
  } satisfies ToolDef<InputSchema, SendMessageToolOutput>)
