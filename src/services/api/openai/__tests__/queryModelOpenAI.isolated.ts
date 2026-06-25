/**
 * index.ts 中 queryModelOpenAI 的测试。
 *
 * 专注于已修复的两个 bug：
 *  1. 组装后的 AssistantMessage 中 stop_reason 始终为 null，因为
 *     partialMessage（来自 message_start）的 stop_reason 为 null，而从
 *     message_delta 捕获的 stop_reason 从未被应用。
 *  2. message_stop 后 partialMessage 未被重置为 null，导致循环末尾的安全
 *     兜底路径会再次 yield 一个相同的 AssistantMessage（使下次 API 请求中的
 *     内容重复出现）。
 *
 * 策略：mock getOpenAIClient + adaptOpenAIStreamToAnthropic，直接将预先构造
 * 好的 Anthropic 事件传入 queryModelOpenAI，并检查其输出——无任何真实 HTTP 调用。
 */
import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test'
import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type {
  AssistantMessage,
  StreamEvent,
} from '../../../../types/message.js'

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

/** 构建最简 message_start 事件 */
function makeMessageStart(
  overrides: Record<string, any> = {},
): BetaRawMessageStreamEvent {
  return {
    type: 'message_start',
    message: {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'test-model',
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      ...overrides,
    },
  } as any
}

/** 为指定 block 类型构建 content_block_start 事件 */
function makeContentBlockStart(
  index: number,
  type: 'text' | 'tool_use' | 'thinking',
  extra: Record<string, any> = {},
): BetaRawMessageStreamEvent {
  const block =
    type === 'text'
      ? { type: 'text', text: '' }
      : type === 'tool_use'
        ? { type: 'tool_use', id: 'toolu_test', name: 'bash', input: {} }
        : { type: 'thinking', thinking: '', signature: '' }
  return {
    type: 'content_block_start',
    index,
    content_block: { ...block, ...extra },
  } as any
}

/** 构建 text_delta 类型的 content_block_delta 事件 */
function makeTextDelta(index: number, text: string): BetaRawMessageStreamEvent {
  return {
    type: 'content_block_delta',
    index,
    delta: { type: 'text_delta', text },
  } as any
}

/** 构建 input_json_delta 类型的 content_block_delta 事件 */
function makeInputJsonDelta(
  index: number,
  json: string,
): BetaRawMessageStreamEvent {
  return {
    type: 'content_block_delta',
    index,
    delta: { type: 'input_json_delta', partial_json: json },
  } as any
}

/** 构建 thinking_delta 类型的 content_block_delta 事件 */
function makeThinkingDelta(
  index: number,
  thinking: string,
): BetaRawMessageStreamEvent {
  return {
    type: 'content_block_delta',
    index,
    delta: { type: 'thinking_delta', thinking },
  } as any
}

/** 构建 content_block_stop 事件 */
function makeContentBlockStop(index: number): BetaRawMessageStreamEvent {
  return { type: 'content_block_stop', index } as any
}

/** 构建携带 stop_reason 和 output_tokens 的 message_delta 事件 */
function makeMessageDelta(
  stopReason: string,
  outputTokens: number,
): BetaRawMessageStreamEvent {
  return {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  } as any
}

/** 构建 message_stop 事件 */
function makeMessageStop(): BetaRawMessageStreamEvent {
  return { type: 'message_stop' } as any
}

/** 从固定事件数组生成的异步生成器 */
async function* eventStream(events: BetaRawMessageStreamEvent[]) {
  for (const e of events) yield e
}

/** 将 queryModelOpenAI 的所有输出按类型收集到各桶中 */
async function runQueryModel(
  events: BetaRawMessageStreamEvent[],
  envOverrides: Record<string, string | undefined> = {},
) {
  // 将事件接入 mocked 流适配器
  _nextEvents = events
  // 保存并应用环境变量覆盖
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(envOverrides)) {
    saved[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }

  try {
    // 在 try 块内内联 mock.module。
    // Bun 在调用处同步解析 mock.module（提升），
    // 因此每个测试文件只注册一次，然后每次重新 import。
    const { queryModelOpenAI } = await import('../index.js')

    const assistantMessages: AssistantMessage[] = []
    const streamEvents: StreamEvent[] = []
    const otherOutputs: any[] = []

    const minimalOptions: any = {
      model: 'test-model',
      tools: [],
      agents: [],
      querySource: 'main_loop',
      getToolPermissionContext: async () => ({
        alwaysAllow: [],
        alwaysDeny: [],
        needsPermission: [],
        mode: 'default',
        isBypassingPermissions: false,
      }),
    }

    for await (const item of queryModelOpenAI(
      [],
      { type: 'text', text: '' } as any,
      [],
      new AbortController().signal,
      minimalOptions,
    )) {
      if (item.type === 'assistant') {
        assistantMessages.push(item as AssistantMessage)
      } else if (item.type === 'stream_event') {
        streamEvents.push(item as StreamEvent)
      } else {
        otherOutputs.push(item)
      }
    }

    return { assistantMessages, streamEvents, otherOutputs }
  } finally {
    // 恢复环境变量
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

// ─── mock 设置 ───────────────────────────────────────────────────────────────

// 在模块层面 mock。Bun 的 mock.module 对整个文件生效，
// 因此通过共享变量在每个测试中配置流。
let _nextEvents: BetaRawMessageStreamEvent[] = []
let _searchExtraToolsEnabled = false

/** 记录最后一次 chat.completions.create() 调用的参数 */
let _lastCreateArgs: Record<string, any> | null = null

mock.module('@ant/model-provider', () => ({
  resolveOpenAIModel: (m: string) => m,
  adaptOpenAIStreamToAnthropic: (_stream: any, _model: string) =>
    eventStream(_nextEvents),
  anthropicMessagesToOpenAI: (messages: any[]) =>
    messages.map(msg => ({
      role: msg.message?.role ?? 'user',
      content: msg.message?.content ?? '',
    })),
  anthropicToolsToOpenAI: (tools: any[]) =>
    tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description ?? '',
        parameters: tool.input_schema ?? { type: 'object', properties: {} },
      },
    })),
  anthropicToolChoiceToOpenAI: () => undefined,
}))

mock.module('../../../../utils/envUtils.js', () => ({
  isEnvTruthy: (value: string | undefined) =>
    value === '1' || value === 'true' || value === 'yes' || value === 'on',
  isEnvDefinedFalsy: (value: string | undefined) =>
    value === '0' || value === 'false' || value === 'no' || value === 'off',
}))

mock.module('../../../../services/analytics/growthbook.js', () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: (_key: string, fallback: unknown) =>
    fallback,
}))

mock.module('src/bootstrap/state.js', () => ({
  isReplBridgeActive: () => false,
}))

mock.module('bun:bundle', () => ({
  feature: () => false,
}))

mock.module('../client.js', () => ({
  getOpenAIClient: () => ({
    chat: {
      completions: {
        create: async (args: Record<string, any>) => {
          _lastCreateArgs = args
          return { [Symbol.asyncIterator]: async function* () {} }
        },
      },
    },
  }),
}))

mock.module('../streamAdapter.js', () => ({
  adaptOpenAIStreamToAnthropic: (_stream: any, _model: string) =>
    eventStream(_nextEvents),
}))

mock.module('../modelMapping.js', () => ({
  resolveOpenAIModel: (m: string) => m,
}))

mock.module('../convertMessages.js', () => ({
  anthropicMessagesToOpenAI: () => [],
}))

mock.module('../convertTools.js', () => ({
  anthropicToolsToOpenAI: () => [],
  anthropicToolChoiceToOpenAI: () => undefined,
}))

mock.module('../../../../utils/context.js', () => ({
  MODEL_CONTEXT_WINDOW_DEFAULT: 200_000,
  COMPACT_MAX_OUTPUT_TOKENS: 20_000,
  CAPPED_DEFAULT_MAX_TOKENS: 8_000,
  ESCALATED_MAX_TOKENS: 64_000,
  is1mContextDisabled: () => false,
  has1mContext: () => false,
  modelSupports1M: () => false,
  getModelMaxOutputTokens: () => ({ upperLimit: 8192, default: 8192 }),
  getContextWindowForModel: () => 200_000,
  getSonnet1mExpTreatmentEnabled: () => false,
  calculateContextPercentages: () => ({
    usedPercent: 0,
    remainingPercent: 100,
  }),
  getMaxThinkingTokensForModel: () => 0,
}))

mock.module('../../../../utils/messages.js', () => ({
  normalizeMessagesForAPI: (msgs: any) => msgs,
  normalizeContentFromAPI: (blocks: any[]) => blocks,
  createUserMessage: (opts: any) => ({
    type: 'user',
    message: { role: 'user', content: opts.content },
    uuid: 'user-uuid',
    timestamp: new Date().toISOString(),
    isMeta: opts.isMeta,
  }),
  createAssistantAPIErrorMessage: (opts: any) => ({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: opts.content }],
      apiError: opts.apiError,
    },
    uuid: 'error-uuid',
    timestamp: new Date().toISOString(),
  }),
}))

mock.module('../../../../utils/api.js', () => ({
  toolToAPISchema: async (t: any) => t,
}))

mock.module('../../../../utils/searchExtraTools.js', () => ({
  isSearchExtraToolsEnabled: async () => _searchExtraToolsEnabled,
  extractDiscoveredToolNames: () => new Set(),
  isDeferredToolsDeltaEnabled: () => false,
}))

mock.module('../../../../tools/SearchExtraToolsTool/prompt.js', () => ({
  isDeferredTool: () => false,
  SEARCH_EXTRA_TOOLS_TOOL_NAME: '__tool_search__',
}))

mock.module('../../../../cost-tracker.js', () => ({
  addToTotalSessionCost: () => {},
}))

mock.module('../../../../utils/modelCost.js', () => ({
  COST_TIER_3_15: {},
  COST_TIER_15_75: {},
  COST_TIER_5_25: {},
  COST_TIER_30_150: {},
  COST_HAIKU_35: {},
  COST_HAIKU_45: {},
  getOpus46CostTier: () => ({}),
  MODEL_COSTS: {},
  getModelCosts: () => ({}),
  calculateUSDCost: () => 0,
  calculateCostFromTokens: () => 0,
  formatModelPricing: () => '',
  getModelPricingString: () => undefined,
}))

mock.module('../../../../services/langfuse/tracing.js', () => ({
  recordLLMObservation: () => {},
}))

mock.module('../../../../services/langfuse/convert.js', () => ({
  convertMessagesToLangfuse: () => [],
  convertOutputToLangfuse: () => ({}),
  convertToolsToLangfuse: () => [],
}))

mock.module('../../../../utils/debug.js', () => ({
  logForDebugging: () => {},
  logAntError: () => {},
  isDebugMode: () => false,
  isDebugToStdErr: () => false,
  getDebugFilePath: () => null,
  getDebugLogPath: () => '',
  getDebugFilter: () => null,
  getMinDebugLogLevel: () => 'debug',
  enableDebugLogging: () => false,
  setHasFormattedOutput: () => {},
  getHasFormattedOutput: () => false,
  flushDebugLogs: async () => {},
}))

// ─── 测试用例 ────────────────────────────────────────────────────────────────

describe('queryModelOpenAI — stop_reason propagation', () => {
  test('assembled AssistantMessage has stop_reason end_turn (not null)', async () => {
    _nextEvents = [
      makeMessageStart(),
      makeContentBlockStart(0, 'text'),
      makeTextDelta(0, 'Hello'),
      makeContentBlockStop(0),
      makeMessageDelta('end_turn', 10),
      makeMessageStop(),
    ]

    const { assistantMessages } = await runQueryModel(_nextEvents)

    expect(assistantMessages).toHaveLength(1)
    expect(assistantMessages[0]!.message.stop_reason).toBe('end_turn')
  })

  test('assembled AssistantMessage has stop_reason tool_use', async () => {
    _nextEvents = [
      makeMessageStart(),
      makeContentBlockStart(0, 'tool_use'),
      makeInputJsonDelta(0, '{"cmd":"ls"}'),
      makeContentBlockStop(0),
      makeMessageDelta('tool_use', 20),
      makeMessageStop(),
    ]

    const { assistantMessages } = await runQueryModel(_nextEvents)

    expect(assistantMessages).toHaveLength(1)
    expect(assistantMessages[0]!.message.stop_reason).toBe('tool_use')
  })

  test('assembled AssistantMessage has stop_reason max_tokens', async () => {
    _nextEvents = [
      makeMessageStart(),
      makeContentBlockStart(0, 'text'),
      makeTextDelta(0, 'truncated'),
      makeContentBlockStop(0),
      makeMessageDelta('max_tokens', 8192),
      makeMessageStop(),
    ]

    const { assistantMessages } = await runQueryModel(_nextEvents)

    // 两个 assistant 类型的条目：内容消息 + max_output_tokens 错误信号。
    // 错误信号由 createAssistantAPIErrorMessage 作为合成 assistant 消息发出。
    expect(assistantMessages).toHaveLength(2)
    const contentMsg = assistantMessages[0]!
    expect(contentMsg.message.stop_reason).toBe('max_tokens')
    // 第二个条目是错误信号（设有 apiError）
    const errorMsg = assistantMessages[1]!.message as any
    expect(errorMsg.apiError).toBe('max_output_tokens')
  })

  test('当未收到 message_delta 时 stop_reason 为 null（安全兜底路径）', async () => {
    // 流在没有 message_stop 的情况下结束——触发安全兜底分支。
    // 由于从未收到 message_delta，stop_reason 保持为 null。
    _nextEvents = [
      makeMessageStart(),
      makeContentBlockStart(0, 'text'),
      makeTextDelta(0, 'partial'),
      makeContentBlockStop(0),
      // 无 message_delta / message_stop
    ]

    const { assistantMessages } = await runQueryModel(_nextEvents)

    // 安全兜底应 yield 部分内容
    expect(assistantMessages).toHaveLength(1)
    expect(assistantMessages[0]!.message.stop_reason).toBeNull()
  })
})

describe('queryModelOpenAI — usage accumulation', () => {
  test('组装后消息中的 usage 应反映 message_delta 的所有四个字段', async () => {
    // message_start 中所有字段均为 0（尾块模式：usage 此时尚不可用）。
    // message_delta 在流结束后携带真实值。
    // message_delta 处理器中的展开操作必须覆盖 message_start 中的零值，
    // 包括此前 message_delta 中缺失的 cache_read_input_tokens。
    _nextEvents = [
      makeMessageStart({
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      }),
      makeContentBlockStart(0, 'text'),
      makeTextDelta(0, 'response'),
      makeContentBlockStop(0),
      // message_delta carries all four Anthropic usage fields (as emitted by the fixed streamAdapter)
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: {
          input_tokens: 30011,
          output_tokens: 190,
          cache_read_input_tokens: 19904,
          cache_creation_input_tokens: 0,
        },
      } as any,
      makeMessageStop(),
    ]

    const { assistantMessages } = await runQueryModel(_nextEvents)

    expect(assistantMessages).toHaveLength(1)
    const usage = assistantMessages[0]!.message.usage as any
    expect(usage.input_tokens).toBe(30011)
    expect(usage.output_tokens).toBe(190)
    // cache_read_input_tokens from message_delta overrides the 0 from message_start
    expect(usage.cache_read_input_tokens).toBe(19904)
    expect(usage.cache_creation_input_tokens).toBe(0)
  })

  test('usage is zero when no usage events arrive (prevents false autocompact)', async () => {
    // If usage stays 0, tokenCountWithEstimation will undercount — so at least
    // verify the field exists and is numeric (to detect regressions).
    _nextEvents = [
      makeMessageStart(),
      makeContentBlockStart(0, 'text'),
      makeTextDelta(0, 'hi'),
      makeContentBlockStop(0),
      makeMessageDelta('end_turn', 0),
      makeMessageStop(),
    ]

    const { assistantMessages } = await runQueryModel(_nextEvents)

    const usage = assistantMessages[0]!.message.usage as any
    expect(typeof usage.input_tokens).toBe('number')
    expect(typeof usage.output_tokens).toBe('number')
  })
})

describe('queryModelOpenAI — no duplicate AssistantMessage (partialMessage reset)', () => {
  test('yields exactly one AssistantMessage per message_stop when content is present', async () => {
    _nextEvents = [
      makeMessageStart(),
      makeContentBlockStart(0, 'text'),
      makeTextDelta(0, 'only once'),
      makeContentBlockStop(0),
      makeMessageDelta('end_turn', 5),
      makeMessageStop(),
    ]

    const { assistantMessages } = await runQueryModel(_nextEvents)

    // Before the fix, partialMessage was not reset to null, so the safety
    // fallback at the end of the loop would yield a second message with the
    // same message.id — causing mergeAssistantMessages to concatenate content.
    expect(assistantMessages).toHaveLength(1)
  })

  test('thinking + text response yields exactly one AssistantMessage', async () => {
    _nextEvents = [
      makeMessageStart(),
      makeContentBlockStart(0, 'thinking'),
      makeThinkingDelta(0, 'let me think'),
      makeContentBlockStop(0),
      makeContentBlockStart(1, 'text'),
      makeTextDelta(1, 'answer'),
      makeContentBlockStop(1),
      makeMessageDelta('end_turn', 30),
      makeMessageStop(),
    ]

    const { assistantMessages } = await runQueryModel(_nextEvents)

    expect(assistantMessages).toHaveLength(1)
  })

  test('safety fallback path still yields message when stream ends without message_stop', async () => {
    // Simulates a stream that cuts off without the normal termination sequence.
    _nextEvents = [
      makeMessageStart(),
      makeContentBlockStart(0, 'text'),
      makeTextDelta(0, 'abrupt end'),
      // No content_block_stop, no message_delta, no message_stop
    ]

    const { assistantMessages } = await runQueryModel(_nextEvents)

    expect(assistantMessages).toHaveLength(1)
  })
})

describe('queryModelOpenAI — stream_events forwarded', () => {
  test('every adapted event is also yielded as stream_event for real-time display', async () => {
    _nextEvents = [
      makeMessageStart(),
      makeContentBlockStart(0, 'text'),
      makeTextDelta(0, 'hello'),
      makeContentBlockStop(0),
      makeMessageDelta('end_turn', 5),
      makeMessageStop(),
    ]

    const { streamEvents } = await runQueryModel(_nextEvents)

    const eventTypes = streamEvents.map(e => (e as any).event?.type)
    expect(eventTypes).toContain('message_start')
    expect(eventTypes).toContain('content_block_start')
    expect(eventTypes).toContain('content_block_delta')
    expect(eventTypes).toContain('content_block_stop')
    expect(eventTypes).toContain('message_delta')
    expect(eventTypes).toContain('message_stop')
  })
})

describe('queryModelOpenAI — max_tokens forwarded to request', () => {
  test('buildOpenAIRequestBody includes max_tokens in the request payload', async () => {
    _nextEvents = [
      makeMessageStart(),
      makeContentBlockStart(0, 'text'),
      makeTextDelta(0, 'hi'),
      makeContentBlockStop(0),
      makeMessageDelta('end_turn', 5),
      makeMessageStop(),
    ]

    await runQueryModel(_nextEvents)

    expect(_lastCreateArgs).not.toBeNull()
    expect(_lastCreateArgs!.max_tokens).toBe(8192)
  })
})

describe('queryModelOpenAI — deferred MCP tool visibility', () => {
  test('prepends available deferred MCP tools to OpenAI messages', async () => {
    _searchExtraToolsEnabled = true
    _nextEvents = [makeMessageStart(), makeMessageStop()]

    try {
      const { queryModelOpenAI } = await import('../index.js')
      const tools: any[] = [
        {
          name: 'SearchExtraTools',
          isMcp: false,
          input_schema: { type: 'object', properties: {} },
          prompt: async () => 'Search deferred tools',
        },
        {
          name: 'mcp__wechat__send_message',
          isMcp: true,
          input_schema: { type: 'object', properties: {} },
          prompt: async () => 'Send a WeChat message',
        },
      ]

      const options: any = {
        model: 'test-model',
        tools: [],
        agents: [],
        querySource: 'main_loop',
        getToolPermissionContext: async () => ({
          alwaysAllow: [],
          alwaysDeny: [],
          needsPermission: [],
          mode: 'default',
          isBypassingPermissions: false,
        }),
      }

      for await (const _item of queryModelOpenAI(
        [],
        { type: 'text', text: '' } as any,
        tools as any,
        new AbortController().signal,
        options,
      )) {
        // Exhaust generator so request body is built.
      }

      expect(_lastCreateArgs).not.toBeNull()
      expect(JSON.stringify(_lastCreateArgs!.messages)).toContain(
        '<available-deferred-tools>\\nmcp__wechat__send_message\\n</available-deferred-tools>',
      )
    } finally {
      _searchExtraToolsEnabled = false
    }
  })
})
