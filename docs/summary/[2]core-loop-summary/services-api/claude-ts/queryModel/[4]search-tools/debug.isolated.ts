/**
 * [4] search-tools —— src/services/api/claude.ts:1408-1561
 * ──────────────────────────────────────────────────────────────────────────
 * SearchExtraTools（工具延迟加载）：决定这次把哪些工具的完整 schema 真正发给模型，
 * 省 token、保 prompt 缓存。包含「是否启用」「哪些工具延迟」「过滤」等判断。
 *
 * 建议断点：claude.ts:1413（启用判断）、1480 起（工具分流/过滤）。
 *
 * 控制杆：
 *   - tools                       传入真实工具列表才有东西可分流（见下方 getAllBaseTools）
 *   - options.mcpTools            MCP 工具（per-user，影响缓存策略）
 *   - options.hasPendingMcpServers 有 MCP 仍在连接 → 保持 SearchExtraTools 可用
 *   - features: ['EXPERIMENTAL_SEARCH_EXTRA_TOOLS']  工具搜索预取管道
 *   - env ENABLE_SEARCH_EXTRA_TOOLS
 *
 * 默认 tools=[] 可直接跑通；要观察真实分流，取消下面 getAllBaseTools 注释。
 *
 * 运行：bun --inspect-wait run "docs/.../queryModel/[4]search-tools/debug.isolated.ts"
 */
import { runQueryModel } from '../_debug/harness.js'

// 取消注释以加载真实内置工具（schema 较多、更费 token）：
// const { getAllBaseTools } = await import('src/tools.js')
// const tools = getAllBaseTools()

await runQueryModel({
  features: ['EXPERIMENTAL_SEARCH_EXTRA_TOOLS'],
  // tools,
  options: {
    hasPendingMcpServers: false,
  },
})
