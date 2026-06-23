import type { ToolPermissionContext } from 'src/Tool.js'
import { splitCommand_DEPRECATED } from 'src/utils/bash/commands.js'
import { tryParseShellCommand } from 'src/utils/bash/shellQuote.js'
import type { PermissionResult } from 'src/utils/permissions/PermissionResult.js'

/**
 * 辅助函数：根据白名单校验标志
 * 同时处理单个标志和组合标志（例如 -nE）
 * @param flags 待校验的标志数组
 * @param allowedFlags 允许的单字符标志和长标志数组
 * @returns 所有标志都合法返回 true，否则返回 false
 */
function validateFlagsAgainstAllowlist(
  flags: string[],
  allowedFlags: string[],
): boolean {
  for (const flag of flags) {
    // 处理像 -nE 或 -Er 这样的组合标志
    if (flag.startsWith('-') && !flag.startsWith('--') && flag.length > 2) {
      // 检查组合标志中的每个字符
      for (let i = 1; i < flag.length; i++) {
        const singleFlag = '-' + flag[i]
        if (!allowedFlags.includes(singleFlag)) {
          return false
        }
      }
    } else {
      // 单个标志或长标志
      if (!allowedFlags.includes(flag)) {
        return false
      }
    }
  }
  return true
}

/**
 * 模式 1：检查这是否是一个带 -n 标志的行打印命令
 * 允许：sed -n 'N' | sed -n 'N,M'，可选 -E、-r、-z 标志
 * 允许以分号分隔的打印命令，如：sed -n '1p;2p;3p'
 * 此模式允许使用文件参数
 * @internal 导出用于测试
 */
export function isLinePrintingCommand(
  command: string,
  expressions: string[],
): boolean {
  const sedMatch = command.match(/^\s*sed\s+/)
  if (!sedMatch) return false

  const withoutSed = command.slice(sedMatch[0].length)
  const parseResult = tryParseShellCommand(withoutSed)
  if (!parseResult.success) return false
  const parsed = parseResult.tokens

  // 提取所有标志
  const flags: string[] = []
  for (const arg of parsed) {
    if (typeof arg === 'string' && arg.startsWith('-') && arg !== '--') {
      flags.push(arg)
    }
  }

  // 校验标志 - 只允许 -n、-E、-r、-z 及其长格式
  const allowedFlags = [
    '-n',
    '--quiet',
    '--silent',
    '-E',
    '--regexp-extended',
    '-r',
    '-z',
    '--zero-terminated',
    '--posix',
  ]

  if (!validateFlagsAgainstAllowlist(flags, allowedFlags)) {
    return false
  }

  // 检查是否存在 -n 标志（模式 1 所需）
  let hasNFlag = false
  for (const flag of flags) {
    if (flag === '-n' || flag === '--quiet' || flag === '--silent') {
      hasNFlag = true
      break
    }
    // 在组合标志中检查
    if (flag.startsWith('-') && !flag.startsWith('--') && flag.includes('n')) {
      hasNFlag = true
      break
    }
  }

  // 模式 1 必须有 -n 标志
  if (!hasNFlag) {
    return false
  }

  // 必须至少有一个表达式
  if (expressions.length === 0) {
    return false
  }

  // 所有表达式都必须是打印命令（严格白名单）
  // 允许以分号分隔的命令
  for (const expr of expressions) {
    const commands = expr.split(';')
    for (const cmd of commands) {
      if (!isPrintCommand(cmd.trim())) {
        return false
      }
    }
  }

  return true
}

/**
 * 辅助函数：检查单个命令是否是有效的打印命令
 * 严格白名单 - 只允许以下确切形式：
 * - p（打印全部）
 * - Np（打印第 N 行，其中 N 为数字）
 * - N,Mp（打印第 N 到 M 行）
 * 其他任何形式（包括 w、W、e、E 命令）都会被拒绝。
 * @internal 导出用于测试
 */
export function isPrintCommand(cmd: string): boolean {
  if (!cmd) return false
  // 单个严格 regex，只匹配允许的打印命令
  // ^(?:\d+|\d+,\d+)?p$ 匹配：p, 1p, 123p, 1,5p, 10,200p
  return /^(?:\d+|\d+,\d+)?p$/.test(cmd)
}

/**
 * 模式 2：检查这是否是一个替换命令
 * 允许：sed 's/pattern/replacement/flags'，其中 flags 只能是：g, p, i, I, m, M, 1-9
 * 当 allowFileWrites 为 true 时，允许使用 -i 标志和文件参数进行就地编辑
 * 当 allowFileWrites 为 false（默认）时，要求仅输出到 stdout（不允许文件参数和 -i 标志）
 * @internal 导出用于测试
 */
function isSubstitutionCommand(
  command: string,
  expressions: string[],
  hasFileArguments: boolean,
  options?: { allowFileWrites?: boolean },
): boolean {
  const allowFileWrites = options?.allowFileWrites ?? false

  // 不允许文件写入时，不能有文件参数
  if (!allowFileWrites && hasFileArguments) {
    return false
  }

  const sedMatch = command.match(/^\s*sed\s+/)
  if (!sedMatch) return false

  const withoutSed = command.slice(sedMatch[0].length)
  const parseResult = tryParseShellCommand(withoutSed)
  if (!parseResult.success) return false
  const parsed = parseResult.tokens

  // 提取所有 flag
  const flags: string[] = []
  for (const arg of parsed) {
    if (typeof arg === 'string' && arg.startsWith('-') && arg !== '--') {
      flags.push(arg)
    }
  }

  // 根据模式校验 flag
  // 两种模式共有的基础允许 flag
  const allowedFlags = ['-E', '--regexp-extended', '-r', '--posix']

  // 允许文件写入时，还允许 -i 与 --in-place
  if (allowFileWrites) {
    allowedFlags.push('-i', '--in-place')
  }

  if (!validateFlagsAgainstAllowlist(flags, allowedFlags)) {
    return false
  }

  // 必须恰好有一个表达式
  if (expressions.length !== 1) {
    return false
  }

  const expr = expressions[0]!.trim()

  // 严格白名单：必须恰好是以 's' 开头的替换命令
  // 这会拒绝诸如 'e'、'w file' 之类的独立命令
  if (!expr.startsWith('s')) {
    return false
  }

  // 解析替换：s/pattern/replacement/flags
  // 仅允许以 / 作为分隔符（严格要求）
  const substitutionMatch = expr.match(/^s\/(.*?)$/)
  if (!substitutionMatch) {
    return false
  }

  const rest = substitutionMatch[1]!

  // 查找 / 分隔符的位置
  let delimiterCount = 0
  let lastDelimiterPos = -1
  let i = 0
  while (i < rest.length) {
    if (rest[i] === '\\') {
      // 跳过转义字符
      i += 2
      continue
    }
    if (rest[i] === '/') {
      delimiterCount++
      lastDelimiterPos = i
    }
    i++
  }

  // 必须恰好找到 2 个分隔符（pattern 和 replacement）
  if (delimiterCount !== 2) {
    return false
  }

  // 提取 flag（最后一个分隔符之后的全部内容）
  const exprFlags = rest.slice(lastDelimiterPos + 1)

  // 校验 flag：仅允许 g、p、i、I、m、M，以及可选地一个 1-9 的数字
  const allowedFlagChars = /^[gpimIM]*[1-9]?[gpimIM]*$/
  if (!allowedFlagChars.test(exprFlags)) {
    return false
  }

  return true
}

/**
 * 检查 sed 命令是否被白名单允许。
 * 白名单 pattern 本身已经足够严格，可以拒绝危险操作。
 * @param command 待检查的 sed 命令
 * @param options.allowFileWrites 为 true 时，允许替换命令使用 -i 标志和文件参数
 * @returns 若命令被允许（匹配白名单并通过黑名单检查）返回 true，否则返回 false
 */
export function sedCommandIsAllowedByAllowlist(
  command: string,
  options?: { allowFileWrites?: boolean },
): boolean {
  const allowFileWrites = options?.allowFileWrites ?? false

  // 提取 sed 表达式（实际 sed 命令所在的引号内容）
  let expressions: string[]
  try {
    expressions = extractSedExpressions(command)
  } catch (_error) {
    // 解析失败则视为不允许
    return false
  }

  // 检查 sed 命令是否带文件参数
  const hasFileArguments = hasFileArgs(command)

  // 检查命令是否匹配白名单 pattern
  let isPattern1 = false
  let isPattern2 = false

  if (allowFileWrites) {
    // 允许文件写入时，仅检查替换命令（模式 2 变体）
    // 模式 1（行打印）不需要文件写入
    isPattern2 = isSubstitutionCommand(command, expressions, hasFileArguments, {
      allowFileWrites: true,
    })
  } else {
    // 标准只读模式：两种 pattern 都检查
    isPattern1 = isLinePrintingCommand(command, expressions)
    isPattern2 = isSubstitutionCommand(command, expressions, hasFileArguments)
  }

  if (!isPattern1 && !isPattern2) {
    return false
  }

  // 模式 2 不允许分号（命令分隔符）
  // 模式 1 允许使用分号分隔多个打印命令
  for (const expr of expressions) {
    if (isPattern2 && expr.includes(';')) {
      return false
    }
  }

  // 纵深防御：即使匹配了白名单，也要再检查黑名单
  for (const expr of expressions) {
    if (containsDangerousOperations(expr)) {
      return false
    }
  }

  return true
}

/**
 * 检查 sed 命令是否带文件参数（而不仅仅是 stdin）
 * @internal 导出用于测试
 */
export function hasFileArgs(command: string): boolean {
  const sedMatch = command.match(/^\s*sed\s+/)
  if (!sedMatch) return false

  const withoutSed = command.slice(sedMatch[0].length)
  const parseResult = tryParseShellCommand(withoutSed)
  if (!parseResult.success) return true
  const parsed = parseResult.tokens

  try {
    let argCount = 0
    let hasEFlag = false

    for (let i = 0; i < parsed.length; i++) {
      const arg = parsed[i]

      // 同时处理字符串参数和 glob 模式（如 *.log）
      if (typeof arg !== 'string' && typeof arg !== 'object') continue

      // 若是 glob 模式，则视为文件参数
      if (
        typeof arg === 'object' &&
        arg !== null &&
        'op' in arg &&
        arg.op === 'glob'
      ) {
        return true
      }

      // 跳过非字符串且不是 glob 模式的参数
      if (typeof arg !== 'string') continue

      // 处理 -e flag 后跟随表达式的情况
      if ((arg === '-e' || arg === '--expression') && i + 1 < parsed.length) {
        hasEFlag = true
        i++ // 跳过下一个参数，因为它是表达式
        continue
      }

      // 处理 --expression=value 格式
      if (arg.startsWith('--expression=')) {
        hasEFlag = true
        continue
      }

      // 处理 -e=value 格式（非标准，但出于纵深防御考虑）
      if (arg.startsWith('-e=')) {
        hasEFlag = true
        continue
      }

      // 跳过其他 flag
      if (arg.startsWith('-')) continue

      argCount++

      // 若使用了 -e flag，则所有非 flag 参数都是文件参数
      if (hasEFlag) {
        return true
      }

      // 若未使用 -e flag，则第一个非 flag 参数是 sed 表达式，
      // 因此需要多于 1 个非 flag 参数才算有文件参数
      if (argCount > 1) {
        return true
      }
    }

    return false
  } catch (_error) {
    return true // 解析失败时视为危险
  }
}

/**
 * 从命令中提取 sed 表达式，忽略 flag 和文件名
 * @param command 完整的 sed 命令
 * @returns 用于危险操作检查的 sed 表达式数组
 * @throws 若解析失败则抛出错误
 * @internal 导出用于测试
 */
export function extractSedExpressions(command: string): string[] {
  const expressions: string[] = []

  // 通过截掉前 N 个字符（去掉 'sed '）来计算 withoutSed
  const sedMatch = command.match(/^\s*sed\s+/)
  if (!sedMatch) return expressions

  const withoutSed = command.slice(sedMatch[0].length)

  // 拒绝危险的 flag 组合，如 -ew、-eW、-ee、-we（-e/-w 与危险命令的组合）
  if (/-e[wWe]/.test(withoutSed) || /-w[eE]/.test(withoutSed)) {
    throw new Error('Dangerous flag combination detected')
  }

  // 使用 shell-quote 正确解析参数
  const parseResult = tryParseShellCommand(withoutSed)
  if (!parseResult.success) {
    // 格式错误的 shell 语法——抛错由调用方捕获
    throw new Error(
      `Malformed shell syntax: ${(parseResult as { success: false; error: string }).error}`,
    )
  }
  const parsed = parseResult.tokens
  try {
    let foundEFlag = false
    let foundExpression = false

    for (let i = 0; i < parsed.length; i++) {
      const arg = parsed[i]

      // 跳过非字符串参数（例如控制操作符）
      if (typeof arg !== 'string') continue

      // 处理 -e flag 后跟随表达式的情况
      if ((arg === '-e' || arg === '--expression') && i + 1 < parsed.length) {
        foundEFlag = true
        const nextArg = parsed[i + 1]
        if (typeof nextArg === 'string') {
          expressions.push(nextArg)
          i++ // 跳过下一个参数，因为我们已消费它
        }
        continue
      }

      // 处理 --expression=value 格式
      if (arg.startsWith('--expression=')) {
        foundEFlag = true
        expressions.push(arg.slice('--expression='.length))
        continue
      }

      // 处理 -e=value 格式（非标准，但出于纵深防御考虑）
      if (arg.startsWith('-e=')) {
        foundEFlag = true
        expressions.push(arg.slice('-e='.length))
        continue
      }

      // 跳过其他 flag
      if (arg.startsWith('-')) continue

      // 若此前未发现任何 -e flag，则第一个非 flag 参数即 sed 表达式
      if (!foundEFlag && !foundExpression) {
        expressions.push(arg)
        foundExpression = true
        continue
      }

      // 若此前已发现 -e flag 或独立表达式，
      // 则剩余非 flag 参数均为文件名
      break
    }
  } catch (error) {
    // 若 shell-quote 解析失败，则将该 sed 命令视为不安全
    throw new Error(
      `Failed to parse sed command: ${error instanceof Error ? error.message : 'Unknown error'}`,
    )
  }

  return expressions
}

/**
 * 检查 sed 表达式是否包含危险操作（黑名单）
 * @param expression 单条 sed 表达式（不含引号）
 * @returns 危险返回 true，安全返回 false
 */
function containsDangerousOperations(expression: string): boolean {
  const cmd = expression.trim()
  if (!cmd) return false

  // 保守拒绝：广泛地拒绝可能具有危险性的 pattern
  // 存疑时一律视为不安全

  // 拒绝非 ASCII 字符（Unicode 同形字、组合字符等）
  // 示例：ｗ（全角）、ᴡ（小型大写字母）、w̃（加波浪号组合字符）
  // 检查是否含有 ASCII 范围（0x01-0x7F，排除空字节）之外的字符
  // eslint-disable-next-line no-control-regex
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 出于安全校验需要，有意匹配控制字符
  if (/[^\x01-\x7F]/.test(cmd)) {
    return true
  }

  // 拒绝花括号（块）——解析过于复杂
  if (cmd.includes('{') || cmd.includes('}')) {
    return true
  }

  // 拒绝换行符——多行命令过于复杂
  if (cmd.includes('\n')) {
    return true
  }

  // 拒绝注释（紧随 s 命令之后的 # 不算）
  // 注释形如：#comment 或以 # 开头
  // 分隔符形如：s#pattern#replacement#
  const hashIndex = cmd.indexOf('#')
  if (hashIndex !== -1 && !(hashIndex > 0 && cmd[hashIndex - 1] === 's')) {
    return true
  }

  // 拒绝取反操作符
  // 取反可能出现在：开头（!/pattern/）、地址之后（/pattern/!、1,10!、$!）
  // 分隔符形如：s!pattern!replacement!（其前有 's'）
  if (/^!/.test(cmd) || /[/\d$]!/.test(cmd)) {
    return true
  }

  // 拒绝 GNU step 地址格式中的波浪号（digit~digit、,~digit、或 $~digit）
  // 允许波浪号周围有空白
  if (/\d\s*~\s*\d|,\s*~\s*\d|\$\s*~\s*\d/.test(cmd)) {
    return true
  }

  // 拒绝以逗号开头（裸逗号是 1,$ 地址范围的简写）
  if (/^,/.test(cmd)) {
    return true
  }

  // 拒绝逗号后跟 +/-（GNU 偏移地址）
  if (/,\s*[+-]/.test(cmd)) {
    return true
  }

  // 拒绝反斜杠把戏：
  // 1. s\（以反斜杠作为分隔符的替换命令）
  // 2. \X，其中 X 可能是其他分隔符（|、#、% 等）——不是 regex 转义
  if (/s\\/.test(cmd) || /\\[|#%@]/.test(cmd)) {
    return true
  }

  // 拒绝转义斜杠后紧跟 w/W（形如 /\/path\/to\/file/w）
  if (/\\\/.*[wW]/.test(cmd)) {
    return true
  }

  // 拒绝我们不理解、格式错误或可疑的 pattern
  // 若出现斜杠后跟非斜杠字符，再跟空白，最后跟危险命令
  // 示例：/pattern w file、/pattern e cmd、/foo X;w file
  if (/\/[^/]*\s+[wWeE]/.test(cmd)) {
    return true
  }

  // 拒绝不符合常规格式的畸形替换命令
  // 示例：s/foobareoutput.txt（缺少分隔符）、s/foo/bar//w（多余分隔符）
  if (/^s\//.test(cmd) && !/^s\/[^/]*\/[^/]*\/[^/]*$/.test(cmd)) {
    return true
  }

  // 偏执检查：拒绝任何以 's' 开头、并以危险字符（w、W、e、E）结尾、
  // 且不匹配我们已知安全替换 pattern 的命令。这可以捕获那些使用非斜杠分隔符、
  // 可能试图使用危险 flag 的畸形 s 命令。
  if (/^s./.test(cmd) && /[wWeE]$/.test(cmd)) {
    // 检查它是否是格式正确的替换（任意分隔符，不仅仅是 /）
    const properSubst = /^s([^\\\n]).*?\1.*?\1[^wWeE]*$/.test(cmd)
    if (!properSubst) {
      return true
    }
  }

  // 检查危险的写入命令
  // pattern：[address]w filename、[address]W filename、/pattern/w filename、/pattern/W filename
  // 已简化以避免指数级回溯（CodeQL 问题）
  // 在可能是命令的位置（允许前后空白）检查 w/W
  if (
    /^[wW]\s*\S+/.test(cmd) || // 在开头：w file
    /^\d+\s*[wW]\s*\S+/.test(cmd) || // 行号之后：1w file 或 1 w file
    /^\$\s*[wW]\s*\S+/.test(cmd) || // $ 之后：$w file 或 $ w file
    /^\/[^/]*\/[IMim]*\s*[wW]\s*\S+/.test(cmd) || // pattern 之后：/pattern/w file
    /^\d+,\d+\s*[wW]\s*\S+/.test(cmd) || // 范围之后：1,10w file
    /^\d+,\$\s*[wW]\s*\S+/.test(cmd) || // 范围之后：1,$w file
    /^\/[^/]*\/[IMim]*,\/[^/]*\/[IMim]*\s*[wW]\s*\S+/.test(cmd) // pattern 范围之后：/s/,/e/w file
  ) {
    return true
  }

  // 检查危险的执行命令
  // pattern：[address]e [command]、/pattern/e [command]、或以 e 开头的命令
  // 已简化以避免指数级回溯（CodeQL 问题）
  // 在可能是命令的位置（允许前后空白）检查 e
  if (
    /^e/.test(cmd) || // 在开头：e cmd
    /^\d+\s*e/.test(cmd) || // 行号之后：1e 或 1 e
    /^\$\s*e/.test(cmd) || // $ 之后：$e 或 $ e
    /^\/[^/]*\/[IMim]*\s*e/.test(cmd) || // pattern 之后：/pattern/e
    /^\d+,\d+\s*e/.test(cmd) || // 范围之后：1,10e
    /^\d+,\$\s*e/.test(cmd) || // 范围之后：1,$e
    /^\/[^/]*\/[IMim]*,\/[^/]*\/[IMim]*\s*e/.test(cmd) // pattern 范围之后：/s/,/e/e
  ) {
    return true
  }

  // 检查带危险 flag 的替换命令
  // pattern：s<delim>pattern<delim>replacement<delim>flags，其中 flags 含有 w 或 e
  // 按 POSIX 规定，sed 允许除反斜杠和换行符外的任意字符作为分隔符
  const substitutionMatch = cmd.match(/s([^\\\n]).*?\1.*?\1(.*?)$/)
  if (substitutionMatch) {
    const flags = substitutionMatch[2] || ''

    // 检查写入 flag：s/old/new/w filename 或 s/old/new/gw filename
    if (flags.includes('w') || flags.includes('W')) {
      return true
    }

    // 检查执行 flag：s/old/new/e 或 s/old/new/ge
    if (flags.includes('e') || flags.includes('E')) {
      return true
    }
  }

  // 检查 y（转换）命令后跟随的危险操作
  // pattern：y<delim>source<delim>dest<delim> 后跟任意内容
  // y 命令使用与 s 命令相同的分隔符语法
  // 偏执检查：拒绝任何在分隔符之后出现 w/W/e/E 的 y 命令
  const yCommandMatch = cmd.match(/y([^\\\n])/)
  if (yCommandMatch) {
    // 若看到 y 命令，则检查整条命令中是否含有 w、W、e、E
    // 此判断偏执但安全——y 命令很少见，且 y 之后出现 w/e 可疑
    if (/[wWeE]/.test(cmd)) {
      return true
    }
  }

  return false
}

/**
 * 针对 sed 命令的横切校验步骤。
 *
 * 这是一个约束检查，无论何种模式都会阻止危险的 sed 操作。
 * 对非 sed 命令或安全的 sed 命令返回 'passthrough'，
 * 对危险的 sed 操作（w/W/e/E 命令）返回 'ask'。
 *
 * @param input - 包含命令字符串的对象
 * @param toolPermissionContext - 包含模式与权限的上下文
 * @returns
 * - 若任一 sed 命令含危险操作，返回 'ask'
 * - 若没有 sed 命令或全部安全，返回 'passthrough'
 */
export function checkSedConstraints(
  input: { command: string },
  toolPermissionContext: ToolPermissionContext,
): PermissionResult {
  const commands = splitCommand_DEPRECATED(input.command)

  for (const cmd of commands) {
    // 跳过非 sed 命令
    const trimmed = cmd.trim()
    const baseCmd = trimmed.split(/\s+/)[0]
    if (baseCmd !== 'sed') {
      continue
    }

    // 在 acceptEdits 模式下，允许文件写入（-i flag），但仍阻止危险操作
    const allowFileWrites = toolPermissionContext.mode === 'acceptEdits'

    const isAllowed = sedCommandIsAllowedByAllowlist(trimmed, {
      allowFileWrites,
    })

    if (!isAllowed) {
      return {
        behavior: 'ask',
        message:
          'sed command requires approval (contains potentially dangerous operations)',
        decisionReason: {
          type: 'other',
          reason:
            'sed command contains operations that require explicit approval (e.g., write commands, execute commands)',
        },
      }
    }
  }

  // 未发现危险的 sed 命令（或根本没有 sed 命令）
  return {
    behavior: 'passthrough',
    message: 'No dangerous sed operations detected',
  }
}
