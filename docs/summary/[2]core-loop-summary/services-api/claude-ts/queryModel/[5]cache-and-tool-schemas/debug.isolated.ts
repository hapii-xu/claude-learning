/**
 * [5] cache-and-tool-schemas —— src/services/api/claude.ts:1480-1563
 * ──────────────────────────────────────────────────────────────────────────
 * cachedMC 闸门、全局缓存作用域、toolSchemas 构建（toolToAPISchema，api.ts:119）。
 * 关注 prompt 缓存如何被「保护」——工具数组字节稳定、cache_control 的注入位置。
 *
 * 建议断点：claude.ts:1480、toolToAPISchema 内部（src/utils/api.ts:119）。
 *
 * 控制杆：
 *   - options.enablePromptCaching   true/false/undefined（是否注入 cache_control）
 *   - options.skipCacheWrite        把缓存断点从最后一条移到倒数第二条（发射即忘）
 *   - options.mcpTools              MCP 工具不能走全局缓存——观察作用域差异
 *   - tools                         传真实工具看 schema 缓存键（见 [4] 的 getAllBaseTools）
 *   - env DISABLE_PROMPT_CACHING / DISABLE_PROMPT_CACHING_SONNET
 *
 * 运行：bun --inspect-wait run "docs/.../queryModel/[5]cache-and-tool-schemas/debug.isolated.ts"
 */
import { runQueryModel } from '../_debug/harness.js'

await runQueryModel({
  options: {
    enablePromptCaching: true,
    skipCacheWrite: false,
  },
  // 观察缓存关闭路径：env: { DISABLE_PROMPT_CACHING: '1' },
})
