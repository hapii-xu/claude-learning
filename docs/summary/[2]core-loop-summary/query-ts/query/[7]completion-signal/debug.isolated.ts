/**
 * [7] completion-signal —— src/query.ts:510-526
 * ──────────────────────────────────────────────────────────────────────────
 * 正常返回路径：`notifyCommandLifecycle('completed')`（510）放在 finally **之外**，
 * 再 `return terminal!`（526）。三种出口落点不同：
 *   - 正常 return → finally 执行 ✅ + completed 通知 ✅
 *   - throw       → finally 执行 ✅ + completed **跳过**（[4] 的无效模型路径）
 *   - .return()   → finally 执行 ✅ + completed **跳过**（调用方提前关闭 generator）
 * 这种非对称「started-without-completed」信号让上层知道命令「开始了但没善终」。
 *
 * 建议断点：query.ts:510（notifyCommandLifecycle('completed')）、526（return terminal）。
 *
 * 控制杆：
 *   - 默认：正常完成 → 看 completed 被发、terminal.reason
 *   - closeAfterYields: N —— 跑够 N 个 yield 后 harness 调 gen.return()，
 *     观察 .return() 出口（completed 跳过）
 *
 * ⚠️ 真实工具副作用 + 真实计费。
 * 运行：bun run "docs/.../query-ts/query/[7]completion-signal/debug.isolated.ts"
 */
import { runQuery } from '../_debug/harness.js'

// 正常完成：发 completed，return terminal
await runQuery({
  prompt: 'Reply with a single word: ok',
  maxTurns: 1,
})

// .return() 出口：取消注释，跑到第 2 个 yield 后提前关闭 generator（completed 跳过）
// await runQuery({
//   prompt: 'Reply with a single word: ok',
//   maxTurns: 1,
//   closeAfterYields: 2,
// })
