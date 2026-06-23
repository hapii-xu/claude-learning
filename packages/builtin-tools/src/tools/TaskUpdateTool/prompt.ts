export const DESCRIPTION = '更新任务列表中的任务'

export const PROMPT = `使用此工具更新任务列表中的任务。

## 何时使用此工具

**标记任务为已完成：**
- 当你完成了某项任务中描述的工作
- 当某项任务已不再需要或被取代
- 重要：完成分配给你的任务后，务必将其标记为已完成
- 标记完成后，调用 TaskList 查找下一个任务

- 只有在你已完全完成一项任务时，才能将其标记为 completed
- 如果遇到错误、阻塞或无法完成，请保持任务为 in_progress
- 当被阻塞时，创建一个新任务描述需要解决的问题
- 出现以下情况时绝不标记为 completed：
  - 测试正在失败
  - 实现尚不完整
  - 遇到未解决的错误
  - 无法找到必需的文件或依赖

**删除任务：**
- 当任务不再相关或创建有误
- 把 status 设为 \`deleted\` 将永久移除该任务

**更新任务详情：**
- 当需求发生变化或变得更清晰
- 当需要建立任务之间的依赖关系

## 可更新的字段

- **status**：任务状态（见下方状态工作流）
- **subject**：修改任务标题（祈使句形式，例如 "Run tests"）
- **description**：修改任务描述
- **activeForm**：处于 in_progress 时在 spinner 中显示的现在进行时形式（例如 "Running tests"）
- **owner**：修改任务负责人（agent 名称）
- **metadata**：将 metadata 键合并到任务中（把某个键设为 null 可删除它）
- **addBlocks**：标记必须等此任务完成后才能开始的任务
- **addBlockedBy**：标记必须完成后此任务才能开始的任务

## 状态工作流

状态流转：\`pending\` → \`in_progress\` → \`completed\`

使用 \`deleted\` 永久移除一个任务。

## 状态时效

更新前请务必使用 \`TaskGet\` 读取任务的最新状态。

## 示例

开始工作时把任务标记为 in_progress：
\`\`\`json
{"taskId": "1", "status": "in_progress"}
\`\`\`

完成工作后把任务标记为 completed：
\`\`\`json
{"taskId": "1", "status": "completed"}
\`\`\`

删除任务：
\`\`\`json
{"taskId": "1", "status": "deleted"}
\`\`\`

通过设置 owner 认领任务：
\`\`\`json
{"taskId": "1", "owner": "my-name"}
\`\`\`

设置任务依赖：
\`\`\`json
{"taskId": "2", "addBlockedBy": ["1"]}
\`\`\`
`
