/**
 * teleport/index.ts 的测试 —— 命令元数据 + load() 函数体。
 * 我们不 mock launchTeleport，以免通过 Bun 进程级 mock.module 缓存
 * 污染 launchTeleport.test.ts。
 * load() 通过断言其解析为带 call 函数的对象来测试。
 */
import { beforeAll, describe, expect, mock, test } from 'bun:test'

mock.module('bun:bundle', () => ({
  feature: (_name: string) => false,
}))

let cmd: {
  load?: () => Promise<{ call: unknown }>
  isEnabled?: () => boolean
  name?: string
  type?: string
  aliases?: string[]
  getBridgeInvocationError?: (args: string) => string | undefined
}

beforeAll(async () => {
  const mod = await import('../index.js')
  cmd = mod.default as typeof cmd
})

describe('teleport index', () => {
  test('command name is teleport', () => {
    expect(cmd.name).toBe('teleport')
  })

  test('command type is local-jsx', () => {
    expect(cmd.type).toBe('local-jsx')
  })

  test('isEnabled returns true', () => {
    expect(cmd.isEnabled?.()).toBe(true)
  })

  test('aliases includes tp', () => {
    expect(cmd.aliases).toContain('tp')
  })

  test('getBridgeInvocationError returns error string (not bridge-safe)', () => {
    const err = cmd.getBridgeInvocationError?.('anything')
    expect(typeof err).toBe('string')
    expect(err).toContain('not bridge-safe')
  })

  test('load() exists and is a function', () => {
    expect(typeof cmd.load).toBe('function')
  })

  test('load() resolves to object with call function', async () => {
    const loaded = await cmd.load!()
    expect(typeof (loaded as { call?: unknown }).call).toBe('function')
  })
})
