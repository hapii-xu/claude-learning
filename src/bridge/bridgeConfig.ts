/**
 * 共享的 bridge 认证/URL 解析。整合了仅 ant 可用的
 * CLAUDE_BRIDGE_* 开发覆盖项 —— 之前散落在十几个文件里复制粘贴：
 * inboundAttachments、BriefTool/upload、bridgeMain、
 * initReplBridge、remoteBridgeCore、daemon workers、/rename、
 * /remote-control。
 *
 * 两层：*Override() 返回仅 ant 的环境变量（或 undefined）；
 * 非 Override 版本会回落到真实的 OAuth store/config。
 * 组合其他认证源的调用方（例如使用 IPC 认证的 daemon worker）
 * 直接使用 Override getter。
 */

import { getOauthConfig } from '../constants/oauth.js'
import { getClaudeAIOAuthTokens } from '../utils/auth.js'

/** 开发覆盖：CLAUDE_BRIDGE_OAUTH_TOKEN，否则 undefined。 */
export function getBridgeTokenOverride(): string | undefined {
  return process.env.CLAUDE_BRIDGE_OAUTH_TOKEN || undefined
}

/** 开发覆盖：CLAUDE_BRIDGE_BASE_URL，否则 undefined。 */
export function getBridgeBaseUrlOverride(): string | undefined {
  return process.env.CLAUDE_BRIDGE_BASE_URL || undefined
}

/**
 * bridge API 调用的 access token：先看开发覆盖，再看 OAuth
 * keychain。undefined 表示"未登录"。
 */
export function getBridgeAccessToken(): string | undefined {
  return getBridgeTokenOverride() ?? getClaudeAIOAuthTokens()?.accessToken
}

/**
 * bridge API 调用的 base URL：先看开发覆盖，再看生产
 * OAuth config。总是返回一个 URL。
 */
export function getBridgeBaseUrl(): string {
  return getBridgeBaseUrlOverride() ?? getOauthConfig().BASE_API_URL
}

/** 当用户显式配置了自定义 bridge 服务器时返回 true。 */
export function isSelfHostedBridge(): boolean {
  return !!getBridgeBaseUrlOverride()
}
