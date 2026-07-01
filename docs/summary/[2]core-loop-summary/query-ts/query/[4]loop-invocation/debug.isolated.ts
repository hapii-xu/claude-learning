/**
 * [4] loop-invocation —— src/query.ts:408-432
 * ──────────────────────────────────────────────────────────────────────────
 * 委托执行：`terminal = yield* queryLoop(paramsWithTrace, ...)`（416）把 queryLoop 的
 * 全部产出透传给上游，并用 try/catch 捕获结局——queryLoop 内部抛出的错误经 yield*
 * 冒泡到此处的 catch（428），置 didThrow/thrownError 后在 finally 善后、再 rethrow。
 *
 * 建议断点：
 *   - query.ts:416  yield* queryLoop（委托）
 *   - query.ts:428  catch（看 didThrow/thrownError）
 *
 * 控制杆：
 *   - optionsOverride.mainLoopModel = 无效模型 → 让 queryLoop 抛错，观察 throw 经 yield*
 *     冒泡进 catch（didThrow=true）→ finally 仍执行、但 [7] 的 completed 通知被跳过
 *
 * ⚠️ 真实工具副作用 + 真实计费。
 * 运行：bun run "docs/.../query-ts/query/[4]loop-invocation/debug.isolated.ts"
 */
import { runQuery } from '../_debug/harness.js'

// 正常委托（terminal 正常返回）
await runQuery({
  prompt: 'Reply with a single word: ok',
  maxTurns: 1,
})

// throw 路径：取消注释，用无效模型让 queryLoop 抛错冒泡进 catch（428）
// await runQuery({
//   prompt: 'ignored',
//   maxTurns: 1,
//   optionsOverride: { mainLoopModel: 'an-invalid-model-name' },
// }).catch(e => console.error('[harness] query rethrew:', (e as Error)?.message))
