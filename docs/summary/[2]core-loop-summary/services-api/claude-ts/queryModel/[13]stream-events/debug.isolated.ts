/**
 * [13] stream-events —— src/services/api/claude.ts:2307-2775（核心）
 * ──────────────────────────────────────────────────────────────────────────
 * 流事件处理大循环 `for await (const part of stream)`（claude.ts:2322）：把 SSE 的
 * message_start / content_block_start / *_delta / content_block_stop / message_delta /
 * message_stop 逐个累积成完整内容块，并在 content_block_stop 时 yield AssistantMessage。
 *
 * 建议断点：claude.ts:2322（大循环）、各 case（text_delta / input_json_delta /
 *          thinking_delta）、2643（content_block_stop 处 yield）。
 *
 * 控制杆：
 *   - prompt 要求模型「先思考再答 + 用工具」可让流里出现 thinking / tool_use 多种块
 *   - thinkingConfig 开启思考预算，观察 thinking_delta 累积
 *
 * 这是最值得单步的一节——真实流会逐帧进 case，观察 partialMessage 如何拼装。
 *
 * 运行：bun --inspect-wait run "docs/.../queryModel/[13]stream-events/debug.isolated.ts"
 */
import { runQueryModel } from '../_debug/harness.js'

await runQueryModel({
  prompt: 'Think briefly, then reply with a single word: ok',
  thinkingConfig: { type: 'enabled', budgetTokens: 1024 },
  options: {
    maxOutputTokensOverride: 512,
  },
})
