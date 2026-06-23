import { isAgentSwarmsEnabled } from 'src/utils/agentSwarmsEnabled.js'

export const DESCRIPTION = '在任务列表中创建一个新任务'

export function getPrompt(): string {
  const teammateContext = isAgentSwarmsEnabled()
    ? '，并可能被分配给 teammate'
    : ''

  const teammateTips = isAgentSwarmsEnabled()
    ? `- 在 description 中提供足够的细节，以便另一个 agent 能够理解并完成任务
- 新建任务的状态为 'pending' 且没有 owner —— 使用 TaskUpdate 的 \`owner\` 参数来分配任务
`
    : ''

  return `使用此工具为当前编码会话创建结构化的任务列表。这有助于跟踪进度、整理复杂任务，并向用户展示工作的全面性。
它也帮助用户了解任务的进展和整体请求的完成情况。

## 何时使用此工具

在以下情况主动使用此工具：

- 复杂的多步骤任务——当任务需要 3 个或更多独立步骤或操作时
- 非简单的复杂任务——需要仔细规划或多步操作的任务${teammateContext}
- Plan mode——使用 plan mode 时，创建任务列表来追踪工作
- 用户明确请求待办列表——用户直接要求使用待办列表时
- 用户提供多个任务——用户提供了一组待办事项时（编号或逗号分隔）
- 收到新指令后——立即将用户需求记录为任务
- 开始处理任务时——在开始工作前将任务标记为 in_progress
- 完成任务后——将其标记为 completed，并添加实现过程中发现的新后续任务

## 何时不使用此工具

在以下情况跳过此工具：
- 只有一个简单直接的任务
- 任务非常简单，跟踪它没有任何组织价值
- 任务可以在不到 3 个简单步骤内完成
- 任务纯粹是对话性或信息性的

注意：如果只有一个简单任务，不要使用此工具，直接完成任务更好。

## 任务字段

- **subject**：简短的、以祈使形式描述的可操作标题（例如"修复登录流程中的身份验证 bug"）
- **description**：需要完成的内容
- **activeForm**（可选）：任务处于 in_progress 时在进度条中显示的进行时形式（例如"正在修复身份验证 bug"）。如果省略，进度条显示 subject。

所有任务创建时状态为 \`pending\`。

## 提示

- 创建任务时使用清晰、具体的 subject 来描述预期结果
- 创建任务后，如需设置依赖关系（blocks/blockedBy），使用 TaskUpdate
${teammateTips}- 先查看 TaskList，避免创建重复任务
`
}
