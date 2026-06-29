/**
 * [7] provider-routing —— src/services/api/claude.ts:1621-1662
 * ──────────────────────────────────────────────────────────────────────────
 * OpenAI / Gemini / Grok 兼容层的提前 return：命中对应 env 时，queryModel 把
 * 控制权交给兼容层的 queryModelOpenAI / Gemini / Grok，后续 1P 路径完全不执行。
 *
 * 建议断点：claude.ts:1624（OpenAI）、1639（Gemini）、1652（Grok）。
 *
 * 控制杆（env）：
 *   - CLAUDE_CODE_USE_OPENAI=1  + OPENAI_BASE_URL/OPENAI_API_KEY/OPENAI_MODEL
 *   - CLAUDE_CODE_USE_GEMINI=1  + GEMINI_API_KEY
 *   - CLAUDE_CODE_USE_GROK=1
 *
 * ⚠️ 你当前用的是 Anthropic 协议的 DashScope 端点（ANTHROPIC_BASE_URL），
 *    属于 firstParty 路径，不会进这三条分支。把断点设在 1624 单步确认：默认会
 *    一路 falsy 跳过、继续走 1P。要真正进 OpenAI 分支需另配 OPENAI_* 并设下面 env。
 *
 * 运行：bun --inspect-wait run "docs/.../queryModel/[7]provider-routing/debug.isolated.ts"
 */
import { runQueryModel } from '../_debug/harness.js'

await runQueryModel({
  // 取消注释 + 配好 OPENAI_* 才会真正走 OpenAI 兼容层（否则保持 1P）：
  // env: { CLAUDE_CODE_USE_OPENAI: '1' },
  prompt: 'Reply with a single word: ok',
})
