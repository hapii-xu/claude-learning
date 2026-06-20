/**
 * 覆盖 getTranscriptPath 的 projectDir 分支（share/index.ts 的第 127 行）。
 *
 * 本文件 mock src/bootstrap/state.js 使其返回非空的 projectDir，
 * 从而执行 getTranscriptPath 的 if (projectDir) 分支。
 *
 * 为避免 state mock 污染，单独放在一个文件中。
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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── child_process mock（gh 失败 → 显示 gh 未安装） ──
let _execFileImplPD: (
  cmd: string,
  args: string[],
  opts: unknown,
  cb: (err: Error | null, stdout: string, stderr: string) => void,
) => void = (_cmd, _args, _opts, cb) => cb(new Error('ENOENT'), '', '')

const execFileMockPD = (
  cmd: string,
  args: string[],
  opts: unknown,
  cb: (err: Error | null, stdout: string, stderr: string) => void,
) => _execFileImplPD(cmd, args, opts, cb)

;(execFileMockPD as unknown as Record<symbol, unknown>)[
  promisify.custom as symbol
] = (
  cmd: string,
  args: string[],
  opts: unknown,
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) =>
    _execFileImplPD(cmd, args, opts, (err, stdout, stderr) => {
      if (err) reject(err)
      else resolve({ stdout, stderr })
    }),
  )

// 展开真实的 child_process + 通过 useShareProjectdirCpStubs 控制 stub。
// 默认关闭：仅本套件的 beforeAll 打开，afterAll 关闭。
// 如果不展开，同一次 `bun test` 运行中其他导入 child_process 的测试
// （例如使用 execFileSync 调用 git 的 src/services/skillLearning/projectContext.ts）
// 会拿到我们的 stub 并出错。
let useShareProjectdirCpStubs = false
mock.module('node:child_process', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const real = require('node:child_process') as Record<string, unknown>
  return {
    ...real,
    default: real,
    execFile: ((...args: unknown[]) =>
      useShareProjectdirCpStubs
        ? (execFileMockPD as (...a: unknown[]) => unknown)(...args)
        : (real.execFile as (...a: unknown[]) => unknown)(
            ...args,
          )) as typeof real.execFile,
    execFileSync: ((...args: unknown[]) =>
      useShareProjectdirCpStubs
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

// ── 带非空 projectDir 的 state mock ──
let _mockProjectDir: string | null = null

mock.module('src/bootstrap/state.js', () => ({
  getSessionId: () => 'test-session-pd',
  getSessionProjectDir: () => _mockProjectDir,
  getOriginalCwd: () => '/mock/cwd',
  getProjectRoot: () => '/mock/project',
  getIsNonInteractiveSession: () => false,
  regenerateSessionId: () => {},
  getParentSessionId: () => undefined,
  switchSession: () => {},
  onSessionSwitch: () => () => {},
  setOriginalCwd: () => {},
  setProjectRoot: () => {},
  getDirectConnectServerUrl: () => undefined,
  setDirectConnectServerUrl: () => {},
  addToTotalDurationState: () => {},
  resetTotalDurationStateAndCost_FOR_TESTS_ONLY: () => {},
  addToTotalCostState: () => {},
  getTotalCostUSD: () => 0,
  getTotalAPIDuration: () => 0,
  getTotalDuration: () => 0,
  getTotalAPIDurationWithoutRetries: () => 0,
  getTotalToolDuration: () => 0,
  addToToolDuration: () => {},
  getTurnHookDurationMs: () => 0,
  addToTurnHookDuration: () => {},
  resetTurnHookDuration: () => {},
  getTurnHookCount: () => 0,
  getTurnToolDurationMs: () => 0,
  resetTurnToolDuration: () => {},
  getTurnToolCount: () => 0,
  getTurnClassifierDurationMs: () => 0,
  addToTurnClassifierDuration: () => {},
  resetTurnClassifierDuration: () => {},
  getTurnClassifierCount: () => 0,
  getStatsStore: () => ({}),
  setStatsStore: () => {},
  updateLastInteractionTime: () => {},
  flushInteractionTime: () => {},
  addToTotalLinesChanged: () => {},
  getTotalLinesAdded: () => 0,
  getTotalLinesRemoved: () => 0,
  getTotalInputTokens: () => 0,
  getTotalOutputTokens: () => 0,
  getTotalCacheReadInputTokens: () => 0,
  getTotalCacheCreationInputTokens: () => 0,
  getTotalWebSearchRequests: () => 0,
  getTurnOutputTokens: () => 0,
  getCurrentTurnTokenBudget: () => null,
  setLastAPIRequest: () => {},
  getLastAPIRequest: () => null,
  setLastAPIRequestMessages: () => {},
  getLastAPIRequestMessages: () => [],
  getSdkAgentProgressSummariesEnabled: () => false,
  addSlowOperation: () => {},
  getCwdState: () => '/mock/cwd',
  setCwdState: () => {},
}))

// ── 状态 ──
let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'share-pd-test-'))
  _execFileImplPD = (_cmd, _args, _opts, cb) => cb(new Error('ENOENT'), '', '')
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  _mockProjectDir = null
})

// ── 辅助函数 ──
type CallFn = (args: string) => Promise<{ type: string; value: string }>

async function getCallFn(): Promise<CallFn> {
  const mod = await import('../index.js')
  const loaded = await (
    mod.default as unknown as { load: () => Promise<{ call: CallFn }> }
  ).load()
  return loaded.call.bind(loaded) as CallFn
}

// 仅对本测试套件打开 child_process stub。
beforeAll(() => {
  useShareProjectdirCpStubs = true
})
afterAll(() => {
  useShareProjectdirCpStubs = false
})

describe('share command — getTranscriptPath projectDir branch', () => {
  test('getSessionProjectDir non-null → uses projectDir path (session log not found)', async () => {
    // 将 projectDir 设置为 tmpDir — session 文件不存在 → "Session log not found"
    _mockProjectDir = tmpDir
    const call = await getCallFn()
    const result = await call('--private')
    expect(result.type).toBe('text')
    // 由于 projectDir/test-session-pd.jsonl 不存在 → log 未找到
    expect(result.value).toContain('Session log not found')
    expect(result.value).toContain('test-session-pd')
  })

  test('getSessionProjectDir non-null + log exists → proceeds past log check', async () => {
    // 在 projectDir/test-session-pd.jsonl 写入 session log
    _mockProjectDir = tmpDir
    const logPath = join(tmpDir, 'test-session-pd.jsonl')
    writeFileSync(
      logPath,
      JSON.stringify({ role: 'user', content: 'test' }) + '\n',
    )
    const call = await getCallFn()
    const result = await call('--private')
    expect(result.type).toBe('text')
    // gh 失败 → 显示 gh 安装说明
    expect(typeof result.value).toBe('string')
    expect(result.value.length).toBeGreaterThan(0)
  })
})
