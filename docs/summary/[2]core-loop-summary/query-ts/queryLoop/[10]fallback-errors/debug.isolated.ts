/**
 * [10] fallback-errors —— src/query.ts:1473-1597
 * ──────────────────────────────────────────────────────────────────────────
 * 模型降级 + 错误处理：529/限流时切 fallbackModel 重试；API/运行时错误被**扣留
 * （withheld）**进流里（暗线 3 恢复家族），等流结束再逐级尝试恢复；最终可能
 * 返回 Terminal{reason:'model_error'}（1596）。
 *
 * 建议断点：query.ts:1473（降级/错误起点）、1596（model_error 返回）。
 *
 * 控制杆：
 *   - optionsOverride.mainLoopModel = 无效模型 → 触发错误/降级
 *   - paramsOverride.fallbackModel = 有效模型 → 看切换重试
 *
 * ⚠️ 真实工具副作用 + 真实计费 + 真实错误日志。
 * 运行：bun run "docs/.../query-ts/queryLoop/[10]fallback-errors/debug.isolated.ts"
 */
import { runQuery } from '../_debug/harness.js'

await runQuery({
  prompt: 'Reply with a single word: ok',
  maxTurns: 1,
  // 触发错误/降级：
  // optionsOverride: { mainLoopModel: 'an-invalid-model-name' },
  // paramsOverride: { fallbackModel: 'your-valid-fallback' },
})
