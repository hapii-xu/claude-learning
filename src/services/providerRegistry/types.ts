import { z } from 'zod'

/**
 * 兼容规则标识符。每个标识符对应 providerCompatMatrix.ts 中的一个 CompatProfile。
 */
export const CompatRuleSchema = z.enum([
  'cerebras',
  'groq',
  'deepseek',
  'strict-openai',
  'permissive',
])

export type CompatRule = z.infer<typeof CompatRuleSchema>

/**
 * PR-2 阶段唯一支持的 provider 类型。PR-3+ 可能会新增 'oauth'、'bedrock-compat' 等。
 */
export const ProviderKindSchema = z.literal('openai-compat')
export type ProviderKind = z.infer<typeof ProviderKindSchema>

/**
 * 单个 provider 配置条目的 Zod 模式。
 *
 * 规则：
 * - id：在 /provider use <id> 中使用的 kebab-case 标识符
 * - kind：PR-2 阶段仅支持 'openai-compat'
 * - baseUrl：完整的基础 URL，必要时包含 /v1 后缀
 * - apiKeyEnv：持有 API 密钥的环境变量名
 * - defaultModel：作为 OPENAI_MODEL 传入的模型字符串
 * - compatRule：从 providerCompatMatrix 中选择 CompatProfile
 */
export const ProviderConfigSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, 'id must be kebab-case'),
  kind: ProviderKindSchema,
  baseUrl: z.string().url(),
  apiKeyEnv: z.string().min(1),
  defaultModel: z.string().min(1),
  compatRule: CompatRuleSchema,
})

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>

/**
 * 整个 ~/.hclaude/providers.json 文件的模式。
 * 顶层必须是 ProviderConfig 的数组。
 */
export const ProvidersFileSchema = z.array(ProviderConfigSchema)
