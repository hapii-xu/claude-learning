import { describe, test, expect } from 'bun:test'
import { parseLocalVaultArgs } from '../parseArgs.js'

describe('parseLocalVaultArgs', () => {
  test('empty string → list', () => {
    expect(parseLocalVaultArgs('')).toEqual({ action: 'list' })
  })

  test('"list" → list', () => {
    expect(parseLocalVaultArgs('list')).toEqual({ action: 'list' })
  })

  test('set with key and value', () => {
    expect(parseLocalVaultArgs('set MY_KEY my-secret-value')).toEqual({
      action: 'set',
      key: 'MY_KEY',
      value: 'my-secret-value',
    })
  })

  test('set with value containing spaces', () => {
    expect(parseLocalVaultArgs('set MY_KEY value with spaces')).toEqual({
      action: 'set',
      key: 'MY_KEY',
      value: 'value with spaces',
    })
  })

  test('set without value → invalid', () => {
    const result = parseLocalVaultArgs('set MY_KEY')
    expect(result.action).toBe('invalid')
  })

  test('set without key → invalid', () => {
    const result = parseLocalVaultArgs('set')
    expect(result.action).toBe('invalid')
  })

  test('get without --reveal → reveal=false', () => {
    expect(parseLocalVaultArgs('get MY_KEY')).toEqual({
      action: 'get',
      key: 'MY_KEY',
      reveal: false,
    })
  })

  test('get with --reveal → reveal=true', () => {
    expect(parseLocalVaultArgs('get MY_KEY --reveal')).toEqual({
      action: 'get',
      key: 'MY_KEY',
      reveal: true,
    })
  })

  test('get with --reveal before key → reveal=true, key correctly resolved', () => {
    expect(parseLocalVaultArgs('get --reveal MY_KEY')).toEqual({
      action: 'get',
      key: 'MY_KEY',
      reveal: true,
    })
  })

  test('get without key → invalid', () => {
    const result = parseLocalVaultArgs('get')
    expect(result.action).toBe('invalid')
  })

  test('delete with key', () => {
    expect(parseLocalVaultArgs('delete MY_KEY')).toEqual({
      action: 'delete',
      key: 'MY_KEY',
    })
  })

  test('delete without key → invalid', () => {
    const result = parseLocalVaultArgs('delete')
    expect(result.action).toBe('invalid')
  })

  test('unknown sub-command → invalid', () => {
    const result = parseLocalVaultArgs('frobnicate')
    expect(result.action).toBe('invalid')
    if (result.action === 'invalid') {
      expect(result.reason).toContain('frobnicate')
    }
  })

  test('"list" with trailing args still returns list action', () => {
    expect(parseLocalVaultArgs('list extra-arg')).toEqual({ action: 'list' })
  })

  test('set with key starting with "-" → invalid (reserved for flags)', () => {
    const r = parseLocalVaultArgs('set --some-flag value')
    expect(r.action).toBe('invalid')
    if (r.action === 'invalid') {
      expect(r.reason.toLowerCase()).toContain('flag')
    }
  })

  test('set with key starting with single "-" → invalid', () => {
    const r = parseLocalVaultArgs('set -k v')
    expect(r.action).toBe('invalid')
  })

  // ── M1（codecov-100 审计 #4）：拒绝类似连字符的 Unicode 前缀 ──
  // U+2212 MINUS SIGN 视觉上像 '-'，但 shell 不会将其往返转回 ASCII '-'。
  // 如果我们接受这样的 key，用户能存储却永远无法通过 CLI 检索。
  describe('M1: hyphen-like Unicode prefix rejection (audit #4)', () => {
    test('U+2212 MINUS SIGN prefix → invalid', () => {
      const r = parseLocalVaultArgs('set −key value')
      expect(r.action).toBe('invalid')
      if (r.action === 'invalid') {
        expect(r.reason.toLowerCase()).toContain('hyphen')
      }
    })

    test('U+2010 HYPHEN prefix → invalid', () => {
      const r = parseLocalVaultArgs('set ‐key value')
      expect(r.action).toBe('invalid')
    })

    test('U+2013 EN DASH prefix → invalid', () => {
      const r = parseLocalVaultArgs('set –key value')
      expect(r.action).toBe('invalid')
    })

    test('U+2014 EM DASH prefix → invalid', () => {
      const r = parseLocalVaultArgs('set —key value')
      expect(r.action).toBe('invalid')
    })

    test('U+FF0D FULLWIDTH HYPHEN-MINUS prefix → invalid', () => {
      const r = parseLocalVaultArgs('set －key value')
      expect(r.action).toBe('invalid')
    })

    test('non-hyphen unicode prefix is still allowed (e.g. CJK)', () => {
      // 防御性测试：我们只拒绝类似连字符的字符；像 '日本語' 这样合法的
      // unicode key 仍必须被接受。
      const r = parseLocalVaultArgs('set 日本語key value')
      expect(r.action).toBe('set')
      if (r.action === 'set') {
        expect(r.key).toBe('日本語key')
        expect(r.value).toBe('value')
      }
    })

    test('underscore prefix is still allowed (not a hyphen)', () => {
      const r = parseLocalVaultArgs('set _under value')
      expect(r.action).toBe('set')
    })
  })
})
