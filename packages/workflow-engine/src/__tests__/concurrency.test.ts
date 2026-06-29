import { expect, test } from 'bun:test'
import {
  clampMaxConcurrency,
  Semaphore,
  maxConcurrency,
} from '../engine/concurrency.js'
import { DEFAULT_MAX_CONCURRENCY, MAX_CONCURRENCY_CAP } from '../constants.js'

test('Semaphore limits concurrency, permit transfer does not leak', async () => {
  const sem = new Semaphore(2)
  let active = 0
  let peak = 0
  const task = async (): Promise<void> => {
    const release = await sem.acquire()
    active++
    peak = Math.max(peak, active)
    await new Promise(r => {
      setTimeout(r, 10)
    })
    active--
    release()
  }
  await Promise.all(Array.from({ length: 6 }, () => task()))
  expect(peak).toBe(2) // 从不超过许可数
})

test('maxConcurrency returns DEFAULT_MAX_CONCURRENCY (=3)', () => {
  expect(maxConcurrency()).toBe(DEFAULT_MAX_CONCURRENCY)
  expect(maxConcurrency()).toBe(3)
})

test('clampMaxConcurrency: undefined/NaN→DEFAULT; <1→1; >CAP→CAP; normal value kept', () => {
  expect(clampMaxConcurrency(undefined)).toBe(DEFAULT_MAX_CONCURRENCY)
  expect(clampMaxConcurrency(Number.NaN)).toBe(DEFAULT_MAX_CONCURRENCY)
  expect(clampMaxConcurrency(0)).toBe(1)
  expect(clampMaxConcurrency(-3)).toBe(1)
  expect(clampMaxConcurrency(MAX_CONCURRENCY_CAP + 100)).toBe(
    MAX_CONCURRENCY_CAP,
  )
  expect(clampMaxConcurrency(5)).toBe(5)
  expect(clampMaxConcurrency(1)).toBe(1)
  expect(clampMaxConcurrency(MAX_CONCURRENCY_CAP)).toBe(MAX_CONCURRENCY_CAP)
  // 小数截断（Semaphore 已执行 Math.max(1, Math.floor)；clampMaxConcurrency 显式截断）
  expect(clampMaxConcurrency(2.9)).toBe(2)
})

test('Semaphore(0) has at least 1 permit, acquire does not block', async () => {
  const sem = new Semaphore(0)
  const release = await sem.acquire()
  expect(release).toBeTypeOf('function')
  release()
})

test('Semaphore wakes up in FIFO order', async () => {
  const sem = new Semaphore(1)
  const order: string[] = []
  const first = await sem.acquire()
  const p1 = sem.acquire().then(r => {
    order.push('p1')
    return r
  })
  const p2 = sem.acquire().then(r => {
    order.push('p2')
    return r
  })
  await new Promise(r => {
    setTimeout(r, 5)
  })
  expect(order).toEqual([])
  first()
  await new Promise(r => {
    setTimeout(r, 5)
  })
  expect(order).toEqual(['p1'])
  ;(await p1)()
  await new Promise(r => {
    setTimeout(r, 5)
  })
  expect(order).toEqual(['p1', 'p2'])
  ;(await p2)()
})

test('Semaphore.acquire with an aborted signal → immediately rejects, no permit consumed', async () => {
  // 修复 L：中止时排队的等待者必须立即 reject 而非等待许可。
  // 否则已取消的 agent 阻塞在 acquire()，许可被消耗（转移给死等待者），
  // 降低实际并发能力；最坏情况下所有等待者已取消，信号量仍为死等待者排队。
  const sem = new Semaphore(1)
  const ac = new AbortController()

  // 占据唯一许可
  const first = await sem.acquire()

  // 排队的等待者
  const queued = sem.acquire(ac.signal)
  await new Promise(r => {
    setTimeout(r, 5)
  })

  // 中止 → 等待者应立即 reject
  ac.abort()
  await expect(queued).rejects.toThrow()

  // 无许可泄漏：释放 first 后，新的 acquire 应立即获得（无过期等待者抢占）
  first()
  const third = await sem.acquire()
  expect(third).toBeTypeOf('function')
  third()
})

test('Semaphore.acquire with an already aborted signal → synchronous reject', async () => {
  const sem = new Semaphore(1)
  const ac = new AbortController()
  ac.abort()
  // 信号已中止，即使有许可也不应获取（语义：调用者已取消）
  // 注意：当前实现先检查 available 并可能直接返回。此测试锁定"优先检查中止"。
  // 若实现选择"许可可用时优先授予"，此测试将改为：acquire 成功，调用者稍后检查中止。
  // 当前实现采用前者：中止信号立即抛出，阻止死 agent 抢占许可。
  await expect(sem.acquire(ac.signal)).rejects.toThrow()
})
