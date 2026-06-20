/**
 * 自 mtime 以来经过的天数。向下取整 —— 今天为 0，昨天为 1，
 * 更早为 2+。负数输入（未来 mtime、时钟偏差）被钳制为 0。
 */
export function memoryAgeDays(mtimeMs: number): number {
  return Math.max(0, Math.floor((Date.now() - mtimeMs) / 86_400_000))
}

/**
 * 人类可读的时间字符串。模型不擅长日期算术 ——
 * 原始 ISO 时间戳不会像"47 天前"那样触发陈旧性推理。
 */
export function memoryAge(mtimeMs: number): string {
  const d = memoryAgeDays(mtimeMs)
  if (d === 0) return 'today'
  if (d === 1) return 'yesterday'
  return `${d} days ago`
}

/**
 * 针对超过 1 天的记忆的纯文本陈旧性提示。对于新鲜（今天/昨天）
 * 的记忆返回 '' —— 在那里警告只是噪音。
 *
 * 当消费者已经提供自己的包装时使用此函数
 * （例如 messages.ts 的 relevant_memories → wrapMessagesInSystemReminder）。
 *
 * 动机：用户报告陈旧代码状态记忆（对已更改代码的 file:line 引用）
 * 被当作事实断言 —— 引用使陈旧的声明听起来更权威，而不是更不权威。
 */
export function memoryFreshnessText(mtimeMs: number): string {
  const d = memoryAgeDays(mtimeMs)
  if (d <= 1) return ''
  return (
    `This memory is ${d} days old. ` +
    `Memories are point-in-time observations, not live state — ` +
    `claims about code behavior or file:line citations may be outdated. ` +
    `Verify against current code before asserting as fact.`
  )
}

/**
 * 用 <system-reminder> 标签包装的每条记忆的陈旧性注释。
 * 对于 ≤ 1 天前的记忆返回 ''。供不添加自己
 * system-reminder 包装的调用方使用（例如 FileReadTool 输出）。
 */
export function memoryFreshnessNote(mtimeMs: number): string {
  const text = memoryFreshnessText(mtimeMs)
  if (!text) return ''
  return `<system-reminder>${text}</system-reminder>\n`
}
