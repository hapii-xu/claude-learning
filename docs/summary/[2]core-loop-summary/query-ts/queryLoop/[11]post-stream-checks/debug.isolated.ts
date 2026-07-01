/**
 * [11] post-stream-checks —— src/query.ts:1599-1693
 * ──────────────────────────────────────────────────────────────────────────
 * 流后检查 + 流式中断：流结束后检查扣留的错误（图片尺寸 1576 / API 错误 1596）、
 * 判断是否被用户中断（aborted_streaming，1683）。
 *
 * 建议断点：query.ts:1599（流后检查起点）、1683（aborted_streaming 返回）。
 *
 * 控制杆：
 *   - 跑动中按 Ctrl+C 中断流式（观察 aborted_streaming）
 *   - 注入会触发图片/API 错误的 messages 看扣留错误检查
 *
 * ⚠️ 真实工具副作用 + 真实计费。
 * 运行：bun run "docs/.../query-ts/queryLoop/[11]post-stream-checks/debug.isolated.ts"
 */
import { runQuery } from '../_debug/harness.js'

// 用稍长输出便于在流式阶段手动 Ctrl+C 观察 aborted_streaming（1683）
await runQuery({
  prompt: 'Count slowly from 1 to 30, one number per line.',
  maxTurns: 1,
  paramsOverride: { maxOutputTokensOverride: 512 },
})
