import memoize from 'lodash-es/memoize.js'
import { refreshAndGetAwsCredentials } from '../auth.js'
import { getAWSRegion, isEnvTruthy } from '../envUtils.js'
import { logError } from '../log.js'
import { getAWSClientProxyConfig } from '../proxy.js'

export const getBedrockInferenceProfiles = memoize(async function (): Promise<
  string[]
> {
  const [client, { ListInferenceProfilesCommand }] = await Promise.all([
    createBedrockClient(),
    import('@aws-sdk/client-bedrock'),
  ])
  const allProfiles = []
  let nextToken: string | undefined

  try {
    do {
      const command = new ListInferenceProfilesCommand({
        ...(nextToken && { nextToken }),
        typeEquals: 'SYSTEM_DEFINED',
      })
      const response = await client.send(command)

      if (response.inferenceProfileSummaries) {
        allProfiles.push(...response.inferenceProfileSummaries)
      }

      nextToken = response.nextToken
    } while (nextToken)

    // 过滤 Anthropic 模型（SYSTEM_DEFINED 类型过滤在 query 层处理）
    return allProfiles
      .filter(profile => profile.inferenceProfileId?.includes('anthropic'))
      .map(profile => profile.inferenceProfileId)
      .filter(Boolean) as string[]
  } catch (error) {
    logError(error as Error)
    throw error
  }
})

export function findFirstMatch(
  profiles: string[],
  substring: string,
): string | null {
  return profiles.find(p => p.includes(substring)) ?? null
}

async function createBedrockClient() {
  const { BedrockClient } = await import('@aws-sdk/client-bedrock')
  // 严格匹配 Anthropic Bedrock SDK 的区域解析行为：
  // - 读取 AWS_REGION 或 AWS_DEFAULT_REGION 环境变量（不读取 AWS 配置文件）
  // - 若两者均未设置，默认回退到 'us-east-1'
  // 确保查询 inference profile 时使用的区域与实际调用客户端一致
  const region = getAWSRegion()

  const skipAuth = isEnvTruthy(process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH)

  const clientConfig: ConstructorParameters<typeof BedrockClient>[0] = {
    region,
    ...(process.env.ANTHROPIC_BEDROCK_BASE_URL && {
      endpoint: process.env.ANTHROPIC_BEDROCK_BASE_URL,
    }),
    ...(await getAWSClientProxyConfig()),
    ...(skipAuth && {
      requestHandler: new (
        await import('@smithy/node-http-handler')
      ).NodeHttpHandler(),
      httpAuthSchemes: [
        {
          schemeId: 'smithy.api#noAuth',
          identityProvider: () => async () => ({}),
          signer: new (await import('@smithy/core')).NoAuthSigner(),
        },
      ],
      httpAuthSchemeProvider: () => [{ schemeId: 'smithy.api#noAuth' }],
    }),
  }

  if (!skipAuth && !process.env.AWS_BEARER_TOKEN_BEDROCK) {
    // 仅在非 API Key 认证模式下才刷新凭证
    const cachedCredentials = await refreshAndGetAwsCredentials()
    if (cachedCredentials) {
      clientConfig.credentials = {
        accessKeyId: cachedCredentials.accessKeyId,
        secretAccessKey: cachedCredentials.secretAccessKey,
        sessionToken: cachedCredentials.sessionToken,
      }
    }
  }

  return new BedrockClient(clientConfig)
}

export async function createBedrockRuntimeClient() {
  const { BedrockRuntimeClient } = await import(
    '@aws-sdk/client-bedrock-runtime'
  )
  const region = getAWSRegion()
  const skipAuth = isEnvTruthy(process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH)

  const clientConfig: ConstructorParameters<typeof BedrockRuntimeClient>[0] = {
    region,
    ...(process.env.ANTHROPIC_BEDROCK_BASE_URL && {
      endpoint: process.env.ANTHROPIC_BEDROCK_BASE_URL,
    }),
    ...(await getAWSClientProxyConfig()),
    ...(skipAuth && {
      // BedrockRuntimeClient 默认使用 HTTP/2 且无降级回退
      // 代理服务器可能不支持 HTTP/2，因此显式强制使用 HTTP/1.1
      requestHandler: new (
        await import('@smithy/node-http-handler')
      ).NodeHttpHandler(),
      httpAuthSchemes: [
        {
          schemeId: 'smithy.api#noAuth',
          identityProvider: () => async () => ({}),
          signer: new (await import('@smithy/core')).NoAuthSigner(),
        },
      ],
      httpAuthSchemeProvider: () => [{ schemeId: 'smithy.api#noAuth' }],
    }),
  }

  if (!skipAuth && !process.env.AWS_BEARER_TOKEN_BEDROCK) {
    // 仅在非 API Key 认证模式下才刷新凭证
    const cachedCredentials = await refreshAndGetAwsCredentials()
    if (cachedCredentials) {
      clientConfig.credentials = {
        accessKeyId: cachedCredentials.accessKeyId,
        secretAccessKey: cachedCredentials.secretAccessKey,
        sessionToken: cachedCredentials.sessionToken,
      }
    }
  }

  return new BedrockRuntimeClient(clientConfig)
}

export const getInferenceProfileBackingModel = memoize(async function (
  profileId: string,
): Promise<string | null> {
  try {
    const [client, { GetInferenceProfileCommand }] = await Promise.all([
      createBedrockClient(),
      import('@aws-sdk/client-bedrock'),
    ])
    const command = new GetInferenceProfileCommand({
      inferenceProfileIdentifier: profileId,
    })
    const response = await client.send(command)

    if (!response.models || response.models.length === 0) {
      return null
    }

    // 取第一个模型作为费用计算的主要底层模型
    // 实际上，应用推理配置文件通常在成本结构相同的同类模型之间做负载均衡
    const primaryModel = response.models[0]
    if (!primaryModel?.modelArn) {
      return null
    }

    // 从 ARN 中提取模型名称
    // ARN 格式：arn:aws:bedrock:<区域>:<账号>:foundation-model/<模型名>
    const lastSlashIndex = primaryModel.modelArn.lastIndexOf('/')
    return lastSlashIndex >= 0
      ? primaryModel.modelArn.substring(lastSlashIndex + 1)
      : primaryModel.modelArn
  } catch (error) {
    logError(error as Error)
    return null
  }
})

/**
 * 判断模型 ID 是否为基础模型（如 "anthropic.claude-sonnet-4-5-20250929-v1:0"）
 */
export function isFoundationModel(modelId: string): boolean {
  return modelId.startsWith('anthropic.')
}

/**
 * Bedrock 跨区域推理配置文件前缀。
 * 这些前缀用于将请求路由到指定区域的模型。
 */
const BEDROCK_REGION_PREFIXES = ['us', 'eu', 'apac', 'global'] as const

/**
 * 从 Bedrock ARN 中提取模型 ID 或推理配置文件 ID。
 * 若输入不是 ARN 格式，则原样返回。
 *
 * ARN 格式：arn:aws:bedrock:<区域>:<账号>:inference-profile/<配置文件 ID>
 * 也支持：arn:aws:bedrock:<区域>:<账号>:application-inference-profile/<配置文件 ID>
 * 以及基础模型 ARN：arn:aws:bedrock:<区域>::foundation-model/<模型 ID>
 */
export function extractModelIdFromArn(modelId: string): string {
  if (!modelId.startsWith('arn:')) {
    return modelId
  }
  const lastSlashIndex = modelId.lastIndexOf('/')
  if (lastSlashIndex === -1) {
    return modelId
  }
  return modelId.substring(lastSlashIndex + 1)
}

export type BedrockRegionPrefix = (typeof BEDROCK_REGION_PREFIXES)[number]

/**
 * 从 Bedrock 跨区域推理模型 ID 中提取区域前缀。
 * 同时支持普通模型 ID 和完整 ARN 格式。
 * 示例：
 * - "eu.anthropic.claude-sonnet-4-5-20250929-v1:0" → "eu"
 * - "us.anthropic.claude-3-7-sonnet-20250219-v1:0" → "us"
 * - "arn:aws:bedrock:ap-northeast-2:123:inference-profile/global.anthropic.claude-opus-4-6-v1" → "global"
 * - "anthropic.claude-3-5-sonnet-20241022-v2:0" → undefined（基础模型，无前缀）
 * - "claude-sonnet-4-5-20250929" → undefined（一方格式，无前缀）
 */
export function getBedrockRegionPrefix(
  modelId: string,
): BedrockRegionPrefix | undefined {
  // 若为 ARN 格式则先提取推理配置文件 ID
  // ARN 格式：arn:aws:bedrock:<区域>:<账号>:inference-profile/<配置文件 ID>
  const effectiveModelId = extractModelIdFromArn(modelId)

  for (const prefix of BEDROCK_REGION_PREFIXES) {
    if (effectiveModelId.startsWith(`${prefix}.anthropic.`)) {
      return prefix
    }
  }
  return undefined
}

/**
 * 为 Bedrock 模型 ID 添加区域前缀。
 * 若模型已有不同区域前缀，则替换为新前缀。
 * 若模型为基础模型（anthropic.*），则直接添加前缀。
 * 若不是 Bedrock 模型格式，则原样返回。
 *
 * 示例：
 * - applyBedrockRegionPrefix("us.anthropic.claude-sonnet-4-5-v1:0", "eu") → "eu.anthropic.claude-sonnet-4-5-v1:0"
 * - applyBedrockRegionPrefix("anthropic.claude-sonnet-4-5-v1:0", "eu") → "eu.anthropic.claude-sonnet-4-5-v1:0"
 * - applyBedrockRegionPrefix("claude-sonnet-4-5-20250929", "eu") → "claude-sonnet-4-5-20250929"（非 Bedrock 模型，原样返回）
 */
export function applyBedrockRegionPrefix(
  modelId: string,
  prefix: BedrockRegionPrefix,
): string {
  // 若已有区域前缀则替换
  const existingPrefix = getBedrockRegionPrefix(modelId)
  if (existingPrefix) {
    return modelId.replace(`${existingPrefix}.`, `${prefix}.`)
  }

  // 若为基础模型（anthropic.*），直接加前缀
  if (isFoundationModel(modelId)) {
    return `${prefix}.${modelId}`
  }

  // 非 Bedrock 模型格式，原样返回
  return modelId
}
