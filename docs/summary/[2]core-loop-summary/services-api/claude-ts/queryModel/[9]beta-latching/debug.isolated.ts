/**
 * [9] beta-latching —— src/services/api/claude.ts:1781-1871
 * ──────────────────────────────────────────────────────────────────────────
 * beta 头「粘性锁存」：一旦某个 beta 头发出去，就锁存进 bootstrap state，
 * 会话中途即便条件变了也不改缓存键（防 prompt 缓存抖动）。还含缓存打破检测、llmSpan。
 *
 * 建议断点：claude.ts:1781 起；getFastModeHeaderLatched/setFastModeHeaderLatched 等。
 *
 * 控制杆：
 *   - options.fastMode   首次为 true → FAST_MODE_BETA_HEADER 被锁存
 *   - 连续两次调用        第二次即便 fastMode 改了，锁存的头也不变（观察锁存语义）
 *
 * 本文件演示「连调两次」：在 setFastModeHeaderLatched 处下断点，看第二次命中已锁存值。
 *
 * 运行：bun --inspect-wait run "docs/.../queryModel/[9]beta-latching/debug.isolated.ts"
 */
import { runQueryModel } from '../_debug/harness.js'

// 第一次：fastMode=true → 锁存 fast-mode beta 头
await runQueryModel({
  prompt: 'Reply with a single word: one',
  options: { fastMode: true },
})

// 第二次：fastMode=false → 但上一轮已锁存，beta 头不应回退（断点对比）
await runQueryModel({
  prompt: 'Reply with a single word: two',
  options: { fastMode: false },
})
