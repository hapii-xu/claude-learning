import axios from 'axios'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import { validateBridgeId } from './bridgeApi.js'
import { getBridgeAccessToken } from './bridgeConfig.js'
import { getReplBridgeHandle } from './replBridgeHandle.js'
import { toCompatSessionId } from './sessionIdCompat.js'

export type BridgePeerSession = {
  address: string
  name?: string
  cwd?: string
  pid?: number
}

/**
 * 列出本机上已发布 Remote Control session ID 的本地已注册 session。PID
 * 注册表是本机已知的 bridge peer 的事实来源；当当前进程有活跃的 bridge
 * handle 时，SendMessage 可以用这些 bridge:<id> 地址。
 */
export async function listBridgePeers(): Promise<BridgePeerSession[]> {
  const { listAllLiveSessions } = await import('../utils/udsClient.js')
  const sessions = await listAllLiveSessions()
  const peers: BridgePeerSession[] = []

  for (const session of sessions) {
    if (session.pid === process.pid || !session.bridgeSessionId) continue
    const compatId = toCompatSessionId(session.bridgeSessionId)
    peers.push({
      address: `bridge:${compatId}`,
      name: session.name ?? session.kind,
      cwd: session.cwd,
      pid: session.pid,
    })
  }

  return peers
}

/**
 * 通过 bridge API 给另一个 Claude session 发送纯文本消息。
 *
 * 当目标地址 scheme 是 "bridge:" 时由 SendMessageTool 调用。用当前
 * ReplBridgeHandle 推导发送方身份和 POST 请求的 session ingress URL。
 *
 * @param target - 目标 session ID（取自 "bridge:<sessionId>" 地址）
 * @param message - 纯文本消息内容（结构化消息在上游就被拒绝）
 * @returns 成功返回 { ok: true }，失败返回 { ok: false, error }。永不抛错。
 */
export async function postInterClaudeMessage(
  target: string,
  message: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const handle = getReplBridgeHandle()
    if (!handle) {
      return { ok: false, error: 'Bridge not connected' }
    }

    const normalizedTarget = target.trim()
    if (!normalizedTarget) {
      return { ok: false, error: 'No target session specified' }
    }

    const accessToken = getBridgeAccessToken()
    if (!accessToken) {
      return { ok: false, error: 'No access token available' }
    }

    const compatTarget = toCompatSessionId(normalizedTarget)
    // 防路径穿越校验 —— 与 bridgeApi.ts 用的是同一份白名单
    validateBridgeId(compatTarget, 'target sessionId')
    const from = toCompatSessionId(handle.bridgeSessionId)
    const baseUrl = handle.sessionIngressUrl

    const url = `${baseUrl}/v1/sessions/${encodeURIComponent(compatTarget)}/messages`

    const response = await axios.post(
      url,
      {
        type: 'peer_message',
        from,
        content: message,
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
        },
        timeout: 10_000,
        validateStatus: (s: number) => s < 500,
      },
    )

    if (response.status === 200 || response.status === 204) {
      logForDebugging(
        `[bridge:peer] Message sent to ${compatTarget} (${response.status})`,
      )
      return { ok: true }
    }

    const detail =
      typeof response.data === 'object' && response.data?.error?.message
        ? response.data.error.message
        : `HTTP ${response.status}`
    logForDebugging(`[bridge:peer] Send failed: ${detail}`)
    return { ok: false, error: detail }
  } catch (err: unknown) {
    const msg = errorMessage(err)
    logForDebugging(`[bridge:peer] postInterClaudeMessage error: ${msg}`)
    return { ok: false, error: msg }
  }
}
