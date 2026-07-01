/**
 * [1] streaming-wrapper —— src/services/api/claude.ts:1022-1054
 * ──────────────────────────────────────────────────────────────────────────
 * `queryModelWithStreaming` 是 REPL/子 agent 的流式入口：函数体只有一行
 * `return yield* withStreamingVCR(messages, () => queryModel(...))`——把 queryModel
 * 的每个 yield 透传给调用方，自己不消费。
 *
 * 建议断点：claude.ts:1022（入口）、1040（开始日志）、1044（yield* 透传）。
 * 单步时观察：每个 stream_event / assistant 如何原样冒泡出来。
 *
 * 控制杆：
 *   - prompt / messages —— 改输入看事件流变化
 *
 * 运行：bun run "docs/.../queryModelWrappers/[1]streaming-wrapper/debug.isolated.ts"
 */
import { runStreaming } from '../_debug/harness.js'

await runStreaming({
  prompt: 'Reply with a single word: ok',
})
