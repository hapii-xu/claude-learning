import figures from 'figures'
import { logError } from 'src/utils/log.js'
import { callIdeRpc } from '../services/mcp/client.js'
import type { MCPServerConnection } from '../services/mcp/types.js'
import { ClaudeError } from '../utils/errors.js'
import { normalizePathForComparison, pathsEqual } from '../utils/file.js'
import { getConnectedIdeClient } from '../utils/ide.js'
import { jsonParse } from '../utils/slowOperations.js'

class DiagnosticsTrackingError extends ClaudeError {}

const MAX_DIAGNOSTICS_SUMMARY_CHARS = 4000

export interface Diagnostic {
  message: string
  severity: 'Error' | 'Warning' | 'Info' | 'Hint'
  range: {
    start: { line: number; character: number }
    end: { line: number; character: number }
  }
  source?: string
  code?: string
}

export interface DiagnosticFile {
  uri: string
  diagnostics: Diagnostic[]
}

export class DiagnosticTrackingService {
  private static instance: DiagnosticTrackingService | undefined
  private baseline: Map<string, Diagnostic[]> = new Map()

  private initialized = false
  private mcpClient: MCPServerConnection | undefined

  // 跟踪文件上次被处理/获取的时间
  private lastProcessedTimestamps: Map<string, number> = new Map()

  // 跟踪哪些文件已接收到右侧文件诊断信息以及它们是否发生变化
  // Map<规范化路径, 上次 claudeFsRight 的诊断信息>
  private rightFileDiagnosticsState: Map<string, Diagnostic[]> = new Map()

  static getInstance(): DiagnosticTrackingService {
    if (!DiagnosticTrackingService.instance) {
      DiagnosticTrackingService.instance = new DiagnosticTrackingService()
    }
    return DiagnosticTrackingService.instance
  }

  initialize(mcpClient: MCPServerConnection) {
    if (this.initialized) {
      return
    }

    // TODO: 不要缓存已连接的 mcpClient，因为它可能会变化。
    this.mcpClient = mcpClient
    this.initialized = true
  }

  async shutdown(): Promise<void> {
    this.initialized = false
    this.baseline.clear()
    this.rightFileDiagnosticsState.clear()
    this.lastProcessedTimestamps.clear()
  }

  /**
   * 重置跟踪状态但保持服务已初始化。
   * 这会清除所有被跟踪的文件和诊断信息。
   */
  reset() {
    this.baseline.clear()
    this.rightFileDiagnosticsState.clear()
    this.lastProcessedTimestamps.clear()
  }

  private normalizeFileUri(fileUri: string): string {
    // 移除我们的协议前缀
    const protocolPrefixes = [
      'file://',
      '_claude_fs_right:',
      '_claude_fs_left:',
    ]

    let normalized = fileUri
    for (const prefix of protocolPrefixes) {
      if (fileUri.startsWith(prefix)) {
        normalized = fileUri.slice(prefix.length)
        break
      }
    }

    // 使用共享工具进行平台感知的路径规范化
    // （处理 Windows 大小写不敏感和路径分隔符）
    return normalizePathForComparison(normalized)
  }

  /**
   * 确保文件在处理前已在 IDE 中打开。
   * 这对诊断等语言服务正常工作很重要。
   */
  async ensureFileOpened(fileUri: string): Promise<void> {
    if (
      !this.initialized ||
      !this.mcpClient ||
      this.mcpClient.type !== 'connected'
    ) {
      return
    }

    try {
      // 调用 openFile 工具以确保文件已加载
      await callIdeRpc(
        'openFile',
        {
          filePath: fileUri,
          preview: false,
          startText: '',
          endText: '',
          selectToEndOfLine: false,
          makeFrontmost: false,
        },
        this.mcpClient,
      )
    } catch (error) {
      logError(error as Error)
    }
  }

  /**
   * 在编辑前捕获特定文件的基线诊断信息。
   * 这在编辑文件之前调用，以确保我们有一个用于比较的基线。
   */
  async beforeFileEdited(filePath: string): Promise<void> {
    if (
      !this.initialized ||
      !this.mcpClient ||
      this.mcpClient.type !== 'connected'
    ) {
      return
    }

    const timestamp = Date.now()

    try {
      const result = await callIdeRpc(
        'getDiagnostics',
        { uri: `file://${filePath}` },
        this.mcpClient,
      )
      const diagnosticFile = this.parseDiagnosticResult(result)[0]
      if (diagnosticFile) {
        // 比较规范化路径（处理协议前缀和 Windows 大小写不敏感）
        if (
          !pathsEqual(
            this.normalizeFileUri(filePath),
            this.normalizeFileUri(diagnosticFile.uri),
          )
        ) {
          logError(
            new DiagnosticsTrackingError(
              `Diagnostics file path mismatch: expected ${filePath}, got ${diagnosticFile.uri})`,
            ),
          )
          return
        }

        // 使用规范化路径键存储，以在 Windows 上保持一致的查找
        const normalizedPath = this.normalizeFileUri(filePath)
        this.baseline.set(normalizedPath, diagnosticFile.diagnostics)
        this.lastProcessedTimestamps.set(normalizedPath, timestamp)
      } else {
        // 没有返回诊断文件，存储空基线
        const normalizedPath = this.normalizeFileUri(filePath)
        this.baseline.set(normalizedPath, [])
        this.lastProcessedTimestamps.set(normalizedPath, timestamp)
      }
    } catch (_error) {
      // 如果 IDE 不支持诊断，静默失败
    }
  }

  /**
   * 从 file://、_claude_fs_right 和 _claude_fs_ URI 获取基线中没有的新诊断。
   * 仅处理已编辑的文件的诊断。
   */
  async getNewDiagnostics(): Promise<DiagnosticFile[]> {
    if (
      !this.initialized ||
      !this.mcpClient ||
      this.mcpClient.type !== 'connected'
    ) {
      return []
    }

    // 检查是否有任何文件存在诊断变更
    let allDiagnosticFiles: DiagnosticFile[] = []
    try {
      const result = await callIdeRpc(
        'getDiagnostics',
        {}, // 空参数获取所有诊断
        this.mcpClient,
      )
      allDiagnosticFiles = this.parseDiagnosticResult(result)
    } catch (_error) {
      // 如果获取所有诊断失败，返回空
      return []
    }
    const diagnosticsForFileUrisWithBaselines = allDiagnosticFiles
      .filter(file => this.baseline.has(this.normalizeFileUri(file.uri)))
      .filter(file => file.uri.startsWith('file://'))

    const diagnosticsForClaudeFsRightUrisWithBaselinesMap = new Map<
      string,
      DiagnosticFile
    >()
    allDiagnosticFiles
      .filter(file => this.baseline.has(this.normalizeFileUri(file.uri)))
      .filter(file => file.uri.startsWith('_claude_fs_right:'))
      .forEach(file => {
        diagnosticsForClaudeFsRightUrisWithBaselinesMap.set(
          this.normalizeFileUri(file.uri),
          file,
        )
      })

    const newDiagnosticFiles: DiagnosticFile[] = []

    // 处理 file:// 协议的诊断
    for (const file of diagnosticsForFileUrisWithBaselines) {
      const normalizedPath = this.normalizeFileUri(file.uri)
      const baselineDiagnostics = this.baseline.get(normalizedPath) || []

      // 如果存在，获取 _claude_fs_right 文件
      const claudeFsRightFile =
        diagnosticsForClaudeFsRightUrisWithBaselinesMap.get(normalizedPath)

      // 根据右侧文件诊断的状态决定使用哪个文件
      let fileToUse = file

      if (claudeFsRightFile) {
        const previousRightDiagnostics =
          this.rightFileDiagnosticsState.get(normalizedPath)

        // 使用 _claude_fs_right 如果：
        // 1. 此文件从未获取过右侧文件诊断（previousRightDiagnostics === undefined）
        // 2. 或者右侧文件诊断刚发生变化
        if (
          !previousRightDiagnostics ||
          !this.areDiagnosticArraysEqual(
            previousRightDiagnostics,
            claudeFsRightFile.diagnostics,
          )
        ) {
          fileToUse = claudeFsRightFile
        }

        // 更新对右侧文件诊断的跟踪
        this.rightFileDiagnosticsState.set(
          normalizedPath,
          claudeFsRightFile.diagnostics,
        )
      }

      // 查找基线中没有的新诊断
      const newDiagnostics = fileToUse.diagnostics.filter(
        d => !baselineDiagnostics.some(b => this.areDiagnosticsEqual(d, b)),
      )

      if (newDiagnostics.length > 0) {
        newDiagnosticFiles.push({
          uri: file.uri,
          diagnostics: newDiagnostics,
        })
      }

      // 用当前诊断更新基线
      this.baseline.set(normalizedPath, fileToUse.diagnostics)
    }

    return newDiagnosticFiles
  }

  private parseDiagnosticResult(result: unknown): DiagnosticFile[] {
    if (Array.isArray(result)) {
      const textBlock = result.find(block => block.type === 'text')
      if (textBlock && 'text' in textBlock) {
        const parsed = jsonParse(textBlock.text)
        return parsed
      }
    }
    return []
  }

  private areDiagnosticsEqual(a: Diagnostic, b: Diagnostic): boolean {
    return (
      a.message === b.message &&
      a.severity === b.severity &&
      a.source === b.source &&
      a.code === b.code &&
      a.range.start.line === b.range.start.line &&
      a.range.start.character === b.range.start.character &&
      a.range.end.line === b.range.end.line &&
      a.range.end.character === b.range.end.character
    )
  }

  private areDiagnosticArraysEqual(a: Diagnostic[], b: Diagnostic[]): boolean {
    if (a.length !== b.length) return false

    // 检查 'a' 中的每个诊断是否都存在于 'b' 中
    return (
      a.every(diagA =>
        b.some(diagB => this.areDiagnosticsEqual(diagA, diagB)),
      ) &&
      b.every(diagB => a.some(diagA => this.areDiagnosticsEqual(diagA, diagB)))
    )
  }

  /**
   * 处理新查询的开始。此方法：
   * - 如果尚未初始化，初始化诊断跟踪器
   * - 如果已初始化（用于新的查询循环），重置跟踪器
   * - 自动从提供的客户端列表中查找 IDE 客户端
   *
   * @param clients 可能包含 IDE 客户端的 MCP 客户端数组
   * @param shouldQuery 是否实际在进行查询（不只是是一个命令）
   */
  async handleQueryStart(clients: MCPServerConnection[]): Promise<void> {
    // 仅在应查询且有客户端时继续
    if (!this.initialized) {
      // 查找已连接的 IDE 客户端
      const connectedIdeClient = getConnectedIdeClient(clients)

      if (connectedIdeClient) {
        this.initialize(connectedIdeClient)
      }
    } else {
      // 为新的查询循环重置诊断跟踪
      this.reset()
    }
  }

  /**
   * 将诊断格式化为人类可读的摘要字符串。
   * 这对于在消息或日志中显示诊断很有用。
   *
   * @param files 要格式化的诊断文件数组
   * @returns 诊断的格式化字符串表示
   */
  static formatDiagnosticsSummary(files: DiagnosticFile[]): string {
    const truncationMarker = '…[truncated]'
    const result = files
      .map(file => {
        const filename = file.uri.split('/').pop() || file.uri
        const diagnostics = file.diagnostics
          .map(d => {
            const severitySymbol = DiagnosticTrackingService.getSeveritySymbol(
              d.severity,
            )

            return `  ${severitySymbol} [Line ${d.range.start.line + 1}:${d.range.start.character + 1}] ${d.message}${d.code ? ` [${d.code}]` : ''}${d.source ? ` (${d.source})` : ''}`
          })
          .join('\n')

        return `${filename}:\n${diagnostics}`
      })
      .join('\n\n')

    if (result.length > MAX_DIAGNOSTICS_SUMMARY_CHARS) {
      return (
        result.slice(
          0,
          MAX_DIAGNOSTICS_SUMMARY_CHARS - truncationMarker.length,
        ) + truncationMarker
      )
    }
    return result
  }

  /**
   * 获取诊断的严重性符号
   */
  static getSeveritySymbol(severity: Diagnostic['severity']): string {
    return (
      {
        Error: figures.cross,
        Warning: figures.warning,
        Info: figures.info,
        Hint: figures.star,
      }[severity] || figures.bullet
    )
  }
}

export const diagnosticTracker = DiagnosticTrackingService.getInstance()
