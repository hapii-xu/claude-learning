/**
 * [6] reorderAttachmentsForAPI（真实 queryModel 调用版）—— src/utils/messages.ts:1761
 * ──────────────────────────────────────────────────────────────────────────
 * 跑完整 queryModel 主流程，让「attachment 向上冒泡重排」逻辑在业务主流程里
 * 被触发——便于在断点里观察：attachment 消息是怎么被 reorderAttachmentsForAPI
 * 移动到「停止点」之后，然后在 normalizeMessagesForAPI 里被合并进相邻的 user
 * 消息、最终变成 API 能接受的形态。
 *
 * ⭐ 断点建议（在 VS Code「Attach to Bun」或 chrome://inspect 后下）：
 *   - src/utils/messages.ts:1761          reorderAttachmentsForAPI 入口
 *     看 messages 数组的「前/后」顺序（watch 窗口里看 messages[i].type）
 *   - src/utils/messages.ts:2287          normalizeMessagesForAPI 第 ① 步调用 reorder
 *     看 reorder 输出如何流入下一步
 *   - src/utils/messages.ts:2565-2580     normalizeAttachmentForAPI + 合并
 *     看 attachment 如何被转成 user message、再和相邻 user 合并
 *   - src/services/api/claude.ts:1572     normalizeMessagesForAPI 结束处
 *     看 messagesForAPI 最终长什么样（role 交替、无 attachment 残留）
 *
 * ⭐ 本场景构造：
 *   [0] assistant 「上一轮回答」         ← 停止点
 *   [1] user      「谢谢」              ← 普通 user，不是停止点
 *   [2] attachment (opened_file_in_ide) ← 应该越过 user[1]，向上冒泡到 asst[0] 之后
 *   [3] user      「看看这个文件」
 *
 *   reorder 后：
 *   [0] assistant
 *   [1] attachment                      ← 已冒泡到 asst[0] 正后方
 *   [2] user 「谢谢」
 *   [3] user 「看看这个文件」
 *
 *   normalize 后（attachment → user message + 与相邻 user 合并）：
 *   [0] assistant
 *   [1] user 「用户打开了 X.ts ... 谢谢 ... 看看这个文件」
 *
 *   最终发出去的 messages 是 2 条（role 交替），模型正常响应。
 *
 * 运行：bun --inspect-wait run "docs/.../queryModel/[6]message-normalization/debug.isolated.reorder.ts"
 *
 * ⚠️ 真实计费：会消耗真实 token（默认最大输出 128 token 省成本）。
 */
import { runQueryModel } from '../_debug/harness.js'

const uuid = () => crypto.randomUUID()
const ts = () => new Date().toISOString()

// ── 构造一段含「错位 attachment」的对话 ─────────────────────────────────────
// opened_file_in_ide 是最简单的 attachment 类型之一 —— 只需要 filename，
// normalizeAttachmentForAPI 会把它转成「用户打开了 X」的 user message。
const messages = [
  // [0] assistant 上一轮回答 —— 这是 attachment 冒泡的「停止点」
  {
    type: 'assistant' as const,
    uuid: uuid(),
    timestamp: ts(),
    message: {
      id: uuid(),
      role: 'assistant',
      model: 'sonnet',
      stop_reason: 'end_turn',
      content: [
        {
          type: 'text' as const,
          text: '上一轮我回答了关于 TypeScript 的问题。',
        },
      ],
    },
  },
  // [1] 普通 user 文本 —— 不是停止点（stop 条件要求首块是 tool_result 或 assistant）
  {
    type: 'user' as const,
    uuid: uuid(),
    timestamp: ts(),
    message: { role: 'user', content: '谢谢' },
  },
  // [2] ⭐ 错位 attachment：本应紧贴 asst[0] 之后，但现在夹在两条 user 之间
  //     reorder 会把它「冒泡」到 asst[0] 正后方
  {
    type: 'attachment' as const,
    uuid: uuid(),
    timestamp: ts(),
    attachment: {
      type: 'opened_file_in_ide' as const,
      filename: 'src/utils/example.ts',
    },
  },
  // [3] 用户的真正问题
  {
    type: 'user' as const,
    uuid: uuid(),
    timestamp: ts(),
    message: { role: 'user', content: '帮我看看这个文件里的代码' },
  },
]

// 运行完整 queryModel。断点里 step into normalizeMessagesForAPI 能看到：
//   1) reorderAttachmentsForAPI 把 attachment 从 idx2 移到 idx1
//   2) normalizeAttachmentForAPI 把 attachment 转成 user message「用户打开了...」
//   3) mergeUserMessagesAndToolResults 把相邻的 user 合并成一条
//   4) 最终 messagesForAPI = [assistant, user(合并后)] —— role 交替、无 attachment 残留
await runQueryModel({
  messages,
  options: { maxOutputTokensOverride: 128 },
})

// ── 想试「冒泡到顶端」（没有任何停止点）？把 messages 替换为以下之一重跑 ───
//
// 📌 上方没有任何 assistant —— attachment 一路冒泡到 messages[0]
// const messages = [
//   { type: 'user', uuid: uuid(), timestamp: ts(),
//     message: { role: 'user', content: '你好' } },
//   { type: 'attachment', uuid: uuid(), timestamp: ts(),
//     attachment: { type: 'opened_file_in_ide', filename: 'foo.ts' } },
//   { type: 'user', uuid: uuid(), timestamp: ts(),
//     message: { role: 'user', content: '看看这个文件' } },
// ]
//
// 📌 多个 attachment 成簇冒泡到「上方停止点」之后，相对顺序保留
// const messages = [
//   { type: 'assistant', uuid: uuid(), timestamp: ts(),
//     message: { id: uuid(), role: 'assistant', model: 'sonnet',
//       stop_reason: 'end_turn',
//       content: [{ type: 'text', text: '回答 1' }] } },
//   { type: 'user', uuid: uuid(), timestamp: ts(),
//     message: { role: 'user', content: '中间普通文本' } },
//   { type: 'attachment', uuid: uuid(), timestamp: ts(),
//     attachment: { type: 'opened_file_in_ide', filename: 'a.ts' } },
//   { type: 'attachment', uuid: uuid(), timestamp: ts(),
//     attachment: { type: 'opened_file_in_ide', filename: 'b.ts' } },
//   { type: 'assistant', uuid: uuid(), timestamp: ts(),
//     message: { id: uuid(), role: 'assistant', model: 'sonnet',
//       stop_reason: 'end_turn',
//       content: [{ type: 'text', text: '回答 2' }] } },
//   { type: 'user', uuid: uuid(), timestamp: ts(),
//     message: { role: 'user', content: '看这两个文件' } },
// ]
