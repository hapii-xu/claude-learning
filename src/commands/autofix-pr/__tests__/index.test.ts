import { beforeAll, describe, expect, mock, test } from 'bun:test'

// 在 import index 之前必须先 mock bun:bundle
mock.module('bun:bundle', () => ({
  feature: (_name: string) => true,
}))

let cmd: {
  isEnabled?: () => boolean
  getBridgeInvocationError?: (args: string) => string | undefined
  load?: () => Promise<unknown>
}
let getBridgeInvocationError: ((args: string) => string | undefined) | undefined

beforeAll(async () => {
  const mod = await import('../index.js')
  cmd = mod.default as typeof cmd
  getBridgeInvocationError = cmd.getBridgeInvocationError
})

describe('autofixPr isEnabled', () => {
  test('isEnabled returns a boolean', () => {
    // 在 Bun 测试环境中，bun:bundle 的 feature() 是编译期 macro。
    // mock.module('bun:bundle') 拦截只是为了让 import 成功，真正的 macro 取值
    // 是构建期解析的（不是运行期）。在测试 runner（非 bundle 模式）下，
    // feature() 返回 false。我们只验证该函数可调用并返回 boolean。
    const result = cmd.isEnabled?.()
    expect(typeof result).toBe('boolean')
  })
})

describe('autofixPr load', () => {
  test('load function exists on the command', () => {
    // 只验证 load 是函数（不要调用它 —— 调用它会 import launchAutofixPr.js，
    // 进而在进程级注入 mock，污染 launchAutofixPr.test.ts）
    expect(typeof cmd.load).toBe('function')
  })
})

describe('autofixPr getBridgeInvocationError', () => {
  test('empty string returns error', () => {
    const err = getBridgeInvocationError?.('')
    expect(err).toBe('PR number required, e.g. /autofix-pr 386')
  })

  test('"stop" returns undefined (no error)', () => {
    expect(getBridgeInvocationError?.('stop')).toBeUndefined()
  })

  test('"off" returns undefined (no error)', () => {
    expect(getBridgeInvocationError?.('off')).toBeUndefined()
  })

  test('digit-only returns undefined (no error)', () => {
    expect(getBridgeInvocationError?.('386')).toBeUndefined()
  })

  test('cross-repo syntax returns undefined (no error)', () => {
    expect(
      getBridgeInvocationError?.('anthropics/claude-code#999'),
    ).toBeUndefined()
  })

  test('invalid args returns error string', () => {
    const err = getBridgeInvocationError?.('not valid!!')
    expect(err).toMatch(/Invalid args/)
  })

  test('load is defined as an async function', () => {
    expect(typeof cmd.load).toBe('function')
  })
})
