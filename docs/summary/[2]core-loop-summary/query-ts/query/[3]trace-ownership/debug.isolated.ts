/**
 * [3] trace-ownership —— src/query.ts:359-407
 * ──────────────────────────────────────────────────────────────────────────
 * Langfuse trace 拥有权与注入：
 *   - ownsTrace = !params.toolUseContext.langfuseTrace（379）——传入有 trace 就复用，
 *     否则自己 createTrace（387）并挂回 toolUseContext（paramsWithTrace, 401）。
 *   作为子 agent 调用时 trace 由 runAgent 设好；主线程自己建。
 *
 * 建议断点：
 *   - query.ts:379  ownsTrace 计算
 *   - query.ts:384/387  createTrace 分支
 *   - query.ts:401  paramsWithTrace 挂载
 *
 * 控制杆：
 *   - features: 点亮 langfuse 相关 flag（让 isLangfuseEnabled() 为真，走 createTrace）
 *   - toolUseContextOverride.langfuseTrace: 预置一个 trace 看「复用」分支（ownsTrace=false）
 *
 * ⚠️ 真实工具副作用 + 真实计费。
 * 运行：bun run "docs/.../query-ts/query/[3]trace-ownership/debug.isolated.ts"
 */
import { runQuery } from '../_debug/harness.js'

await runQuery({
  prompt: 'Reply with a single word: ok',
  maxTurns: 1,
  // 看「复用已有 trace」分支（ownsTrace=false）：注入一个占位 trace
  // toolUseContextOverride: { langfuseTrace: { id: 'preset-trace' } },
})
