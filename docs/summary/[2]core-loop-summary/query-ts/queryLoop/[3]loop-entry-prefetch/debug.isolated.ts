/**
 * [3] loop-entry-prefetch —— src/query.ts:628-712
 * ──────────────────────────────────────────────────────────────────────────
 * 循环入口：启动内存预取（pendingMemoryPrefetch，634，每会话只建一次省 700KB）、
 * skill + tool 预取（677），建立 queryTracking 链路（chainId/depth，702）。
 *
 * 建议断点：query.ts:634（memory 预取）、677（skill/tool 预取）、702（queryTracking）。
 *
 * 控制杆：features 点亮 EXPERIMENTAL_SKILL_SEARCH / EXPERIMENTAL_SEARCH_EXTRA_TOOLS 看预取分支。
 *
 * ⚠️ 真实工具副作用 + 真实计费。
 * 运行：bun run "docs/.../query-ts/queryLoop/[3]loop-entry-prefetch/debug.isolated.ts"
 */
import { runQuery } from '../_debug/harness.js'

await runQuery({
  prompt: 'Reply with a single word: ok',
  maxTurns: 1,
  // features: ['EXPERIMENTAL_SKILL_SEARCH', 'EXPERIMENTAL_SEARCH_EXTRA_TOOLS'],
})
