/**
 * [9] api-call-stream —— src/query.ts:1224-1472（核心）
 * ──────────────────────────────────────────────────────────────────────────
 * callModel 流式消费：调 deps.callModel（→ queryModel → Anthropic API），逐帧 yield
 * 流式事件给调用方（UI 实时渲染），并累积 assistant 内容块（text / thinking / tool_use）。
 * 这是 queryLoop 主干，最值得单步。
 *
 * 建议断点：query.ts:1224（API 调用起点）、流式消费循环、tool_use 块累积处。
 *
 * 控制杆：
 *   - thinkingConfig 开思考预算，观察 thinking_delta 累积
 *   - runWithToolLoop：让模型发 tool_use，观察工具块如何拼装（⚠️ 真实执行工具）
 *
 * ⚠️ 真实工具副作用 + 真实计费。
 * 运行：bun run "docs/.../query-ts/queryLoop/[9]api-call-stream/debug.isolated.ts"
 */
import { runWithToolLoop } from '../_debug/harness.js'

await runWithToolLoop({
  thinkingConfig: { type: 'enabled', budgetTokens: 1024 },
  paramsOverride: { maxOutputTokensOverride: 512 },
})
