/**
 * schedule/index.ts 的测试 — 仅针对命令元数据。
 */
import { beforeAll, describe, expect, mock, test } from 'bun:test'

mock.module('bun:bundle', () => ({
  feature: (_name: string) => true,
}))

let cmd: {
  load?: () => Promise<{ call: unknown }>
  isEnabled?: () => boolean
  name?: string
  type?: string
  aliases?: string[]
  description?: string
  bridgeSafe?: boolean
  availability?: string[]
}

beforeAll(async () => {
  const mod = await import('../index.js')
  cmd = mod.default as typeof cmd
})

describe('scheduleCommand metadata', () => {
  test('name is "triggers" (renamed from "schedule" to avoid bundled-skill collision)', () => {
    expect(cmd.name).toBe('triggers')
  })

  test('type is local-jsx', () => {
    expect(cmd.type).toBe('local-jsx')
  })

  test('isEnabled returns true', () => {
    expect(cmd.isEnabled?.()).toBe(true)
  })

  test('aliases include cron (triggers is now the primary name)', () => {
    expect(cmd.aliases).toContain('cron')
    // 'triggers' 已迁移为主 `name`；上游内置 skill /schedule 占用了
    // 'schedule' 这个槽位，因此我们也不将其作为别名。
    expect(cmd.aliases).not.toContain('schedule')
  })

  test('bridgeSafe is false', () => {
    expect(cmd.bridgeSafe).toBe(false)
  })

  test('availability includes claude-ai', () => {
    expect(cmd.availability).toContain('claude-ai')
  })

  test('description mentions schedule or trigger', () => {
    expect(cmd.description?.toLowerCase()).toMatch(/schedule|cron|trigger/)
  })

  test('load() exists and is a function', () => {
    expect(typeof cmd.load).toBe('function')
  })

  test('load() resolves to object with call function', async () => {
    const loaded = await cmd.load!()
    expect(typeof (loaded as { call?: unknown }).call).toBe('function')
  })
})
