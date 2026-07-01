/**
 * [12] termination-recovery —— src/query.ts:1695-1925
 * ──────────────────────────────────────────────────────────────────────────
 * 终止判断 + 恢复家族（暗线 3，queryLoop 最复杂的部分）。413 上下文超限的逐级恢复：
 *   collapse drain（1750, transition collapse_drain_retry）
 *     → reactive compact（1805, reactive_compact_retry，压缩家族第六手）
 *       → 暴露错误 prompt_too_long（1821/1832）
 * 媒体尺寸超限：reactive compact strip-retry → image_error（1821）。
 * 输出截断：8k→64k 升级（1867, max_output_tokens_escalate）→ 注入续写（1899, recovery）。
 *
 * 建议断点：query.ts:1695（终止判断起点）、1750 / 1805 / 1821 / 1867 / 1899。
 *
 * 控制杆：runWithBigHistory 撑爆上下文触发 413 恢复链；或 maxOutputTokensOverride 极小看续写。
 *
 * ⚠️ 真实工具副作用 + 真实计费（恢复路径会多发 API 请求）。
 * 运行：bun run "docs/.../query-ts/queryLoop/[12]termination-recovery/debug.isolated.ts"
 */
import { runWithBigHistory } from '../_debug/harness.js'

await runWithBigHistory({ repeat: 800 })
