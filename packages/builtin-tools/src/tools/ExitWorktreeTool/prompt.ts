export function getExitWorktreeToolPrompt(): string {
  return `退出由 EnterWorktree 创建的 worktree 会话，并将会话返回到原始工作目录。

## 范围

此工具仅操作由本会话中 EnterWorktree 创建的 worktree。它不会触及：
- 你手动用 \`git worktree add\` 创建的 worktree
- 来自先前会话的 worktree（即使当时是由 EnterWorktree 创建的）
- 如果从未调用过 EnterWorktree，你当前所在的目录

如果在 EnterWorktree 会话之外调用，此工具是 **空操作**：它会报告没有活动的 worktree 会话且不执行任何操作。文件系统状态保持不变。

## 何时使用

- 用户明确要求"exit the worktree"、"leave the worktree"、"go back"或以其他方式结束 worktree 会话
- 不要主动调用此工具 — 仅在用户要求时调用

## 参数

- \`action\`（必需）：\`"keep"\` 或 \`"remove"\`
  - \`"keep"\` — 在磁盘上保留 worktree 目录和分支。如果用户想稍后回到此工作，或者有要保留的更改，请使用此项。
  - \`"remove"\` — 删除 worktree 目录及其分支。当工作完成或放弃时，用于干净的退出。
- \`discard_changes\`（可选，默认为 false）：仅在 \`action: "remove"\` 时有意义。如果 worktree 有未提交的文件或不在原始分支上的提交，除非将其设置为 \`true\`，否则工具将拒绝删除。如果工具返回列出更改的错误，请在用 \`discard_changes: true\` 重新调用之前与用户确认。

## 行为

- 将会话的工作目录恢复到 EnterWorktree 之前的位置
- 清除依赖 CWD 的缓存（系统提示部分、内存文件、计划目录），使会话状态反映原始目录
- 如果有附加到 worktree 的 tmux 会话：在 \`remove\` 时被杀死，在 \`keep\` 时继续运行（其名称会被返回，以便用户可以重新附加）
- 一旦退出，可以再次调用 EnterWorktree 来创建新的 worktree
`
}
