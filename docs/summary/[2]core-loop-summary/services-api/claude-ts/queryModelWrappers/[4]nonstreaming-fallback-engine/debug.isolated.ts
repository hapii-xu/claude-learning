/**
 * [4] nonstreaming-fallback-engine —— src/services/api/claude.ts:1079-1196
 * ──────────────────────────────────────────────────────────────────────────
 * `executeNonStreamingRequest` 不是入口包装，而是 queryModel 的 [15]error-fallback
 * 一节在「流式请求失败」后改用的非流式降级引擎。它用
 * getNonstreamingFallbackTimeoutMs()（远端会话 120s / 否则 300s）给每次尝试套超时，
 * 让卡死的后端得到干净的 APIConnectionTimeoutError。
 *
 * 为什么经「真实触发」而不直接调用：executeNonStreamingRequest 需要一个
 * paramsFromContext 闭包（claude.ts:1105）来构造 BetaMessageStreamParams，独立构造
 * 成本高。最自然的观察方式是让一次流式请求失败、从而触发 queryModel 内部走到
 * 1090 这一步。
 *
 * 建议断点：
 *   - claude.ts:1090  executeNonStreamingRequest 入口
 *   - claude.ts:1114  fallbackTimeoutMs 计算
 *   - claude.ts:3021 / 3033 / 3133  queryModel 内触发降级处
 *
 * 控制杆：
 *   - options.model = 会让流式失败的模型名（触发降级 catch）
 *   - options.onStreamingFallback —— 注入回调看降级通知
 *
 * ⚠️ 真实计费 + 可能产生真实错误日志。
 *
 * 运行：bun run "docs/.../queryModelWrappers/[4]nonstreaming-fallback-engine/debug.isolated.ts"
 */
import { runStreaming } from '../_debug/harness.js'

await runStreaming({
  prompt: 'Reply with a single word: ok',
  options: {
    // 改成你环境里会触发流式失败/降级的模型名，命中 1090 的非流式重发
    // model: 'an-invalid-or-non-streaming-model',
    onStreamingFallback: (info: unknown) =>
      console.error('[harness] onStreamingFallback', info),
  },
})
