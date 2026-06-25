import { describe, test, expect, beforeEach } from 'bun:test'
import { mock } from 'bun:test'
import { logMock } from '../../../../tests/mocks/log'
import { debugMock } from '../../../../tests/mocks/debug'

mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)
mock.module('src/services/analytics/growthbook.js', () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: () => false,
  checkStatsigFeatureGate_CACHED_MAY_BE_STALE: () => false,
  getFeatureValue_DEPRECATED: async () => undefined,
  getFeatureValue_CACHED_WITH_REFRESH: async () => undefined,
  hasGrowthBookEnvOverride: () => false,
  getAllGrowthBookFeatures: () => ({}),
  getGrowthBookConfigOverrides: () => ({}),
  setGrowthBookConfigOverride: () => {},
  clearGrowthBookConfigOverrides: () => {},
  getApiBaseUrlHost: () => undefined,
  onGrowthBookRefresh: () => {},
  initializeGrowthBook: async () => {},
  checkSecurityRestrictionGate: async () => false,
  checkGate_CACHED_OR_BLOCKING: async () => false,
  refreshGrowthBookAfterAuthChange: () => {},
  resetGrowthBook: () => {},
  refreshGrowthBookFeatures: async () => {},
  setupPeriodicGrowthBookRefresh: () => {},
  stopPeriodicGrowthBookRefresh: () => {},
  getDynamicConfig_CACHED_MAY_BE_STALE: () => undefined,
  getDynamicConfig_BLOCKS_ON_INIT: async () => undefined,
}))

// Mock skillSearch/prefetch.js（searchExtraTools/prefetch.ts 的依赖）
mock.module('src/services/skillSearch/prefetch.js', () => ({
  extractQueryFromMessages: (
    _input: string | null,
    messages: { type: string; content: unknown }[],
  ) => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]!
      if (msg.type !== 'user') continue
      const content = msg.content
      if (typeof content === 'string') return content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            block &&
            typeof block === 'object' &&
            'text' in block &&
            typeof (block as { text: unknown }).text === 'string'
          ) {
            return (block as { text: string }).text
          }
        }
      }
    }
    return ''
  },
}))

const mockGetToolIndex = mock(() => Promise.resolve([] as never[]))
const mockSearchTools = mock(() => [] as never[])

mock.module('src/services/searchExtraTools/toolIndex.js', () => ({
  getToolIndex: mockGetToolIndex,
  searchTools: mockSearchTools,
  clearToolIndexCache: () => {},
  buildToolIndex: async () => [],
  parseToolName: (name: string) => ({
    parts: name.toLowerCase().split('_'),
    full: name.toLowerCase(),
    isMcp: name.startsWith('mcp__'),
  }),
}))

const {
  startSearchExtraToolsPrefetch,
  getTurnZeroSearchExtraToolsPrefetch,
  collectSearchExtraToolsPrefetch,
  buildToolDiscoveryAttachment,
} = await import('../prefetch.js')

function makeMockMessages(text: string) {
  return [
    {
      type: 'user',
      content: [{ type: 'text', text }],
      uuid: 'test-uuid',
    },
  ] as never
}

describe('startSearchExtraToolsPrefetch', () => {
  beforeEach(() => {
    mockGetToolIndex.mockResolvedValue([
      { name: 'index-entry', tokens: ['test'], tfVector: new Map() },
    ] as never)
    mockSearchTools.mockReturnValue([])
  })

  test('对匹配的 tools 返回 tool_discovery attachment', async () => {
    mockSearchTools.mockReturnValue([
      {
        name: 'CronCreateTool',
        description: 'Create cron jobs',
        searchHint: 'schedule recurring',
        score: 0.5,
        isMcp: false,
        isDeferred: true,
        inputSchema: undefined,
      },
    ] as never)

    const result = await startSearchExtraToolsPrefetch(
      [],
      makeMockMessages('schedule a cron job'),
    )
    expect(result).toHaveLength(1)
    expect(result[0]!.type).toBe('tool_discovery')
    expect((result[0] as Record<string, unknown>).trigger).toBe(
      'assistant_turn',
    )
    expect((result[0] as Record<string, unknown>).tools).toBeDefined()
  })

  test('query 为空时返回空数组', async () => {
    const result = await startSearchExtraToolsPrefetch([], [
      { type: 'assistant', content: [] },
    ] as never)
    expect(result).toEqual([])
  })

  test('无 tools 匹配时返回空数组', async () => {
    mockSearchTools.mockReturnValue([])
    const result = await startSearchExtraToolsPrefetch(
      [],
      makeMockMessages('quantum physics'),
    )
    expect(result).toEqual([])
  })

  test('发生异常时返回空数组（异常安全）', async () => {
    mockGetToolIndex.mockRejectedValue(new Error('index failed'))
    const result = await startSearchExtraToolsPrefetch(
      [],
      makeMockMessages('test'),
    )
    expect(result).toEqual([])
  })
})

describe('getTurnZeroSearchExtraToolsPrefetch', () => {
  // 第零轮用户输入工具推荐已禁用，以避免频繁弹窗。
  // 无论输入或匹配状态如何，所有情况均返回 null。
  test('返回 null（功能已禁用）', async () => {
    mockGetToolIndex.mockResolvedValue([
      { name: 'index-entry', tokens: ['test'], tfVector: new Map() },
    ] as never)
    mockSearchTools.mockReturnValue([
      {
        name: 'CronCreateTool',
        description: 'Create cron jobs',
        searchHint: 'schedule recurring',
        score: 0.5,
        isMcp: false,
        isDeferred: true,
        inputSchema: undefined,
      },
    ] as never)

    const result = await getTurnZeroSearchExtraToolsPrefetch(
      'schedule cron job',
      [],
    )
    expect(result).toBeNull()
  })

  test('输入为空时返回 null', async () => {
    const result = await getTurnZeroSearchExtraToolsPrefetch('', [])
    expect(result).toBeNull()
  })

  test('无 tools 匹配时返回 null', async () => {
    mockSearchTools.mockReturnValue([])
    const result = await getTurnZeroSearchExtraToolsPrefetch(
      'quantum physics',
      [],
    )
    expect(result).toBeNull()
  })
})

describe('collectSearchExtraToolsPrefetch', () => {
  test('返回已 resolve 的 attachment 数组', async () => {
    const attachment = {
      type: 'tool_discovery' as const,
      tools: [],
      trigger: 'assistant_turn' as const,
      queryText: 'test',
      durationMs: 10,
      indexSize: 5,
    }
    const result = await collectSearchExtraToolsPrefetch(
      Promise.resolve([
        attachment,
      ] as unknown as import('../../../utils/attachments.js').Attachment[]),
    )
    expect(result).toHaveLength(1)
    expect(result[0]!.type).toBe('tool_discovery')
  })

  test('promise rejected 时返回空数组', async () => {
    const result = await collectSearchExtraToolsPrefetch(
      Promise.reject(new Error('fail')),
    )
    expect(result).toEqual([])
  })
})

describe('buildToolDiscoveryAttachment', () => {
  test('返回包含所有必填字段的 attachment', () => {
    const tools = [
      {
        name: 'TestTool',
        description: 'A test tool',
        searchHint: 'test',
        score: 0.5,
        isMcp: false,
        isDeferred: true,
        inputSchema: undefined,
      },
    ]
    const attachment = buildToolDiscoveryAttachment(
      tools,
      'user_input',
      'test query',
      10,
      5,
    )
    const att = attachment as Record<string, unknown>
    expect(att.type).toBe('tool_discovery')
    expect(att.tools).toBe(tools)
    expect(att.trigger).toBe('user_input')
    expect(att.queryText).toBe('test query')
    expect(att.durationMs).toBe(10)
    expect(att.indexSize).toBe(5)
  })
})
