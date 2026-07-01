/**
 * [2] params-and-state —— src/query.ts:284-335
 * ──────────────────────────────────────────────────────────────────────────
 * 输入与状态契约：QueryParams 16 字段（284-317）+ queryLoop 内 State 12 字段（322-335）。
 * 本节是「看清进门时的参数长什么样」——在 query 入口与 queryLoop 入口断点，逐字段核对。
 *
 * 建议断点：
 *   - query.ts:359  query() 入口（看 params 全字段）
 *   - query.ts:540  queryLoop() 入口（看 state 初始化）
 *
 * 控制杆（改下面再重跑，对照断点处 params 变化）：
 *   - prompt / messages / system / tools / maxTurns / thinkingConfig
 *   - paramsOverride.fallbackModel / paramsOverride.taskBudget
 *
 * ⚠️ 真实工具副作用 + 真实计费。
 * 运行：bun run "docs/.../query-ts/query/[2]params-and-state/debug.isolated.ts"
 */
import { runQuery } from '../_debug/harness.js'

await runQuery({
  prompt: 'Reply with a single word: ok',
  maxTurns: 2,
  // paramsOverride: { fallbackModel: 'some-fallback', taskBudget: { total: 200_000 } },
})
