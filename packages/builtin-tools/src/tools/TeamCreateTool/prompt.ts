export function getPrompt(): string {
  return `
# TeamCreate

## 何时使用

在以下情况主动使用此工具：
- 用户明确要求使用团队、swarm 或一组 agent
- 用户提到希望 agent 协同工作、协调或合作
- 任务足够复杂，能够从多个 agent 并行工作中受益（例如构建一个同时涉及前后端的完整功能、在保持测试通过的前提下重构代码库、实施一个包含调研、规划和编码阶段的多步骤项目）

拿不准某项任务是否值得用团队时，优先创建团队。

## 为 Teammate 选择 Agent 类型

通过 Agent 工具生成 teammate 时，请根据任务所需工具选择 \`subagent_type\`。每种 agent 类型都有不同的可用工具集 - 把 agent 和工作匹配起来：

- **只读 agent**（如 Explore、Plan）无法编辑或写入文件。只能分配调研、搜索或规划类任务。绝不要给它们分配实现类工作。
- **全能力 agent**（如 general-purpose）可访问包括文件编辑、写入和 bash 在内的全部工具。用于需要做出改动的任务。
- **在 \`.hclaude/agents/\` 中定义的自定义 agent** 可能有自己的工具限制。阅读它们的描述以了解能做什么、不能做什么。

为 teammate 选择 \`subagent_type\` 前，务必查看 Agent 工具 prompt 中列出的 agent 类型描述及其可用工具。

创建一个新团队来协调多个 agent 共同完成一个项目。团队与任务列表一一对应（Team = TaskList）。

\`\`\`
{
  "team_name": "my-project",
  "description": "Working on feature X"
}
\`\`\`

这会创建：
- 位于 \`~/.hclaude/teams/{team-name}/config.json\` 的团队文件
- 位于 \`~/.hclaude/tasks/{team-name}/\` 的对应任务列表目录

## 团队工作流

1. **创建团队** - 使用 TeamCreate，同时创建团队及其任务列表
2. **创建任务** - 使用 Task 工具（TaskCreate、TaskList 等）- 它们会自动使用团队的任务列表
3. **生成 teammate** - 使用 Agent 工具，传入 \`team_name\` 和 \`name\` 参数，创建加入团队的 teammate
4. **分配任务** - 使用 TaskUpdate 配合 \`owner\` 把任务派给空闲的 teammate
5. **Teammate 完成被分配的任务** - 并通过 TaskUpdate 标记为 completed
6. **Teammate 在回合之间进入空闲** - 每次回合结束后，teammate 会自动空闲并发送通知。重要：对空闲 teammate 保持耐心！在它真正影响到你的工作前，不要评论其空闲状态。
7. **关闭团队** - 任务完成后，通过 SendMessage 配合 \`message: {type: "shutdown_request"}\` 优雅地关闭 teammate。

## 任务归属

任务通过 TaskUpdate 的 \`owner\` 参数进行分配。任何 agent 都可以通过 TaskUpdate 设置或更改任务归属。

## 自动消息投递

**重要**：来自 teammate 的消息会自动投递给你。你无需手动检查收件箱。

当你生成 teammate 后：
- 它们完成任务或需要帮助时会给你发消息
- 这些消息会作为新的对话回合自动出现（类似用户消息）
- 如果你正忙（回合进行中），消息会排队并在你的回合结束后投递
- 有消息待处理时，UI 会显示一条带发件人名称的简短通知

消息会自动投递。

汇报 teammate 的消息时，无需引用原消息 - 它已展示给用户。

## Teammate 空闲状态

Teammate 在每次回合结束后都会空闲 - 这完全正常且符合预期。teammate 发消息给你后立刻空闲并不代表它已完成或不可用。空闲仅意味着它正在等待输入。

- **空闲 teammate 可以接收消息。** 向空闲 teammate 发送消息会唤醒它，它会正常处理。
- **空闲通知是自动的。** 系统在 teammate 回合结束时发送空闲通知。除非你想分配新工作或发送后续消息，否则无需响应空闲通知。
- **不要把空闲当作错误。** teammate 发消息后进入空闲是正常流程 - 它已发出消息，正在等待响应。
- **Peer DM 可见性。** 当 teammate 向另一 teammate 发送 DM 时，其空闲通知中会包含简短摘要。这让你能了解 peer 协作情况，而无需完整消息内容。你无需对这些摘要作出响应 - 它们仅作信息说明。

## 发现团队成员

Teammate 可以读取团队配置文件以发现其他成员：
- **团队配置位置**：\`~/.hclaude/teams/{team-name}/config.json\`

配置文件包含 \`members\` 数组，每个 teammate 包含：
- \`name\`：人类可读名称（**始终使用此项** 进行消息和任务分配）
- \`agentId\`：唯一标识符（仅供参考 - 不要用于通信）
- \`agentType\`：agent 的角色/类型

**重要**：始终使用 NAME 称呼 teammate（例如 "team-lead"、"researcher"、"tester"）。名称用于：
- 发送消息时的 \`to\`
- 标识任务负责人

读取团队配置示例：
\`\`\`
使用 Read 工具读取 ~/.hclaude/teams/{team-name}/config.json
\`\`\`

## 任务列表协调

团队共享一个任务列表，所有 teammate 都能访问 \`~/.hclaude/tasks/{team-name}/\`。

Teammate 应当：
1. 定期检查 TaskList，**尤其是在完成每个任务之后**，以查找可用工作或新解除阻塞的任务
2. 用 TaskUpdate 认领未被分配、未被阻塞的任务（把 \`owner\` 设为你的名字）。**优先按 ID 顺序**（ID 最小的先做）处理多个可用任务，因为较早的任务往往为后续任务铺垫上下文
3. 在识别出额外工作时用 \`TaskCreate\` 创建新任务
4. 完成后用 \`TaskUpdate\` 标记任务为 completed，然后查看 TaskList 找下一项工作
5. 通过阅读任务列表状态与其他 teammate 协调
6. 如果所有可用任务都被阻塞，通知团队负责人或帮助解除阻塞任务

**与团队沟通的重要注意事项**：
- 不要使用终端工具查看团队活动；始终向 teammate 发送消息（并记得用名字称呼）。
- 如果不使用 SendMessage 工具，你的团队听不到你。回复 teammate 时务必发送消息。
- 不要发送结构化 JSON 状态消息，例如 \`{"type":"idle",...}\` 或 \`{"type":"task_completed",...}\`。需要联系 teammate 时用纯文本即可。
- 用 TaskUpdate 标记任务完成。
- 如果你是团队中的 agent，系统会在你停止时自动向团队负责人发送空闲通知。

`.trim()
}
