/**
 * Markdown 文件的 frontmatter 解析器
 * 提取并解析 --- 分隔符之间的 YAML frontmatter
 */

import { logForDebugging } from './debug.js'
import type { HooksSettings } from './settings/types.js'
import { parseYaml } from './yaml.js'

export type FrontmatterData = {
  // YAML 对没有值的键（如 "key:" 后面什么都没有）可能返回 null
  'allowed-tools'?: string | string[] | null
  description?: string | null
  // 内存类型：'user'、'feedback'、'project' 或 'reference'
  // 仅适用于内存文件；通过 src/memdir/memoryTypes.ts 中的 parseMemoryType() 细化
  type?: string | null
  'argument-hint'?: string | null
  when_to_use?: string | null
  version?: string | null
  // 仅适用于斜杠命令 — 类似布尔环境变量的字符串，
  // 用于确定是否对 SlashCommand 工具可见
  'hide-from-slash-command-tool'?: string | null
  // 模型别名或名称（如 'haiku'、'sonnet'、'opus' 或具体模型名）
  // 命令使用父模型时用 'inherit'
  model?: string | null
  // 逗号分隔的 skill 名称列表，用于预加载（仅适用于 agent）
  skills?: string | null
  // 用户是否可以通过输入 /skill-name 调用此 skill
  // 'true' = 用户可以输入 /skill-name 调用
  // 'false' = 只有模型可以通过 Skill 工具调用
  // 默认值取决于来源：commands/ 默认为 true，skills/ 默认为 false
  'user-invocable'?: string | null
  // 调用此 skill 时要注册的 hooks
  // 键为钩子事件（PreToolUse、PostToolUse、Stop 等）
  // 值为带有 hooks 的匹配器配置数组
  // 由 loadSkillsDir.ts 中的 HooksSchema 验证
  hooks?: HooksSettings | null
  // agent 的努力程度（如 'low'、'medium'、'high'、'xhigh'、'max' 或整数）
  // 控制 agent 模型使用的思考努力程度
  effort?: string | null
  // skill 的执行上下文：'inline'（默认）或 'fork'（作为子 agent 运行）
  // 'inline' = skill 内容扩展到当前对话中
  // 'fork' = skill 在有独立上下文和 token 预算的子 agent 中运行
  context?: 'inline' | 'fork' | null
  // fork 时使用的 agent 类型（如 'Bash'、'general-purpose'）
  // 仅在 context 为 'fork' 时适用
  agent?: string | null
  // 此 skill 适用的文件路径 glob 模式。接受逗号分隔的字符串或字符串 YAML 列表。
  // 设置后，仅当模型接触到匹配文件时才激活 skill
  // 使用与 CLAUDE.md paths frontmatter 相同的格式
  paths?: string | string[] | null
  // skill/command .md 内容中 !`cmd` 和 ```! 块使用的 shell。
  // 'bash'（默认）或 'powershell'。文件级别 — 适用于所有 !-块。
  // 从不查询 settings.defaultShell：skill 跨平台可移植，
  // 因此由作者选择 shell 而非读者。见 docs/design/ps-shell-selection.md §5.3。
  shell?: string | null
  [key: string]: unknown
}

export type ParsedMarkdown = {
  frontmatter: FrontmatterData
  content: string
}

// 在 YAML 值中需要引用的字符（未引用时）
// - { } 是流映射指示符
// - * 是锚点/别名指示符
// - [ ] 是流序列指示符
// - ': '（冒号后跟空格）是键指示符 — 出现在值中间时会导致
//   "紧凑映射中不允许嵌套映射"。匹配该模式而非裸 ':' 使
//   '12:34' 时间和 'https://' URL 保持不引用。
// - # 是注释指示符
// - & 是锚点指示符
// - ! 是标签指示符
// - | > 是块标量指示符（仅在开头）
// - % 是指令指示符（仅在开头）
// - @ ` 是保留字符
const YAML_SPECIAL_CHARS = /[{}[\]*&#!|>%@`]|: /

/**
 * 预处理 frontmatter 文本，对包含特殊 YAML 字符的值进行引用。
 * 使 **\/*.{ts,tsx} 等 glob 模式能被正确解析。
 */
function quoteProblematicValues(frontmatterText: string): string {
  const lines = frontmatterText.split('\n')
  const result: string[] = []

  for (const line of lines) {
    // 匹配简单的 key: value 行（非缩进、非列表项、非块标量）
    const match = line.match(/^([a-zA-Z_-]+):\s+(.+)$/)
    if (match) {
      const [, key, value] = match
      if (!key || !value) {
        result.push(line)
        continue
      }

      // 已引用则跳过
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        result.push(line)
        continue
      }

      // 包含特殊 YAML 字符则引用
      if (YAML_SPECIAL_CHARS.test(value)) {
        // 使用双引号并转义已有的双引号
        const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
        result.push(`${key}: "${escaped}"`)
        continue
      }
    }

    result.push(line)
  }

  return result.join('\n')
}

export const FRONTMATTER_REGEX = /^---\s*\n([\s\S]*?)---\s*\n?/

/**
 * 解析 markdown 内容以提取 frontmatter 和正文
 * @param markdown 原始 markdown 内容
 * @returns 包含解析后的 frontmatter 和去除 frontmatter 后的内容的对象
 */
export function parseFrontmatter(
  markdown: string,
  sourcePath?: string,
): ParsedMarkdown {
  const match = markdown.match(FRONTMATTER_REGEX)

  if (!match) {
    // No frontmatter found
    return {
      frontmatter: {},
      content: markdown,
    }
  }

  const frontmatterText = match[1] || ''
  const content = markdown.slice(match[0].length)

  let frontmatter: FrontmatterData = {}
  try {
    const parsed = parseYaml(frontmatterText) as FrontmatterData | null
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      frontmatter = parsed
    }
  } catch {
    // YAML parsing failed - try again after quoting problematic values
    try {
      const quotedText = quoteProblematicValues(frontmatterText)
      const parsed = parseYaml(quotedText) as FrontmatterData | null
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        frontmatter = parsed
      }
    } catch (retryError) {
      // Still failed - log for debugging so users can diagnose broken frontmatter
      const location = sourcePath ? ` in ${sourcePath}` : ''
      logForDebugging(
        `Failed to parse YAML frontmatter${location}: ${retryError instanceof Error ? retryError.message : retryError}`,
        { level: 'warn' },
      )
    }
  }

  return {
    frontmatter,
    content,
  }
}

/**
 * Splits a comma-separated string and expands brace patterns.
 * Commas inside braces are not treated as separators.
 * Also accepts a YAML list (string array) for ergonomic frontmatter.
 * @param input - Comma-separated string, or array of strings, with optional brace patterns
 * @returns Array of expanded strings
 * @example
 * splitPathInFrontmatter("a, b") // returns ["a", "b"]
 * splitPathInFrontmatter("a, src/*.{ts,tsx}") // returns ["a", "src/*.ts", "src/*.tsx"]
 * splitPathInFrontmatter("{a,b}/{c,d}") // returns ["a/c", "a/d", "b/c", "b/d"]
 * splitPathInFrontmatter(["a", "src/*.{ts,tsx}"]) // returns ["a", "src/*.ts", "src/*.tsx"]
 */
export function splitPathInFrontmatter(input: string | string[]): string[] {
  if (Array.isArray(input)) {
    return input.flatMap(splitPathInFrontmatter)
  }
  if (typeof input !== 'string') {
    return []
  }
  // Split by comma while respecting braces
  const parts: string[] = []
  let current = ''
  let braceDepth = 0

  for (let i = 0; i < input.length; i++) {
    const char = input[i]

    if (char === '{') {
      braceDepth++
      current += char
    } else if (char === '}') {
      braceDepth--
      current += char
    } else if (char === ',' && braceDepth === 0) {
      // Split here - we're at a comma outside of braces
      const trimmed = current.trim()
      if (trimmed) {
        parts.push(trimmed)
      }
      current = ''
    } else {
      current += char
    }
  }

  // Add the last part
  const trimmed = current.trim()
  if (trimmed) {
    parts.push(trimmed)
  }

  // Expand brace patterns in each part
  return parts
    .filter(p => p.length > 0)
    .flatMap(pattern => expandBraces(pattern))
}

/**
 * Expands brace patterns in a glob string.
 * @example
 * expandBraces("src/*.{ts,tsx}") // returns ["src/*.ts", "src/*.tsx"]
 * expandBraces("{a,b}/{c,d}") // returns ["a/c", "a/d", "b/c", "b/d"]
 */
function expandBraces(pattern: string): string[] {
  // Find the first brace group
  const braceMatch = pattern.match(/^([^{]*)\{([^}]+)\}(.*)$/)

  if (!braceMatch) {
    // No braces found, return pattern as-is
    return [pattern]
  }

  const prefix = braceMatch[1] || ''
  const alternatives = braceMatch[2] || ''
  const suffix = braceMatch[3] || ''

  // Split alternatives by comma and expand each one
  const parts = alternatives.split(',').map(alt => alt.trim())

  // Recursively expand remaining braces in suffix
  const expanded: string[] = []
  for (const part of parts) {
    const combined = prefix + part + suffix
    // Recursively handle additional brace groups
    const furtherExpanded = expandBraces(combined)
    expanded.push(...furtherExpanded)
  }

  return expanded
}

/**
 * Parses a positive integer value from frontmatter.
 * Handles both number and string representations.
 *
 * @param value The raw value from frontmatter (could be number, string, or undefined)
 * @returns The parsed positive integer, or undefined if invalid or not provided
 */
export function parsePositiveIntFromFrontmatter(
  value: unknown,
): number | undefined {
  if (value === undefined || value === null) {
    return undefined
  }

  const parsed = typeof value === 'number' ? value : parseInt(String(value), 10)

  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed
  }

  return undefined
}

/**
 * Validate and coerce a description value from frontmatter.
 *
 * Strings are returned as-is (trimmed). Primitive values (numbers, booleans)
 * are coerced to strings via String(). Non-scalar values (arrays, objects)
 * are invalid and are logged then omitted. Null, undefined, and
 * empty/whitespace-only strings return null so callers can fall back to
 * a default.
 *
 * @param value - The raw frontmatter description value
 * @param componentName - The skill/command/agent/style name for log messages
 * @param pluginName - The plugin name, if this came from a plugin
 */
export function coerceDescriptionToString(
  value: unknown,
  componentName?: string,
  pluginName?: string,
): string | null {
  if (value == null) {
    return null
  }
  if (typeof value === 'string') {
    return value.trim() || null
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  // Non-scalar descriptions (arrays, objects) are invalid — log and omit
  const source = pluginName
    ? `${pluginName}:${componentName}`
    : (componentName ?? 'unknown')
  logForDebugging(`Description invalid for ${source} - omitting`, {
    level: 'warn',
  })
  return null
}

/**
 * Parse a boolean frontmatter value.
 * Only returns true for literal true or "true" string.
 */
export function parseBooleanFrontmatter(value: unknown): boolean {
  return value === true || value === 'true'
}

/**
 * Shell values accepted in `shell:` frontmatter for .md `!`-block execution.
 */
export type FrontmatterShell = 'bash' | 'powershell'

const FRONTMATTER_SHELLS: readonly FrontmatterShell[] = ['bash', 'powershell']

/**
 * Parse and validate the `shell:` frontmatter field.
 *
 * Returns undefined for absent/null/empty (caller defaults to bash).
 * Logs a warning and returns undefined for unrecognized values — we fall
 * back to bash rather than failing the skill load, matching how `effort`
 * and other fields degrade.
 */
export function parseShellFrontmatter(
  value: unknown,
  source: string,
): FrontmatterShell | undefined {
  if (value == null) {
    return undefined
  }
  const normalized = String(value).trim().toLowerCase()
  if (normalized === '') {
    return undefined
  }
  if ((FRONTMATTER_SHELLS as readonly string[]).includes(normalized)) {
    return normalized as FrontmatterShell
  }
  logForDebugging(
    `Frontmatter 'shell: ${value}' in ${source} is not recognized. Valid values: ${FRONTMATTER_SHELLS.join(', ')}. Falling back to bash.`,
    { level: 'warn' },
  )
  return undefined
}
