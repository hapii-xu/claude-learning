import {
  hasMalformedTokens,
  hasShellQuoteSingleQuoteBug,
  type ParseEntry,
  quote,
  tryParseShellCommand,
} from './shellQuote.js'

/**
 * 重排带管道的命令，将标准输入重定向放置在第一个命令之后。
 * 这修复了一个问题：eval 将整个管道命令视为单个单元，
 * 导致标准输入重定向应用于 eval 本身而非第一个命令。
 */
export function rearrangePipeCommand(command: string): string {
  // 如果命令包含反引号则跳过 - shell-quote 无法正确处理它们
  if (command.includes('`')) {
    return quoteWithEvalStdinRedirect(command)
  }

  // 如果命令包含命令替换则跳过 - shell-quote 错误解析 $()，
  // 将 ( 和 ) 视为单独的操作符而非识别命令替换
  if (command.includes('$(')) {
    return quoteWithEvalStdinRedirect(command)
  }

  // 如果命令引用 shell 变量（$VAR, ${VAR}）则跳过。shell-quote 的 parse()
  // 在没有传递 env 时会将其展开为空字符串，静默丢弃引用。即使我们通过
  // env 函数保留了令牌，quote() 也会在重建时转义 $，阻止运行时展开。参见 #9732。
  if (/\$[A-Za-z_{]/.test(command)) {
    return quoteWithEvalStdinRedirect(command)
  }

  // 如果命令包含 bash 控制结构（for/while/until/if/case/select）则跳过
  // shell-quote 无法正确解析这些，会错误地在控制结构体中找到管道，
  // 在重排时破坏命令
  if (containsControlStructure(command)) {
    return quoteWithEvalStdinRedirect(command)
  }

  // 在解析前合并续行：shell-quote 无法处理 \<换行符>，
  // 并为每次出现生成空字符串令牌，导致重建命令中出现虚假的空参数
  const joined = joinContinuationLines(command)

  // shell-quote 将裸换行视为空白，而非命令分隔符。
  // 解析+重建 'cmd1 | head\ncmd2 | grep' 会得到 'cmd1 | head cmd2 | grep'，
  // 静默合并管道。行续行（\<换行符>）已在上方剥离；
  // 任何剩余的换行都是真正的分隔符。回退到 eval 后备方案，
  // 它在单引号参数内保留换行。参见 #32515。
  if (joined.includes('\n')) {
    return quoteWithEvalStdinRedirect(command)
  }

  // 安全性：shell-quote 将单引号内的 \' 视为转义，但
  // bash 将其视为字面量 \ 后跟闭合引号。模式
  // '\'' <载荷> '\'' 使 shell-quote 将 <载荷> 合并到引号
  // 字符串中，隐藏 ; 等操作符。从该合并令牌重建
  // 可能在 bash 重新解析时暴露操作符。
  if (hasShellQuoteSingleQuoteBug(joined)) {
    return quoteWithEvalStdinRedirect(command)
  }

  const parseResult = tryParseShellCommand(joined)

  // 如果解析失败（语法错误），回退到引用整个命令
  if (!parseResult.success) {
    return quoteWithEvalStdinRedirect(command)
  }

  const parsed = parseResult.tokens

  // 安全性：shell-quote 的分词方式与 bash 不同。输入如
  // `echo {"hi":\"hi;calc.exe"}` 是 bash 语法错误（引号不平衡），
  // 但 shell-quote 将其解析为以 `;` 为操作符和
  // `calc.exe` 为单独单词的令牌。从这些令牌重建会产生
  // 执行 `calc.exe` 的有效 bash - 将语法错误变成注入。
  // 字符串令牌中不平衡的分隔符表示这种错误解析；
  // 回退到整个命令引用，它保留原始内容
  // （然后 bash 会抛出与没有我们时相同的语法错误）。
  if (hasMalformedTokens(joined, parsed)) {
    return quoteWithEvalStdinRedirect(command)
  }

  const firstPipeIndex = findFirstPipeOperator(parsed)

  if (firstPipeIndex <= 0) {
    return quoteWithEvalStdinRedirect(command)
  }

  // 重建：first_command < /dev/null | rest_of_pipeline
  const parts = [
    ...buildCommandParts(parsed, 0, firstPipeIndex),
    '< /dev/null',
    ...buildCommandParts(parsed, firstPipeIndex, parsed.length),
  ]

  return singleQuoteForEval(parts.join(' '))
}

/**
 * 查找解析后 shell 命令中的第一个管道操作符索引
 */
function findFirstPipeOperator(parsed: ParseEntry[]): number {
  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i]
    if (isOperator(entry, '|')) {
      return i
    }
  }
  return -1
}

/**
 * 从重词条目构建命令部分，处理字符串和操作符。
 * 特殊处理文件描述符重定向以将它们作为单个单元保留。
 */
function buildCommandParts(
  parsed: ParseEntry[],
  start: number,
  end: number,
): string[] {
  const parts: string[] = []
  // 跟踪是否已看到非环境变量的字符串令牌
  // 环境变量仅在命令开头有效
  let seenNonEnvVar = false

  for (let i = start; i < end; i++) {
    const entry = parsed[i]

    // 检查文件描述符重定向（例如 2>&1, 2>/dev/null）
    if (
      typeof entry === 'string' &&
      /^[012]$/.test(entry) &&
      i + 2 < end &&
      isOperator(parsed[i + 1])
    ) {
      const op = parsed[i + 1] as { op: string }
      const target = parsed[i + 2]

      // 处理 2>&1 风格的重定向
      if (
        op.op === '>&' &&
        typeof target === 'string' &&
        /^[012]$/.test(target)
      ) {
        parts.push(`${entry}>&${target}`)
        i += 2
        continue
      }

      // 处理 2>/dev/null 风格的重定向
      if (op.op === '>' && target === '/dev/null') {
        parts.push(`${entry}>/dev/null`)
        i += 2
        continue
      }

      // 处理 2> &1 风格（> 和 &1 之间有空格）
      if (
        op.op === '>' &&
        typeof target === 'string' &&
        target.startsWith('&')
      ) {
        const fd = target.slice(1)
        if (/^[012]$/.test(fd)) {
          parts.push(`${entry}>&${fd}`)
          i += 2
          continue
        }
      }
    }

    // 处理常规条目
    if (typeof entry === 'string') {
      // 环境变量赋值仅在命令开头有效，
      // 在任何非环境变量令牌（实际命令及其参数）之前
      const isEnvVar = !seenNonEnvVar && isEnvironmentVariableAssignment(entry)

      if (isEnvVar) {
        // 对于环境变量赋值，我们需要保留 = 但根据需要引号引用值
        // 拆分为名称和值部分
        const eqIndex = entry.indexOf('=')
        const name = entry.slice(0, eqIndex)
        const value = entry.slice(eqIndex + 1)

        // 引号引用值部分以处理空格和特殊字符
        const quotedValue = quote([value])
        parts.push(`${name}=${quotedValue}`)
      } else {
        // 一旦看到非环境变量字符串，后续所有字符串都是参数
        seenNonEnvVar = true
        parts.push(quote([entry]))
      }
    } else if (isOperator(entry)) {
      // 特殊处理 glob 操作符
      if (entry.op === 'glob' && 'pattern' in entry) {
        // 不要引号引用 glob 模式 - 它们需要保持原样以供 shell 展开
        parts.push(entry.pattern as string)
      } else {
        parts.push(entry.op)
        // 在命令分隔符后重置 - 下一个命令可以有自己的环境变量
        if (isCommandSeparator(entry.op)) {
          seenNonEnvVar = false
        }
      }
    }
  }

  return parts
}

/**
 * 检查字符串是否为环境变量赋值（VAR=value）
 * 环境变量名必须以字母或下划线开头，
 * 后跟字母、数字或下划线
 */
function isEnvironmentVariableAssignment(str: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(str)
}

/**
 * 检查操作符是否为启动新命令上下文的命令分隔符。
 * 在这些操作符之后，环境变量赋值再次有效。
 */
function isCommandSeparator(op: string): boolean {
  return op === '&&' || op === '||' || op === ';'
}

/**
 * 类型守卫，检查解析的条目是否为操作符
 */
function isOperator(entry: unknown, op?: string): entry is { op: string } {
  if (!entry || typeof entry !== 'object' || !('op' in entry)) {
    return false
  }
  return op ? entry.op === op : true
}

/**
 * 检查命令是否包含 shell-quote 无法解析的 bash 控制结构。
 * 包括 for/while/until/if/case/select 循环和条件语句。
 * 我们匹配关键字后跟空白以避免与恰好包含这些单词的
 * 命令或参数产生误报。
 */
function containsControlStructure(command: string): boolean {
  return /\b(for|while|until|if|case|select)\s/.test(command)
}

/**
 * 引号引用命令并在 eval 时添加 `< /dev/null` 作为 shell 重定向，而非
 * 作为 eval 参数。这对于无法解析管道边界的管道命令至关重要
 * （例如，包含 $()、反引号或控制结构的命令）。
 *
 * 使用 `singleQuoteForEval(cmd) + ' < /dev/null'` 产生：eval 'cmd' < /dev/null
 *   → eval 的标准输入是 /dev/null，eval 计算 'cmd'，管道内部正常工作
 *
 * 之前的方法 `quote([cmd, '<', '/dev/null'])` 产生：eval 'cmd' \< /dev/null
 *   → eval 将参数拼接为 'cmd < /dev/null'，重定向应用于最后一个管道命令
 */
function quoteWithEvalStdinRedirect(command: string): string {
  return singleQuoteForEval(command) + ' < /dev/null'
}

/**
 * 将字符串用单引号引起来以用作 eval 参数。通过 '"'"' 转义嵌入的
 * 单引号（关闭单引号、双引号内的字面单引号、重新打开单引号）。
 * 使用此函数而非 shell-quote 的 quote()，后者在输入包含单引号时
 * 切换到双引号模式，然后转义 ! -> \!，破坏 jq/awk 过滤器
 * 如 `select(.x != .y)` 变成 `select(.x \!= .y)`。
 */
function singleQuoteForEval(s: string): string {
  return "'" + s.replace(/'/g, `'"'"'`) + "'"
}

/**
 * 合并 shell 续行（反斜杠换行）为单行。
 * 仅在反斜杠后换行前有奇数个反斜杠时合并
 * （最后一个反斜杠转义换行）。偶数个反斜杠配对为转义
 * 序列，换行保持为分隔符。
 */
function joinContinuationLines(command: string): string {
  return command.replace(/\\+\n/g, match => {
    const backslashCount = match.length - 1 // -1 是换行符
    if (backslashCount % 2 === 1) {
      // 奇数个：最后一个反斜杠转义换行（行续行）
      return '\\'.repeat(backslashCount - 1)
    } else {
      // 偶数个：全部配对，换行是真正的分隔符
      return match
    }
  })
}
