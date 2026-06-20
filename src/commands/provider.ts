import type { Command } from '../commands.js'
import type { LocalCommandCall } from '../types/command.js'
import { getAPIProvider } from '../utils/model/providers.js'
import { updateSettingsForSource } from '../utils/settings/settings.js'
import { getSettings_DEPRECATED } from '../utils/settings/settings.js'
import { applyConfigEnvironmentVariables } from '../utils/managedEnv.js'

function getEnvVarForProvider(provider: string): string {
  switch (provider) {
    case 'bedrock':
      return 'CLAUDE_CODE_USE_BEDROCK'
    case 'vertex':
      return 'CLAUDE_CODE_USE_VERTEX'
    case 'foundry':
      return 'CLAUDE_CODE_USE_FOUNDRY'
    case 'gemini':
      return 'CLAUDE_CODE_USE_GEMINI'
    case 'grok':
      return 'CLAUDE_CODE_USE_GROK'
    default:
      throw new Error(`Unknown provider: ${provider}`)
  }
}

// 获取合并后的 env：process.env + settings.env（来自 userSettings）
function getMergedEnv(): Record<string, string> {
  const settings = getSettings_DEPRECATED()
  const merged: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (e): e is [string, string] => e[1] !== undefined,
    ),
  )
  if (settings?.env) {
    Object.assign(merged, settings.env)
  }
  return merged
}

const call: LocalCommandCall = async (args, _context) => {
  const arg = args.trim().toLowerCase()

  // 无参数：显示当前 provider
  if (!arg) {
    const current = getAPIProvider()
    return { type: 'text', value: `Current API provider: ${current}` }
  }

  // unset：清除设置，回退到环境变量
  if (arg === 'unset') {
    updateSettingsForSource('userSettings', { modelType: undefined })
    // 同时清除所有 provider 专属的环境变量，避免冲突
    delete process.env.CLAUDE_CODE_USE_BEDROCK
    delete process.env.CLAUDE_CODE_USE_VERTEX
    delete process.env.CLAUDE_CODE_USE_FOUNDRY
    delete process.env.CLAUDE_CODE_USE_OPENAI
    delete process.env.CLAUDE_CODE_USE_GEMINI
    delete process.env.CLAUDE_CODE_USE_GROK
    return {
      type: 'text',
      value: 'API provider cleared (will use environment variables).',
    }
  }

  // 校验 provider
  const validProviders = [
    'anthropic',
    'openai',
    'gemini',
    'grok',
    'bedrock',
    'vertex',
    'foundry',
  ]
  if (!validProviders.includes(arg)) {
    return {
      type: 'text',
      value: `Invalid provider: ${arg}\nValid: ${validProviders.join(', ')}`,
    }
  }

  // 切换到 openai 时检查环境变量（包括 settings.env）
  if (arg === 'openai') {
    const mergedEnv = getMergedEnv()
    const hasChatGPTAuth = mergedEnv.OPENAI_AUTH_MODE === 'chatgpt'
    const hasKey = !!mergedEnv.OPENAI_API_KEY
    const hasUrl = !!mergedEnv.OPENAI_BASE_URL
    if (!hasChatGPTAuth && (!hasKey || !hasUrl)) {
      updateSettingsForSource('userSettings', { modelType: 'openai' })
      const missing = []
      if (!hasKey) missing.push('OPENAI_API_KEY')
      if (!hasUrl) missing.push('OPENAI_BASE_URL')
      return {
        type: 'text',
        value: `Switched to OpenAI provider.\nWarning: Missing env vars: ${missing.join(', ')}\nConfigure them via /login or set manually.`,
      }
    }
  }

  // 切换到 grok 时检查环境变量（包括 settings.env）
  if (arg === 'grok') {
    const mergedEnv = getMergedEnv()
    const hasKey = !!(mergedEnv.GROK_API_KEY || mergedEnv.XAI_API_KEY)
    if (!hasKey) {
      updateSettingsForSource('userSettings', { modelType: 'grok' })
      return {
        type: 'text',
        value: `Switched to Grok provider.\nWarning: Missing env var: GROK_API_KEY (or XAI_API_KEY)\nConfigure it via settings.json env or set manually.`,
      }
    }
  }

  // 切换到 gemini 时检查环境变量（包括 settings.env）
  if (arg === 'gemini') {
    const mergedEnv = getMergedEnv()
    const hasKey = !!mergedEnv.GEMINI_API_KEY
    // GEMINI_BASE_URL 可选（有默认值）
    if (!hasKey) {
      updateSettingsForSource('userSettings', { modelType: 'gemini' })
      return {
        type: 'text',
        value: `Switched to Gemini provider.\nWarning: Missing env var: GEMINI_API_KEY\nConfigure it via /login or set manually.`,
      }
    }
  }

  // 处理不同类型的 provider
  // - 'anthropic'、'openai'、'gemini' 存储在 settings.json 中（持久化）
  // - 'bedrock'、'vertex'、'foundry' 仅通过环境变量控制（不要动 settings.json）
  if (
    arg === 'anthropic' ||
    arg === 'openai' ||
    arg === 'gemini' ||
    arg === 'grok'
  ) {
    // 清除可能存在的云 provider 环境变量以避免冲突
    delete process.env.CLAUDE_CODE_USE_BEDROCK
    delete process.env.CLAUDE_CODE_USE_VERTEX
    delete process.env.CLAUDE_CODE_USE_FOUNDRY
    delete process.env.CLAUDE_CODE_USE_OPENAI
    delete process.env.CLAUDE_CODE_USE_GEMINI
    delete process.env.CLAUDE_CODE_USE_GROK
    // 更新 settings.json
    updateSettingsForSource('userSettings', { modelType: arg })
    // 确保 settings.env 被应用到 process.env
    applyConfigEnvironmentVariables()
    return { type: 'text', value: `API provider set to ${arg}.` }
  } else {
    // 云 provider：仅设置环境变量，不要动 settings.json
    delete process.env.CLAUDE_CODE_USE_OPENAI
    delete process.env.OPENAI_API_KEY
    delete process.env.OPENAI_BASE_URL
    delete process.env.CLAUDE_CODE_USE_GEMINI
    delete process.env.CLAUDE_CODE_USE_GROK
    process.env[getEnvVarForProvider(arg)] = '1'
    // 不要修改 settings.json —— 云 provider 完全由环境变量控制
    applyConfigEnvironmentVariables()
    return {
      type: 'text',
      value: `API provider set to ${arg} (via environment variable).`,
    }
  }
}

const provider = {
  type: 'local',
  name: 'provider',
  description:
    'Switch API provider (anthropic/openai/gemini/grok/bedrock/vertex/foundry)',
  aliases: ['api'],
  argumentHint: '[anthropic|openai|gemini|grok|bedrock|vertex|foundry|unset]',
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default provider
