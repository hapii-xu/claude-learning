import { relative } from 'path'
import type {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  DocumentSymbol,
  Hover,
  Location,
  LocationLink,
  MarkedString,
  MarkupContent,
  SymbolInformation,
  SymbolKind,
} from 'vscode-languageserver-types'
import { logForDebugging } from 'src/utils/debug.js'
import { errorMessage } from 'src/utils/errors.js'
import { plural } from 'src/utils/stringUtils.js'

/**
 * 格式化 URI，在可能的情况下转为相对路径。
 * 处理 URI 解码，若格式不正确则优雅回退到未解码路径。
 * 仅在更短且不以 ../../ 开头时使用相对路径
 */
function formatUri(uri: string | undefined, cwd?: string): string {
  // 处理 undefined/null URI —— 表明 LSP 数据畸形
  if (!uri) {
    // 注意：理想情况下应在更早处捕获并做正确的错误日志
    // 这里是格式化层的防御性兜底
    logForDebugging(
      'formatUri 被传入 undefined URI —— 表明 LSP server 返回畸形',
      { level: 'warn' },
    )
    return '<未知位置>'
  }

  // 如果存在 file:// 协议则去除
  // 在 Windows 上，file:///C:/path 替换 file:// 后变为 /C:/path
  // 对于 Windows 盘符路径需要去掉前导斜杠
  let filePath = uri.replace(/^file:\/\//, '')
  if (/^\/[A-Za-z]:/.test(filePath)) {
    filePath = filePath.slice(1)
  }

  // 解码 URI 编码 —— 优雅处理畸形 URI
  try {
    filePath = decodeURIComponent(filePath)
  } catch (error) {
    // 记录以供调试，但继续使用未解码路径
    const errorMsg = errorMessage(error)
    logForDebugging(
      `解码 LSP URI '${uri}' 失败：${errorMsg}。使用未解码的路径：${filePath}`,
      { level: 'warn' },
    )
    // filePath 已包含未解码路径，仍可使用
  }

  // 若提供了 cwd 则转为相对路径
  if (cwd) {
    // 将分隔符统一为正斜杠，保证展示一致
    const relativePath = relative(cwd, filePath).replaceAll('\\', '/')
    // 仅在更短且不以 ../.. 开头时才使用相对路径
    if (
      relativePath.length < filePath.length &&
      !relativePath.startsWith('../../')
    ) {
      return relativePath
    }
  }

  // 将分隔符统一为正斜杠，保证展示一致
  return filePath.replaceAll('\\', '/')
}

/**
 * 按文件 URI 分组条目。
 * 可同时用于 Location[] 和 SymbolInformation[] 的通用辅助函数
 */
function groupByFile<T extends { uri: string } | { location: { uri: string } }>(
  items: T[],
  cwd?: string,
): Map<string, T[]> {
  const byFile = new Map<string, T[]>()
  for (const item of items) {
    const uri = 'uri' in item ? item.uri : item.location.uri
    const filePath = formatUri(uri, cwd)
    const existingItems = byFile.get(filePath)
    if (existingItems) {
      existingItems.push(item)
    } else {
      byFile.set(filePath, [item])
    }
  }
  return byFile
}

/**
 * 以文件路径和行/字符位置格式化 Location
 */
function formatLocation(location: Location, cwd?: string): string {
  const filePath = formatUri(location.uri, cwd)
  const line = location.range.start.line + 1 // 转为 1-based
  const character = location.range.start.character + 1 // 转为 1-based
  return `${filePath}:${line}:${character}`
}

/**
 * 将 LocationLink 转为 Location 格式以统一处理
 */
function locationLinkToLocation(link: LocationLink): Location {
  return {
    uri: link.targetUri,
    range: link.targetSelectionRange || link.targetRange,
  }
}

/**
 * 检查对象是 LocationLink（有 targetUri）还是 Location（有 uri）
 */
function isLocationLink(item: Location | LocationLink): item is LocationLink {
  return 'targetUri' in item
}

/**
 * 格式化 goToDefinition 结果
 * 可能返回 Location、LocationLink 或它们的数组
 */
export function formatGoToDefinitionResult(
  result: Location | Location[] | LocationLink | LocationLink[] | null,
  cwd?: string,
): string {
  if (!result) {
    return '未找到定义。这可能是因为光标不在符号上，或定义位于 LSP server 尚未索引的外部库中。'
  }

  if (Array.isArray(result)) {
    // 将 LocationLink 转为 Location 以便统一处理
    const locations: Location[] = result.map(item =>
      isLocationLink(item) ? locationLinkToLocation(item) : item,
    )

    // 记录并过滤掉 uri 为 undefined 的位置
    const invalidLocations = locations.filter(loc => !loc || !loc.uri)
    if (invalidLocations.length > 0) {
      logForDebugging(
        `formatGoToDefinitionResult：过滤掉 ${invalidLocations.length} 个无效位置 —— 这应在更早处被捕获`,
        { level: 'warn' },
      )
    }

    const validLocations = locations.filter(loc => loc && loc.uri)

    if (validLocations.length === 0) {
      return '未找到定义。这可能是因为光标不在符号上，或定义位于 LSP server 尚未索引的外部库中。'
    }
    if (validLocations.length === 1) {
      return `定义于 ${formatLocation(validLocations[0]!, cwd)}`
    }
    const locationList = validLocations
      .map(loc => `  ${formatLocation(loc, cwd)}`)
      .join('\n')
    return `找到 ${validLocations.length} 处定义：\n${locationList}`
  }

  // 单个结果 —— 必要时转为 LocationLink
  const location = isLocationLink(result)
    ? locationLinkToLocation(result)
    : result
  return `定义于 ${formatLocation(location, cwd)}`
}

/**
 * 格式化 findReferences 结果
 */
export function formatFindReferencesResult(
  result: Location[] | null,
  cwd?: string,
): string {
  if (!result || result.length === 0) {
    return '未找到引用。这可能是因为该符号没有使用点，或 LSP server 尚未完成工作区索引。'
  }

  // 记录并过滤掉 uri 为 undefined 的位置
  const invalidLocations = result.filter(loc => !loc || !loc.uri)
  if (invalidLocations.length > 0) {
    logForDebugging(
      `formatFindReferencesResult：过滤掉 ${invalidLocations.length} 个无效位置 —— 这应在更早处被捕获`,
      { level: 'warn' },
    )
  }

  const validLocations = result.filter(loc => loc && loc.uri)

  if (validLocations.length === 0) {
    return '未找到引用。这可能是因为该符号没有使用点，或 LSP server 尚未完成工作区索引。'
  }

  if (validLocations.length === 1) {
    return `找到 1 处引用：\n  ${formatLocation(validLocations[0]!, cwd)}`
  }

  // 按文件分组引用
  const byFile = groupByFile(validLocations, cwd)

  const lines: string[] = [
    `找到 ${validLocations.length} 处引用，跨 ${byFile.size} 个文件：`,
  ]

  for (const [filePath, locations] of byFile) {
    lines.push(`\n${filePath}:`)
    for (const loc of locations) {
      const line = loc.range.start.line + 1
      const character = loc.range.start.character + 1
      lines.push(`  第 ${line} 行：${character}`)
    }
  }

  return lines.join('\n')
}

/**
 * 从 MarkupContent 或 MarkedString 中提取文本内容
 */
function extractMarkupText(
  contents: MarkupContent | MarkedString | MarkedString[],
): string {
  if (Array.isArray(contents)) {
    return contents
      .map(item => {
        if (typeof item === 'string') {
          return item
        }
        return item.value
      })
      .join('\n\n')
  }

  if (typeof contents === 'string') {
    return contents
  }

  if ('kind' in contents) {
    // MarkupContent
    return contents.value
  }

  // MarkedString 对象
  return contents.value
}

/**
 * 格式化 hover 结果
 */
export function formatHoverResult(result: Hover | null, _cwd?: string): string {
  if (!result) {
    return '没有可用的悬停信息。这可能是因为光标不在符号上，或 LSP server 尚未完成对该文件的索引。'
  }

  const content = extractMarkupText(result.contents)

  if (result.range) {
    const line = result.range.start.line + 1
    const character = result.range.start.character + 1
    return `位置 ${line}:${character} 的悬停信息：\n\n${content}`
  }

  return content
}

/**
 * 将 SymbolKind 枚举映射为可读字符串
 */
function symbolKindToString(kind: SymbolKind): string {
  const kinds: Record<SymbolKind, string> = {
    [1]: 'File',
    [2]: 'Module',
    [3]: 'Namespace',
    [4]: 'Package',
    [5]: 'Class',
    [6]: 'Method',
    [7]: 'Property',
    [8]: 'Field',
    [9]: 'Constructor',
    [10]: 'Enum',
    [11]: 'Interface',
    [12]: 'Function',
    [13]: 'Variable',
    [14]: 'Constant',
    [15]: 'String',
    [16]: 'Number',
    [17]: 'Boolean',
    [18]: 'Array',
    [19]: 'Object',
    [20]: 'Key',
    [21]: 'Null',
    [22]: 'EnumMember',
    [23]: 'Struct',
    [24]: 'Event',
    [25]: 'Operator',
    [26]: 'TypeParameter',
  }
  return kinds[kind] || 'Unknown'
}

/**
 * 带缩进格式化单个 DocumentSymbol
 */
function formatDocumentSymbolNode(
  symbol: DocumentSymbol,
  indent: number = 0,
): string[] {
  const lines: string[] = []
  const prefix = '  '.repeat(indent)
  const kind = symbolKindToString(symbol.kind)

  let line = `${prefix}${symbol.name} (${kind})`
  if (symbol.detail) {
    line += ` ${symbol.detail}`
  }

  const symbolLine = symbol.range.start.line + 1
  line += ` - 第 ${symbolLine} 行`

  lines.push(line)

  // 递归格式化子项
  if (symbol.children && symbol.children.length > 0) {
    for (const child of symbol.children) {
      lines.push(...formatDocumentSymbolNode(child, indent + 1))
    }
  }

  return lines
}

/**
 * 格式化 documentSymbol 结果（分层大纲）
 * 同时处理 DocumentSymbol[]（分层，带 range）和 SymbolInformation[]（扁平，带 location.range）
 * LSP 规范允许 textDocument/documentSymbol 返回任一格式
 */
export function formatDocumentSymbolResult(
  result: DocumentSymbol[] | SymbolInformation[] | null,
  cwd?: string,
): string {
  if (!result || result.length === 0) {
    return '文档中未找到符号。这可能是因为文件为空、不被 LSP server 支持，或 server 尚未完成对文件的索引。'
  }

  // 检测格式：DocumentSymbol 直接有 'range'，SymbolInformation 有 'location.range'
  // 检查第一个有效元素以确定格式
  const firstSymbol = result[0]
  const isSymbolInformation = firstSymbol && 'location' in firstSymbol

  if (isSymbolInformation) {
    // 委托给 workspace symbol formatter 处理 SymbolInformation[]
    return formatWorkspaceSymbolResult(result as SymbolInformation[], cwd)
  }

  // 处理 DocumentSymbol[] 格式（分层）
  const lines: string[] = ['文档符号：']

  for (const symbol of result as DocumentSymbol[]) {
    lines.push(...formatDocumentSymbolNode(symbol))
  }

  return lines.join('\n')
}

/**
 * 格式化 workspaceSymbol 结果（扁平符号列表）
 */
export function formatWorkspaceSymbolResult(
  result: SymbolInformation[] | null,
  cwd?: string,
): string {
  if (!result || result.length === 0) {
    return '工作区中未找到符号。这可能是因为工作区为空，或 LSP server 尚未完成项目索引。'
  }

  // 记录并过滤掉 location.uri 为 undefined 的符号
  const invalidSymbols = result.filter(
    sym => !sym || !sym.location || !sym.location.uri,
  )
  if (invalidSymbols.length > 0) {
    logForDebugging(
      `formatWorkspaceSymbolResult：过滤掉 ${invalidSymbols.length} 个无效符号 —— 这应在更早处被捕获`,
      { level: 'warn' },
    )
  }

  const validSymbols = result.filter(
    sym => sym && sym.location && sym.location.uri,
  )

  if (validSymbols.length === 0) {
    return '工作区中未找到符号。这可能是因为工作区为空，或 LSP server 尚未完成项目索引。'
  }

  const lines: string[] = [
    `在工作区中找到 ${validSymbols.length} 个${plural(validSymbols.length, 'symbol')}：`,
  ]

  // 按文件分组
  const byFile = groupByFile(validSymbols, cwd)

  for (const [filePath, symbols] of byFile) {
    lines.push(`\n${filePath}:`)
    for (const symbol of symbols) {
      const kind = symbolKindToString(symbol.kind)
      const line = symbol.location.range.start.line + 1
      let symbolLine = `  ${symbol.name} (${kind}) - 第 ${line} 行`

      // 若存在容器名则添加
      if (symbol.containerName) {
        symbolLine += ` 位于 ${symbol.containerName}`
      }

      lines.push(symbolLine)
    }
  }

  return lines.join('\n')
}

/**
 * 格式化 CallHierarchyItem 及其位置
 * 在格式化前校验 URI 以处理畸形的 LSP 数据
 */
function formatCallHierarchyItem(
  item: CallHierarchyItem,
  cwd?: string,
): string {
  // 校验 URI —— 优雅处理 undefined/null
  if (!item.uri) {
    logForDebugging(
      'formatCallHierarchyItem：CallHierarchyItem 的 URI 为 undefined',
      { level: 'warn' },
    )
    return `${item.name} (${symbolKindToString(item.kind)}) - <未知位置>`
  }

  const filePath = formatUri(item.uri, cwd)
  const line = item.range.start.line + 1
  const kind = symbolKindToString(item.kind)
  let result = `${item.name} (${kind}) - ${filePath}:${line}`
  if (item.detail) {
    result += ` [${item.detail}]`
  }
  return result
}

/**
 * 格式化 prepareCallHierarchy 结果
 * 返回给定位置处的调用层次项
 */
export function formatPrepareCallHierarchyResult(
  result: CallHierarchyItem[] | null,
  cwd?: string,
): string {
  if (!result || result.length === 0) {
    return '该位置未找到调用层次项'
  }

  if (result.length === 1) {
    return `调用层次项：${formatCallHierarchyItem(result[0]!, cwd)}`
  }

  const lines = [`找到 ${result.length} 个调用层次项：`]
  for (const item of result) {
    lines.push(`  ${formatCallHierarchyItem(item, cwd)}`)
  }
  return lines.join('\n')
}

/**
 * 格式化 incomingCalls 结果
 * 显示所有调用目标函数/方法的位置
 */
export function formatIncomingCallsResult(
  result: CallHierarchyIncomingCall[] | null,
  cwd?: string,
): string {
  if (!result || result.length === 0) {
    return '未找到传入调用（没有调用此函数的地方）'
  }

  const lines = [
    `找到 ${result.length} 处传入${plural(result.length, 'call')}：`,
  ]

  // 按文件分组
  const byFile = new Map<string, CallHierarchyIncomingCall[]>()
  for (const call of result) {
    if (!call.from) {
      logForDebugging(
        'formatIncomingCallsResult：CallHierarchyIncomingCall 的 from 字段为 undefined',
        { level: 'warn' },
      )
      continue
    }
    const filePath = formatUri(call.from.uri, cwd)
    const existing = byFile.get(filePath)
    if (existing) {
      existing.push(call)
    } else {
      byFile.set(filePath, [call])
    }
  }

  for (const [filePath, calls] of byFile) {
    lines.push(`\n${filePath}:`)
    for (const call of calls) {
      if (!call.from) {
        continue // 上面已记录
      }
      const kind = symbolKindToString(call.from.kind)
      const line = call.from.range.start.line + 1
      let callLine = `  ${call.from.name} (${kind}) - 第 ${line} 行`

      // 显示调用者内部的调用点
      if (call.fromRanges && call.fromRanges.length > 0) {
        const callSites = call.fromRanges
          .map(r => `${r.start.line + 1}:${r.start.character + 1}`)
          .join(', ')
        callLine += ` [调用位于：${callSites}]`
      }

      lines.push(callLine)
    }
  }

  return lines.join('\n')
}

/**
 * 格式化 outgoingCalls 结果
 * 显示目标所调用的所有函数/方法
 */
export function formatOutgoingCallsResult(
  result: CallHierarchyOutgoingCall[] | null,
  cwd?: string,
): string {
  if (!result || result.length === 0) {
    return '未找到传出调用（此函数不调用任何东西）'
  }

  const lines = [
    `找到 ${result.length} 处传出${plural(result.length, 'call')}：`,
  ]

  // 按文件分组
  const byFile = new Map<string, CallHierarchyOutgoingCall[]>()
  for (const call of result) {
    if (!call.to) {
      logForDebugging(
        'formatOutgoingCallsResult：CallHierarchyOutgoingCall 的 to 字段为 undefined',
        { level: 'warn' },
      )
      continue
    }
    const filePath = formatUri(call.to.uri, cwd)
    const existing = byFile.get(filePath)
    if (existing) {
      existing.push(call)
    } else {
      byFile.set(filePath, [call])
    }
  }

  for (const [filePath, calls] of byFile) {
    lines.push(`\n${filePath}:`)
    for (const call of calls) {
      if (!call.to) {
        continue // 上面已记录
      }
      const kind = symbolKindToString(call.to.kind)
      const line = call.to.range.start.line + 1
      let callLine = `  ${call.to.name} (${kind}) - 第 ${line} 行`

      // 显示当前函数内部的调用点
      if (call.fromRanges && call.fromRanges.length > 0) {
        const callSites = call.fromRanges
          .map(r => `${r.start.line + 1}:${r.start.character + 1}`)
          .join(', ')
        callLine += ` [调用自：${callSites}]`
      }

      lines.push(callLine)
    }
  }

  return lines.join('\n')
}
