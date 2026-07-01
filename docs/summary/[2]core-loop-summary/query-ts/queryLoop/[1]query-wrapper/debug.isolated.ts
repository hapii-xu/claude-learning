/**
 * [1] query-wrapper —— src/query.ts:359-526
 * ──────────────────────────────────────────────────────────────────────────
 * 外层 query() 包装器：trace 拥有权 / finally 收尾（autonomy 命令、闭包断链置 null、
 * performance.clearMarks）/ completed 信号。queryLoop 的「生命周期与善后」全在这层。
 * （与 query 系列 [3][5][6][7] 是同一段代码，这里从 queryLoop 视角再看一遍。）
 *
 * 建议断点：query.ts:379（ownsTrace）、416（yield* queryLoop）、457（finally GC）、510（completed）。
 *
 * 控制杆：features 开 langfuse 看 trace 三连清理；optionsOverride.mainLoopModel 无效模型看 throw。
 *
 * ⚠️ 真实工具副作用 + 真实计费。
 * 运行：bun run "docs/.../query-ts/queryLoop/[1]query-wrapper/debug.isolated.ts"
 */
import { runQuery } from '../_debug/harness.js'

await runQuery({
  prompt: 'Reply with a single word: ok',
  maxTurns: 1,
})
