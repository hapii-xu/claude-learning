/**
 * [2] params-state-deps —— src/query.ts:284-336 + 580-626
 * ──────────────────────────────────────────────────────────────────────────
 * QueryParams / State / deps / config 快照：queryLoop 入口解构 params、用
 * `params.deps ?? productionDeps()`（595）决定依赖实现、拍一份 config 快照（605-624）。
 * deps 注入是测试精确控制 callModel/compact 的关键逃生舱。
 *
 * 建议断点：query.ts:540（入口）、595（deps 决议）、605（config 快照）。
 *
 * 控制杆：
 *   - paramsOverride.deps —— 注入 { callModel: mockFn } 精确控制单次 LLM 请求（不触网）
 *   - paramsOverride.taskBudget —— 看 config 快照里的预算字段
 *
 * ⚠️ 真实工具副作用 + 真实计费（未注入 deps 时）。
 * 运行：bun run "docs/.../query-ts/queryLoop/[2]params-state-deps/debug.isolated.ts"
 */
import { runQuery } from '../_debug/harness.js'

await runQuery({
  prompt: 'Reply with a single word: ok',
  maxTurns: 1,
  // 注入 deps.callModel 可不触网精确控制（参考 query.ts:593 注释）
  // paramsOverride: { deps: { callModel: async function* () { /* 自造流 */ } } },
})
