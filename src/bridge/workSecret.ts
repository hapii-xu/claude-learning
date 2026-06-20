import axios from 'axios'
import { jsonParse, jsonStringify } from '../utils/slowOperations.js'
import type { WorkSecret } from './types.js'

/** 解码 base64url 编码的 work secret 并校验其版本号。 */
export function decodeWorkSecret(secret: string): WorkSecret {
  const json = Buffer.from(secret, 'base64url').toString('utf-8')
  const parsed: unknown = jsonParse(json)
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('version' in parsed) ||
    parsed.version !== 1
  ) {
    throw new Error(
      `Unsupported work secret version: ${parsed && typeof parsed === 'object' && 'version' in parsed ? parsed.version : 'unknown'}`,
    )
  }
  const obj = parsed as Record<string, unknown>
  if (
    typeof obj.session_ingress_token !== 'string' ||
    obj.session_ingress_token.length === 0
  ) {
    throw new Error(
      'Invalid work secret: missing or empty session_ingress_token',
    )
  }
  if (typeof obj.api_base_url !== 'string') {
    throw new Error('Invalid work secret: missing api_base_url')
  }
  return parsed as WorkSecret
}

/**
 * 根据API base URL 和 session ID 构造 WebSocket SDK URL。
 * 剥离 HTTP(S) 协议，构造 ws(s):// ingress URL。
 *
 * localhost 使用 /v2/（直连 session-ingress，不走 Envoy 改写）；
 * 生产环境使用 /v1/（Envoy 会把 /v1/ 改写为 /v2/）。
 */
export function buildSdkUrl(apiBaseUrl: string, sessionId: string): string {
  const isLocalhost =
    apiBaseUrl.includes('localhost') || apiBaseUrl.includes('127.0.0.1')
  const protocol = apiBaseUrl.startsWith('https') ? 'wss' : 'ws'
  const version = isLocalhost ? 'v2' : 'v1'
  const host = apiBaseUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '')
  return `${protocol}://${host}/${version}/session_ingress/ws/${sessionId}`
}

/**
 * 比较两个 session ID 是否相同（忽略其带 tag 的 ID 前缀）。
 *
 * 带 tag 的 ID 形如 {tag}_{body} 或 {tag}_staging_{body}，其中 body
 * 编码一个 UUID。CCR v2 的 compat 层向 v1 API 客户端返回 `session_*`
 * （compat/convert.go:41），但基础设施层（sandbox-gateway work 队列、
 * work poll 响应）使用 `cse_*`（compat/CLAUDE.md:13）。两者底层是同一个
 * UUID。
 *
 * 若没有这个处理，当 ccr_v2_compat_enabled gate 开启时，replBridge 会
 * 在 work-received 校验环节把自己的 session 当作"外部 session"拒绝掉。
 */
export function sameSessionId(a: string, b: string): boolean {
  if (a === b) return true
  // body 是最后一个下划线之后的所有内容 —— 同时处理
  // `{tag}_{body}` 和 `{tag}_staging_{body}` 两种形式。
  const aBody = a.slice(a.lastIndexOf('_') + 1)
  const bBody = b.slice(b.lastIndexOf('_') + 1)
  // 防御没有下划线的 ID（裸 UUID）：lastIndexOf 返回 -1，
  // slice(0) 返回整个字符串，而上面已经检查过 a === b。
  // 要求最小长度，避免短后缀意外匹配（例如格式错误的 ID 残留的单字符 tag）。
  return aBody.length >= 4 && aBody === bBody
}

/**
 * 根据API base URL 和 session ID 构造 CCR v2 session URL。
 * 与 buildSdkUrl 不同，这里返回 HTTP(S) URL（而非 ws://），并指向
 * /v1/code/sessions/{id} —— 子 CC 进程会从这个 base 推导出 SSE 流路径
 * 和 worker endpoint。
 */
export function buildCCRv2SdkUrl(
  apiBaseUrl: string,
  sessionId: string,
): string {
  const base = apiBaseUrl.replace(/\/+$/, '')
  return `${base}/v1/code/sessions/${sessionId}`
}

/**
 * 把当前 bridge 注册为某个 CCR v2 session 的 worker。
 * 返回 worker_epoch，必须传给子 CC 进程，使其 CCRClient 在每个
 * heartbeat/state/event 请求里都带上。
 *
 * 对应容器路径中 environment-manager 的实现
 * （api-go/environment-manager/cmd/cmd_task_run.go RegisterWorker）。
 */
export async function registerWorker(
  sessionUrl: string,
  accessToken: string,
): Promise<number> {
  const response = await axios.post(
    `${sessionUrl}/worker/register`,
    {},
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      timeout: 10_000,
    },
  )
  // protojson 把 int64 序列化为字符串以避免 JS 数字精度丢失；
  // Go 侧根据编码器设置也可能返回数字。
  const raw = response.data?.worker_epoch
  const epoch = typeof raw === 'string' ? Number(raw) : raw
  if (
    typeof epoch !== 'number' ||
    !Number.isFinite(epoch) ||
    !Number.isSafeInteger(epoch)
  ) {
    throw new Error(
      `registerWorker: invalid worker_epoch in response: ${jsonStringify(response.data)}`,
    )
  }
  return epoch
}
