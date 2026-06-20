/**
 * getAuthStatus.ts 的测试
 * 覆盖 subscription 的设置/未设置、workspace API key 前缀的各种变体，以及第三方 provider 的环境变量。
 * 所有测试均为纯测试（无网络请求）—— 只涉及 process.env 和被 mock 的 OAuth 文件读取。
 */
import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test'
import { logMock } from '../../../../tests/mocks/log'
import { debugMock } from '../../../../tests/mocks/debug'

// 在导入被测对象之前 mock 掉有副作用的模块
mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)
mock.module('bun:bundle', () => ({ feature: () => false }))
mock.module('src/utils/settings/settings.js', () => ({
  getCachedOrDefaultSettings: () => ({}),
  getSettings: () => ({}),
}))
mock.module('src/utils/config.ts', () => ({
  isConfigEnabled: () => true,
  getGlobalConfig: () => ({
    workspaceApiKey: undefined,
  }),
  saveGlobalConfig: (_updater: unknown) => undefined,
}))

// 我们 mock auth.ts 的 getClaudeAIOAuthTokens，让每个测试返回受控的值
// —— 我们在测试内部通过对 process.env 使用 spy 来 mock getClaudeAIOAuthTokens，
// 不发起任何网络请求。

const SUBSCRIPTION_TOKEN_FIXTURE = {
  accessToken: 'access-token-value',
  refreshToken: 'refresh-token',
  expiresAt: Date.now() + 3_600_000,
  scopes: ['user:inference', 'claude.ai'],
  subscriptionType: 'pro',
  rateLimitTier: null,
}

// 我们会在 mock 设置完成后再懒加载 import getAuthStatus
describe('getAuthStatus', () => {
  const origEnv = { ...process.env }

  beforeEach(() => {
    // 每个测试前重置 env 到干净状态
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.CEREBRAS_API_KEY
    delete process.env.GROQ_API_KEY
    delete process.env.DASHSCOPE_API_KEY
    delete process.env.DEEPSEEK_API_KEY
    delete process.env.CLAUDE_CODE_USE_OPENAI
    delete process.env.OPENAI_BASE_URL
  })

  afterEach(() => {
    // 还原原始 env
    for (const key of Object.keys(process.env)) {
      if (!(key in origEnv)) {
        delete process.env[key]
      }
    }
    for (const [k, v] of Object.entries(origEnv)) {
      if (v !== undefined) {
        process.env[k] = v
      }
    }
  })

  test('subscription.active=false when no OAuth tokens present', async () => {
    mock.module('src/utils/auth.ts', () => ({
      getClaudeAIOAuthTokens: () => null,
      hasAnthropicApiKeyAuth: () => false,
      isAnthropicAuthEnabled: () => false,
      getSubscriptionType: () => null,
    }))
    const { getAuthStatus } = await import('../getAuthStatus.js')
    const status = getAuthStatus()
    expect(status.subscription.active).toBe(false)
    expect(status.subscription.plan).toBeNull()
  })

  test('subscription.active=true and plan=pro when OAuth tokens present with subscriptionType=pro', async () => {
    mock.module('src/utils/auth.ts', () => ({
      getClaudeAIOAuthTokens: () => SUBSCRIPTION_TOKEN_FIXTURE,
      hasAnthropicApiKeyAuth: () => false,
      isAnthropicAuthEnabled: () => true,
      getSubscriptionType: () => 'pro',
    }))
    const { getAuthStatus } = await import('../getAuthStatus.js')
    const status = getAuthStatus()
    expect(status.subscription.active).toBe(true)
    expect(status.subscription.plan).toBe('pro')
  })

  test('workspaceKey.set=false when ANTHROPIC_API_KEY not set', async () => {
    mock.module('src/utils/auth.ts', () => ({
      getClaudeAIOAuthTokens: () => null,
      hasAnthropicApiKeyAuth: () => false,
      isAnthropicAuthEnabled: () => false,
      getSubscriptionType: () => null,
    }))
    const { getAuthStatus } = await import('../getAuthStatus.js')
    const status = getAuthStatus()
    expect(status.workspaceKey.set).toBe(false)
    expect(status.workspaceKey.prefixValid).toBe(false)
    expect(status.workspaceKey.keyPreview).toBeNull()
    expect(status.workspaceKey.source).toBeNull()
  })

  test('workspaceKey.set=true, prefixValid=true with valid sk-ant-api03- prefix', async () => {
    // 52 字符的 key：prefix (14) + 38 字符
    process.env.ANTHROPIC_API_KEY =
      'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
    mock.module('src/utils/auth.ts', () => ({
      getClaudeAIOAuthTokens: () => null,
      hasAnthropicApiKeyAuth: () => true,
      isAnthropicAuthEnabled: () => false,
      getSubscriptionType: () => null,
    }))
    const { getAuthStatus } = await import('../getAuthStatus.js')
    const status = getAuthStatus()
    expect(status.workspaceKey.set).toBe(true)
    expect(status.workspaceKey.prefixValid).toBe(true)
    expect(status.workspaceKey.keyPreview).not.toBeNull()
    // 预览不得包含完整 key 值
    expect(status.workspaceKey.keyPreview).not.toContain(
      'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
    )
    // 预览必须包含遮蔽形式
    expect(status.workspaceKey.keyPreview).toContain('...')
  })

  test('workspaceKey.prefixValid=false when key has wrong prefix', async () => {
    process.env.ANTHROPIC_API_KEY =
      'sk-wrong-prefix-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
    mock.module('src/utils/auth.ts', () => ({
      getClaudeAIOAuthTokens: () => null,
      hasAnthropicApiKeyAuth: () => true,
      isAnthropicAuthEnabled: () => false,
      getSubscriptionType: () => null,
    }))
    const { getAuthStatus } = await import('../getAuthStatus.js')
    const status = getAuthStatus()
    expect(status.workspaceKey.set).toBe(true)
    expect(status.workspaceKey.prefixValid).toBe(false)
  })

  test('keyPreview format: shows first4 + ... + last2 + length for valid key', async () => {
    // 构造一个 key：sk-ant-api03- (14 字符) + ABCDEFGHIJKLMNOPQRSTUVWXYZ01234567 (34 字符) = 共 48 字符
    const key = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ01234567'
    process.env.ANTHROPIC_API_KEY = key
    mock.module('src/utils/auth.ts', () => ({
      getClaudeAIOAuthTokens: () => null,
      hasAnthropicApiKeyAuth: () => true,
      isAnthropicAuthEnabled: () => false,
      getSubscriptionType: () => null,
    }))
    const { getAuthStatus } = await import('../getAuthStatus.js')
    const status = getAuthStatus()
    const preview = status.workspaceKey.keyPreview
    expect(preview).not.toBeNull()
    // 必须包含长度
    expect(preview).toContain(`(${key.length}`)
    // 必须包含前 4 个字符
    expect(preview).toContain('sk-a')
    // 必须包含最后 2 个字符
    expect(preview).toContain('67')
    // 完整 suffix 不得出现
    expect(preview).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZ01234567')
  })

  // ---------------------------------------------------------------------------
  // 双来源 workspace key 测试（env 与 settings）
  // ---------------------------------------------------------------------------

  test('workspaceKey.source=env when ANTHROPIC_API_KEY env var is set', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-' + 'X'.repeat(50)
    mock.module('src/utils/auth.ts', () => ({
      getClaudeAIOAuthTokens: () => null,
      hasAnthropicApiKeyAuth: () => true,
      isAnthropicAuthEnabled: () => false,
      getSubscriptionType: () => null,
    }))
    mock.module('src/utils/config.ts', () => ({
      isConfigEnabled: () => true,
      getGlobalConfig: () => ({
        workspaceApiKey: 'sk-ant-api03-' + 'Y'.repeat(50),
      }),
    }))
    const { getAuthStatus } = await import('../getAuthStatus.js')
    const status = getAuthStatus()
    expect(status.workspaceKey.source).toBe('env')
    expect(status.workspaceKey.set).toBe(true)
  })

  test('workspaceKey.source=settings when only workspaceApiKey in config is set', async () => {
    delete process.env.ANTHROPIC_API_KEY
    mock.module('src/utils/auth.ts', () => ({
      getClaudeAIOAuthTokens: () => null,
      hasAnthropicApiKeyAuth: () => false,
      isAnthropicAuthEnabled: () => false,
      getSubscriptionType: () => null,
    }))
    mock.module('src/utils/config.ts', () => ({
      isConfigEnabled: () => true,
      getGlobalConfig: () => ({
        workspaceApiKey: 'sk-ant-api03-' + 'Z'.repeat(50),
      }),
    }))
    const { getAuthStatus } = await import('../getAuthStatus.js')
    const status = getAuthStatus()
    expect(status.workspaceKey.source).toBe('settings')
    expect(status.workspaceKey.set).toBe(true)
    expect(status.workspaceKey.prefixValid).toBe(true)
  })

  test('workspaceKey.source=null when neither env nor settings has a key', async () => {
    delete process.env.ANTHROPIC_API_KEY
    mock.module('src/utils/auth.ts', () => ({
      getClaudeAIOAuthTokens: () => null,
      hasAnthropicApiKeyAuth: () => false,
      isAnthropicAuthEnabled: () => false,
      getSubscriptionType: () => null,
    }))
    mock.module('src/utils/config.ts', () => ({
      isConfigEnabled: () => true,
      getGlobalConfig: () => ({ workspaceApiKey: undefined }),
    }))
    const { getAuthStatus } = await import('../getAuthStatus.js')
    const status = getAuthStatus()
    expect(status.workspaceKey.source).toBeNull()
    expect(status.workspaceKey.set).toBe(false)
  })

  test('env takes precedence over settings when both are set', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-FROMENV' + 'E'.repeat(40)
    mock.module('src/utils/auth.ts', () => ({
      getClaudeAIOAuthTokens: () => null,
      hasAnthropicApiKeyAuth: () => true,
      isAnthropicAuthEnabled: () => false,
      getSubscriptionType: () => null,
    }))
    mock.module('src/utils/config.ts', () => ({
      isConfigEnabled: () => true,
      getGlobalConfig: () => ({
        workspaceApiKey: 'sk-ant-api03-FROMSETTINGS' + 'S'.repeat(40),
      }),
    }))
    const { getAuthStatus } = await import('../getAuthStatus.js')
    const status = getAuthStatus()
    // env 优先
    expect(status.workspaceKey.source).toBe('env')
    // 预览不得包含 settings key 的 suffix
    expect(status.workspaceKey.keyPreview).not.toContain('FROMSETTINGS')
  })

  // 第三方 provider 相关测试于 2026-05-06 移除 —— 该展示面已从 AuthStatus 删除，
  // 以便让 fork 已有的 /login 表单负责 OpenAI-compat 配置。原因见 AuthPlaneSummary.tsx。

  test('subscription with non-standard subscriptionType → plan="unknown"', async () => {
    mock.module('src/utils/auth.ts', () => ({
      getClaudeAIOAuthTokens: () => ({
        ...SUBSCRIPTION_TOKEN_FIXTURE,
        subscriptionType: 'lifetime-deluxe',
      }),
      hasAnthropicApiKeyAuth: () => false,
      isAnthropicAuthEnabled: () => false,
      getSubscriptionType: () => null,
    }))
    const { getAuthStatus } = await import('../getAuthStatus.js')
    const status = getAuthStatus()
    expect(status.subscription.plan).toBe('unknown')
  })

  test('subscription with subscriptionType=null → plan=null', async () => {
    mock.module('src/utils/auth.ts', () => ({
      getClaudeAIOAuthTokens: () => ({
        ...SUBSCRIPTION_TOKEN_FIXTURE,
        subscriptionType: null,
      }),
      hasAnthropicApiKeyAuth: () => false,
      isAnthropicAuthEnabled: () => false,
      getSubscriptionType: () => null,
    }))
    const { getAuthStatus } = await import('../getAuthStatus.js')
    const status = getAuthStatus()
    expect(status.subscription.plan).toBeNull()
  })
})
