import { findProvider, loadProviders } from './loader.js'
import type { ProviderConfig } from './types.js'

export interface SwitchProviderResult {
  /**
   * 下次会话前需要设置的环境变量。
   * 此为只读信息——调用方不得修改 process.env。
   * 用户将这些变量复制到其 shell 配置文件中。
   */
  env: Record<string, string>

  /**
   * 人类可读的警告（例如当前环境中缺少 API 密钥）。
   * 非致命：用户仍然可以配置 provider。
   */
  warnings: string[]

  /**
   * 本次切换使用的已解析 provider 配置。
   */
  provider: ProviderConfig
}

/**
 * 计算激活 OpenAI 兼容 provider 所需的环境变量。
 *
 * 设计约束（来自计划）：
 * - 纯函数：不修改 process.env
 * - 在顶部调用 assertNoAnthropicEnvForOpenAI() 以警告凭证混用
 *   （ANTHROPIC_API_KEY 与 OPENAI 兼容模式同时设置）
 * - 返回用户可粘贴到 shell 配置文件的 export 命令
 * - 环境变量生效需重启（OpenAI 客户端已缓存）
 *
 * @param id - Provider id（例如 'cerebras'、'groq'、'deepseek'、'qwen'）
 * @param providers - 可选的预加载列表（默认使用 loadProviders()）
 * @throws {Error} 若未找到对应的 provider id
 */
export function switchProvider(
  id: string,
  providers?: ProviderConfig[],
): SwitchProviderResult {
  const list = providers ?? loadProviders()
  const found = findProvider(id, list)

  if (!found) {
    const ids = list.map(p => p.id).join(', ')
    throw new Error(
      `switchProvider: provider "${id}" not found. Available: ${ids}`,
    )
  }

  const env: Record<string, string> = {
    CLAUDE_CODE_USE_OPENAI: '1',
    OPENAI_BASE_URL: found.baseUrl,
    OPENAI_MODEL: found.defaultModel,
    // 值为持有密钥的环境变量名，而非密钥本身。
    // Shell 示例：export OPENAI_API_KEY=$CEREBRAS_API_KEY
    // 我们返回建议的 export，但实际值取决于用户的环境。
  }

  // 包含 API 密钥环境变量名，以便调用方构建 shell 代码片段。
  // 不读取 process.env[found.apiKeyEnv]，以避免密钥泄露。
  const warnings: string[] = []

  // G3：将 ANTHROPIC_API_KEY 冲突警告包含在 result.warnings 中（而非仅 logError），
  // 使 Ink 视图（/providers use）能将其渲染给用户，而非丢失在旁路 stderr 日志中。
  const hasOpenAIMode =
    process.env['CLAUDE_CODE_USE_OPENAI'] === '1' ||
    Boolean(process.env['OPENAI_API_KEY'])
  const hasAnthropicKey = Boolean(process.env['ANTHROPIC_API_KEY'])
  if (hasOpenAIMode && hasAnthropicKey) {
    warnings.push(
      'Both ANTHROPIC_API_KEY and OpenAI-compat mode are set. ' +
        'ANTHROPIC_API_KEY is for Anthropic workspace endpoints (/v1/agents, /v1/vaults). ' +
        'OpenAI-compat mode routes /v1/messages to a third-party provider. ' +
        'These are separate planes — verify this is intentional.',
    )
  }

  if (!process.env[found.apiKeyEnv]) {
    warnings.push(
      `${found.apiKeyEnv} is not set in the current environment. ` +
        `Set it before starting Claude Code: export ${found.apiKeyEnv}=<your-api-key>`,
    )
  }

  return { env, warnings, provider: found }
}

/**
 * 构建向用户展示的 shell export 代码块。
 *
 * 示例输出：
 *   export CLAUDE_CODE_USE_OPENAI=1
 *   export OPENAI_BASE_URL=https://api.cerebras.ai/v1
 *   export OPENAI_API_KEY=$CEREBRAS_API_KEY
 *   export OPENAI_MODEL=llama-3.3-70b
 *
 * API 密钥行使用变量引用，因此实际密钥不会被输出。
 */
export function buildShellExportBlock(result: SwitchProviderResult): string {
  const { env, provider } = result
  const lines: string[] = [
    `export CLAUDE_CODE_USE_OPENAI=${env['CLAUDE_CODE_USE_OPENAI'] ?? '1'}`,
    `export OPENAI_BASE_URL=${env['OPENAI_BASE_URL'] ?? provider.baseUrl}`,
    `export OPENAI_API_KEY=$${provider.apiKeyEnv}`,
    `export OPENAI_MODEL=${env['OPENAI_MODEL'] ?? provider.defaultModel}`,
  ]
  return lines.join('\n')
}
