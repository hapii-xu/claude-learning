/**
 * [14] tool-execution —— src/query.ts:2031-2226
 * ──────────────────────────────────────────────────────────────────────────
 * 工具执行：模型发了 tool_use → 经 canUseTool 判权限 → 执行工具 → 拼接 tool_result。
 * 被用户中断时返回 aborted_tools（2204）；hook_stopped_continuation 时 hook_stopped（2213）。
 *
 * ⚠️⚠️ 本节会**真实执行工具**：harness 默认 canUseTool 自动放行所有工具，
 *      模型可能真的运行 Bash 命令 / 写文件。runWithToolLoop 的 prompt 故意诱导列目录。
 *      想避免副作用：把 prompt 改成只读意图、或在 isolated 里传 tools:[] 禁工具。
 *
 * 建议断点：query.ts:2031（工具执行起点）、canUseTool 调用处、2204（aborted_tools）、2213（hook_stopped）。
 *
 * 控制杆：runWithToolLoop（全量 tools + 诱导工具调用）；改 prompt 控制调哪个工具。
 *
 * 运行：bun run "docs/.../query-ts/queryLoop/[14]tool-execution/debug.isolated.ts"
 */
import { runWithToolLoop } from '../_debug/harness.js'

await runWithToolLoop({
  prompt: 'Use a tool to read the package.json version field, then say done.',
})
