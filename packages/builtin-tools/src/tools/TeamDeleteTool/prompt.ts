export function getPrompt(): string {
  return `
# TeamDelete

当 swarm 工作完成时，移除团队和任务目录。

此操作会：
- 移除团队目录（\`~/.hclaude/teams/{team-name}/\`）
- 移除任务目录（\`~/.hclaude/tasks/{team-name}/\`）
- 清除当前会话的团队上下文

**重要**：如果团队仍有活跃成员，TeamDelete 会失败。请先优雅终止 teammate，等所有 teammate 关闭后再调用 TeamDelete。

当所有 teammate 都已完成工作，你想清理团队资源时使用。团队名称会自动从当前会话的团队上下文中获取。
`.trim()
}
