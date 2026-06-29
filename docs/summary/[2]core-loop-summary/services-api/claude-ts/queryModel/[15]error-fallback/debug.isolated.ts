/**
 * [15] error-fallback —— src/services/api/claude.ts:2883-3290
 * ──────────────────────────────────────────────────────────────────────────
 * 多层降级：流式错误 → 非流式降级；404 流端点 → 非流式降级；外层 catch 处理
 * FallbackTriggeredError（切模型上抛 query.ts）。
 *
 * 建议断点：claude.ts:2883（流式错误 catch）、3080（外层 catch / 404 / FallbackTriggered）。
 *
 * 控制杆（故意制造错误）：
 *   - options.model = 不存在的模型名  → 端点报错，观察 catch 与降级路径
 *   - 也可断网后运行，观察 APIConnectionTimeoutError 路径
 *
 * 本文件用一个无效模型触发错误，看错误如何被转成 assistant 错误消息 / 走降级。
 *
 * 运行：bun --inspect-wait run "docs/.../queryModel/[15]error-fallback/debug.isolated.ts"
 */
import { runQueryModel } from '../_debug/harness.js'

const res = await runQueryModel({
  prompt: 'Reply with a single word: ok',
  options: {
    model: 'this-model-does-not-exist-xyz',
  },
})

console.error(
  '[15] errors =',
  res.errors.length,
  'assistant =',
  res.assistantMessages.length,
)
