/**
 * [6] trace-teardown-gc —— src/query.ts:457-508
 * ──────────────────────────────────────────────────────────────────────────
 * finally② trace 拆除 + 内存治理三连（571MB OTel 泄漏对策）：
 *   1. endTrace + flushLangfuse —— 不主动 flush，SpanImpl 会把序列化对话历史保留到
 *      批次定时器（默认 10s）。
 *   2. 闭包断链置 null —— 斩断 toolUseContext 捕获的 langfuseTrace→SpanImpl→otperformance
 *      引用链，才能 GC 掉 571MB Performance 对象。
 *   3. performance.clearMarks() —— 清空 OTel 永不收缩的 C++ Vector。
 *
 * 建议断点：
 *   - query.ts:457  finally② 起点 / endTrace
 *   - flushLangfuse / 置 null / clearMarks 各处
 *
 * 控制杆：
 *   - features: 点亮 langfuse 让三连真正有东西可清（否则 trace 为 null，多为空操作）
 *
 * ⚠️ 真实工具副作用 + 真实计费。
 * 运行：bun run "docs/.../query-ts/query/[6]trace-teardown-gc/debug.isolated.ts"
 */
import { runQuery } from '../_debug/harness.js'

await runQuery({
  prompt: 'Reply with a single word: ok',
  maxTurns: 1,
  // features: ['<langfuse-flag>'],
})
