export const PRODUCT_URL = 'https://github.com/claude-code-best/claude-code'

// Claude Code Remote 会话 URL
export const CLAUDE_AI_BASE_URL = 'https://claude.ai'
export const CLAUDE_AI_STAGING_BASE_URL = 'https://claude-ai.staging.ant.dev'
export const CLAUDE_AI_LOCAL_BASE_URL = 'http://localhost:4000'

/**
 * 判断是否处于远程会话的 staging 环境。
 * 检查会话 ID 格式和 ingress URL。
 */
export function isRemoteSessionStaging(
  sessionId?: string,
  ingressUrl?: string,
): boolean {
  return (
    sessionId?.includes('_staging_') === true ||
    ingressUrl?.includes('staging') === true
  )
}

/**
 * 判断是否处于远程会话的本地开发环境。
 * 检查会话 ID 格式（例如 `session_local_...`）和 ingress URL。
 */
export function isRemoteSessionLocal(
  sessionId?: string,
  ingressUrl?: string,
): boolean {
  return (
    sessionId?.includes('_local_') === true ||
    ingressUrl?.includes('localhost') === true
  )
}

/**
 * 根据环境获取 Claude AI 的 baseURL。
 * 对于 localhost，从 ingress URL 推导 baseURL，以保留
 * 实际服务器端口，而不是使用硬编码默认值（4000）。
 */
export function getClaudeAiBaseUrl(
  sessionId?: string,
  ingressUrl?: string,
): string {
  if (isRemoteSessionLocal(sessionId, ingressUrl)) {
    // 如果有 ingress URL，则提取其 origin 以保留正确端口。
    // 自托管服务器可能运行在任意端口（默认 3000），不一定是 4000。
    if (ingressUrl) {
      try {
        const parsed = new URL(ingressUrl)
        return parsed.origin
      } catch {
        // 回退到默认值
      }
    }
    return CLAUDE_AI_LOCAL_BASE_URL
  }
  if (isRemoteSessionStaging(sessionId, ingressUrl)) {
    return CLAUDE_AI_STAGING_BASE_URL
  }
  return CLAUDE_AI_BASE_URL
}

/**
 * 获取远程会话的完整 URL。
 *
 * cse_→session_ 的翻译是一个临时 shim，由
 * tengu_bridge_repl_v2_cse_shim_enabled 控制（见 isCseShimEnabled）。Worker
 * 端点（/v1/code/sessions/{id}/worker/*）需要 `cse_*`，但 claude.ai
 * 前端目前按 `session_*` 进行路由（compat/convert.go:27 会校验
 * TagSession）。UUID 主体相同，只是 tag 前缀不同。一旦服务器按
 * environment_kind 打 tag 且前端直接接受 `cse_*`，即可关闭该开关。
 * 对已经是 `session_*` 形式的 ID 不产生副作用。参见
 * src/bridge/sessionIdCompat.ts 中的 toCompatSessionId 获取标准辅助函数
 * （此处延迟 require 以保持 constants/ 在模块加载时位于 DAG 叶节点）。
 */
export function getRemoteSessionUrl(
  sessionId: string,
  ingressUrl?: string,
): string {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { toCompatSessionId } =
    require('../bridge/sessionIdCompat.js') as typeof import('../bridge/sessionIdCompat.js')
  /* eslint-enable @typescript-eslint/no-require-imports */
  const compatId = toCompatSessionId(sessionId)
  // 如果环境变量中有 CLAUDE_BRIDGE_BASE_URL 则优先使用，否则回退到默认逻辑
  const bridgeBaseUrl = process.env.CLAUDE_BRIDGE_BASE_URL
  if (bridgeBaseUrl) {
    const base = bridgeBaseUrl.replace(/\/+$/, '')
    return `${base}/code/${compatId}`
  }
  const baseUrl = getClaudeAiBaseUrl(compatId, ingressUrl)
  return `${baseUrl}/code/${compatId}`
}
