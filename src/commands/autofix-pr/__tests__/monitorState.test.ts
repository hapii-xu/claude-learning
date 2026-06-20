import { beforeEach, describe, expect, test } from 'bun:test'
import {
  clearActiveMonitor,
  getActiveMonitor,
  isMonitoring,
  setActiveMonitor,
  trySetActiveMonitor,
  updateActiveMonitor,
} from '../monitorState.js'

function makeState(
  overrides?: Partial<Parameters<typeof setActiveMonitor>[0]>,
) {
  return {
    taskId: 'task-1',
    owner: 'acme',
    repo: 'myrepo',
    prNumber: 42,
    abortController: new AbortController(),
    startedAt: Date.now(),
    ...overrides,
  }
}

describe('monitorState', () => {
  beforeEach(() => {
    clearActiveMonitor()
  })

  test('getActiveMonitor returns null when nothing set', () => {
    expect(getActiveMonitor()).toBeNull()
  })

  test('setActiveMonitor stores state and getActiveMonitor returns it', () => {
    const state = makeState()
    setActiveMonitor(state)
    expect(getActiveMonitor()).toBe(state)
  })

  test('clearActiveMonitor resets state to null', () => {
    setActiveMonitor(makeState())
    clearActiveMonitor()
    expect(getActiveMonitor()).toBeNull()
  })

  test('isMonitoring returns true for matching owner/repo/prNumber', () => {
    setActiveMonitor(makeState())
    expect(isMonitoring('acme', 'myrepo', 42)).toBe(true)
  })

  test('isMonitoring returns false when not monitoring', () => {
    expect(isMonitoring('acme', 'myrepo', 42)).toBe(false)
  })

  test('setActiveMonitor throws when already active', () => {
    setActiveMonitor(makeState())
    expect(() => setActiveMonitor(makeState({ prNumber: 99 }))).toThrow(
      /Monitor already active/,
    )
  })

  test('clearActiveMonitor calls abort on the controller', () => {
    const abortController = new AbortController()
    setActiveMonitor(makeState({ abortController }))
    clearActiveMonitor()
    expect(abortController.signal.aborted).toBe(true)
  })

  test('trySetActiveMonitor returns true when no active monitor', () => {
    expect(trySetActiveMonitor(makeState())).toBe(true)
    expect(getActiveMonitor()).not.toBeNull()
  })

  test('trySetActiveMonitor returns false when monitor already active', () => {
    expect(trySetActiveMonitor(makeState({ prNumber: 1 }))).toBe(true)
    expect(trySetActiveMonitor(makeState({ prNumber: 2 }))).toBe(false)
    // 保留的是第一个 state
    expect(getActiveMonitor()?.prNumber).toBe(1)
  })

  test('updateActiveMonitor returns false when no active monitor', () => {
    expect(updateActiveMonitor({ taskId: 'task-x' })).toBe(false)
    expect(getActiveMonitor()).toBeNull()
  })

  test('updateActiveMonitor merges partial fields into the active monitor', () => {
    setActiveMonitor(makeState({ taskId: 'tentative-uuid' }))
    expect(updateActiveMonitor({ taskId: 'framework-task-id' })).toBe(true)
    const after = getActiveMonitor()
    expect(after?.taskId).toBe('framework-task-id')
    // 其他字段保持不变
    expect(after?.owner).toBe('acme')
    expect(after?.repo).toBe('myrepo')
    expect(after?.prNumber).toBe(42)
  })

  test('updateActiveMonitor with new taskId makes clearActiveMonitor recognise framework taskId', () => {
    // 复现潜在 bug 场景：用一个 taskId 拿到锁，框架又分配了另一个 taskId。
    // 修复之前，框架调用 clearActiveMonitor(frameworkTaskId) 会因守卫失败而无操作。
    setActiveMonitor(makeState({ taskId: 'teammate-uuid' }))
    // 框架用自己的 taskId 做清理 —— 修复之前守卫会失败
    clearActiveMonitor('framework-uuid')
    expect(getActiveMonitor()).not.toBeNull()
    // updateActiveMonitor 替换 taskId 之后，框架清理就能生效
    updateActiveMonitor({ taskId: 'framework-uuid' })
    clearActiveMonitor('framework-uuid')
    expect(getActiveMonitor()).toBeNull()
  })

  test('updateActiveMonitor does not change abortController identity', () => {
    const ac = new AbortController()
    setActiveMonitor(makeState({ abortController: ac, taskId: 'tentative' }))
    updateActiveMonitor({ taskId: 'updated' })
    expect(getActiveMonitor()?.abortController).toBe(ac)
  })
})
