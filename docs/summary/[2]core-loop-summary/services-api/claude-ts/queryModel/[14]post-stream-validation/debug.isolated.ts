/**
 * [14] post-stream-validation —— src/services/api/claude.ts:2776-2882
 * ──────────────────────────────────────────────────────────────────────────
 * 流结束后的校验：usage 统计、配额响应头解析、空响应降级判定
 * （流跑完却没拿到任何内容块 → 触发非流式降级，见 [15]）。
 *
 * 建议断点：claude.ts:2776 起；usage 累计、extractQuotaStatusFromHeaders。
 *
 * 控制杆：
 *   - 正常一次成功请求即可观察 usage（input/output/cache_* tokens）填充
 *   - 想观察「空响应」分支较难自然触发——把断点设在空响应判定处单步看条件
 *
 * 运行：bun --inspect-wait run "docs/.../queryModel/[14]post-stream-validation/debug.isolated.ts"
 */
import { runQueryModel } from '../_debug/harness.js'

const res = await runQueryModel({
  prompt: 'Reply with a single word: ok',
})

// 看最终 usage（断点也可直接在 claude.ts:2776 区段观察）
const usage = (res.assistantMessages.at(-1) as any)?.message?.usage
console.error('[14] final usage =', JSON.stringify(usage))
