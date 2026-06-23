/**
 * Shell 工具的共享权限规则匹配工具函数。
 *
 * 提取以下通用逻辑：
 * - 解析权限规则（精确匹配、前缀匹配、通配符匹配）
 * - 将命令与规则进行匹配
 * - 生成权限建议
 */

import type { PermissionUpdate } from './PermissionUpdateSchema.js'

// 通配符模式转义的 null 字节哨兵占位符 — 模块级定义
// 使 RegExp 对象只编译一次，而非每次权限检查都重新编译。
const ESCAPED_STAR_PLACEHOLDER = '\x00ESCAPED_STAR\x00'
const ESCAPED_BACKSLASH_PLACEHOLDER = '\x00ESCAPED_BACKSLASH\x00'
const ESCAPED_STAR_PLACEHOLDER_RE = new RegExp(ESCAPED_STAR_PLACEHOLDER, 'g')
const ESCAPED_BACKSLASH_PLACEHOLDER_RE = new RegExp(
  ESCAPED_BACKSLASH_PLACEHOLDER,
  'g',
)

/**
 * 已解析的权限规则可辨识联合类型。
 */
export type ShellPermissionRule =
  | {
      type: 'exact'
      command: string
    }
  | {
      type: 'prefix'
      prefix: string
    }
  | {
      type: 'wildcard'
      pattern: string
    }

/**
 * 从旧版 :* 语法中提取前缀（例如 "npm:*" -> "npm"）
 * 保留此函数以维持向后兼容。
 */
export function permissionRuleExtractPrefix(
  permissionRule: string,
): string | null {
  const match = permissionRule.match(/^(.+):\*$/)
  return match?.[1] ?? null
}

/**
 * 检查模式是否包含未转义的通配符（非旧版 :* 语法）。
 * 如果模式包含未被 \ 转义或不以末尾 :* 形式出现的 *，则返回 true。
 */
export function hasWildcards(pattern: string): boolean {
  // 如果以 :* 结尾，则为旧版前缀语法，非通配符
  if (pattern.endsWith(':*')) {
    return false
  }
  // 检查模式中是否存在未转义的 *
  // 如果星号前没有反斜杠，或者前面有偶数个反斜杠（已转义的反斜杠），
  // 则该星号是未转义的
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '*') {
      // 计算此星号前的反斜杠数量
      let backslashCount = 0
      let j = i - 1
      while (j >= 0 && pattern[j] === '\\') {
        backslashCount++
        j--
      }
      // 如果反斜杠数量为偶数（包括 0），则星号是未转义的
      if (backslashCount % 2 === 0) {
        return true
      }
    }
  }
  return false
}

/**
 * 将命令与通配符模式进行匹配。
 * 通配符 (*) 匹配任意字符序列。
 * 使用 \* 匹配字面量星号字符。
 * 使用 \\ 匹配字面量反斜杠。
 *
 * @param pattern - 包含通配符的权限规则模式
 * @param command - 要进行匹配的命令
 * @returns 如果命令匹配模式则返回 true
 */
export function matchWildcardPattern(
  pattern: string,
  command: string,
  caseInsensitive = false,
): boolean {
  // 去除模式的前后空白
  const trimmedPattern = pattern.trim()

  // 处理模式中的转义序列：\* 和 \\
  let processed = ''
  let i = 0

  while (i < trimmedPattern.length) {
    const char = trimmedPattern[i]

    // 处理转义序列
    if (char === '\\' && i + 1 < trimmedPattern.length) {
      const nextChar = trimmedPattern[i + 1]
      if (nextChar === '*') {
        // \* -> 字面量星号占位符
        processed += ESCAPED_STAR_PLACEHOLDER
        i += 2
        continue
      } else if (nextChar === '\\') {
        // \\ -> 字面量反斜杠占位符
        processed += ESCAPED_BACKSLASH_PLACEHOLDER
        i += 2
        continue
      }
    }

    processed += char
    i++
  }

  // 转义正则表达式特殊字符，但保留 *
  const escaped = processed.replace(/[.+?^${}()|[\]\\'"]/g, '\\$&')

  // 将未转义的 * 转换为 .* 以实现通配符匹配
  const withWildcards = escaped.replace(/\*/g, '.*')

  // 将占位符转换回转义后的正则字面量
  let regexPattern = withWildcards
    .replace(ESCAPED_STAR_PLACEHOLDER_RE, '\\*')
    .replace(ESCAPED_BACKSLASH_PLACEHOLDER_RE, '\\\\')

  // 当模式以 ' *'（空格 + 未转义通配符）结尾且该尾部通配符是
  // 唯一的未转义通配符时，使尾部的空格和参数变为可选，
  // 这样 'git *' 既能匹配 'git add' 也能匹配单独的 'git'。
  // 这使得通配符匹配与前缀规则语义（git:*）保持一致。
  // 多通配符模式如 '* run *' 被排除 — 使最后一个通配符可选
  // 会错误地匹配 'npm run'（无尾部参数）。
  const unescapedStarCount = (processed.match(/\*/g) || []).length
  if (regexPattern.endsWith(' .*') && unescapedStarCount === 1) {
    regexPattern = regexPattern.slice(0, -3) + '( .*)?'
  }

  // 创建匹配整个字符串的正则表达式。
  // 's'（dotAll）标志使 '.' 匹配换行符，因此通配符可以匹配
  // 包含嵌入换行符的命令（例如 splitCommand_DEPRECATED 后的 heredoc 内容）。
  const flags = 's' + (caseInsensitive ? 'i' : '')
  const regex = new RegExp(`^${regexPattern}$`, flags)

  return regex.test(command)
}

/**
 * 将权限规则字符串解析为结构化的规则对象。
 */
export function parsePermissionRule(
  permissionRule: string,
): ShellPermissionRule {
  // 优先检查旧版 :* 前缀语法（向后兼容）
  const prefix = permissionRuleExtractPrefix(permissionRule)
  if (prefix !== null) {
    return {
      type: 'prefix',
      prefix,
    }
  }

  // 检查新版通配符语法（包含 * 但不以 :* 结尾）
  if (hasWildcards(permissionRule)) {
    return {
      type: 'wildcard',
      pattern: permissionRule,
    }
  }

  // 否则，为精确匹配
  return {
    type: 'exact',
    command: permissionRule,
  }
}

/**
 * 为精确命令匹配生成权限更新建议。
 */
export function suggestionForExactCommand(
  toolName: string,
  command: string,
): PermissionUpdate[] {
  return [
    {
      type: 'addRules',
      rules: [
        {
          toolName,
          ruleContent: command,
        },
      ],
      behavior: 'allow',
      destination: 'localSettings',
    },
  ]
}

/**
 * 为前缀匹配生成权限更新建议。
 */
export function suggestionForPrefix(
  toolName: string,
  prefix: string,
): PermissionUpdate[] {
  return [
    {
      type: 'addRules',
      rules: [
        {
          toolName,
          ruleContent: `${prefix}:*`,
        },
      ],
      behavior: 'allow',
      destination: 'localSettings',
    },
  ]
}
