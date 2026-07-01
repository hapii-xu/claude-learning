/**
 * [7] setup-and-model —— src/query.ts:1021-1108
 * ──────────────────────────────────────────────────────────────────────────
 * 设置阶段 + 模型选择：确定本轮用哪个模型（主模型 / fallback / fastMode 等）、
 * 准备请求所需的运行期设置。
 *
 * 建议断点：query.ts:1021（设置阶段起点）、模型选择处。
 *
 * 控制杆：
 *   - optionsOverride.mainLoopModel —— 指定主模型
 *   - paramsOverride.fallbackModel —— 指定 fallback
 *
 * ⚠️ 真实工具副作用 + 真实计费。
 * 运行：bun run "docs/.../query-ts/queryLoop/[7]setup-and-model/debug.isolated.ts"
 */
import { runQuery } from '../_debug/harness.js'

await runQuery({
  prompt: 'Reply with a single word: ok',
  maxTurns: 1,
  // optionsOverride: { mainLoopModel: 'your-model' },
  // paramsOverride: { fallbackModel: 'your-fallback' },
})
