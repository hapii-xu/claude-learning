/**
 * [16] finally-and-teardown —— src/services/api/claude.ts:3291-3402
 * ──────────────────────────────────────────────────────────────────────────
 * 收尾：releaseStreamResources 释放流资源（防 Response 持有的堆外 TLS/socket 泄漏）、
 * 降级成本累计、langfuse 观测、成功日志。生成器被 .return() 提前终止时 finally 也会跑。
 *
 * 建议断点：claude.ts:3291（finally 入口）、releaseStreamResources、addToTotalSessionCost。
 *
 * 控制杆 / 观察方式：
 *   - 正常跑完一次：断点看 finally 里资源释放 + 成本累计 + 成功日志
 *   - 提前终止：在消费方 break 出 for-await（见下方注释），观察 finally 仍触发清理
 *
 * 运行：bun --inspect-wait run "docs/.../queryModel/[16]finally-and-teardown/debug.isolated.ts"
 */
import { runQueryModel } from '../_debug/harness.js'

// 正常完整跑一次：finally 在所有 yield 之后触发。
await runQueryModel({
  prompt: 'Reply with a single word: ok',
})

// 想观察「提前终止触发 finally」：自行直接驱动生成器并在中途 break——
// 参考 harness.ts 里的消费循环，把 for-await 改成读到第一个 stream_event 就 break，
// 生成器的 finally（claude.ts:3291）会在 break 时被调用做清理。
