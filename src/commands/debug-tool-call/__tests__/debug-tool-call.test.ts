import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

// 将 envUtils mock 为从 process.env 动态读取 CLAUDE_CONFIG_DIR。
// 其他测试文件（cacheStats、SessionMemory/prompts、MagicDocs/prompts）
// 使用静态路径 mock envUtils — 通过在调用时读取 process.env，
// 我们的 mock 能与完整测试套件保持兼容，因为其他测试也会驱动真实的 CLAUDE_CONFIG_DIR。
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

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'dtc-test-'))
  claudeDir = join(tmpDir, '.claude')
  mkdirSync(claudeDir, { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = claudeDir
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  delete process.env.CLAUDE_CONFIG_DIR
})

async function makeLogWithToolCalls(
  claudeDir: string,
  count: number,
): Promise<void> {
  const { sanitizePath } = await import('../../../utils/path.js')
  const { getSessionId, getOriginalCwd } = await import(
    '../../../bootstrap/state.js'
  )
  // 使用命令将要看到的状态值（可能被 mock）
  const encodedCwd = sanitizePath(getOriginalCwd())
  const projectsDir = join(claudeDir, 'projects', encodedCwd)
  mkdirSync(projectsDir, { recursive: true })
  const lines: string[] = []
  for (let i = 1; i <= count; i++) {
    lines.push(
      JSON.stringify({
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: `tu${i}`,
            name: `Tool${i}`,
            input: { arg: `val${i}` },
          },
        ],
      }),
    )
    lines.push(
      JSON.stringify({
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: `tu${i}`, content: `result${i}` },
        ],
      }),
    )
  }
  writeFileSync(
    join(projectsDir, `${getSessionId()}.jsonl`),
    lines.join('\n') + '\n',
  )
}

describe('debug-tool-call command', () => {
  test('command has correct name and type', async () => {
    const mod = await import('../index.js')
    const cmd = mod.default
    expect(cmd.name).toBe('debug-tool-call')
    expect(cmd.type).toBe('local')
    expect(
      (cmd as unknown as { supportsNonInteractive: boolean })
        .supportsNonInteractive,
    ).toBe(true)
  })

  test('isEnabled returns true', async () => {
    const mod = await import('../index.js')
    const cmd = mod.default
    expect(cmd.isEnabled?.()).toBe(true)
  })

  test('shows no-log message when log file missing', async () => {
    const mod = await import('../index.js')
    const cmd = mod.default
    const loaded = await (
      cmd as unknown as {
        load: () => Promise<{
          call: (
            args: string,
            ctx: never,
          ) => Promise<{ type: string; value: string }>
        }>
      }
    ).load()
    const result = await loaded.call('', {} as never)
    expect(result.type).toBe('text')
    if (result.type === 'text') {
      expect(result.value).toContain('Debug Tool')
    }
  })

  test('shows no-tool-calls message when log has no tool blocks', async () => {
    const { sanitizePath } = await import('../../../utils/path.js')
    const { getSessionId, getOriginalCwd } = await import(
      '../../../bootstrap/state.js'
    )
    const encodedCwd = sanitizePath(getOriginalCwd())
    const projectsDir = join(claudeDir, 'projects', encodedCwd)
    mkdirSync(projectsDir, { recursive: true })
    writeFileSync(
      join(projectsDir, `${getSessionId()}.jsonl`),
      JSON.stringify({ role: 'user', content: 'hi' }) + '\n',
    )

    const mod = await import('../index.js')
    const cmd = mod.default
    const loaded = await (
      cmd as unknown as {
        load: () => Promise<{
          call: (
            args: string,
            ctx: never,
          ) => Promise<{ type: string; value: string }>
        }>
      }
    ).load()
    const result = await loaded.call('', {} as never)
    expect(result.type).toBe('text')
    if (result.type === 'text') {
      expect(result.value).toContain('No tool call')
    }
  })

  test('shows tool call pairs from log', async () => {
    await makeLogWithToolCalls(claudeDir, 1)

    const mod = await import('../index.js')
    const cmd = mod.default
    const loaded = await (
      cmd as unknown as {
        load: () => Promise<{
          call: (
            args: string,
            ctx: never,
          ) => Promise<{ type: string; value: string }>
        }>
      }
    ).load()
    const result = await loaded.call('1', {} as never)
    expect(result.type).toBe('text')
    if (result.type === 'text') {
      expect(result.value).toContain('Tool1')
    }
  })

  test('renderValue handles non-JSON-serializable input gracefully (lines 53-54)', async () => {
    // renderValue 会捕获循环引用导致的 JSON.stringify 错误。
    // 我们需要创建一个日志条目，其 `input` 字段从 JSON 读取后是普通对象。
    // 但由于 JSON.stringify 用于在 JSON.parse 之后序列化 `use.input`，
    // 解析出的值始终是 JSON 安全的。
    // 触发 catch 的唯一方式是传入一个不可序列化的值。
    // 由于值来自 JSON.parse，它总是可序列化的。
    // 因此第 53-54 行在正常流程下不可达。该测试通过传入有效日志并确认
    // 正常路径正常工作来记录这一情况。
    const { sanitizePath } = await import('../../../utils/path.js')
    const { getSessionId, getOriginalCwd } = await import(
      '../../../bootstrap/state.js'
    )
    const encodedCwd = sanitizePath(getOriginalCwd())
    const projectsDir = join(claudeDir, 'projects', encodedCwd)
    mkdirSync(projectsDir, { recursive: true })

    // 写入一条日志，其中包含一个工具调用，其 input 为深层嵌套对象
    writeFileSync(
      join(projectsDir, `${getSessionId()}.jsonl`),
      [
        JSON.stringify({
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'complex1',
              name: 'ComplexTool',
              input: { nested: { deep: { value: 'test' } } },
            },
          ],
        }),
        JSON.stringify({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'complex1',
              content: [{ type: 'text', text: 'tool result here' }],
            },
          ],
        }),
      ].join('\n') + '\n',
    )

    const mod = await import('../index.js')
    const cmd = mod.default
    const loaded = await (
      cmd as unknown as {
        load: () => Promise<{
          call: (
            args: string,
            ctx: never,
          ) => Promise<{ type: string; value: string }>
        }>
      }
    ).load()
    const result = await loaded.call('1', {} as never)
    expect(result.type).toBe('text')
    if (result.type === 'text') {
      expect(result.value).toContain('ComplexTool')
    }
  })

  test('respects N argument (shows last N of total)', async () => {
    await makeLogWithToolCalls(claudeDir, 3)

    const mod = await import('../index.js')
    const cmd = mod.default
    const loaded = await (
      cmd as unknown as {
        load: () => Promise<{
          call: (
            args: string,
            ctx: never,
          ) => Promise<{ type: string; value: string }>
        }>
      }
    ).load()
    const result = await loaded.call('2', {} as never)
    expect(result.type).toBe('text')
    if (result.type === 'text') {
      // 应显示总共 3 个中的后 2 个
      expect(result.value).toContain('Last 2 Tool Calls')
    }
  })

  async function runWithLogLines(lines: string[]): Promise<string> {
    const { sanitizePath } = await import('../../../utils/path.js')
    const { getSessionId, getOriginalCwd } = await import(
      '../../../bootstrap/state.js'
    )
    const encodedCwd = sanitizePath(getOriginalCwd())
    const projectsDir = join(claudeDir, 'projects', encodedCwd)
    mkdirSync(projectsDir, { recursive: true })
    writeFileSync(
      join(projectsDir, `${getSessionId()}.jsonl`),
      lines.join('\n') + '\n',
    )
    const mod = await import('../index.js')
    const cmd = mod.default
    const loaded = await (
      cmd as unknown as {
        load: () => Promise<{
          call: (
            args: string,
            ctx: never,
          ) => Promise<{ type: string; value: string }>
        }>
      }
    ).load()
    const result = await loaded.call('', {} as never)
    return result.type === 'text' ? result.value : ''
  }

  test('renderValue catch: triggers fallback when JSON.stringify throws', async () => {
    // 将 JSON.stringify patch 为对任何对象输入都抛错 — 触发第 53-54 行
    //（catch 分支）。在 finally 中恢复，以免影响其他测试。
    const originalStringify = JSON.stringify
    JSON.stringify = ((
      v: unknown,
      replacer?: (this: unknown, key: string, value: unknown) => unknown,
      space?: string | number,
    ) => {
      // 允许 string/number/null 透传（测试 setup 会用到这些）
      if (
        typeof v === 'string' ||
        typeof v === 'number' ||
        v === null ||
        v === undefined ||
        Array.isArray(v)
      ) {
        return originalStringify(v, replacer as never, space)
      }
      // 来自 tool_use 的对象输入 → 抛错以触发 catch
      throw new Error('forced JSON.stringify failure')
    }) as typeof JSON.stringify
    try {
      const out = await runWithLogLines([
        // 带对象输入的工具调用 — renderValue 会对它执行 JSON.stringify
        // 注意：由于 JSON.stringify 已被 patch，这里手动构造行字符串
        '{"role":"assistant","content":[{"type":"tool_use","id":"x","name":"X","input":{"obj":1}}]}',
        '{"role":"user","content":[{"type":"tool_result","tool_use_id":"x","content":"y"}]}',
      ])
      // 仍应能渲染，但 Input 字段显示 String 回退值
      expect(out).toContain('X')
    } finally {
      JSON.stringify = originalStringify
    }
  })

  test('truncates long input/output beyond MAX_OUTPUT_LEN', async () => {
    const longString = 'x'.repeat(500)
    const out = await runWithLogLines([
      JSON.stringify({
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'LongTool', input: longString },
        ],
      }),
      JSON.stringify({
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: longString },
        ],
      }),
    ])
    expect(out).toContain('LongTool')
    expect(out).toContain('…')
    expect(out).not.toContain('x'.repeat(300))
  })

  test('renderValue handles object input (JSON.stringify path)', async () => {
    const out = await runWithLogLines([
      JSON.stringify({
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'obj',
            name: 'ObjTool',
            input: { foo: 'bar', n: 42 },
          },
        ],
      }),
      JSON.stringify({
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'obj', content: { ok: true } },
        ],
      }),
    ])
    expect(out).toContain('"foo"')
    expect(out).toContain('"bar"')
    expect(out).toContain('"ok"')
  })

  test('extractContentBlocks: ignores entry without array content (string content)', async () => {
    const out = await runWithLogLines([
      JSON.stringify({ role: 'user', content: 'plain text body' }),
      JSON.stringify({
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Tool', input: 'in' }],
      }),
      JSON.stringify({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'out' }],
      }),
    ])
    expect(out).toContain('Tool')
    expect(out).toContain('in')
  })

  test('extractContentBlocks: skips tool_use missing string id', async () => {
    const out = await runWithLogLines([
      JSON.stringify({
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'NoIdTool', input: 'x' },
          { type: 'tool_use', id: 'good', name: 'GoodTool', input: 'y' },
        ],
      }),
      JSON.stringify({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'good', content: 'r' }],
      }),
    ])
    expect(out).toContain('GoodTool')
    expect(out).not.toContain('NoIdTool')
  })

  test('extractContentBlocks: tool_use without name defaults to "unknown"', async () => {
    const out = await runWithLogLines([
      JSON.stringify({
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'u', input: 'in' }],
      }),
      JSON.stringify({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'u', content: 'r' }],
      }),
    ])
    expect(out).toContain('unknown')
  })

  test('extractContentBlocks: skips tool_result missing tool_use_id', async () => {
    const out = await runWithLogLines([
      JSON.stringify({
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Tool1', input: 'in' }],
      }),
      JSON.stringify({
        role: 'user',
        content: [
          { type: 'tool_result', content: 'orphan_no_id' },
          { type: 'tool_result', tool_use_id: 't1', content: 'matched' },
        ],
      }),
    ])
    expect(out).toContain('Tool1')
    expect(out).toContain('matched')
    expect(out).not.toContain('orphan_no_id')
  })

  test('extractContentBlocks: skips block of unknown type', async () => {
    const out = await runWithLogLines([
      JSON.stringify({
        role: 'assistant',
        content: [
          { type: 'text', text: 'should be ignored' },
          { type: 'tool_use', id: 't1', name: 'OnlyTool', input: 'in' },
        ],
      }),
      JSON.stringify({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r' }],
      }),
    ])
    expect(out).toContain('OnlyTool')
    expect(out).not.toContain('should be ignored')
  })

  test('parseToolCallsFromLog: skips malformed JSON lines', async () => {
    const out = await runWithLogLines([
      'this-is-not-json',
      JSON.stringify({
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'GoodTool', input: 'x' }],
      }),
      '{broken json',
      JSON.stringify({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'y' }],
      }),
    ])
    expect(out).toContain('GoodTool')
  })

  test('skips entries with no content field', async () => {
    const out = await runWithLogLines([
      JSON.stringify({ role: 'system' }),
      JSON.stringify({
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'OnlyTool', input: 'x' }],
      }),
      JSON.stringify({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'y' }],
      }),
    ])
    expect(out).toContain('OnlyTool')
  })

  test('tool_use without matching tool_result produces no pair', async () => {
    const out = await runWithLogLines([
      JSON.stringify({
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'orphan', name: 'OrphanTool', input: 'x' },
        ],
      }),
    ])
    // 无配对 → "no tool call pairs found"
    expect(out).toContain('No tool call')
  })

  test('non-numeric N argument falls back to default 5', async () => {
    await makeLogWithToolCalls(claudeDir, 7)
    const mod = await import('../index.js')
    const cmd = mod.default
    const loaded = await (
      cmd as unknown as {
        load: () => Promise<{
          call: (
            args: string,
            ctx: never,
          ) => Promise<{ type: string; value: string }>
        }>
      }
    ).load()
    const result = await loaded.call('not-a-number', {} as never)
    expect(result.type).toBe('text')
    if (result.type === 'text') {
      // 默认为 5 → "Last 5 Tool Calls (of 7 total)"
      expect(result.value).toContain('Last 5 Tool Calls')
      expect(result.value).toContain('of 7 total')
    }
  })

  test('zero or negative N falls back to default', async () => {
    await makeLogWithToolCalls(claudeDir, 7)
    const mod = await import('../index.js')
    const cmd = mod.default
    const loaded = await (
      cmd as unknown as {
        load: () => Promise<{
          call: (
            args: string,
            ctx: never,
          ) => Promise<{ type: string; value: string }>
        }>
      }
    ).load()
    const result = await loaded.call('0', {} as never)
    expect(result.type).toBe('text')
    if (result.type === 'text') {
      expect(result.value).toContain('Last 5 Tool Calls')
    }
  })

  test('singular header when only one tool call (no plural s)', async () => {
    await makeLogWithToolCalls(claudeDir, 1)
    const mod = await import('../index.js')
    const cmd = mod.default
    const loaded = await (
      cmd as unknown as {
        load: () => Promise<{
          call: (
            args: string,
            ctx: never,
          ) => Promise<{ type: string; value: string }>
        }>
      }
    ).load()
    const result = await loaded.call('1', {} as never)
    expect(result.type).toBe('text')
    if (result.type === 'text') {
      expect(result.value).toContain('Last 1 Tool Call ')
      expect(result.value).not.toContain('Last 1 Tool Calls')
    }
  })
})
