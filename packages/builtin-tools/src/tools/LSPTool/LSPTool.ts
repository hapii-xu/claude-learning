import { open } from 'fs/promises'
import * as path from 'path'
import { pathToFileURL } from 'url'
import type {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  DocumentSymbol,
  Hover,
  Location,
  LocationLink,
  SymbolInformation,
} from 'vscode-languageserver-types'
import { z } from 'zod/v4'
import {
  getInitializationStatus,
  getLspServerManager,
  isLspConnected,
  waitForInitialization,
} from 'src/services/lsp/manager.js'
import type { ValidationResult } from 'src/Tool.js'
import { buildTool, type ToolDef } from 'src/Tool.js'
import { uniq } from 'src/utils/array.js'
import { getCwd } from 'src/utils/cwd.js'
import { logForDebugging } from 'src/utils/debug.js'
import { isENOENT, toError } from 'src/utils/errors.js'
import { execFileNoThrowWithCwd } from 'src/utils/execFileNoThrow.js'
import { getFsImplementation } from 'src/utils/fsOperations.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { logError } from 'src/utils/log.js'
import { expandPath } from 'src/utils/path.js'
import { checkReadPermissionForTool } from 'src/utils/permissions/filesystem.js'
import type { PermissionDecision } from 'src/utils/permissions/PermissionResult.js'
import {
  formatDocumentSymbolResult,
  formatFindReferencesResult,
  formatGoToDefinitionResult,
  formatHoverResult,
  formatIncomingCallsResult,
  formatOutgoingCallsResult,
  formatPrepareCallHierarchyResult,
  formatWorkspaceSymbolResult,
} from './formatters.js'
import { DESCRIPTION, LSP_TOOL_NAME } from './prompt.js'
import { lspToolInputSchema } from './schemas.js'
import {
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  userFacingName,
} from './UI.js'

const MAX_LSP_FILE_SIZE_BYTES = 10_000_000

/**
 * 与工具兼容的输入 schema（普通 ZodObject，而非可辨识联合）
 * 我们在 validateInput 中针对可辨识联合做校验，以获得更好的错误信息
 */
const inputSchema = lazySchema(() =>
  z.strictObject({
    operation: z
      .enum([
        'goToDefinition',
        'findReferences',
        'hover',
        'documentSymbol',
        'workspaceSymbol',
        'goToImplementation',
        'prepareCallHierarchy',
        'incomingCalls',
        'outgoingCalls',
      ])
      .describe('要执行的 LSP 操作'),
    filePath: z.string().describe('文件的绝对或相对路径'),
    line: z
      .number()
      .int()
      .positive()
      .describe('行号（从 1 开始，与编辑器一致）'),
    character: z
      .number()
      .int()
      .positive()
      .describe('字符偏移（从 1 开始，与编辑器一致）'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    operation: z
      .enum([
        'goToDefinition',
        'findReferences',
        'hover',
        'documentSymbol',
        'workspaceSymbol',
        'goToImplementation',
        'prepareCallHierarchy',
        'incomingCalls',
        'outgoingCalls',
      ])
      .describe('执行的 LSP 操作'),
    result: z.string().describe('LSP 操作格式化后的结果'),
    filePath: z
      .string()
      .describe('执行该操作所针对的文件路径'),
    resultCount: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('结果数量（定义、引用、符号）'),
    fileCount: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('包含结果的文件数量'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>
export type Input = z.infer<InputSchema>

export const LSPTool = buildTool({
  name: LSP_TOOL_NAME,
  searchHint: '代码智能（定义、引用、符号、悬停）',
  maxResultSizeChars: 100_000,
  isLsp: true,
  async description() {
    return DESCRIPTION
  },
  userFacingName,
  shouldDefer: true,
  isEnabled() {
    return isLspConnected()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  getPath({ filePath }): string {
    return expandPath(filePath)
  },
  async validateInput(input: Input): Promise<ValidationResult> {
    // 先针对可辨识联合做校验，以获得更好的类型安全
    const parseResult = lspToolInputSchema().safeParse(input)
    if (!parseResult.success) {
      return {
        result: false,
        message: `无效输入：${parseResult.error.message}`,
        errorCode: 3,
      }
    }

    // 校验文件存在且为常规文件
    const fs = getFsImplementation()
    const absolutePath = expandPath(input.filePath)

    // 安全：跳过对 UNC 路径的文件系统操作，以防 NTLM 凭据泄露。
    if (absolutePath.startsWith('\\\\') || absolutePath.startsWith('//')) {
      return { result: true }
    }

    let stats
    try {
      stats = await fs.stat(absolutePath)
    } catch (error) {
      if (isENOENT(error)) {
        return {
          result: false,
          message: `文件不存在：${input.filePath}`,
          errorCode: 1,
        }
      }
      const err = toError(error)
      // 记录文件系统访问错误以便追踪
      logError(
        new Error(
          `对 ${input.filePath} 执行 LSP 操作时访问文件 stat 失败：${err.message}`,
        ),
      )
      return {
        result: false,
        message: `无法访问文件：${input.filePath}。${err.message}`,
        errorCode: 4,
      }
    }

    if (!stats.isFile()) {
      return {
        result: false,
        message: `路径不是文件：${input.filePath}`,
        errorCode: 2,
      }
    }

    return { result: true }
  },
  async checkPermissions(input, context): Promise<PermissionDecision> {
    const appState = context.getAppState()
    return checkReadPermissionForTool(
      LSPTool,
      input,
      appState.toolPermissionContext,
    )
  },
  async prompt() {
    return DESCRIPTION
  },
  renderToolUseMessage,
  renderToolUseErrorMessage,
  renderToolResultMessage,
  async call(input: Input, _context) {
    const absolutePath = expandPath(input.filePath)
    const cwd = getCwd()

    // 如果仍在初始化则等待其完成
    // 避免在初始化完成前就返回 "no server available"
    const status = getInitializationStatus()
    if (status.status === 'pending') {
      await waitForInitialization()
    }

    // 获取 LSP server manager
    const manager = getLspServerManager()
    if (!manager) {
      // 记录此系统级失败以便追踪
      logError(
        new Error('调用工具时 LSP server manager 尚未初始化'),
      )

      const output: Output = {
        operation: input.operation,
        result:
          'LSP server manager 未初始化。这可能表明存在启动问题。',
        filePath: input.filePath,
      }
      return {
        data: output,
      }
    }

    // 将操作映射为 LSP 方法并准备参数
    const { method, params } = getMethodAndParams(input, absolutePath)

    try {
      // 在发起请求前确保文件已在 LSP server 中打开
      // 大多数 LSP server 要求先 textDocument/didOpen 再做其他操作
      // 仅当文件尚未打开时才读取，以避免不必要的 I/O
      if (!manager.isFileOpen(absolutePath)) {
        const handle = await open(absolutePath, 'r')
        try {
          const stats = await handle.stat()
          if (stats.size > MAX_LSP_FILE_SIZE_BYTES) {
            const output: Output = {
              operation: input.operation,
              result: `文件过大，无法进行 LSP 分析（${Math.ceil(stats.size / 1_000_000)}MB 超过 10MB 上限）`,
              filePath: input.filePath,
            }
            return { data: output }
          }
          const fileContent = await handle.readFile({ encoding: 'utf-8' })
          await manager.openFile(absolutePath, fileContent)
        } finally {
          await handle.close()
        }
      }

      // 向 LSP server 发送请求
      let result = await manager.sendRequest(absolutePath, method, params)

      if (result === undefined) {
        // 出于诊断目的记录 —— 帮助追踪使用模式和潜在 bug
        logForDebugging(
          `文件类型 ${path.extname(absolutePath)} 没有可用的 LSP server，无法对文件 ${input.filePath} 执行操作 ${input.operation}`,
        )

        const output: Output = {
          operation: input.operation,
          result: `该文件类型没有可用的 LSP server：${path.extname(absolutePath)}`,
          filePath: input.filePath,
        }
        return {
          data: output,
        }
      }

      // 对于 incomingCalls 和 outgoingCalls，需要两步流程：
      // 1. 先通过 prepareCallHierarchy 获取 CallHierarchyItem
      // 2. 然后用该 item 请求实际的 calls
      if (
        input.operation === 'incomingCalls' ||
        input.operation === 'outgoingCalls'
      ) {
        const callItems = result as CallHierarchyItem[]
        if (!callItems || callItems.length === 0) {
          const output: Output = {
            operation: input.operation,
            result: '该位置未找到调用层次项',
            filePath: input.filePath,
            resultCount: 0,
            fileCount: 0,
          }
          return { data: output }
        }

        // 使用第一个调用层次项请求 calls
        const callMethod =
          input.operation === 'incomingCalls'
            ? 'callHierarchy/incomingCalls'
            : 'callHierarchy/outgoingCalls'

        result = await manager.sendRequest(absolutePath, callMethod, {
          item: callItems[0],
        })

        if (result === undefined) {
          logForDebugging(
            `LSP server 对 ${input.filePath} 的 ${callMethod} 返回 undefined`,
          )
          // 继续进入 formatter，它会优雅处理 empty/null
        }
      }

      // 从基于位置的结果中过滤掉 gitignored 文件
      if (
        result &&
        Array.isArray(result) &&
        (input.operation === 'findReferences' ||
          input.operation === 'goToDefinition' ||
          input.operation === 'goToImplementation' ||
          input.operation === 'workspaceSymbol')
      ) {
        if (input.operation === 'workspaceSymbol') {
          // SymbolInformation 有 location.uri —— 通过提取位置来过滤
          const symbols = result as SymbolInformation[]
          const locations = symbols
            .filter(s => s?.location?.uri)
            .map(s => s.location)
          const filteredLocations = await filterGitIgnoredLocations(
            locations,
            cwd,
          )
          const filteredUris = new Set(filteredLocations.map(l => l.uri))
          result = symbols.filter(
            s => !s?.location?.uri || filteredUris.has(s.location.uri),
          )
        } else {
          // Location[] 或 (Location | LocationLink)[]
          const locations = (result as (Location | LocationLink)[]).map(
            toLocation,
          )
          const filteredLocations = await filterGitIgnoredLocations(
            locations,
            cwd,
          )
          const filteredUris = new Set(filteredLocations.map(l => l.uri))
          result = (result as (Location | LocationLink)[]).filter(item => {
            const loc = toLocation(item)
            return !loc.uri || filteredUris.has(loc.uri)
          })
        }
      }

      // 根据操作类型格式化结果
      const { formatted, resultCount, fileCount } = formatResult(
        input.operation,
        result,
        cwd,
      )

      const output: Output = {
        operation: input.operation,
        result: formatted,
        filePath: input.filePath,
        resultCount,
        fileCount,
      }

      return {
        data: output,
      }
    } catch (error) {
      const err = toError(error)
      const errorMessage = err.message

      // 记录错误以便追踪
      logError(
        new Error(
          `对 ${input.filePath} 执行 ${input.operation} 的 LSP 工具请求失败：${errorMessage}`,
        ),
      )

      const output: Output = {
        operation: input.operation,
        result: `执行 ${input.operation} 时出错：${errorMessage}`,
        filePath: input.filePath,
      }
      return {
        data: output,
      }
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: output.result,
    }
  },
} satisfies ToolDef<InputSchema, Output>)

/**
 * 将 LSPTool 操作映射为 LSP 方法和参数
 */
function getMethodAndParams(
  input: Input,
  absolutePath: string,
): { method: string; params: unknown } {
  const uri = pathToFileURL(absolutePath).href
  // 从 1-based（用户友好）转为 0-based（LSP 协议）
  const position = {
    line: input.line - 1,
    character: input.character - 1,
  }

  switch (input.operation) {
    case 'goToDefinition':
      return {
        method: 'textDocument/definition',
        params: {
          textDocument: { uri },
          position,
        },
      }
    case 'findReferences':
      return {
        method: 'textDocument/references',
        params: {
          textDocument: { uri },
          position,
          context: { includeDeclaration: true },
        },
      }
    case 'hover':
      return {
        method: 'textDocument/hover',
        params: {
          textDocument: { uri },
          position,
        },
      }
    case 'documentSymbol':
      return {
        method: 'textDocument/documentSymbol',
        params: {
          textDocument: { uri },
        },
      }
    case 'workspaceSymbol':
      return {
        method: 'workspace/symbol',
        params: {
          query: '', // 空查询返回所有符号
        },
      }
    case 'goToImplementation':
      return {
        method: 'textDocument/implementation',
        params: {
          textDocument: { uri },
          position,
        },
      }
    case 'prepareCallHierarchy':
      return {
        method: 'textDocument/prepareCallHierarchy',
        params: {
          textDocument: { uri },
          position,
        },
      }
    case 'incomingCalls':
      // 对于 incoming/outgoing calls，先要 prepare 调用层次
      // LSP server 会返回 CallHierarchyItem，我们再将其传给 calls 请求
      return {
        method: 'textDocument/prepareCallHierarchy',
        params: {
          textDocument: { uri },
          position,
        },
      }
    case 'outgoingCalls':
      return {
        method: 'textDocument/prepareCallHierarchy',
        params: {
          textDocument: { uri },
          position,
        },
      }
  }
}

/**
 * 统计包含嵌套子项在内的符号总数
 */
function countSymbols(symbols: DocumentSymbol[]): number {
  let count = symbols.length
  for (const symbol of symbols) {
    if (symbol.children && symbol.children.length > 0) {
      count += countSymbols(symbol.children)
    }
  }
  return count
}

/**
 * 统计位置数组中的唯一文件数
 */
function countUniqueFiles(locations: Location[]): number {
  return new Set(locations.map(loc => loc.uri)).size
}

/**
 * 从 file:// URI 中提取文件路径，解码百分号编码字符。
 */
function uriToFilePath(uri: string): string {
  let filePath = uri.replace(/^file:\/\//, '')
  // 在 Windows 上，file:///C:/path 会变成 /C:/path —— 去掉前导斜杠
  if (/^\/[A-Za-z]:/.test(filePath)) {
    filePath = filePath.slice(1)
  }
  try {
    filePath = decodeURIComponent(filePath)
  } catch {
    // 若格式不正确，使用未解码的路径
  }
  return filePath
}

/**
 * 过滤掉文件路径被 gitignored 的位置。
 * 使用 `git check-ignore` 以批量路径参数方式高效执行。
 */
async function filterGitIgnoredLocations<T extends Location>(
  locations: T[],
  cwd: string,
): Promise<T[]> {
  if (locations.length === 0) {
    return locations
  }

  // 从 URI 中收集唯一文件路径
  const uriToPath = new Map<string, string>()
  for (const loc of locations) {
    if (loc.uri && !uriToPath.has(loc.uri)) {
      uriToPath.set(loc.uri, uriToFilePath(loc.uri))
    }
  }

  const uniquePaths = uniq(uriToPath.values())
  if (uniquePaths.length === 0) {
    return locations
  }

  // 用 git check-ignore 批量检查路径
  // 退出码 0 = 至少一个路径被忽略，1 = 均未忽略，128 = 非 git 仓库
  const ignoredPaths = new Set<string>()
  const BATCH_SIZE = 50
  for (let i = 0; i < uniquePaths.length; i += BATCH_SIZE) {
    const batch = uniquePaths.slice(i, i + BATCH_SIZE)
    const result = await execFileNoThrowWithCwd(
      'git',
      ['check-ignore', ...batch],
      {
        cwd,
        preserveOutputOnError: false,
        timeout: 5_000,
      },
    )

    if (result.code === 0 && result.stdout) {
      for (const line of result.stdout.split('\n')) {
        const trimmed = line.trim()
        if (trimmed) {
          ignoredPaths.add(trimmed)
        }
      }
    }
  }

  if (ignoredPaths.size === 0) {
    return locations
  }

  return locations.filter(loc => {
    const filePath = uriToPath.get(loc.uri)
    return !filePath || !ignoredPaths.has(filePath)
  })
}

/**
 * 检查 item 是 LocationLink（有 targetUri）还是 Location（有 uri）
 */
function isLocationLink(item: Location | LocationLink): item is LocationLink {
  return 'targetUri' in item
}

/**
 * 将 LocationLink 转为 Location 格式，以便统一处理
 */
function toLocation(item: Location | LocationLink): Location {
  if (isLocationLink(item)) {
    return {
      uri: item.targetUri,
      range: item.targetSelectionRange || item.targetRange,
    }
  }
  return item
}

/**
 * 根据操作类型格式化 LSP 结果，并提取摘要计数
 */
function formatResult(
  operation: Input['operation'],
  result: unknown,
  cwd: string,
): { formatted: string; resultCount: number; fileCount: number } {
  switch (operation) {
    case 'goToDefinition': {
      // 同时处理 Location 和 LocationLink 格式
      const rawResults = Array.isArray(result)
        ? result
        : result
          ? [result as Location | LocationLink]
          : []

      // 将 LocationLink 转为 Location 以便统一处理
      const locations = rawResults.map(toLocation)

      // 记录并过滤掉 uri 为 undefined 的位置
      const invalidLocations = locations.filter(loc => !loc || !loc.uri)
      if (invalidLocations.length > 0) {
        logError(
          new Error(
            `LSP server 对 ${cwd} 的 goToDefinition 返回了 ${invalidLocations.length} 个 URI 为 undefined 的位置。` +
              `这表明 LSP server 返回了畸形数据。`,
          ),
        )
      }

      const validLocations = locations.filter(loc => loc && loc.uri)
      return {
        formatted: formatGoToDefinitionResult(
          result as
            | Location
            | Location[]
            | LocationLink
            | LocationLink[]
            | null,
          cwd,
        ),
        resultCount: validLocations.length,
        fileCount: countUniqueFiles(validLocations),
      }
    }
    case 'findReferences': {
      const locations = (result as Location[]) || []

      // 记录并过滤掉 uri 为 undefined 的位置
      const invalidLocations = locations.filter(loc => !loc || !loc.uri)
      if (invalidLocations.length > 0) {
        logError(
          new Error(
            `LSP server 对 ${cwd} 的 findReferences 返回了 ${invalidLocations.length} 个 URI 为 undefined 的位置。` +
              `这表明 LSP server 返回了畸形数据。`,
          ),
        )
      }

      const validLocations = locations.filter(loc => loc && loc.uri)
      return {
        formatted: formatFindReferencesResult(result as Location[] | null, cwd),
        resultCount: validLocations.length,
        fileCount: countUniqueFiles(validLocations),
      }
    }
    case 'hover': {
      return {
        formatted: formatHoverResult(result as Hover | null, cwd),
        resultCount: result ? 1 : 0,
        fileCount: result ? 1 : 0,
      }
    }
    case 'documentSymbol': {
      // LSP 允许 documentSymbol 返回 DocumentSymbol[] 或 SymbolInformation[]
      const symbols = (result as (DocumentSymbol | SymbolInformation)[]) || []
      // 检测格式：DocumentSymbol 有 'range'，SymbolInformation 有 'location'
      const isDocumentSymbol =
        symbols.length > 0 && symbols[0] && 'range' in symbols[0]
      // 统计符号 —— DocumentSymbol 可能有嵌套子项，SymbolInformation 是扁平的
      const count = isDocumentSymbol
        ? countSymbols(symbols as DocumentSymbol[])
        : symbols.length
      return {
        formatted: formatDocumentSymbolResult(
          result as (DocumentSymbol[] | SymbolInformation[]) | null,
          cwd,
        ),
        resultCount: count,
        fileCount: symbols.length > 0 ? 1 : 0,
      }
    }
    case 'workspaceSymbol': {
      const symbols = (result as SymbolInformation[]) || []

      // 记录并过滤掉 location.uri 为 undefined 的符号
      const invalidSymbols = symbols.filter(
        sym => !sym || !sym.location || !sym.location.uri,
      )
      if (invalidSymbols.length > 0) {
        logError(
          new Error(
            `LSP server 对 ${cwd} 的 workspaceSymbol 返回了 ${invalidSymbols.length} 个 location URI 为 undefined 的符号。` +
              `这表明 LSP server 返回了畸形数据。`,
          ),
        )
      }

      const validSymbols = symbols.filter(
        sym => sym && sym.location && sym.location.uri,
      )
      const locations = validSymbols.map(s => s.location)
      return {
        formatted: formatWorkspaceSymbolResult(
          result as SymbolInformation[] | null,
          cwd,
        ),
        resultCount: validSymbols.length,
        fileCount: countUniqueFiles(locations),
      }
    }
    case 'goToImplementation': {
      // 同时处理 Location 和 LocationLink 格式（与 goToDefinition 相同）
      const rawResults = Array.isArray(result)
        ? result
        : result
          ? [result as Location | LocationLink]
          : []

      // 将 LocationLink 转为 Location 以便统一处理
      const locations = rawResults.map(toLocation)

      // 记录并过滤掉 uri 为 undefined 的位置
      const invalidLocations = locations.filter(loc => !loc || !loc.uri)
      if (invalidLocations.length > 0) {
        logError(
          new Error(
            `LSP server 对 ${cwd} 的 goToImplementation 返回了 ${invalidLocations.length} 个 URI 为 undefined 的位置。` +
              `这表明 LSP server 返回了畸形数据。`,
          ),
        )
      }

      const validLocations = locations.filter(loc => loc && loc.uri)
      return {
        // 复用 goToDefinition 的 formatter，因为结果格式完全一致
        formatted: formatGoToDefinitionResult(
          result as
            | Location
            | Location[]
            | LocationLink
            | LocationLink[]
            | null,
          cwd,
        ),
        resultCount: validLocations.length,
        fileCount: countUniqueFiles(validLocations),
      }
    }
    case 'prepareCallHierarchy': {
      const items = (result as CallHierarchyItem[]) || []
      return {
        formatted: formatPrepareCallHierarchyResult(
          result as CallHierarchyItem[] | null,
          cwd,
        ),
        resultCount: items.length,
        fileCount: items.length > 0 ? countUniqueFilesFromCallItems(items) : 0,
      }
    }
    case 'incomingCalls': {
      const calls = (result as CallHierarchyIncomingCall[]) || []
      return {
        formatted: formatIncomingCallsResult(
          result as CallHierarchyIncomingCall[] | null,
          cwd,
        ),
        resultCount: calls.length,
        fileCount:
          calls.length > 0 ? countUniqueFilesFromIncomingCalls(calls) : 0,
      }
    }
    case 'outgoingCalls': {
      const calls = (result as CallHierarchyOutgoingCall[]) || []
      return {
        formatted: formatOutgoingCallsResult(
          result as CallHierarchyOutgoingCall[] | null,
          cwd,
        ),
        resultCount: calls.length,
        fileCount:
          calls.length > 0 ? countUniqueFilesFromOutgoingCalls(calls) : 0,
      }
    }
  }
}

/**
 * 统计 CallHierarchyItem 数组中的唯一文件数
 * 过滤掉 URI 为 undefined 的项
 */
function countUniqueFilesFromCallItems(items: CallHierarchyItem[]): number {
  const validUris = items.map(item => item.uri).filter(uri => uri)
  return new Set(validUris).size
}

/**
 * 统计 CallHierarchyIncomingCall 数组中的唯一文件数
 * 过滤掉 URI 为 undefined 的 calls
 */
function countUniqueFilesFromIncomingCalls(
  calls: CallHierarchyIncomingCall[],
): number {
  const validUris = calls.map(call => call.from?.uri).filter(uri => uri)
  return new Set(validUris).size
}

/**
 * 统计 CallHierarchyOutgoingCall 数组中的唯一文件数
 * 过滤掉 URI 为 undefined 的 calls
 */
function countUniqueFilesFromOutgoingCalls(
  calls: CallHierarchyOutgoingCall[],
): number {
  const validUris = calls.map(call => call.to?.uri).filter(uri => uri)
  return new Set(validUris).size
}
