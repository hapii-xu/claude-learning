/**
 * src/commands/env/index.ts 的测试
 * 覆盖：isSecretKey、maskValue、ENV_PREFIX_ALLOWLIST 分支、formatRuntime 以及完整 call()
 *
 * 注意：此处我们 NOT mock src/bootstrap/state.js，以避免 tests/mocks/README 中
 * 所述的不完整 mock 跨测试污染。真实的 state 模块可安全导入
 *（getSessionId() 在每个进程中返回稳定的 UUID）。
 */
import { afterEach, beforeAll, describe, expect, test } from 'bun:test'

let envCmd: {
  load?: () => Promise<{ call: () => Promise<{ type: string; value: string }> }>
  isEnabled?: () => boolean
  supportsNonInteractive?: boolean
  name?: string
}

beforeAll(async () => {
  const mod = await import('../index.js')
  envCmd = mod.default as typeof envCmd
})

describe('env command metadata', () => {
  test('isEnabled returns true', () => {
    expect(envCmd.isEnabled?.()).toBe(true)
  })

  test('supportsNonInteractive is true', () => {
    expect(envCmd.supportsNonInteractive).toBe(true)
  })

  test('name is "env"', () => {
    expect(envCmd.name).toBe('env')
  })

  test('type is local', async () => {
    const mod = await import('../index.js')
    const cmd = mod.default as { type?: string }
    expect(cmd.type).toBe('local')
  })
})

describe('env command output', () => {
  const savedEnvVars: Record<string, string | undefined> = {}

  afterEach(() => {
    // 恢复测试期间设置的环境变量
    for (const [k, v] of Object.entries(savedEnvVars)) {
      if (v === undefined) {
        delete process.env[k]
      } else {
        process.env[k] = v
      }
    }
    Object.keys(savedEnvVars).forEach(k => delete savedEnvVars[k])
  })

  function setEnv(key: string, value: string): void {
    savedEnvVars[key] = process.env[key]
    process.env[key] = value
  }

  function deleteEnv(key: string): void {
    savedEnvVars[key] = process.env[key]
    delete process.env[key]
  }

  test('call() returns type=text', async () => {
    const loaded = await envCmd.load!()
    const result = await loaded.call()
    expect(result.type).toBe('text')
  })

  test('call() contains ## Runtime section', async () => {
    const loaded = await envCmd.load!()
    const result = await loaded.call()
    expect(result.value).toContain('## Runtime')
  })

  test('call() contains ## Environment Variables section', async () => {
    const loaded = await envCmd.load!()
    const result = await loaded.call()
    expect(result.value).toContain('## Environment Variables')
  })

  test('call() contains platform info', async () => {
    const loaded = await envCmd.load!()
    const result = await loaded.call()
    expect(result.value).toContain('platform:')
  })

  test('call() contains session field', async () => {
    const loaded = await envCmd.load!()
    const result = await loaded.call()
    expect(result.value).toContain('session:')
  })

  test('CLAUDE_ prefixed var appears in output', async () => {
    setEnv('CLAUDE_TEST_MYVAR', 'hello_env')
    const loaded = await envCmd.load!()
    const result = await loaded.call()
    expect(result.value).toContain('CLAUDE_TEST_MYVAR=hello_env')
  })

  test('FEATURE_ var appears in output', async () => {
    setEnv('FEATURE_MYTEST', '1')
    const loaded = await envCmd.load!()
    const result = await loaded.call()
    expect(result.value).toContain('FEATURE_MYTEST=1')
  })

  test('secret key (token) value is masked — short value shows ***', async () => {
    setEnv('CLAUDE_TEST_TOKEN', 'short')
    const loaded = await envCmd.load!()
    const result = await loaded.call()
    expect(result.value).toContain('CLAUDE_TEST_TOKEN=***')
  })

  test('secret key (token) value is masked — long value shows partial with length', async () => {
    setEnv('CLAUDE_TEST_TOKEN', 'verylongtokenvalue1234')
    const loaded = await envCmd.load!()
    const result = await loaded.call()
    expect(result.value).not.toContain('verylongtokenvalue1234')
    expect(result.value).toContain('CLAUDE_TEST_TOKEN=very')
    expect(result.value).toContain('chars)')
  })

  test('non-allowlisted var does NOT appear in output', async () => {
    setEnv('RANDOM_UNRELATED_TEST_VAR', 'should-not-appear')
    const loaded = await envCmd.load!()
    const result = await loaded.call()
    expect(result.value).not.toContain('RANDOM_UNRELATED_TEST_VAR')
  })

  test('password key is recognized as secret', async () => {
    setEnv('ANTHROPIC_TEST_PASSWORD', 'mysecret12345')
    const loaded = await envCmd.load!()
    const result = await loaded.call()
    expect(result.value).not.toContain('mysecret12345')
    expect(result.value).toContain('ANTHROPIC_TEST_PASSWORD=')
  })

  test('no recognized env vars shows placeholder when all removed', async () => {
    const allowlistPrefixes = [
      'CLAUDE_',
      'FEATURE_',
      'ANTHROPIC_',
      'BUN_',
      'NODE_',
      'GEMINI_',
      'OPENAI_',
      'GROK_',
      'CCR_',
      'KAIROS_',
      'BUGHUNTER_',
    ]
    for (const key of Object.keys(process.env)) {
      if (allowlistPrefixes.some(p => key.startsWith(p))) {
        deleteEnv(key)
      }
    }
    const loaded = await envCmd.load!()
    const result = await loaded.call()
    expect(result.value).toContain('(no recognized env vars set)')
  })

  // ── M1 回归测试：KAIROS_ 前缀必须包含下划线 ──
  test('M1: KAIROS_ var (with underscore) appears in output', async () => {
    setEnv('KAIROS_MY_VAR', 'kairos_value')
    const loaded = await envCmd.load!()
    const result = await loaded.call()
    expect(result.value).toContain('KAIROS_MY_VAR=kairos_value')
  })

  test('M1: KAIROSE_ (wrong prefix, no match) does NOT appear in output', async () => {
    // KAIROSE_ 不应被显示 — 仅允许精确的 KAIROS_ 前缀
    setEnv('KAIROSE_INTERNAL', 'should_not_appear')
    const loaded = await envCmd.load!()
    const result = await loaded.call()
    expect(result.value).not.toContain('KAIROSE_INTERNAL')
  })
})
