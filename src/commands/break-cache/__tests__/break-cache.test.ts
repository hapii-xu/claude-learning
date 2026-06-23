import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

mock.module('bun:bundle', () => ({
  feature: (_name: string) => true,
}))

mock.module('src/services/analytics/index.js', () => ({
  logEvent: () => {},
  stripProtoFields: (v: unknown) => v,
}))

let tmpDir: string
let claudeDir: string

// 动态 envUtils mock —— 在调用时从 process.env 读取 CLAUDE_CONFIG_DIR，
// 这样当其他测试文件也通过 process.env 驱动各自目录时，
// 整个测试套件依然保持兼容。
mock.module('src/utils/envUtils.js', () => ({
  getClaudeConfigHomeDir: () =>
    process.env.CLAUDE_CONFIG_DIR ?? `${tmpdir()}/dummy-claude`,
  isEnvTruthy: (v: unknown) => Boolean(v),
  getTeamsDir: () =>
    join(process.env.CLAUDE_CONFIG_DIR ?? `${tmpdir()}/dummy-claude`, 'teams'),
  hasNodeOption: () => false,
  isEnvDefinedFalsy: () => false,
  isBareMode: () => false,
  parseEnvVars: (s: string) => s,
  getAWSRegion: () => 'us-east-1',
  getDefaultVertexRegion: () => 'us-central1',
  shouldMaintainProjectWorkingDir: () => false,
}))

async function invokeBreakCache(
  args: string,
): Promise<{ type: string; value: string }> {
  const { callBreakCache } = await import('../index.js')
  return callBreakCache(args) as Promise<{ type: string; value: string }>
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'break-cache-test-'))
  claudeDir = join(tmpDir, '.hclaude')
  mkdirSync(claudeDir, { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = claudeDir
})

afterEach(() => {
  // 清理任何残留的 marker 文件
  try {
    const { getBreakCacheMarkerPath } = require('../index.js')
    const markerPath = getBreakCacheMarkerPath()
    if (existsSync(markerPath)) unlinkSync(markerPath)
  } catch {
    // 忽略
  }
  rmSync(tmpDir, { recursive: true, force: true })
  delete process.env.CLAUDE_CONFIG_DIR
})

describe('break-cache command', () => {
  test('command has correct name and type', async () => {
    const mod = await import('../index.js')
    const cmd = mod.default
    expect(cmd.name).toBe('break-cache')
    expect(cmd.type).toBe('local-jsx')
    expect(cmd.argumentHint).toContain('status')

    const nonInteractive = mod.breakCacheNonInteractive
    expect(nonInteractive.name).toBe('break-cache')
    expect(nonInteractive.type).toBe('local')
    expect(
      (nonInteractive as unknown as { supportsNonInteractive: boolean })
        .supportsNonInteractive,
    ).toBe(true)
  })

  test('interactive and noninteractive entries are mutually gated', async () => {
    const mod = await import('../index.js')
    const interactiveEnabled = mod.default.isEnabled?.()
    const nonInteractiveEnabled = mod.breakCacheNonInteractive.isEnabled?.()

    expect(typeof interactiveEnabled).toBe('boolean')
    expect(nonInteractiveEnabled).toBe(!interactiveEnabled)
  })

  test('writes marker file and confirms in message', async () => {
    const mod = await import('../index.js')
    const { getBreakCacheMarkerPath } = mod
    const result = await invokeBreakCache('')

    expect(result.type).toBe('text')
    if (result.type === 'text') {
      expect(result.value).toContain('Cache break scheduled')
      expect(result.value).toContain('next API call')
    }

    // marker 文件必须存在于 CLAUDE_CONFIG_DIR 下
    const markerPath = getBreakCacheMarkerPath()
    expect(markerPath).toContain('.next-request-no-cache')
    expect(existsSync(markerPath)).toBe(true)

    // 清理
    unlinkSync(markerPath)
  })

  test('--clear removes an existing marker', async () => {
    const mod = await import('../index.js')
    const { getBreakCacheMarkerPath } = mod

    // 先设置 marker
    await invokeBreakCache('')
    const markerPath = getBreakCacheMarkerPath()
    expect(existsSync(markerPath)).toBe(true)

    // 然后清除它
    const clearResult = await invokeBreakCache('--clear')
    expect(clearResult.type).toBe('text')
    if (clearResult.type === 'text') {
      expect(clearResult.value).toContain('cleared')
    }
    expect(existsSync(markerPath)).toBe(false)
  })

  test('--clear when no marker returns no-marker message', async () => {
    const mod = await import('../index.js')
    const { getBreakCacheMarkerPath } = mod
    const markerPath = getBreakCacheMarkerPath()

    // 确保它不存在
    if (existsSync(markerPath)) unlinkSync(markerPath)

    const result = await invokeBreakCache('--clear')
    expect(result.type).toBe('text')
    if (result.type === 'text') {
      expect(result.value).toContain('No cache-break marker')
    }
  })

  test('getBreakCacheMarkerPath points inside CLAUDE_CONFIG_DIR', async () => {
    const { getBreakCacheMarkerPath } = await import('../index.js')
    const path = getBreakCacheMarkerPath()
    expect(path).toContain('.next-request-no-cache')
    // 路径应位于 claudeDir（CLAUDE_CONFIG_DIR）之下
    expect(path.startsWith(claudeDir)).toBe(true)
  })

  test('"once" scope is same as empty args', async () => {
    const mod = await import('../index.js')
    const { getBreakCacheMarkerPath } = mod
    const result = await invokeBreakCache('once')
    expect(result.type).toBe('text')
    if (result.type === 'text') {
      expect(result.value).toContain('Cache break scheduled')
    }
    const markerPath = getBreakCacheMarkerPath()
    expect(existsSync(markerPath)).toBe(true)
  })

  test('"always" scope writes the always flag', async () => {
    const mod = await import('../index.js')
    const { getBreakCacheAlwaysPath } = mod
    const result = await invokeBreakCache('always')
    expect(result.type).toBe('text')
    if (result.type === 'text') {
      expect(result.value).toContain('Always-on')
    }
    expect(existsSync(getBreakCacheAlwaysPath())).toBe(true)
    // 清理
    unlinkSync(getBreakCacheAlwaysPath())
  })

  test('"off" scope clears both flags', async () => {
    const mod = await import('../index.js')
    const { getBreakCacheMarkerPath, getBreakCacheAlwaysPath } = mod
    // 设置两个 marker
    await invokeBreakCache('')
    await invokeBreakCache('always')
    expect(existsSync(getBreakCacheMarkerPath())).toBe(true)
    expect(existsSync(getBreakCacheAlwaysPath())).toBe(true)
    // 清除两者
    const result = await invokeBreakCache('off')
    expect(result.type).toBe('text')
    if (result.type === 'text') {
      expect(result.value).toContain('disabled')
    }
    expect(existsSync(getBreakCacheMarkerPath())).toBe(false)
    expect(existsSync(getBreakCacheAlwaysPath())).toBe(false)
  })

  test('"status" scope shows current state', async () => {
    const result = await invokeBreakCache('status')
    expect(result.type).toBe('text')
    if (result.type === 'text') {
      expect(result.value).toContain('Break-Cache Status')
      expect(result.value).toContain('Once marker')
      expect(result.value).toContain('Always mode')
    }
  })

  test('unknown scope returns usage text', async () => {
    const result = await invokeBreakCache('foobar')
    expect(result.type).toBe('text')
    if (result.type === 'text') {
      expect(result.value).toContain('Unknown scope')
      expect(result.value).toContain('Usage')
    }
  })

  test('getBreakCacheAlwaysPath and getBreakCacheStatsPath are exported', async () => {
    const { getBreakCacheAlwaysPath, getBreakCacheStatsPath } = await import(
      '../index.js'
    )
    expect(typeof getBreakCacheAlwaysPath()).toBe('string')
    expect(typeof getBreakCacheStatsPath()).toBe('string')
    expect(getBreakCacheAlwaysPath()).toContain('.break-cache-always')
    // 文件已重命名为 append-only JSONL（H3 修复：原子 append 防止 RMW 竞争）
    expect(getBreakCacheStatsPath()).toContain('break-cache-events.jsonl')
  })

  // ── H3 回归测试：append-only 统计日志能正确累积 ──
  test('H3: each /break-cache once appends one event; totalBreaks reflects all calls', async () => {
    const { readFileSync } = await import('node:fs')
    const mod = await import('../index.js')
    const { getBreakCacheStatsPath } = mod

    // 调用 /break-cache once 共三次
    await invokeBreakCache('once')
    await invokeBreakCache('once')
    await invokeBreakCache('once')

    // 统计路径应该是包含 3 个 'once' 事件的 JSONL 文件
    const statsPath = getBreakCacheStatsPath()
    const lines = readFileSync(statsPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
    const events = lines.map(l => JSON.parse(l) as { kind: string })
    const onceEvents = events.filter(e => e.kind === 'once')
    expect(onceEvents.length).toBe(3)

    // status 命令应报告 totalBreaks = 3
    const statusResult = await invokeBreakCache('status')
    if (statusResult.type === 'text') {
      expect(statusResult.value).toContain('total_breaks:   3')
    }
  })

  test('local-jsx no args renders action panel without completing', async () => {
    const { call } = await import('../panel.js')
    const messages: string[] = []

    const node = await call(
      msg => {
        if (msg) messages.push(msg)
      },
      {} as never,
      '',
    )

    expect(node).not.toBeNull()
    expect(messages).toHaveLength(0)
  })

  test('local-jsx explicit args completes through onDone', async () => {
    const { call } = await import('../panel.js')
    const messages: string[] = []

    const node = await call(
      msg => {
        if (msg) messages.push(msg)
      },
      {} as never,
      'status',
    )

    expect(node).toBeNull()
    expect(messages.join('\n')).toContain('Break-Cache Status')
  })

  test('readEvents skips malformed JSON lines (catch branch)', async () => {
    const { getBreakCacheStatsPath } = await import('../index.js')
    const statsPath = getBreakCacheStatsPath()
    mkdirSync(join(statsPath, '..'), { recursive: true })
    writeFileSync(
      statsPath,
      [
        '{not valid json',
        JSON.stringify({ kind: 'once', timestamp: Date.now() }),
        '',
        '{"truncated":',
      ].join('\n') + '\n',
    )
    // status 读取内部使用 readEvents → 会触发 JSON.parse 的 catch 分支。
    const result = await invokeBreakCache('status')
    expect(result.type).toBe('text')
    expect(result.value).toContain('Break-Cache Status')
  })

  test('breakCache (interactive): getBridgeInvocationError requires arg', async () => {
    const mod = await import('../index.js')
    const cmd = mod.default
    const fn = (
      cmd as unknown as {
        getBridgeInvocationError?: (args: string) => string | undefined
      }
    ).getBridgeInvocationError
    expect(typeof fn).toBe('function')
    if (fn) {
      expect(fn('')).toContain('Remote Control')
      expect(fn('   ')).toContain('Remote Control')
      expect(fn('once')).toBeUndefined()
      expect(fn('status')).toBeUndefined()
    }
  })

  test('breakCacheNonInteractive: load() returns call function', async () => {
    const { breakCacheNonInteractive } = await import('../index.js')
    expect(breakCacheNonInteractive.type).toBe('local')
    const loaded = await (
      breakCacheNonInteractive as unknown as {
        load: () => Promise<{ call: unknown }>
      }
    ).load()
    expect(typeof loaded.call).toBe('function')
  })
})
