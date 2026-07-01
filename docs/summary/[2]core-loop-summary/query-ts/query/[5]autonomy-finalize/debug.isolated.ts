/**
 * [5] autonomy-finalize —— src/query.ts:433-456
 * ──────────────────────────────────────────────────────────────────────────
 * finally① autonomy 命令收尾：本回合若消费了 autonomy 命令（consumedAutonomyCommands），
 * 在 finally 里把后续命令 enqueue 回队列，保证「自动模式」链路不断。
 *
 * 建议断点：query.ts:433（autonomy 收尾起点）、enqueue 处。
 *
 * 控制杆：
 *   - features: 点亮 autonomy 相关 flag（如 'AGENT_TRIGGERS' 等，按需）
 *   - messages: 构造带 autonomy 命令的历史，使 consumedAutonomyCommands 非空
 *
 * 说明：默认环境（无 autonomy 命令）此节多为空操作；要观察 enqueue 需点亮 feature
 * 并喂入 autonomy 命令。先在 433 断点确认是否进入。
 *
 * ⚠️ 真实工具副作用 + 真实计费。
 * 运行：bun run "docs/.../query-ts/query/[5]autonomy-finalize/debug.isolated.ts"
 */
import { runQuery } from '../_debug/harness.js'

await runQuery({
  prompt: 'Reply with a single word: ok',
  maxTurns: 1,
  // features: ['AGENT_TRIGGERS'],
})
