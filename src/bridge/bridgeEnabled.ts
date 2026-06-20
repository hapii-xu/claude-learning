import { feature } from 'bun:bundle'
import {
  checkGate_CACHED_OR_BLOCKING,
  getDynamicConfig_CACHED_MAY_BE_STALE,
  getFeatureValue_CACHED_MAY_BE_STALE,
} from '../services/analytics/growthbook.js'
import { isSelfHostedBridge } from './bridgeConfig.js'
// namespace import 打破了 bridgeEnabled → auth → config → bridgeEnabled
// 循环 —— authModule.foo 是 live binding，所以当下面的 helper 调用它时，
// auth.js 已经完全加载完毕。此前用 require() 实现同样的延迟加载，但
// require() 命中的 CJS 缓存在 mock.module() 之后会与 ESM namespace
// 分叉（daemon/auth.test.ts），导致 spyOn 失效。
import * as authModule from '../utils/auth.js'
import { isEnvTruthy } from '../utils/envUtils.js'
import { lt } from '../utils/semver.js'

/**
 * 运行时检查 bridge 模式的权限资格。
 *
 * Remote Control 需要 claude.ai 订阅（bridge 用 claude.ai OAuth token
 * 认证到 CCR）。isClaudeAISubscriber() 会排除 Bedrock/Vertex/Foundry、
 * apiKeyHelper/gateway 部署、环境变量 API key 以及 Console API 登录 ——
 * 这些都没有 CCR 需要的 OAuth token。
 * 参见 github.com/deshaw/anthropic-issues/issues/24。
 *
 * `feature('BRIDGE_MODE')` 守卫确保只有在构建时启用 bridge 模式的
 * 情况下才会引用 GrowthBook 字符串字面量。
 */
export function isBridgeEnabled(): boolean {
  // 自托管 bridge：当用户配置了自定义服务器时，完全跳过 GrowthBook 门控。
  if (feature('BRIDGE_MODE') && isSelfHostedBridge()) {
    return true
  }
  // 正向三元模式 —— 见 docs/feature-gating.md。
  // 负向模式（if (!feature(...)) return）无法从外部构建中消除
  // 内联字符串字面量。
  return feature('BRIDGE_MODE')
    ? isClaudeAISubscriber() &&
        getFeatureValue_CACHED_MAY_BE_STALE('tengu_ccr_bridge', false)
    : false
}

/**
 * Remote Control 的阻塞性权限检查。
 *
 * 缓存为 `true` 时立即返回（快速路径）。如果磁盘缓存为 `false` 或缺失，
 * 则等待 GrowthBook 初始化并获取最新的服务器值（慢速路径，最长约 5s），
 * 然后写入磁盘。
 *
 * 用在"陈旧的 false 会不公平地拒绝访问"的权限闸门处。对于面向用户的
 * 错误路径，优先使用 `getBridgeDisabledReason()` —— 它会给出具体的
 * 诊断信息。对于渲染层 UI 的可见性检查，使用 `isBridgeEnabled()`。
 */
export async function isBridgeEnabledBlocking(): Promise<boolean> {
  if (feature('BRIDGE_MODE') && isSelfHostedBridge()) {
    return true
  }
  return feature('BRIDGE_MODE')
    ? isClaudeAISubscriber() &&
        (await checkGate_CACHED_OR_BLOCKING('tengu_ccr_bridge'))
    : false
}

/**
 * 诊断信息：说明 Remote Control 为什么不可用；如果已启用则返回 null。
 * 当你需要向用户展示可操作的错误时，调用此函数而不是裸调
 * `isBridgeEnabledBlocking()`。
 *
 * GrowthBook 门控按 organizationUUID 命中，该值来自 config.oauthAccount
 * —— 登录时由 /api/oauth/profile 填充。该端点需要 user:profile scope。
 * 没有该 scope 的 token（setup-token、CLAUDE_CODE_OAUTH_TOKEN 环境变量、
 * 或 scope 扩展之前的登录）会让 oauthAccount 保持未填充状态，于是
 * 门控回退到 false，用户看到死胡同般的 "not enabled" 消息，完全看不出
 * 重新登录能修复问题。参见 CC-1165 / gh-33105。
 */
export async function getBridgeDisabledReason(): Promise<string | null> {
  if (feature('BRIDGE_MODE')) {
    // 自托管 bridge：不需要订阅/scope/门控检查。
    if (isSelfHostedBridge()) {
      return null
    }
    if (!isClaudeAISubscriber()) {
      return 'Remote Control requires a claude.ai subscription. Run `claude auth login` to sign in with your claude.ai account.'
    }
    if (!hasProfileScope()) {
      return 'Remote Control requires a full-scope login token. Long-lived tokens (from `claude setup-token` or CLAUDE_CODE_OAUTH_TOKEN) are limited to inference-only for security reasons. Run `claude auth login` to use Remote Control.'
    }
    if (!getOauthAccountInfo()?.organizationUuid) {
      return 'Unable to determine your organization for Remote Control eligibility. Run `claude auth login` to refresh your account information.'
    }
    if (!(await checkGate_CACHED_OR_BLOCKING('tengu_ccr_bridge'))) {
      return 'Remote Control is not yet enabled for your account.'
    }
    return null
  }
  return 'Remote Control is not available in this build.'
}

// try/catch：main.tsx:5698 在定义 Commander 程序期间、enableConfigs() 之前
// 调用了 isBridgeEnabled()。此时 isClaudeAISubscriber() → getGlobalConfig()
// 会抛 "Config accessed before allowed"。配置加载之前不可能存在 OAuth token，
// 所以返回 false 是正确的。这与 growthbook.ts:775-780 中
// getFeatureValue_CACHED_MAY_BE_STALE 已有的吞错行为一致。
function isClaudeAISubscriber(): boolean {
  try {
    return authModule.isClaudeAISubscriber()
  } catch {
    return false
  }
}
function hasProfileScope(): boolean {
  try {
    return authModule.hasProfileScope()
  } catch {
    return false
  }
}
function getOauthAccountInfo(): ReturnType<
  typeof authModule.getOauthAccountInfo
> {
  try {
    return authModule.getOauthAccountInfo()
  } catch {
    return undefined
  }
}

/**
 * 运行时检查是否启用 env-less（v2）REPL bridge 路径。
 * 当 GrowthBook flag `tengu_bridge_repl_v2` 启用时返回 true。
 *
 * 这控制的是 initReplBridge 使用哪一套实现 —— 不是 bridge 是否可用
 *（见上方 isBridgeEnabled）。Daemon/print 路径无论此门控如何，
 * 都保持使用基于 env 的实现。
 */
export function isEnvLessBridgeEnabled(): boolean {
  return feature('BRIDGE_MODE')
    ? getFeatureValue_CACHED_MAY_BE_STALE('tengu_bridge_repl_v2', false)
    : false
}

/**
 * `cse_*` → `session_*` 客户端 retag shim 的 kill switch。
 *
 * 之所以存在这个 shim，是因为 compat/convert.go:27 会校验 TagSession、
 * claude.ai 前端按 `session_*` 路由，而 v2 worker 端点下发的是 `cse_*`。
 * 一旦服务器按 environment_kind 打 tag、前端能直接接受 `cse_*`，就把
 * 这个开关翻成 false，让 toCompatSessionId 变成 no-op。
 * 默认为 true —— shim 保持启用，直到被显式禁用。
 */
export function isCseShimEnabled(): boolean {
  return feature('BRIDGE_MODE')
    ? getFeatureValue_CACHED_MAY_BE_STALE(
        'tengu_bridge_repl_v2_cse_shim_enabled',
        true,
      )
    : true
}

/**
 * 返回错误信息：当前 CLI 版本低于 v1（基于 env）Remote Control 路径
 * 所需的最低版本；版本正常则返回 null。v2（env-less）路径改用
 * envLessBridgeConfig.ts 中的 checkEnvLessBridgeMinVersion() —— 两套
 * 实现有独立的版本下限。
 *
 * 使用缓存的（非阻塞）GrowthBook 配置。如果 GrowthBook 尚未加载，
 * 默认值 '0.0.0' 会让检查直接通过 —— 这是安全的回退。
 */
export function checkBridgeMinVersion(): string | null {
  // 正向模式 —— 见 docs/feature-gating.md。
  // 负向模式（if (!feature(...)) return）无法从外部构建中消除
  // 内联字符串字面量。
  if (feature('BRIDGE_MODE')) {
    const config = getDynamicConfig_CACHED_MAY_BE_STALE<{
      minVersion: string
    }>('tengu_bridge_min_version', { minVersion: '0.0.0' })
    if (config.minVersion && lt(MACRO.VERSION, config.minVersion)) {
      return `Your version of Claude Code (${MACRO.VERSION}) is too old for Remote Control.\nVersion ${config.minVersion} or higher is required. Run \`claude update\` to update.`
    }
  }
  return null
}

/**
 * 用户未显式设置时 remoteControlAtStartup 的默认值。当存在 CCR_AUTO_CONNECT
 * 构建标志（仅 ant）且 tengu_cobalt_harbor GrowthBook 门控开启时，所有
 * session 默认连接 CCR —— 用户仍可在 config 中设置
 * remoteControlAtStartup=false 退出（显式设置永远优先于此默认值）。
 *
 * 放在这里而不是 config.ts 中，是为了避免 config.ts → growthbook.ts 的
 * 直接 import 循环（growthbook.ts → user.ts → config.ts）。
 */
export function getCcrAutoConnectDefault(): boolean {
  return feature('CCR_AUTO_CONNECT')
    ? getFeatureValue_CACHED_MAY_BE_STALE('tengu_cobalt_harbor', false)
    : false
}

/**
 * 可选的 CCR mirror 模式 —— 每个本地 session 都会派生一个仅出站的
 * Remote Control session 来接收转发的事件。与 getCcrAutoConnectDefault
 *（双向 Remote Control）相互独立。环境变量优先用于本地 opt-in；
 * GrowthBook 控制灰度。
 */
export function isCcrMirrorEnabled(): boolean {
  return feature('CCR_MIRROR')
    ? isEnvTruthy(process.env.CLAUDE_CODE_CCR_MIRROR) ||
        getFeatureValue_CACHED_MAY_BE_STALE('tengu_ccr_mirror', false)
    : false
}
