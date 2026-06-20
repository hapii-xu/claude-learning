/**
 * 解析 /schedule 命令的 args 字符串。
 *
 * 支持的子命令：
 *   list                                    → { action: 'list' }
 *   get <id>                                → { action: 'get', id }
 *   create <cron-expr> <prompt>             → { action: 'create', cron, prompt }
 *   update <id> <field> <value>             → { action: 'update', id, field, value }
 *   delete <id>                             → { action: 'delete', id }
 *   run <id>                                → { action: 'run', id }
 *   enable <id>                             → { action: 'enable', id }
 *   disable <id>                            → { action: 'disable', id }
 *   (空)                                    → { action: 'list' }
 *   其他任何输入                            → { action: 'invalid', reason }
 */

export type ScheduleArgs =
  | { action: 'list' }
  | { action: 'get'; id: string }
  | { action: 'create'; cron: string; prompt: string }
  | { action: 'update'; id: string; field: string; value: string }
  | { action: 'delete'; id: string }
  | { action: 'run'; id: string }
  | { action: 'enable'; id: string }
  | { action: 'disable'; id: string }
  | { action: 'invalid'; reason: string }

const USAGE =
  'Usage: /schedule list | get ID | create CRON PROMPT | update ID FIELD VALUE | delete ID | run ID | enable ID | disable ID'

/**
 * 将前 5 个以空白分隔的 token 作为 cron 表达式提取；
 * 剩余部分作为 prompt。当 token 少于 6 个时返回 null。
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

/**
 * 校验 5 字段 cron 表达式（minute hour day month weekday）。
 * 当表达式恰好包含 5 个字段时返回 true，否则返回 false。
 * 这是一个轻量的结构化校验 — 语义校验由服务端完成。
 */
export function isValidCronExpression(cron: string): boolean {
  const fields = cron.trim().split(/\s+/)
  return fields.length === 5
}

export function parseScheduleArgs(args: string): ScheduleArgs {
  const trimmed = args.trim()

  if (trimmed === '' || trimmed === 'list') {
    return { action: 'list' }
  }

  const spaceIdx = trimmed.indexOf(' ')
  const subCmd = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)
  const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim()

  // ── get ───────────────────────────────────────────────────────────
  if (subCmd === 'get') {
    if (!rest) {
      return { action: 'invalid', reason: 'get requires a trigger id' }
    }
    const id = rest.split(/\s+/)[0]
    /* istanbul ignore next */
    if (!id) {
      return { action: 'invalid', reason: 'get requires a trigger id' }
    }
    return { action: 'get', id }
  }

  // ── create ────────────────────────────────────────────────────────────
  if (subCmd === 'create') {
    if (!rest) {
      return {
        action: 'invalid',
        reason:
          'create requires a cron expression and prompt, e.g. create "0 9 * * 1" Run weekly standup',
      }
    }
    const parsed = splitCronAndPrompt(rest)
    if (!parsed) {
      return {
        action: 'invalid',
        reason:
          'create requires 5 cron fields followed by a prompt, e.g. create "0 9 * * 1" Run weekly standup',
      }
    }
    const { cron, prompt } = parsed
    if (!isValidCronExpression(cron)) {
      return {
        action: 'invalid',
        reason: `Invalid cron expression: "${cron}". Expected 5 fields (minute hour day month weekday).`,
      }
    }
    /* istanbul ignore next -- 由于 splitCronAndPrompt 的构造方式，prompt 必非空 */
    if (!prompt.trim()) {
      return { action: 'invalid', reason: 'prompt cannot be empty' }
    }
    return { action: 'create', cron, prompt: prompt.trim() }
  }

  // ── update ────────────────────────────────────────────────────────────
  if (subCmd === 'update') {
    const parts = rest.split(/\s+/)
    if (parts.length < 3 || !parts[0]) {
      return {
        action: 'invalid',
        reason:
          'update requires an id, field, and value, e.g. update trg_123 enabled false',
      }
    }
    const id = parts[0]
    const field = parts[1] ?? ''
    const value = parts.slice(2).join(' ')
    if (!field) {
      return { action: 'invalid', reason: 'update requires a field name' }
    }
    if (!value) {
      return { action: 'invalid', reason: 'update requires a value' }
    }
    return { action: 'update', id, field, value }
  }

  // ── delete ────────────────────────────────────────────────────────────
  if (subCmd === 'delete') {
    if (!rest) {
      return { action: 'invalid', reason: 'delete requires a trigger id' }
    }
    const id = rest.split(/\s+/)[0]
    /* istanbul ignore next */
    if (!id) {
      return { action: 'invalid', reason: 'delete requires a trigger id' }
    }
    return { action: 'delete', id }
  }

  // ── run ───────────────────────────────────────────────────────────
  if (subCmd === 'run') {
    if (!rest) {
      return { action: 'invalid', reason: 'run requires a trigger id' }
    }
    const id = rest.split(/\s+/)[0]
    /* istanbul ignore next */
    if (!id) {
      return { action: 'invalid', reason: 'run requires a trigger id' }
    }
    return { action: 'run', id }
  }

  // ── enable / disable ──────────────────────────────────────────────────
  if (subCmd === 'enable' || subCmd === 'disable') {
    if (!rest) {
      return {
        action: 'invalid',
        reason: `${subCmd} requires a trigger id`,
      }
    }
    const id = rest.split(/\s+/)[0]
    /* istanbul ignore next */
    if (!id) {
      return {
        action: 'invalid',
        reason: `${subCmd} requires a trigger id`,
      }
    }
    return { action: subCmd as 'enable' | 'disable', id }
  }

  return {
    action: 'invalid',
    reason: `Unknown sub-command "${subCmd}". ${USAGE}`,
  }
}
