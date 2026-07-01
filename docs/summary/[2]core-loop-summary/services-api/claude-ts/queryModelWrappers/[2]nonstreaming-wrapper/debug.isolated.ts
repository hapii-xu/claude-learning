/**
 * [2] nonstreaming-wrapper —— src/services/api/claude.ts:963-1020
 * ──────────────────────────────────────────────────────────────────────────
 * `queryModelWithoutStreaming` 是 compact / extract_memories / queryHaiku 等
 * 辅助查询的入口：内部 for-await **把生成器吃光**（哪怕只要最后一条 assistant），
 * 因为成功日志 logAPISuccessAndDuration 在所有 yield 之后才触发。返回单条
 * AssistantMessage。
 *
 * 建议断点：
 *   - claude.ts:985  for-await 消费 withStreamingVCR(...)（看「吃光」过程）
 *   - claude.ts:999  没拿到 assistant 的兜底
 *   - claude.ts:1002 signal.aborted → 抛 APIUserAbortError
 *
 * 控制杆：
 *   - prompt
 *   - 取消下方注释：传入「已 abort 的 signal」直接命中 1002 的中止分支
 *
 * 运行：bun run "docs/.../queryModelWrappers/[2]nonstreaming-wrapper/debug.isolated.ts"
 */
import { runNonStreaming } from '../_debug/harness.js'

// 正常路径：返回单条 AssistantMessage
await runNonStreaming({
  prompt: 'Reply with a single word: ok',
})

// 中止路径：取消注释观察 APIUserAbortError（claude.ts:1002）
// const ac = new AbortController()
// ac.abort()
// await runNonStreaming({ prompt: 'ignored', signal: ac.signal })
