/**
 * [1] off-switch —— src/services/api/claude.ts:1324-1342
 * ──────────────────────────────────────────────────────────────────────────
 * Opus 应急容量「关闭开关」：非订阅用户 + 官方 Opus 模型 + 远程动态配置
 * `tengu-off-switch` 激活时，直接 yield 一条错误消息并 return。
 *
 * 建议断点：claude.ts:1324（if 条件）、1337（命中后的 yield）。
 *
 * 控制杆：
 *   - options.model         必须是 isNonCustomOpusModel() 认定的官方 Opus 才会进判断
 *   - getDynamicConfig_BLOCKS_ON_INIT('tengu-off-switch') 的 activated（远程配置，难本地触发）
 *
 * 观察点：正常情况下 activated=false → 条件不成立、跳过本节。把断点设在 1324
 *         单步看四个子条件如何短路（isClaudeAISubscriber / isNonCustomOpusModel）。
 *
 * 运行：bun --inspect-wait run "docs/.../queryModel/[1]off-switch/debug.isolated.ts"
 */
import { runQueryModel } from '../_debug/harness.js'

await runQueryModel({
  prompt: 'Reply with a single word: ok',
  options: {
    // 切到 Opus 别名，让 isNonCustomOpusModel 这一支有机会为真（取决于 provider 映射）
    model: 'claude-opus-4-7',
  },
})
