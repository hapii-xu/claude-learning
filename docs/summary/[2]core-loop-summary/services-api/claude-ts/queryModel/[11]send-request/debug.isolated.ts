/**
 * [11] send-request —— src/services/api/claude.ts:2137-2233
 * ──────────────────────────────────────────────────────────────────────────
 * withRetry 包裹、创建客户端、发起流式请求 .create({ stream: true })（claude.ts:2198）。
 * 这里是「真正把请求发出去」的点；断点在 2198 可看最终组装好的 params。
 *
 * 建议断点：claude.ts:2198（发起请求）、withRetry 内的客户端创建。
 *
 * 控制杆：
 *   - options.fallbackModel           连续 529 达阈值后切到的降级模型
 *   - options.maxOutputTokensOverride 覆盖 max_tokens（断点看最终 params.max_tokens）
 *
 * 运行：bun --inspect-wait run "docs/.../queryModel/[11]send-request/debug.isolated.ts"
 */
import { runQueryModel } from '../_debug/harness.js'

await runQueryModel({
  prompt: 'Reply with a single word: ok',
  options: {
    maxOutputTokensOverride: 64,
    // fallbackModel: 'qwen3.5-plus', // 主模型 529 时降级目标
  },
})
