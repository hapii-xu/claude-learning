/**
 * [6] message-normalization（真实 queryModel 调用版）—— src/services/api/claude.ts:1565-1672
 * ──────────────────────────────────────────────────────────────────────────
 * 跑完整 queryModel 主流程，让归一化、配对修复、指纹等清洗函数在业务主流程
 * 里被触发——便于在断点里观察「它们是怎么被调用的、调用栈长什么样、修复前后
 * 的 messages 实际长什么样」。
 *
 * ⭐ 与 debug.pairing.ts 的区别：
 *   - debug.pairing.ts 是纯函数直调：不烧 token，只能看 messages 前后对比
 *   - 本文件是 harness 版：跑完整 queryModel，能在 claude.ts 里 step into
 *     看真实调用栈（normalizeMessagesForAPI → strip → pairing → advisor →
 *     media → fingerprint → API 请求 → 流式响应），代价是烧一次真实 API 请求
 *
 * ⭐ 断点建议（在 VS Code「Attach to Bun」或 chrome://inspect 后下）：
 *   - src/services/api/claude.ts:1572  normalizeMessagesForAPI 入口
 *     看 messages 经过第一道归一化后变什么样
 *   - src/services/api/claude.ts:1588-1601  模型切换剔除（本场景不会触发，
 *     因为没有 tool_reference/caller，可跳过或验证「不命中」分支）
 *   - src/services/api/claude.ts:1606  ensureToolResultPairing 调用点 ⭐
 *     step into 进入 messages.ts:5536，能看到：
 *     · 进入前：messages[2] 是纯文本 user（没有 tool_result）
 *     · 进入后：messages[2] 前面被补了一条 tool_result(is_error=true)
 *     · repaired=true → logEvent('tengu_tool_result_pairing_repaired')
 *   - src/services/api/claude.ts:1672  computeFingerprintFromMessages
 *     注意：此时 fingerprint 从「修复后」的 messages 计算，所以归因
 *     包含了合成 tool_result。这是设计选择（归一化在指纹之前）。
 *   - src/services/api/claude.ts:1621-1662  Provider 分流（你走的是
 *     firstParty 还是 OpenAI/Gemini/Grok 兼容层，看你 env 里的 base url）
 *
 * 本场景构造：
 *   [0] user 「帮我运行一下 echo hello」
 *   [1] assistant 请求了 Bash(toolu_ORPHAN_DEMO)，但流在 tool_result 回来之前被中断
 *   [2] user 「算了，帮我写一段打印 hello world 的代码」—— 没带 tool_result
 *
 *   API 会因 tool_use/tool_result 配对错位直接 400 —— 所以 queryModel 在发
 *   请求前必须经过 ensureToolResultPairing 补一条合成 error tool_result。
 *
 * 运行：bun --inspect-wait run "docs/.../queryModel/[6]message-normalization/debug.isolated.ts"
 * 然后 VS Code 按 F5（或「Run → Attach to Bun」）接入。
 *
 * ⚠️ 真实计费：会消耗真实 token（默认最大输出 256 token 省成本）。
 */
import { runQueryModel } from '../_debug/harness.js'

const uuid = () => crypto.randomUUID()
const ts = () => new Date().toISOString()

// ── 构造一段「被截断」的历史 ─────────────────────────────────────────────
// 模拟：assistant 上一轮请求 Bash，但结果没回来用户就发新消息了。
// 这会导致 tool_use(toolu_ORPHAN_DEMO) 没有对应 tool_result。
const messages = [
  {
    type: 'user' as const,
    uuid: uuid(),
    timestamp: ts(),
    message: { role: 'user', content: '帮我运行一下 echo hello' },
  },
  {
    type: 'assistant' as const,
    uuid: uuid(),
    timestamp: ts(),
    message: {
      id: uuid(),
      role: 'assistant',
      model: 'sonnet',
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use' as const,
          id: 'toolu_ORPHAN_DEMO',
          name: 'Bash',
          input: { command: 'echo hello' },
        },
      ],
    },
  },
  // ⭐ 关键：这条 user 没有 toolu_ORPHAN_DEMO 的 tool_result
  //    模拟「流被打断 / 远端会话恢复时 tool_result 还没回来」的情况
  {
    type: 'user' as const,
    uuid: uuid(),
    timestamp: ts(),
    message: {
      role: 'user',
      content: '算了，帮我写一段打印 hello world 的代码',
    },
  },
]

// 运行完整 queryModel。在断点里 step into ensureToolResultPairing 能看到：
//   进入前：messages[2] 是纯文本 user（只有 text 块）
//   进入后：messages[2] 前面被补了一条
//          { type: 'tool_result', tool_use_id: 'toolu_ORPHAN_DEMO',
//            content: '[Tool result missing...]', is_error: true }
//   repaired=true → logEvent('tengu_tool_result_pairing_repaired', ...)
//
// 之后继续走：advisor → media → provider 分流 → fingerprint → API 请求
// → 模型按修复后的合法消息序列正常响应。
await runQueryModel({
  messages,
  options: { maxOutputTokensOverride: 256 },
})

// ── 想试其他配对错位？把 messages 替换为以下之一重跑 ──────────────────────
//
// 📌 孤立 tool_result（与有效结果混在同一条 user）—— 触发「剔除孤儿」分支
// const messages = [
//   { type: 'user', uuid: uuid(), timestamp: ts(),
//     message: { role: 'user', content: '编辑两个文件' } },
//   { type: 'assistant', uuid: uuid(), timestamp: ts(),
//     message: { id: uuid(), role: 'assistant', model: 'sonnet',
//       stop_reason: 'tool_use',
//       content: [{ type: 'tool_use', id: 'toolu_VALID', name: 'Edit',
//                   input: { file_path: 'a.ts' } }] } },
//   { type: 'user', uuid: uuid(), timestamp: ts(),
//     message: { role: 'user', content: [
//       { type: 'tool_result', tool_use_id: 'toolu_VALID', content: 'ok' },
//       { type: 'tool_result', tool_use_id: 'toolu_GHOST', content: '孤儿' },
//     ] } },
// ]
//
// 📌 恢复会话首条 tool_result —— 触发「messages[0] 占位文本」分支
// const messages = [
//   { type: 'user', uuid: uuid(), timestamp: ts(),
//     message: { role: 'user', content: [
//       { type: 'tool_result', tool_use_id: 'toolu_DROPPED', content: '残留' },
//     ] } },
//   { type: 'assistant', uuid: uuid(), timestamp: ts(),
//     message: { id: uuid(), role: 'assistant', model: 'sonnet',
//       stop_reason: 'end_turn',
//       content: [{ type: 'text', text: '继续' }] } },
// ]
