import { isAgentSwarmsEnabled } from 'src/utils/agentSwarmsEnabled.js'

export const DESCRIPTION = '列出任务列表中的所有任务'

export function getPrompt(): string {
  const teammateUseCase = isAgentSwarmsEnabled()
    ? `- 向队友分配任务前，查看可用任务
`
    : ''

  const idDescription = isAgentSwarmsEnabled()
    ? '- **id**：任务标识符（与 TaskGet、TaskUpdate 配合使用）'
    : '- **id**：任务标识符（与 TaskGet、TaskUpdate 配合使用）'

  const teammateWorkflow = isAgentSwarmsEnabled()
    ? `
## 队友工作流

作为队友工作时：
1. 完成当前任务后，调用 TaskList 寻找可用工作
2. 寻找 status 为 'pending'、无 owner 且 blockedBy 为空的任务
3. **优先按 ID 顺序处理任务**（最小 ID 优先），因为早期任务通常为后续任务奠定上下文
4. 使用 TaskUpdate（将 \`owner\` 设为你的名字）认领可用任务，或等待 leader 分配
5. 如果被阻塞，专注于解除阻塞的任务或通知 team lead
`
    : ''

  return `使用此工具列出任务列表中的所有任务。

## 何时使用此工具

- 查看可处理的任务（status: 'pending'，无 owner，未被阻塞）
- 检查项目整体进度
- 找出被阻塞且需要解决依赖的任务
${teammateUseCase}- 完成一个任务后，检查是否有新解锁的工作，或认领下一个可用任务
- **优先按 ID 顺序处理任务**（最小 ID 优先），因为早期任务通常为后续任务奠定上下文

## 输出

返回每个任务的摘要：
${idDescription}
- **subject**：任务简要描述
- **status**：'pending'、'in_progress' 或 'completed'
- **owner**：已分配时为 Agent ID，可认领时为空
- **blockedBy**：必须先解决的未完成任务 ID 列表（有 blockedBy 的任务在依赖解决前无法认领）

使用 TaskGet 加上具体任务 ID 查看完整详情，包括描述和备注。
${teammateWorkflow}`
}
