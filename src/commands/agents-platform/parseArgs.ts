/**
 * 解析 /agents-platform 命令的参数字符串。
 *
 * 支持的子命令：
 *   list                              → { action: 'list' }
 *   create <cron-expr> <prompt>       → { action: 'create', cron, prompt }
 *   delete <id>                       → { action: 'delete', id }
 *   run <id>                          → { action: 'run', id }
 *   （空）                              → { action: 'list' }
 *   其他任意输入                         → { action: 'invalid', reason }
 */

export type AgentsPlatformArgs =
  | { action: 'list' }
  | { action: 'create'; cron: string; prompt: string }
  | { action: 'delete'; id: string }
  | { action: 'run'; id: string }
  | { action: 'invalid'; reason: string }

/**
 * cron 表达式由 5 个空格分隔的字段组成。
 * 本辅助函数提取前 5 个空白分隔的 token 并拼接为 cron，
 * 剩余字符串作为 prompt。
 * 若 token 数少于 5 个则返回 null。
 */
export function splitCronAndPrompt(
  rest: string,
): { cron: string; prompt: string } | null {
  const tokens = rest.trim().split(/\s+/)
  if (tokens.length < 6) return null
  const cron = tokens.slice(0, 5).join(' ')
  const prompt = tokens.slice(5).join(' ')
  return { cron, prompt }
}

export function parseAgentsPlatformArgs(args: string): AgentsPlatformArgs {
  const trimmed = args.trim()

  if (trimmed === '' || trimmed === 'list') {
    return { action: 'list' }
  }

  // 取首个 token 作为子命令
  const spaceIdx = trimmed.indexOf(' ')
  const subCmd = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)
  const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim()

  if (subCmd === 'create') {
    if (!rest) {
      return {
        action: 'invalid',
        reason:
          'create requires a cron expression and prompt, e.g. create "0 9 * * 1" Run daily standup',
      }
    }
    const parsed = splitCronAndPrompt(rest)
    if (!parsed) {
      return {
        action: 'invalid',
        reason:
          'create requires at least 5 cron fields followed by a prompt, e.g. create "0 9 * * 1" Run daily standup',
      }
    }
    const { cron, prompt } = parsed
    // splitCronAndPrompt 会把 slice(5) 拼接起来，因此 prompt 在构造上不可能为空；
    // 此守卫是面向未来重构的防御性回退。
    /* istanbul ignore next -- prompt is non-empty by construction from splitCronAndPrompt */
    if (!prompt.trim()) {
      return { action: 'invalid', reason: 'prompt cannot be empty' }
    }
    return { action: 'create', cron, prompt: prompt.trim() }
  }

  if (subCmd === 'delete') {
    if (!rest) {
      return { action: 'invalid', reason: 'delete requires an agent id' }
    }
    const id = rest.split(/\s+/)[0]
    /* istanbul ignore next -- rest is non-empty; split(/\s+/) always yields a non-empty first token */
    if (!id) {
      return { action: 'invalid', reason: 'delete requires an agent id' }
    }
    return { action: 'delete', id }
  }

  if (subCmd === 'run') {
    if (!rest) {
      return { action: 'invalid', reason: 'run requires an agent id' }
    }
    const id = rest.split(/\s+/)[0]
    /* istanbul ignore next -- rest is non-empty; split(/\s+/) always yields a non-empty first token */
    if (!id) {
      return { action: 'invalid', reason: 'run requires an agent id' }
    }
    return { action: 'run', id }
  }

  return {
    action: 'invalid',
    reason: `Unknown sub-command "${subCmd}". Use: list | create CRON PROMPT | delete ID | run ID`,
  }
}
