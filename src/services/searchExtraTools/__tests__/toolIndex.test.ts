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
}))

const {
  parseToolName,
  buildToolIndex,
  searchTools,
  getToolIndex,
  clearToolIndexCache,
} = await import('../toolIndex.js')

type MockTool = {
  name: string
  alwaysLoad?: boolean
  isMcp?: boolean
  shouldDefer?: boolean
  searchHint?: string
  prompt: () => Promise<string>
  inputJSONSchema?: object
  inputSchema?: unknown
}

function makeMockTool(overrides: Partial<MockTool> = {}): MockTool {
  return {
    name: 'TestTool',
    isMcp: false,
    shouldDefer: undefined,
    alwaysLoad: undefined,
    searchHint: undefined,
    prompt: async () => 'A test tool for testing purposes.',
    inputJSONSchema: undefined,
    inputSchema: undefined,
    ...overrides,
  }
}

describe('parseToolName', () => {
  test('解析 MCP tool 名称', () => {
    const result = parseToolName('mcp__github__create_issue')
    expect(result.isMcp).toBe(true)
    expect(result.parts).toEqual(['github', 'create', 'issue'])
  })

  test('解析内置 tool 名称', () => {
    const result = parseToolName('NotebookEditTool')
    expect(result.isMcp).toBe(false)
    expect(result.parts).toEqual(['notebook', 'edit', 'tool'])
  })

  test('解析下划线分隔的 tool 名称', () => {
    const result = parseToolName('EnterWorktreeTool')
    expect(result.isMcp).toBe(false)
    expect(result.parts).toContain('enter')
    expect(result.parts).toContain('worktree')
  })
})

describe('buildToolIndex', () => {
  test('仅对延迟 tools 构建索引', async () => {
    const tools = [
      makeMockTool({ name: 'CoreRead', alwaysLoad: true }),
      makeMockTool({
        name: 'ConfigTool',
        searchHint: 'configure settings options',
        prompt: async () => 'Manage configuration settings.',
      }),
      makeMockTool({
        name: 'CronCreateTool',
        searchHint: 'schedule recurring prompt',
        prompt: async () => 'Create cron jobs for scheduling.',
      }),
    ] as unknown as import('../../../Tool.js').Tool[]

    const index = await buildToolIndex(tools)
    // 只有非核心、非 alwaysLoad 的 tools 才应被索引
    expect(index.length).toBe(2)
    for (const entry of index) {
      expect(entry.tokens.length).toBeGreaterThan(0)
      expect(entry.tfVector.size).toBeGreaterThan(0)
    }
  })

  test('所有 tools 均为核心 tools 时返回空数组', async () => {
    const tools = [
      makeMockTool({ name: 'Read', alwaysLoad: true }),
      makeMockTool({ name: 'Edit', alwaysLoad: true }),
    ] as unknown as import('../../../Tool.js').Tool[]

    const index = await buildToolIndex(tools)
    expect(index.length).toBe(0)
  })
})

describe('searchTools', () => {
  test('找到与 query 匹配的 tools', async () => {
    const tools = [
      makeMockTool({
        name: 'CronCreateTool',
        searchHint: 'schedule a recurring or one-shot prompt',
        prompt: async () => 'Create cron jobs for scheduling tasks.',
      }),
      makeMockTool({
        name: 'ConfigTool',
        searchHint: 'configure settings options',
        prompt: async () => 'Manage configuration settings.',
      }),
    ] as unknown as import('../../../Tool.js').Tool[]

    const index = await buildToolIndex(tools)
    const results = searchTools('schedule cron job', index)
    expect(results.length).toBeGreaterThan(0)
    // 对于 "schedule cron job"，CronCreateTool 应排名最高
    expect(results[0]!.name).toBe('CronCreateTool')
    expect(results[0]!.score).toBeGreaterThan(0)
  })

  test('query 为空时返回空数组', async () => {
    const tools = [
      makeMockTool({
        name: 'ConfigTool',
        prompt: async () => 'Manage configuration.',
      }),
    ] as unknown as import('../../../Tool.js').Tool[]

    const index = await buildToolIndex(tools)
    expect(searchTools('', index)).toEqual([])
  })

  test('无 tools 匹配时返回空数组', async () => {
    const tools = [
      makeMockTool({
        name: 'ConfigTool',
        prompt: async () => 'Manage configuration settings.',
      }),
    ] as unknown as import('../../../Tool.js').Tool[]

    const index = await buildToolIndex(tools)
    const results = searchTools('quantum physics entanglement', index)
    expect(results).toEqual([])
  })

  test('CJK 分词产生 bigram', async () => {
    // 验证 CJK 文本被分词为 bigram（委托给 localSearch.tokenize）
    const { tokenizeAndStem } = await import('../../skillSearch/localSearch.js')
    const tokens = tokenizeAndStem('搜索代码')
    expect(tokens).toContain('搜索')
    expect(tokens).toContain('代码')
  })
})

describe('getToolIndex 缓存行为', () => {
  beforeEach(() => {
    clearToolIndexCache()
  })

  test('相同 tool 列表时返回缓存的索引', async () => {
    const tools = [
      makeMockTool({
        name: 'ConfigTool',
        prompt: async () => 'Manage configuration.',
      }),
    ] as unknown as import('../../../Tool.js').Tool[]

    const first = await getToolIndex(tools)
    const second = await getToolIndex(tools)
    expect(first).toBe(second) // 相同引用 = 已缓存
  })

  test('调用 clearToolIndexCache 后重新构建索引', async () => {
    const tools = [
      makeMockTool({
        name: 'ConfigTool',
        prompt: async () => 'Manage configuration.',
      }),
    ] as unknown as import('../../../Tool.js').Tool[]

    const first = await getToolIndex(tools)
    clearToolIndexCache()
    const second = await getToolIndex(tools)
    expect(first).not.toBe(second) // 不同引用 = 已重建
  })
})
