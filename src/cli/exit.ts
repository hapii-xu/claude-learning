/**
 * 用于 subcommand 处理器的 CLI 退出辅助函数。
 *
 * 合并了此前在 `claude mcp *` / `claude plugin *` 处理器中
 * 被复制粘贴了约 60 次的“打印 + 抑制 lint + 退出”4-5 行代码块。
 * `: never` 返回类型让 TypeScript 能在调用处收窄控制流，
 * 无需在末尾再写 `return`。
 */
/* eslint-disable custom-rules/no-process-exit -- 集中式 CLI 退出点 */

// `return undefined as never`（并非退出后抛出）— 测试会监听
// process.exit 并允许其返回。调用处写成 `return cliError(...)`
// 是因为在 mock 下后续代码会解引用已被收窄掉的值。
// cliError 使用 console.error（测试监听 console.error）；cliOk 使用
// process.stdout.write（测试监听 process.stdout.write — Bun 的 console.log
// 不会经过被监听的 process.stdout.write）。

/** 将错误信息写入 stderr（如果提供了）并以退出码 1 退出。 */
export function cliError(msg?: string): never {
  if (msg) console.error(msg)
  process.exit(1)
  return undefined as never
}

/** 将消息写入 stdout（如果提供了）并以退出码 0 退出。 */
export function cliOk(msg?: string): never {
  if (msg) process.stdout.write(msg + '\n')
  process.exit(0)
  return undefined as never
}
