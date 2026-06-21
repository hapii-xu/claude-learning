import { describe, expect, test } from 'bun:test'
import { memoizeWithLRU } from '../cache.js'

describe('memoizeWithLRU', () => {
  test('caches results', () => {
    let callCount = 0
    const fn = memoizeWithLRU(
      (x: number) => {
        callCount++
        return x * 2
      },
      x => `key-${x}`,
      10,
    )

    expect(fn(5)).toBe(10)
    expect(callCount).toBe(1)
    expect(fn(5)).toBe(10)
    expect(callCount).toBe(1) // cached, no new call
  })

  test('evicts least recently used entries', () => {
    const fn = memoizeWithLRU(
      (x: number) => x,
      x => `key-${x}`,
      2,
    )

    fn(1)
    fn(2)
    fn(3) // should evict key-1

    expect(fn.cache.size()).toBe(2)
    expect(fn.cache.has('key-1')).toBe(false)
    expect(fn.cache.has('key-2')).toBe(true)
    expect(fn.cache.has('key-3')).toBe(true)
  })

  test('cache.clear removes all entries', () => {
    const fn = memoizeWithLRU(
      (x: number) => x,
      x => `key-${x}`,
      10,
    )

    fn(1)
    fn(2)
    expect(fn.cache.size()).toBe(2)

    fn.cache.clear()
    expect(fn.cache.size()).toBe(0)
  })

  test('cache.delete removes specific entry', () => {
    const fn = memoizeWithLRU(
      (x: number) => x,
      x => `key-${x}`,
      10,
    )

    fn(1)
    fn(2)
    expect(fn.cache.delete('key-1')).toBe(true)
    expect(fn.cache.has('key-1')).toBe(false)
    expect(fn.cache.has('key-2')).toBe(true)
  })

  test('cache.get returns value without promoting', () => {
    const fn = memoizeWithLRU(
      (x: number) => x * 10,
      x => `key-${x}`,
      2,
    )

    fn(1)
    fn(2)
    // key-1 是 LRU，但 get() 不应该提升它
    expect(fn.cache.get('key-1')).toBe(10)
    // 添加 key-3 应该仍然淘汰 key-1（未被 get 提升）
    fn(3)
    expect(fn.cache.has('key-1')).toBe(false)
  })
})
