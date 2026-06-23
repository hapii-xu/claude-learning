export const DESCRIPTION = '按 ID 从任务列表获取一个任务'

export const PROMPT = `使用此工具通过 ID 从任务列表中获取一个任务。

## 何时使用此工具

- 开始处理任务前，需要完整描述和上下文时
- 了解任务依赖关系时（它阻塞了什么、什么阻塞了它）
- 被分配任务后，获取完整需求时

## 输出

返回完整的任务详情：
- **subject**：任务标题
- **description**：详细需求和上下文
- **status**：'pending'、'in_progress' 或 'completed'
- **blocks**：等待此任务完成的任务
- **blockedBy**：必须在此任务开始前完成的任务

## 提示

- 获取任务后，开始工作前请确认其 blockedBy 列表为空。
- 使用 TaskList 以摘要形式查看所有任务。
`
