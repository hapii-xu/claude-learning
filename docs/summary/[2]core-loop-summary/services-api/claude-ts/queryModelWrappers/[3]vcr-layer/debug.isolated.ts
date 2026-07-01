/**
 * [3] vcr-layer —— src/services/vcr.ts:26-383
 * ──────────────────────────────────────────────────────────────────────────
 * `withStreamingVCR` 是两个入口共享的录制/回放层。生产环境第一行就是
 * `if (!shouldUseVCR()) return yield* f()`——零开销透传。只有 NODE_ENV==='test'
 * 或显式 FORCE_VCR 才进入录放：哈希前把路径/UUID/时间戳/耗时/成本「脱水」成
 * 占位符（dehydrateValue），回放时再「水合」回真实值（hydrateValue），让同一段
 * 对话跨机命中同一 fixture。
 *
 * 建议断点：
 *   - vcr.ts:26  shouldUseVCR（看它为何返回 true/false）
 *   - vcr.ts:91  withVCR 主体
 *   - dehydrateValue / hydrateValue（脱水水合）
 *
 * 控制杆：
 *   - env.FORCE_VCR='1' —— 在 bun run 下显式打开 VCR（默认 NODE_ENV 非 test 时关闭）
 *   - 连跑两次：第一次录制 fixture，第二次回放命中（断点看 cache hit 分支）
 *
 * ⚠️ 若 FORCE_VCR 不足以放行（取决于 shouldUseVCR 实现），退路见 _debug/README.md：
 *    改用 `bun --inspect-wait test <file>` 并 passthrough-mock src/services/vcr.js。
 *
 * 运行：bun run "docs/.../queryModelWrappers/[3]vcr-layer/debug.isolated.ts"
 */
import { runStreaming } from '../_debug/harness.js'

await runStreaming({
  prompt: 'Reply with a single word: ok',
  env: { FORCE_VCR: '1' },
})
