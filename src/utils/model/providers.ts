import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/index.js'
import { getInitialSettings } from '../settings/settings.js'
import type { SettingsJson } from '../settings/types.js'
import { isEnvTruthy } from '../envUtils.js'
import { logForDebugging } from '../debug.js'

export type APIProvider =
  | 'firstParty'
  | 'bedrock'
  | 'vertex'
  | 'foundry'
  | 'openai'
  | 'gemini'
  | 'grok'

export function getAPIProvider(
  settings: Pick<SettingsJson, 'modelType'> = getInitialSettings(),
): APIProvider {
  const modelType = settings.modelType
  if (modelType === 'openai') {
    logForDebugging(
      `[Hapii] Providers.getAPIProvider → openai (settings.modelType)`,
      { level: 'info' },
    )
    return 'openai'
  }
  if (modelType === 'gemini') {
    logForDebugging(
      `[Hapii] Providers.getAPIProvider → gemini (settings.modelType)`,
      { level: 'info' },
    )
    return 'gemini'
  }
  if (modelType === 'grok') {
    logForDebugging(
      `[Hapii] Providers.getAPIProvider → grok (settings.modelType)`,
      { level: 'info' },
    )
    return 'grok'
  }

  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)) {
    logForDebugging(
      `[Hapii] Providers.getAPIProvider → bedrock (CLAUDE_CODE_USE_BEDROCK)`,
      { level: 'info' },
    )
    return 'bedrock'
  }
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)) {
    logForDebugging(
      `[Hapii] Providers.getAPIProvider → vertex (CLAUDE_CODE_USE_VERTEX)`,
      { level: 'info' },
    )
    return 'vertex'
  }
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)) {
    logForDebugging(
      `[Hapii] Providers.getAPIProvider → foundry (CLAUDE_CODE_USE_FOUNDRY)`,
      { level: 'info' },
    )
    return 'foundry'
  }

  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_OPENAI)) {
    logForDebugging(
      `[Hapii] Providers.getAPIProvider → openai (CLAUDE_CODE_USE_OPENAI)`,
      { level: 'info' },
    )
    return 'openai'
  }
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_GEMINI)) {
    logForDebugging(
      `[Hapii] Providers.getAPIProvider → gemini (CLAUDE_CODE_USE_GEMINI)`,
      { level: 'info' },
    )
    return 'gemini'
  }
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_GROK)) {
    logForDebugging(
      `[Hapii] Providers.getAPIProvider → grok (CLAUDE_CODE_USE_GROK)`,
      { level: 'info' },
    )
    return 'grok'
  }

  // logForDebugging(
  //   `[Hapii] Providers.getAPIProvider → firstParty (默认 Anthropic 直连)`,
  //   { level: 'info' },
  // )
  return 'firstParty'
}

export function getAPIProviderForStatsig(): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  return getAPIProvider() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

/**
 * 检查 ANTHROPIC_BASE_URL 是否为第一方 Anthropic API URL。
 * 未设置（默认 API）或指向 api.anthropic.com（对 ant 用户还包含
 * api-staging.anthropic.com）时返回 true。
 */
export function isFirstPartyAnthropicBaseUrl(): boolean {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  // TODO: 这里会有问题, 只配置了 openai 协议的用户, 按理说会为 true 导致问题
  if (!baseUrl) {
    return true
  }
  try {
    const host = new URL(baseUrl).host
    const allowedHosts = ['api.anthropic.com']
    if (process.env.USER_TYPE === 'ant') {
      allowedHosts.push('api-staging.anthropic.com')
    }
    return allowedHosts.includes(host)
  } catch {
    return false
  }
}
