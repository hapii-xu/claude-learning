/**
 * [4] history-trim-budget —— src/query.ts:714-800
 * ──────────────────────────────────────────────────────────────────────────
 * 历史裁边 + 工具结果预算：getMessagesAfterCompactBoundary（749）按压缩边界裁掉旧消息，
 * applyToolResultBudget（782）给历史里的 toolUseResult 套预算（释放 400KB FileRead 等大负载，
 * 暗线 1 内存治理）。
 *
 * 建议断点：query.ts:725（裁边前）、749（裁边后）、782（预算）。
 *
 * 控制杆：用 runWithBigHistory 注入超长历史（含大 toolUseResult），看裁剪/预算释放。
 *
 * ⚠️ 真实工具副作用 + 真实计费。
 * 运行：bun run "docs/.../query-ts/queryLoop/[4]history-trim-budget/debug.isolated.ts"
 */
import { runWithBigHistory } from '../_debug/harness.js'

await runWithBigHistory({ repeat: 200 })
