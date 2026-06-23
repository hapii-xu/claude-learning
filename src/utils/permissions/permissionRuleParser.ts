import { feature } from 'bun:bundle'
import { AGENT_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/AgentTool/constants.js'
import { TASK_OUTPUT_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/TaskOutputTool/constants.js'
import { TASK_STOP_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/TaskStopTool/prompt.js'
import type { PermissionRuleValue } from './PermissionRule.js'

// 死代码消除：仅 Anthropic 内部使用的工具名称通过条件导入，
// 避免其字符串泄露到外部构建中。静态导入总是会被打包。
/* eslint-disable @typescript-eslint/no-require-imports */
const BRIEF_TOOL_NAME: string | null =
  feature('KAIROS') || feature('KAIROS_BRIEF')
    ? (
        require('@claude-code-best/builtin-tools/tools/BriefTool/prompt.js') as typeof import('@claude-code-best/builtin-tools/tools/BriefTool/prompt.js')
      ).BRIEF_TOOL_NAME
    : null
/* eslint-enable @typescript-eslint/no-require-imports */

// 将旧版工具名称映射到当前的规范名称。
// 当工具重命名时，在此添加旧名称 → 新名称的映射，
// 以便权限规则、钩子和持久化的网络名称能解析到规范名称。
const LEGACY_TOOL_NAME_ALIASES: Record<string, string> = {
  Task: AGENT_TOOL_NAME,
  KillShell: TASK_STOP_TOOL_NAME,
  AgentOutputTool: TASK_OUTPUT_TOOL_NAME,
  BashOutputTool: TASK_OUTPUT_TOOL_NAME,
  ...((feature('KAIROS') || feature('KAIROS_BRIEF')) && BRIEF_TOOL_NAME
    ? { Brief: BRIEF_TOOL_NAME }
    : {}),
}

export function normalizeLegacyToolName(name: string): string {
  return LEGACY_TOOL_NAME_ALIASES[name] ?? name
}

export function getLegacyToolNames(canonicalName: string): string[] {
  const result: string[] = []
  for (const [legacy, canonical] of Object.entries(LEGACY_TOOL_NAME_ALIASES)) {
    if (canonical === canonicalName) result.push(legacy)
  }
  return result
}

/**
 * 转义规则内容中的特殊字符，以便安全存储在权限规则中。
 * 权限规则使用格式 "Tool(content)"，因此内容中的括号必须转义。
 *
 * 转义顺序很重要：
 * 1. 先转义现有反斜杠（\ -> \\）
 * 2. 然后转义括号（( -> \(, ) -> \)）
 *
 * @example
 * escapeRuleContent('psycopg2.connect()') // => 'psycopg2.connect\\(\\)'
 * escapeRuleContent('echo "test\\nvalue"') // => 'echo "test\\\\nvalue"'
 */
export function escapeRuleContent(content: string): string {
  return content
    .replace(/\\/g, '\\\\') // 先转义反斜杠
    .replace(/\(/g, '\\(') // 转义左括号
    .replace(/\)/g, '\\)') // 转义右括号
}

/**
 * 从权限规则解析后取消转义规则内容中的特殊字符。
 * 这会反转 escapeRuleContent 的转义操作。
 *
 * 取消转义顺序很重要（与转义相反）：
 * 1. 先取消转义括号（\( -> (, \) -> )）
 * 2. 然后取消转义反斜杠（\\ -> \）
 *
 * @example
 * unescapeRuleContent('psycopg2.connect\\(\\)') // => 'psycopg2.connect()'
 * unescapeRuleContent('echo "test\\\\nvalue"') // => 'echo "test\\nvalue"'
 */
export function unescapeRuleContent(content: string): string {
  return content
    .replace(/\\\(/g, '(') // 取消转义左括号
    .replace(/\\\)/g, ')') // 取消转义右括号
    .replace(/\\\\/g, '\\') // 最后取消转义反斜杠
}

/**
 * 将权限规则字符串解析为其组成部分。
 * 处理内容部分中转义的括号。
 *
 * 格式："ToolName" 或 "ToolName(content)"
 * 内容可能包含转义的括号：\( 和 \)
 *
 * @example
 * permissionRuleValueFromString('Bash') // => { toolName: 'Bash' }
 * permissionRuleValueFromString('Bash(npm install)') // => { toolName: 'Bash', ruleContent: 'npm install' }
 * permissionRuleValueFromString('Bash(python -c "print\\(1\\)")') // => { toolName: 'Bash', ruleContent: 'python -c "print(1)"' }
 */
export function permissionRuleValueFromString(
  ruleString: string,
): PermissionRuleValue {
  // 查找第一个未转义的左括号
  const openParenIndex = findFirstUnescapedChar(ruleString, '(')
  if (openParenIndex === -1) {
    // 未找到括号 - 这只是工具名称
    return { toolName: normalizeLegacyToolName(ruleString) }
  }

  // 查找最后一个未转义的右括号
  const closeParenIndex = findLastUnescapedChar(ruleString, ')')
  if (closeParenIndex === -1 || closeParenIndex <= openParenIndex) {
    // 没有匹配的右括号或格式错误 - 视为工具名称
    return { toolName: normalizeLegacyToolName(ruleString) }
  }

  // 确保右括号在末尾
  if (closeParenIndex !== ruleString.length - 1) {
    // 右括号后有内容 - 视为工具名称
    return { toolName: normalizeLegacyToolName(ruleString) }
  }

  const toolName = ruleString.substring(0, openParenIndex)
  const rawContent = ruleString.substring(openParenIndex + 1, closeParenIndex)

  // 缺少工具名称（例如 "(foo)"）是格式错误 - 将整个字符串视为工具名称
  if (!toolName) {
    return { toolName: normalizeLegacyToolName(ruleString) }
  }

  // 空内容（例如 "Bash()"）或独立通配符（例如 "Bash(*)"）
  // 应视为仅工具名称（工具级规则）
  if (rawContent === '' || rawContent === '*') {
    return { toolName: normalizeLegacyToolName(toolName) }
  }

  // 取消转义内容
  const ruleContent = unescapeRuleContent(rawContent)
  return { toolName: normalizeLegacyToolName(toolName), ruleContent }
}

/**
 * 将权限规则值转换为其字符串表示形式。
 * 转义内容中的括号以防止解析问题。
 *
 * @example
 * permissionRuleValueToString({ toolName: 'Bash' }) // => 'Bash'
 * permissionRuleValueToString({ toolName: 'Bash', ruleContent: 'npm install' }) // => 'Bash(npm install)'
 * permissionRuleValueToString({ toolName: 'Bash', ruleContent: 'python -c "print(1)"' }) // => 'Bash(python -c "print\\(1\\)")'
 */
export function permissionRuleValueToString(
  ruleValue: PermissionRuleValue,
): string {
  if (!ruleValue.ruleContent) {
    return ruleValue.toolName
  }
  const escapedContent = escapeRuleContent(ruleValue.ruleContent)
  return `${ruleValue.toolName}(${escapedContent})`
}

/**
 * 查找字符第一次未转义出现的位置索引。
 * 如果字符前有奇数个反斜杠，则视为已转义。
 */
function findFirstUnescapedChar(str: string, char: string): number {
  for (let i = 0; i < str.length; i++) {
    if (str[i] === char) {
      // 计算前面的反斜杠数量
      let backslashCount = 0
      let j = i - 1
      while (j >= 0 && str[j] === '\\') {
        backslashCount++
        j--
      }
      // 如果反斜杠数量为偶数，则该字符未转义
      if (backslashCount % 2 === 0) {
        return i
      }
    }
  }
  return -1
}

/**
 * 查找字符最后一次未转义出现的位置索引。
 * 如果字符前有奇数个反斜杠，则视为已转义。
 */
function findLastUnescapedChar(str: string, char: string): number {
  for (let i = str.length - 1; i >= 0; i--) {
    if (str[i] === char) {
      // 计算前面的反斜杠数量
      let backslashCount = 0
      let j = i - 1
      while (j >= 0 && str[j] === '\\') {
        backslashCount++
        j--
      }
      // 如果反斜杠数量为偶数，则该字符未转义
      if (backslashCount % 2 === 0) {
        return i
      }
    }
  }
  return -1
}
