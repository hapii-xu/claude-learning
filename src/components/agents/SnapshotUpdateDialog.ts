import React from 'react'
import { Dialog, Text } from '@anthropic/ink'
import type { AgentMemoryScope } from '@claude-code-best/builtin-tools/tools/AgentTool/agentMemory.js'
import { Select } from '../CustomSelect/index.js'

interface SnapshotUpdateDialogProps {
  agentType: string
  scope: AgentMemoryScope
  snapshotTimestamp: string
  onComplete: (choice: 'merge' | 'keep' | 'replace') => void
  onCancel: () => void
}

// 这里使用 React.createElement 而非 JSX，以便真正的实现
// 可以放在 .ts 文件中（本仓库中 bun 的 `.js` import 解析器会优先
// 加载 .tsx，若两种扩展名并存，会用空的 .tsx 把本模块覆盖掉）。
export function SnapshotUpdateDialog({
  agentType,
  scope,
  snapshotTimestamp,
  onComplete,
  onCancel,
}: SnapshotUpdateDialogProps): React.ReactElement {
  const children = [
    React.createElement(
      Text,
      { dimColor: true, key: 'timestamp' },
      `快照时间戳：${snapshotTimestamp}`,
    ),
    React.createElement(Select, {
      key: 'select',
      defaultFocusValue: 'merge',
      options: [
        {
          label: '将快照合并到当前记忆',
          value: 'merge',
          description: '保留当前记忆，并请求 Claude 将快照中的变更合并进来。',
        },
        {
          label: '保留当前记忆',
          value: 'keep',
          description: '忽略本次快照更新，继续使用当前记忆。',
        },
        {
          label: '用快照替换',
          value: 'replace',
          description: '用快照内容覆盖当前的记忆文件。',
        },
      ],
      onChange: onComplete as (value: unknown) => void,
    }),
  ]
  return React.createElement(Dialog, {
    title: 'Agent 记忆快照更新',
    subtitle: `${agentType} 存在更新的 ${scope} 记忆快照。`,
    onCancel,
    color: 'warning' as const,
    children,
  })
}

export function buildMergePrompt(
  agentType: string,
  scope: AgentMemoryScope,
): string {
  return `"${agentType}" agent 存在更新的 ${scope} 持久化记忆快照。

请在继续之前，将快照更新合并到当前的 ${scope} agent 记忆中：
- 保留有用的现有记忆条目。
- 融入快照中更新的、更准确的信息。
- 处理重复或冲突时，以最新、最具体的信息为准。
- 保持记忆简洁，并与该 agent 后续运行相关。

合并完成后，继续处理用户的请求。`
}
