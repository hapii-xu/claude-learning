/**
 * 用于替换技能/命令提示中的 $ARGUMENTS 占位符的工具。
 *
 * 支持：
 * - $ARGUMENTS - 替换为完整的参数字符串
 * - $ARGUMENTS[0]、$ARGUMENTS[1] 等 - 替换为单个索引参数
 * - $0、$1 等 - $ARGUMENTS[0]、$ARGUMENTS[1] 的简写
 * - 命名参数（例如，$foo、$bar）- 当在前言中定义了参数名称时
 *
 * 参数使用 shell-quote 解析以正确处理 shell 参数。
 */

import { tryParseShellCommand } from './bash/shellQuote.js'

/**
 * 将参数字符串解析为单个参数的数组。
 * 使用 shell-quote 进行正确的 shell 参数解析，包括引号字符串。
 *
 * 示例：
 * - "foo bar baz" => ["foo", "bar", "baz"]
 * - 'foo "hello world" baz' => ["foo", "hello world", "baz"]
 * - "foo 'hello world' baz" => ["foo", "hello world", "baz"]
 */
export function parseArguments(args: string): string[] {
  if (!args || !args.trim()) {
    return []
  }

  // 返回 $KEY 以保留变量字面量语法（不展开变量）
  const result = tryParseShellCommand(args, key => `$${key}`)
  if (!result.success) {
    // 如果解析失败则回退到简单的空白分割
    return args.split(/\s+/).filter(Boolean)
  }

  // 仅过滤字符串 token（忽略 shell 运算符等）
  return result.tokens.filter(
    (token): token is string => typeof token === 'string',
  )
}

/**
 * 从前言的 'arguments' 字段解析参数名称。
 * 接受空格分隔的字符串或字符串数组。
 *
 * 示例：
 * - "foo bar baz" => ["foo", "bar", "baz"]
 * - ["foo", "bar", "baz"] => ["foo", "bar", "baz"]
 */
export function parseArgumentNames(
  argumentNames: string | string[] | undefined,
): string[] {
  if (!argumentNames) {
    return []
  }

  // 过滤掉空字符串和纯数字名称（与 $0、$1 简写冲突）
  const isValidName = (name: string): boolean =>
    typeof name === 'string' && name.trim() !== '' && !/^\d+$/.test(name)

  if (Array.isArray(argumentNames)) {
    return argumentNames.filter(isValidName)
  }
  if (typeof argumentNames === 'string') {
    return argumentNames.split(/\s+/).filter(isValidName)
  }
  return []
}

/**
 * 生成显示剩余未填充参数的提示。
 * @param argNames - 来自前言的参数名称数组
 * @param typedArgs - 用户到目前为止输入的参数
 * @returns 提示字符串如 "[arg2] [arg3]"，如果全部填充则返回 undefined
 */
export function generateProgressiveArgumentHint(
  argNames: string[],
  typedArgs: string[],
): string | undefined {
  const remaining = argNames.slice(typedArgs.length)
  if (remaining.length === 0) return undefined
  return remaining.map(name => `[${name}]`).join(' ')
}

/**
 * 将内容中的 $ARGUMENTS 占位符替换为实际的参数值。
 *
 * @param content - 包含占位符的内容
 * @param args - 原始参数字符串（可能为 undefined/null）
 * @param appendIfNoPlaceholder - 如果为 true 且未找到占位符，则将 "ARGUMENTS: {args}" 附加到内容
 * @param argumentNames - 可选的命名参数数组（例如，["foo", "bar"]），映射到索引位置
 * @returns 替换占位符后的内容
 */
export function substituteArguments(
  content: string,
  args: string | undefined,
  appendIfNoPlaceholder = true,
  argumentNames: string[] = [],
): string {
  // undefined/null 表示未提供参数 - 返回内容不变
  // 空字符串是有效输入，应该将占位符替换为空
  if (args === undefined || args === null) {
    return content
  }

  const parsedArgs = parseArguments(args)
  const originalContent = content

  // 用值替换命名参数（例如，$foo、$bar）
  // 命名参数映射到位置：argumentNames[0] -> parsedArgs[0]，等等。
  for (let i = 0; i < argumentNames.length; i++) {
    const name = argumentNames[i]
    if (!name) continue

    // 匹配 $name 但不匹配 $name[...] 或 $nameXxx（单词字符）
    // 同时确保我们匹配单词边界以避免部分匹配
    content = content.replace(
      new RegExp(`\\$${name}(?![\\[\\w])`, 'g'),
      parsedArgs[i] ?? '',
    )
  }

  // 替换索引参数（$ARGUMENTS[0]、$ARGUMENTS[1] 等）
  content = content.replace(/\$ARGUMENTS\[(\d+)\]/g, (_, indexStr: string) => {
    const index = parseInt(indexStr, 10)
    return parsedArgs[index] ?? ''
  })

  // 替换简写索引参数（$0、$1 等）
  content = content.replace(/\$(\d+)(?!\w)/g, (_, indexStr: string) => {
    const index = parseInt(indexStr, 10)
    return parsedArgs[index] ?? ''
  })

  // 用完整的参数字符串替换 $ARGUMENTS
  content = content.replaceAll('$ARGUMENTS', args)

  // 如果未找到占位符且 appendIfNoPlaceholder 为 true，则附加
  // 但仅当 args 非空时（空字符串表示调用命令时没有参数）
  if (content === originalContent && appendIfNoPlaceholder && args) {
    content = content + `\n\nARGUMENTS: ${args}`
  }

  return content
}
