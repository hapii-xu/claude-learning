/**
 * [5] helpers —— src/services/api/claude.ts:1060-1292
 * ──────────────────────────────────────────────────────────────────────────
 * 包装层周边一圈小工具：
 *   - shouldDeferLspTool（1060）         LSP 工具是否延迟加载（未导出，断点观察）
 *   - getNonstreamingFallbackTimeoutMs（1079） 降级超时（120s/300s）
 *   - getPreviousRequestIdFromMessages（1205） 从历史里取上一条 requestId（未导出，断点观察）
 *   - stripExcessMediaItems（1233）       裁掉超量 media block（已导出，可直接调）
 *
 * 本文件分两段：
 *   ① 直接调 stripExcessMediaItems（已导出），喂一组含大量 media 的 messages 看裁剪；
 *   ② 跑一次 runStreaming，在 1205 / 1060 打断点观察未导出的两个 helper。
 *
 * 建议断点：claude.ts:1233（strip）、1205（previousRequestId）、1060（deferLsp）。
 *
 * 运行：bun run "docs/.../queryModelWrappers/[5]helpers/debug.isolated.ts"
 */
import { runStreaming } from '../_debug/harness.js'

// ① 直接调已导出的 stripExcessMediaItems（无 API 调用）
const { stripExcessMediaItems } = await import('src/services/api/claude.js')
const manyImages = Array.from({ length: 30 }, () => ({
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
}))
const messagesWithMedia = [
  {
    type: 'user',
    uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: manyImages },
  },
]
const stripped = (stripExcessMediaItems as any)(messagesWithMedia)
console.error(
  `[harness] stripExcessMediaItems  in=${messagesWithMedia.length} out=${stripped?.length}`,
)

// ② 跑一次流式，在 1205 / 1060 打断点观察未导出的 helper（带 requestId 的历史 / LSP 工具）
await runStreaming({
  prompt: 'Reply with a single word: ok',
})
