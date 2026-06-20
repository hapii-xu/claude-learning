/**
 * 解析 /local-vault 命令的 args 字符串。
 *
 * 支持的子命令：
 *   list                         → { action: 'list' }
 *   set <key> <value>            → { action: 'set', key, value }
 *   get <key>                    → { action: 'get', key, reveal: false }
 *   get <key> --reveal           → { action: 'get', key, reveal: true }
 *   delete <key>                 → { action: 'delete', key }
 *   （空）                        → { action: 'list' }
 *   其他任意值                   → { action: 'invalid', reason }
 */

export type LocalVaultArgs =
  | { action: 'list' }
  | { action: 'set'; key: string; value: string }
  | { action: 'get'; key: string; reveal: boolean }
  | { action: 'delete'; key: string }
  | { action: 'invalid'; reason: string }

// REPL 输出的 markdown 渲染器会把 `<key>` / `<value>` 当作 HTML 标签并剥离。
// 使用不带尖括号的大写占位符名，确保用户能看到完整的 usage 行。
const USAGE =
  'Usage: /local-vault list | set KEY VALUE | get KEY [--reveal] | delete KEY'

// M1 修复（codecov-100 审计 #4）：防御性地拒绝以类似连字符的 Unicode 字符开头的
// key 名称。ASCII '-' 显然是 flag 前缀，但存储为例如 '−mykey'
// (U+2212 MINUS SIGN) 的 key 会经过 /local-vault set 往返存储，
// 之后却无法通过 CLI 检索，因为这里的 shell 风格 tokenizer 是一致的。
// 凡是首字符属于 Unicode 连字符 / 破折号家族的 key 都拒绝。
// 列表取自 Unicode 通用类别 Pd (Dash_Punctuation)，外加数学减号。
//   U+002D HYPHEN-MINUS                    -
//   U+2010 HYPHEN                          ‐
//   U+2011 NON-BREAKING HYPHEN             ‑
//   U+2012 FIGURE DASH                     ‒
//   U+2013 EN DASH                         –
//   U+2014 EM DASH                         —
//   U+2015 HORIZONTAL BAR                  ―
//   U+2212 MINUS SIGN                      −
//   U+FE58 SMALL EM DASH                   ﹘
//   U+FE63 SMALL HYPHEN-MINUS              ﹣
//   U+FF0D FULLWIDTH HYPHEN-MINUS          －
const HYPHEN_LIKE_PREFIX_REGEX = /^[-‐-―−﹘﹣－]/

export function parseLocalVaultArgs(args: string): LocalVaultArgs {
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

  // ── set ───────────────────────────────────────────────────────────────────
  if (subCmd === 'set') {
    const key = tokens[1]
    if (!key) {
      return { action: 'invalid', reason: `set requires a key name. ${USAGE}` }
    }
    // D3 + M1：拒绝以 '-' 或任何类似连字符的 Unicode 字符开头的 key。
    // ASCII '-' 会被误判为 flag；非 ASCII 的连字符替身（例如 U+2212 MINUS SIGN）
    // 会被静默存储，之后却无法检索，因为用户通常无法在 shell 中复现精确的码点。
    if (HYPHEN_LIKE_PREFIX_REGEX.test(key)) {
      return {
        action: 'invalid',
        reason: `Key name must not start with "-" or a hyphen-like character (reserved for flags). ${USAGE}`,
      }
    }
    // D4：value 是 tokens[2..] 拼接而成，不用 substring 计算（可处理 key 含有重复子串的情况）
    const rest = tokens.slice(2).join(' ')
    if (!rest) {
      return {
        action: 'invalid',
        reason: `set requires a value. ${USAGE}`,
      }
    }
    return { action: 'set', key, value: rest }
  }

  // ── get ───────────────────────────────────────────────────────────────────
  if (subCmd === 'get') {
    // 在提取 key 之前剥离 flag，使得 `get --reveal MY_KEY` 能正确把
    // MY_KEY 解析为 key，而不是 --reveal。
    const flags = ['--reveal']
    const argsWithoutFlags = tokens.filter(t => !flags.includes(t))
    const key = argsWithoutFlags[1] // argsWithoutFlags[0] is 'get'
    if (!key) {
      return { action: 'invalid', reason: `get requires a key name. ${USAGE}` }
    }
    const reveal = tokens.includes('--reveal')
    return { action: 'get', key, reveal }
  }

  // ── delete ────────────────────────────────────────────────────────────────
  if (subCmd === 'delete') {
    const key = tokens[1]
    if (!key) {
      return {
        action: 'invalid',
        reason: `delete requires a key name. ${USAGE}`,
      }
    }
    return { action: 'delete', key }
  }

  return {
    action: 'invalid',
    reason: `Unknown sub-command "${subCmd}". ${USAGE}`,
  }
}
