import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '../../../entrypoints/agentSdkTypes.js'
import {
  AUTOFIX_RESULT_TAG,
  extractAutofixResultFromLog,
} from '../extractAutofixResult.js'

function hookProgressMessage(stdout: string): SDKMessage {
  return {
    type: 'system',
    subtype: 'hook_progress',
    stdout,
  } as unknown as SDKMessage
}

function assistantTextMessage(text: string): SDKMessage {
  return {
    type: 'assistant',
    message: {
      content: [{ type: 'text', text }],
    },
  } as unknown as SDKMessage
}

const sampleTag = (summary: string): string =>
  `<${AUTOFIX_RESULT_TAG}>
  <pr-number>42</pr-number>
  <commits-pushed>
    <commit sha="abc123">${summary}</commit>
  </commits-pushed>
  <ci-status>green</ci-status>
  <summary>${summary}</summary>
</${AUTOFIX_RESULT_TAG}>`

describe('extractAutofixResultFromLog', () => {
  test('returns null on empty log', () => {
    expect(extractAutofixResultFromLog([])).toBeNull()
  })

  test('returns null when no tag present', () => {
    const log = [
      assistantTextMessage('just some normal text without the tag'),
      hookProgressMessage('hook output without tag'),
    ]
    expect(extractAutofixResultFromLog(log)).toBeNull()
  })

  test('extracts from hook stdout', () => {
    const tag = sampleTag('fixed lint error')
    const log = [hookProgressMessage(`prefix\n${tag}\nsuffix`)]
    const result = extractAutofixResultFromLog(log)
    expect(result).toBe(tag)
  })

  test('extracts from assistant text', () => {
    const tag = sampleTag('typecheck fixed')
    const log = [assistantTextMessage(`Done!\n${tag}`)]
    expect(extractAutofixResultFromLog(log)).toBe(tag)
  })

  test('extracts from hook_response subtype too', () => {
    const tag = sampleTag('via hook_response')
    const log = [
      {
        type: 'system',
        subtype: 'hook_response',
        stdout: tag,
      } as unknown as SDKMessage,
    ]
    expect(extractAutofixResultFromLog(log)).toBe(tag)
  })

  test('returns the latest tag when multiple appear in different messages', () => {
    const older = sampleTag('older attempt')
    const newer = sampleTag('newer attempt')
    const log = [
      assistantTextMessage(`first try\n${older}`),
      assistantTextMessage(`retry\n${newer}`),
    ]
    expect(extractAutofixResultFromLog(log)).toBe(newer)
  })

  test('returns null when open tag exists but close tag is missing (truncated)', () => {
    const log = [
      assistantTextMessage(
        `<${AUTOFIX_RESULT_TAG}>\n<summary>got cut off mid-write...`,
      ),
    ]
    expect(extractAutofixResultFromLog(log)).toBeNull()
  })

  test('returns earlier complete tag when latest open tag is truncated within the same block', () => {
    // 重试场景：先输出了一个完整 result，随后又起了第二个 result 标签但被截断。
    // 应当输出更早的完整对，而不是把整块丢掉。
    const complete = sampleTag('earlier complete result')
    const truncated = `<${AUTOFIX_RESULT_TAG}>\n<summary>truncated retry...`
    const log = [assistantTextMessage(`${complete}\n${truncated}`)]
    expect(extractAutofixResultFromLog(log)).toBe(complete)
  })

  test('walks backwards so hook stdout from later in log wins over earlier assistant text', () => {
    const earlier = sampleTag('via assistant first')
    const later = sampleTag('via hook later')
    const log = [
      assistantTextMessage(`some output\n${earlier}`),
      hookProgressMessage(later),
    ]
    expect(extractAutofixResultFromLog(log)).toBe(later)
  })

  test('ignores tag-shaped strings that span across messages (no concatenation)', () => {
    // 开标签在一条消息里、闭标签在另一条消息里 —— 不应该被拼接。
    const log = [
      assistantTextMessage(`<${AUTOFIX_RESULT_TAG}>\n<summary>part 1`),
      assistantTextMessage(`part 2</summary>\n</${AUTOFIX_RESULT_TAG}>`),
    ]
    expect(extractAutofixResultFromLog(log)).toBeNull()
  })

  test('extracts when assistant content is a string (not block array)', () => {
    // 某些 SDK 路径会把 assistant content 以裸字符串形式输出，而不是
    // content-block 数组。当前实现会跳过这些 —— 验证优雅无操作、不崩溃。
    const log = [
      {
        type: 'assistant',
        message: { content: sampleTag('string content') },
      } as unknown as SDKMessage,
    ]
    expect(extractAutofixResultFromLog(log)).toBeNull()
  })
})
