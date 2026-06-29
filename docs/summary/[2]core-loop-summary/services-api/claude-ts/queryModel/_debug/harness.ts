/**
 * queryModel 调试 harness（真实 API 调用版）
 * ──────────────────────────────────────────────────────────────────────────
 * 目的：不启动整个 CLI，直接 debug 运行 `src/services/api/claude.ts` 里的
 *      `queryModel`（claude.ts:1303），并能自己调整每次调用传入的参数。
 *
 * 运行方式（用 bun run，不要用 bun test）：
 *   bun --inspect-wait run "docs/.../queryModel/[N]<name>/debug.isolated.ts"
 *   然后在 VS Code「Attach to Bun」或 chrome://inspect 接入，在 claude.ts 下断点。
 *
 * 为什么 bun run 而非 bun test：
 *   - `bun run` 下 NODE_ENV 不为 'test' → vcr.ts:27 的 shouldUseVCR() 返回 false
 *     → queryModel 每次真实执行（而非录/放跳过本体）。无需 mock vcr。
 *
 * 鉴权：完全复用你机器上现有配置（~/.hclaude）。getAnthropicClient（client.ts:83）
 *      会自动解析 OAuth token / API key——本 harness 不 mock 任何 auth/client/messages。
 *
 * 我们唯一 mock 的是 `bun:bundle` 的 feature()——因为没有 `--feature` flag 时
 * 它默认全部返回 false。用 setFeatures([...]) 在 import claude.ts 之前声明式开关。
 *
 * ⚠️ 真实计费：每次运行都消耗真实 token。默认用便宜模型 + 小输出。
 */
import { mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ── 0. 注入构建期 MACRO 定义（正常由 dev.ts/build.ts 的 -d/define 注入）─────
// 源码里以裸标识符引用 MACRO.* 和 HOOK_TIMING_DISPLAY_THRESHOLD_MS，未定义会抛
// "MACRO is not defined"。这里在 import 任何源码之前挂到 globalThis 上。
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

/** 在调用 runQueryModel 之前声明本节需要点亮的 feature flag。 */
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
  /** 工具列表（分节 [4][5] 可传真实 builtin tool 观察 schema 构建）。 */
  tools?: unknown[]
  /** 需要点亮的 feature flag（等价于先调 setFeatures）。 */
  features?: string[]
  /** 本次运行前临时设置的环境变量（运行后自动还原）。 */
  env?: Record<string, string | undefined>
  /** 覆盖 options 的任意字段（与默认 options 浅合并）。 */
  options?: Record<string, unknown>
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

export type RunResult = {
  assistantMessages: any[]
  streamEvents: any[]
  errors: any[]
}

// ── 3. 主入口 ───────────────────────────────────────────────────────────────
/**
 * 真实调用 queryModel（经由已导出的 queryModelWithStreaming 薄包装进门），
 * 消费异步生成器，按 yield 类型分桶返回。
 */
export async function runQueryModel(
  overrides: RunOverrides = {},
): Promise<RunResult> {
  if (overrides.features) setFeatures(overrides.features)

  // 应用临时环境变量
  const savedEnv: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(overrides.env ?? {})) {
    savedEnv[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }

  try {
    // 在 mock 之后再动态 import 被测函数 + 参数构造工具。
    const { queryModelWithStreaming } = await import(
      'src/services/api/claude.js'
    )
    const { asSystemPrompt } = await import('src/utils/systemPromptType.js')
    const { getEmptyToolPermissionContext } = await import('src/Tool.js')

    // 正常由 CLI init 流程开启；standalone 运行需手动放行配置读取，
    // 否则 config.ts:1426 会抛 "Config accessed before allowed."。
    const { enableConfigs } = await import('src/utils/config.js')
    enableConfigs()

    // 把 ~/.hclaude/settings.json 的 `env` 块（ANTHROPIC_AUTH_TOKEN /
    // ANTHROPIC_BASE_URL / 模型映射等）应用到 process.env——这正是 CLI init
    // 所做的事；不做的话鉴权解析不到 token，会走「未登录」错误分支。
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

    // 默认用配置里映射的 sonnet 模型（尊重你的 provider，如 qwen3.6-plus）。
    const { getDefaultSonnetModel } = await import('src/utils/model/model.js')

    const options = {
      getToolPermissionContext: async () => getEmptyToolPermissionContext(),
      model: getDefaultSonnetModel(),
      isNonInteractiveSession: true,
      querySource: 'repl_main_thread',
      agents: [],
      mcpTools: [],
      hasAppendSystemPrompt: false,
      // 默认压小输出，省 token；分节可覆盖。
      maxOutputTokensOverride: 128,
      ...overrides.options,
    }

    const result: RunResult = {
      assistantMessages: [],
      streamEvents: [],
      errors: [],
    }

    console.error(
      `\n[harness] → queryModel  model=${options.model} source=${options.querySource} features=[${[...enabledFeatures].join(',')}]`,
    )

    for await (const item of queryModelWithStreaming({
      messages: messages as any,
      systemPrompt,
      thinkingConfig: thinkingConfig as any,
      tools: (overrides.tools ?? []) as any,
      signal: new AbortController().signal,
      options: options as any,
    })) {
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
      `[harness] ← done  assistant=${result.assistantMessages.length} events=${result.streamEvents.length} errors=${result.errors.length}\n`,
    )
    return result
  } finally {
    // 还原环境变量
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}
