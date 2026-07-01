/**
 * [5] compaction-family —— src/query.ts:802-895
 * ──────────────────────────────────────────────────────────────────────────
 * 压缩家族前三手（暗线 2，按固定顺序、互补不互斥）：
 *   snipCompact (HISTORY_SNIP) → microcompact → contextCollapse
 * microcompact 清理后会删除 contentReplacement 原始字符串（暗线 1 内存治理）。
 *
 * 建议断点：query.ts:802（压缩家族起点）、snip / micro / collapse 各处。
 *
 * 控制杆：
 *   - runWithBigHistory 注入超长历史触发压缩
 *   - features: ['HISTORY_SNIP'] 点亮 snipCompact
 *
 * ⚠️ 真实工具副作用 + 真实计费。
 * 运行：bun run "docs/.../query-ts/queryLoop/[5]compaction-family/debug.isolated.ts"
 */
import { runWithBigHistory } from '../_debug/harness.js'

await runWithBigHistory({ repeat: 400, features: ['HISTORY_SNIP'] })
