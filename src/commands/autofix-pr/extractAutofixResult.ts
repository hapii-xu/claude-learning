// 从远程 autofix-pr 会话日志中提取 <autofix-result> 标签。
//
// 远程 agent 会把一段结构化 XML 块作为最终消息输出（由 launchAutofixPr.ts
// 中的 initialMessage 指示它这么做）。该标签携带 PR 维度的结果数据 ——
// push 的 commit、改动的文件、CI 状态、摘要 —— 这些是框架通用的
// 「task completed」通知无法表达的。我们通过把标签原样注入消息队列
// 来传递给本地模型（与 <remote-review> 的处理方式一致）。
//
// 能稳健应对两种生产环境的现实情况：
//   1. 标签可能出现在 assistant 文本块中，也可能出现在 hook stdout 中
//      （部分 autofix skill 会用 hook 包裹最终报告）。
//   2. 标签可能根本不出现（较老的 agent、被截断的运行）——
//      调用方会回退到通用完成通知。

import type {
  SDKAssistantMessage,
  SDKMessage,
} from '../../entrypoints/agentSdkTypes.js'

export const AUTOFIX_RESULT_TAG = 'autofix-result'

const TAG_OPEN = `<${AUTOFIX_RESULT_TAG}>`
const TAG_CLOSE = `</${AUTOFIX_RESULT_TAG}>`

/**
 * 遍历会话日志寻找 <autofix-result> 标签。返回完整标签
 * （包含首尾分隔符），以便调用方原样注入到通知中；若不存在则返回 null。
 *
 * 搜索顺序：
 *   1. 最新的 hook_progress / hook_response stdout（使用 hook 格式化报告的
 *      autofix skill 会先写到这里）。
 *   2. 最新的 assistant 文本块（不使用 hook 的 agent 会把标签内联写在
 *      最终消息中）。
 *
 * 「最新优先」保证了同一会话内的重试不会把陈旧的早期结果再抛出来。
 */
export function extractAutofixResultFromLog(log: SDKMessage[]): string | null {
  // 倒序遍历，这样能先命中最近的标签。
  for (let i = log.length - 1; i >= 0; i--) {
    const msg = log[i]
    if (!msg) continue

    // Hook stdout（subtype 为 hook_progress / hook_response 的 system 消息）。
    if (
      msg.type === 'system' &&
      (msg.subtype === 'hook_progress' || msg.subtype === 'hook_response')
    ) {
      const stdout = (msg as { stdout?: unknown }).stdout
      if (typeof stdout === 'string') {
        const extracted = extractBetween(stdout, TAG_OPEN, TAG_CLOSE)
        if (extracted) return extracted
      }
      continue
    }

    // assistant 文本块。
    if (msg.type === 'assistant') {
      const content = (msg as SDKAssistantMessage).message?.content
      if (!content || typeof content === 'string') continue
      for (const block of content as Array<{ type: string; text?: string }>) {
        if (block.type !== 'text' || typeof block.text !== 'string') continue
        if (!block.text.includes(TAG_OPEN)) continue
        const extracted = extractBetween(block.text, TAG_OPEN, TAG_CLOSE)
        if (extracted) return extracted
      }
    }
  }
  return null
}

// 从最新到最早遍历开标签，返回第一个完整的 open/close 对。
// 防止被截断的最终标签遮蔽同一文本块中更早的完整对
// （例如重试时先写了完整结果，随后模型又起了一个被截断的标签）。
function extractBetween(
  text: string,
  open: string,
  close: string,
): string | null {
  let searchFrom = text.length
  while (searchFrom >= 0) {
    const start = text.lastIndexOf(open, searchFrom)
    if (start === -1) return null
    const end = text.indexOf(close, start + open.length)
    if (end !== -1) return text.slice(start, end + close.length)
    searchFrom = start - 1
  }
  return null
}
