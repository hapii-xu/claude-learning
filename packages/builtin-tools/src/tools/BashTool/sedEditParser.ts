/**
 * sed 编辑命令（-i 标志替换）解析器
 * 提取文件路径和替换模式，从而支持以类文件编辑的方式渲染
 */

import { randomBytes } from 'crypto'
import { tryParseShellCommand } from 'src/utils/bash/shellQuote.js'

// BRE→ERE 转换占位符（空字节哨兵，永远不会出现在用户输入中）
const BACKSLASH_PLACEHOLDER = '\x00BACKSLASH\x00'
const PLUS_PLACEHOLDER = '\x00PLUS\x00'
const QUESTION_PLACEHOLDER = '\x00QUESTION\x00'
const PIPE_PLACEHOLDER = '\x00PIPE\x00'
const LPAREN_PLACEHOLDER = '\x00LPAREN\x00'
const RPAREN_PLACEHOLDER = '\x00RPAREN\x00'
const BACKSLASH_PLACEHOLDER_RE = new RegExp(BACKSLASH_PLACEHOLDER, 'g')
const PLUS_PLACEHOLDER_RE = new RegExp(PLUS_PLACEHOLDER, 'g')
const QUESTION_PLACEHOLDER_RE = new RegExp(QUESTION_PLACEHOLDER, 'g')
const PIPE_PLACEHOLDER_RE = new RegExp(PIPE_PLACEHOLDER, 'g')
const LPAREN_PLACEHOLDER_RE = new RegExp(LPAREN_PLACEHOLDER, 'g')
const RPAREN_PLACEHOLDER_RE = new RegExp(RPAREN_PLACEHOLDER, 'g')

export type SedEditInfo = {
  /** 正在被编辑的文件路径 */
  filePath: string
  /** 搜索模式（正则） */
  pattern: string
  /** 替换字符串 */
  replacement: string
  /** 替换标志（g、i 等） */
  flags: string
  /** 是否使用扩展正则（-E 或 -r 标志） */
  extendedRegex: boolean
}

/**
 * 检查某条命令是否为 sed 就地编辑命令
 * 仅对简单的 sed -i 's/pattern/replacement/flags' file 命令返回 true
 */
export function isSedInPlaceEdit(command: string): boolean {
  const info = parseSedEditCommand(command)
  return info !== null
}

/**
 * 解析 sed 编辑命令并提取编辑信息
 * 若该命令不是有效的 sed 就地编辑，则返回 null
 */
export function parseSedEditCommand(command: string): SedEditInfo | null {
  const trimmed = command.trim()

  // 必须以 sed 开头
  const sedMatch = trimmed.match(/^\s*sed\s+/)
  if (!sedMatch) return null

  const withoutSed = trimmed.slice(sedMatch[0].length)
  const parseResult = tryParseShellCommand(withoutSed)
  if (!parseResult.success) return null
  const tokens = parseResult.tokens

  // 仅提取字符串类型的 token
  const args: string[] = []
  for (const token of tokens) {
    if (typeof token === 'string') {
      args.push(token)
    } else if (
      typeof token === 'object' &&
      token !== null &&
      'op' in token &&
      token.op === 'glob'
    ) {
      // glob 模式对于这个简单解析器而言过于复杂
      return null
    }
  }

  // 解析标志与参数
  let hasInPlaceFlag = false
  let extendedRegex = false
  let expression: string | null = null
  let filePath: string | null = null

  let i = 0
  while (i < args.length) {
    const arg = args[i]!

    // 处理 -i 标志（带或不带备份后缀）
    if (arg === '-i' || arg === '--in-place') {
      hasInPlaceFlag = true
      i++
      // 在 macOS 上，-i 需要一个后缀参数（即使是空字符串）
      // 检查下一个参数是否像备份后缀（为空或以点开头）
      // 不要吞掉标志（-E、-r）或 sed 表达式（以 s、y、d 开头）
      if (i < args.length) {
        const nextArg = args[i]
        // 若下一个参数为空字符串或以点开头，则它是备份后缀
        if (
          typeof nextArg === 'string' &&
          !nextArg.startsWith('-') &&
          (nextArg === '' || nextArg.startsWith('.'))
        ) {
          i++ // 跳过备份后缀
        }
      }
      continue
    }
    if (arg.startsWith('-i')) {
      // -i.bak 或类似形式（内联后缀）
      hasInPlaceFlag = true
      i++
      continue
    }

    // 处理扩展正则标志
    if (arg === '-E' || arg === '-r' || arg === '--regexp-extended') {
      extendedRegex = true
      i++
      continue
    }

    // 处理带表达式的 -e 标志
    if (arg === '-e' || arg === '--expression') {
      if (i + 1 < args.length && typeof args[i + 1] === 'string') {
        // 仅支持单个表达式
        if (expression !== null) return null
        expression = args[i + 1]!
        i += 2
        continue
      }
      return null
    }
    if (arg.startsWith('--expression=')) {
      if (expression !== null) return null
      expression = arg.slice('--expression='.length)
      i++
      continue
    }

    // 跳过其他我们不认识的标志
    if (arg.startsWith('-')) {
      // 未知标志——无法安全解析
      return null
    }

    // 非标志参数
    if (expression === null) {
      // 第一个非标志参数即表达式
      expression = arg
    } else if (filePath === null) {
      // 第二个非标志参数即文件路径
      filePath = arg
    } else {
      // 多于一个文件——不支持简单渲染
      return null
    }

    i++
  }

  // 必须同时具备 -i 标志、表达式与文件路径
  if (!hasInPlaceFlag || !expression || !filePath) {
    return null
  }

  // 解析替换表达式：s/pattern/replacement/flags
  // 为简化处理，仅支持以 / 作为分隔符
  const substMatch = expression.match(/^s\//)
  if (!substMatch) {
    return null
  }

  const rest = expression.slice(2) // 跳过 's/'

  // 通过追踪转义字符来定位 pattern 与 replacement
  let pattern = ''
  let replacement = ''
  let flags = ''
  let state: 'pattern' | 'replacement' | 'flags' = 'pattern'
  let j = 0

  while (j < rest.length) {
    const char = rest[j]!

    if (char === '\\' && j + 1 < rest.length) {
      // 转义字符
      if (state === 'pattern') {
        pattern += char + rest[j + 1]
      } else if (state === 'replacement') {
        replacement += char + rest[j + 1]
      } else {
        flags += char + rest[j + 1]
      }
      j += 2
      continue
    }

    if (char === '/') {
      if (state === 'pattern') {
        state = 'replacement'
      } else if (state === 'replacement') {
        state = 'flags'
      } else {
        // flags 中出现额外分隔符——不符合预期
        return null
      }
      j++
      continue
    }

    if (state === 'pattern') {
      pattern += char
    } else if (state === 'replacement') {
      replacement += char
    } else {
      flags += char
    }
    j++
  }

  // 必须能够找到全部三部分（pattern、replacement 分隔符以及可选的 flags）
  if (state !== 'flags') {
    return null
  }

  // 校验 flags——仅允许安全的替换标志
  const validFlags = /^[gpimIM1-9]*$/
  if (!validFlags.test(flags)) {
    return null
  }

  return {
    filePath,
    pattern,
    replacement,
    flags,
    extendedRegex,
  }
}

/**
 * 将 sed 替换应用到文件内容上
 * 返回应用替换后的新内容
 */
export function applySedSubstitution(
  content: string,
  sedInfo: SedEditInfo,
): string {
  // 将 sed 模式转换为 JavaScript 正则
  let regexFlags = ''

  // 处理 global 标志
  if (sedInfo.flags.includes('g')) {
    regexFlags += 'g'
  }

  // 处理大小写不敏感标志（sed 中的 i 或 I）
  if (sedInfo.flags.includes('i') || sedInfo.flags.includes('I')) {
    regexFlags += 'i'
  }

  // 处理多行标志（sed 中的 m 或 M）
  if (sedInfo.flags.includes('m') || sedInfo.flags.includes('M')) {
    regexFlags += 'm'
  }

  // 将 sed 模式转换为 JavaScript 正则模式
  let jsPattern = sedInfo.pattern
    // 将 \/ 反转义为 /
    .replace(/\\\//g, '/')

  // 在 BRE 模式（无 -E 标志）下，元字符的转义含义正好相反：
  // BRE 中：\+ 表示“一次或多次”，+ 是字面量
  // ERE/JS 中：+ 表示“一次或多次”，\+ 是字面量
  // 我们需要将 BRE 的转义形式转换为 ERE，以适配 JavaScript 正则
  if (!sedInfo.extendedRegex) {
    jsPattern = jsPattern
      // 步骤 1：先保护字面反斜杠（\\）——在 BRE 和 ERE 中，\\ 都是字面反斜杠
      .replace(/\\\\/g, BACKSLASH_PLACEHOLDER)
      // 步骤 2：将被转义的元字符替换为占位符（这些在 JS 中应当是未转义形态）
      .replace(/\\\+/g, PLUS_PLACEHOLDER)
      .replace(/\\\?/g, QUESTION_PLACEHOLDER)
      .replace(/\\\|/g, PIPE_PLACEHOLDER)
      .replace(/\\\(/g, LPAREN_PLACEHOLDER)
      .replace(/\\\)/g, RPAREN_PLACEHOLDER)
      // 步骤 3：转义未转义的元字符（它们在 BRE 中是字面量）
      .replace(/\+/g, '\\+')
      .replace(/\?/g, '\\?')
      .replace(/\|/g, '\\|')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)')
      // 步骤 4：将占位符替换为对应的 JS 形态
      .replace(BACKSLASH_PLACEHOLDER_RE, '\\\\')
      .replace(PLUS_PLACEHOLDER_RE, '+')
      .replace(QUESTION_PLACEHOLDER_RE, '?')
      .replace(PIPE_PLACEHOLDER_RE, '|')
      .replace(LPAREN_PLACEHOLDER_RE, '(')
      .replace(RPAREN_PLACEHOLDER_RE, ')')
  }

  // 反转义 replacement 中 sed 特有的转义
  // 例如将 \n 转换为换行符，将 & 转换为 $&（匹配内容）等
  // 使用带随机盐的唯一占位符来防止注入攻击
  const salt = randomBytes(8).toString('hex')
  const ESCAPED_AMP_PLACEHOLDER = `___ESCAPED_AMPERSAND_${salt}___`
  const jsReplacement = sedInfo.replacement
    // 将 \/ 反转义为 /
    .replace(/\\\//g, '/')
    // 先把 \& 转义为占位符
    .replace(/\\&/g, ESCAPED_AMP_PLACEHOLDER)
    // 将 & 转换为 $&（完整匹配）——用 $$& 让输出中得到字面 $&
    .replace(/&/g, '$$&')
    // 将占位符还原为字面 &
    .replace(new RegExp(ESCAPED_AMP_PLACEHOLDER, 'g'), '&')

  try {
    const regex = new RegExp(jsPattern, regexFlags)
    return content.replace(regex, jsReplacement)
  } catch {
    // 若正则无效，则返回原始内容
    return content
  }
}
