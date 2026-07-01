/**
 * [15] attachments-next-turn —— src/query.ts:2228-2457
 * ──────────────────────────────────────────────────────────────────────────
 * 附件注入 + 续轮闭环：把工具结果 + 新附件拼进 messages 副本，设
 * transition.reason='next_turn'（2449），`state = { ...next }` 整体替换后 continue 续轮；
 * 达到 maxTurns 上限则 Terminal{reason:'max_turns'}（2431）。
 *
 * 建议断点：query.ts:2228（附件/续轮起点）、2431（max_turns）、2449（next_turn transition）。
 *
 * 控制杆：
 *   - runWithToolLoop：让模型调工具 → 产生 tool_result → 看续轮闭环
 *   - maxTurns 改小 → 提前命中 max_turns（2431）
 *
 * ⚠️ 真实工具副作用 + 真实计费。
 * 运行：bun run "docs/.../query-ts/queryLoop/[15]attachments-next-turn/debug.isolated.ts"
 */
import { runWithToolLoop } from '../_debug/harness.js'

await runWithToolLoop({
  prompt: 'List files with a tool, then summarize, then say done.',
  maxTurns: 3,
})
