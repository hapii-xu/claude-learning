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

/**
 * 
  ---
  firstParty — Anthropic 官方直连（默认）

  - 含义：直接调用 Anthropic 自己的 API（api.anthropic.com）
  - 认证方式：Anthropic API Key 或 Claude.ai OAuth 订阅登录
  - 适用场景：绝大多数用户的默认方式，不需要设置任何环境变量

  ---
  bedrock — AWS Bedrock 托管

  - 含义：通过 Amazon Bedrock 服务调用 Claude 模型（bedrock-runtime.*.amazonaws.com）
  - 认证方式：AWS IAM 凭证（AWS_BEARER_TOKEN_BEDROCK 或 AWS SDK 标准认证链），可设
  CLAUDE_CODE_SKIP_BEDROCK_AUTH=1 跳过认证（用于本地代理）
  - 自定义端点：ANTHROPIC_BEDROCK_BASE_URL
  - 适用场景：企业用户，AWS 账号已开通 Bedrock 服务，希望通过 AWS 统一计费/合规/网络隔离来使用     
  Claude
  - 特殊处理：模型 ID 可能是 Inference Profile ARN，需要额外解析（即上一轮讲的
  getInferenceProfileBackingModel）

  ---
  vertex — Google Cloud Vertex AI

  - 含义：通过 Google Vertex AI 服务调用 Claude 模型（{region}-aiplatform.googleapis.com）
  - 认证方式：GCP 应用默认凭证（ADC），可设 CLAUDE_CODE_SKIP_VERTEX_AUTH=1 跳过
  - 额外配置：需要 ANTHROPIC_VERTEX_PROJECT_ID（GCP 项目 ID）+ ANTHROPIC_VERTEX_BASE_URL
  - 适用场景：企业用户，GCP 账号已开通 Vertex AI，希望通过 Google Cloud 统一计费和网络管控使用     
  Claude

  ---
  foundry — Azure AI Foundry（微软 Azure）

  - 含义：通过 Azure AI Foundry 服务调用 Claude 模型（{resource}.services.ai.azure.com）
  - 认证方式：ANTHROPIC_FOUNDRY_API_KEY
  - 额外配置：ANTHROPIC_FOUNDRY_BASE_URL + ANTHROPIC_FOUNDRY_RESOURCE
  - 适用场景：企业用户，Azure 账号，通过微软 Azure 的 AI Foundry 服务使用 Claude

  ---
 */

export function getAPIProvider(
  settings: Pick<SettingsJson, 'modelType'> = getInitialSettings(),
): APIProvider {
  // firstParty 是 Anthropic 直营，其余三个（bedrock / vertex / foundry）是三大云厂商的托管渠道，企业用户通过设置对应的环境变量来切换 API
  // 通道，走各自云平台的计费和网络。

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
  console.error(
    `[DEBUG providers] isFirstPartyAnthropicBaseUrl: ANTHROPIC_BASE_URL="${baseUrl}"`,
  )
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
