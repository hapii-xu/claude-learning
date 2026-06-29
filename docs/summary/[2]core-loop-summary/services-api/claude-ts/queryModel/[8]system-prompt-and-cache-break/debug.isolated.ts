/**
 * [8] system-prompt-and-cache-break —— src/services/api/claude.ts:1674-1762
 * ──────────────────────────────────────────────────────────────────────────
 * 延迟工具公告注入、system prompt 前缀组装、break-cache nonce。
 * system 前缀按「交互/非交互 + 是否 appendSystemPrompt」选择不同 preset。
 *
 * 建议断点：claude.ts:1674 起；splitSysPromptPrefix / getCLISyspromptPrefix。
 *
 * 控制杆：
 *   - options.isNonInteractiveSession  true→AGENT_SDK 前缀；false→DEFAULT 前缀
 *   - options.hasAppendSystemPrompt    叠加 preset（见 Options 注释 claude.ts:854）
 *   - system                           自定义系统提示词数组
 *   - break-cache 标记文件（src/commands/break-cache）存在时注入 nonce 打破缓存
 *
 * 运行：bun --inspect-wait run "docs/.../queryModel/[8]system-prompt-and-cache-break/debug.isolated.ts"
 */
import { runQueryModel } from '../_debug/harness.js'

await runQueryModel({
  system: ['You are a concise assistant.', 'Always answer in one word.'],
  options: {
    isNonInteractiveSession: false, // 切 true/false 对比 system 前缀选择
    hasAppendSystemPrompt: false,
  },
})
