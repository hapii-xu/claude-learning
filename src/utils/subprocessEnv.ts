import { isEnvTruthy } from './envUtils.js'

/**
 * 在 GitHub Actions 内运行时从子进程环境中剥离的环境变量。
 * 这防止了通过 shell 扩展（例如，${ANTHROPIC_API_KEY}）在 Bash
 * 工具命令中渗出密钥的提示注入攻击。
 *
 * 父 claude 进程保留这些变量（API 调用、延迟凭据读取所需）。
 * 仅子进程（bash、shell 快照、MCP stdio、LSP、hook）被清理。
 *
 * GITHUB_TOKEN / GH_TOKEN 有意不被清理 — 包装脚本（gh.sh）需要
 * 它们调用 GitHub API。该令牌是作业范围的，在工作流结束时过期。
 */
const GHA_SUBPROCESS_SCRUB = [
  // Anthropic 认证 — claude 每请求重新读取这些，子进程不需要它们
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_CUSTOM_HEADERS',

  // OTLP 导出器头 — 文档记录携带 Authorization=Bearer 令牌
  // 用于监控后端；由 OTEL SDK 在进程内读取，子进程从不需要它们
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_EXPORTER_OTLP_LOGS_HEADERS',
  'OTEL_EXPORTER_OTLP_METRICS_HEADERS',
  'OTEL_EXPORTER_OTLP_TRACES_HEADERS',

  // 云提供商凭据 — 相同模式（延迟 SDK 读取）
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'AZURE_CLIENT_SECRET',
  'AZURE_CLIENT_CERTIFICATE_PATH',

  // GitHub Actions OIDC — 在 claude 生成前被 action 的 JS 消费；
  // 泄露这些允许铸造 App 安装令牌 → 仓库接管
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_URL',

  // GitHub Actions artifact/cache API — 缓存投毒 → 供应链枢纽
  'ACTIONS_RUNTIME_TOKEN',
  'ACTIONS_RUNTIME_URL',

  // claude-code-action 特定的重复 — action JS 在生成 claude 之前的
  // prepare 阶段消费这些。ALL_INPUTS 包含 anthropic_api_key 作为 JSON。
  'ALL_INPUTS',
  'OVERRIDE_GITHUB_TOKEN',
  'DEFAULT_WORKFLOW_TOKEN',
  'SSH_SIGNING_KEY',
] as const

/**
 * 返回 process.env 的副本，剥离敏感密钥，用于生成子进程时
 *（Bash 工具、shell 快照、MCP stdio 服务器、LSP 服务器、shell hook）。
 *
 * 受 CLAUDE_CODE_SUBPROCESS_ENV_SCRUB 门控。当配置了
 * `allowed_non_write_users` 时，claude-code-action 自动设置此选项 —
 * 这是将工作流暴露给不受信任内容（提示注入面）的标志。
 */
// 由 init.ts 在 upstreamproxy 模块在 CCR 会话中被动态导入后注册。
// 在非 CCR 启动时保持未定义，因此我们永远不会通过静态导入拉入
// upstreamproxy 模块图（upstreamproxy.ts + relay.ts）。
let _getUpstreamProxyEnv: (() => Record<string, string>) | undefined

/**
 * 从 init.ts 调用，在 upstreamproxy 模块被延迟加载后连接代理 env 函数。
 * 必须在任何子进程生成之前调用。
 */
export function registerUpstreamProxyEnvFn(
  fn: () => Record<string, string>,
): void {
  _getUpstreamProxyEnv = fn
}

export function subprocessEnv(): NodeJS.ProcessEnv {
  // CCR upstreamproxy：注入 HTTPS_PROXY + CA 包变量，以便 agent 子进程中的
  // curl/gh/python 通过本地中继路由。当代理被禁用或未注册（非 CCR）时
  // 返回 {}，因此在 CCR 容器之外这是空操作。
  const proxyEnv = _getUpstreamProxyEnv?.() ?? {}

  if (!isEnvTruthy(process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB)) {
    return Object.keys(proxyEnv).length > 0
      ? { ...process.env, ...proxyEnv }
      : process.env
  }
  const env = { ...process.env, ...proxyEnv }
  for (const k of GHA_SUBPROCESS_SCRUB) {
    delete env[k]
    // GitHub Actions 为 `with:` 输入自动创建 INPUT_<NAME>，重复
    // 类似 INPUT_ANTHROPIC_API_KEY 的密钥。对非 action 输入的变量是空操作。
    delete env[`INPUT_${k}`]
  }
  return env
}
