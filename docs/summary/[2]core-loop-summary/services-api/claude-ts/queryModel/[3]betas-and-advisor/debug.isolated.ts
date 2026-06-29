/**
 * [3] betas-and-advisor —— src/services/api/claude.ts:1356-1406
 * ──────────────────────────────────────────────────────────────────────────
 * 三件事：
 *  1. isAgenticQuery：由 querySource 前缀判断（repl_main_thread/agent:/sdk/...）。
 *  2. betas：getMergedBetas(model, {isAgenticQuery}) 合并 beta 头；advisor 开启再追加。
 *  3. advisorModel：仅 agentic + advisor 启用 + 模型支持 + 合法 advisor 模型时才解析。
 *
 * 建议断点：claude.ts:1357（isAgenticQuery）、1363（betas）、1372（advisor 分支）。
 *
 * 控制杆：
 *   - options.querySource    改成非 agentic（如 'compact'）对比 isAgenticQuery=false
 *   - options.advisorModel   指定 advisor 模型，观察是否被采纳/跳过
 *   - features: ['ADVISOR']  点亮 advisor 相关 feature（若有门控）
 *
 * 注：你的 settings.json 里 advisorModel=qwen3.7-plus 且 sage_compass 已启用，
 *     所以 isAdvisorEnabled() 很可能为 true——正好观察 1367/1372 两条 advisor 分支。
 *
 * 运行：bun --inspect-wait run "docs/.../queryModel/[3]betas-and-advisor/debug.isolated.ts"
 */
import { runQueryModel } from '../_debug/harness.js'

await runQueryModel({
  features: ['ADVISOR'],
  options: {
    querySource: 'repl_main_thread', // 改成 'compact' 看 isAgenticQuery 变 false
    advisorModel: 'qwen3.7-plus',
  },
})
