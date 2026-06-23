export function getEnterWorktreeToolPrompt(): string {
  return `仅当用户明确要求在 worktree 中工作时才使用此工具。此工具会创建一个隔离的 git worktree，并将当前会话切换到其中。

## 何时使用

- 用户明确说出 "worktree"（例如 "启动一个 worktree"、"在 worktree 中工作"、"创建一个 worktree"、"使用 worktree"）

## 何时不使用

- 用户要求创建分支、切换分支或在其他分支上工作 —— 改用 git 命令
- 用户要求修复 bug 或开发功能 —— 使用常规 git 工作流，除非他们明确提到 worktree
- 除非用户明确提到 "worktree"，否则绝不要使用此工具

## 前置要求

- 必须处于 git 仓库中，或在 settings.json 中配置了 WorktreeCreate/WorktreeRemove hooks
- 必须当前不在 worktree 中

## 行为

- 在 git 仓库中：在 \`.claude/worktrees/\` 下基于 HEAD 创建一个新的 git worktree 及新分支
- 在 git 仓库之外：委托给 WorktreeCreate/WorktreeRemove hooks 实现 VCS 无关的隔离
- 将会话的工作目录切换到新的 worktree
- 使用 ExitWorktree 可在会话中途离开 worktree（保留或移除）。会话退出时若仍处于 worktree 中，会提示用户保留还是移除它

## 参数

- \`name\`（可选）：worktree 的名称。若未提供，则生成一个随机名称。
`
}
