/**
 * getAuthStatus —— 纯函数；不发任何网络请求。
 *
 * 读取 process.env + 本地 OAuth 凭证文件（通过已 memoize 的
 * getClaudeAIOAuthTokens()）+ globalConfig.workspaceApiKey，生成供
 * /login UI 中 AuthPlaneSummary 使用的 AuthStatus 快照。
 *
 * 安全约定：
 *   - ANTHROPIC_API_KEY / workspaceApiKey 的值永远不以原始形式返回；只暴露
 *     遮蔽后的预览。
 *   - 第三方 API key 的值永远不包含进来；只有布尔存在标志。
 */

import type { SubscriptionType } from '../../services/oauth/types.js'
import { getClaudeAIOAuthTokens } from '../../utils/auth.js'
import { getGlobalConfig } from '../../utils/config.js'

// ---------------------------------------------------------------------------
// 公共类型
// ---------------------------------------------------------------------------

export interface AuthStatus {
  subscription: {
    /** 当本地存储中存在 claude.ai OAuth token 时为 true */
    active: boolean
    /** 订阅档次；未登录 / 仅 API key 模式时为 null */
    plan: 'free' | 'pro' | 'max' | 'team' | 'enterprise' | 'unknown' | null
    /** 保留字段 —— 出于安全始终为 null（email 不包含在遮蔽输出中） */
    accountEmail: null
  }
  workspaceKey: {
    /**
     * 当环境变量或保存的设置（~/.claude.json 中的 workspaceApiKey）提供了
     * workspace API key 时为 true。
     */
    set: boolean
    /** 当 key 以预期的 'sk-ant-api03-' 前缀开头时为 true */
    prefixValid: boolean
    /**
     * key 的遮蔽预览，例如 'sk-a...67 (48 chars)'；未设置时为 null。
     * 永远不含原始 key 值。
     */
    keyPreview: string | null
    /**
     * key 的来源：
     *   'env'      — ANTHROPIC_API_KEY 环境变量
     *   'settings' — 通过 /login UI 保存在 ~/.claude.json 中的 workspaceApiKey
     *   null       — 未设置
     */
    source: 'env' | 'settings' | null
  }
}

// thirdParty 于 2026-05-06 移除：fork 已有的 /login → "Anthropic
// Compatible Setup" 表单才是 OpenAI-compat 配置的唯一权威来源。
// 该 summary 刻意只展示 Anthropic 侧的 plane（subscription / workspace key），
// fork 表单不会暴露这些。

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const WORKSPACE_KEY_PREFIX = 'sk-ant-api03-'

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

/**
 * 生成 API key 的遮蔽预览。
 * 格式：first4 + '...' + last2 + ' (N chars)'
 * 例如：'sk-a...67 (48 chars)'
 *
 * E3 修复：短于 20 字符的 key 每个字符暴露的熵比例过高
 * （例如 6/14 = 43% 暴露）。对于短/格式异常的 key，只显示 [redacted]。
 *
 * 永远不返回原始 key 值。
 */
function maskApiKey(key: string): string {
  const len = key.length
  // E3：短 key —— 只显示长度，不带前缀
  if (len < 20) return `[redacted] (${len} chars)`
  const first4 = key.slice(0, 4)
  const last2 = key.slice(-2)
  return `${first4}...${last2} (${len} chars)`
}

// ---------------------------------------------------------------------------
// 主导出
// ---------------------------------------------------------------------------

/**
 * 通过读取以下内容返回当前认证状态的快照：
 *   - process.env.ANTHROPIC_API_KEY (workspace key)
 *   - getClaudeAIOAuthTokens()（来自本地凭证文件，subscription OAuth）
 *
 * 第三方 provider 配置（Cerebras / Groq / Qwen / DeepSeek）由 fork 已有的
 * /login → "Anthropic Compatible Setup" 表单管理；并行的展示面已于
 * 2026-05-06 移除。
 *
 * 此函数永不抛错，也永不发起网络请求。
 */
export function getAuthStatus(): AuthStatus {
  // ---- 1. Subscription OAuth plane ----（订阅 OAuth 平面）
  const oauthTokens = getClaudeAIOAuthTokens()
  const subscriptionActive =
    oauthTokens !== null && Boolean(oauthTokens.accessToken)

  let plan: AuthStatus['subscription']['plan'] = null
  if (subscriptionActive && oauthTokens) {
    // 本地持久化或历史 token 中可能出现 'free' 等未纳入 SubscriptionType 的字符串
    const raw = oauthTokens.subscriptionType as
      | (SubscriptionType | 'free')
      | null
    if (
      raw === 'free' ||
      raw === 'pro' ||
      raw === 'max' ||
      raw === 'team' ||
      raw === 'enterprise'
    ) {
      plan = raw
    } else if (raw !== null && raw !== undefined) {
      plan = 'unknown'
    } else {
      plan = null
    }
  }

  // ---- 2. Workspace API key plane（双来源：env var 优先于 settings）----
  const envKey = (process.env.ANTHROPIC_API_KEY ?? '').trim()
  const settingsKey = getGlobalConfig().workspaceApiKey?.trim() ?? ''

  let rawKey: string
  let keySource: 'env' | 'settings' | null

  if (envKey.length > 0) {
    rawKey = envKey
    keySource = 'env'
  } else if (settingsKey.length > 0) {
    rawKey = settingsKey
    keySource = 'settings'
  } else {
    rawKey = ''
    keySource = null
  }

  const keySet = rawKey.length > 0
  const prefixValid = rawKey.startsWith(WORKSPACE_KEY_PREFIX)
  const keyPreview = keySet ? maskApiKey(rawKey) : null

  return {
    subscription: {
      active: subscriptionActive,
      plan,
      accountEmail: null,
    },
    workspaceKey: {
      set: keySet,
      prefixValid,
      keyPreview,
      source: keySource,
    },
  }
}
