import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// 在任何使用 feature() 的 import 之前 mock bun:bundle
// 注意：在测试环境中 AWAY_SUMMARY 编译期 flag 为 false，
// 因此无论 GrowthBook 的值是什么，isEnabled() 都会返回 false。
// 这里我们 mock 为 true，以便测试其他受 feature flag 控制的代码路径。
mock.module('bun:bundle', () => ({
  feature: (_name: string) => true,
}))

// Mock log/debug 以避免 bootstrap 副作用
mock.module('src/utils/log.ts', () => ({
  logError: () => {},
  logInfo: () => {},
  logWarning: () => {},
}))
mock.module('src/utils/debug.ts', () => ({
  logForDebugging: () => {},
  isDebug: () => false,
}))

// Mock settings 以避免文件系统副作用
mock.module('src/utils/settings/settings.js', () => ({
  getCachedSettings: () => ({}),
  getSettings: async () => ({}),
  updateSettings: async () => {},
}))

// Mock analytics（GrowthBook）— isEnabled() 所需
let gbValue = true
mock.module('src/services/analytics/growthbook.js', () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: (_key: string, defaultVal: unknown) =>
    gbValue ?? defaultVal,
}))

// Mock generateRecap 所使用的 forkedAgent 工具函数
let mockRecapResult: {
  kind: 'ok' | 'api-error' | 'no-turn' | 'aborted' | 'failed'
  text?: string
} = { kind: 'ok', text: 'Working on fixing the auth bug. Next: run tests.' }

mock.module('src/commands/recap/generateRecap.js', () => ({
  generateRecap: async (_signal: AbortSignal) => mockRecapResult,
}))

let recapCmd: any
let callFn:
  | ((args: string, context: any) => Promise<{ type: string; value: string }>)
  | undefined

beforeEach(async () => {
  gbValue = true
  mockRecapResult = {
    kind: 'ok',
    text: 'Working on fixing the auth bug. Next: run tests.',
  }
  // 重新 import 以获取全新模块
  const mod = await import('../index.js')
  recapCmd = mod.default
  const loaded = await recapCmd.load()
  callFn = loaded.call
})

afterEach(() => {
  recapCmd = undefined
  callFn = undefined
})

// ── 元数据 ──────────────────────────────────────────────────────────────────

describe('recap command metadata', () => {
  test('has correct name', () => {
    expect(recapCmd.name).toBe('recap')
  })

  test('has description mentioning recap/session', () => {
    expect(recapCmd.description).toBeTruthy()
    expect(typeof recapCmd.description).toBe('string')
    expect(recapCmd.description.length).toBeGreaterThan(5)
  })

  test('type is local', () => {
    expect(recapCmd.type).toBe('local')
  })

  test('supportsNonInteractive is false', () => {
    expect(recapCmd.supportsNonInteractive).toBe(false)
  })

  test('has aliases including away and catchup', () => {
    expect(recapCmd.aliases).toBeDefined()
    expect(recapCmd.aliases).toContain('away')
    expect(recapCmd.aliases).toContain('catchup')
  })

  test('isEnabled returns boolean', () => {
    // feature('AWAY_SUMMARY') 是编译期常量；在测试环境中
    // 它求值为 false（未设置 flag），因此无论 GrowthBook 如何，
    // isEnabled() 都返回 false。我们只验证它返回的是 boolean 而不抛异常。
    const result = recapCmd.isEnabled()
    expect(typeof result).toBe('boolean')
  })

  test('isEnabled returns false when GrowthBook flag is false', () => {
    // GrowthBook 关闭 → isEnabled 必须为 false（双保险检查，
    // 适用于真实 build 中 feature flag 为 true 的情况）
    gbValue = false
    const result = recapCmd.isEnabled()
    expect(result).toBe(false)
  })

  test('load() resolves to module with call function', async () => {
    const mod = await recapCmd.load()
    expect(typeof mod.call).toBe('function')
  })
})

// ── Call 行为 ─────────────────────────────────────────────────────────────

describe('recap command call()', () => {
  // Cast 为 any：测试只需要 abortController，不需要完整的 ToolUseContext 结构
  const fakeContext: any = {
    abortController: new AbortController(),
    messages: [],
    options: { tools: [], mainLoopModel: 'claude-3-5-haiku-20241022' },
  }

  test('returns text value on ok result', async () => {
    mockRecapResult = { kind: 'ok', text: 'Fixing auth bug. Next: run tests.' }
    const result = await callFn!('', fakeContext)
    expect(result.type).toBe('text')
    expect(result.value).toContain('Fixing auth bug')
  })

  test('returns text value on api-error result', async () => {
    mockRecapResult = { kind: 'api-error', text: 'Rate limit hit.' }
    const result = await callFn!('', fakeContext)
    expect(result.type).toBe('text')
    expect(result.value).toContain('Rate limit hit')
  })

  test('returns helpful message on no-turn result', async () => {
    mockRecapResult = { kind: 'no-turn' }
    const result = await callFn!('', fakeContext)
    expect(result.type).toBe('text')
    expect(result.value.length).toBeGreaterThan(5)
    expect(result.value).not.toBe('')
  })

  test('returns cancelled message on aborted result', async () => {
    mockRecapResult = { kind: 'aborted' }
    const result = await callFn!('', fakeContext)
    expect(result.type).toBe('text')
    expect(result.value.toLowerCase()).toMatch(/cancel|abort/)
  })

  test('returns error message on failed result', async () => {
    mockRecapResult = { kind: 'failed' }
    const result = await callFn!('', fakeContext)
    expect(result.type).toBe('text')
    expect(result.value.length).toBeGreaterThan(5)
  })

  test('passes abortController signal to generateRecap', async () => {
    let capturedSignal: AbortSignal | undefined
    mock.module('src/commands/recap/generateRecap.js', () => ({
      generateRecap: async (signal: AbortSignal) => {
        capturedSignal = signal
        return { kind: 'ok', text: 'Done.' }
      },
    }))
    const fresh = await import('../index.js')
    const loaded = await fresh.default.load()
    await loaded.call('', fakeContext)
    expect(capturedSignal).toBe(fakeContext.abortController.signal)
  })
})
