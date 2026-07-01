/**
 * queryLoop 调试 harness（真实 API 调用 + 真实回合循环版）
 * ──────────────────────────────────────────────────────────────────────────
 * `queryLoop()`（query.ts:540）是**未导出**的内部函数，唯一入口是 `query()`（query.ts:359），
 * 后者经 `yield*` 委托前者。所以本 harness **薄封装** query 系列的驱动核心 `runQuery`——
 * 一次运行就同时穿过 query 与 queryLoop，断点全部打在 `queryLoop` 内部（query.ts:540-2457）。
 *
 * 共享同一套 bootstrap（MACRO / feature mock / enableConfigs /
 * applySafeConfigEnvironmentVariables / buildToolUseContext / 手动驱动 generator 拿 Terminal），
 * 见 ../../query/_debug/harness.ts。
 *
 * ⚠️ 真实工具副作用 + 真实计费：默认 canUseTool 自动放行所有工具，跑真实完整回合，
 *    模型发 tool_use 会真实执行（含 Bash / 写文件）。已用 maxTurns + maxOutputTokensOverride 收窄。
 */
export {
  runQuery,
  setFeatures,
  type RunQueryOverrides,
  type RunQueryResult,
} from '../../query/_debug/harness.js'

import { runQuery, type RunQueryOverrides } from '../../query/_debug/harness.js'

/**
 * 循环向 preset：全量 tools + 一个能诱导工具调用的 prompt，
 * 用于观察 [9]api-call-stream / [14]tool-execution / [15]attachments-next-turn
 * 的「发请求→跑工具→续轮」闭环。⚠️ 模型可能真实执行工具。
 */
export function runWithToolLoop(
  overrides: RunQueryOverrides = {},
): ReturnType<typeof runQuery> {
  return runQuery({
    prompt:
      'List the files in the current directory using a tool, then say done.',
    maxTurns: 3,
    ...overrides,
  })
}

/**
 * 循环向 preset：注入一段超长历史（重复文本撑大 token），
 * 用于触发压缩家族 [5]/[6]/[8] 与恢复家族 [12]（接近/超出窗口上限）。
 */
export function runWithBigHistory(
  opts: { repeat?: number } & RunQueryOverrides = {},
): ReturnType<typeof runQuery> {
  const { repeat = 400, ...rest } = opts
  const blob = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '
  const messages = Array.from({ length: repeat }, (_, i) => ({
    type: i % 2 === 0 ? 'user' : 'assistant',
    uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    message: {
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: i % 2 === 0 ? blob.repeat(20) : `ack ${i}`,
    },
  }))
  messages.push({
    type: 'user',
    uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: 'Reply with a single word: ok' },
  })
  return runQuery({ messages, maxTurns: 1, ...rest })
}
