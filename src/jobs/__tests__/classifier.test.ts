/**
 * src/jobs/classifier.ts 的测试
 *
 * 使用真实的临时目录而不是 mock fs，以避免 bun test 中的
 * 跨测试 mock 污染。
 *
 * classifier.ts 将 jobDir 作为参数接受，因此不需要 envUtils mock。
 */
import { describe, expect, test, beforeEach, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { AssistantMessage } from '../../types/message.js'
import { classifyAndWriteState } from '../classifier.js'

// ─── 设置：真实临时目录 ──────────────────────────────────────────────────

let tempBase: string
let jobDir: string
let stateFile: string

tempBase = mkdtempSync(join(tmpdir(), 'classifier-test-'))

function freshJobDir(): void {
  jobDir = mkdtempSync(join(tempBase, 'job-'))
  stateFile = join(jobDir, 'state.json')
}

// ─── 辅助函数 ────────────────────────────────────────────────────────────────

function makeAssistantMessage(
  content: any[],
  extra: Record<string, any> = {},
): AssistantMessage {
  return {
    type: 'assistant',
    uuid: '00000000-0000-0000-0000-000000000000' as any,
    message: {
      role: 'assistant',
      content,
      ...extra,
    },
  } as any
}

// ─── 生命周期 ─────────────────────────────────────────────────────────────

beforeEach(() => {
  freshJobDir()
})

afterAll(() => {
  try {
    rmSync(tempBase, { recursive: true, force: true })
  } catch {
    // 尽力清理
  }
})

// ─── 测试 ──────────────────────────────────────────────────────────────────

describe('classifyAndWriteState', () => {
  test('does nothing when state.json is missing', async () => {
    await classifyAndWriteState(jobDir, [])
    // stateFile 应该仍然不存在
    let exists = false
    try {
      readFileSync(stateFile, 'utf-8')
      exists = true
    } catch {
      // 预期的
    }
    expect(exists).toBe(false)
  })

  test('sets status to running when last message has tool_use block', async () => {
    writeFileSync(
      stateFile,
      JSON.stringify({ status: 'created', updatedAt: '2026-01-01' }),
      'utf-8',
    )

    const msg = makeAssistantMessage([
      { type: 'text', text: 'Let me check...' },
      { type: 'tool_use', id: 'toolu_1', name: 'bash', input: {} },
    ])

    await classifyAndWriteState(jobDir, [msg])

    const state = JSON.parse(readFileSync(stateFile, 'utf-8'))
    expect(state.status).toBe('running')
  })

  test('sets status to completed when stop_reason is end_turn', async () => {
    writeFileSync(
      stateFile,
      JSON.stringify({ status: 'running', updatedAt: '2026-01-01' }),
      'utf-8',
    )

    const msg = makeAssistantMessage([{ type: 'text', text: 'All done.' }], {
      stop_reason: 'end_turn',
    })

    await classifyAndWriteState(jobDir, [msg])

    const state = JSON.parse(readFileSync(stateFile, 'utf-8'))
    expect(state.status).toBe('completed')
  })

  test('sets status to running for empty messages (state exists)', async () => {
    writeFileSync(
      stateFile,
      JSON.stringify({ status: 'created', updatedAt: '2026-01-01' }),
      'utf-8',
    )

    await classifyAndWriteState(jobDir, [])

    const state = JSON.parse(readFileSync(stateFile, 'utf-8'))
    expect(state.status).toBe('running')
  })

  test('sets status to running when stop_reason is max_tokens', async () => {
    writeFileSync(
      stateFile,
      JSON.stringify({ status: 'running', updatedAt: '2026-01-01' }),
      'utf-8',
    )

    const msg = makeAssistantMessage([{ type: 'text', text: 'I need more' }], {
      stop_reason: 'max_tokens',
    })

    await classifyAndWriteState(jobDir, [msg])

    const state = JSON.parse(readFileSync(stateFile, 'utf-8'))
    expect(state.status).toBe('running')
  })
})
