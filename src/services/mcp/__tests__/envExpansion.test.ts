import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { expandEnvVarsInString } from '../envExpansion'

const ENV_OPEN = '$' + '{'
const ENV_CLOSE = '}'
const envExpr = (value: string): string => `${ENV_OPEN}${value}${ENV_CLOSE}`

describe('expandEnvVarsInString', () => {
  // 保存并恢复测试中涉及的环境变量
  const savedEnv: Record<string, string | undefined> = {}
  const trackedKeys = [
    'TEST_HOME',
    'MISSING',
    'TEST_A',
    'TEST_B',
    'TEST_EMPTY',
    'TEST_X',
    'VAR',
    'TEST_FOUND',
  ]

  beforeEach(() => {
    for (const key of trackedKeys) {
      savedEnv[key] = process.env[key]
    }
  })

  afterEach(() => {
    for (const key of trackedKeys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = savedEnv[key]
      }
    }
  })

  test('expands a single env var that exists', () => {
    process.env.TEST_HOME = '/home/user'
    const result = expandEnvVarsInString(envExpr('TEST_HOME'))
    expect(result.expanded).toBe('/home/user')
    expect(result.missingVars).toEqual([])
  })

  test('returns original placeholder and tracks missing var when not found', () => {
    delete process.env.MISSING
    const result = expandEnvVarsInString(envExpr('MISSING'))
    expect(result.expanded).toBe(envExpr('MISSING'))
    expect(result.missingVars).toEqual(['MISSING'])
  })

  test('uses default value when var is missing and default is provided', () => {
    delete process.env.MISSING
    const result = expandEnvVarsInString(envExpr('MISSING:-fallback'))
    expect(result.expanded).toBe('fallback')
    expect(result.missingVars).toEqual([])
  })

  test('expands multiple vars', () => {
    process.env.TEST_A = 'hello'
    process.env.TEST_B = 'world'
    const result = expandEnvVarsInString(
      `${envExpr('TEST_A')}/${envExpr('TEST_B')}`,
    )
    expect(result.expanded).toBe('hello/world')
    expect(result.missingVars).toEqual([])
  })

  test('handles mix of found and missing vars', () => {
    process.env.TEST_FOUND = 'yes'
    delete process.env.MISSING
    const result = expandEnvVarsInString(
      `${envExpr('TEST_FOUND')}-${envExpr('MISSING')}`,
    )
    expect(result.expanded).toBe(`yes-${envExpr('MISSING')}`)
    expect(result.missingVars).toEqual(['MISSING'])
  })

  test('returns plain string unchanged with empty missingVars', () => {
    const result = expandEnvVarsInString('plain string')
    expect(result.expanded).toBe('plain string')
    expect(result.missingVars).toEqual([])
  })

  test('expands empty env var value', () => {
    process.env.TEST_EMPTY = ''
    const result = expandEnvVarsInString(envExpr('TEST_EMPTY'))
    expect(result.expanded).toBe('')
    expect(result.missingVars).toEqual([])
  })

  test('prefers env var value over default when var exists', () => {
    process.env.TEST_X = 'real'
    const result = expandEnvVarsInString(envExpr('TEST_X:-default'))
    expect(result.expanded).toBe('real')
    expect(result.missingVars).toEqual([])
  })

  test('handles default value containing colons', () => {
    // split(':-', 2) 表示只有第一个 :- 是分隔符
    delete process.env.TEST_X
    const result = expandEnvVarsInString(envExpr('TEST_X:-value:-with:-colons'))
    // 默认值是 "value"，因为 split(':-', 2) 返回 ["TEST_X", "value"]
    // 等等 — 实际上对 "TEST_X:-value:-with:-colons" 执行 split(':-', 2) 返回：
    //   ["TEST_X", "value"]，因为 limit=2 在达到 2 个片段时停止
    expect(result.expanded).toBe('value')
    expect(result.missingVars).toEqual([])
  })

  test('handles nested-looking syntax as literal (not supported)', () => {
    // ${${VAR}} — 正则 [^}]+ 匹配 "${VAR"（直到第一个 }）
    // 所以 varName 会是 "${VAR"，在环境中找不到
    delete process.env.VAR
    const nestedExpr = `${ENV_OPEN}${envExpr('VAR')}${ENV_CLOSE}`
    const result = expandEnvVarsInString(nestedExpr)
    // 正则 \$\{([^}]+)\} 匹配 "${${VAR}" 并捕获 "${VAR"
    // 该环境变量不存在，所以保持为 "${${VAR}" + 剩余的 "}"
    expect(result.missingVars).toEqual([`${ENV_OPEN}VAR`])
    expect(result.expanded).toBe(nestedExpr)
  })

  test('handles empty string input', () => {
    const result = expandEnvVarsInString('')
    expect(result.expanded).toBe('')
    expect(result.missingVars).toEqual([])
  })

  test('handles var surrounded by text', () => {
    process.env.TEST_A = 'middle'
    const result = expandEnvVarsInString(`before-${envExpr('TEST_A')}-after`)
    expect(result.expanded).toBe('before-middle-after')
    expect(result.missingVars).toEqual([])
  })

  test('handles default value that is empty string', () => {
    delete process.env.MISSING
    const result = expandEnvVarsInString(envExpr('MISSING:-'))
    expect(result.expanded).toBe('')
    expect(result.missingVars).toEqual([])
  })

  test('does not expand $VAR without braces', () => {
    process.env.TEST_A = 'value'
    const result = expandEnvVarsInString('$TEST_A')
    expect(result.expanded).toBe('$TEST_A')
    expect(result.missingVars).toEqual([])
  })
})
