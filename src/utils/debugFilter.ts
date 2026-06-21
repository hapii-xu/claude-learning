import memoize from 'lodash-es/memoize.js'

export type DebugFilter = {
  include: string[]
  exclude: string[]
  isExclusive: boolean
}

/**
 * 将调试过滤器字符串解析为过滤器配置
 * 示例：
 * - "api,hooks" -> 仅包含 api 和 hooks 类别
 * - "!1p,!file" -> 排除 logging 和 file 类别
 * - undefined/空 -> 不过滤（显示全部）
 */
export const parseDebugFilter = memoize(
  (filterString?: string): DebugFilter | null => {
    if (!filterString || filterString.trim() === '') {
      return null
    }

    const filters = filterString
      .split(',')
      .map(f => f.trim())
      .filter(Boolean)

    // 若无有效过滤器，返回 null
    if (filters.length === 0) {
      return null
    }

    // 检查是否混合了包含和排除过滤器
    const hasExclusive = filters.some(f => f.startsWith('!'))
    const hasInclusive = filters.some(f => !f.startsWith('!'))

    if (hasExclusive && hasInclusive) {
      // 目前将此视为错误情况并显示所有消息
      // 使用 logForDebugging 记录错误以避免 console.error lint 规则
      // 等循环依赖解决后再引入使用
      // 目前仅静默返回 null
      return null
    }

    // 清理过滤器（移除 ! 前缀）并规范化
    const cleanFilters = filters.map(f => f.replace(/^!/, '').toLowerCase())

    return {
      include: hasExclusive ? [] : cleanFilters,
      exclude: hasExclusive ? cleanFilters : [],
      isExclusive: hasExclusive,
    }
  },
)

/**
 * 从消息中提取调试类别
 * 支持多种模式：
 * - "category: message" -> ["category"]
 * - "[CATEGORY] message" -> ["category"]
 * - "MCP server \"name\": message" -> ["mcp", "name"]
 * - "[ANT-ONLY] 1P event: tengu_timer" -> ["ant-only", "1p"]
 *
 * 返回小写类别以便不区分大小写匹配
 */
export function extractDebugCategories(message: string): string[] {
  const categories: string[] = []

  // 模式 3：MCP server "servername" - 优先检查以避免误判
  const mcpMatch = message.match(/^MCP server ["']([^"']+)["']/)
  if (mcpMatch && mcpMatch[1]) {
    categories.push('mcp')
    categories.push(mcpMatch[1].toLowerCase())
  } else {
    // 模式 1："category: message"（简单前缀）- 仅在不匹配 MCP 模式时使用
    const prefixMatch = message.match(/^([^:[]+):/)
    if (prefixMatch && prefixMatch[1]) {
      categories.push(prefixMatch[1].trim().toLowerCase())
    }
  }

  // 模式 2：开头的 [CATEGORY]
  const bracketMatch = message.match(/^\[([^\]]+)]/)
  if (bracketMatch && bracketMatch[1]) {
    categories.push(bracketMatch[1].trim().toLowerCase())
  }

  // 模式 4：检查消息中的其他类别
  // 例如 "[ANT-ONLY] 1P event: tengu_timer" 应同时匹配 "ant-only" 和 "1p"
  if (message.toLowerCase().includes('1p event:')) {
    categories.push('1p')
  }

  // 模式 5：在首个模式之后查找次级类别
  // 例如 "AutoUpdaterWrapper: Installation type: development"
  const secondaryMatch = message.match(
    /:\s*([^:]+?)(?:\s+(?:type|mode|status|event))?:/,
  )
  if (secondaryMatch && secondaryMatch[1]) {
    const secondary = secondaryMatch[1].trim().toLowerCase()
    // 仅在类别名合理时添加（不太长、无空格）
    if (secondary.length < 30 && !secondary.includes(' ')) {
      categories.push(secondary)
    }
  }

  // 若未找到类别，返回空数组（未分类）
  return Array.from(new Set(categories)) // 去重
}

/**
 * 根据过滤器检查是否应显示调试消息
 * @param categories - 从消息中提取的类别
 * @param filter - 解析后的过滤器配置
 * @returns 若应显示消息则为 true
 */
export function shouldShowDebugCategories(
  categories: string[],
  filter: DebugFilter | null,
): boolean {
  // 无过滤器表示显示全部
  if (!filter) {
    return true
  }

  // 若未找到类别，根据过滤器模式处理
  if (categories.length === 0) {
    // 排除模式下，未分类消息默认被排除（出于安全考虑）
    // 包含模式下，未分类消息也被排除（必须匹配一个类别）
    return false
  }

  if (filter.isExclusive) {
    // 排除模式：若所有类别都不在排除列表中则显示
    return !categories.some(cat => filter.exclude.includes(cat))
  } else {
    // 包含模式：若任一类别在包含列表中则显示
    return categories.some(cat => filter.include.includes(cat))
  }
}

/**
 * 检查调试消息是否应显示的主函数
 * 结合提取与过滤
 */
export function shouldShowDebugMessage(
  message: string,
  filter: DebugFilter | null,
): boolean {
  // 快速路径：无过滤器表示显示全部
  if (!filter) {
    return true
  }

  // 仅在存在过滤器时提取类别
  const categories = extractDebugCategories(message)
  return shouldShowDebugCategories(categories, filter)
}
