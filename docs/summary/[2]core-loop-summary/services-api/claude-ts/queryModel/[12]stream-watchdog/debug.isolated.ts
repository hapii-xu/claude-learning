/**
 * [12] stream-watchdog —— src/services/api/claude.ts:2245-2305
 * ──────────────────────────────────────────────────────────────────────────
 * 空闲超时看门狗 + stall 检测：流式接收过程中若长时间没有新事件，看门狗触发，
 * throw 出去走非流式降级（见 [15]）。
 *
 * 建议断点：claude.ts:2245 起（看门狗定时器设置/重置）。
 *
 * 控制杆：
 *   - env API_TIMEOUT_MS    影响超时上限（你的 settings 里是 3000000）
 *   - 用一个会「慢吐」的 prompt（要求较长输出）便于观察看门狗每次被新事件重置
 *
 * 运行：bun --inspect-wait run "docs/.../queryModel/[12]stream-watchdog/debug.isolated.ts"
 */
import { runQueryModel } from '../_debug/harness.js'

await runQueryModel({
  // 要一段稍长的输出，制造多次流事件，便于看门狗多次重置
  prompt: 'Count from 1 to 20, one number per line.',
  options: {
    maxOutputTokensOverride: 256,
  },
  // 想观察看门狗更敏感地触发，可临时把超时调小（注意可能误伤正常慢响应）：
  // env: { API_TIMEOUT_MS: '2000' },
})
