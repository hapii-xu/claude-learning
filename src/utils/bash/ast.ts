/**
 * AST-based bash command analysis using tree-sitter.
 *
 * This module replaces the shell-quote + hand-rolled char-walker approach in
 * bashSecurity.ts / commands.ts. Instead of detecting parser differentials
 * one-by-one, we parse with tree-sitter-bash and walk the tree with an
 * EXPLICIT allowlist of node types. Any node type not in the allowlist causes
 * the entire command to be classified as 'too-complex', which means it goes
 * through the normal permission prompt flow.
 *
 * The key design property is FAIL-CLOSED: we never interpret structure we
 * don't understand. If tree-sitter produces a node we haven't explicitly
 * allowlisted, we refuse to extract argv and the caller must ask the user.
 *
 * This is NOT a sandbox. It does not prevent dangerous commands from running.
 * It answers exactly one question: "Can we produce a trustworthy argv[] for
 * each simple command in this string?" If yes, downstream code can match
 * argv[0] against permission rules and flag allowlists. If no, ask the user.
 */

import { SHELL_KEYWORDS } from './bashParser.js'
import type { Node } from './parser.js'
import { PARSE_ABORTED, parseCommandRaw } from './parser.js'

export type Redirect = {
  op: '>' | '>>' | '<' | '<<' | '>&' | '>|' | '<&' | '&>' | '&>>' | '<<<'
  target: string
  fd?: number
}

export type SimpleCommand = {
  /** argv[0] is the command name, rest are arguments with quotes already resolved */
  argv: string[]
  /** Leading VAR=val assignments */
  envVars: { name: string; value: string }[]
  /** Output/input redirects */
  redirects: Redirect[]
  /** Original source span for this command (for UI display) */
  text: string
}

export type ParseForSecurityResult =
  | { kind: 'simple'; commands: SimpleCommand[] }
  | { kind: 'too-complex'; reason: string; nodeType?: string }
  | { kind: 'parse-unavailable' }

/**
 * Structural node types that represent composition of commands. We recurse
 * through these to find the leaf `command` nodes. `program` is the root;
 * `list` is `a && b || c`; `pipeline` is `a | b`; `redirected_statement`
 * wraps a command with its redirects. Semicolon-separated commands appear
 * as direct siblings under `program` (no wrapper node).
 */
const STRUCTURAL_TYPES = new Set([
  'program',
  'list',
  'pipeline',
  'redirected_statement',
])

/**
 * Operator tokens that separate commands. These are leaf nodes that appear
 * between commands in `list`/`pipeline`/`program` and carry no payload.
 */
const SEPARATOR_TYPES = new Set(['&&', '||', '|', ';', '&', '|&', '\n'])

/**
 * Placeholder string used in outer argv when a $() is recursively extracted.
 * The actual $() output is runtime-determined; the inner command(s) are
 * checked against permission rules separately. Using a placeholder keeps
 * the outer argv clean (no multi-line heredoc bodies polluting path
 * extraction or triggering newline checks).
 */
const CMDSUB_PLACEHOLDER = '__CMDSUB_OUTPUT__'

/**
 * Placeholder for simple_expansion ($VAR) references to variables set earlier
 * in the same command via variable_assignment. Since we tracked the assignment,
 * we know the var exists and its value is either a static string or
 * __CMDSUB_OUTPUT__ (if set via $()). Either way, safe to substitute.
 */
const VAR_PLACEHOLDER = '__TRACKED_VAR__'

/**
 * All placeholder strings. Used for defense-in-depth: if a varScope value
 * contains ANY placeholder (exact or embedded), the value is NOT a pure
 * literal and cannot be trusted as a bare argument. Covers composites like
 * `VAR="prefix$(cmd)"` → `"prefix__CMDSUB_OUTPUT__"` — the substring check
 * catches these where exact-match Set.has() would miss.
 *
 * Also catches user-typed literals that collide with placeholder strings:
 * `VAR=__TRACKED_VAR__ && rm $VAR` — treated as non-literal (conservative).
 */
function containsAnyPlaceholder(value: string): boolean {
  return value.includes(CMDSUB_PLACEHOLDER) || value.includes(VAR_PLACEHOLDER)
}

/**
 * Unquoted $VAR in bash undergoes word-splitting (on $IFS: space/tab/NL)
 * and pathname expansion (glob matching on * ? [). Our argv stores a
 * single string — but at runtime bash may produce MULTIPLE args, or paths
 * matched by a glob. A value containing these metacharacters cannot be
 * trusted as a bare arg: `VAR="-rf /" && rm $VAR` → bash runs `rm -rf /`
 * (two args) but our argv would have `['rm', '-rf /']` (one arg). Similarly
 * `VAR="/etc/*" && cat $VAR` → bash expands to all /etc files.
 *
 * Inside double-quotes ("$VAR"), neither splitting nor globbing applies —
 * the value IS a single literal argument.
 */
const BARE_VAR_UNSAFE_RE = /[ \t\n*?[]/

// stdbuf 标志形式 —— 从包装器剥离 while 循环中提取
const STDBUF_SHORT_SEP_RE = /^-[ioe]$/
const STDBUF_SHORT_FUSED_RE = /^-[ioe]./
const STDBUF_LONG_RE = /^--(input|output|error)=/

/**
 * 已知安全的环境变量，bash 自动设置这些变量。它们的值由 shell/操作系统
 * 控制，而非任意用户输入。通过 $VAR 引用这些变量是安全的 —— 展开是确定性
 * 的，不会引入注入风险。覆盖 `$HOME`、`$PWD`、`$USER`、`$PATH`、`$SHELL`
 * 等。故意保持小巧：只包含总是由 bash/login 设置且值为路径/名称
 * （非任意内容）的变量。
 */
const SAFE_ENV_VARS = new Set([
  'HOME', // 用户主目录
  'PWD', // 当前工作目录（bash 维护）
  'OLDPWD', // 上一个目录
  'USER', // 当前用户名
  'LOGNAME', // 登录名
  'SHELL', // 用户的登录 shell
  'PATH', // 可执行文件搜索路径
  'HOSTNAME', // 机器主机名
  'UID', // 用户 id
  'EUID', // 有效用户 id
  'PPID', // 父进程 id
  'RANDOM', // 随机数（bash 内建）
  'SECONDS', // shell 启动后的秒数
  'LINENO', // 当前行号
  'TMPDIR', // 临时目录
  // 特殊 bash 变量 —— 总是设置，值由 shell 控制：
  'BASH_VERSION', // bash 版本字符串
  'BASHPID', // 当前 bash 进程 id
  'SHLVL', // shell 嵌套层级
  'HISTFILE', // 历史文件路径
  'IFS', // 字段分隔符（注意：只在字符串内部安全；作为裸参数
  //       $IFS 是经典注入原语，resolveSimpleExpansion 中的
  //       insideString 门控正确地阻止了它）
])

/**
 * 特殊 shell 变量（$?、$$、$!、$#、$0-$9）。tree-sitter 对这些使用
 * `special_variable_name`（而非 `variable_name`）。值由 shell 控制：
 * 退出状态、PID、位置参数。只在字符串内部解析是安全的（与 SAFE_ENV_VARS
 * 相同的理由 —— 作为裸参数，它们的值就是参数本身，可能是来自 $1 等的
 * 路径/标志）。
 *
 * 安全性：'@' 和 '*' 不在此集合中。在 "..." 内部，它们展开为位置参数 ——
 * 在全新的 BashTool shell 中（我们的总是这样启动）这些是空的。返回
 * VAR_PLACEHOLDER 会撒谎：`git "push$*"` 给出 argv ['git','push__TRACKED_VAR__']
 * 而 bash 传递 ['git','push']。拒绝规则 Bash(git push:*) 在 .text（原始 `$*`）
 * 和重建的 argv（占位符）上都失败。移除它们后，resolveSimpleExpansion
 * 对 `$*` / `$@` 会落入 tooComplex。`echo "args: $*"` 变成 too-complex ——
 * 可接受（在 BashTool 用法中很少见；`"$@"` 更少见）。
 */
const SPECIAL_VAR_NAMES = new Set([
  '?', // 上一个命令的退出状态
  '$', // 当前 shell PID
  '!', // 上一个后台 PID
  '#', // 位置参数数量
  '0', // 脚本名
  '-', // shell 选项标志
])

/**
 * 表示"此命令无法静态分析"的节点类型。这些类型要么执行任意代码
 * （替换、子 shell、控制流），要么展开为我们无法静态确定的值
 * （参数/算术展开、花括号表达式）。
 *
 * 此集合并非详尽 —— 它记录已知的危险类型。真正的安全属性是
 * walkArgument/walkCommand 中的白名单：任何未在那里明确处理的类型
 * 也会触发 too-complex。
 */
const DANGEROUS_TYPES = new Set([
  'command_substitution',
  'process_substitution',
  'expansion',
  'simple_expansion',
  'brace_expression',
  'subshell',
  'compound_statement',
  'for_statement',
  'while_statement',
  'until_statement',
  'if_statement',
  'case_statement',
  'function_definition',
  'test_command',
  'ansi_c_string',
  'translated_string',
  'herestring_redirect',
  'heredoc_redirect',
])

/**
 * Numeric IDs for analytics (logEvent doesn't accept strings). Index into
 * DANGEROUS_TYPES. Append new entries at the end to keep IDs stable.
 * 0 = unknown/other, -1 = ERROR (parse failure), -2 = pre-check.
 */
const DANGEROUS_TYPE_IDS = [...DANGEROUS_TYPES]
export function nodeTypeId(nodeType: string | undefined): number {
  if (!nodeType) return -2
  if (nodeType === 'ERROR') return -1
  const i = DANGEROUS_TYPE_IDS.indexOf(nodeType)
  return i >= 0 ? i + 1 : 0
}

/**
 * Redirect operator tokens → canonical operator. tree-sitter produces these
 * as child nodes of `file_redirect`.
 */
const REDIRECT_OPS: Record<string, Redirect['op']> = {
  '>': '>',
  '>>': '>>',
  '<': '<',
  '>&': '>&',
  '<&': '<&',
  '>|': '>|',
  '&>': '&>',
  '&>>': '&>>',
  '<<<': '<<<',
}

/**
 * Brace expansion pattern: {a,b} or {a..b}. Must have , or .. inside
 * braces. We deliberately do NOT try to determine whether the opening brace
 * is backslash-escaped: tree-sitter doesn't unescape backslashes, so
 * distinguishing `\{a,b}` (escaped, literal) from `\\{a,b}` (literal
 * backslash + expansion) would require reimplementing bash quote removal.
 * Reject both — the escaped-brace case is rare and trivially rewritten
 * with single quotes.
 */
const BRACE_EXPANSION_RE = /\{[^{}\s]*(,|\.\.)[^{}\s]*\}/

/**
 * Control characters that bash silently drops but confuse static analysis.
 * Includes CR (0x0D): tree-sitter treats CR as a word separator but bash's
 * default IFS does not include CR, so tree-sitter and bash disagree on
 * word boundaries.
 */
// eslint-disable-next-line no-control-regex
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control character detection regex
const CONTROL_CHAR_RE = /[\x00-\x08\x0B-\x1F\x7F]/

/**
 * Unicode whitespace beyond ASCII. These render invisibly (or as regular
 * spaces) in terminals so a user reviewing the command can't see them, but
 * bash treats them as literal word characters. Blocks NBSP, zero-width
 * spaces, line/paragraph separators, BOM.
 */
const UNICODE_WHITESPACE_RE =
  /[\u00A0\u1680\u2000-\u200B\u2028\u2029\u202F\u205F\u3000\uFEFF]/

/**
 * Backslash immediately before whitespace. bash treats `\ ` as a literal
 * space inside the current word, but tree-sitter returns the raw text with
 * the backslash still present. argv[0] from tree-sitter is `cat\ test`
 * while bash runs `cat test` (with a literal space). Rather than
 * reimplement bash's unescaping rules, we reject these — they're rare in
 * practice and trivial to rewrite with quotes.
 *
 * Also matches `\` before newline (line continuation) when adjacent to a
 * non-whitespace char. `tr\<NL>aceroute` — bash joins to `traceroute`, but
 * tree-sitter splits into two words (differential). When `\<NL>` is preceded
 * by whitespace (e.g. `foo && \<NL>bar`), there's no word to join — both
 * parsers agree, so we allow it.
 */
const BACKSLASH_WHITESPACE_RE = /\\[ \t]|[^ \t\n\\]\\\n/

/**
 * Zsh dynamic named directory expansion: ~[name]. In zsh this invokes the
 * zsh_directory_name hook, which can run arbitrary code. bash treats it as
 * a literal tilde followed by a glob character class. Since BashTool runs
 * via the user's default shell (often zsh), reject conservatively.
 */
const ZSH_TILDE_BRACKET_RE = /~\[/

/**
 * Zsh EQUALS expansion: word-initial `=cmd` expands to the absolute path of
 * `cmd` (equivalent to `$(which cmd)`). `=curl evil.com` runs as
 * `/usr/bin/curl evil.com`. tree-sitter parses `=curl` as a literal word, so
 * a `Bash(curl:*)` deny rule matching on base command name won't see `curl`.
 * Only matches word-initial `=` followed by a command-name char — `VAR=val`
 * and `--flag=val` have `=` mid-word and are not expanded by zsh.
 */
const ZSH_EQUALS_EXPANSION_RE = /(?:^|[\s;&|])=[a-zA-Z_]/

/**
 * 花括号字符与引号字符的组合。像 `{a'}',b}` 这样的构造
 * 在花括号展开上下文中使用引号包围的花括号来混淆
 * 基于正则表达式的检测。在 bash 中，`{a'}',b}` 展开为
 * `a} b`（引号内的 `}` 在第一个备选项中变为字面量）。
 * 这些很难正确分析，且在我们想自动允许的命令中没有合法用途。
 *
 * 此检查在命令的版本上运行，其中 `{` 从单引号和双引号
 * 跨度中掩码掉，因此 JSON 载荷如 `curl -d '{"k":"v"}'`
 * 不会触发误报。花括号展开不能在引号内发生，所以那里的
 * `{` 永远不能开始混淆模式。引号字符本身保持可见，所以
 * `{a'}',b}` 和 `{@'{'0},...}` 仍通过外层未引用的 `{` 匹配。
 */
const BRACE_WITH_QUOTE_RE = /\{[^}]*['"]/

/**
 * 掩码出现在单引号或双引号上下文中的 `{` 字符。
 * 使用单次遍历的 bash 感知引号状态扫描器而非正则表达式。
 *
 * 天真的正则表达式（`/'[^']*'/g`）在双引号字符串内出现 `'` 时
 * 会错误检测跨度：对于 `echo "it's" {a'}',b}`，它从 `it's` 中的
 * `'` 匹配到 `{a'}` 中的 `'`，掩码了未引用的 `{` 并产生假阴性。
 * 扫描器跟踪实际的 bash 引号状态：`'` 仅在未引用上下文中切换
 * 单引号；`"` 仅在单引号外切换双引号；`\` 在未引用上下文中
 * 转义下一个字符，在双引号内转义 `"` / `\\`。
 *
 * 在两种引号上下文中花括号展开都不可能，所以在其中掩码 `{`
 * 是安全的。第二道防线：walkArgument 中的 BRACE_EXPANSION_RE。
 */
function maskBracesInQuotedContexts(cmd: string): string {
  // 快速路径：没有 `{` → 无需掩码。跳过逐字符扫描
  // 适用于 >90% 没有花括号的命令（`ls -la`、`git status` 等）。
  if (!cmd.includes('{')) return cmd
  const out: string[] = []
  let inSingle = false
  let inDouble = false
  let i = 0
  while (i < cmd.length) {
    const c = cmd[i]!
    if (inSingle) {
      // Bash 单引号：无转义，`'` 总是终止。
      if (c === "'") inSingle = false
      out.push(c === '{' ? ' ' : c)
      i++
    } else if (inDouble) {
      // Bash 双引号：`\` 转义 `"` 和 `\`（还有 `$`、反引号、
      // 换行 - 但这些不影响引号状态，所以我们让它们通过）。
      if (c === '\\' && (cmd[i + 1] === '"' || cmd[i + 1] === '\\')) {
        out.push(c, cmd[i + 1]!)
        i += 2
      } else {
        if (c === '"') inDouble = false
        out.push(c === '{' ? ' ' : c)
        i++
      }
    } else {
      // 未引用：`\` 转义下一个字符。
      if (c === '\\' && i + 1 < cmd.length) {
        out.push(c, cmd[i + 1]!)
        i += 2
      } else {
        if (c === "'") inSingle = true
        else if (c === '"') inDouble = true
        out.push(c)
        i++
      }
    }
  }
  return out.join('')
}

const DOLLAR = String.fromCharCode(0x24)

/**
 * 解析 bash 命令字符串并提取简单命令的扁平列表。
 * 如果命令使用了我们无法静态分析的任何 shell 特性，
 * 返回 'too-complex'。如果 tree-sitter WASM 未加载，
 * 返回 'parse-unavailable' - 调用者应回退到保守行为。
 */
export async function parseForSecurity(
  cmd: string,
): Promise<ParseForSecurityResult> {
  // parseCommandRaw('') 返回 null（假值检查），所以在此短路。
  // 不要使用 .trim() - 它会剥离 Unicode 空白（\u00a0 等），
  // 而 parseForSecurityFromAst 中的预检查需要看到并拒绝它们。
  if (cmd === '') return { kind: 'simple', commands: [] }
  const root = await parseCommandRaw(cmd)
  return root === null
    ? { kind: 'parse-unavailable' }
    : parseForSecurityFromAst(cmd, root)
}

/**
 * 与 parseForSecurity 相同，但接受预解析的 AST 根，以便
 * 需要树用于其他目的的调用者可以解析一次并共享。
 * 预检查仍在 `cmd` 上运行 - 它们捕获 tree-sitter/bash 差异，
 * 而成功的解析不会捕获这些差异。
 */
export function parseForSecurityFromAst(
  cmd: string,
  root: Node | typeof PARSE_ABORTED,
): ParseForSecurityResult {
  // 预检查：导致 tree-sitter 和 bash 在单词边界上产生分歧的字符。
  // 这些在 tree-sitter 之前运行，因为它们是已知的
  // tree-sitter/bash 差异。此后的所有内容都信任 tree-sitter 的分词。
  if (CONTROL_CHAR_RE.test(cmd)) {
    return { kind: 'too-complex', reason: '包含控制字符' }
  }
  if (UNICODE_WHITESPACE_RE.test(cmd)) {
    return { kind: 'too-complex', reason: '包含 Unicode 空白' }
  }
  if (BACKSLASH_WHITESPACE_RE.test(cmd)) {
    return {
      kind: 'too-complex',
      reason: '包含反斜杠转义的空白',
    }
  }
  if (ZSH_TILDE_BRACKET_RE.test(cmd)) {
    return {
      kind: 'too-complex',
      reason: '包含 zsh ~[ 动态目录语法',
    }
  }
  if (ZSH_EQUALS_EXPANSION_RE.test(cmd)) {
    return {
      kind: 'too-complex',
      reason: '包含 zsh =cmd 等号展开',
    }
  }
  if (BRACE_WITH_QUOTE_RE.test(maskBracesInQuotedContexts(cmd))) {
    return {
      kind: 'too-complex',
      reason: '包含带引号字符的花括号（展开混淆）',
    }
  }

  const trimmed = cmd.trim()
  if (trimmed === '') {
    return { kind: 'simple', commands: [] }
  }

  if (root === PARSE_ABORTED) {
    // 安全性：模块已加载但解析中止（超时 / 节点预算 / 恐慌）。
    // 可被对手触发 - `(( a[0][0]... ))` 约 2800 个下标
    // 在 10K 长度限制下达到 PARSE_TIMEOUT_MICROS。
    // 以前与模块未加载无法区分 → 路由到旧版（parse-unavailable），
    // 后者缺少 EVAL_LIKE_BUILTINS - `trap`、`enable`、`hash` 泄漏
    // 与 Bash(*)。失败关闭：too-complex → 询问。
    return {
      kind: 'too-complex',
      reason:
        'Parser aborted (timeout or resource limit) — possible adversarial input',
      nodeType: 'PARSE_ABORT',
    }
  }

  return walkProgram(root)
}

function walkProgram(root: Node): ParseForSecurityResult {
  // ERROR 节点检查折叠到 collectCommands 中 - 任何未处理的节点类型
  // （包括 ERROR）在默认分支中落到 tooComplex()。
  // 避免为错误检测进行单独的整树遍历。
  const commands: SimpleCommand[] = []
  // 跟踪在同一命令中较早赋值的变量。当 simple_expansion ($VAR)
  // 引用跟踪的变量时，我们可以替换占位符而非返回 too-complex。
  // 支持像 `NOW=$(date) && jq --arg now "$NOW" ...` 这样的模式 -
  // $NOW 已知是 $(date) 的输出（已作为内部命令提取）。
  const varScope = new Map<string, string>()
  const err = collectCommands(root, commands, varScope)
  if (err) return err
  return { kind: 'simple', commands }
}

/**
 * 从结构包装节点递归收集叶子 `command` 节点。
 * 在任何不允许的节点类型上返回错误结果，成功时返回 null。
 */
function collectCommands(
  node: Node,
  commands: SimpleCommand[],
  varScope: Map<string, string>,
): ParseForSecurityResult | null {
  if (node.type === 'command') {
    // 传递 `commands` 作为内部命令累加器 - 在 walkCommand 期间
    // 提取的任何 $() 都会与外部命令一起追加。
    const result = walkCommand(node, [], commands, varScope)
    if (result.kind !== 'simple') return result
    commands.push(...result.commands)
    return null
  }

  if (node.type === 'redirected_statement') {
    return walkRedirectedStatement(node, commands, varScope)
  }

  if (node.type === 'comment') {
    return null
  }

  if (STRUCTURAL_TYPES.has(node.type)) {
    // 安全性：`||`、`|`、`|&`、`&` 不得线性传递 varScope。在 bash 中：
    //   `||` 右侧条件运行 → 那里设置的变量可能未设置
    //   `|`/`|&` 阶段在子 shell 中运行 → 那里设置的变量之后永远不可见
    //   `&` 左侧在后台子 shell 中运行 → 同上
    // 标志省略攻击：`true || FLAG=--dry-run && cmd $FLAG` - bash 跳过
    // `||` 右侧（FLAG 未设置 → $FLAG 为空），运行 `cmd` 时没有 --dry-run。
    // 使用线性作用域，我们的 argv 有 ['cmd','--dry-run'] → 看似安全 → 绕过。
    //
    // 修复：在入口快照传入的作用域。在这些分隔符之后，重置为
    // 快照 - 分隔符之间子句中设置的变量不会泄漏。`scope`
    // 用于 `&&`/`;` 链之间的子句共享状态（常见的 `VAR=x && cmd $VAR`）。
    // `scope` 跨越 `||`/`|`/`&` 仅作为预结构快照。
    //
    // `&&` 和 `;` 确实传递作用域：`VAR=x && cmd $VAR` 是顺序的，VAR 已设置。
    //
    // 注意：`scope` 和 `varScope` 在第一个 `||`/`|`/`&` 后分歧。
    // 调用者的 varScope 仅为 `&&`/`;` 前缀变异 - 这是保守的
    // （`A && B | C && D` 中设置的变量泄漏 A+B 到调用者，而非 C+D）
    // 但是安全的。
    //
    // 效率：快照仅在我们遇到 `||`/`|`/`|&`/`&` 时需要。对于
    // 主要情况（`ls`、`git status` - 没有此类分隔符），通过
    // 廉价预扫描跳过 Map 分配。对于 `pipeline`，node.type 已告诉
    // 我们阶段是子 shell - 在入口复制一次，无需快照（每次
    // 重置使用 varScope 的入口副本模式，它未被触及）。
    const isPipeline = node.type === 'pipeline'
    let needsSnapshot = false
    if (!isPipeline) {
      for (const c of node.children) {
        if (c && (c.type === '||' || c.type === '&')) {
          needsSnapshot = true
          break
        }
      }
    }
    const snapshot = needsSnapshot ? new Map(varScope) : null
    // 对于 `pipeline`，所有阶段在子 shell 中运行 - 从副本开始以便
    // 没有东西变异调用者的作用域。对于 `list`/`program`，`&&`/`;`
    // 链变异调用者的作用域（顺序）；仅在 `||`/`&` 时分叉。
    let scope = isPipeline ? new Map(varScope) : varScope
    for (const child of node.children) {
      if (!child) continue
      if (SEPARATOR_TYPES.has(child.type)) {
        if (
          child.type === '||' ||
          child.type === '|' ||
          child.type === '|&' ||
          child.type === '&'
        ) {
          // 对于管道：varScope 未被触及（我们从副本开始）。
          // 对于列表/程序：快照非空（预扫描设置了它）。
          // `|`/`|&` 仅出现在 `pipeline` 节点下；`||`/`&` 在列表下。
          scope = new Map(snapshot ?? varScope)
        }
        continue
      }
      const err = collectCommands(child, commands, scope)
      if (err) return err
    }
    return null
  }

  if (node.type === 'negated_command') {
    // `! cmd` 仅反转退出码 - 不执行代码或影响 argv。
    // 递归进入包装的命令。在 CI 中常见：`! grep err`、
    // `! test -f lock`、`! git diff --quiet`。
    for (const child of node.children) {
      if (!child) continue
      if (child.type === '!') continue
      return collectCommands(child, commands, varScope)
    }
    return null
  }

  if (node.type === 'declaration_command') {
    // `export`/`local`/`readonly`/`declare`/`typeset`。tree-sitter 发出
    // 这些作为 declaration_command，而非 command，所以以前落到
    // tooComplex。值通过 walkVariableAssignment 验证：值中的 `$()`
    // 被递归提取（内部命令推送到
    // commands[]，外部 argv 获得 CMDSUB_PLACEHOLDER）；其他不允许的
    // 展开仍然通过 walkArgument 拒绝。argv[0] 是内建命令名，所以
    // `Bash(export:*)` 规则匹配。
    const argv: string[] = []
    for (const child of node.children) {
      if (!child) continue
      switch (child.type) {
        case 'export':
        case 'local':
        case 'readonly':
        case 'declare':
        case 'typeset':
          argv.push(child.text)
          break
        case 'word':
        case 'number':
        case 'raw_string':
        case 'string':
        case 'concatenation': {
          // 标志（`declare -r`）、引号名称（`export "FOO=bar"`）、数字
          // （`declare -i 42`）。镜像 walkCommand 的 argv 处理 - 在此之前，
          // `export "FOO=bar"` 在 `string` 子节点上触发 tooComplex。
          // walkArgument 验证每一个（展开仍然拒绝）。
          const arg = walkArgument(child, commands, varScope)
          if (typeof arg !== 'string') return arg
          // 安全性：改变赋值语义的 declare/typeset/local 标志
          // 破坏我们的静态模型。-n（名称引用）：`declare -n X=Y`
          // 然后 `$X` 解引用为 $Y 的值 - varScope 存储 'Y'
          // （目标名称），argv[0] 显示 'Y' 而 bash 运行 $Y 持有的任何内容。
          // -i（整数）：`declare -i X='a[$(cmd)]'` 在赋值时算术
          // 计算右侧，运行 $(cmd) 即使来自单引号 raw_string
          // （与 $((…)) 中 walkArithmetic 防护相同的原语）。
          // -a/-A（数组）：赋值时的下标算术。-r/-x/-g/-p/-f/-F 是惰性的。
          // 检查已解析的参数（而非 child.text）以便 `\-n` 和引号内的 `-n`
          // 被捕获。仅限于 declare/typeset/local：`export -n` 表示
          // "移除导出属性"（非名称引用），且 export/readonly 不接受 -i；
          // readonly -a/-A 拒绝带下标的参数作为无效标识符，
          // 所以下标算术不会触发。
          if (
            (argv[0] === 'declare' ||
              argv[0] === 'typeset' ||
              argv[0] === 'local') &&
            /^-[a-zA-Z]*[niaA]/.test(arg)
          ) {
            return {
              kind: 'too-complex',
              reason: `declare 标志 ${arg} 改变赋值语义（名称引用/整数/数组）`,
              nodeType: 'declaration_command',
            }
          }
          // 安全性：带下标的裸位置赋值也会计算 - 不需要 -a/-i 标志。
          // `declare 'x[$(id)]=val'` 隐式创建数组元素，算术计算
          // 下标并运行 $(id)。tree-sitter 将单引号形式作为 raw_string
          // 叶子节点传递，所以 walkArgument 只看到字面文本。
          // 仅限于 declare/typeset/local：export/readonly 在计算前
          // 拒绝标识符中的 `[`。
          if (
            (argv[0] === 'declare' ||
              argv[0] === 'typeset' ||
              argv[0] === 'local') &&
            arg[0] !== '-' &&
            /^[^=]*\[/.test(arg)
          ) {
            return {
              kind: 'too-complex',
              reason: `declare 位置参数 '${arg}' 包含数组下标 —— bash 在下标中计算 $(cmd)`,
              nodeType: 'declaration_command',
            }
          }
          argv.push(arg)
          break
        }
        case 'variable_assignment': {
          const ev = walkVariableAssignment(child, commands, varScope)
          if ('kind' in ev) return ev
          // export/declare 赋值填充作用域，以便后续的 $VAR 引用可解析。
          applyVarToScope(varScope, ev)
          argv.push(`${ev.name}=${ev.value}`)
          break
        }
        case 'variable_name':
          // `export FOO` - 裸名称，无赋值。
          argv.push(child.text)
          break
        default:
          return tooComplex(child)
      }
    }
    commands.push({ argv, envVars: [], redirects: [], text: node.text })
    return null
  }

  if (node.type === 'variable_assignment') {
    // 语句级的裸 `VAR=value`（非命令环境变量前缀）。
    // 设置 shell 变量 —— 无代码执行，无文件系统 I/O。
    // 值通过 walkVariableAssignment → walkArgument 验证，
    // 所以 `VAR=$(evil)` 仍然根据内部命令递归提取/拒绝。
    // 不推送到 commands —— 裸赋值不需要权限规则（它是惰性的）。
    // 常见模式：`VAR=x && cmd`，其中 cmd 引用 $VAR。约占前 5k ant
    // 命令中 too-complex 的 35%。
    const ev = walkVariableAssignment(node, commands, varScope)
    if ('kind' in ev) return ev
    // 填充作用域以便后续的 `$VAR` 引用可解析。
    applyVarToScope(varScope, ev)
    return null
  }

  if (node.type === 'for_statement') {
    // `for VAR in WORD...; do BODY; done` —— 对每个单词迭代执行 BODY。
    // 主体命令提取一次；每次迭代运行相同的命令。
    //
    // 安全性：循环变量总是被视为未知值（VAR_PLACEHOLDER）。
    // 即使"静态"迭代单词也可能：
    //  - 绝对路径：`for i in /etc/passwd; do rm $i; done` —— 主体 argv
    //    会有占位符，路径验证永远看不到 /etc/passwd。
    //  - 通配符：`for i in /etc/*; do rm $i; done` —— `/etc/*` 在解析时
    //    是静态单词，但 bash 在运行时展开它。
    //  - 标志：`for i in -rf /; do rm $i; done` —— 标志走私。
    //
    // VAR_PLACEHOLDER 意味着主体中的裸 `$i` → too-complex。只有
    // 字符串嵌入（`echo "item: $i"`）保持简单。这撤销了原始 PR 中
    // 一些 too-complex→简单 的救援 —— 每一个都是潜在的路径验证绕过。
    let loopVar: string | null = null
    let doGroup: Node | null = null
    for (const child of node.children) {
      if (!child) continue
      if (child.type === 'variable_name') {
        loopVar = child.text
      } else if (child.type === 'do_group') {
        doGroup = child
      } else if (
        child.type === 'for' ||
        child.type === 'in' ||
        child.type === 'select' ||
        child.type === ';'
      ) {
      } else if (child.type === 'command_substitution') {
        // `for i in $(seq 1 3)` —— 内部命令确实被提取并进行规则检查。
        const err = collectCommandSubstitution(child, commands, varScope)
        if (err) return err
      } else {
        // 迭代值 —— 通过 walkArgument 验证。值被丢弃：
        // 主体 argv 无论迭代单词如何都获得 VAR_PLACEHOLDER，
        // 主体中的裸 `$i` → too-complex（见上方的安全性注释）。
        // 我们仍然验证以拒绝例如 `for i in $(cmd); do ...; done`
        // 其中迭代单词本身就是不允许的展开。
        const arg = walkArgument(child, commands, varScope)
        if (typeof arg !== 'string') return arg
      }
    }
    if (loopVar === null || doGroup === null) return tooComplex(node)
    // 安全性：`for PS4 in '$(id)'; do set -x; :; done` 直接通过下方的
    // varScope.set 设置 PS4 —— walkVariableAssignment 的 PS4/IFS 检查
    // 永远不会触发。跟踪时 RCE（PS4）或分词绕过（IFS）。没有合法用途。
    if (loopVar === 'PS4' || loopVar === 'IFS') {
      return {
        kind: 'too-complex',
        reason: `${loopVar} 作为循环变量绕过赋值验证`,
        nodeType: 'for_statement',
      }
    }
    // 安全性：主体使用作用域副本 —— 循环主体内赋值的变量不会泄漏到
    // `done` 之后的命令。循环变量本身设置在真实作用域中
    // （bash 语义：$i 在循环后仍然设置）并复制到主体作用域。
    // 总是 VAR_PLACEHOLDER —— 见上方。
    varScope.set(loopVar, VAR_PLACEHOLDER)
    const bodyScope = new Map(varScope)
    for (const c of doGroup.children) {
      if (!c) continue
      if (c.type === 'do' || c.type === 'done' || c.type === ';') continue
      const err = collectCommands(c, commands, bodyScope)
      if (err) return err
    }
    return null
  }

  if (node.type === 'if_statement' || node.type === 'while_statement') {
    // `if COND; then BODY; [elif...; else...;] fi`
    // `while COND; do BODY; done`
    // 提取条件命令 + 所有分支/主体命令。所有都针对权限规则检查。
    // `while read VAR` 跟踪 VAR 以便主体可以引用 $VAR。
    //
    // 安全性：分支主体使用作用域副本 - 在条件分支内赋值的变量
    // （可能不执行）不得泄漏到 fi/done 之后的命令。
    // `if false; then T=safe; fi && rm $T` 必须拒绝 $T。
    // 条件命令使用真实的 varScope（它们总是为检查运行，
    // 所以那里的赋值是无条件的 - 例如，`while read V` 跟踪
    // 必须持久化到主体副本）。
    //
    // tree-sitter if_statement 子节点：if, COND..., then, THEN-BODY...,
    // [elif_clause...], [else_clause], fi。我们通过跟踪是否已看到
    // `then` 令牌来区分条件和 then 主体。
    let seenThen = false
    for (const child of node.children) {
      if (!child) continue
      if (
        child.type === 'if' ||
        child.type === 'fi' ||
        child.type === 'else' ||
        child.type === 'elif' ||
        child.type === 'while' ||
        child.type === 'until' ||
        child.type === ';'
      ) {
        continue
      }
      if (child.type === 'then') {
        seenThen = true
        continue
      }
      if (child.type === 'do_group') {
        // while 主体：使用作用域副本递归（主体赋值不泄漏过 done）。
        // 副本包含条件中的任何 `read VAR` 跟踪（此时已在真实 varScope 中）。
        const bodyScope = new Map(varScope)
        for (const c of child.children) {
          if (!c) continue
          if (c.type === 'do' || c.type === 'done' || c.type === ';') continue
          const err = collectCommands(c, commands, bodyScope)
          if (err) return err
        }
        continue
      }
      if (child.type === 'elif_clause' || child.type === 'else_clause') {
        // elif_clause：elif, cond, ;, then, body... / else_clause：else, body...
        // 作用域副本 - elif/else 分支赋值不泄漏过 fi。
        const branchScope = new Map(varScope)
        for (const c of child.children) {
          if (!c) continue
          if (
            c.type === 'elif' ||
            c.type === 'else' ||
            c.type === 'then' ||
            c.type === ';'
          ) {
            continue
          }
          const err = collectCommands(c, commands, branchScope)
          if (err) return err
        }
        continue
      }
      // 条件（seenThen=false）或 then 主体（seenThen=true）。
      // 条件使用真实 varScope（总是运行）。then 主体使用副本。
      // 特殊情况 `while read VAR`：条件 `read VAR` 被收集后，
      // 在真实作用域中跟踪 VAR 以便主体副本继承它。
      const targetScope = seenThen ? new Map(varScope) : varScope
      const before = commands.length
      const err = collectCommands(child, commands, targetScope)
      if (err) return err
      // 如果条件包含 `read VAR...`，在真实作用域中跟踪变量。
      // read 变量值为 UNKNOWN（标准输入输入）→ 使用 VAR_PLACEHOLDER
      // （未知值标记，仅限字符串）。
      if (!seenThen) {
        for (let i = before; i < commands.length; i++) {
          const c = commands[i]
          if (c?.argv[0] === 'read') {
            for (const a of c.argv.slice(1)) {
              // 跳过标志（-r、-d 等）；将裸标识符参数跟踪为变量名。
              if (!a.startsWith('-') && /^[A-Za-z_][A-Za-z0-9_]*$/.test(a)) {
                // 安全性：commands[] 是扁平累加器。条件中的 `true || read VAR`：
                // 列表处理器正确地为 ||-RHS 使用作用域副本（可能不运行），
                // 但 `read VAR` 仍被推送到 commands[] - 我们无法从这里判断
                // 它是作用域隔离的。`echo | read VAR`（管道，bash 中的子 shell）
                // 和 `(read VAR)`（子 shell）同理。用 VAR_PLACEHOLDER 覆盖
                // 跟踪的字面量会隐藏路径遍历：`VAR=../../etc/passwd &&
                // if true || read VAR; then cat "/tmp/$VAR"; fi` - 解析器会看到
                // /tmp/__TRACKED_VAR__，bash 读取 /etc/passwd。当跟踪的字面量
                // 将被覆盖时失败关闭。安全情况（无先前值或已是占位符）→ 继续。
                const existing = varScope.get(a)
                if (
                  existing !== undefined &&
                  !containsAnyPlaceholder(existing)
                ) {
                  return {
                    kind: 'too-complex',
                    reason: `条件中的 'read ${a}' 可能不执行（||/管道/子 shell）；无法证明它会覆盖已跟踪的字面量 '${existing}'`,
                    nodeType: 'if_statement',
                  }
                }
                varScope.set(a, VAR_PLACEHOLDER)
              }
            }
          }
        }
      }
    }
    return null
  }

  if (node.type === 'subshell') {
    // `(cmd1; cmd2)` - 在子 shell 中运行命令。内部命令确实
    // 被执行，所以提取它们进行权限检查。子 shell 具有
    // 隔离作用域：内部设置的变量不会泄漏出来。使用 varScope
    // 的副本（外部变量可见，内部更改被丢弃）。
    const innerScope = new Map(varScope)
    for (const child of node.children) {
      if (!child) continue
      if (child.type === '(' || child.type === ')') continue
      const err = collectCommands(child, commands, innerScope)
      if (err) return err
    }
    return null
  }

  if (node.type === 'test_command') {
    // `[[ EXPR ]]` 或 `[ EXPR ]` - 条件测试。基于文件测试（-f、-d）、
    // 字符串比较（==、!=）等计算为真/假。无代码执行（内部无
    // command_substitution - 那将是一个子节点，我们会通过 walkArgument
    // 递归进入它并拒绝它）。作为合成命令推送，argv[0]='[[' 以便
    // 权限规则可以匹配 - `Bash([[ :*)` 会不寻常但合法。
    // 遍历参数以验证（操作数内无 cmdsub/展开）。
    const argv: string[] = ['[[']
    for (const child of node.children) {
      if (!child) continue
      if (child.type === '[[' || child.type === ']]') continue
      if (child.type === '[' || child.type === ']') continue
      // 递归进入测试表达式结构：unary_expression、binary_expression、
      // parenthesized_expression、negated_expression。叶子节点是
      // test_operator（-f、-d、==）和操作数字。
      const err = walkTestExpr(child, argv, commands, varScope)
      if (err) return err
    }
    commands.push({ argv, envVars: [], redirects: [], text: node.text })
    return null
  }

  if (node.type === 'unset_command') {
    // `unset FOO BAR`、`unset -f func`。安全：仅从当前 shell 移除
    // shell 变量/函数 - 无代码执行，无文件系统 I/O。tree-sitter
    // 发出专用节点类型，所以以前落到 tooComplex。子节点：`unset`
    // 关键字、每个名称的 `variable_name`、标志如 `-f`/`-v` 的 `word`。
    const argv: string[] = []
    for (const child of node.children) {
      if (!child) continue
      switch (child.type) {
        case 'unset':
          argv.push(child.text)
          break
        case 'variable_name':
          argv.push(child.text)
          // 安全性：unset 从 bash 作用域中移除变量。从 varScope 中移除
          // 以便后续的 `$VAR` 引用正确拒绝。
          // `VAR=safe && unset VAR && rm $VAR` 不得解析 $VAR。
          varScope.delete(child.text)
          break
        case 'word': {
          const arg = walkArgument(child, commands, varScope)
          if (typeof arg !== 'string') return arg
          argv.push(arg)
          break
        }
        default:
          return tooComplex(child)
      }
    }
    commands.push({ argv, envVars: [], redirects: [], text: node.text })
    return null
  }

  return tooComplex(node)
}

/**
 * 递归遍历 test_command 表达式树（一元/二元/否定/括号表达式）。
 * 叶子节点是 test_operator 令牌和操作数（word/string/number 等）。
 * 操作数通过 walkArgument 验证。
 */
function walkTestExpr(
  node: Node,
  argv: string[],
  innerCommands: SimpleCommand[],
  varScope: Map<string, string>,
): ParseForSecurityResult | null {
  switch (node.type) {
    case 'unary_expression':
    case 'binary_expression':
    case 'negated_expression':
    case 'parenthesized_expression': {
      for (const c of node.children) {
        if (!c) continue
        const err = walkTestExpr(c, argv, innerCommands, varScope)
        if (err) return err
      }
      return null
    }
    case 'test_operator':
    case '!':
    case '(':
    case ')':
    case '&&':
    case '||':
    case '==':
    case '=':
    case '!=':
    case '<':
    case '>':
    case '=~':
      argv.push(node.text)
      return null
    case 'regex':
    case 'extglob_pattern':
      // [[ ]] 中 =~ 或 ==/!= 的右侧。仅模式文本 —— 无代码执行。
      // 解析器将这些作为无子节点的叶子节点发出（模式内的任何 $(...)
      // 或 ${...} 是兄弟节点而非子节点，会被单独遍历）。
      argv.push(node.text)
      return null
    default: {
      // 操作数 —— word、string、number 等。通过 walkArgument 验证。
      const arg = walkArgument(node, innerCommands, varScope)
      if (typeof arg !== 'string') return arg
      argv.push(arg)
      return null
    }
  }
}

/**
 * `redirected_statement` 包装一个命令（或管道）加上一个或多个
 * `file_redirect`/`heredoc_redirect` 节点。提取重定向，遍历内部命令，
 * 将重定向附加到最后一个命令（输出被重定向的那个）。
 */
function walkRedirectedStatement(
  node: Node,
  commands: SimpleCommand[],
  varScope: Map<string, string>,
): ParseForSecurityResult | null {
  const redirects: Redirect[] = []
  let innerCommand: Node | null = null

  for (const child of node.children) {
    if (!child) continue
    if (child.type === 'file_redirect') {
      // 传递 `commands` 以便重定向目标中的 $()（例如 `> $(mktemp)`）
      // 提取内部命令进行权限检查。
      const r = walkFileRedirect(child, commands, varScope)
      if ('kind' in r) return r
      redirects.push(r)
    } else if (child.type === 'heredoc_redirect') {
      const r = walkHeredocRedirect(child)
      if (r) return r
    } else if (
      child.type === 'command' ||
      child.type === 'pipeline' ||
      child.type === 'list' ||
      child.type === 'negated_command' ||
      child.type === 'declaration_command' ||
      child.type === 'unset_command'
    ) {
      innerCommand = child
    } else {
      return tooComplex(child)
    }
  }

  if (!innerCommand) {
    // 单独的 `> file` 是有效的 bash（截断文件）。表示为具有空 argv
    // 的命令，以便下游看到写入。
    commands.push({ argv: [], envVars: [], redirects, text: node.text })
    return null
  }

  const before = commands.length
  const err = collectCommands(innerCommand, commands, varScope)
  if (err) return err
  if (commands.length > before && redirects.length > 0) {
    const last = commands[commands.length - 1]
    if (last) last.redirects.push(...redirects)
  }
  return null
}

/**
 * Extract operator + target from a `file_redirect` node. The target must be
 * a static word or string.
 */
function walkFileRedirect(
  node: Node,
  innerCommands: SimpleCommand[],
  varScope: Map<string, string>,
): Redirect | ParseForSecurityResult {
  let op: Redirect['op'] | null = null
  let target: string | null = null
  let fd: number | undefined

  for (const child of node.children) {
    if (!child) continue
    if (child.type === 'file_descriptor') {
      fd = Number(child.text)
    } else if (child.type in REDIRECT_OPS) {
      op = REDIRECT_OPS[child.type] ?? null
    } else if (child.type === 'word' || child.type === 'number') {
      // 安全性：`number` 节点可以通过 `NN#<expansion>` 算术基语法
      // 怪癖包含展开子节点 - 与 walkArgument 的数字情况相同的问题。
      // `> 10#$(cmd)` 在运行时运行 cmd。纯 word/number 节点没有子节点。
      if (child.children.length > 0) return tooComplex(child)
      // 与 walkArgument（~608）对称：`echo foo > {a,b}` 在 bash 中
      // 是模糊重定向。tree-sitter 实际上发出
      // `concatenation` 节点用于花括号目标（被下方的默认分支捕获），
      // 但也检查 `word` 文本以做纵深防御。
      if (BRACE_EXPANSION_RE.test(child.text)) return tooComplex(child)
      // 反转义反斜杠序列 - 与 walkArgument 相同。Bash 引号移除
      // 将 `\X` → `X`。没有这个，`cat < /proc/self/\environ` 存储
      // 目标 `/proc/self/\environ` 逃避 PROC_ENVIRON_RE，
      // 但 bash 读取 /proc/self/environ。
      target = child.text.replace(/\\(.)/g, '$1')
    } else if (child.type === 'raw_string') {
      target = stripRawString(child.text)
    } else if (child.type === 'string') {
      const s = walkString(child, innerCommands, varScope)
      if (typeof s !== 'string') return s
      target = s
    } else if (child.type === 'concatenation') {
      // `echo > "foo"bar` - tree-sitter 生成 string + word 子节点的拼接。
      // walkArgument 已验证拼接（拒绝展开，检查花括号语法）并返回拼接文本。
      const s = walkArgument(child, innerCommands, varScope)
      if (typeof s !== 'string') return s
      target = s
    } else {
      return tooComplex(child)
    }
  }

  if (!op || target === null) {
    return {
      kind: 'too-complex',
      reason: '无法识别的重定向形式',
      nodeType: node.type,
    }
  }
  return { op, target, fd }
}

/**
 * Heredoc 重定向。仅引号分隔符 heredoc（<<'EOF'）是安全的 -
 * 它们的主体是字面文本。无引号分隔符 heredoc（<<EOF）
 * 在主体中进行完整的参数/命令/算术展开。
 *
 * 安全性：tree-sitter-bash 有一个语法漏洞 - 无引号 heredoc 主体内
 * 的反引号（`...`）不被解析为 command_substitution 节点
 * （body.children 为空，反引号在 body.text 中）。但 bash 确实
 * 执行它们。我们不能通过检查 body 子节点中的展开节点来安全地
 * 放宽引号分隔符要求 - 我们会漏掉反引号替换。保持拒绝所有
 * 无引号 heredoc。用户应使用 <<'EOF' 获取字面主体，模型已经偏好此方式。
 */
function walkHeredocRedirect(node: Node): ParseForSecurityResult | null {
  let startText: string | null = null
  let body: Node | null = null

  for (const child of node.children) {
    if (!child) continue
    if (child.type === 'heredoc_start') startText = child.text
    else if (child.type === 'heredoc_body') body = child
    else if (
      child.type === '<<' ||
      child.type === '<<-' ||
      child.type === 'heredoc_end' ||
      child.type === 'file_descriptor'
    ) {
      // 预期的结构标记 —— 可安全跳过。file_descriptor
      // 覆盖带 fd 前缀的 heredoc（`cat 3<<'EOF'`）—— walkFileRedirect
      // 已将其视为良性结构标记。
    } else {
      // 安全性：tree-sitter 将 pipeline / command / file_redirect /
      // && / 等作为 heredoc_redirect 的子节点，当它们在同一行
      // 跟随分隔符时（例如 `ls <<'EOF' | rm x`）。以前这些被静默跳过，
      // 将管道命令隐藏于权限检查之外。像其他所有遍历器一样失败关闭。
      return tooComplex(child)
    }
  }

  const isQuoted =
    startText !== null &&
    ((startText.startsWith("'") && startText.endsWith("'")) ||
      (startText.startsWith('"') && startText.endsWith('"')) ||
      startText.startsWith('\\'))

  if (!isQuoted) {
    return {
      kind: 'too-complex',
      reason: '未引用分隔符的 Heredoc 会进行 shell 展开',
      nodeType: 'heredoc_redirect',
    }
  }

  if (body) {
    for (const child of body.children) {
      if (!child) continue
      if (child.type !== 'heredoc_content') {
        return tooComplex(child)
      }
    }
  }
  return null
}

/**
 * Here-string 重定向（`<<< content`）。内容成为标准输入 —— 不是 argv，
 * 不是路径。当内容是字面单词、raw_string 或无展开的 string 时安全。
 * 当内容包含 $()/${}/$VAR 时拒绝 —— 那些执行任意代码或注入运行时值。
 *
 * 重用 walkArgument 进行内容验证：它已经拒绝 command_substitution、
 * expansion 和（对于 strings）simple_expansion，除非变量被跟踪/安全。
 * 结果字符串被丢弃 —— 我们只关心它可以静态解析。
 *
 * 注意：`VAR=$(cmd) && cat <<< "$VAR"` 原则上是安全的（内部命令被
 * 单独提取，herestring 内容是标准输入）但目前被保守拒绝 ——
 * walkString 的单独占位符防护会触发，因为它不知道 herestring 与
 * argv 上下文的差异。
 */
function walkHerestringRedirect(
  node: Node,
  innerCommands: SimpleCommand[],
  varScope: Map<string, string>,
): ParseForSecurityResult | null {
  for (const child of node.children) {
    if (!child) continue
    if (child.type === '<<<') continue
    // 内容节点：重用 walkArgument。成功时返回字符串
    // （我们丢弃它 - 内容是标准输入，与权限无关）或
    // 失败时返回 too-complex 结果（找到展开，无法解析的变量）。
    const content = walkArgument(child, innerCommands, varScope)
    if (typeof content !== 'string') return content
    // Herestring 内容被丢弃（不在 argv/envVars/redirects 中）但
    // 通过原始 node.text 保留在 .text 中。在此扫描它以便
    // checkSemantics 的 NEWLINE_HASH 不变量（bashPermissions.ts 依赖它）仍成立。
    if (NEWLINE_HASH_RE.test(content)) return tooComplex(child)
  }
  return null
}

/**
 * 遍历 `command` 节点并提取 argv。子节点按顺序出现：
 * [variable_assignment...] command_name [argument...] [file_redirect...]
 * 任何未明确处理的子节点类型都会触发 too-complex。
 */
function walkCommand(
  node: Node,
  extraRedirects: Redirect[],
  innerCommands: SimpleCommand[],
  varScope: Map<string, string>,
): ParseForSecurityResult {
  const argv: string[] = []
  const envVars: { name: string; value: string }[] = []
  const redirects: Redirect[] = [...extraRedirects]

  for (const child of node.children) {
    if (!child) continue

    switch (child.type) {
      case 'variable_assignment': {
        const ev = walkVariableAssignment(child, innerCommands, varScope)
        if ('kind' in ev) return ev
        // 安全性：环境前缀赋值（`VAR=x cmd`）在 bash 中是命令局部的 -
        // VAR 仅作为环境变量对 `cmd` 可见，对后续命令不可见。
        // 不要添加到全局 varScope - 那会让 `VAR=safe cmd1 && rm $VAR`
        // 在 bash 已移除它时解析 $VAR。
        envVars.push({ name: ev.name, value: ev.value })
        break
      }
      case 'command_name': {
        const arg = walkArgument(
          child.children[0] ?? child,
          innerCommands,
          varScope,
        )
        if (typeof arg !== 'string') return arg
        argv.push(arg)
        break
      }
      case 'word':
      case 'number':
      case 'raw_string':
      case 'string':
      case 'concatenation':
      case 'arithmetic_expansion': {
        const arg = walkArgument(child, innerCommands, varScope)
        if (typeof arg !== 'string') return arg
        argv.push(arg)
        break
      }
      // 注意：作为裸参数（不在字符串内）的 command_substitution
      // 故意不在此处处理 - $() 输出就是参数，对于路径敏感命令
      // （cd、rm、chmod），占位符会隐藏下游检查的真实路径。
      // `cd $(echo /etc)` 必须保持 too-complex 以便路径检查无法绕过。
      // 字符串内的 $()（"Timer: $(date)"）在 walkString 中处理，
      // 输出嵌入在更长的字符串中（更安全）。
      case 'simple_expansion': {
        // 裸 `$VAR` 作为参数。跟踪的静态变量返回实际值
        // （例如 VAR=/etc → '/etc'）。带有 IFS/glob 字符或
        // 占位符的值拒绝。参见 resolveSimpleExpansion。
        const v = resolveSimpleExpansion(child, varScope, false)
        if (typeof v !== 'string') return v
        argv.push(v)
        break
      }
      case 'file_redirect': {
        const r = walkFileRedirect(child, innerCommands, varScope)
        if ('kind' in r) return r
        redirects.push(r)
        break
      }
      case 'herestring_redirect': {
        // `cmd <<< "content"` - 内容是标准输入，不是 argv。验证它是
        // 字面量（无展开）；丢弃内容字符串。
        const err = walkHerestringRedirect(child, innerCommands, varScope)
        if (err) return err
        break
      }
      default:
        return tooComplex(child)
    }
  }

  // .text is the raw source span. Downstream (bashToolCheckPermission →
  // splitCommand_DEPRECATED）通过 shell-quote 重新分词。通常 .text
  // 不变地使用 - 但如果我们将 $VAR 解析到 argv 中，.text 会分歧
  // （有原始 `$VAR`），下游规则匹配会错过拒绝规则。
  //
  // 安全性：`SUB=push && git $SUB --force` 带有 `Bash(git push:*)` 拒绝：
  //   argv = ['git', 'push', '--force']  ← 正确，路径验证看到 'push'
  //   .text = 'git $SUB --force'         ← 拒绝规则 'git push:*' 不匹配
  //
  // 检测：node.text 中的任何 `$<identifier>` 意味着 simple_expansion 被
  // 解析（否则我们会返回 too-complex）。这在任何位置捕获 $VAR -
  // command_name、word、字符串内部、拼接部分。`$(...)` 不匹配
  // （括号，非标识符开头）。单引号中的 `'$VAR'`：tree-sitter 的 .text
  // 包含引号，所以天真检查会在 `echo '$VAR'` 上误报。但单引号中的
  // $ 在 bash 中是字面量 - argv 有字面量 `$VAR` 字符串，所以从 argv
  // 重建产生 `'$VAR'`（shell-escape 包装它）。相同的净 .text。无规则匹配错误。
  //
  // 从 argv 重建 .text。Shell-escape 每个参数：单引号包装，
  // 嵌入的单引号用 `'\''`。空字符串、元字符和占位符都被引号引用。
  // 下游 shell-quote 重新解析正确。
  //
  // 注意：这不在重建的 .text 中包含 redirects/envVars -
  // walkFileRedirect 拒绝 simple_expansion，envVars 不用于规则匹配。
  // 如果任一更改，此重建必须包含它们。
  //
  // 安全性：当 node.text 包含换行时也重建。行续行 `<space>\<LF>`
  // 对 argv 不可见（tree-sitter 折叠它们）但保留在 node.text 中。
  // `timeout 5 \<LF>curl evil.com` → argv 正确，但原始 .text →
  // stripSafeWrappers 匹配 `timeout 5 `（\ 前的空格），留下
  // `\<LF>curl evil.com` - Bash(curl:*) 拒绝不前缀匹配。
  // 重建的 .text 用 ' ' 连接 argv → 无换行 → stripSafeWrappers 工作。
  // 也覆盖 heredoc 主体泄漏。
  const text =
    /\$[A-Za-z_]/.test(node.text) || node.text.includes('\n')
      ? argv
          .map(a =>
            a === '' || /["'\\ \t\n$`;|&<>(){}*?[\]~#]/.test(a)
              ? `'${a.replace(/'/g, "'\\''")}'`
              : a,
          )
          .join(' ')
      : node.text
  return {
    kind: 'simple',
    commands: [{ argv, envVars, redirects, text }],
  }
}

/**
 * 递归进入 command_substitution 节点的内部命令。如果内部命令
 * 解析干净（简单），将它们添加到内部命令累加器并返回 null（成功）。
 * 如果内部命令本身是 too-complex（例如，嵌套算术展开、进程替换），
 * 返回错误。这启用递归权限检查：`echo $(git rev-parse HEAD)`
 * 提取 `echo $(git rev-parse HEAD)`（外部）和 `git rev-parse HEAD`
 * （内部）- 权限规则必须匹配两者才能允许整个命令。
 */
function collectCommandSubstitution(
  csNode: Node,
  innerCommands: SimpleCommand[],
  varScope: Map<string, string>,
): ParseForSecurityResult | null {
  // $() 之前设置的变量在内部可见（bash 子 shell 语义），
  // 但内部设置的变量不会泄漏出来。传递外部作用域的副本，
  // 以便内部赋值不会改变外部映射。
  const innerScope = new Map(varScope)
  // command_substitution 子节点：`$(` 或 `` ` ``，内部语句，`)`
  for (const child of csNode.children) {
    if (!child) continue
    if (child.type === '$(' || child.type === '`' || child.type === ')') {
      continue
    }
    const err = collectCommands(child, innerCommands, innerScope)
    if (err) return err
  }
  return null
}

/**
 * 将参数节点转换为其字面字符串值。引号被解析。
 * 此函数实现参数位置的白名单。
 */
function walkArgument(
  node: Node | null,
  innerCommands: SimpleCommand[],
  varScope: Map<string, string>,
): string | ParseForSecurityResult {
  if (!node) {
    return { kind: 'too-complex', reason: '空参数节点' }
  }

  switch (node.type) {
    case 'word': {
      // 反转义反斜杠序列。在未引用上下文中，bash 的引号移除
      // 将任何字符 X 的 `\X` → `X`。tree-sitter 保留原始文本。
      // checkSemantics 需要：`\eval` 必须匹配 EVAL_LIKE_BUILTINS，
      // `\zmodload` 必须匹配 ZSH_DANGEROUS_BUILTINS。
      // 也使 argv 准确：`find -exec {} \;` → argv 有 `;` 而非 `\;`。
      // （.text 上的拒绝规则匹配已通过下游 splitCommand_DEPRECATED
      // 转义工作 - 参见 walkCommand 注释。）`\<whitespace>` 已被
      // BACKSLASH_WHITESPACE_RE 拒绝。
      if (BRACE_EXPANSION_RE.test(node.text)) {
        return {
          kind: 'too-complex',
          reason: '单词包含花括号展开语法',
          nodeType: 'word',
        }
      }
      return node.text.replace(/\\(.)/g, '$1')
    }

    case 'number':
      // 安全性：tree-sitter-bash 将 `NN#<expansion>`（算术基语法）
      // 解析为带有展开作为子节点的 `number` 节点。`10#$(cmd)`
      // 是一个 number 节点，其 .text 是完整字面量但其子节点是
      // command_substitution - bash 运行替换。带有子节点的节点上的
      // .text 会将展开偷运过权限检查。纯数字（`10`、`16#ff`）
      // 没有子节点。
      if (node.children.length > 0) {
        return {
          kind: 'too-complex',
          reason: '数字节点包含展开（NN# 算术进制语法）',
          nodeType: node.children[0]?.type,
        }
      }
      return node.text

    case 'raw_string':
      return stripRawString(node.text)

    case 'string':
      return walkString(node, innerCommands, varScope)

    case 'concatenation': {
      if (BRACE_EXPANSION_RE.test(node.text)) {
        return {
          kind: 'too-complex',
          reason: '花括号展开',
          nodeType: 'concatenation',
        }
      }
      let result = ''
      for (const child of node.children) {
        if (!child) continue
        const part = walkArgument(child, innerCommands, varScope)
        if (typeof part !== 'string') return part
        result += part
      }
      return result
    }

    case 'arithmetic_expansion': {
      const err = walkArithmetic(node)
      if (err) return err
      return node.text
    }

    case 'simple_expansion': {
      // 拼接内的 `$VAR`（例如 `prefix$VAR`）。与 walkCommand 中
      // 裸情况相同的规则：必须是已跟踪的或 SAFE_ENV_VARS。
      // 拼接内部算作裸参数（整个拼接就是参数）
      return resolveSimpleExpansion(node, varScope, false)
    }

    // 注意：参数位置的 command_substitution（裸或在拼接内部）故意不处理 ——
    // 输出是/成为位置参数的一部分，可能是路径或标志。`rm $(foo)` 或
    // `rm $(foo)bar` 会将真实路径隐藏在占位符之后。只有在 `string` 节点
    // 内部（walkString）的 $() 才会被提取，因为输出嵌入在更长的字符串中
    // 而不是成为参数本身。

    default:
      return tooComplex(node)
  }
}

/**
 * 从双引号字符串节点提取字面内容。`string` 节点的子节点是 `"` 分隔符、
 * `string_content` 字面量和可能的展开节点。
 *
 * tree-sitter 怪癖：双引号内的字面换行不包含在 `string_content` 节点文本中。
 * bash 保留它们。对于 `"a\nb"`，tree-sitter 生成两个 `string_content` 子节点
 * （`"a"`、`"b"`），换行不在任何一个中。对于 `"\n#"`，它生成一个子节点（`"#"`），
 * 前导换行被吃掉。因此拼接子节点会丢失换行。
 *
 * 修复：跟踪子节点的 `startIndex` 并在每个索引间隙插入一个 `\n`。
 * 子节点之间的间隙就是被丢弃的换行。这使得 argv 值与 bash 实际看到的匹配。
 */
function walkString(
  node: Node,
  innerCommands: SimpleCommand[],
  varScope: Map<string, string>,
): string | ParseForSecurityResult {
  let result = ''
  let cursor = -1
  // 安全性：跟踪字符串是否包含运行时未知的占位符（$() 输出或未知值的
  // 已跟踪变量）与任何字面内容。只有占位符的字符串（`"$(cmd)"`、`"$VAR"`
  // 其中 VAR 持有未知哨兵）产生的 argv 元素就是占位符 —— 下游路径验证
  // 将其解析为 cwd 内的相对文件名，绕过检查。`cd "$(echo /etc)"` 会通过
  // 验证但在运行时 cd 到 /etc。我们拒绝单独的占位符字符串；与字面内容
  // 混合的占位符（`"prefix: $(cmd)"`）是安全的 —— 运行时值不能等于裸路径。
  let sawDynamicPlaceholder = false
  let sawLiteralContent = false
  for (const child of node.children) {
    if (!child) continue
    // 此子节点与前一个之间的索引间隔 = 丢弃的换行符。
    // 忽略第一个非分隔符子节点前的间隔（cursor === -1）。
    // 跳过 `"` 分隔符的间隔填充：闭合 `"` 前的间隔是
    // tree-sitter 仅空白字符串怪癖（空格/制表符，非换行）-
    // 让下方的 Fix C 检查将其捕获为 too-complex 而非用 `\n`
    // 错误填充并与 bash 分歧。
    if (cursor !== -1 && child.startIndex > cursor && child.type !== '"') {
      result += '\n'.repeat(child.startIndex - cursor)
      sawLiteralContent = true
    }
    cursor = child.endIndex
    switch (child.type) {
      case '"':
        // 在开引号后重置光标，以便捕获 `"` 和第一个内容子节点之间的间隔。
        cursor = child.endIndex
        break
      case 'string_content':
        // Bash 双引号转义规则（不是 walkArgument 中用于
        // 未引用单词的通用 /\\(.)/g）：在 "..." 内，反斜杠仅
        // 转义 $ ` " \ - 其他序列如 \n 保持字面量。所以
        // `"fix \"bug\""` → `fix "bug"`，但 `"a\nb"` → `a\nb`
        // （保留反斜杠）。tree-sitter 在 .text 中保留原始转义；
        // 我们在此解析它们以便 argv 匹配 bash 实际传递的内容。
        result += child.text.replace(/\\([$`"\\])/g, '$1')
        sawLiteralContent = true
        break
      case DOLLAR:
        // 闭合引号前或非名称字符前的裸美元符号在 bash 中是字面量。
        // tree-sitter 将其作为独立节点发出。
        result += DOLLAR
        sawLiteralContent = true
        break
      case 'command_substitution': {
        // 特殊处理：`$(cat <<'EOF' ... EOF)` 是安全的。引号分隔符
        // heredoc 主体是字面量（无展开），`cat` 只是打印它。
        // 因此替换结果是已知的静态字符串。这种模式是将多行内容
        // 传递给工具如 `gh pr create --body` 的习惯用法。我们
        // 用占位符 argv 值替换替换 - 实际内容对权限检查不重要，
        // 重要的是它是静态的。
        const heredocBody = extractSafeCatHeredoc(child)
        if (heredocBody === 'DANGEROUS') return tooComplex(child)
        if (heredocBody !== null) {
          // 安全性：主体就是替换结果。以前我们丢弃它 →
          // `rm "$(cat <<'EOF'\n/etc/passwd\nEOF)"` 产生 argv ['rm','']
          // 而 bash 运行 `rm /etc/passwd`。validatePath('') 解析到 cwd →
          // 允许。每个路径受限命令都通过此方式绕过。现在：追加主体
          // （尾部 LF 修剪 - bash $() 修剪尾部换行）。
          //
          // 权衡：内部有换行的主体是多行文本（markdown、脚本），
          // 不能是有效路径 - 安全地丢弃以避免 NEWLINE_HASH_RE
          // 在 `## Summary` 上的误报。单行主体（如 `/etc/passwd`）
          // 必须进入 argv 以便下游路径验证看到真实目标。
          const trimmed = heredocBody.replace(/\n+$/, '')
          if (trimmed.includes('\n')) {
            sawLiteralContent = true
            break
          }
          result += trimmed
          sawLiteralContent = true
          break
        }
        // "..." 内的一般 $()：递归进入内部命令。如果它们解析干净，
        // 它们成为权限系统必须匹配规则的额外子命令。外部 argv
        // 获得原始 $() 文本作为占位符（运行时确定的值）。
        // `echo "SHA: $(git rev-parse HEAD)"` → 提取两者
        // `echo "SHA: $(...)"` 和 `git rev-parse HEAD` - 两者都必须
        // 匹配权限规则。在 top-5k ant 命令中约占 too-complex 的 27%。
        const err = collectCommandSubstitution(child, innerCommands, varScope)
        if (err) return err
        result += CMDSUB_PLACEHOLDER
        sawDynamicPlaceholder = true
        break
      }
      case 'simple_expansion': {
        // "..." 内的 `$VAR`。跟踪/安全变量解析；未跟踪的拒绝。
        const v = resolveSimpleExpansion(child, varScope, true)
        if (typeof v !== 'string') return v
        // VAR_PLACEHOLDER = 运行时未知（循环变量、read 变量、$() 输出、
        // SAFE_ENV_VARS、特殊变量）。任何其他字符串 = 来自跟踪的
        // 静态变量的实际字面值（例如 VAR=/tmp → v='/tmp'）。
        if (v === VAR_PLACEHOLDER) sawDynamicPlaceholder = true
        else sawLiteralContent = true
        result += v
        break
      }
      case 'arithmetic_expansion': {
        const err = walkArithmetic(child)
        if (err) return err
        result += child.text
        // 已验证为字面数字 —— 静态内容。
        sawLiteralContent = true
        break
      }
      default:
        // "..." 内的 expansion（${...}）
        return tooComplex(child)
    }
  }
  // 安全性：拒绝单独的占位符字符串。`"$(cmd)"` 或 `"$VAR"`（其中 VAR
  // 持有未知值）会产生一个就是占位符的 argv 元素 —— 这会绕过下游路径
  // 验证（validatePath 将占位符解析为 cwd 内的相对文件名）。只允许与字面
  // 内容一起嵌入的占位符（`"prefix: $(cmd)"`）。
  if (sawDynamicPlaceholder && !sawLiteralContent) {
    return tooComplex(node)
  }
  // 安全性：tree-sitter-bash 怪癖 —— 只包含空白（` "`, `" "`, `"\t"`）的
  // 双引号字符串不产生 string_content 子节点；空白被归因于闭合 `"` 节点
  // 的文本。我们的循环只从 string_content/expansion 子节点添加到 `result`，
  // 所以当 bash 看到 " " 时我们会返回 ""。检测：我们没有看到内容子节点
  // （两个标志都为 false —— 既没有字面量也没有占位符添加）但源跨度比
  // 裸 `""` 长。真正的 `""` 有 text.length==2。`"$V"` 且 V="" 不会命中
  // 这个 —— simple_expansion 子节点通过 `else` 分支设置 sawLiteralContent，
  // 即使 v 为空。
  if (!sawLiteralContent && !sawDynamicPlaceholder && node.text.length > 2) {
    return tooComplex(node)
  }
  return result
}

/**
 * 算术展开内的安全叶子节点：整数字面量（十进制、十六进制、八进制、
 * bash base#digits）和操作符/括号标记。叶子位置（不是数字字面量的
 * variable_name）的任何其他内容都会被拒绝。
 */
const ARITH_LEAF_RE =
  /^(?:[0-9]+|0[xX][0-9a-fA-F]+|[0-9]+#[0-9a-zA-Z]+|[-+*/%^&|~!<>=?:(),]+|<<|>>|\*\*|&&|\|\||[<>=!]=|\$\(\(|\)\))$/

/**
 * 递归验证 arithmetic_expansion 节点。只允许字面数字表达式 —— 无变量，
 * 无替换。安全时返回 null，不安全时返回 too-complex 结果。
 *
 * 变量被拒绝是因为 bash 算术递归计算变量值：如果 x='a[$(cmd)]'
 * 则 $((x)) 执行 cmd。参见 https://www.vidarholen.net/contents/blog/?p=716
 * （算术注入）。
 *
 * 安全时，调用者将完整的 `$((…))` 跨度作为字面字符串放入 argv。
 * bash 会在运行时将其展开为整数；静态字符串不会匹配任何敏感路径/拒绝模式。
 */
function walkArithmetic(node: Node): ParseForSecurityResult | null {
  for (const child of node.children) {
    if (!child) continue
    if (child.children.length === 0) {
      if (!ARITH_LEAF_RE.test(child.text)) {
        return {
          kind: 'too-complex',
          reason: `算术展开引用了变量或非字面量：${child.text}`,
          nodeType: 'arithmetic_expansion',
        }
      }
      continue
    }
    switch (child.type) {
      case 'binary_expression':
      case 'unary_expression':
      case 'ternary_expression':
      case 'parenthesized_expression': {
        const err = walkArithmetic(child)
        if (err) return err
        break
      }
      default:
        return tooComplex(child)
    }
  }
  return null
}

/**
 * Check if a command_substitution node is exactly `$(cat <<'DELIM'...DELIM)`
 * and return the heredoc body if so. Any deviation (extra args to cat,
 * unquoted delimiter, additional commands) returns null.
 *
 * tree-sitter structure:
 *   command_substitution
 *     $(
 *     redirected_statement
 *       command → command_name → word "cat"    (exactly one child)
 *       heredoc_redirect
 *         <<
 *         heredoc_start 'DELIM'                (quoted)
 *         heredoc_body                         (pure heredoc_content)
 *         heredoc_end
 *     )
 */
function extractSafeCatHeredoc(subNode: Node): string | 'DANGEROUS' | null {
  // 期望恰好：$( + 一个 redirected_statement + )
  let stmt: Node | null = null
  for (const child of subNode.children) {
    if (!child) continue
    if (child.type === '$(' || child.type === ')') continue
    if (child.type === 'redirected_statement' && stmt === null) {
      stmt = child
    } else {
      return null
    }
  }
  if (!stmt) return null

  // redirected_statement 必须是：command(cat) + heredoc_redirect（引号分隔）
  let sawCat = false
  let body: string | null = null
  for (const child of stmt.children) {
    if (!child) continue
    if (child.type === 'command') {
      // 必须是裸 `cat` - 无参数，无环境变量
      const cmdChildren = child.children.filter(c => c)
      if (cmdChildren.length !== 1) return null
      const nameNode = cmdChildren[0]
      if (nameNode?.type !== 'command_name' || nameNode.text !== 'cat') {
        return null
      }
      sawCat = true
    } else if (child.type === 'heredoc_redirect') {
      // 重用现有验证器：引号分隔符，主体是纯文本。
      // walkHeredocRedirect 成功时返回 null，拒绝时返回非 null。
      if (walkHeredocRedirect(child) !== null) return null
      for (const hc of child.children) {
        if (hc?.type === 'heredoc_body') body = hc.text
      }
    } else {
      return null
    }
  }

  if (!sawCat || body === null) return null
  // 安全性：heredoc 主体通过替换成为外部命令的 argv 值，
  // 所以像 `/proc/self/environ` 这样的主体在语义上是
  // `cat /proc/self/environ`。checkSemantics 从未看到主体
  // （我们在 walkString 调用站点丢弃它以避免换行+# 误报）。
  // 在此返回 `null` 会落到 walkString 中的 collectCommandSubstitution，
  // 它会通过 walkHeredocRedirect 提取内部 `cat`（此处不检查主体文本）-
  // 有效地绕过此检查。返回不同的标记以便调用者拒绝而非落入。
  if (PROC_ENVIRON_RE.test(body)) return 'DANGEROUS'
  // jq system() 同理：checkSemantics 检查 argv 但从未看到 heredoc 主体。
  // 无条件检查（我们不知道外部命令）。
  if (/\bsystem\s*\(/.test(body)) return 'DANGEROUS'
  return body
}

function walkVariableAssignment(
  node: Node,
  innerCommands: SimpleCommand[],
  varScope: Map<string, string>,
): { name: string; value: string; isAppend: boolean } | ParseForSecurityResult {
  let name: string | null = null
  let value = ''
  let isAppend = false

  for (const child of node.children) {
    if (!child) continue
    if (child.type === 'variable_name') {
      name = child.text
    } else if (child.type === '=' || child.type === '+=') {
      // `PATH+=":/new"` - tree-sitter 发出 `+=` 作为不同的操作符节点。
      // 没有此情况它会落到下方的 walkArgument → 未知类型 `+=` 的 tooComplex。
      isAppend = child.type === '+='
    } else if (child.type === 'command_substitution') {
      // $() 作为变量的值。输出成为存储在变量中的字符串 —— 它不是
      // 位置参数（无路径/标志问题）。`VAR=$(date)` 运行 `date`，存储
      // 输出。`VAR=$(rm -rf /)` 运行 `rm` —— 内部命令确实被检查权限规则，
      // 所以 `rm` 必须匹配规则。变量只保存 `rm` 打印的任何内容。
      const err = collectCommandSubstitution(child, innerCommands, varScope)
      if (err) return err
      value = CMDSUB_PLACEHOLDER
    } else if (child.type === 'simple_expansion') {
      // `VAR=$OTHER` —— 赋值右侧在 bash 中不进行分词或通配符展开
      // （与命令参数不同）。所以 `A="a b"; B=$A` 将 B 设置为字面的
      // "a b"。像在字符串内部一样解析（insideString=true），以便
      // BARE_VAR_UNSAFE_RE 不会过度拒绝。结果值可能
      // 包含空格/glob - 如果 B 后来用作裸参数，该使用
      // 将通过 BARE_VAR_UNSAFE_RE 正确拒绝。
      const v = resolveSimpleExpansion(child, varScope, true)
      if (typeof v !== 'string') return v
      // 如果 v 是 VAR_PLACEHOLDER（OTHER 持有未知值），存储它 -
      // 与调用者中的 containsAnyPlaceholder 结合以视为未知。
      value = v
    } else {
      const v = walkArgument(child, innerCommands, varScope)
      if (typeof v !== 'string') return v
      value = v
    }
  }

  if (name === null) {
    return {
      kind: 'too-complex',
      reason: '变量赋值没有名称',
      nodeType: 'variable_assignment',
    }
  }
  // 安全性：tree-sitter-bash 接受无效变量名（例如 `1VAR=value`）
  // 作为 variable_assignment。Bash 仅识别 [A-Za-z_][A-Za-z0-9_]* -
  // 其他任何内容都作为命令运行。`1VAR=value` → bash 尝试从 PATH
  // 执行 `1VAR=value`。我们不得将其视为惰性赋值。
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return {
      kind: 'too-complex',
      reason: `无效变量名（bash 视为命令）：${name}`,
      nodeType: 'variable_assignment',
    }
  }
  // 安全性：设置 IFS 会改变后续未引用 $VAR 展开的分词行为。
  // `IFS=: && VAR=a:b && rm $VAR` → bash 在 `:` 上分割 → `rm a b`。
  // 我们的 BARE_VAR_UNSAFE_RE 只检查默认 IFS 字符（空格/制表符/换行）
  // —— 我们无法建模自定义 IFS。拒绝。
  if (name === 'IFS') {
    return {
      kind: 'too-complex',
      reason: 'IFS 赋值改变分词 —— 无法静态建模',
      nodeType: 'variable_assignment',
    }
  }
  // 安全性：PS4 在 `set -x` 后跟踪的每个命令上通过 promptvars（默认开启）展开。
  // 包含 $(cmd) 或 `cmd` 的 raw_string 值在跟踪时执行：
  // `PS4='$(id)' && set -x && :` 运行 id，但我们的 argv 只有
  // [["set","-x"],[":"]] —— 有效载荷对权限检查不可见。PS0-3 和
  // PROMPT_COMMAND 在非交互式 shell（BashTool）中不展开。
  //
  // 白名单，而非黑名单。5 轮绕过补丁告诉我们依赖值的黑名单在结构上很脆弱：
  //   - `+=` 有效值计算在多个作用域模型差距中与 bash 分歧：`||` 重置、
  //     环境变量前缀链（PS4='' && PS4='$' PS4+='(id)' cmd 读取过时的父值）、
  //     子 shell。
  //   - bash 的 decode_prompt_string 在 promptvars 之前运行，所以 `\044(id)`
  //     （`$` 的八进制）在跟踪时变成 `$(id)` —— 任何字面字符检查都必须
  //     精确建模 prompt-escape 解码。
  //   - 赋值路径存在于 walkVariableAssignment 之外（for_statement
  //     直接设置 loopVar，见该处理器的 PS4 检查）。
  //
  // 策略：（1）直接拒绝 += —— 无作用域跟踪依赖；用户可以合并为一个
  // PS4=...（2）拒绝占位符 —— 运行时不可知。（3）白名单剩余值：
  // ${identifier} 引用（仅值读取，安全）加上 [A-Za-z0-9 _+:.\/=[\]-]。
  // 无裸 `$`（阻止分割原语），无 `\`（阻止八进制 \044/\140），无反引号，
  // 无括号。覆盖所有已知编码向量和未来的 —— 白名单外的任何内容都失败。
  // 合法的 `PS4='+${BASH_SOURCE}:${LINENO}: '` 仍然通过。
  if (name === 'PS4') {
    if (isAppend) {
      return {
        kind: 'too-complex',
        reason:
          'PS4 += cannot be statically verified — combine into a single PS4= assignment',
        nodeType: 'variable_assignment',
      }
    }
    if (containsAnyPlaceholder(value)) {
      return {
        kind: 'too-complex',
        reason: 'PS4 值派生自命令替换/变量 —— 运行时不可知',
        nodeType: 'variable_assignment',
      }
    }
    if (
      !/^[A-Za-z0-9 _+:./=[\]-]*$/.test(
        value.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, ''),
      )
    ) {
      return {
        kind: 'too-complex',
        reason:
          // biome-ignore lint/suspicious/noTemplateCurlyInString: ${VAR} is bash syntax documentation, not a JS template literal
          'PS4 value outside safe charset — only ${VAR} refs and [A-Za-z0-9 _+:.=/[]-] allowed',
        nodeType: 'variable_assignment',
      }
    }
  }
  // 安全性：赋值右侧的波浪号展开。`VAR=~/x`（未引用）→
  // bash 在赋值时展开 `~` → VAR='/home/user/x'。我们看到字面的 `~/x`。
  // 后续 `cd $VAR` → 我们的 argv `['cd','~/x']`，bash 运行 `cd /home/user/x`。
  // 波浪号展开也发生在赋值值的 `=` 和 `:` 之后（例如 PATH=~/bin:~/sbin）。
  // 我们无法建模 —— 拒绝任何包含 `~` 的值，除非它已经是引号字面量
  // （bash 不展开的地方）。保守：值中的任何 `~` → 拒绝。
  if (value.includes('~')) {
    return {
      kind: 'too-complex',
      reason: '赋值值中的波浪号 —— bash 可能在赋值时展开',
      nodeType: 'variable_assignment',
    }
  }
  return { name, value, isAppend }
}

/**
 * 解析 `simple_expansion`（$VAR）节点。可解析时返回 VAR_PLACEHOLDER，
 * 否则返回 too-complex。
 *
 * @param insideString 当 $VAR 在 `string` 节点（"...$VAR..."）内部时为 true，
 *   而非裸/拼接参数。SAFE_ENV_VARS 和未知值的已跟踪变量只允许在字符串内部 ——
 *   作为裸参数，它们的运行时值就是参数本身，我们无法静态知道。
 *   `cd $HOME/../x` 会将真实路径隐藏在占位符之后；
 *   `echo "Home: $HOME"` 只是在字符串中嵌入文本。持有静态字符串
 *   （VAR=字面量）的已跟踪变量在两个位置都允许，因为它们的值是已知的。
 */
function resolveSimpleExpansion(
  node: Node,
  varScope: Map<string, string>,
  insideString: boolean,
): string | ParseForSecurityResult {
  let varName: string | null = null
  let isSpecial = false
  for (const c of node.children) {
    if (c?.type === 'variable_name') {
      varName = c.text
      break
    }
    if (c?.type === 'special_variable_name') {
      varName = c.text
      isSpecial = true
      break
    }
  }
  if (varName === null) return tooComplex(node)
  // 跟踪的变量：检查存储的值。字面字符串（VAR=/tmp）直接返回
  // 以便下游路径验证看到真实路径。非字面值（包含任何占位符 -
  // 循环变量、$() 输出、read 变量、组合值如 `VAR="prefix$(cmd)"`）
  // 仅在字符串内安全；作为裸参数它们会隐藏运行时路径/标志不被验证。
  //
  // 安全性：返回实际 trackedValue（非占位符）是关键修复。
  // `VAR=/etc && rm $VAR` → argv ['rm', '/etc'] → validatePath 正确拒绝。
  // 以前返回占位符 → validatePath 看到 '__LOOP_STATIC__'，解析为
  // cwd 相对 → 通过 → 绕过。
  const trackedValue = varScope.get(varName)
  if (trackedValue !== undefined) {
    if (containsAnyPlaceholder(trackedValue)) {
      // 非字面量：裸 → 拒绝，字符串内 → VAR_PLACEHOLDER
      // （walkString 的单独占位符门控拒绝单独的 `"$VAR"`）。
      if (!insideString) return tooComplex(node)
      return VAR_PLACEHOLDER
    }
    // 纯字面量（例如 '/tmp'、'foo'）- 直接返回。下游
    // 路径验证 / checkSemantics 在真实值上操作。
    //
    // 安全性：对于裸参数（不在字符串内），bash 在 $IFS 上分词
    // 并 glob 展开结果。`VAR="-rf /" && rm $VAR` → bash 运行
    // `rm -rf /`（两个参数）；`VAR="/etc/*" && cat $VAR` → 展开为
    // 所有文件。拒绝包含 IFS/glob 字符的值，除非在 "..." 内。
    //
    // 安全性：空值作为裸参数。Bash 在 "" 上进行分词产生零个字段 ——
    // 展开消失。`V="" && $V eval x` → bash 运行 `eval x`（我们的 argv
    // 将是 ["","eval","x"]，name="" —— 每个 EVAL_LIKE/ZSH/关键字检查
    // 都错过）。`V="" && ls $V /etc` → bash 运行 `ls /etc`，我们的 argv
    // 有一个幽灵 "" 移位位置。在 "..." 内部：`"$V"` → bash 产生一个
    // 空字符串参数 → 我们的 "" 是正确的，继续允许。
    if (!insideString) {
      if (trackedValue === '') return tooComplex(node)
      if (BARE_VAR_UNSAFE_RE.test(trackedValue)) return tooComplex(node)
    }
    return trackedValue
  }
  // SAFE_ENV_VARS + 特殊变量（$?、$$、$@、$1 等）：值未知（shell 控制）。
  // 只在嵌入字符串时安全，不作为路径敏感命令的裸参数。
  if (insideString) {
    if (SAFE_ENV_VARS.has(varName)) return VAR_PLACEHOLDER
    if (
      isSpecial &&
      (SPECIAL_VAR_NAMES.has(varName) || /^[0-9]+$/.test(varName))
    ) {
      return VAR_PLACEHOLDER
    }
  }
  return tooComplex(node)
}

/**
 * 将变量赋值应用到作用域，处理 `+=` 追加语义。
 * 安全性：如果任一侧（现有值或追加值）包含占位符，结果是非字面的 ——
 * 存储 VAR_PLACEHOLDER 以便后续的 $VAR 作为裸参数时正确拒绝。
 * `VAR=/etc && VAR+=$(cmd)` 不得使 VAR 看起来是静态的。
 */
function applyVarToScope(
  varScope: Map<string, string>,
  ev: { name: string; value: string; isAppend: boolean },
): void {
  const existing = varScope.get(ev.name) ?? ''
  const combined = ev.isAppend ? existing + ev.value : ev.value
  varScope.set(
    ev.name,
    containsAnyPlaceholder(combined) ? VAR_PLACEHOLDER : combined,
  )
}

function stripRawString(text: string): string {
  return text.slice(1, -1)
}

function tooComplex(node: Node): ParseForSecurityResult {
  const reason =
    node.type === 'ERROR'
      ? 'Parse error'
      : DANGEROUS_TYPES.has(node.type)
        ? `Contains ${node.type}`
        : `Unhandled node type: ${node.type}`
  return { kind: 'too-complex', reason, nodeType: node.type }
}

// ────────────────────────────────────────────────────────────────────────────
// Post-argv 语义检查
//
// 上面的所有内容回答"我们能分词吗？"。下面的所有内容回答
// "结果 argv 是否以不涉及解析的方式危险？"。这些是对 argv[0]
// 或 argv 内容的检查，旧的 bashSecurity.ts 验证器执行了这些检查，
// 但它们与解析器差异无关。它们在这里（不在 bashSecurity.ts 中）
// 是因为它们在 SimpleCommand 上操作并且需要为每个提取的命令运行。
// ────────────────────────────────────────────────────────────────────────────

/**
 * Zsh 模块内建命令。这些不是 PATH 上的二进制文件 - 它们是通过
 * zmodload 加载的 zsh 内部命令。由于 BashTool 通过用户的默认
 * shell（通常是 zsh）运行，且这些解析为普通的 `command` 节点，
 * 没有区分语法，我们只能通过名称捕获它们。
 */
const ZSH_DANGEROUS_BUILTINS = new Set([
  'zmodload',
  'emulate',
  'sysopen',
  'sysread',
  'syswrite',
  'sysseek',
  'zpty',
  'ztcp',
  'zsocket',
  'zf_rm',
  'zf_mv',
  'zf_ln',
  'zf_chmod',
  'zf_chown',
  'zf_mkdir',
  'zf_rmdir',
  'zf_chgrp',
])

/**
 * 将其参数作为代码计算或以其他方式逃避 argv 抽象的 shell 内建命令。
 * 像 `eval "rm -rf /"` 这样的命令有 argv ['eval', 'rm -rf /']，
 * 对标志验证看起来是惰性的但执行该字符串。将这些与命令替换同等对待。
 */
const EVAL_LIKE_BUILTINS = new Set([
  'eval',
  'source',
  '.',
  'exec',
  'command',
  'builtin',
  'fc',
  // `coproc rm -rf /` 将 rm 作为协同进程生成。tree-sitter 将其解析为
  // 带有 argv[0]='coproc' 的普通命令，所以权限规则和路径验证
  // 会检查 'coproc' 而非 'rm'。
  'coproc',
  // Zsh 预命令修饰符：`noglob cmd args` 在关闭 globbing 的情况下运行 cmd。
  // 它们解析为普通命令（noglob 是 argv[0]，真正的命令是 argv[1]）
  // 所以针对 argv[0] 的权限匹配会看到 'noglob'，而非包装的命令。
  'noglob',
  'nocorrect',
  // `trap 'cmd' SIGNAL` - cmd 在信号/退出时作为 shell 代码运行。
  // EXIT 在每次 BashTool 调用结束时触发，所以这保证执行。
  'trap',
  // `enable -f /path/lib.so name` - 将任意 .so 作为内建命令 dlopen。
  // 原生代码执行。
  'enable',
  // `mapfile -C callback -c N` / `readarray -C callback` — callback runs as
  // 每 N 行输入执行 shell 代码。
  'mapfile',
  'readarray',
  // `hash -p /path cmd` - 污染 bash 的命令查找缓存。同一命令中
  // 后续的 `cmd` 解析为 /path 而非 PATH 查找。
  'hash',
  // `bind -x '"key":cmd'` / `complete -C cmd` - 仅交互式的回调
  // 但仍然是代码字符串参数。在非交互式 BashTool shell 中影响较低，
  // 为一致性阻止。`compgen -C cmd` 不是仅交互式的：它立即执行
  // -C 参数以生成补全。
  'bind',
  'complete',
  'compgen',
  // `alias name='cmd'` - 默认情况下非交互式 bash 不展开别名，
  // 但 `shopt -s expand_aliases` 启用它们。也作为纵深防御阻止
  // （别名后跟同一命令中的名称使用）。
  'alias',
  // `let EXPR` 算术计算 EXPR - 与 $(( EXPR )) 相同。
  // 表达式中的数组下标在计算时展开 $(cmd)，即使
  // 参数是单引号到达：`let 'x=a[$(id)]'` 执行 id。
  // tree-sitter 将 raw_string 视为不透明叶子。与
  // walkArithmetic 相同的原语防护，但 `let` 是普通命令节点。
  'let',
])

/**
 * 内部重新解析 NAME 操作数并算术计算 `arr[EXPR]` 下标的内建命令 -
 * 包括下标中的 $(cmd) - 即使 argv 元素来自单引号 raw_string。
 * `test -v 'a[$(id)]'` → tree-sitter 看到不透明叶子，bash 运行 id。
 * 映射：内建命令名 → 下一个参数是 NAME 的标志集合。
 */
const SUBSCRIPT_EVAL_FLAGS: Record<string, Set<string>> = {
  test: new Set(['-v', '-R']),
  '[': new Set(['-v', '-R']),
  '[[': new Set(['-v', '-R']),
  printf: new Set(['-v']),
  read: new Set(['-a']),
  unset: new Set(['-v']),
  // bash 5.1+：`wait -p VAR [id...]` 将等待的 PID 存储到 VAR 中。当 VAR
  // 是 `arr[EXPR]`，bash 算术计算下标 —— 即使来自单引号 raw_string 也
  // 运行 $(cmd)。已验证 bash 5.3.9：`: & wait -p 'a[$(id)]' %1` 执行 id。
  wait: new Set(['-p']),
}

/**
 * `[[ ARG1 OP ARG2 ]]`，其中 OP 是算术比较。bash 手册："当与 [[ 一起使用
 * 时，Arg1 和 Arg2 作为算术表达式计算。"算术计算递归展开数组下标，
 * 所以 `[[ 'a[$(id)]' -eq 0 ]]` 执行 `id`，即使 tree-sitter 将操作数视为
 * 不透明的 raw_string 叶子节点。与 -v/-R（一元，标志后是 NAME）不同，
 * 这些是二元的 —— 下标可以出现在任一侧，所以 SUBSCRIPT_EVAL_FLAGS 的
 * "下一个参数"逻辑不够。`[` / `test` 不受影响（bash 报错"期望整数表达式"），
 * 但 test_command 处理器为两种形式规范化 argv[0]='[['，所以它们也获得
 * 此检查 —— 轻微过度阻止，安全侧。
 */
const TEST_ARITH_CMP_OPS = new Set(['-eq', '-ne', '-lt', '-le', '-gt', '-ge'])

/**
 * 内建命令，其中每个非标志位置参数都是 NAME，bash 重新解析并算术计算
 * 下标 —— 不需要标志。`read 'a[$(id)]'` 执行 id：每个位置参数是要赋值
 * 的变量名，`arr[EXPR]` 在那里是有效语法。`unset NAME...` 相同（虽然
 * tree-sitter 的 unset_command 处理器在到达这里之前拒绝 raw_string 子节点
 * —— 这是纵深防御）。不是 printf（位置参数是 FORMAT/data），不是 test/[
 * （操作数是值，只有 -v/-R 接受 NAME）。declare/typeset/local 在
 * declaration_command 中处理，因为它们作为普通命令永远不到达这里。
 */
const BARE_SUBSCRIPT_NAME_BUILTINS = new Set(['read', 'unset'])

/**
 * `read` 标志，其下一个参数是数据（提示/分隔符/计数/fd），而非 NAME。
 * `read -p '[foo] ' var` 不得在提示字符串中的 `[` 上触发。`-a` 故意缺失
 * —— 它的操作数是 NAME。
 */
const READ_DATA_FLAGS = new Set(['-p', '-d', '-n', '-N', '-t', '-u', '-i'])

// SHELL_KEYWORDS 从 bashParser.ts 导入 —— shell 保留字永远不能是合法的
// argv[0]；如果它们出现，解析器错误解析了复合命令。拒绝以避免无意义的
// argv 到达下游。

// 使用 `.*` 而非 `[^/]*` - Linux 在 procfs 中解析 `..`，所以
// `/proc/self/../self/environ` 有效且必须被捕获。
const PROC_ENVIRON_RE = /\/proc\/.*\/environ/

/**
 * argv 元素、环境变量值或重定向目标中的换行后跟 `#`。
 * 下游 stripSafeWrappers 逐行重新分词 .text 并将换行后的 `#`
 * 视为注释，隐藏后续的参数。
 */
const NEWLINE_HASH_RE = /\n[ \t]*#/

export type SemanticCheckResult = { ok: true } | { ok: false; reason: string }

/**
 * Post-argv 语义检查。在 parseForSecurity 返回 'simple' 后运行，
 * 以捕获分词正常但按名称或参数内容危险的命令。返回第一个失败
 * 或 {ok: true}。
 */
export function checkSemantics(commands: SimpleCommand[]): SemanticCheckResult {
  for (const cmd of commands) {
    // 剥离安全包装命令（nohup、time、timeout N、nice -n N）以便
    // `nohup eval "..."` 和 `timeout 5 jq 'system(...)'` 针对
    // 包装的命令检查，而非包装器。在此内联以避免与 bashPermissions.ts
    // 的循环导入。
    let a = cmd.argv
    for (;;) {
      if (a[0] === 'time' || a[0] === 'nohup') {
        a = a.slice(1)
      } else if (a[0] === 'timeout') {
        // `timeout 5`、`timeout 5s`、`timeout 5.5`，加上持续时间前的可选 GNU 标志。
        // 长标志：--foreground、--kill-after=N、--signal=SIG、--preserve-status。
        // 短标志：-k DUR、-s SIG、-v（也可融合：-k5、-sTERM）。
        // 安全性（SAST 2026 年 3 月）：先前的循环仅跳过 `--long` 标志，
        // 所以 `timeout -k 5 10 eval ...` 以 name='timeout' 跳出，
        // 包装的 eval 从未被检查。现在处理已知的短标志并在任何
        // 未识别的标志上失败关闭 - 未知标志意味着我们无法定位
        // 包装的命令，所以我们不得静默落到 name='timeout'。
        let i = 1
        while (i < a.length) {
          const arg = a[i]!
          if (
            arg === '--foreground' ||
            arg === '--preserve-status' ||
            arg === '--verbose'
          ) {
            i++ // known no-value long flags
          } else if (/^--(?:kill-after|signal)=[A-Za-z0-9_.+-]+$/.test(arg)) {
            i++ // --kill-after=5, --signal=TERM (value fused with =)
          } else if (
            (arg === '--kill-after' || arg === '--signal') &&
            a[i + 1] &&
            /^[A-Za-z0-9_.+-]+$/.test(a[i + 1]!)
          ) {
            i += 2 // --kill-after 5, --signal TERM (space-separated)
          } else if (arg.startsWith('--')) {
            // 未知的长标志，或 --kill-after/--signal 带有不在允许列表中的值
            // （例如来自 $() 替换的占位符）。失败关闭。
            return {
              ok: false,
              reason: `timeout 带 ${arg} 标志无法静态分析`,
            }
          } else if (arg === '-v') {
            i++ // --verbose，无参数
          } else if (
            (arg === '-k' || arg === '-s') &&
            a[i + 1] &&
            /^[A-Za-z0-9_.+-]+$/.test(a[i + 1]!)
          ) {
            i += 2 // -k DURATION / -s SIGNAL - 分离的值
          } else if (/^-[ks][A-Za-z0-9_.+-]+$/.test(arg)) {
            i++ // 融合：-k5、-sTERM
          } else if (arg.startsWith('-')) {
            // 未知标志或 -k/-s 带有不在允许列表中的值 - 无法定位
            // 包装的命令。拒绝，不要落到 name='timeout'。
            return {
              ok: false,
              reason: `timeout 带 ${arg} 标志无法静态分析`,
            }
          } else {
            break // 非标志 - 应该是持续时间
          }
        }
        if (a[i] && /^\d+(?:\.\d+)?[smhd]?$/.test(a[i]!)) {
          a = a.slice(i + 1)
        } else if (a[i]) {
          // 安全性（PR #21503 第 3 轮）：a[i] 存在但不匹配我们的
          // 持续时间正则表达式。GNU timeout 通过 xstrtod()（libc strtod）
          // 解析并接受 `.5`、`+5`、`5e-1`、`inf`、`infinity`、十六进制浮点数 -
          // 都不匹配 `/^\d+(\.\d+)?[smhd]?$/`。经验证：
          // `timeout .5 echo ok` 有效。以前此分支 `break`（失败开放）所以
          // `timeout .5 eval "id"` 带有 `Bash(timeout:*)` 留下 name='timeout'
          // 且 eval 从未被检查。现在失败关闭 - 与上方的未知标志处理一致
          // （行 ~1895,1912）。
          return {
            ok: false,
            reason: `timeout 持续时间 '${a[i]}' 无法静态分析`,
          }
        } else {
          break // 没有更多参数 - 单独的 `timeout`，惰性
        }
      } else if (a[0] === 'nice') {
        // `nice cmd`、`nice -n N cmd`、`nice -N cmd`（旧版）。都以较低优先级运行 cmd。
        // argv[0] 检查必须看到包装的命令。
        if (a[1] === '-n' && a[2] && /^-?\d+$/.test(a[2])) {
          a = a.slice(3)
        } else if (a[1] && /^-\d+$/.test(a[1])) {
          a = a.slice(2) // `nice -10 cmd`
        } else if (a[1] && /[$(`]/.test(a[1])) {
          // 安全性：walkArgument 对 arithmetic_expansion 返回 node.text，
          // 所以 `nice $((0-5)) jq ...` 有 a[1]='$((0-5))'。Bash 将其展开为
          // '-5'（legacy nice 语法）并 exec jq；我们会在这里 slice(1) 并
          // 设置 name='$((0-5))'，这完全跳过了 jq system() 检查。
          // 失败关闭 —— 镜像上方的 timeout-duration 失败关闭。
          return {
            ok: false,
            reason: `nice 参数 '${a[1]}' 包含展开 —— 无法静态确定包装的命令`,
          }
        } else {
          a = a.slice(1) // bare `nice cmd`
        }
      } else if (a[0] === 'env') {
        // `env [VAR=val...] [-i] [-0] [-v] [-u NAME...] cmd args` 运行 cmd。
        // argv[0] 检查必须看到 cmd，而非 env。只跳过已知安全的形式。
        // 安全性：-S 将字符串分割为 argv（迷你 shell）—— 必须拒绝。
        // -C/-P 改变 cwd/PATH —— 包装的命令在其他地方运行，拒绝。
        // 任何其他标志 → 拒绝（失败关闭，而非失败开放到 name='env'）。
        let i = 1
        while (i < a.length) {
          const arg = a[i]!
          if (arg.includes('=') && !arg.startsWith('-')) {
            i++ // VAR=val assignment
          } else if (arg === '-i' || arg === '-0' || arg === '-v') {
            i++ // flags with no argument
          } else if (arg === '-u' && a[i + 1]) {
            i += 2 // -u NAME unsets; takes one arg
          } else if (arg.startsWith('-')) {
            // -S（argv 分割器）、-C（替代 cwd）、-P（替代 path）、--anything、
            // 或未知标志。无法建模 —— 拒绝整个命令。
            return {
              ok: false,
              reason: `env 带 ${arg} 标志无法静态分析`,
            }
          } else {
            break // the wrapped command
          }
        }
        if (i < a.length) {
          a = a.slice(i)
        } else {
          break // `env` alone (no wrapped cmd) — inert, name='env'
        }
      } else if (a[0] === 'stdbuf') {
        // `stdbuf -o0 cmd`（融合）、`stdbuf -o 0 cmd`（空格分隔）、
        // 多个标志（`stdbuf -o0 -eL cmd`）、长形式（`--output=0`）。
        // 安全性：之前的处理只剥离一个标志并对任何未识别的内容落到
        // slice(2)，所以 `stdbuf --output 0 eval` → ['0','eval',...] →
        // name='0' 隐藏了 eval。现在迭代所有已知标志形式并在任何未知标志上失败关闭。
        let i = 1
        while (i < a.length) {
          const arg = a[i]!
          if (STDBUF_SHORT_SEP_RE.test(arg) && a[i + 1]) {
            i += 2 // -o MODE (space-separated)
          } else if (STDBUF_SHORT_FUSED_RE.test(arg)) {
            i++ // -o0 (fused)
          } else if (STDBUF_LONG_RE.test(arg)) {
            i++ // --output=MODE (fused long)
          } else if (arg.startsWith('-')) {
            // --output MODE（空格分隔长选项）或未知标志。GNU stdbuf
            // 长选项使用 `=` 语法，但 getopt_long 也接受空格分隔 ——
            // 我们无法安全枚举，拒绝。
            return {
              ok: false,
              reason: `stdbuf 带 ${arg} 标志无法静态分析`,
            }
          } else {
            break // the wrapped command
          }
        }
        if (i > 1 && i < a.length) {
          a = a.slice(i)
        } else {
          break // `stdbuf` with no flags or no wrapped cmd — inert
        }
      } else {
        break
      }
    }
    const name = a[0]
    if (name === undefined) continue

    // 安全性：空命令名。引号空（`"" cmd`）是无害的 —— bash 尝试 exec ""
    // 并失败并显示"command not found"。但命令位置的未引用空展开
    // （`V="" && $V cmd`）是绕过：bash 丢弃空字段并运行 `cmd` 作为 argv[0]，
    // 而我们的 name="" 跳过下面的每个内建检查。resolveSimpleExpansion
    // 拒绝 $V 情况；这捕获任何其他到达空 argv[0] 的路径（空拼接、
    // walkString 空白怪癖、未来 bug）。
    if (name === '') {
      return {
        ok: false,
        reason: '空命令名 —— argv[0] 可能不反映 bash 运行的内容',
      }
    }

    // 纵深防御：var-tracking 修复后 argv[0] 不应该是占位符（静态变量
    // 返回真实值，未知变量拒绝）。但如果上游有 bug 漏过一个，在此捕获 ——
    // 占位符作为命令名意味着运行时确定的命令 → 不安全。
    if (name.includes(CMDSUB_PLACEHOLDER) || name.includes(VAR_PLACEHOLDER)) {
      return {
        ok: false,
        reason: '命令名是运行时确定的（占位符 argv[0]）',
      }
    }

    // argv[0] 以操作符/标志开头：这是一个片段，不是命令。
    // 可能是行续行泄漏或错误。
    if (name.startsWith('-') || name.startsWith('|') || name.startsWith('&')) {
      return {
        ok: false,
        reason: '命令似乎是一个不完整的片段',
      }
    }

    // 安全性：内部重新解析 NAME 操作数的内建命令。bash 算术计算
    // NAME 位置中的 `arr[EXPR]`，运行下标中的 $(cmd)，即使 argv 元素
    // 来自单引号 raw_string（对 tree-sitter 是不透明叶子）。两种形式：
    // 分离（`printf -v NAME`）和融合（`printf -vNAME`，getopt 风格）。
    // `printf '[%s]' x` 保持安全 —— `[` 在格式字符串中，不在 `-v` 之后。
    const dangerFlags = SUBSCRIPT_EVAL_FLAGS[name]
    if (dangerFlags !== undefined) {
      for (let i = 1; i < a.length; i++) {
        const arg = a[i]!
        // 分离形式：`-v` 然后 NAME 在下一个参数中。
        if (dangerFlags.has(arg) && a[i + 1]?.includes('[')) {
          return {
            ok: false,
            reason: `'${name} ${arg}' 操作数包含数组下标 —— bash 在下标中计算 $(cmd)`,
          }
        }
        // 组合短标志：`-ra` 是 `-r -a` 的 bash 简写。检查组合标志字符串中
        // 是否出现任何危险标志字符。危险标志的 NAME 操作数是下一个参数。
        if (
          arg.length > 2 &&
          arg[0] === '-' &&
          arg[1] !== '-' &&
          !arg.includes('[')
        ) {
          for (const flag of dangerFlags) {
            if (flag.length === 2 && arg.includes(flag[1]!)) {
              if (a[i + 1]?.includes('[')) {
                return {
                  ok: false,
                  reason: `'${name} ${flag}'（组合在 '${arg}' 中）操作数包含数组下标 —— bash 在下标中计算 $(cmd)`,
                }
              }
            }
          }
        }
        // 融合形式：`-vNAME` 在一个参数中。只有短选项标志融合（getopt），
        // 所以检查 -v/-a/-R。`[[` 只使用 test_operator 节点。
        for (const flag of dangerFlags) {
          if (
            flag.length === 2 &&
            arg.startsWith(flag) &&
            arg.length > 2 &&
            arg.includes('[')
          ) {
            return {
              ok: false,
              reason: `'${name} ${flag}'（融合）操作数包含数组下标 —— bash 在下标中计算 $(cmd)`,
            }
          }
        }
      }
    }

    // 安全性：`[[ ARG OP ARG ]]` 算术比较。bash 将两个操作数都作为
    // 算术表达式计算，递归展开 `arr[$(cmd)]` 下标，即使来自单引号
    // raw_string。检查每个算术比较操作符两侧相邻的操作数 ——
    // SUBSCRIPT_EVAL_FLAGS 的"标志然后下一个参数"模式无法表达
    // "二元操作符的任一侧"。字符串比较（==/!=/=~）不
    // 触发算术计算 —— `[[ 'a[x]' == y ]]` 是字面字符串比较。
    if (name === '[[') {
      // i 从 2 开始：a[0]='[['（包含 '['），a[1] 是第一个真实操作数。
      // 二元操作符不能出现在索引 2 之前。
      for (let i = 2; i < a.length; i++) {
        if (!TEST_ARITH_CMP_OPS.has(a[i]!)) continue
        if (a[i - 1]?.includes('[') || a[i + 1]?.includes('[')) {
          return {
            ok: false,
            reason: `'[[ ... ${a[i]} ... ]]' 操作数包含数组下标 —— bash 算术计算下标中的 $(cmd)`,
          }
        }
      }
    }

    // 安全性：`read`/`unset` 将每个裸位置参数视为 NAME —— 不需要标志。
    // `read 'a[$(id)]' <<< data` 执行 id，即使 argv[1] 来自单引号 raw_string
    // 且没有 -a 标志。与 SUBSCRIPT_EVAL_FLAGS 相同的原语，但触发器是位置
    // 参数，而非标志门控。跳过 read 的数据接受标志的操作数（-p PROMPT 等）
    // 以避免阻止 `read -p '[foo] ' var`。
    if (BARE_SUBSCRIPT_NAME_BUILTINS.has(name)) {
      let skipNext = false
      for (let i = 1; i < a.length; i++) {
        const arg = a[i]!
        if (skipNext) {
          skipNext = false
          continue
        }
        if (arg[0] === '-') {
          if (name === 'read') {
            if (READ_DATA_FLAGS.has(arg)) {
              skipNext = true
            } else if (arg.length > 2 && arg[1] !== '-') {
              // 组合短标志如 `-rp`。Getopt 风格：第一个数据标志字符
              // 消耗剩余参数作为操作数（`-p[foo]` → prompt=`[foo]`），
              // 或者如果是最后一个字符则消耗下一个参数
              // （`-rp '[foo]'` → prompt=`[foo]`）。因此仅当数据标志字符
              // 出现在末尾（在 `-r`/`-s` 等无参数标志之后）时 skipNext 为 true。
              for (let j = 1; j < arg.length; j++) {
                if (READ_DATA_FLAGS.has('-' + arg[j])) {
                  if (j === arg.length - 1) skipNext = true
                  break
                }
              }
            }
          }
          continue
        }
        if (arg.includes('[')) {
          return {
            ok: false,
            reason: `'${name}' 位置参数 NAME '${arg}' 包含数组下标 —— bash 在下标中计算 $(cmd)`,
          }
        }
      }
    }

    // 安全性：Shell 保留关键字作为 argv[0] 表示 tree-sitter 解析错误。
    // `! for i in a; do :; done` 被解析为 `command "for i in a"`
    // + `command "do :"` + `command "done"` —— tree-sitter 无法识别 `!` 后的
    // `for` 作为复合命令开头。拒绝：关键字永远不可能是合法的命令名，
    // 像 ['do','false'] 这样的 argv 是胡说八道。
    if (SHELL_KEYWORDS.has(name)) {
      return {
        ok: false,
        reason: `Shell 关键字 '${name}' 作为命令名 —— tree-sitter 解析错误`,
      }
    }

    // 检查 argv（而非 .text）以同时捕获单引号（`'\n#'`）和
    // 双引号（`"\n#"`）变体。环境变量和重定向也属于 .text 跨度，
    // 因此同样的下游 bug 适用。Heredoc 体被排除在 argv 之外，
    // 所以 markdown 的 `##` 标题不会触发此检查。
    // TODO: 一旦下游路径验证在 argv 上操作，移除此检查。
    for (const arg of cmd.argv) {
      if (arg.includes('\n') && NEWLINE_HASH_RE.test(arg)) {
        return {
          ok: false,
          reason:
            'Newline followed by # inside a quoted argument can hide arguments from path validation',
        }
      }
    }
    for (const ev of cmd.envVars) {
      if (ev.value.includes('\n') && NEWLINE_HASH_RE.test(ev.value)) {
        return {
          ok: false,
          reason:
            'Newline followed by # inside an env var value can hide arguments from path validation',
        }
      }
    }
    for (const r of cmd.redirects) {
      if (r.target.includes('\n') && NEWLINE_HASH_RE.test(r.target)) {
        return {
          ok: false,
          reason:
            'Newline followed by # inside a redirect target can hide arguments from path validation',
        }
      }
    }

    // jq 的 system() 内置函数可以执行任意 shell 命令，而像 --from-file
    // 这样的标志可以将任意文件读入 jq 变量。在旧路径上，这些由
    // bashSecurity.ts 中的 validateJqCommand 捕获，但该验证器位于
    // `astSubcommands === null` 门控之后，当 AST 解析成功时从不运行。
    // 在此镜像这些检查，使 AST 路径具有相同的防御。
    if (name === 'jq') {
      for (const arg of a) {
        if (/\bsystem\s*\(/.test(arg)) {
          return {
            ok: false,
            reason:
              'jq command contains system() function which executes arbitrary commands',
          }
        }
      }
      if (
        a.some(arg =>
          /^(?:-[fL](?:$|[^A-Za-z])|--(?:from-file|rawfile|slurpfile|library-path)(?:$|=))/.test(
            arg,
          ),
        )
      ) {
        return {
          ok: false,
          reason:
            'jq command contains dangerous flags that could execute code or read arbitrary files',
        }
      }
    }

    if (ZSH_DANGEROUS_BUILTINS.has(name)) {
      return {
        ok: false,
        reason: `Zsh 内建命令 '${name}' 可能绕过安全检查`,
      }
    }

    if (EVAL_LIKE_BUILTINS.has(name)) {
      // `command -v foo` / `command -V foo` 是 POSIX 存在性检查，
      // 只打印路径 —— 它们从不执行 argv[1]。裸的 `command foo`
      // 确实会绕过函数/别名查找（这是关注点），因此继续阻止它。
      if (name === 'command' && (a[1] === '-v' || a[1] === '-V')) {
        // 继续到剩余检查
      } else if (
        name === 'fc' &&
        !a.slice(1).some(arg => /^-[^-]*[es]/.test(arg))
      ) {
        // `fc -l`、`fc -ln` 列出历史 —— 安全。`fc -e ed` 调用编辑器
        // 然后执行。`fc -s [pat=rep]` 重新执行最后匹配的命令（可选地
        // 带替换）—— 和 eval 一样危险。阻止任何包含 `e` 或 `s` 的短选项。
        // 以避免为 `fc -l`（列出历史）引入误报。
      } else if (
        name === 'compgen' &&
        !a.slice(1).some(arg => /^-[^-]*[CFW]/.test(arg))
      ) {
        // `compgen -c/-f/-v` 只列出补全 —— 安全。`compgen -C cmd`
        // 立即执行 cmd；`-F func` 调用 shell 函数；`-W list`
        // 对其参数进行单词展开（包括来自单引号 raw_string 的 $(cmd)）。
        // 阻止任何包含 C/F/W 的短选项（区分大小写：-c/-f 是安全的）。
      } else {
        return {
          ok: false,
          reason: `'${name}' 将参数作为 shell 代码计算`,
        }
      }
    }

    // /proc/*/environ 暴露其他进程的环境变量（包括秘密）。
    // 检查 argv 和重定向目标 —— `cat /proc/self/environ` 和
    // `cat < /proc/self/environ` 都会读取它。
    for (const arg of cmd.argv) {
      if (arg.includes('/proc/') && PROC_ENVIRON_RE.test(arg)) {
        return {
          ok: false,
          reason: '访问 /proc/*/environ 可能暴露秘密',
        }
      }
    }
    for (const r of cmd.redirects) {
      if (r.target.includes('/proc/') && PROC_ENVIRON_RE.test(r.target)) {
        return {
          ok: false,
          reason: '访问 /proc/*/environ 可能暴露秘密',
        }
      }
    }
  }
  return { ok: true }
}
