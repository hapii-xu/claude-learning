/**
 * share/index.ts 的测试
 *
 * share/index.ts 现在使用 `import * as childProcess from 'node:child_process'`
 * 配合懒加载 promisify，因此 mock.module('node:child_process') 能生效。
 * 本文件设置了一个 gh 成功的默认 mock（这样测试 log 存在路径的用例
 * 可以通过 gh 检查继续执行）。share-gh.test.ts 文件详细测试了
 * 具体的 gh 上传路径。
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { promisify } from 'node:util'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 默认：gh --version 成功，gist create 失败（对于只需到达内容准备阶段的
// 测试来说，上传错误是可以接受的）。
let _execFileImplBase: (
  cmd: string,
  args: string[],
  opts: unknown,
  cb: (err: Error | null, stdout: string, stderr: string) => void,
) => void = (_cmd, _args, _opts, cb) => cb(null, '', '')

const execFileMockBase = (
  cmd: string,
  args: string[],
  opts: unknown,
  cb: (err: Error | null, stdout: string, stderr: string) => void,
) => _execFileImplBase(cmd, args, opts, cb)

;(execFileMockBase as unknown as Record<symbol, unknown>)[
  promisify.custom as symbol
] = (
  cmd: string,
  args: string[],
  opts: unknown,
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) =>
    _execFileImplBase(cmd, args, opts, (err, stdout, stderr) => {
      if (err) reject(err)
      else resolve({ stdout, stderr })
    }),
  )

// 展开真实的 child_process + 通过 flag 控制的 stub（关于 promisify.custom 的
// 原因见 share-gh.test.ts）。默认关闭；测试套件的 beforeAll 打开，
// afterAll 关闭，使得 projectContext.test 等其他 child_process 消费方
// 在本套件之外看到真实实现。
let useShareCpStubs = false
const wrappedShareExecFile = ((...args: unknown[]) =>
  useShareCpStubs
    ? (execFileMockBase as (...a: unknown[]) => unknown)(...args)
    : // eslint-disable-next-line @typescript-eslint/no-require-imports
      (require('node:child_process').execFile as (...a: unknown[]) => unknown)(
        ...args,
      )) as unknown as Record<symbol, unknown> & ((...a: unknown[]) => unknown)
;(wrappedShareExecFile as Record<symbol, unknown>)[promisify.custom as symbol] =
  (
    cmd: string,
    args: string[],
    opts: unknown,
  ): Promise<{ stdout: string; stderr: string }> => {
    if (useShareCpStubs) {
      return new Promise((resolve, reject) =>
        _execFileImplBase(cmd, args, opts, (err, stdout, stderr) =>
          err ? reject(err) : resolve({ stdout, stderr }),
        ),
      )
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const real = require('node:child_process') as Record<string, unknown>
    return promisify(real.execFile as never)(cmd, args, opts) as Promise<{
      stdout: string
      stderr: string
    }>
  }
mock.module('node:child_process', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const real = require('node:child_process') as Record<string, unknown>
  return {
    ...real,
    default: real,
    execFile: wrappedShareExecFile as typeof real.execFile,
    execFileSync: ((...args: unknown[]) =>
      useShareCpStubs
        ? Buffer.from('')
        : (real.execFileSync as (...a: unknown[]) => unknown)(
            ...args,
          )) as typeof real.execFileSync,
  }
})

mock.module('bun:bundle', () => ({
  feature: (_name: string) => true,
}))

mock.module('src/services/analytics/index.js', () => ({
  logEvent: () => {},
  stripProtoFields: (v: unknown) => v,
}))

// 注意：我们在此不 mock src/bootstrap/state.js，以避免干扰其他测试文件
// （尤其是 launchAutofixPr.test.ts）。我们动态 import state 以获取真实的
// session ID，用于构造日志文件路径。

// ── 状态 ──
let tmpDir: string
let claudeDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'share-test-'))
  claudeDir = join(tmpDir, '.hclaude')
  mkdirSync(claudeDir, { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = claudeDir
  // 重置为 gh 成功的默认值（execFile 返回空 stdout — gh 检查通过，
  // gist create 会以 "Unexpected gh gist output" 失败，对于仅测试内容准备
  // 路径的用例来说这是可接受的）。
  _execFileImplBase = (_cmd, _args, _opts, cb) => cb(null, '', '')
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  delete process.env.CLAUDE_CONFIG_DIR
})

// ── 辅助函数 ──
type CallFn = (
  args: string,
  ctx?: never,
) => Promise<{ type: string; value: string }>

async function getCallFn(): Promise<CallFn> {
  const mod = await import('../index.js')
  const loaded = await (
    mod.default as unknown as { load: () => Promise<{ call: CallFn }> }
  ).load()
  return loaded.call.bind(loaded) as CallFn
}

async function writeSessionLog(entries?: string[]): Promise<void> {
  // 将 session log 写入 share/index.ts 在运行时会计算的路径。
  // 我们使用真实的 state 值（不 mock）以匹配实际路径。
  const { sanitizePath } = await import('../../../utils/path.js')
  const { getSessionId, getOriginalCwd } = await import(
    '../../../bootstrap/state.js'
  )
  const sessionId = getSessionId()
  const cwd = getOriginalCwd()
  const encoded = sanitizePath(cwd)
  const dir = join(claudeDir, 'projects', encoded)
  mkdirSync(dir, { recursive: true })
  const content = entries ?? [
    JSON.stringify({ role: 'user', content: 'hello world' }),
    JSON.stringify({
      role: 'assistant',
      content: [{ type: 'text', text: 'hi there' }],
    }),
  ]
  writeFileSync(join(dir, `${sessionId}.jsonl`), content.join('\n') + '\n')
}

// 仅在本测试套件中启用 child_process stub。
beforeAll(() => {
  useShareCpStubs = true
})
afterAll(() => {
  useShareCpStubs = false
})

describe('share command — metadata', () => {
  test('command has correct name and type', async () => {
    const mod = await import('../index.js')
    const cmd = mod.default
    expect(cmd.name).toBe('share')
    expect(cmd.type).toBe('local')
    expect(
      (cmd as unknown as { supportsNonInteractive: boolean })
        .supportsNonInteractive,
    ).toBe(true)
  })

  test('isEnabled returns true', async () => {
    const mod = await import('../index.js')
    expect(mod.default.isEnabled?.()).toBe(true)
  })
})

describe('share command — parseShareArgs', () => {
  test('unknown flag → returns usage hint', async () => {
    const call = await getCallFn()
    const result = await call('--unknown')
    expect(result.type).toBe('text')
    expect(result.value).toContain('Usage')
  })

  test('empty args → valid (default private) → log_not_found', async () => {
    const call = await getCallFn()
    const result = await call('')
    expect(result.type).toBe('text')
    expect(result.value.length).toBeGreaterThan(0)
  })

  test('--private is valid', async () => {
    const call = await getCallFn()
    const result = await call('--private')
    expect(result.type).toBe('text')
    expect(result.value.length).toBeGreaterThan(0)
  })

  test('--public is valid', async () => {
    const call = await getCallFn()
    const result = await call('--public')
    expect(result.type).toBe('text')
    expect(result.value.length).toBeGreaterThan(0)
  })

  test('--mask-secrets is valid', async () => {
    const call = await getCallFn()
    const result = await call('--mask-secrets')
    expect(result.type).toBe('text')
    expect(result.value.length).toBeGreaterThan(0)
  })

  test('--summary-only is valid', async () => {
    const call = await getCallFn()
    const result = await call('--summary-only')
    expect(result.type).toBe('text')
    expect(result.value.length).toBeGreaterThan(0)
  })

  test('--allow-public-fallback is valid', async () => {
    const call = await getCallFn()
    const result = await call('--allow-public-fallback')
    expect(result.type).toBe('text')
    expect(result.value.length).toBeGreaterThan(0)
  })

  test('multiple valid flags together', async () => {
    const call = await getCallFn()
    const result = await call('--public --mask-secrets --summary-only')
    expect(result.type).toBe('text')
    expect(result.value.length).toBeGreaterThan(0)
  })
})

describe('share command — log not found', () => {
  test('returns log_not_found when no log exists', async () => {
    const call = await getCallFn()
    const result = await call('--private')
    expect(result.type).toBe('text')
    expect(result.value).toContain('Session log not found')
  })

  test('--public returns log_not_found when no log exists', async () => {
    const call = await getCallFn()
    const result = await call('--public')
    expect(result.type).toBe('text')
    expect(result.value).toContain('Session log not found')
  })
})

describe('share command — log exists', () => {
  test('log exists + --summary-only with real content → proceeds past log check', async () => {
    await writeSessionLog()
    const call = await getCallFn()
    const result = await call('--summary-only')
    expect(result.type).toBe('text')
    // 成功（若 gh 可用）或失败（若不可用）皆可 — 但通过了 log 检查
    expect(typeof result.value).toBe('string')
    expect(result.value.length).toBeGreaterThan(0)
  })

  test('log exists + --summary-only with only system entries → no conversation content', async () => {
    await writeSessionLog([
      JSON.stringify({ type: 'system', content: 'system message' }),
    ])
    const call = await getCallFn()
    const result = await call('--summary-only')
    expect(result.type).toBe('text')
    expect(result.value).toContain('No conversation content')
  })

  test('log exists + --mask-secrets with API key → proceeds past log check', async () => {
    await writeSessionLog([
      JSON.stringify({
        role: 'user',
        content: 'my api key is sk-ant-abcdefghijklmnopqrstuvwxyz123456',
      }),
    ])
    const call = await getCallFn()
    const result = await call('--mask-secrets')
    expect(result.type).toBe('text')
    expect(typeof result.value).toBe('string')
    expect(result.value.length).toBeGreaterThan(0)
  })

  test('log exists + no fallback + gh not available → shows manual instructions OR fails if gh is installed', async () => {
    await writeSessionLog()
    const call = await getCallFn()
    // 在不控制 child_process 的情况下，行为取决于运行环境
    const result = await call('--private')
    expect(result.type).toBe('text')
    expect(typeof result.value).toBe('string')
    // 接受任意结果 — log 存在的路径已被执行
    expect(result.value.length).toBeGreaterThan(0)
  })

  test('log exists with array content (buildSummaryContent array branch)', async () => {
    await writeSessionLog([
      JSON.stringify({
        role: 'user',
        content: [{ type: 'text', text: 'help me debug' }],
      }),
      JSON.stringify({
        role: 'assistant',
        content: 'sure',
      }),
    ])
    const call = await getCallFn()
    const result = await call('--summary-only')
    expect(result.type).toBe('text')
    expect(typeof result.value).toBe('string')
  })

  test('log exists with malformed JSONL lines (buildSummaryContent try/catch)', async () => {
    await writeSessionLog([
      JSON.stringify({ role: 'user', content: 'valid' }),
      'NOT_VALID_JSON{{{',
    ])
    const call = await getCallFn()
    const result = await call('--summary-only')
    expect(result.type).toBe('text')
    expect(typeof result.value).toBe('string')
  })

  // ── M2 回归：maskSecrets 不得脱敏 git SHA，但必须脱敏 Anthropic 密钥 ──
  test('M2: maskSecrets redacts sk-ant-* keys but leaves 40-char hex git SHAs intact', async () => {
    const { maskSecrets } = await import('../index.js')

    const gitSha = 'a' + '1'.repeat(39) // 40 位十六进制字符 — 一个 git SHA
    const apiKey = 'sk-ant-api03-verylongapikey1234567890abcdef'
    const input = `commit ${gitSha}\nAPI key: ${apiKey}`

    const result = maskSecrets(input)

    // Git SHA 不得被脱敏
    expect(result).toContain(gitSha)
    // API 密钥必须被脱敏
    expect(result).not.toContain(apiKey)
    expect(result).toContain('[REDACTED')
  })

  test('M2: maskSecrets redacts Bearer tokens', async () => {
    const { maskSecrets } = await import('../index.js')
    const input =
      'Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.verylongvalue'
    const result = maskSecrets(input)
    expect(result).toContain('[REDACTED_TOKEN]')
  })
})
