/**
 * [1] module-helpers —— src/query.ts:214-282
 * ──────────────────────────────────────────────────────────────────────────
 * 模块级辅助：
 *   - isWithheldMaxOutputTokens（扣留判定：输出 token 被扣留时的识别）
 *   - getAutonomyTurnOutcome（从 terminal 反推 autonomy 回合结局）
 * 两者都是未导出的模块级函数，在 query()/queryLoop 跑动时被调用——在源码行打断点观察。
 *
 * 建议断点：query.ts:214（isWithheldMaxOutputTokens）、query.ts 内 getAutonomyTurnOutcome 处。
 *
 * 控制杆：
 *   - maxTurns —— 改小看 max_turns 终止 → getAutonomyTurnOutcome 如何映射结局
 *   - paramsOverride.maxOutputTokensOverride —— 影响扣留判定
 *
 * ⚠️ 真实工具副作用 + 真实计费。
 * 运行：bun run "docs/.../query-ts/query/[1]module-helpers/debug.isolated.ts"
 */
import { runQuery } from '../_debug/harness.js'

await runQuery({
  prompt: 'Reply with a single word: ok',
  maxTurns: 1,
})
