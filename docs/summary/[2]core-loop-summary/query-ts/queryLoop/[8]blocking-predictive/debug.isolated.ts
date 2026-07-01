/**
 * [8] blocking-predictive —— src/query.ts:1110-1222
 * ──────────────────────────────────────────────────────────────────────────
 * 阻塞上限 + 预测式压缩：auto-compact 关闭时撞到硬阻塞 token 上限 → 返回
 * Terminal{reason:'blocking_limit'}（1172）；否则在调 API 前做**预测式 autocompact**
 * （压缩家族第五手，暗线 2）。
 *
 * 建议断点：query.ts:1110（阻塞上限起点）、1172（blocking_limit 返回）、预测式压缩处。
 *
 * 控制杆：
 *   - runWithBigHistory 撑大上下文
 *   - env / optionsOverride 关闭 auto-compact 以命中 blocking_limit（按实现的开关）
 *
 * ⚠️ 真实工具副作用 + 真实计费。
 * 运行：bun run "docs/.../query-ts/queryLoop/[8]blocking-predictive/debug.isolated.ts"
 */
import { runWithBigHistory } from '../_debug/harness.js'

await runWithBigHistory({ repeat: 500 })
