/**
 * 预连接到 Anthropic API，使 TCP+TLS 握手与启动并行。
 *
 * TCP+TLS 握手约 100-200ms，通常在第一次 API 调用时阻塞。
 * 在 init 期间触发一个即发即弃的 fetch 让握手可以与
 * action-handler 工作并行进行（-p 模式下 API 请求前约 100ms
 * 的设置/命令/mcp；交互模式下无限的"用户正在输入"窗口）。
 *
 * Bun 的 fetch 全局共享 keep-alive 连接池，因此真实的 API
 * 请求会复用已预热的连接。
 *
 * 从 init.ts 调用，在 applyExtraCACertsFromConfig() + configureGlobalAgents()
 * 之后，因此 settings.json 环境变量已应用且 TLS 证书存储已最终确定。
 * 早期的 cli.tsx 调用点已移除 — 它在 settings.json 加载前运行，
 * 因此 settings 中的 ANTHROPIC_BASE_URL/proxy/mTLS 将不可见，预连接
 * 会预热错误的池（或更糟的是，在 NODE_EXTRA_CA_CERTS 应用前锁定
 * BoringSSL 的证书存储）。
 *
 * 以下情况跳过：
 * - 配置了 proxy/mTLS/unix socket（预连接会使用错误的传输 ——
 *   SDK 传递的自定义 dispatcher/agent 不共享全局池）
 * - Bedrock/Vertex/Foundry（不同的端点，不同的认证）
 */

import { getOauthConfig } from '../constants/oauth.js'
import { isEnvTruthy } from './envUtils.js'
import { isEssentialTrafficOnly } from './privacyLevel.js'

let fired = false

export function preconnectAnthropicApi(): void {
  if (fired) return
  fired = true

  // 当通过以下方式禁用非必要流量时也跳过：
  // CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC / DISABLE_TELEMETRY / proxy 环境变量。
  if (isEssentialTrafficOnly()) return

  // 如果使用云提供商则跳过 —— 不同的端点 + 认证
  if (
    isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)
  ) {
    return
  }
  // 如果使用 proxy/mTLS/unix 则跳过 —— SDK 的自定义 dispatcher 不会复用此池
  if (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ANTHROPIC_UNIX_SOCKET ||
    process.env.CLAUDE_CODE_CLIENT_CERT ||
    process.env.CLAUDE_CODE_CLIENT_KEY
  ) {
    return
  }

  // 使用配置的 base URL（staging、local 或自定义网关）。涵盖
  // ANTHROPIC_BASE_URL 环境变量 + USE_STAGING_OAUTH + USE_LOCAL_OAUTH 一次查找。
  // NODE_EXTRA_CA_CERTS 不再是跳过条件 —— init.ts 在此触发前已应用。
  const baseUrl =
    process.env.ANTHROPIC_BASE_URL || getOauthConfig().BASE_API_URL

  // 即发即弃。HEAD 表示无响应体 —— 连接在头部到达后
  // 立即有资格用于 keep-alive 池复用。10s 超时
  // 因此慢网络不会挂起进程；中止也没问题，因为真实的
  // 请求会在需要时重新握手。
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  void fetch(baseUrl, {
    method: 'HEAD',
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {})
}
