/**
 * query() 调试 harness（真实 API 调用 + 真实回合循环版）
 * ──────────────────────────────────────────────────────────────────────────
 * 目的：不启动整个 CLI，直接 debug 运行 `src/query.ts` 里的 `query()`（query.ts:359）。
 *      `query()` 经 `yield*` 委托内部的 `queryLoop()`（query.ts:540），所以**一次运行
 *      同时穿过 query 与 queryLoop 两者**——queryLoop 系列也复用本 harness。
 *
 * bootstrap 前奏（MACRO 注入 / feature mock / enableConfigs /
 * applySafeConfigEnvironmentVariables / 默认 sonnet 模型）与 queryModel/queryModelWrappers
 * 的 harness **完全一致**。差别在于 query() 需要一个完整的 QueryParams（含 ToolUseContext），
 * 由 buildToolUseContext() 组装最小可用实例。
 *
 * ⚠️ 真实工具副作用 + 真实计费：
 *   默认 canUseTool **自动放行所有工具**，且跑真实完整回合——模型发 tool_use 时会
 *   **真实执行工具（含 Bash 命令 / 写文件）**。已用 maxTurns:3 + maxOutputTokensOverride:128
 *   + 短 prompt 收窄。调试时保持小输入。
 *
 * 运行（bun run，不要 bun test）：
 *   bun run "docs/.../query-ts/query/[N]<name>/debug.isolated.ts"
 */
import { mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ── 0. 注入构建期 MACRO 定义 ─────────────────────────────────────────────────
{
  const g = globalThis as Record<string, unknown>
  if (typeof g.MACRO === 'undefined') {
    let version = '0.0.0-debug'
    try {
      version = JSON.parse(
        readFileSync(join(process.cwd(), 'package.json'), 'utf-8'),
      ).version
    } catch {
      /* 退回占位版本 */
    }
    g.MACRO = {
      VERSION: version,
      BUILD_TIME: new Date().toISOString(),
      FEEDBACK_CHANNEL: '',
      ISSUES_EXPLAINER: '',
      NATIVE_PACKAGE_URL: '',
      PACKAGE_URL: '',
      VERSION_CHANGELOG: '',
    }
  }
  if (typeof g.HOOK_TIMING_DISPLAY_THRESHOLD_MS === 'undefined') {
    g.HOOK_TIMING_DISPLAY_THRESHOLD_MS = 500
  }
}

// ── 1. feature 开关（必须在 import query.ts 之前定好）────────────────────────
const enabledFeatures = new Set<string>()

/** 在调用 runQuery 之前声明本节需要点亮的 feature flag。 */
export function setFeatures(names: string[]): void {
  enabledFeatures.clear()
  for (const n of names) enabledFeatures.add(n)
}

mock.module('bun:bundle', () => ({
  feature: (name: string) => enabledFeatures.has(name),
}))

// ── 2. 入参默认值 ───────────────────────────────────────────────────────────
export type RunQueryOverrides = {
  /** user 消息文本（默认一句短话，省 token）。 */
  prompt?: string
  /** 直接覆盖 messages（优先级高于 prompt）。 */
  messages?: unknown[]
  /** 系统提示词数组。 */
  system?: string[]
  /** 思考预算配置，默认关闭。 */
  thinkingConfig?: unknown
  /** 工具列表。默认 getTools(空权限上下文) 全量，便于触发工具执行。传 [] 可禁工具。 */
  tools?: unknown[]
  /** 循环最大轮数，默认 3（有界，防真实工具循环失控）。 */
  maxTurns?: number
  /** 需要点亮的 feature flag。 */
  features?: string[]
  /** 本次运行前临时设置的环境变量（运行后自动还原）。 */
  env?: Record<string, string | undefined>
  /** 浅合并任意 QueryParams 字段（如 fallbackModel / taskBudget / deps）。 */
  paramsOverride?: Record<string, unknown>
  /** 浅合并 toolUseContext 字段（如 [3] 注入 langfuseTrace）。 */
  toolUseContextOverride?: Record<string, unknown>
  /** 浅合并 toolUseContext.options 字段（如 mainLoopModel=无效模型触发 throw）。 */
  optionsOverride?: Record<string, unknown>
  /** 跑到第 N 个 yield 后调 gen.return()，专供 [7] 观察 .return() 出口。 */
  closeAfterYields?: number
}

/** 构造一条最小可用的 UserMessage 字面量。 */
function buildUserMessage(text: string): Record<string, unknown> {
  return {
    type: 'user',
    uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: text },
  }
}

/** 应用临时 env，返回还原函数。 */
function applyEnv(env?: Record<string, string | undefined>): () => void {
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(env ?? {})) {
    saved[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

/**
 * 组装一个最小可用的 ToolUseContext（src/Tool.ts:160）。
 * 只填 query/queryLoop 真正会访问的字段，其余 setter 用 no-op。
 */
async function buildToolUseContext(
  messages: unknown[],
  thinkingConfig: unknown,
  overrides: RunQueryOverrides,
): Promise<Record<string, unknown>> {
  const { getEmptyToolPermissionContext } = await import('src/Tool.js')
  const { getTools } = await import('src/tools.js')
  const { getDefaultAppState } = await import('src/state/AppStateStore.js')
  const { FileStateCache } = await import('src/utils/fileStateCache.js')
  const { getDefaultSonnetModel } = await import('src/utils/model/model.js')

  const permCtx = getEmptyToolPermissionContext()
  const tools = overrides.tools ?? getTools(permCtx)

  // 可变 AppState 闭包：从默认状态起步，setAppState 真实更新它。
  let appState = getDefaultAppState()

  const options = {
    commands: [],
    debug: false,
    mainLoopModel: getDefaultSonnetModel(),
    tools,
    verbose: false,
    thinkingConfig,
    mcpClients: [],
    mcpResources: {},
    isNonInteractiveSession: true,
    agentDefinitions: { activeAgents: [], allAgents: [] },
    ...overrides.optionsOverride,
  }

  return {
    options,
    abortController: new AbortController(),
    readFileState: new FileStateCache(500, 50 * 1024 * 1024),
    getAppState: () => appState,
    setAppState: (f: (prev: unknown) => unknown) => {
      appState = f(appState) as typeof appState
    },
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    messages,
    ...overrides.toolUseContextOverride,
  }
}

export type RunQueryResult = {
  streamEvents: any[]
  assistantMessages: any[]
  toolResults: any[]
  others: any[]
  terminal: any
}

// ── 3. 主入口 ───────────────────────────────────────────────────────────────
/**
 * 真实调用 query()，手动驱动生成器（for-await 拿不到 return 值，而 query() 的
 * 精华正是 finally 善后 + 返回的 Terminal），按 yield 类型分桶，最后打印 terminal。
 */
export async function runQuery(
  overrides: RunQueryOverrides = {},
): Promise<RunQueryResult> {
  if (overrides.features) setFeatures(overrides.features)
  const restoreEnv = applyEnv(overrides.env)
  try {
    const { query } = await import('src/query.js')
    const { asSystemPrompt } = await import('src/utils/systemPromptType.js')

    // standalone 放行配置读取 + 应用 settings.json env（鉴权据此解析）。
    const { enableConfigs } = await import('src/utils/config.js')
    enableConfigs()
    const { applySafeConfigEnvironmentVariables } = await import(
      'src/utils/managedEnv.js'
    )
    applySafeConfigEnvironmentVariables()

    const messages = overrides.messages ?? [
      buildUserMessage(overrides.prompt ?? 'Reply with a single word: ok'),
    ]
    const systemPrompt = asSystemPrompt(
      overrides.system ?? ['You are a concise assistant.'],
    )
    const thinkingConfig = overrides.thinkingConfig ?? { type: 'disabled' }

    const toolUseContext = await buildToolUseContext(
      messages,
      thinkingConfig,
      overrides,
    )

    const params = {
      messages,
      systemPrompt,
      userContext: {},
      systemContext: {},
      // 自动放行所有工具（⚠️ 真实执行工具副作用）
      canUseTool: async (_tool: unknown, input: unknown) => ({
        behavior: 'allow',
        updatedInput: input,
      }),
      toolUseContext,
      querySource: 'repl_main_thread',
      maxTurns: overrides.maxTurns ?? 3,
      maxOutputTokensOverride: 128,
      ...overrides.paramsOverride,
    }

    const result: RunQueryResult = {
      streamEvents: [],
      assistantMessages: [],
      toolResults: [],
      others: [],
      terminal: undefined,
    }

    console.error(
      `\n[harness] → query  model=${(toolUseContext.options as any).mainLoopModel} maxTurns=${params.maxTurns} tools=${(toolUseContext.options as any).tools.length} features=[${[...enabledFeatures].join(',')}]`,
    )

    const gen = query(params as any)
    let count = 0
    let r = await gen.next()
    while (!r.done) {
      const item: any = r.value
      count++
      switch (item?.type) {
        case 'stream_event':
          result.streamEvents.push(item)
          console.error(`[harness]   stream_event  ${item.event?.type}`)
          break
        case 'assistant': {
          result.assistantMessages.push(item)
          const content = item.message?.content
          const preview =
            typeof content === 'string'
              ? content
              : JSON.stringify(content)?.slice(0, 160)
          console.error(
            `[harness] assistant  stop=${item.message?.stop_reason}  ${preview}`,
          )
          break
        }
        case 'user':
          result.toolResults.push(item)
          console.error(`[harness] tool_result/user`)
          break
        default:
          result.others.push(item)
          console.error(
            `[harness] other(${item?.type})  ${JSON.stringify(item)?.slice(0, 160)}`,
          )
      }
      // [7] 专用：跑够 N 个 yield 后提前关闭 generator（触发 .return() 出口）
      if (
        overrides.closeAfterYields !== undefined &&
        count >= overrides.closeAfterYields
      ) {
        console.error(
          `[harness] closeAfterYields=${overrides.closeAfterYields} → gen.return()（观察 .return() 出口）`,
        )
        await gen.return(undefined as never)
        break
      }
      r = await gen.next()
    }
    if (r.done) result.terminal = r.value

    console.error(
      `[harness] ← query done  terminal.reason=${result.terminal?.reason ?? '(closed early / none)'} events=${result.streamEvents.length} assistant=${result.assistantMessages.length} toolResults=${result.toolResults.length}\n`,
    )
    return result
  } finally {
    restoreEnv()
  }
}
