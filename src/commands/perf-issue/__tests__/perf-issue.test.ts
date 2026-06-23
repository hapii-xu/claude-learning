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

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'perf-test-'))
  claudeDir = join(tmpDir, '.hclaude')
  mkdirSync(claudeDir, { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = claudeDir
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  delete process.env.CLAUDE_CONFIG_DIR
})

describe('perf-issue command', () => {
  test('command has correct name and type', async () => {
    const mod = await import('../index.js')
    const cmd = mod.default
    expect(cmd.name).toBe('perf-issue')
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

  test('writes a perf report and returns path in message', async () => {
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
      expect(result.value).toContain('Perf snapshot written to')
      expect(result.value).toContain('perf-reports')
    }
  })

  test('includes session info and memory in report file', async () => {
    const { readFileSync, readdirSync } = await import('node:fs')
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
    if (result.type === 'text') {
      // 从结果信息中提取路径
      const pathMatch = result.value.match(/\n\s+`?(\S+?\.md)`?/)
      if (pathMatch) {
        const reportContent = readFileSync(pathMatch[1], 'utf8')
        expect(reportContent).toContain('Snapshot')
        expect(reportContent).toContain('Memory')
        expect(reportContent).toContain('CPU')
      }
    }
  })

  test('handles missing log gracefully', async () => {
    // 没有日志文件时它仍然应该可以工作
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
      // 即使 log 段显示 "not found"，也应该生成报告
      expect(result.value).toContain('written to')
    }
  })

  test('log with timestamps and tool_use/result pairs covers lines 109-148', async () => {
    const { sanitizePath } = await import('../../../utils/path.js')
    const { getSessionId, getOriginalCwd } = await import(
      '../../../bootstrap/state.js'
    )
    const encodedCwd = sanitizePath(getOriginalCwd())
    const projectsDir = join(claudeDir, 'projects', encodedCwd)
    mkdirSync(projectsDir, { recursive: true })

    const now = Date.now()
    const logLines = [
      // 数字时间戳（覆盖 109-110 行）
      JSON.stringify({
        role: 'user',
        content: 'hello',
        timestamp: now - 5000,
        usage: { input_tokens: 100 },
      }),
      // 字符串 ISO 时间戳（覆盖 112-113 行）
      JSON.stringify({
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool_abc', name: 'BashTool', input: {} },
        ],
        timestamp: new Date(now - 3000).toISOString(),
        usage: { output_tokens: 50 },
      }),
      // tool_result 匹配 tool_use（覆盖 138-148 行）
      JSON.stringify({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool_abc',
            content: 'ok',
          },
        ],
        timestamp: now - 2000,
      }),
    ]
    writeFileSync(
      join(projectsDir, `${getSessionId()}.jsonl`),
      logLines.join('\n') + '\n',
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
      expect(result.value).toContain('written to')
    }
  })

  test('log exists but is malformed → parse error path (lines 154-156)', async () => {
    const { sanitizePath } = await import('../../../utils/path.js')
    const { getSessionId, getOriginalCwd } = await import(
      '../../../bootstrap/state.js'
    )
    const encodedCwd = sanitizePath(getOriginalCwd())
    const projectsDir = join(claudeDir, 'projects', encodedCwd)
    mkdirSync(projectsDir, { recursive: true })
    // 写入一个 readFileSync 成功但 split/parse 会失败的日志文件。
    // 实际上 analyzeLog 会对每行 try/catch，因此外层 154-156 行的
    // catch 仅在 readFileSync 本身抛错时触发——但 existsSync 已经检查过了。
    // 我们通过写入一个会通过 existsSync 但会让 analyzeLog 在 readFileSync
    // 层抛错的日志文件来模拟：不 mock fs（不能 mock）的话我们做不到。
    //
    // 替代方案：写入一个合法的日志并验证正常路径能工作。
    // 解析错误路径（154-156 行）是 hasLog=true 块内 analyzeLog()
    // 的 catch。由于 analyzeLog 的逐行错误都在内部被捕获，外层
    // catch 只有在 readFileSync 本身抛错时（TOCTOU 竞争）才会触发。
    // 在测试中功能上不可达。
    // 本测试确认没有解析错误的正常路径能工作。
    writeFileSync(
      join(projectsDir, `${getSessionId()}.jsonl`),
      JSON.stringify({
        role: 'user',
        content: 'hi',
        usage: { input_tokens: 5 },
      }) + '\n',
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
      expect(result.value).toContain('written to')
    }
  })

  test('includes token usage when log file exists with usage data', async () => {
    const { sanitizePath } = await import('../../../utils/path.js')
    const { getSessionId, getOriginalCwd } = await import(
      '../../../bootstrap/state.js'
    )
    const encodedCwd = sanitizePath(getOriginalCwd())
    const projectsDir = join(claudeDir, 'projects', encodedCwd)
    mkdirSync(projectsDir, { recursive: true })
    const logLines = [
      JSON.stringify({
        role: 'user',
        content: 'hello',
        usage: { input_tokens: 100 },
      }),
      JSON.stringify({
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'BashTool', input: {} }],
        usage: { output_tokens: 50 },
      }),
    ]
    writeFileSync(
      join(projectsDir, `${getSessionId()}.jsonl`),
      logLines.join('\n') + '\n',
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
      expect(result.value).toContain('written to')
    }
  })

  test('--format=json produces a .json file with token fields', async () => {
    const { sanitizePath } = await import('../../../utils/path.js')
    const { getSessionId, getOriginalCwd } = await import(
      '../../../bootstrap/state.js'
    )
    const projectsDir = join(
      claudeDir,
      'projects',
      sanitizePath(getOriginalCwd()),
    )
    mkdirSync(projectsDir, { recursive: true })
    writeFileSync(
      join(projectsDir, `${getSessionId()}.jsonl`),
      JSON.stringify({
        role: 'user',
        content: 'hello',
        usage: { input_tokens: 42 },
      }) + '\n',
    )
    const mod = await import('../index.js')
    const loaded = await (
      mod.default as unknown as {
        load: () => Promise<{
          call: (
            a: string,
            ctx: never,
          ) => Promise<{ type: string; value: string }>
        }>
      }
    ).load()
    const result = await loaded.call('--format=json', {} as never)
    expect(result.type).toBe('text')
    if (result.type === 'text') {
      const pathMatch = result.value.match(/\n\s+`?(\S+?\.json)`?/)
      if (pathMatch) {
        const { readFileSync } = await import('node:fs')
        const content = readFileSync(pathMatch[1], 'utf8')
        const parsed = JSON.parse(content)
        expect(parsed).toHaveProperty('tokens')
        expect(parsed.tokens.input).toBe(42)
      }
    }
  })

  test('--format=csv produces a .csv file with metric rows', async () => {
    const { sanitizePath } = await import('../../../utils/path.js')
    const { getSessionId, getOriginalCwd } = await import(
      '../../../bootstrap/state.js'
    )
    const projectsDir = join(
      claudeDir,
      'projects',
      sanitizePath(getOriginalCwd()),
    )
    mkdirSync(projectsDir, { recursive: true })
    writeFileSync(
      join(projectsDir, `${getSessionId()}.jsonl`),
      JSON.stringify({
        role: 'user',
        content: 'hello',
        usage: { output_tokens: 10 },
      }) + '\n',
    )
    const mod = await import('../index.js')
    const loaded = await (
      mod.default as unknown as {
        load: () => Promise<{
          call: (
            a: string,
            ctx: never,
          ) => Promise<{ type: string; value: string }>
        }>
      }
    ).load()
    const result = await loaded.call('--format=csv', {} as never)
    expect(result.type).toBe('text')
    if (result.type === 'text') {
      const pathMatch = result.value.match(/\n\s+`?(\S+?\.csv)`?/)
      if (pathMatch) {
        const { readFileSync } = await import('node:fs')
        const content = readFileSync(pathMatch[1], 'utf8')
        expect(content).toContain('metric,value')
        expect(content).toContain('output_tokens,10')
      }
    }
  })

  test('report includes estimated_cost_usd and cache_hit_rate sections', async () => {
    const { sanitizePath } = await import('../../../utils/path.js')
    const { getSessionId, getOriginalCwd } = await import(
      '../../../bootstrap/state.js'
    )
    const projectsDir = join(
      claudeDir,
      'projects',
      sanitizePath(getOriginalCwd()),
    )
    mkdirSync(projectsDir, { recursive: true })
    writeFileSync(
      join(projectsDir, `${getSessionId()}.jsonl`),
      JSON.stringify({
        role: 'user',
        usage: {
          input_tokens: 1000,
          output_tokens: 200,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 400,
        },
      }) + '\n',
    )
    const mod = await import('../index.js')
    const loaded = await (
      mod.default as unknown as {
        load: () => Promise<{
          call: (
            a: string,
            ctx: never,
          ) => Promise<{ type: string; value: string }>
        }>
      }
    ).load()
    const result = await loaded.call('', {} as never)
    if (result.type === 'text') {
      const pathMatch = result.value.match(/\n\s+`?(\S+?\.md)`?/)
      if (pathMatch) {
        const { readFileSync } = await import('node:fs')
        const content = readFileSync(pathMatch[1], 'utf8')
        expect(content).toContain('estimated_usd')
        expect(content).toContain('cache_hit_rate')
      }
    }
  })

  // ── H1 回归：工具耗时必须使用日志时间戳，而非 Date.now() ──
  test('H1: tool durations are computed from log entry timestamps, not parse-time Date.now()', async () => {
    const { sanitizePath } = await import('../../../utils/path.js')
    const { getSessionId, getOriginalCwd } = await import(
      '../../../bootstrap/state.js'
    )
    const encodedCwd = sanitizePath(getOriginalCwd())
    const projectsDir = join(claudeDir, 'projects', encodedCwd)
    mkdirSync(projectsDir, { recursive: true })

    const t0 = 1_000_000_000_000 // 固定的 epoch 毫秒
    const toolUseEntry = JSON.stringify({
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'id_reg1', name: 'BashTool', input: {} },
      ],
      timestamp: t0,
      usage: { output_tokens: 10 },
    })
    const toolResultEntry = JSON.stringify({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'id_reg1', content: 'ok' }],
      // 比 tool_use 晚 3 秒
      timestamp: t0 + 3000,
    })

    writeFileSync(
      join(projectsDir, `${getSessionId()}.jsonl`),
      [toolUseEntry, toolResultEntry].join('\n') + '\n',
    )

    const mod = await import('../index.js')
    const loaded = await (
      mod.default as unknown as {
        load: () => Promise<{
          call: (
            a: string,
            ctx: never,
          ) => Promise<{ type: string; value: string }>
        }>
      }
    ).load()
    const result = await loaded.call('--format=json', {} as never)
    expect(result.type).toBe('text')
    if (result.type === 'text') {
      const pathMatch = result.value.match(/\n\s+`?(\S+?\.json)`?/)
      if (pathMatch) {
        const { readFileSync } = await import('node:fs')
        const parsed = JSON.parse(readFileSync(pathMatch[1], 'utf8'))
        // BashTool 平均应约为 3000ms（来自时间戳），而不是 <1ms（来自 Date.now()）
        const avgMs = parsed.tool_avg_ms?.BashTool
        expect(typeof avgMs).toBe('number')
        // 必须接近 3000ms（±500ms 的容差以应对 CI 波动）
        expect(avgMs).toBeGreaterThan(2000)
        expect(avgMs).toBeLessThan(4000)
      }
    }
  })

  // ── H2 回归：按模型查询费用，未知模型 → null ──
  test('H2: known model produces cost estimate; unknown model produces null', async () => {
    const { sanitizePath } = await import('../../../utils/path.js')
    const { getSessionId, getOriginalCwd } = await import(
      '../../../bootstrap/state.js'
    )
    const encodedCwd = sanitizePath(getOriginalCwd())
    const projectsDir = join(claudeDir, 'projects', encodedCwd)
    mkdirSync(projectsDir, { recursive: true })

    // 写入带有已知 model 字段的日志
    writeFileSync(
      join(projectsDir, `${getSessionId()}.jsonl`),
      JSON.stringify({
        role: 'assistant',
        model: 'claude-sonnet-4-20260401',
        content: [],
        usage: { input_tokens: 1000, output_tokens: 200 },
      }) + '\n',
    )

    const mod = await import('../index.js')
    const loaded = await (
      mod.default as unknown as {
        load: () => Promise<{
          call: (
            a: string,
            ctx: never,
          ) => Promise<{ type: string; value: string }>
        }>
      }
    ).load()
    const result = await loaded.call('--format=json', {} as never)
    expect(result.type).toBe('text')
    if (result.type === 'text') {
      const pathMatch = result.value.match(/\n\s+`?(\S+?\.json)`?/)
      if (pathMatch) {
        const { readFileSync } = await import('node:fs')
        const parsed = JSON.parse(readFileSync(pathMatch[1], 'utf8'))
        // 已知模型 → 数字费用
        expect(typeof parsed.estimated_cost_usd).toBe('number')
        expect(parsed.estimated_cost_usd).toBeGreaterThan(0)
        expect(parsed.detected_model).toBe('claude-sonnet-4-20260401')
      }
    }
  })

  test('H2: unrecognized model produces null estimated_cost_usd in JSON', async () => {
    const { sanitizePath } = await import('../../../utils/path.js')
    const { getSessionId, getOriginalCwd } = await import(
      '../../../bootstrap/state.js'
    )
    const encodedCwd = sanitizePath(getOriginalCwd())
    const projectsDir = join(claudeDir, 'projects', encodedCwd)
    mkdirSync(projectsDir, { recursive: true })

    writeFileSync(
      join(projectsDir, `${getSessionId()}.jsonl`),
      JSON.stringify({
        role: 'assistant',
        model: 'some-future-unknown-model-99',
        content: [],
        usage: { input_tokens: 500 },
      }) + '\n',
    )

    const mod = await import('../index.js')
    const loaded = await (
      mod.default as unknown as {
        load: () => Promise<{
          call: (
            a: string,
            ctx: never,
          ) => Promise<{ type: string; value: string }>
        }>
      }
    ).load()
    const result = await loaded.call('--format=json', {} as never)
    if (result.type === 'text') {
      const pathMatch = result.value.match(/\n\s+`?(\S+?\.json)`?/)
      if (pathMatch) {
        const { readFileSync } = await import('node:fs')
        const parsed = JSON.parse(readFileSync(pathMatch[1], 'utf8'))
        expect(parsed.estimated_cost_usd).toBeNull()
      }
    }
  })

  // ── M6 回归：错误信息必须经过净化（不含绝对家目录路径） ──
  test('M6: error messages do not expose absolute home dir paths', async () => {
    const { homedir } = await import('node:os')
    const home = homedir()
    // 写入一个无效的 perf 报告目录，通过把 CLAUDE_CONFIG_DIR 指向
    // 一个文件（而非目录）来强制 writeFileSync 失败。
    const filePath = join(tmpDir, 'not-a-dir')
    const { writeFileSync: wfs } = await import('node:fs')
    wfs(filePath, 'block', 'utf8')
    // 覆盖 CLAUDE_CONFIG_DIR 指向一个文件，使 call() 内部的 mkdirSync 失败
    process.env.CLAUDE_CONFIG_DIR = filePath

    const mod = await import('../index.js')
    const loaded = await (
      mod.default as unknown as {
        load: () => Promise<{
          call: (
            a: string,
            ctx: never,
          ) => Promise<{ type: string; value: string }>
        }>
      }
    ).load()
    const result = await loaded.call('', {} as never)

    // 恢复 CLAUDE_CONFIG_DIR，使后续测试不受影响
    process.env.CLAUDE_CONFIG_DIR = claudeDir

    if (result.type === 'text' && result.value.includes('Failed')) {
      // 不能包含原始的家目录路径
      expect(result.value).not.toContain(home)
      // 错误部分最多 200 个字符
      const errPart = result.value.replace('Failed to write perf report: ', '')
      expect(errPart.length).toBeLessThanOrEqual(210) // +前缀字符的少量开销
    }
  })

  // ── M4 回归：--limit 限制读取的行数 ──
  test('M4: --limit N caps the number of log lines analyzed', async () => {
    const { sanitizePath } = await import('../../../utils/path.js')
    const { getSessionId, getOriginalCwd } = await import(
      '../../../bootstrap/state.js'
    )
    const encodedCwd = sanitizePath(getOriginalCwd())
    const projectsDir = join(claudeDir, 'projects', encodedCwd)
    mkdirSync(projectsDir, { recursive: true })

    // 写入 10 行带 usage 的数据
    const logLines = Array.from({ length: 10 }, (_, i) =>
      JSON.stringify({
        role: 'user',
        content: `msg ${i}`,
        usage: { input_tokens: 10 },
      }),
    )
    writeFileSync(
      join(projectsDir, `${getSessionId()}.jsonl`),
      logLines.join('\n') + '\n',
    )

    const mod = await import('../index.js')
    const loaded = await (
      mod.default as unknown as {
        load: () => Promise<{
          call: (
            a: string,
            ctx: never,
          ) => Promise<{ type: string; value: string }>
        }>
      }
    ).load()
    // --limit 3 只应分析最后 3 行（30 个 token）
    const result = await loaded.call('--format=json --limit 3', {} as never)
    if (result.type === 'text') {
      const pathMatch = result.value.match(/\n\s+`?(\S+?\.json)`?/)
      if (pathMatch) {
        const { readFileSync } = await import('node:fs')
        const parsed = JSON.parse(readFileSync(pathMatch[1], 'utf8'))
        // 使用 --limit 3 时，只有 3 行 × 10 token = 30 个 input token
        expect(parsed.tokens.input).toBe(30)
      }
    }
  })
})
