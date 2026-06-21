import { feature } from 'bun:bundle'
import type { UUID } from 'crypto'
import { findToolByName, type Tools } from '../Tool.js'
import { extractBashCommentLabel } from '@claude-code-best/builtin-tools/tools/BashTool/commentLabel.js'
import { BASH_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/BashTool/toolName.js'
import { FILE_EDIT_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/FileWriteTool/prompt.js'
import { REPL_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/REPLTool/constants.js'
import { getReplPrimitiveTools } from '@claude-code-best/builtin-tools/tools/REPLTool/primitiveTools.js'
import {
  type BranchAction,
  type CommitKind,
  detectGitOperation,
  type PrAction,
} from '@claude-code-best/builtin-tools/tools/shared/gitOperationTracking.js'
import { SEARCH_EXTRA_TOOLS_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/SearchExtraToolsTool/prompt.js'
import type {
  CollapsedReadSearchGroup,
  CollapsibleMessage,
  ContentItem,
  MessageContent,
  RenderableMessage,
  StopHookInfo,
  SystemStopHookSummaryMessage,
} from '../types/message.js'

/**
 * 安全地获取 MessageContent 值中的第一个内容项。
 * 对于字符串内容或空数组返回 undefined。
 */
function getFirstContentItem(
  content: MessageContent | undefined,
): ContentItem | undefined {
  if (!content || typeof content === 'string') return undefined
  return content[0]
}

/**
 * 遍历内容项（仅对象，不包括字符串）。
 * 对于字符串内容返回空数组。
 */
function getContentItems(content: MessageContent | undefined): ContentItem[] {
  if (!content || typeof content === 'string') return []
  return content
}
import { getDisplayPath } from './file.js'
import { isFullscreenEnvEnabled } from './fullscreen.js'
import {
  isAutoManagedMemoryFile,
  isAutoManagedMemoryPattern,
  isMemoryDirectory,
  isShellCommandTargetingMemory,
} from './memoryFileDetection.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const teamMemOps = feature('TEAMMEM')
  ? (require('./teamMemoryOps.js') as typeof import('./teamMemoryOps.js'))
  : null
const SNIP_TOOL_NAME = feature('HISTORY_SNIP')
  ? (
      require('@claude-code-best/builtin-tools/tools/SnipTool/prompt.js') as typeof import('@claude-code-best/builtin-tools/tools/SnipTool/prompt.js')
    ).SNIP_TOOL_NAME
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * 检查工具调用是否为搜索或读取操作的结果。
 */
export type SearchOrReadResult = {
  isCollapsible: boolean
  isSearch: boolean
  isRead: boolean
  isList: boolean
  isREPL: boolean
  /** 如果这是对 memory 文件的 Write/Edit 操作则为 true */
  isMemoryWrite: boolean
  /**
   * 对于应被折叠组吸收且不增加任何计数的元操作
   * （Snip、SearchExtraTools）为 true。在详细模式下
   * 仍可通过 groupMessages 迭代看到它们。
   */
  isAbsorbedSilently: boolean
  /** 如果是 MCP 工具，则为 MCP 服务器名称 */
  mcpServerName?: string
  /** 不是搜索/读取的 Bash 命令（在全屏模式下） */
  isBash?: boolean
}

/**
 * 从工具调用输入中提取主文件/目录路径。
 * 同时处理 `file_path`（Read/Write/Edit）和 `path`（Grep/Glob）。
 */
function getFilePathFromToolInput(toolInput: unknown): string | undefined {
  const input = toolInput as
    | { file_path?: string; path?: string; pattern?: string; glob?: string }
    | undefined
  return input?.file_path ?? input?.path
}

/**
 * 通过检查搜索工具调用的路径、模式和 glob 来判断是否针对 memory 文件。
 */
function isMemorySearch(toolInput: unknown): boolean {
  const input = toolInput as
    | { path?: string; pattern?: string; glob?: string; command?: string }
    | undefined
  if (!input) {
    return false
  }
  // 检查搜索路径是否针对 memory 文件或目录（Grep/Glob 工具）
  if (input.path) {
    if (isAutoManagedMemoryFile(input.path) || isMemoryDirectory(input.path)) {
      return true
    }
  }
  // 检查表示访问 memory 文件的 glob 模式
  if (input.glob && isAutoManagedMemoryPattern(input.glob)) {
    return true
  }
  // 对于 shell 命令（bash grep/rg、PowerShell Select-String 等），
  // 检查命令是否针对 memory 路径
  if (input.command && isShellCommandTargetingMemory(input.command)) {
    return true
  }
  return false
}

/**
 * 检查 Write 或 Edit 工具调用是否针对 memory 文件并应被折叠。
 */
function isMemoryWriteOrEdit(toolName: string, toolInput: unknown): boolean {
  if (toolName !== FILE_WRITE_TOOL_NAME && toolName !== FILE_EDIT_TOOL_NAME) {
    return false
  }
  const filePath = getFilePathFromToolInput(toolInput)
  return filePath !== undefined && isAutoManagedMemoryFile(filePath)
}

// ~5 行 × ~60 列。宽松静态上限 —— 渲染器让 Ink 自动换行。
const MAX_HINT_CHARS = 300

/**
 * 为 ⎿ 提示格式化 bash 命令。删除空行，合并连续的
 * 行内空白，然后限制总长度。保留换行符以便渲染器
 * 在 ⎿ 下缩进续行。
 */
function commandAsHint(command: string): string {
  const cleaned =
    '$ ' +
    command
      .split('\n')
      .map(l => l.replace(/\s+/g, ' ').trim())
      .filter(l => l !== '')
      .join('\n')
  return cleaned.length > MAX_HINT_CHARS
    ? cleaned.slice(0, MAX_HINT_CHARS - 1) + '…'
    : cleaned
}

/**
 * 使用工具的 isSearchOrReadCommand 方法检查工具是否为搜索/读取操作。
 * 还将 memory 文件的 Write/Edit 视为可折叠。
 * 返回关于它是搜索还是读取操作的详细信息。
 */
export function getSearchExtraToolsOrReadInfo(
  toolName: string,
  toolInput: unknown,
  tools: Tools,
): SearchOrReadResult {
  // REPL 被静默吸收 —— 其内部工具调用作为虚拟消息
  // （isVirtual: true）通过 newMessages 发出，并作为普通的
  // Read/Grep/Bash 消息流经此函数。REPL 包装器本身
  // 不贡献任何计数也不会打断分组，因此连续的 REPL 调用会合并。
  if (toolName === REPL_TOOL_NAME) {
    return {
      isCollapsible: true,
      isSearch: false,
      isRead: false,
      isList: false,
      isREPL: true,
      isMemoryWrite: false,
      isAbsorbedSilently: true,
    }
  }

  // Memory 文件的写入/编辑可折叠
  if (isMemoryWriteOrEdit(toolName, toolInput)) {
    return {
      isCollapsible: true,
      isSearch: false,
      isRead: false,
      isList: false,
      isREPL: false,
      isMemoryWrite: true,
      isAbsorbedSilently: false,
    }
  }

  // 静默吸收的元操作：Snip（上下文清理）和 SearchExtraTools
  // （延迟加载工具 schema）。两者都不应打断折叠组
  // 或贡献计数，但在详细模式下仍可见。
  if (
    (feature('HISTORY_SNIP') && toolName === SNIP_TOOL_NAME) ||
    (isFullscreenEnvEnabled() && toolName === SEARCH_EXTRA_TOOLS_TOOL_NAME)
  ) {
    return {
      isCollapsible: true,
      isSearch: false,
      isRead: false,
      isList: false,
      isREPL: false,
      isMemoryWrite: false,
      isAbsorbedSilently: true,
    }
  }

  // 回退到 REPL 原语：在 REPL 模式下，Bash/Read/Grep 等
  // 从执行工具列表中移除，但 REPL 将它们作为虚拟消息发出。
  // 若无回退，它们将返回 isCollapsible: false 并从摘要行中消失。
  const tool =
    findToolByName(tools, toolName) ??
    findToolByName(getReplPrimitiveTools(), toolName)
  if (!tool?.isSearchOrReadCommand) {
    return {
      isCollapsible: false,
      isSearch: false,
      isRead: false,
      isList: false,
      isREPL: false,
      isMemoryWrite: false,
      isAbsorbedSilently: false,
    }
  }
  // 工具的 isSearchOrReadCommand 方法通过 safeParse 处理自己的输入验证，
  // 因此传递原始输入是安全的。需要类型断言，因为 Tool[] 使用默认泛型，
  // 期望 { [x: string]: any }，而我们在运行时接收 unknown。
  const result = tool.isSearchOrReadCommand(
    toolInput as { [x: string]: unknown },
  )
  const isList = result.isList ?? false
  const isCollapsible = result.isSearch || result.isRead || isList
  // 在全屏模式下，非搜索/读取的 Bash 命令也可折叠
  // 作为独立类别 —— “运行了 N 个 bash 命令” 而非打断分组。
  return {
    isCollapsible:
      isCollapsible ||
      (isFullscreenEnvEnabled() ? toolName === BASH_TOOL_NAME : false),
    isSearch: result.isSearch,
    isRead: result.isRead,
    isList,
    isREPL: false,
    isMemoryWrite: false,
    isAbsorbedSilently: false,
    ...(tool.isMcp && { mcpServerName: tool.mcpInfo?.serverName }),
    isBash: isFullscreenEnvEnabled()
      ? !isCollapsible && toolName === BASH_TOOL_NAME
      : undefined,
  }
}

/**
 * 检查 tool_use 内容块是否为搜索/读取操作。
 * 如果是可折叠的搜索/读取，返回 { isSearch, isRead, isREPL }，否则返回 null。
 */
export function getSearchOrReadFromContent(
  content: { type: string; name?: string; input?: unknown } | undefined,
  tools: Tools,
): {
  isSearch: boolean
  isRead: boolean
  isList: boolean
  isREPL: boolean
  isMemoryWrite: boolean
  isAbsorbedSilently: boolean
  mcpServerName?: string
  isBash?: boolean
} | null {
  if (content?.type === 'tool_use' && content.name) {
    const info = getSearchExtraToolsOrReadInfo(
      content.name,
      content.input,
      tools,
    )
    if (info.isCollapsible || info.isREPL) {
      return {
        isSearch: info.isSearch,
        isRead: info.isRead,
        isList: info.isList,
        isREPL: info.isREPL,
        isMemoryWrite: info.isMemoryWrite,
        isAbsorbedSilently: info.isAbsorbedSilently,
        mcpServerName: info.mcpServerName,
        isBash: info.isBash,
      }
    }
  }
  return null
}

/**
 * 检查工具是否为搜索/读取操作（向后兼容）。
 */
function isSearchExtraToolsOrRead(
  toolName: string,
  toolInput: unknown,
  tools: Tools,
): boolean {
  return getSearchExtraToolsOrReadInfo(toolName, toolInput, tools).isCollapsible
}

/**
 * 从消息中获取工具名称、输入和搜索/读取信息（如果是可折叠的工具调用）。
 * 如果消息不是可折叠的工具调用则返回 null。
 */
function getCollapsibleToolInfo(
  msg: RenderableMessage,
  tools: Tools,
): {
  name: string
  input: unknown
  isSearch: boolean
  isRead: boolean
  isList: boolean
  isREPL: boolean
  isMemoryWrite: boolean
  isAbsorbedSilently: boolean
  mcpServerName?: string
  isBash?: boolean
} | null {
  if (msg.type === 'assistant') {
    const content = getFirstContentItem(msg.message?.content)
    if (!content) return null
    const info = getSearchOrReadFromContent(
      content as { type: string; name?: string; input?: unknown },
      tools,
    )
    if (info && content.type === 'tool_use') {
      const toolUse = content as {
        type: 'tool_use'
        name: string
        input: unknown
      }
      return { name: toolUse.name, input: toolUse.input, ...info }
    }
  }
  if (msg.type === 'grouped_tool_use') {
    // 对于分组工具调用，检查第一条消息的输入
    const firstContent = getFirstContentItem(msg.messages[0]?.message?.content)
    const firstToolUse = firstContent as
      | { type: string; input?: unknown }
      | undefined
    const info = getSearchOrReadFromContent(
      firstToolUse
        ? { type: 'tool_use', name: msg.toolName, input: firstToolUse.input }
        : undefined,
      tools,
    )
    if (info && firstContent && firstContent.type === 'tool_use') {
      return { name: msg.toolName, input: firstToolUse?.input, ...info }
    }
  }
  return null
}

/**
 * 检查消息是否应打断分组的助手文本。
 */
function isTextBreaker(msg: RenderableMessage): boolean {
  if (msg.type === 'assistant') {
    const content = getFirstContentItem(msg.message?.content)
    if (
      content &&
      content.type === 'text' &&
      (content as { type: 'text'; text: string }).text.trim().length > 0
    ) {
      return true
    }
  }
  return false
}

/**
 * 检查消息是否为不应折叠的工具调用（会打断分组）。
 * 包括 Edit、Write 等工具调用。
 */
function isNonCollapsibleToolUse(
  msg: RenderableMessage,
  tools: Tools,
): boolean {
  if (msg.type === 'assistant') {
    const content = getFirstContentItem(msg.message?.content)
    if (
      content &&
      content.type === 'tool_use' &&
      !isSearchExtraToolsOrRead(
        (content as { name: string }).name,
        (content as { input: unknown }).input,
        tools,
      )
    ) {
      return true
    }
  }
  if (msg.type === 'grouped_tool_use') {
    const firstContent = getFirstContentItem(msg.messages[0]?.message?.content)
    if (
      firstContent &&
      firstContent.type === 'tool_use' &&
      !isSearchExtraToolsOrRead(
        msg.toolName,
        (firstContent as { input: unknown }).input,
        tools,
      )
    ) {
      return true
    }
  }
  return false
}

function isPreToolHookSummary(
  msg: RenderableMessage,
): msg is SystemStopHookSummaryMessage {
  return (
    msg.type === 'system' &&
    msg.subtype === 'stop_hook_summary' &&
    msg.hookLabel === 'PreToolUse'
  )
}

/**
 * 检查消息是否应被跳过（不打断分组，直接传递）。
 * 包括思考块、已编辑思考、附件等。
 */
function shouldSkipMessage(msg: RenderableMessage): boolean {
  if (msg.type === 'assistant') {
    const content = getFirstContentItem(msg.message?.content)
    // 跳过思考块和其他非文本、非工具内容
    if (
      content &&
      (content.type === 'thinking' || content.type === 'redacted_thinking')
    ) {
      return true
    }
  }
  // 跳过附件消息
  if (msg.type === 'attachment') {
    return true
  }
  // 跳过系统消息
  if (msg.type === 'system') {
    return true
  }
  return false
}

/**
 * 类型谓词：检查消息是否为可折叠的工具调用。
 */
function isCollapsibleToolUse(
  msg: RenderableMessage,
  tools: Tools,
): msg is CollapsibleMessage {
  if (msg.type === 'assistant') {
    const content = getFirstContentItem(msg.message?.content)
    return (
      content !== undefined &&
      content.type === 'tool_use' &&
      isSearchExtraToolsOrRead(
        (content as { name: string }).name,
        (content as { input: unknown }).input,
        tools,
      )
    )
  }
  if (msg.type === 'grouped_tool_use') {
    const firstContent = getFirstContentItem(msg.messages[0]?.message?.content)
    return (
      firstContent !== undefined &&
      firstContent.type === 'tool_use' &&
      isSearchExtraToolsOrRead(
        msg.toolName,
        (firstContent as { input: unknown }).input,
        tools,
      )
    )
  }
  return false
}

/**
 * 类型谓词：检查消息是否为可折叠工具的工具结果。
 * 仅当消息中所有工具结果都对应已跟踪的可折叠工具时返回 true。
 */
function isCollapsibleToolResult(
  msg: RenderableMessage,
  collapsibleToolUseIds: Set<string>,
): msg is CollapsibleMessage {
  if (msg.type === 'user') {
    const contentItems = getContentItems(msg.message?.content)
    const toolResults = contentItems.filter(
      (c): c is ContentItem & { type: 'tool_result'; tool_use_id: string } =>
        c.type === 'tool_result',
    )
    // 仅当存在工具结果且全部对应可折叠工具时才返回 true
    return (
      toolResults.length > 0 &&
      toolResults.every(r => collapsibleToolUseIds.has(r.tool_use_id))
    )
  }
  return false
}

/**
 * 从单条消息中获取所有工具调用 ID（处理分组工具调用）。
 */
function getToolUseIdsFromMessage(msg: RenderableMessage): string[] {
  if (msg.type === 'assistant') {
    const content = getFirstContentItem(msg.message?.content)
    if (content && content.type === 'tool_use') {
      return [(content as { id: string }).id]
    }
  }
  if (msg.type === 'grouped_tool_use') {
    return msg.messages
      .map(m => {
        const content = getFirstContentItem(m.message?.content)
        if (!content) return ''
        return content.type === 'tool_use' ? (content as { id: string }).id : ''
      })
      .filter(Boolean)
  }
  return []
}

/**
 * 从已折叠的读取/搜索组中获取所有工具调用 ID。
 */
export function getToolUseIdsFromCollapsedGroup(
  message: CollapsedReadSearchGroup,
): string[] {
  const ids: string[] = []
  for (const msg of message.messages) {
    ids.push(...getToolUseIdsFromMessage(msg))
  }
  return ids
}

/**
 * 检查折叠组中是否有工具正在进行中。
 */
export function hasAnyToolInProgress(
  message: CollapsedReadSearchGroup,
  inProgressToolUseIDs: Set<string>,
): boolean {
  return getToolUseIdsFromCollapsedGroup(message).some(id =>
    inProgressToolUseIDs.has(id),
  )
}

/**
 * 获取用于显示（时间戳/模型）的底层 NormalizedMessage。
 * 处理折叠组内嵌套的 GroupedToolUseMessage。
 * 返回 NormalizedAssistantMessage 或 NormalizedUserMessage（永远不是 GroupedToolUseMessage）。
 */
export function getDisplayMessageFromCollapsed(
  message: CollapsedReadSearchGroup,
): Exclude<CollapsibleMessage, { type: 'grouped_tool_use' }> {
  const firstMsg = message.displayMessage
  if (firstMsg.type === 'grouped_tool_use') {
    return firstMsg.displayMessage
  }
  return firstMsg
}

/**
 * 统计消息中的工具调用数量（处理分组工具调用）。
 */
function countToolUses(msg: RenderableMessage): number {
  if (msg.type === 'grouped_tool_use') {
    return msg.messages.length
  }
  return 1
}

/**
 * 从消息中的读取工具输入提取文件路径。
 * 返回文件路径数组（若同一文件在同一条分组消息中被多次读取，可能有重复）。
 */
function getFilePathsFromReadMessage(msg: RenderableMessage): string[] {
  const paths: string[] = []

  if (msg.type === 'assistant') {
    const content = getFirstContentItem(msg.message?.content)
    if (content && content.type === 'tool_use') {
      const input = (content as { input: unknown }).input as
        | { file_path?: string }
        | undefined
      if (input?.file_path) {
        paths.push(input.file_path)
      }
    }
  } else if (msg.type === 'grouped_tool_use') {
    for (const m of msg.messages) {
      const content = getFirstContentItem(m.message?.content)
      if (content && content.type === 'tool_use') {
        const input = (content as { input: unknown }).input as
          | { file_path?: string }
          | undefined
        if (input?.file_path) {
          paths.push(input.file_path)
        }
      }
    }
  }

  return paths
}

/**
 * 扫描 bash 工具结果中的 commit SHA 和 PR URL，并推送到组累加器。
 * 仅对 tool_use_id 已记录在 bashCommands（非搜索/读取的 bash）中的结果调用。
 */
function scanBashResultForGitOps(
  msg: CollapsibleMessage,
  group: GroupAccumulator,
): void {
  if (msg.type !== 'user') return
  const out = msg.toolUseResult as
    | { stdout?: string; stderr?: string }
    | undefined
  if (!out?.stdout && !out?.stderr) return
  // git push 将 ref 更新写入 stderr —— 同时扫描两个流。
  const combined = (out.stdout ?? '') + '\n' + (out.stderr ?? '')
  for (const c of getContentItems(msg.message?.content)) {
    if (c.type !== 'tool_result') continue
    const toolResult = c as { type: 'tool_result'; tool_use_id: string }
    const command = group.bashCommands?.get(toolResult.tool_use_id)
    if (!command) continue
    const { commit, push, branch, pr } = detectGitOperation(command, combined)
    if (commit) group.commits?.push(commit)
    if (push) group.pushes?.push(push)
    if (branch) group.branches?.push(branch)
    if (pr) group.prs?.push(pr)
    if (commit || push || branch || pr) {
      group.gitOpBashCount = (group.gitOpBashCount ?? 0) + 1
    }
  }
}

type GroupAccumulator = {
  messages: CollapsibleMessage[]
  searchCount: number
  readFilePaths: Set<string>
  // 没有文件路径的读取操作计数（如 Bash cat 命令）
  readOperationCount: number
  // 目录列表操作计数（ls、tree、du）
  listCount: number
  toolUseIds: Set<string>
  // Memory 文件操作计数（与普通计数分开跟踪）
  memorySearchCount: number
  memoryReadFilePaths: Set<string>
  memoryWriteCount: number
  // 团队 memory 文件操作计数（分开跟踪）
  teamMemorySearchCount?: number
  teamMemoryReadFilePaths?: Set<string>
  teamMemoryWriteCount?: number
  // 非 memory 的搜索参数，用于显示在折叠摘要下方
  nonMemSearchArgs: string[]
  /** 最近添加的非 memory 操作，已预格式化用于显示 */
  latestDisplayHint: string | undefined
  // MCP 工具调用（分开跟踪，以便显示“查询了 slack”而非“读取了 N 个文件”）
  mcpCallCount?: number
  mcpServerNames?: Set<string>
  // 不是搜索/读取的 Bash 命令（分开跟踪，用于“运行了 N 个 bash 命令”）
  bashCount?: number
  // Bash tool_use_id → 命令字符串，以便扫描工具结果中的
  // commit SHA / PR URL（显示为“已提交 abc123、已创建 PR #42”）
  bashCommands?: Map<string, string>
  commits?: { sha: string; kind: CommitKind }[]
  pushes?: { branch: string }[]
  branches?: { ref: string; action: BranchAction }[]
  prs?: { number: number; url?: string; action: PrAction }[]
  gitOpBashCount?: number
  // 从 hook 摘要消息中吸收的 PreToolUse hook 计时
  hookTotalMs: number
  hookCount: number
  hookInfos: StopHookInfo[]
  // 吸收到此组的 relevant_memories 附件（自动注入的
  // memory，非显式 Read 调用）。路径同步到 readFilePaths +
  // memoryReadFilePaths，以便内联的“回忆了 N 条 memory”文本准确。
  relevantMemories?: { path: string; content: string; mtimeMs: number }[]
}

function createEmptyGroup(): GroupAccumulator {
  const group: GroupAccumulator = {
    messages: [],
    searchCount: 0,
    readFilePaths: new Set(),
    readOperationCount: 0,
    listCount: 0,
    toolUseIds: new Set(),
    memorySearchCount: 0,
    memoryReadFilePaths: new Set(),
    memoryWriteCount: 0,
    nonMemSearchArgs: [],
    latestDisplayHint: undefined,
    hookTotalMs: 0,
    hookCount: 0,
    hookInfos: [],
  }
  if (feature('TEAMMEM')) {
    group.teamMemorySearchCount = 0
    group.teamMemoryReadFilePaths = new Set()
    group.teamMemoryWriteCount = 0
  }
  group.mcpCallCount = 0
  group.mcpServerNames = new Set()
  if (isFullscreenEnvEnabled()) {
    group.bashCount = 0
    group.bashCommands = new Map()
    group.commits = []
    group.pushes = []
    group.branches = []
    group.prs = []
    group.gitOpBashCount = 0
  }
  return group
}

function createCollapsedGroup(
  group: GroupAccumulator,
): CollapsedReadSearchGroup {
  const firstMsg = group.messages[0]!
  // 当存在基于文件路径的读取时，仅使用唯一文件计数（Set.size）。
  // 在此基础上再加 bash 操作计数会重复计算 —— 例如 Read(README.md)
  // 后接 Bash(wc -l README.md) 仍应显示为 1 个文件，而非 2。
  // 仅当没有基于文件路径的读取（纯 bash）时才回退到操作计数。
  const totalReadCount =
    group.readFilePaths.size > 0
      ? group.readFilePaths.size
      : group.readOperationCount
  // memoryReadFilePaths ⊆ readFilePaths（两者都从 Read 工具调用中填充），
  // 因此从下方 totalReadCount 中减去此计数是安全的。被吸收的
  // relevant_memories 附件不在 readFilePaths 中 —— 在减法之后
  // 单独添加，以保持 readCount 正确。
  const toolMemoryReadCount = group.memoryReadFilePaths.size
  const memoryReadCount =
    toolMemoryReadCount + (group.relevantMemories?.length ?? 0)
  // 非 memory 的读取文件路径：排除 memory 和团队 memory 路径
  const teamMemReadPaths = feature('TEAMMEM')
    ? group.teamMemoryReadFilePaths
    : undefined
  const nonMemReadFilePaths = [...group.readFilePaths].filter(
    p =>
      !group.memoryReadFilePaths.has(p) && !(teamMemReadPaths?.has(p) ?? false),
  )
  const teamMemSearchCount = feature('TEAMMEM')
    ? (group.teamMemorySearchCount ?? 0)
    : 0
  const teamMemReadCount = feature('TEAMMEM')
    ? (group.teamMemoryReadFilePaths?.size ?? 0)
    : 0
  const teamMemWriteCount = feature('TEAMMEM')
    ? (group.teamMemoryWriteCount ?? 0)
    : 0
  const result: CollapsedReadSearchGroup = {
    type: 'collapsed_read_search',
    // 减去 memory + 团队 memory 计数，使普通计数仅反映非 memory 操作
    searchCount: Math.max(
      0,
      group.searchCount - group.memorySearchCount - teamMemSearchCount,
    ),
    readCount: Math.max(
      0,
      totalReadCount - toolMemoryReadCount - teamMemReadCount,
    ),
    listCount: group.listCount,
    // REPL 操作故意不被折叠（见第 32 行的 isCollapsible: false），
    // 因此折叠组中的 replCount 始终为 0。保留 replCount 字段
    // 用于 AgentTool/UI.tsx 中子代理进度显示的独立代码路径。
    replCount: 0,
    memorySearchCount: group.memorySearchCount,
    memoryReadCount,
    memoryWriteCount: group.memoryWriteCount,
    readFilePaths: nonMemReadFilePaths,
    searchArgs: group.nonMemSearchArgs,
    latestDisplayHint: group.latestDisplayHint,
    messages: group.messages,
    displayMessage: firstMsg,
    uuid: `collapsed-${firstMsg.uuid}` as UUID,
    timestamp: firstMsg.timestamp,
  }
  if (feature('TEAMMEM')) {
    result.teamMemorySearchCount = teamMemSearchCount
    result.teamMemoryReadCount = teamMemReadCount
    result.teamMemoryWriteCount = teamMemWriteCount
  }
  if ((group.mcpCallCount ?? 0) > 0) {
    result.mcpCallCount = group.mcpCallCount
    result.mcpServerNames = [...(group.mcpServerNames ?? [])]
  }
  if (isFullscreenEnvEnabled()) {
    if ((group.bashCount ?? 0) > 0) {
      result.bashCount = group.bashCount
      result.gitOpBashCount = group.gitOpBashCount
    }
    if ((group.commits?.length ?? 0) > 0) result.commits = group.commits
    if ((group.pushes?.length ?? 0) > 0) result.pushes = group.pushes
    if ((group.branches?.length ?? 0) > 0) result.branches = group.branches
    if ((group.prs?.length ?? 0) > 0) result.prs = group.prs
  }
  if (group.hookCount > 0) {
    result.hookTotalMs = group.hookTotalMs
    result.hookCount = group.hookCount
    result.hookInfos = group.hookInfos
  }
  if (group.relevantMemories && group.relevantMemories.length > 0) {
    result.relevantMemories = group.relevantMemories
  }
  return result
}

/**
 * 将连续的读取/搜索操作折叠为摘要组。
 *
 * 规则：
 * - 将连续的搜索/读取工具调用（Grep、Glob、Read 以及 Bash 搜索/读取命令）分组
 * - 将对应的工具结果也包含在组中
 * - 当出现助手文本时打断分组
 */
export function collapseReadSearchGroups(
  messages: RenderableMessage[],
  tools: Tools,
): RenderableMessage[] {
  const result: RenderableMessage[] = []
  let currentGroup = createEmptyGroup()
  let deferredSkippable: RenderableMessage[] = []

  function flushGroup(): void {
    if (currentGroup.messages.length === 0) {
      return
    }
    result.push(createCollapsedGroup(currentGroup))
    for (const deferred of deferredSkippable) {
      result.push(deferred)
    }
    deferredSkippable = []
    currentGroup = createEmptyGroup()
  }

  for (const msg of messages) {
    if (isCollapsibleToolUse(msg, tools)) {
      // 这是可折叠的工具调用 —— 类型谓词收窄为 CollapsibleMessage
      const toolInfo = getCollapsibleToolInfo(msg, tools)!

      if (toolInfo.isMemoryWrite) {
        // Memory 文件写入/编辑 —— 检查是否为团队 memory
        const count = countToolUses(msg)
        if (
          feature('TEAMMEM') &&
          teamMemOps?.isTeamMemoryWriteOrEdit(toolInfo.name, toolInfo.input)
        ) {
          currentGroup.teamMemoryWriteCount =
            (currentGroup.teamMemoryWriteCount ?? 0) + count
        } else {
          currentGroup.memoryWriteCount += count
        }
      } else if (toolInfo.isAbsorbedSilently) {
        // Snip/SearchExtraTools 被静默吸收 —— 不计数，不生成摘要文本。
        // 在默认视图中隐藏，但仍通过 CollapsedReadSearchContent 中的
        // groupMessages 迭代在详细模式（Ctrl+O）下显示。
      } else if (toolInfo.mcpServerName) {
        // MCP 搜索/读取 —— 单独计数，以便摘要显示
        // “查询了 slack N 次”而非“读取了 N 个文件”。
        const count = countToolUses(msg)
        currentGroup.mcpCallCount = (currentGroup.mcpCallCount ?? 0) + count
        currentGroup.mcpServerNames?.add(toolInfo.mcpServerName)
        const input = toolInfo.input as { query?: string } | undefined
        if (input?.query) {
          currentGroup.latestDisplayHint = `"${input.query}"`
        }
      } else if (isFullscreenEnvEnabled() && toolInfo.isBash) {
        // 非搜索/读取的 Bash 命令 —— 单独计数，以便摘要显示
        // “运行了 N 个 bash 命令”而非打断分组。
        const count = countToolUses(msg)
        currentGroup.bashCount = (currentGroup.bashCount ?? 0) + count
        const input = toolInfo.input as { command?: string } | undefined
        if (input?.command) {
          // 优先使用剥离后的 `# comment`（若存在）—— 这是 Claude
          // 为人类编写的内容（与 comment-as-label 工具调用渲染相同的触发条件）。
          currentGroup.latestDisplayHint =
            extractBashCommentLabel(input.command) ??
            commandAsHint(input.command)
          // 记住 tool_use_id → 命令，以便后续到达的结果可以
          // 扫描 commit SHA / PR URL。
          for (const id of getToolUseIdsFromMessage(msg)) {
            currentGroup.bashCommands?.set(id, input.command)
          }
        }
      } else if (toolInfo.isList) {
        // 目录列表 bash 命令（ls、tree、du）—— 单独计数，
        // 以便摘要显示“列出了 N 个目录”而非“读取了 N 个文件”。
        currentGroup.listCount += countToolUses(msg)
        const input = toolInfo.input as { command?: string } | undefined
        if (input?.command) {
          currentGroup.latestDisplayHint = commandAsHint(input.command)
        }
      } else if (toolInfo.isSearch) {
        // 使用工具的 isSearch 标志正确分类 bash 搜索命令
        const count = countToolUses(msg)
        currentGroup.searchCount += count
        // 检查搜索是否针对 memory 文件（通过路径或 glob 模式）
        if (
          feature('TEAMMEM') &&
          teamMemOps?.isTeamMemorySearch(toolInfo.input)
        ) {
          currentGroup.teamMemorySearchCount =
            (currentGroup.teamMemorySearchCount ?? 0) + count
        } else if (isMemorySearch(toolInfo.input)) {
          currentGroup.memorySearchCount += count
        } else {
          // 常规（非 memory）搜索 —— 收集模式用于显示
          const input = toolInfo.input as { pattern?: string } | undefined
          if (input?.pattern) {
            currentGroup.nonMemSearchArgs.push(input.pattern)
            currentGroup.latestDisplayHint = `"${input.pattern}"`
          }
        }
      } else {
        // 对于读取，跟踪唯一文件路径而非计数操作
        const filePaths = getFilePathsFromReadMessage(msg)
        for (const filePath of filePaths) {
          currentGroup.readFilePaths.add(filePath)
          if (feature('TEAMMEM') && teamMemOps?.isTeamMemFile(filePath)) {
            currentGroup.teamMemoryReadFilePaths?.add(filePath)
          } else if (isAutoManagedMemoryFile(filePath)) {
            currentGroup.memoryReadFilePaths.add(filePath)
          } else {
            // 非 memory 文件读取 —— 更新显示提示
            currentGroup.latestDisplayHint = getDisplayPath(filePath)
          }
        }
        // 若未找到文件路径（如 Bash 读取命令如 ls、cat），则计数操作
        if (filePaths.length === 0) {
          currentGroup.readOperationCount += countToolUses(msg)
          // 使用 Bash 命令作为显示提示（为可读性截断）
          const input = toolInfo.input as { command?: string } | undefined
          if (input?.command) {
            currentGroup.latestDisplayHint = commandAsHint(input.command)
          }
        }
      }

      // 跟踪工具调用 ID 以匹配结果
      for (const id of getToolUseIdsFromMessage(msg)) {
        currentGroup.toolUseIds.add(id)
      }

      currentGroup.messages.push(msg)
    } else if (isCollapsibleToolResult(msg, currentGroup.toolUseIds)) {
      currentGroup.messages.push(msg)
      // 扫描 bash 结果中的 commit SHA / PR URL 以在摘要中显示
      if (isFullscreenEnvEnabled() && currentGroup.bashCommands?.size) {
        scanBashResultForGitOps(msg, currentGroup)
      }
    } else if (currentGroup.messages.length > 0 && isPreToolHookSummary(msg)) {
      // 将 PreToolUse hook 摘要吸收到组中而非延迟处理
      currentGroup.hookCount += msg.hookCount
      currentGroup.hookTotalMs +=
        msg.totalDurationMs ??
        msg.hookInfos.reduce((sum, h) => sum + (h.durationMs ?? 0), 0)
      currentGroup.hookInfos.push(...msg.hookInfos)
    } else if (
      currentGroup.messages.length > 0 &&
      msg.type === 'attachment' &&
      msg.attachment.type === 'relevant_memories'
    ) {
      // 吸收自动注入的 memory 附件，使“回忆了 N 条 memory”
      // 与“运行了 N 个 bash 命令”内联渲染，而非作为单独的
      // ⏺ 块。不要将路径添加到 readFilePaths/memoryReadFilePaths ——
      // 这会污染 readOperationCount 回退（纯 bash 读取没有路径；
      // 添加 memory 路径会使 readFilePaths.size > 0 并抑制回退）。
      // createCollapsedGroup 在 readCount 减法之后将 .length
      // 加到 memoryReadCount。
      currentGroup.relevantMemories ??= []
      currentGroup.relevantMemories.push(...(msg.attachment.memories ?? []))
    } else if (shouldSkipMessage(msg)) {
      // 对可跳过的消息（思考、附件、系统）不刷新分组
      // 如果分组进行中，延迟这些消息到折叠组之后输出
      // 这保留了视觉顺序：折叠徽章出现在第一个工具调用的位置，
      // 而非被中间的可跳过消息所取代。
      // 例外：nested_memory 附件即使在分组进行中也会直接推送，
      // 以便 ⎿ Loaded lines 紧密聚集，而非被徽章的 marginTop 分割。
      if (
        currentGroup.messages.length > 0 &&
        !(msg.type === 'attachment' && msg.attachment.type === 'nested_memory')
      ) {
        deferredSkippable.push(msg)
      } else {
        result.push(msg)
      }
    } else if (isTextBreaker(msg)) {
      // 助手文本打断分组
      flushGroup()
      result.push(msg)
    } else if (isNonCollapsibleToolUse(msg, tools)) {
      // 不可折叠的工具调用打断分组
      flushGroup()
      result.push(msg)
    } else {
      // 带有不可折叠工具结果的用户消息打断分组
      flushGroup()
      result.push(msg)
    }
  }

  flushGroup()
  return result
}

/**
 * 为搜索/读取/REPL 计数生成摘要文本。
 * @param searchCount 搜索操作数量
 * @param readCount 读取操作数量
 * @param isActive 分组是否仍在进行中（使用现在时）或已完成（使用过去时）
 * @param replCount REPL 执行次数（可选）
 * @param memoryCounts 可选的 memory 文件操作计数
 * @returns 摘要文本，如“Searching for 3 patterns, reading 2 files, REPL'd 5 times…”
 */
export function getSearchReadSummaryText(
  searchCount: number,
  readCount: number,
  isActive: boolean,
  replCount: number = 0,
  memoryCounts?: {
    memorySearchCount: number
    memoryReadCount: number
    memoryWriteCount: number
    teamMemorySearchCount?: number
    teamMemoryReadCount?: number
    teamMemoryWriteCount?: number
  },
  listCount: number = 0,
): string {
  const parts: string[] = []

  // 首先是 memory 操作
  if (memoryCounts) {
    const { memorySearchCount, memoryReadCount, memoryWriteCount } =
      memoryCounts
    if (memoryReadCount > 0) {
      const verb = isActive
        ? parts.length === 0
          ? 'Recalling'
          : 'recalling'
        : parts.length === 0
          ? 'Recalled'
          : 'recalled'
      parts.push(
        `${verb} ${memoryReadCount} ${memoryReadCount === 1 ? 'memory' : 'memories'}`,
      )
    }
    if (memorySearchCount > 0) {
      const verb = isActive
        ? parts.length === 0
          ? 'Searching'
          : 'searching'
        : parts.length === 0
          ? 'Searched'
          : 'searched'
      parts.push(`${verb} memories`)
    }
    if (memoryWriteCount > 0) {
      const verb = isActive
        ? parts.length === 0
          ? 'Writing'
          : 'writing'
        : parts.length === 0
          ? 'Wrote'
          : 'wrote'
      parts.push(
        `${verb} ${memoryWriteCount} ${memoryWriteCount === 1 ? 'memory' : 'memories'}`,
      )
    }
    // 团队 memory 操作
    if (feature('TEAMMEM') && teamMemOps) {
      teamMemOps.appendTeamMemorySummaryParts(memoryCounts, isActive, parts)
    }
  }

  if (searchCount > 0) {
    const searchVerb = isActive
      ? parts.length === 0
        ? 'Searching for'
        : 'searching for'
      : parts.length === 0
        ? 'Searched for'
        : 'searched for'
    parts.push(
      `${searchVerb} ${searchCount} ${searchCount === 1 ? 'pattern' : 'patterns'}`,
    )
  }

  if (readCount > 0) {
    const readVerb = isActive
      ? parts.length === 0
        ? 'Reading'
        : 'reading'
      : parts.length === 0
        ? 'Read'
        : 'read'
    parts.push(`${readVerb} ${readCount} ${readCount === 1 ? 'file' : 'files'}`)
  }

  if (listCount > 0) {
    const listVerb = isActive
      ? parts.length === 0
        ? 'Listing'
        : 'listing'
      : parts.length === 0
        ? 'Listed'
        : 'listed'
    parts.push(
      `${listVerb} ${listCount} ${listCount === 1 ? 'directory' : 'directories'}`,
    )
  }

  if (replCount > 0) {
    const replVerb = isActive ? "REPL'ing" : "REPL'd"
    parts.push(`${replVerb} ${replCount} ${replCount === 1 ? 'time' : 'times'}`)
  }

  const text = parts.join(', ')
  return isActive ? `${text}…` : text
}

/**
 * 将最近的工具活动列表汇总为简洁描述。
 * 使用记录时预先计算的 isSearch/isRead 分类来合并尾部连续的
 * 搜索/读取操作。对于不可折叠的工具调用，回退到最后一条
 * 活动的描述。
 */
export function summarizeRecentActivities(
  activities: readonly {
    activityDescription?: string
    isSearch?: boolean
    isRead?: boolean
  }[],
): string | undefined {
  if (activities.length === 0) {
    return undefined
  }
  // 从列表末尾开始计数尾部连续的搜索/读取活动
  let searchCount = 0
  let readCount = 0
  for (let i = activities.length - 1; i >= 0; i--) {
    const activity = activities[i]!
    if (activity.isSearch) {
      searchCount++
    } else if (activity.isRead) {
      readCount++
    } else {
      break
    }
  }
  const collapsibleCount = searchCount + readCount
  if (collapsibleCount >= 2) {
    return getSearchReadSummaryText(searchCount, readCount, true)
  }
  // 回退到最近一条有描述的活动（某些工具如 SendMessage
  // 未实现 getActivityDescription，因此需要向前搜索）
  for (let i = activities.length - 1; i >= 0; i--) {
    if (activities[i]?.activityDescription) {
      return activities[i]!.activityDescription
    }
  }
  return undefined
}
