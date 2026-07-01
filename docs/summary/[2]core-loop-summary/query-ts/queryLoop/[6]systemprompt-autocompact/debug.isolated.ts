/**
 * [6] systemprompt-autocompact —— src/query.ts:897-1019
 * ──────────────────────────────────────────────────────────────────────────
 * 系统提示构建 + 主动 autocompact：拼接 CLAUDE.md / git 状态等动态上下文进 system，
 * 并在上下文接近窗口上限时**主动**压缩历史（压缩家族第四手，暗线 2）。
 *
 * 建议断点：query.ts:897（系统提示构建）、autocompact 触发处。
 *
 * 控制杆：runWithBigHistory 把历史撑到接近窗口上限，触发主动 autocompact。
 *
 * ⚠️ 真实工具副作用 + 真实计费（autocompact 本身也会发 API 请求做摘要）。
 * 运行：bun run "docs/.../query-ts/queryLoop/[6]systemprompt-autocompact/debug.isolated.ts"
 */
import { runWithBigHistory } from '../_debug/harness.js'

await runWithBigHistory({ repeat: 500 })
