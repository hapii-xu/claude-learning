/**
 * [2] previous-request-id —— src/services/api/claude.ts:1347-1354
 * ──────────────────────────────────────────────────────────────────────────
 * 两件小事：
 *  1. previousRequestId：从 messages 里「最后一条带 requestId 的 assistant」反推
 *     （getPreviousRequestIdFromMessages，claude.ts:1205）。用于缓存命中率分析。
 *  2. resolvedModel：Bedrock 且模型是 inference-profile ARN 时解析回真实底模。
 *
 * 建议断点：claude.ts:1347、1349。
 *
 * 控制杆：
 *   - 在 messages 里塞一条带 requestId 的历史 assistant 消息 → 观察 previousRequestId 被取到
 *   - env CLAUDE_CODE_USE_BEDROCK + application-inference-profile 模型名 → 走 resolvedModel 解析
 *
 * 运行：bun --inspect-wait run "docs/.../queryModel/[2]previous-request-id/debug.isolated.ts"
 */
import { runQueryModel } from '../_debug/harness.js'

await runQueryModel({
  // 手工构造带历史 assistant（含 requestId）的消息数组，断点看它被反查到。
  messages: [
    {
      type: 'user',
      uuid: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'hi' },
    },
    {
      type: 'assistant',
      uuid: crypto.randomUUID(),
      requestId: 'req_demo_PREVIOUS_12345',
      timestamp: new Date().toISOString(),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
        stop_reason: 'end_turn',
      },
    },
    {
      type: 'user',
      uuid: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'Reply with a single word: ok' },
    },
  ],
})
