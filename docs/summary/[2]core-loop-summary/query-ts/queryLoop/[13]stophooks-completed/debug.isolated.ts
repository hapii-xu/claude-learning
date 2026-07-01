/**
 * [13] stophooks-completed —— src/query.ts:1927-2029
 * ──────────────────────────────────────────────────────────────────────────
 * 停止钩子 + 完成：模型不再发工具调用时跑 stop hook——hook 放行则
 * Terminal{reason:'completed'}（2028）；hook 主动阻止则 stop_hook_prevented（1947）；
 * hook 返回阻塞错误则带错误续轮（1969, transition stop_hook_blocking）；
 * TOKEN_BUDGET 触发续写（2005, token_budget_continuation）。
 *
 * 建议断点：query.ts:1927（停止钩子起点）、1947 / 1969 / 2005 / 2028。
 *
 * 控制杆：
 *   - 默认无 stop hook → 直接 completed（2028）
 *   - features: ['TOKEN_BUDGET'] + paramsOverride.taskBudget 看续写分支
 *   - 配置 stop hook（settings.json）观察 prevented / blocking
 *
 * ⚠️ 真实工具副作用 + 真实计费。
 * 运行：bun run "docs/.../query-ts/queryLoop/[13]stophooks-completed/debug.isolated.ts"
 */
import { runQuery } from '../_debug/harness.js'

await runQuery({
  prompt: 'Reply with a single word: ok',
  maxTurns: 1,
  // features: ['TOKEN_BUDGET'],
  // paramsOverride: { taskBudget: { total: 500_000 } },
})
