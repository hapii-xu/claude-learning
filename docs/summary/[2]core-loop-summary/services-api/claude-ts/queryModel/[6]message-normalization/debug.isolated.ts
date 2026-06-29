/**
 * [6] message-normalization —— src/services/api/claude.ts:1565-1672
 * ──────────────────────────────────────────────────────────────────────────
 * 消息归一化 / 后处理 / 指纹：normalizeMessagesForAPI、过量媒体裁剪
 * （stripExcessMediaItems，claude.ts:1233）、tool_result 配对、指纹计算等。
 *
 * 建议断点：claude.ts:1565 起；stripExcessMediaItems（claude.ts:1233）。
 *
 * 控制杆（改 messages 的内容形态）：
 *   - content 为 string vs content blocks 数组
 *   - 含 image/document 媒体块（看裁剪 API_MAX_MEDIA_PER_REQUEST）
 *   - 含 tool_use / tool_result 配对
 *
 * 下面构造一条「文本 + 图片块」的用户消息，便于在归一化/裁剪处下断点观察。
 *
 * 运行：bun --inspect-wait run "docs/.../queryModel/[6]message-normalization/debug.isolated.ts"
 */
import { runQueryModel } from '../_debug/harness.js'

await runQueryModel({
  messages: [
    {
      type: 'user',
      uuid: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'Reply with a single word: ok' },
          // 1x1 透明 PNG，作为媒体块触发归一化/裁剪逻辑
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
            },
          },
        ],
      },
    },
  ],
})
