import { describe, expect, test } from 'bun:test'
import {
  isSnipMarkerMessage,
  isSnipRuntimeEnabled,
  shouldNudgeForSnips,
  snipCompactIfNeeded,
  SNIP_NUDGE_TEXT,
} from '../snipCompact.js'
import type { Message } from 'src/types/message.js'

// --- 辅助函数 ---

function makeMessage(uuid: string, type: Message['type'] = 'user'): Message {
  return {
    type,
    uuid,
    message: {
      role: type === 'user' ? 'user' : 'assistant',
      content: `Message ${uuid}`,
    },
  } as Message
}

function makeSystemMessage(
  uuid: string,
  subtype?: string,
  extra?: Record<string, unknown>,
): Message {
  const msg: Message = {
    type: 'system',
    uuid,
    message: { role: 'system', content: '' },
    ...extra,
  } as Message
  if (subtype) {
    ;(msg as Record<string, unknown>).subtype = subtype
  }
  return msg
}

function makeSnipBoundary(uuid: string, removedUuids: string[]): Message {
  return makeSystemMessage(uuid, 'snip_boundary', {
    snipMetadata: { removedUuids },
    content: '[snip] Conversation history before this point has been snipped.',
  })
}

// --- isSnipMarkerMessage 测试 ---

describe('isSnipMarkerMessage', () => {
  test('returns true for system message with snip_marker subtype', () => {
    const msg = makeSystemMessage('m1', 'snip_marker')
    expect(isSnipMarkerMessage(msg)).toBe(true)
  })

  test('returns false for system message with other subtype', () => {
    const msg = makeSystemMessage('m1', 'snip_boundary')
    expect(isSnipMarkerMessage(msg)).toBe(false)
  })

  test('returns false for non-system message', () => {
    const msg = makeMessage('m1', 'user')
    expect(isSnipMarkerMessage(msg)).toBe(false)
  })
})

// --- isSnipRuntimeEnabled 测试 ---

describe('isSnipRuntimeEnabled', () => {
  test('returns true (module is only loaded when HISTORY_SNIP is on)', () => {
    expect(isSnipRuntimeEnabled()).toBe(true)
  })
})

// --- shouldNudgeForSnips 测试 ---

describe('shouldNudgeForSnips', () => {
  test('returns false for short conversation', () => {
    const msgs = Array.from({ length: 10 }, (_, i) => makeMessage(`u${i}`))
    expect(shouldNudgeForSnips(msgs)).toBe(false)
  })

  test('returns true for long conversation', () => {
    const msgs = Array.from({ length: 35 }, (_, i) => makeMessage(`u${i}`))
    expect(shouldNudgeForSnips(msgs)).toBe(true)
  })

  test('returns true at exact threshold', () => {
    const msgs = Array.from({ length: 30 }, (_, i) => makeMessage(`u${i}`))
    expect(shouldNudgeForSnips(msgs)).toBe(true)
  })
})

// --- SNIP_NUDGE_TEXT 测试 ---

describe('SNIP_NUDGE_TEXT', () => {
  test('is a non-empty string', () => {
    expect(typeof SNIP_NUDGE_TEXT).toBe('string')
    expect(SNIP_NUDGE_TEXT.length).toBeGreaterThan(0)
  })
})

// --- snipCompactIfNeeded 测试 ---

describe('snipCompactIfNeeded', () => {
  test('returns messages unchanged when no snip boundary exists', () => {
    const msgs = [makeMessage('a'), makeMessage('b'), makeMessage('c')]
    const result = snipCompactIfNeeded(msgs)
    expect(result.executed).toBe(false)
    expect(result.messages).toBe(msgs) // 相同引用
    expect(result.tokensFreed).toBe(0)
    expect(result.boundaryMessage).toBeUndefined()
  })

  test('removes messages listed in removedUuids', () => {
    const a = makeMessage('a')
    const b = makeMessage('b')
    const c = makeMessage('c')
    const boundary = makeSnipBoundary('bnd', ['a', 'b'])

    const msgs = [a, b, c, boundary]
    const result = snipCompactIfNeeded(msgs)

    expect(result.executed).toBe(true)
    expect(result.messages).toHaveLength(2)
    expect(result.messages.map(m => m.uuid) as string[]).toEqual(['c', 'bnd'])
    expect(result.tokensFreed).toBeGreaterThan(0)
    expect(result.boundaryMessage).toBe(boundary)
  })

  test('keeps boundary message when all messages are removed', () => {
    const a = makeMessage('a')
    const b = makeMessage('b')
    const boundary = makeSnipBoundary('bnd', ['a', 'b'])

    const msgs = [a, b, boundary]
    const result = snipCompactIfNeeded(msgs)

    expect(result.executed).toBe(true)
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]!.uuid as string).toBe('bnd')
  })

  test('keeps messages after boundary when no removedUuids', () => {
    const a = makeMessage('a')
    const boundary = makeSystemMessage('bnd', 'snip_boundary')
    const c = makeMessage('c')

    const msgs = [a, boundary, c]
    const result = snipCompactIfNeeded(msgs)

    expect(result.executed).toBe(true)
    expect(result.messages).toHaveLength(2)
    expect(result.messages.map(m => m.uuid) as string[]).toEqual(['bnd', 'c'])
  })

  test('handles empty removedUuids array', () => {
    const a = makeMessage('a')
    const boundary = makeSnipBoundary('bnd', [])

    const msgs = [a, boundary]
    const result = snipCompactIfNeeded(msgs)

    expect(result.executed).toBe(true)
    // 兜底：保留 boundary + 之后的所有内容
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]!.uuid as string).toBe('bnd')
  })

  test('uses last boundary when multiple boundaries exist', () => {
    const a = makeMessage('a')
    const b = makeMessage('b')
    const c = makeMessage('c')
    const boundary1 = makeSnipBoundary('bnd1', ['a'])
    const boundary2 = makeSnipBoundary('bnd2', ['b'])

    const msgs = [a, boundary1, b, boundary2, c]
    const result = snipCompactIfNeeded(msgs)

    expect(result.executed).toBe(true)
    expect(result.boundaryMessage!.uuid as string).toBe('bnd2')
    // 'b' 被 boundary2 移除，'a' 不在 boundary2 的 removedUuids 中
    expect(result.messages.map(m => m.uuid) as string[]).toEqual([
      'a',
      'bnd1',
      'bnd2',
      'c',
    ])
  })

  test('respects force option (no functional difference — both execute)', () => {
    const a = makeMessage('a')
    const boundary = makeSnipBoundary('bnd', ['a'])

    const msgs = [a, boundary]
    const resultForce = snipCompactIfNeeded(msgs, { force: true })
    const resultNoForce = snipCompactIfNeeded(msgs)

    expect(resultForce.executed).toBe(true)
    expect(resultNoForce.executed).toBe(true)
  })

  test('estimates tokens freed based on removed content length', () => {
    const heavy = {
      ...makeMessage('heavy', 'user'),
      message: {
        role: 'user' as const,
        content: 'x'.repeat(400), // ~100 个 token
      },
    } as Message
    const boundary = makeSnipBoundary('bnd', ['heavy'])

    const result = snipCompactIfNeeded([heavy, boundary])
    expect(result.tokensFreed).toBeGreaterThan(0)
    // 400 字符 / 4 字符每 token = ~100 个 token
    expect(result.tokensFreed).toBeGreaterThanOrEqual(90)
  })

  test('handles empty message array', () => {
    const result = snipCompactIfNeeded([])
    expect(result.executed).toBe(false)
    expect(result.messages).toHaveLength(0)
  })
})
