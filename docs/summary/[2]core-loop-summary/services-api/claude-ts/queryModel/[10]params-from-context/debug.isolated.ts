/**
 * [10] params-from-context —— 关注 src/services/api/claude.ts:1906-2135
 * ──────────────────────────────────────────────────────────────────────────
 * 本节是 paramsFromContext 闭包：把 thinking / temperature / effort / taskBudget /
 * cache breakpoints 等拼进最终 API 请求参数。
 *
 * 建议断点：claude.ts:1906（paramsFromContext 定义处）、以及节内你关心的分支。
 *
 * 控制杆（改下面这些再重跑，对比断点处变量变化）：
 *   - options.thinkingConfig    思考预算（{ type:'enabled', budgetTokens } / { type:'disabled' }）
 *   - options.temperatureOverride  温度（仅 thinking 关闭时生效）
 *   - options.effortValue       'low'|'medium'|'high'|'max'（需模型支持）
 *   - options.taskBudget        { total, remaining }（API 侧预算）
 *
 * 运行：
 *   bun --inspect-wait run "docs/summary/[2]core-loop-summary/services-api/claude-ts/queryModel/[10]params-from-context/debug.isolated.ts"
 */
import { runQueryModel } from '../_debug/harness.js'

await runQueryModel({
  prompt: 'Reply with a single word: ok',
  thinkingConfig: { type: 'disabled' },
  options: {
    temperatureOverride: 0.3,
    // effortValue: 'low',          // 取消注释观察 effort 注入（claude.ts:486 configureEffortParams）
    // taskBudget: { total: 200_000, remaining: 150_000 },
  },
})
