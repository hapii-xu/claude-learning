/**
 * 解析 /local-memory 命令的 args 字符串。
 *
 * 支持的子命令：
 *   list                           → { action: 'list' }
 *   create <store>                 → { action: 'create', store }
 *   store <store> <key> <value>    → { action: 'store', store, key, value }
 *   fetch <store> <key>            → { action: 'fetch', store, key }
 *   entries <store>                → { action: 'entries', store }
 *   archive <store>                → { action: 'archive', store }
 *   （空）                          → { action: 'list' }
 *   其他任意值                     → { action: 'invalid', reason }
 */

export type LocalMemoryArgs =
  | { action: 'list' }
  | { action: 'create'; store: string }
  | { action: 'store'; store: string; key: string; value: string }
  | { action: 'fetch'; store: string; key: string }
  | { action: 'entries'; store: string }
  | { action: 'archive'; store: string }
  | { action: 'invalid'; reason: string }

// REPL 中的 markdown 渲染器会把 `<store>` / `<key>` / `<value>` 当作 HTML 标签
// 吞掉。使用大写的占位符，确保用户能看到完整的 usage 行。（与 src/commands/local-vault/parseArgs.ts
// 的修复方式相同。）
const USAGE =
  'Usage: /local-memory list | create STORE | store STORE KEY VALUE | fetch STORE KEY | entries STORE | archive STORE'

export function parseLocalMemoryArgs(args: string): LocalMemoryArgs {
  const trimmed = args.trim()

  if (trimmed === '' || trimmed === 'list') {
    return { action: 'list' }
  }

  const tokens = trimmed.split(/\s+/)
  const subCmd = tokens[0]

  // ── list ──────────────────────────────────────────────────────────────────
  if (subCmd === 'list') {
    return { action: 'list' }
  }

  // ── create ────────────────────────────────────────────────────────────────
  if (subCmd === 'create') {
    const store = tokens[1]
    if (!store) {
      return {
        action: 'invalid',
        reason: `create requires a store name. ${USAGE}`,
      }
    }
    return { action: 'create', store }
  }

  // ── store ─────────────────────────────────────────────────────────────────
  if (subCmd === 'store') {
    const store = tokens[1]
    const key = tokens[2]
    if (!store) {
      return {
        action: 'invalid',
        reason: `store requires a store name. ${USAGE}`,
      }
    }
    if (!key) {
      return { action: 'invalid', reason: `store requires a key. ${USAGE}` }
    }
    // D6：value 是 tokens[3..] 拼接而成，不用 substring 计算（可处理 store/key 含有重复子串的情况）
    const rest = tokens.slice(3).join(' ')
    if (!rest) {
      return { action: 'invalid', reason: `store requires a value. ${USAGE}` }
    }
    return { action: 'store', store, key, value: rest }
  }

  // ── fetch ─────────────────────────────────────────────────────────────────
  if (subCmd === 'fetch') {
    const store = tokens[1]
    const key = tokens[2]
    if (!store) {
      return {
        action: 'invalid',
        reason: `fetch requires a store name. ${USAGE}`,
      }
    }
    if (!key) {
      return { action: 'invalid', reason: `fetch requires a key. ${USAGE}` }
    }
    return { action: 'fetch', store, key }
  }

  // ── entries ───────────────────────────────────────────────────────────────
  if (subCmd === 'entries') {
    const store = tokens[1]
    if (!store) {
      return {
        action: 'invalid',
        reason: `entries requires a store name. ${USAGE}`,
      }
    }
    return { action: 'entries', store }
  }

  // ── archive ───────────────────────────────────────────────────────────────
  if (subCmd === 'archive') {
    const store = tokens[1]
    if (!store) {
      return {
        action: 'invalid',
        reason: `archive requires a store name. ${USAGE}`,
      }
    }
    return { action: 'archive', store }
  }

  return {
    action: 'invalid',
    reason: `Unknown sub-command "${subCmd}". ${USAGE}`,
  }
}
