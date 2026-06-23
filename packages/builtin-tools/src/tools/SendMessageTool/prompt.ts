import { feature } from 'bun:bundle'

export const DESCRIPTION = '向另一个 agent 发送消息'

export function getPrompt(): string {
  const udsRow = feature('UDS_INBOX')
    ? `\n| \`"uds:/path/to.sock"\` | 本机 Claude 会话 socket（同一机器；使用 \`ListPeers\`）|
| \`"bridge:session_..."\` | Remote Control 对等会话（跨机器；使用 \`ListPeers\`）|`
    : ''
  const udsSection = feature('UDS_INBOX')
    ? `\n\n## 跨会话通信

使用 \`ListPeers\` 发现目标，然后：

\`\`\`json
{"to": "uds:/tmp/cc-socks/1234.sock", "message": "check if tests pass over there"}
{"to": "bridge:session_01AbCd...", "message": "what branch are you on?"}
\`\`\`

已列出的 peer 是活跃的，会处理你的消息——没有"忙碌"状态；消息会在接收方的下一个工具轮次入队并消费。你的消息会以 \`<cross-session-message from="...">\` 的形式到达。**要回复收到的消息，将其 \`from\` 属性复制为你的 \`to\`。**`
    : ''
  return `
# SendMessage

向另一个 agent 发送消息。

\`\`\`json
{"to": "researcher", "summary": "assign task 1", "message": "start on task #1"}
\`\`\`

| \`to\` | |
|---|---|
| \`"researcher"\` | 按名称指定队友 |
| \`"*"\` | 广播给所有队友——开销较大（与团队规模成线性关系），仅在所有人都真正需要时使用 |${udsRow}

你的纯文本输出对其他 agent 不可见——要通信，必须调用此工具。队友的消息会自动送达；你无需查收收件箱。通过名称而非 UUID 称呼队友。转发消息时，不要引用原文——原文已经渲染给用户了。${udsSection}

## 协议响应（旧版）

如果你收到带有 \`type: "shutdown_request"\` 或 \`type: "plan_approval_request"\` 的 JSON 消息，请用对应的 \`_response\` 类型回复——回传 \`request_id\`，设置 \`approve\` 为 true/false：

\`\`\`json
{"to": "team-lead", "message": {"type": "shutdown_response", "request_id": "...", "approve": true}}
{"to": "researcher", "message": {"type": "plan_approval_response", "request_id": "...", "approve": false, "feedback": "add error handling"}}
\`\`\`

批准 shutdown 会终止你的进程。拒绝计划会让队友回去修改。除非被要求，否则不要发起 \`shutdown_request\`。不要发送结构化 JSON 状态消息——使用 TaskUpdate。
`.trim()
}
