/**
 * queryModelWrappers 调试 harness（真实 API 调用版）
 * ──────────────────────────────────────────────────────────────────────────
 * 目的：不启动整个 CLI，直接 debug 运行 `src/services/api/claude.ts` 里的两个
 *      包装层入口——`queryModelWithStreaming`（claude.ts:1022，流式）和
 *      `queryModelWithoutStreaming`（claude.ts:963，非流式），并能自己调整每次
 *      调用传入的参数，对照包装层 5 小节逐段观察。
 *
 * 与隔壁 `queryModel/_debug/harness.ts` 的关系：
 *   bootstrap 前奏（MACRO 注入 / feature mock / enableConfigs /
 *   applySafeConfigEnvironmentVariables / 默认 sonnet 模型）与它**完全一致**。
 *   差别只在本 harness 同时暴露 **streaming + nonstreaming** 两个入口，
 *   且 nonstreaming 支持传入「已 abort 的 signal」观察 APIUserAbortError 分支。
 *
 * 运行方式（用 bun run，不要用 bun test）：
 *   bun run "docs/.../queryModelWrappers/[N]<name>/debug.isolated.ts"
 *   然后在 VS Code「🔬 Debug …当前分节文件 (.isolated.ts)」或 chrome://inspect 接入。
 *
 * 为什么 bun run 而非 bun test：
 *   `bun run` 下 NODE_ENV 不为 'test' → vcr.ts:27 的 shouldUseVCR() 返回 false
 *   → 真实执行而非录/放跳过。`[3]vcr-layer` 一节用 env.FORCE_VCR 显式打开 VCR。
 *
 * ⚠️ 真实计费：每次运行都消耗真实 token。默认用便宜模型 + 小输出。
 */
import { mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ── 0. 注入构建期 MACRO 定义（正常由 dev.ts/build.ts 的 -d/define 注入）─────
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

// ── 1. feature 开关（必须在 import claude.ts 之前定好）──────────────────────
const enabledFeatures = new Set<string>()

/** 在调用 run* 之前声明本节需要点亮的 feature flag。 */
export function setFeatures(names: string[]): void {
  enabledFeatures.clear()
  for (const n of names) enabledFeatures.add(n)
}

// claude.ts 在模块加载时就会读 feature('TRANSCRIPT_CLASSIFIER')（claude.ts:120），
// 所以这个 mock 必须在 harness 模块体里同步注册（早于下方的动态 import）。
mock.module('bun:bundle', () => ({
  feature: (name: string) => enabledFeatures.has(name),
}))

// ── 2. 入参默认值 ───────────────────────────────────────────────────────────
export type RunOverrides = {
  /** user 消息文本（默认一句短话，省 token）。 */
  prompt?: string
  /** 直接覆盖 messages（优先级高于 prompt）。 */
  messages?: unknown[]
  /** 系统提示词数组。 */
  system?: string[]
  /** 思考预算配置，默认关闭。 */
  thinkingConfig?: unknown
  /** 工具列表（[5]helpers 可传带 media 的消息观察 schema 构建）。 */
  tools?: unknown[]
  /** 需要点亮的 feature flag（等价于先调 setFeatures）。 */
  features?: string[]
  /** 本次运行前临时设置的环境变量（运行后自动还原）。 */
  env?: Record<string, string | undefined>
  /** 覆盖 options 的任意字段（与默认 options 浅合并）。 */
  options?: Record<string, unknown>
  /** 自定义 AbortSignal——传一个已 abort() 的 signal 看 nonstreaming 的中止分支。 */
  signal?: AbortSignal
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

/** 完成 bootstrap 并构造一次调用所需的全部参数（streaming/nonstreaming 共用）。 */
async function buildCallArgs(overrides: RunOverrides) {
  const { asSystemPrompt } = await import('src/utils/systemPromptType.js')
  const { getEmptyToolPermissionContext } = await import('src/Tool.js')

  // 正常由 CLI init 流程开启；standalone 运行需手动放行配置读取。
  const { enableConfigs } = await import('src/utils/config.js')
  enableConfigs()

  // 把 ~/.hclaude/settings.json 的 `env` 块应用到 process.env——鉴权据此解析。
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

  const { getDefaultSonnetModel } = await import('src/utils/model/model.js')
  const options = {
    getToolPermissionContext: async () => getEmptyToolPermissionContext(),
    model: getDefaultSonnetModel(),
    isNonInteractiveSession: true,
    querySource: 'repl_main_thread',
    agents: [],
    mcpTools: [],
    hasAppendSystemPrompt: false,
    maxOutputTokensOverride: 128,
    ...overrides.options,
  }

  return {
    messages: messages as never[],
    systemPrompt,
    thinkingConfig: thinkingConfig as never,
    tools: (overrides.tools ?? []) as never[],
    signal: overrides.signal ?? new AbortController().signal,
    options: options as never,
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

export type RunResult = {
  assistantMessages: any[]
  streamEvents: any[]
  errors: any[]
}

// ── 3a. 流式入口（[1]streaming-wrapper / [4]fallback / [5]helpers 用）──────────
/**
 * 真实调用 `queryModelWithStreaming`，消费异步生成器，按 yield 类型分桶返回。
 */
export async function runStreaming(
  overrides: RunOverrides = {},
): Promise<RunResult> {
  if (overrides.features) setFeatures(overrides.features)
  const restoreEnv = applyEnv(overrides.env)
  try {
    const { queryModelWithStreaming } = await import(
      'src/services/api/claude.js'
    )
    const args = await buildCallArgs(overrides)
    const result: RunResult = {
      assistantMessages: [],
      streamEvents: [],
      errors: [],
    }
    console.error(
      `\n[harness] → queryModelWithStreaming  model=${args.options.model} source=${args.options.querySource} features=[${[...enabledFeatures].join(',')}]`,
    )
    for await (const item of queryModelWithStreaming(args)) {
      switch (item.type) {
        case 'assistant': {
          result.assistantMessages.push(item)
          const content = (item as any).message?.content
          const stopReason = (item as any).message?.stop_reason
          const preview =
            typeof content === 'string'
              ? content
              : JSON.stringify(content)?.slice(0, 200)
          console.error(`[harness] assistant  stop=${stopReason}  ${preview}`)
          break
        }
        case 'stream_event': {
          result.streamEvents.push(item)
          console.error(
            `[harness]   stream_event  ${(item as any).event?.type}`,
          )
          break
        }
        default: {
          result.errors.push(item)
          console.error(
            `[harness] other(${(item as any).type})  ${JSON.stringify(item)?.slice(0, 200)}`,
          )
        }
      }
    }
    console.error(
      `[harness] ← streaming done  assistant=${result.assistantMessages.length} events=${result.streamEvents.length} errors=${result.errors.length}\n`,
    )
    return result
  } finally {
    restoreEnv()
  }
}

// ── 3b. 非流式入口（[2]nonstreaming-wrapper 用）──────────────────────────────
/**
 * 真实调用 `queryModelWithoutStreaming`，返回单条 AssistantMessage。
 * 传 overrides.signal = 已 abort 的 signal 可观察 claude.ts:1002 的
 * APIUserAbortError 分支（此时会抛出而非返回）。
 */
export async function runNonStreaming(
  overrides: RunOverrides = {},
): Promise<any> {
  if (overrides.features) setFeatures(overrides.features)
  const restoreEnv = applyEnv(overrides.env)
  try {
    const { queryModelWithoutStreaming } = await import(
      'src/services/api/claude.js'
    )
    const args = await buildCallArgs(overrides)
    console.error(
      `\n[harness] → queryModelWithoutStreaming  model=${args.options.model} aborted=${args.signal.aborted}`,
    )
    try {
      const assistant = await queryModelWithoutStreaming(args)
      const content = (assistant as any)?.message?.content
      const preview =
        typeof content === 'string'
          ? content
          : JSON.stringify(content)?.slice(0, 200)
      console.error(
        `[harness] ← nonstreaming done  stop=${(assistant as any)?.message?.stop_reason}  ${preview}\n`,
      )
      return assistant
    } catch (e) {
      console.error(
        `[harness] ← nonstreaming threw  ${(e as Error)?.name}: ${(e as Error)?.message}\n`,
      )
      throw e
    }
  } finally {
    restoreEnv()
  }
}
