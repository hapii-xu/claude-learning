/**
 * 将大型工具结果持久化到磁盘的实用工具，而非截断它们。
 */

import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { getOriginalCwd, getSessionId } from '../bootstrap/state.js'
import {
  BYTES_PER_TOKEN,
  DEFAULT_MAX_RESULT_SIZE_CHARS,
  MAX_TOOL_RESULT_BYTES,
  MAX_TOOL_RESULTS_PER_MESSAGE_CHARS,
} from '../constants/toolLimits.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { logEvent } from '../services/analytics/index.js'
import { sanitizeToolNameForAnalytics } from '../services/analytics/metadata.js'
import type { Message } from '../types/message.js'
import { logForDebugging } from './debug.js'
import { getErrnoCode, toError } from './errors.js'
import { formatFileSize } from './format.js'
import { logError } from './log.js'
import { getProjectDir } from './sessionStorage.js'
import { jsonStringify } from './slowOperations.js'

// 会话内工具结果的子目录名
export const TOOL_RESULTS_SUBDIR = 'tool-results'

// 用于包裹持久化输出消息的 XML 标签
export const PERSISTED_OUTPUT_TAG = '<persisted-output>'
export const PERSISTED_OUTPUT_CLOSING_TAG = '</persisted-output>'

// 工具结果内容被清除但未持久化到文件时使用的消息
export const TOOL_RESULT_CLEARED_MESSAGE = '[旧工具结果内容已清除]'

/**
 * GrowthBook 覆盖映射：工具名 -> 持久化阈值（字符数）。
 * 当工具名存在于此映射中时，该值直接用作有效阈值，
 * 绕过 Math.min() 对 50k 默认值的钳制。
 * 映射中不存在的工具使用硬编码的回退值。
 * 标志默认值为 {}（无覆盖 == 行为不变）。
 */
const PERSIST_THRESHOLD_OVERRIDE_FLAG = 'tengu_satin_quoll'

/**
 * 解析工具的有效持久化阈值。
 * GrowthBook 覆盖存在时优先；否则回退到声明的每工具上限，
 * 并由全局默认值钳制。
 *
 * 防御性处理：GrowthBook 的缓存返回 `cached !== undefined ? cached : default`，
 * 因此以 `null` 提供的标志会泄漏。我们使用可选链和 typeof 检查，
 * 使任何非对象标志值（null、string、number）回退到硬编码默认值，
 * 而非在索引时抛出或返回 0。
 */
export function getPersistenceThreshold(
  toolName: string,
  declaredMaxResultSizeChars: number,
): number {
  // Infinity = 硬退出（保留给通过其他机制自限的工具）。
  // 在 GB 覆盖之前检查，因此 tengu_satin_quoll 无法强制恢复。
  if (!Number.isFinite(declaredMaxResultSizeChars)) {
    return declaredMaxResultSizeChars
  }
  const overrides = getFeatureValue_CACHED_MAY_BE_STALE<Record<
    string,
    number
  > | null>(PERSIST_THRESHOLD_OVERRIDE_FLAG, {})
  const override = overrides?.[toolName]
  if (
    typeof override === 'number' &&
    Number.isFinite(override) &&
    override > 0
  ) {
    return override
  }
  return Math.min(declaredMaxResultSizeChars, DEFAULT_MAX_RESULT_SIZE_CHARS)
}

// 将工具结果持久化到磁盘的结果
export type PersistedToolResult = {
  filepath: string
  originalSize: number
  isJson: boolean
  preview: string
  hasMore: boolean
}

// 持久化失败时的错误结果
export type PersistToolResultError = {
  error: string
}

/**
 * 获取会话目录（projectDir/sessionId）
 */
function getSessionDir(): string {
  return join(getProjectDir(getOriginalCwd()), getSessionId())
}

/**
 * 获取此会话的工具结果目录（projectDir/sessionId/tool-results）
 */
export function getToolResultsDir(): string {
  return join(getSessionDir(), TOOL_RESULTS_SUBDIR)
}

// 参考消息的预览大小（字节）
export const PREVIEW_SIZE_BYTES = 2000

/**
 * 获取工具结果将被持久化的文件路径。
 */
export function getToolResultPath(id: string, isJson: boolean): string {
  const ext = isJson ? 'json' : 'txt'
  return join(getToolResultsDir(), `${id}.${ext}`)
}

/**
 * 确保会话特定的工具结果目录存在
 */
export async function ensureToolResultsDir(): Promise<void> {
  try {
    await mkdir(getToolResultsDir(), { recursive: true })
  } catch {
    // 目录可能已存在
  }
}

/**
 * 将工具结果持久化到磁盘，并返回关于持久化文件的信息。
 *
 * @param content - 要持久化的工具结果内容（字符串或内容块数组）
 * @param toolUseId - 产生该结果的工具使用的 ID
 * @returns 持久化文件的信息，包括文件路径和预览
 */
export async function persistToolResult(
  content: NonNullable<ToolResultBlockParam['content']>,
  toolUseId: string,
): Promise<PersistedToolResult | PersistToolResultError> {
  const isJson = Array.isArray(content)

  // 检查非文本内容 — 我们只能持久化文本块
  if (isJson) {
    const hasNonTextContent = content.some(block => block.type !== 'text')
    if (hasNonTextContent) {
      return {
        error: '无法持久化包含非文本内容的工具结果',
      }
    }
  }

  await ensureToolResultsDir()
  const filepath = getToolResultPath(toolUseId, isJson)
  const contentStr = isJson ? jsonStringify(content, null, 2) : content

  // tool_use_id 每次调用唯一，且内容对于给定 id 是确定性的，
  // 因此如果文件已存在则跳过。这防止了微压缩重播原始消息时
  // 在每个 API 轮次重复写入相同内容。使用 'wx' 而非 stat-then-write
  // 避免竞态条件。
  try {
    await writeFile(filepath, contentStr, { encoding: 'utf-8', flag: 'wx' })
    logForDebugging(
      `工具结果已持久化到 ${filepath}（${formatFileSize(contentStr.length)}）`,
    )
  } catch (error) {
    if (getErrnoCode(error) !== 'EEXIST') {
      logError(toError(error))
      return { error: getFileSystemErrorMessage(toError(error)) }
    }
    // EEXIST：已在之前的轮次持久化，继续生成预览
  }

  // 生成预览
  const { preview, hasMore } = generatePreview(contentStr, PREVIEW_SIZE_BYTES)

  return {
    filepath,
    originalSize: contentStr.length,
    isJson,
    preview,
    hasMore,
  }
}

/**
 * 为大型工具结果构建带预览的消息
 */
export function buildLargeToolResultMessage(
  result: PersistedToolResult,
): string {
  let message = `${PERSISTED_OUTPUT_TAG}\n`
  message += `输出过大（${formatFileSize(result.originalSize)}）。完整输出已保存到: ${result.filepath}\n\n`
  message += `预览（前 ${formatFileSize(PREVIEW_SIZE_BYTES)}）:\n`
  message += result.preview
  message += result.hasMore ? '\n...\n' : '\n'
  message += PERSISTED_OUTPUT_CLOSING_TAG
  return message
}

/**
 * 处理工具结果以包含在消息中。
 * 将结果映射为 API 格式，并将大型结果持久化到磁盘。
 */
export async function processToolResultBlock<T>(
  tool: {
    name: string
    maxResultSizeChars: number
    mapToolResultToToolResultBlockParam: (
      result: T,
      toolUseID: string,
    ) => ToolResultBlockParam
  },
  toolUseResult: T,
  toolUseID: string,
): Promise<ToolResultBlockParam> {
  const toolResultBlock = tool.mapToolResultToToolResultBlockParam(
    toolUseResult,
    toolUseID,
  )
  return maybePersistLargeToolResult(
    toolResultBlock,
    tool.name,
    getPersistenceThreshold(tool.name, tool.maxResultSizeChars),
  )
}

/**
 * 处理已映射的工具结果块。对大型结果应用持久化，
 * 无需重新调用 mapToolResultToToolResultBlockParam。
 */
export async function processPreMappedToolResultBlock(
  toolResultBlock: ToolResultBlockParam,
  toolName: string,
  maxResultSizeChars: number,
): Promise<ToolResultBlockParam> {
  return maybePersistLargeToolResult(
    toolResultBlock,
    toolName,
    getPersistenceThreshold(toolName, maxResultSizeChars),
  )
}

/**
 * 当 tool_result 的内容为空或实质为空时返回 true。覆盖：
 * undefined/null/''、仅空白的字符串、空数组、以及仅包含
 * 空白文本的文本块的数组。非文本块（图片、tool_reference）
 * 被视为非空。
 */
export function isToolResultContentEmpty(
  content: ToolResultBlockParam['content'],
): boolean {
  if (!content) return true
  if (typeof content === 'string') return content.trim() === ''
  if (!Array.isArray(content)) return false
  if (content.length === 0) return true
  return content.every(
    block =>
      typeof block === 'object' &&
      'type' in block &&
      block.type === 'text' &&
      'text' in block &&
      (typeof block.text !== 'string' || block.text.trim() === ''),
  )
}

/**
 * 通过将大型工具结果持久化到磁盘而非截断来处理。
 * 如果无需持久化则返回原始块，否则返回修改后的块，
 * 内容替换为指向持久化文件的引用。
 */
async function maybePersistLargeToolResult(
  toolResultBlock: ToolResultBlockParam,
  toolName: string,
  persistenceThreshold?: number,
): Promise<ToolResultBlockParam> {
  // 先检查大小再执行异步操作 — 大多数工具结果很小
  const content = toolResultBlock.content

  // inc-4586：提示尾部空的 tool_result 内容会导致某些模型
  // （特别是 capybara）发出 \n\nHuman: 停止序列并以零输出结束轮次。
  // 服务器渲染器不会在工具结果后插入 \n\nAssistant: 标记，
  // 因此裸露的 </function_results>\n\n 模式会匹配到轮次边界。
  // 多个工具可能合理地产生空输出（静默成功的 shell 命令、
  // 返回 content:[] 的 MCP 服务器、REPL 语句等）。
  // 注入一个短标记，让模型始终有内容可响应。
  if (isToolResultContentEmpty(content)) {
    logEvent('tengu_tool_empty_result', {
      toolName: sanitizeToolNameForAnalytics(toolName),
    })
    return {
      ...toolResultBlock,
      content: `(${toolName} 完成，无输出)`,
    }
  }
  // 空值保护后收窄 — 此处之后 content 非空。
  if (!content) {
    return toolResultBlock
  }

  // 跳过图片内容块的持久化 — 它们需要原样发送给 Claude
  if (hasImageBlock(content)) {
    return toolResultBlock
  }

  const size = contentSize(content)

  // 使用工具特定的阈值（如提供），否则回退到全局限制
  const threshold = persistenceThreshold ?? MAX_TOOL_RESULT_BYTES
  if (size <= threshold) {
    return toolResultBlock
  }

  // 将完整内容作为一个单元持久化
  const result = await persistToolResult(content, toolResultBlock.tool_use_id)
  if (isPersistError(result)) {
    // 持久化失败则返回原始块
    return toolResultBlock
  }

  const message = buildLargeToolResultMessage(result)

  // 记录分析事件
  logEvent('tengu_tool_result_persisted', {
    toolName: sanitizeToolNameForAnalytics(toolName),
    originalSizeBytes: result.originalSize,
    persistedSizeBytes: message.length,
    estimatedOriginalTokens: Math.ceil(result.originalSize / BYTES_PER_TOKEN),
    estimatedPersistedTokens: Math.ceil(message.length / BYTES_PER_TOKEN),
    thresholdUsed: threshold,
  })

  return { ...toolResultBlock, content: message }
}

/**
 * 生成内容预览，尽可能在换行符处截断。
 */
export function generatePreview(
  content: string,
  maxBytes: number,
): { preview: string; hasMore: boolean } {
  if (content.length <= maxBytes) {
    return { preview: content, hasMore: false }
  }

  // 在限制内找到最后一个换行符，避免在行中间截断
  const truncated = content.slice(0, maxBytes)
  const lastNewline = truncated.lastIndexOf('\n')

  // 如果在限制的合理范围内找到换行符则使用它
  // 否则回退到精确限制
  const cutPoint = lastNewline > maxBytes * 0.5 ? lastNewline : maxBytes

  return { preview: content.slice(0, cutPoint), hasMore: true }
}

/**
 * 类型守卫：检查持久化结果是否为错误
 */
export function isPersistError(
  result: PersistedToolResult | PersistToolResultError,
): result is PersistToolResultError {
  return 'error' in result
}

// --- 消息级聚合工具结果预算 ---
//
// 跨轮次跟踪替换状态，使 enforceToolResultBudget 每次都做出
// 相同的选择（保持提示缓存前缀稳定）。

/**
 * 聚合工具结果预算的每对话线程状态。
 * 状态必须稳定以保持提示缓存：
 *   - seenIds：已通过预算检查的结果（无论是否替换）。
 *     一旦见过，结果的命运在对话中被冻结。
 *   - replacements：seenIds 中被持久化到磁盘并替换为预览的
 *     子集，映射到展示给模型的确切预览字符串。重新应用是
 *     Map 查找 — 无文件 I/O，保证字节相同，不会失败。
 *
 * 生命周期：每个对话线程一个实例，携带在 ToolUseContext 上。
 * 主线程：REPL 配置一次，永不重置 — /clear、回退、恢复或压缩
 * 后的过期条目永远不会被查找（tool_use_id 是 UUID），因此无害。
 * 子代理：createSubagentContext 默认克隆父级状态
 * （如 agentSummary 等缓存共享分叉需要相同决策），
 * 或 resumeAgentBackground 从 sidechain 记录重构一个。
 */
export type ContentReplacementState = {
  seenIds: Set<string>
  replacements: Map<string, string>
}

export function createContentReplacementState(): ContentReplacementState {
  return { seenIds: new Set(), replacements: new Map() }
}

/**
 * 为缓存共享分叉（如 agentSummary）克隆替换状态。
 * 分叉需要与源在分叉时状态相同，使 enforceToolResultBudget
 * 做出相同选择 → 相同线上前缀 → 提示缓存命中。
 * 修改克隆不影响源。
 */
export function cloneContentReplacementState(
  source: ContentReplacementState,
): ContentReplacementState {
  return {
    seenIds: new Set(source.seenIds),
    replacements: new Map(source.replacements),
  }
}

/**
 * 解析每消息聚合预算限制。GrowthBook 覆盖
 * （tengu_hawthorn_window）存在且为有限正数时优先；
 * 否则回退到硬编码常量。防御性 typeof/finite 检查：
 * GrowthBook 的缓存返回 `cached !== undefined ? cached : default`，
 * 因此以 null/string/NaN 提供的标志会泄漏。
 */
export function getPerMessageBudgetLimit(): number {
  const override = getFeatureValue_CACHED_MAY_BE_STALE<number | null>(
    'tengu_hawthorn_window',
    null,
  )
  if (
    typeof override === 'number' &&
    Number.isFinite(override) &&
    override > 0
  ) {
    return override
  }
  return MAX_TOOL_RESULTS_PER_MESSAGE_CHARS
}

/**
 * 为新对话线程配置替换状态。
 *
 * 封装 feature flag 门控 + 重构 vs 新建的选择：
 *   - 标志关闭 → undefined（query.ts 完全跳过执行）
 *   - 无 initialMessages（冷启动）→ 新建
 *   - 有 initialMessages → 重构（冻结所有候选 ID，使预算
 *     永远不会替换模型已见过未替换的内容。空或缺失记录
 *     冻结所有内容；非空记录还填充 replacements Map 以实现
 *     字节相同的重新应用）。
 */
export function provisionContentReplacementState(
  initialMessages?: Message[],
  initialContentReplacements?: ContentReplacementRecord[],
): ContentReplacementState | undefined {
  const enabled = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_hawthorn_steeple',
    false,
  )
  if (!enabled) return undefined
  if (initialMessages) {
    return reconstructContentReplacementState(
      initialMessages,
      initialContentReplacements ?? [],
    )
  }
  return createContentReplacementState()
}

/**
 * 单个内容替换决策的可序列化记录。作为 ContentReplacementEntry
 * 写入转录，使决策在恢复后存活。通过 `kind` 区分，使未来
 * 替换机制（用户文本、卸载的图片）可以共享同一转录条目类型。
 *
 * `replacement` 是模型看到的确切字符串 — 存储而非在恢复时推导，
 * 这样预览模板、大小格式或路径布局的代码变更不会悄悄破坏提示缓存。
 */
export type ContentReplacementRecord = {
  kind: 'tool-result'
  toolUseId: string
  replacement: string
}

export type ToolResultReplacementRecord = Extract<
  ContentReplacementRecord,
  { kind: 'tool-result' }
>

type ToolResultCandidate = {
  toolUseId: string
  content: NonNullable<ToolResultBlockParam['content']>
  size: number
}

type CandidatePartition = {
  mustReapply: Array<ToolResultCandidate & { replacement: string }>
  frozen: ToolResultCandidate[]
  fresh: ToolResultCandidate[]
}

function isContentAlreadyCompacted(
  content: ToolResultBlockParam['content'],
): boolean {
  // 所有预算产出的内容都以该标签开头（buildLargeToolResultMessage）。
  // `.startsWith()` 避免当标签出现在内容其他地方时的误报
  // （例如，读取此源文件时）。
  return typeof content === 'string' && content.startsWith(PERSISTED_OUTPUT_TAG)
}

function hasImageBlock(
  content: NonNullable<ToolResultBlockParam['content']>,
): boolean {
  return (
    Array.isArray(content) &&
    content.some(
      b => typeof b === 'object' && 'type' in b && b.type === 'image',
    )
  )
}

function contentSize(
  content: NonNullable<ToolResultBlockParam['content']>,
): number {
  if (typeof content === 'string') return content.length
  // 直接求和文本块长度。与序列化相比略少计（无 JSON 框架），
  // 但预算本身就是粗略的 token 启发式。避免在每次执行时
  // 分配内容大小的字符串。
  return content.reduce(
    (sum, b) => sum + (b.type === 'text' ? b.text.length : 0),
    0,
  )
}

/**
 * 遍历消息并构建 tool_use_id → tool_name 映射，来自 assistant
 * 的 tool_use 块。tool_use 始终在其 tool_result 之前（模型先调用，
 * 然后结果到达），因此当预算执行看到结果时，其名称已知。
 */
function buildToolNameMap(messages: Message[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const message of messages) {
    if (message.type !== 'assistant') continue
    const content = message.message!.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type === 'tool_use') {
        map.set(block.id, block.name)
      }
    }
  }
  return map
}

/**
 * 从单个用户消息中提取候选 tool_result 块：非空、非图片、
 * 且未被标签（即被每工具限制或同一查询调用的早期迭代）
 * 已压缩的块。对无合格块的消息返回 []。
 */
function collectCandidatesFromMessage(message: Message): ToolResultCandidate[] {
  if (message.type !== 'user' || !Array.isArray(message.message!.content)) {
    return []
  }
  return message.message!.content.flatMap(block => {
    if (block.type !== 'tool_result' || !block.content) return []
    if (isContentAlreadyCompacted(block.content)) return []
    if (hasImageBlock(block.content)) return []
    return [
      {
        toolUseId: block.tool_use_id,
        content: block.content,
        size: contentSize(block.content),
      },
    ]
  })
}

/**
 * 按 API 级用户消息分组提取候选 tool_result 块。
 *
 * normalizeMessagesForAPI 将连续用户消息合并为一个
 * （Bedrock 兼容；1P 在服务端做同样处理），因此作为 N 个
 * 独立用户消息到达的并行工具结果在连线上变成一个用户消息。
 * 预算必须以相同方式分组，否则它会看到 N 个低于预算的消息
 * 而非一个超预算的消息，在最需要执行时无法准确执行。
 *
 * "组" 是不被 assistant 消息分隔的用户消息的最大连续序列。
 * 只有 assistant 消息创建连线级边界 — normalizeMessagesForAPI
 * 完全过滤掉 progress 并将 attachment / system(local_command)
 * 合并到相邻用户块中，因此这些类型也不会在此处打断组。
 *
 * 这对并行工具中止路径很重要：agent_progress 消息
 * （非临时，持久化在 REPL 状态中）可以穿插在新的 tool_result
 * 消息之间。如果在 progress 时刷新，这些 tool_result 会分裂成
 * 低于预算的组，溜过未替换，被冻结，然后被 normalizeMessagesForAPI
 * 合并成一个超预算的连线消息 — 破坏了此功能。
 *
 * 只返回至少有一个合格候选的组。
 */
function collectCandidatesByMessage(
  messages: Message[],
): ToolResultCandidate[][] {
  const groups: ToolResultCandidate[][] = []
  let current: ToolResultCandidate[] = []

  const flush = () => {
    if (current.length > 0) groups.push(current)
    current = []
  }

  // 跟踪所有已见过的 assistant message.id — 相同 ID 的片段
  // 被 normalizeMessagesForAPI 合并（messages.ts ~2126 通过 `continue`
  // 回退越过不同 ID 的 assistant），因此之前见过的 ID 的任何
  // 重新出现都不能创建组边界。两种场景：
  //   • 连续：streamingToolExecution 每个 content_block_stop
  //     产生一个 AssistantMessage（相同 id）；快速工具在块之间
  //     排空；中止/钩子停止留下 [asst(X), user(trA), asst(X), user(trB)]。
  //   • 交错：协调者/队友流混合不同响应，如
  //     [asst(X), user(trA), asst(Y), user(trB), asst(X), user(trC)]。
  // 两种情况下，normalizeMessagesForAPI 将 X 片段合并为一个连线
  // assistant，其后的 tool_result 合并为一个连线用户消息 —
  // 因此预算也必须将它们视为一个组。
  const seenAsstIds = new Set<string>()
  for (const message of messages) {
    if (message.type === 'user') {
      current.push(...collectCandidatesFromMessage(message))
    } else if (message.type === 'assistant') {
      if (!seenAsstIds.has(message.message!.id ?? '')) {
        flush()
        seenAsstIds.add(message.message!.id ?? '')
      }
    }
    // progress / attachment / system 被 normalizeMessagesForAPI
    // 过滤或合并 — 它们不创建连线边界。
  }
  flush()

  return groups
}

/**
 * 按先前的决策状态划分候选：
 *  - mustReapply：之前已替换 → 重新应用缓存的替换以保持前缀稳定
 *  - frozen：之前已见且未替换 → 不可触碰（现在替换会改变已缓存的前缀）
 *  - fresh：从未见过 → 有资格进行新的替换决策
 */
function partitionByPriorDecision(
  candidates: ToolResultCandidate[],
  state: ContentReplacementState,
): CandidatePartition {
  return candidates.reduce<CandidatePartition>(
    (acc, c) => {
      const replacement = state.replacements.get(c.toolUseId)
      if (replacement !== undefined) {
        acc.mustReapply.push({ ...c, replacement })
      } else if (state.seenIds.has(c.toolUseId)) {
        acc.frozen.push(c)
      } else {
        acc.fresh.push(c)
      }
      return acc
    },
    { mustReapply: [], frozen: [], fresh: [] },
  )
}

/**
 * 选择最大的新结果进行替换，直到模型可见的总量
 * （frozen + 剩余 fresh）在预算内或以下，或 fresh 耗尽。
 * 如果 frozen 结果本身就超过预算，我们接受超额 —
 * 微压缩最终会清除它们。
 */
function selectFreshToReplace(
  fresh: ToolResultCandidate[],
  frozenSize: number,
  limit: number,
): ToolResultCandidate[] {
  const sorted = [...fresh].sort((a, b) => b.size - a.size)
  const selected: ToolResultCandidate[] = []
  let remaining = frozenSize + fresh.reduce((sum, c) => sum + c.size, 0)
  for (const c of sorted) {
    if (remaining <= limit) break
    selected.push(c)
    // 在持久化之前我们不知道替换大小，但预览约 ~2K，
    // 而到达此路径的结果大得多，因此减去完整大小
    // 是选择目的的合理近似。
    remaining -= c.size
  }
  return selected
}

/**
 * 返回新的 Message[]，其中 replacementMap 中出现的每个
 * tool_result 块的内容被替换。无需替换的消息和块按引用传递。
 */
function replaceToolResultsInMessages(
  messages: Message[],
  replacementMap: Map<string, string>,
): Message[] {
  return messages.map(message => {
    if (message.type !== 'user' || !Array.isArray(message.message!.content)) {
      return message
    }
    const content = message.message!.content
    const needsReplace = content.some(
      b => b.type === 'tool_result' && replacementMap.has(b.tool_use_id),
    )
    if (!needsReplace) return message
    return {
      ...message,
      message: {
        ...message.message,
        content: content.map(block => {
          if (block.type !== 'tool_result') return block
          const replacement = replacementMap.get(block.tool_use_id)
          return replacement === undefined
            ? block
            : { ...block, content: replacement }
        }),
      },
    }
  })
}

async function buildReplacement(
  candidate: ToolResultCandidate,
): Promise<{ content: string; originalSize: number } | null> {
  const result = await persistToolResult(candidate.content, candidate.toolUseId)
  if (isPersistError(result)) return null
  return {
    content: buildLargeToolResultMessage(result),
    originalSize: result.originalSize,
  }
}

/**
 * 执行每消息聚合工具结果大小的预算。
 *
 * 对于每个 tool_result 块合计超过每消息限制的用户消息
 * （见 getPerMessageBudgetLimit），该消息中最大的新（从未见过的）
 * 结果被持久化到磁盘并替换为预览。
 * 消息独立评估 — 一个消息中的 150K 结果和另一个消息中的
 * 150K 结果都在预算内且不受影响。
 *
 * 状态通过 `state` 中的 tool_use_id 跟踪。一旦结果被见过，
 * 其命运就被冻结：之前已替换的结果每轮从缓存的预览字符串
 * 重新应用相同的替换（零 I/O，字节相同），之前未替换的结果
 * 永远不会被后来替换（会破坏提示缓存）。
 *
 * 每轮最多添加一条新的带 tool_result 块的用户消息，
 * 因此每消息循环通常最多执行一次预算检查；
 * 所有先前消息只是重新应用缓存的替换。
 *
 * @param state — 被修改：seenIds 和 replacements 就地更新以记录
 *   本次调用的选择。调用者跨轮次持有稳定引用；返回新对象
 *   会在每次查询后需要容易出错的引用更新。
 *
 * 返回 `{ messages, newlyReplaced }`：
 *   - messages：无需替换时为相同数组实例
 *   - newlyReplaced：本次调用进行的替换（非重新应用）。
 *     调用者将这些持久化到转录以用于恢复重构。
 */
export async function enforceToolResultBudget(
  messages: Message[],
  state: ContentReplacementState,
  skipToolNames: ReadonlySet<string> = new Set(),
): Promise<{
  messages: Message[]
  newlyReplaced: ToolResultReplacementRecord[]
}> {
  const candidatesByMessage = collectCandidatesByMessage(messages)
  const nameByToolUseId =
    skipToolNames.size > 0 ? buildToolNameMap(messages) : undefined
  const shouldSkip = (id: string): boolean =>
    nameByToolUseId !== undefined &&
    skipToolNames.has(nameByToolUseId.get(id) ?? '')
  // 每次调用解析一次。会话中途的标志变更仅影响新消息
  // （先前决策通过 seenIds/replacements 冻结），因此已见内容
  // 的提示缓存无论如何都保持不变。
  const limit = getPerMessageBudgetLimit()

  // 独立遍历每个 API 级消息组。对于之前处理过的消息
  // （seenIds 中的所有 ID），这只是重新应用缓存的替换。
  // 对于本轮添加的单条新消息，执行预算检查。
  const replacementMap = new Map<string, string>()
  const toPersist: ToolResultCandidate[] = []
  let reappliedCount = 0
  let messagesOverBudget = 0

  for (const candidates of candidatesByMessage) {
    const { mustReapply, frozen, fresh } = partitionByPriorDecision(
      candidates,
      state,
    )

    // 重新应用：纯 Map 查找。无文件 I/O，字节相同，不会失败。
    mustReapply.forEach(c => replacementMap.set(c.toolUseId, c.replacement))
    reappliedCount += mustReapply.length

    // fresh 表示这是一条新消息。检查其每消息预算。
    // （之前处理过的消息 fresh.length === 0，因为其所有 ID
    // 在第一次见时已添加到 seenIds。）
    if (fresh.length === 0) {
      // mustReapply/frozen 在第一次通过时已在 seenIds 中 —
      // 重新添加是空操作但保持不变量显式。
      candidates.forEach(c => state.seenIds.add(c.toolUseId))
      continue
    }

    // maxResultSizeChars: Infinity 的工具 — 永不持久化
    // （保留给通过其他机制自限的工具）。标记为已见（冻结），
    // 使决策跨轮次保持。它们不计入 freshSize；如果这使组
    // 低于预算但连线消息仍然很大，这就是契约 — 工具自身的
    // maxTokens 是边界，而非此包装器。
    const skipped = fresh.filter(c => shouldSkip(c.toolUseId))
    skipped.forEach(c => state.seenIds.add(c.toolUseId))
    const eligible = fresh.filter(c => !shouldSkip(c.toolUseId))

    const frozenSize = frozen.reduce((sum, c) => sum + c.size, 0)
    const freshSize = eligible.reduce((sum, c) => sum + c.size, 0)

    const selected =
      frozenSize + freshSize > limit
        ? selectFreshToReplace(eligible, frozenSize, limit)
        : []

    // 立即（同步）标记不持久化的候选为已见。选中持久化的 ID
    // 在 await 之后标记为已见，与 replacements.set 一起 — 保持
    // 该对在观察下原子性，使并发读者（一旦子代理共享状态）
    // 永远不会看到 X∈seenIds 但 X∉replacements，否则会将 X
    // 误分类为 frozen 并发送完整内容，而主线程发送预览 → 缓存未命中。
    const selectedIds = new Set(selected.map(c => c.toolUseId))
    candidates
      .filter(c => !selectedIds.has(c.toolUseId))
      .forEach(c => state.seenIds.add(c.toolUseId))

    if (selected.length === 0) continue
    messagesOverBudget++
    toPersist.push(...selected)
  }

  if (replacementMap.size === 0 && toPersist.length === 0) {
    return { messages, newlyReplaced: [] }
  }

  // 新：所有消息中所有选中候选的并发持久化。
  // 实际上每轮 toPersist 来自单条消息。
  const freshReplacements = await Promise.all(
    toPersist.map(async c => [c, await buildReplacement(c)] as const),
  )
  const newlyReplaced: ToolResultReplacementRecord[] = []
  let replacedSize = 0
  for (const [candidate, replacement] of freshReplacements) {
    // 在此标记已见，await 之后，成功情况下与 replacements.set 原子。
    // 对于持久化失败（replacement === null），ID 是已见但未替换 —
    // 原始内容已发送给模型，因此将其视为冻结是正确的。
    state.seenIds.add(candidate.toolUseId)
    if (replacement === null) continue
    replacedSize += candidate.size
    replacementMap.set(candidate.toolUseId, replacement.content)
    state.replacements.set(candidate.toolUseId, replacement.content)
    newlyReplaced.push({
      kind: 'tool-result',
      toolUseId: candidate.toolUseId,
      replacement: replacement.content,
    })
    logEvent('tengu_tool_result_persisted_message_budget', {
      originalSizeBytes: replacement.originalSize,
      persistedSizeBytes: replacement.content.length,
      estimatedOriginalTokens: Math.ceil(
        replacement.originalSize / BYTES_PER_TOKEN,
      ),
      estimatedPersistedTokens: Math.ceil(
        replacement.content.length / BYTES_PER_TOKEN,
      ),
    })
  }

  if (replacementMap.size === 0) {
    return { messages, newlyReplaced: [] }
  }

  if (newlyReplaced.length > 0) {
    logForDebugging(
      `每消息预算: 持久化 ${newlyReplaced.length} 个工具结果，` +
        `跨越 ${messagesOverBudget} 个超预算消息，` +
        `释放 ~${formatFileSize(replacedSize)}，重新应用 ${reappliedCount} 个`,
    )
    logEvent('tengu_message_level_tool_result_budget_enforced', {
      resultsPersisted: newlyReplaced.length,
      messagesOverBudget,
      replacedSizeBytes: replacedSize,
      reapplied: reappliedCount,
    })
  }

  return {
    messages: replaceToolResultsInMessages(messages, replacementMap),
    newlyReplaced,
  }
}

/**
 * 聚合预算的查询循环集成点。
 *
 * 门控 `state`（undefined 表示功能禁用 → 空操作返回），
 * 应用执行，并为新替换触发可选的转录写入回调。
 * 调用者（query.ts）拥有持久化门控 — 它仅为在恢复时
 * 读回记录的 querySource 传递回调（repl_main_thread*、agent:*）；
 * 临时 runForkedAgent 调用者（agentSummary、sessionMemory、
 * /btw、compact）传递 undefined。
 *
 * @returns 应用替换后的消息，或在功能关闭或无替换发生时
 *   输入数组不变。
 */
export async function applyToolResultBudget(
  messages: Message[],
  state: ContentReplacementState | undefined,
  writeToTranscript?: (records: ToolResultReplacementRecord[]) => void,
  skipToolNames?: ReadonlySet<string>,
): Promise<Message[]> {
  if (!state) return messages
  const result = await enforceToolResultBudget(messages, state, skipToolNames)
  if (result.newlyReplaced.length > 0) {
    writeToTranscript?.(result.newlyReplaced)
  }
  return result.messages
}

/**
 * 从转录中加载的内容替换记录重构替换状态。用于恢复，
 * 使预算做出与原始会话相同的选择（提示缓存稳定性）。
 *
 * 接受 LogOption 的完整 ContentReplacementRecord[]
 * （可能包含未来的非 tool-result 类型）；此处仅应用
 * tool-result 记录。
 *
 *   - replacements：直接从存储的替换字符串填充。
 *     不在消息中的 ID 记录（如压缩后）被跳过 — 它们无论如何是惰性的。
 *   - seenIds：加载消息中的每个候选 tool_use_id。结果在转录中
 *     意味着它已发送给模型，因此已被见过。这冻结了未替换结果
 *     防止未来替换。
 *   - inheritedReplacements：分叉子代理恢复的间隙填充。
 *     分叉的原始运行通过 mustReapply 应用父级继承的替换
 *     （永不持久化 — 非 newlyReplaced）。恢复时 sidechain 有
 *     原始内容但无记录，仅记录会将其分类为 frozen。
 *     父级的实时状态仍有映射；为消息中记录未覆盖的 ID 复制它。
 *     对非分叉恢复是空操作（父级 ID 不在子代理的消息中）。
 */
export function reconstructContentReplacementState(
  messages: Message[],
  records: ContentReplacementRecord[],
  inheritedReplacements?: ReadonlyMap<string, string>,
): ContentReplacementState {
  const state = createContentReplacementState()
  const candidateIds = new Set(
    collectCandidatesByMessage(messages)
      .flat()
      .map(c => c.toolUseId),
  )

  for (const id of candidateIds) {
    state.seenIds.add(id)
  }
  for (const r of records) {
    if (r.kind === 'tool-result' && candidateIds.has(r.toolUseId)) {
      state.replacements.set(r.toolUseId, r.replacement)
    }
  }
  if (inheritedReplacements) {
    for (const [id, replacement] of inheritedReplacements) {
      if (candidateIds.has(id) && !state.replacements.has(id)) {
        state.replacements.set(id, replacement)
      }
    }
  }
  return state
}

/**
 * AgentTool 恢复变体：封装 feature flag 门控 + 父级间隙填充，
 * 使 AgentTool.call 和 resumeAgentBackground 共享一个实现。
 * 当 parentState 为 undefined 时返回 undefined（功能关闭）；
 * 否则从 sidechain 记录重构，父级的实时替换填充
 * 分叉继承的 mustReapply 条目的间隙。
 *
 * 保留在 AgentTool.tsx 之外 — 该文件处于 feature() DCE 复杂度
 * 临界点，无法容忍即使 +1 行源码也不会在测试中悄悄破坏
 * feature('TRANSCRIPT_CLASSIFIER') 的求值。
 */
export function reconstructForSubagentResume(
  parentState: ContentReplacementState | undefined,
  resumedMessages: Message[],
  sidechainRecords: ContentReplacementRecord[],
): ContentReplacementState | undefined {
  if (!parentState) return undefined
  return reconstructContentReplacementState(
    resumedMessages,
    sidechainRecords,
    parentState.replacements,
  )
}

/**
 * 从文件系统错误获取人类可读的错误消息
 */
function getFileSystemErrorMessage(error: Error): string {
  // Node.js 文件系统错误有 'code' 属性
  // eslint-disable-next-line no-restricted-syntax -- 使用 .path，非仅 .code
  const nodeError = error as NodeJS.ErrnoException
  if (nodeError.code) {
    switch (nodeError.code) {
      case 'ENOENT':
        return `目录未找到: ${nodeError.path ?? '未知路径'}`
      case 'EACCES':
        return `权限被拒绝: ${nodeError.path ?? '未知路径'}`
      case 'ENOSPC':
        return '设备空间不足'
      case 'EROFS':
        return '只读文件系统'
      case 'EMFILE':
        return '打开的文件过多'
      case 'EEXIST':
        return `文件已存在: ${nodeError.path ?? '未知路径'}`
      default:
        return `${nodeError.code}: ${nodeError.message}`
    }
  }
  return error.message
}
