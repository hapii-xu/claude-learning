import type { BetaToolUnion } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { createPatch } from 'diff'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import type { AgentId } from 'src/types/ids.js'
import type { Message } from 'src/types/message.js'
import { logForDebugging } from 'src/utils/debug.js'
import { djb2Hash } from 'src/utils/hash.js'
import { logError } from 'src/utils/log.js'
import { getClaudeTempDir } from 'src/utils/permissions/filesystem.js'
import { jsonStringify } from 'src/utils/slowOperations.js'
import type { QuerySource } from '../../constants/querySource.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'

function getCacheBreakDiffPath(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let suffix = ''
  for (let i = 0; i < 4; i++) {
    suffix += chars[Math.floor(Math.random() * chars.length)]
  }
  return join(getClaudeTempDir(), `cache-break-${suffix}.diff`)
}

type PreviousState = {
  systemHash: number
  toolsHash: number
  /** 保留了 cache_control 的 system 块的哈希。用于捕获 stripCacheControl
   *  从 systemHash 中抹除的 scope/TTL 翻转（global↔org、1h↔5m）。 */
  cacheControlHash: number
  toolNames: string[]
  /** 每个 tool schema 的哈希。当 toolSchemasChanged 但 added=removed=0
   *  时（BQ 2026-03-22 显示占 77% 的 tool break），用来定位是哪个 tool
   *  的描述变了。AgentTool/SkillTool 内嵌动态的 agent/command 列表。 */
  perToolHashes: Record<string, number>
  systemCharCount: number
  model: string
  fastMode: boolean
  /** 'tool_based' | 'system_prompt' | 'none' —— 在 MCP 工具被发现/移除时翻转。 */
  globalCacheStrategy: string
  /** 排过序的 beta header 列表。做 diff 以展示哪些 header 被添加/移除。 */
  betas: string[]
  /** AFK_MODE_BETA_HEADER 是否存在 —— 不应再打破缓存
   *  （在 claude.ts 中已做 sticky-on 锁存）。跟踪以验证修复。 */
  autoModeActive: boolean
  /** Overage 状态翻转 —— 不应再打破缓存（资格在 should1hCacheTTL 中
   *  按 session 稳定地锁存）。跟踪以验证修复。 */
  isUsingOverage: boolean
  /** Cache-editing beta header 是否存在 —— 不应再打破缓存
   *  （在 claude.ts 中已做 sticky-on 锁存）。跟踪以验证修复。 */
  cachedMCEnabled: boolean
  /** 解析后的 effort（env → options → 模型默认值）。会进入 output_config
   *  或 anthropic_internal.effort_override。 */
  effortValue: string
  /** getExtraBodyParams() 的哈希 —— 捕获 CLAUDE_CODE_EXTRA_BODY 和
   *  anthropic_internal 的变化。 */
  extraBodyHash: number
  callCount: number
  pendingChanges: PendingChanges | null
  prevCacheReadTokens: number | null
  /** 当 cached microcompact 发送 cache_edits 删除时设置。cache 读取会
   *  合理下降 —— 这是预期行为，不是 break。 */
  cacheDeletionsPending: boolean
  buildDiffableContent: string
}

type PendingChanges = {
  systemPromptChanged: boolean
  toolSchemasChanged: boolean
  modelChanged: boolean
  fastModeChanged: boolean
  cacheControlChanged: boolean
  globalCacheStrategyChanged: boolean
  betasChanged: boolean
  autoModeChanged: boolean
  overageChanged: boolean
  cachedMCChanged: boolean
  effortChanged: boolean
  extraBodyChanged: boolean
  addedToolCount: number
  removedToolCount: number
  systemCharDelta: number
  addedTools: string[]
  removedTools: string[]
  changedToolSchemas: string[]
  previousModel: string
  newModel: string
  prevGlobalCacheStrategy: string
  newGlobalCacheStrategy: string
  addedBetas: string[]
  removedBetas: string[]
  prevEffortValue: string
  newEffortValue: string
  prevDiffableContent: string
}

const previousStateBySource = new Map<string, PreviousState>()

// 限制被跟踪 source 的数量，防止内存无界增长。
// 每个条目存储一个约 300KB+ 的 diffableContent 字符串（序列化后的 system
// prompt + tool schemas）。如果不限制，大量 subagent（每个都有独立的
// agentId 作为 key）会让 map 无限增长。
const MAX_TRACKED_SOURCES = 10

const TRACKED_SOURCE_PREFIXES = [
  'repl_main_thread',
  'sdk',
  'agent:custom',
  'agent:default',
  'agent:builtin',
]

// 触发 cache break 告警所需的最小绝对 token 下降量。
// 较小的下降（例如几千 token）可能是正常波动导致，不值得告警。
const MIN_CACHE_MISS_TOKENS = 2_000

// 用于测试的 Anthropic 服务端 prompt cache TTL 阈值。
// 超过这些时长的 cache break 更可能是 TTL 过期，
// 而不是客户端的变化导致的。
const CACHE_TTL_5MIN_MS = 5 * 60 * 1000
export const CACHE_TTL_1HOUR_MS = 60 * 60 * 1000

// 需要从 cache break 检测中排除的模型（例如 haiku 的缓存行为不同）
function isExcludedModel(model: string): boolean {
  return model.includes('haiku')
}

/**
 * 返回某个 querySource 的跟踪 key，若不跟踪则返回 null。
 * Compact 与 repl_main_thread 共享同一份服务端缓存
 * （相同的 cacheSafeParams），所以它们共享跟踪状态。
 *
 * 对于带被跟踪 querySource 的 subagent，使用唯一的 agentId 来隔离
 * 跟踪状态。这样可以避免当同一种 agent 类型的多个实例并发运行时
 * 出现误报的 cache break 通知。
 *
 * 不跟踪的 source（speculation、session_memory、prompt_suggestion 等）
 * 是短暂的 fork agent，对它们做 cache break 检测没有价值 —— 它们每次
 * 运行 1-3 轮且使用全新的 agentId，没有可比较的对象。它们的缓存指标
 * 仍会通过 tengu_api_success 记录用于分析。
 */
function getTrackingKey(
  querySource: QuerySource,
  agentId?: AgentId,
): string | null {
  if (querySource === 'compact') return 'repl_main_thread'
  for (const prefix of TRACKED_SOURCE_PREFIXES) {
    if (querySource.startsWith(prefix)) return agentId || querySource
  }
  return null
}

function stripCacheControl(
  items: ReadonlyArray<Record<string, unknown>>,
): unknown[] {
  return items.map(item => {
    if (!('cache_control' in item)) return item
    const { cache_control: _, ...rest } = item
    return rest
  })
}

function computeHash(data: unknown): number {
  const str = jsonStringify(data)
  if (typeof Bun !== 'undefined') {
    const hash = Bun.hash(str)
    // Bun.hash 对大输入可能返回 bigint；安全地转换为 number
    return typeof hash === 'bigint' ? Number(hash & 0xffffffffn) : hash
  }
  // 非 Bun 运行时（例如通过 npm 全局安装的 Node.js）的兜底
  return djb2Hash(str)
}

/** MCP 工具名由用户控制（server 配置），可能泄露文件路径。
 *  把它们折叠为 'mcp'；内置名是固定的词汇表。 */
function sanitizeToolName(name: string): string {
  return name.startsWith('mcp__') ? 'mcp' : name
}

function computePerToolHashes(
  strippedTools: ReadonlyArray<unknown>,
  names: string[],
): Record<string, number> {
  const hashes: Record<string, number> = {}
  for (let i = 0; i < strippedTools.length; i++) {
    hashes[names[i] ?? `__idx_${i}`] = computeHash(strippedTools[i])
  }
  return hashes
}

function getSystemCharCount(system: TextBlockParam[]): number {
  let total = 0
  for (const block of system) {
    total += block.text.length
  }
  return total
}

function buildDiffableContent(
  system: TextBlockParam[],
  tools: BetaToolUnion[],
  model: string,
): string {
  const systemText = system.map(b => b.text).join('\n\n')
  const toolDetails = tools
    .map(t => {
      if (!('name' in t)) return 'unknown'
      const desc = 'description' in t ? t.description : ''
      const schema = 'input_schema' in t ? jsonStringify(t.input_schema) : ''
      return `${t.name}\n  description: ${desc}\n  input_schema: ${schema}`
    })
    .sort()
    .join('\n\n')
  return `Model: ${model}\n\n=== System Prompt ===\n\n${systemText}\n\n=== Tools (${tools.length}) ===\n\n${toolDetails}\n`
}

/** 扩展的跟踪快照 —— 我们能从客户端观察到的、所有可能影响服务端缓存
 *  key 的内容。所有字段都是可选的，调用方可以增量添加；
 *  undefined 字段视为稳定。 */
export type PromptStateSnapshot = {
  system: TextBlockParam[]
  toolSchemas: BetaToolUnion[]
  querySource: QuerySource
  model: string
  agentId?: AgentId
  fastMode?: boolean
  globalCacheStrategy?: string
  betas?: readonly string[]
  autoModeActive?: boolean
  isUsingOverage?: boolean
  cachedMCEnabled?: boolean
  effortValue?: string | number
  extraBodyParams?: unknown
}

/**
 * 阶段 1（调用前）：记录当前 prompt/tool 状态并检测发生了什么变化。
 * 不触发事件 —— 只把待处理的变化存起来，供阶段 2 使用。
 */
export function recordPromptState(snapshot: PromptStateSnapshot): void {
  try {
    const {
      system,
      toolSchemas,
      querySource,
      model,
      agentId,
      fastMode,
      globalCacheStrategy = '',
      betas = [],
      autoModeActive = false,
      isUsingOverage = false,
      cachedMCEnabled = false,
      effortValue,
      extraBodyParams,
    } = snapshot
    const key = getTrackingKey(querySource, agentId)
    if (!key) return

    const strippedSystem = stripCacheControl(
      system as unknown as ReadonlyArray<Record<string, unknown>>,
    )
    const strippedTools = stripCacheControl(
      toolSchemas as unknown as ReadonlyArray<Record<string, unknown>>,
    )

    const systemHash = computeHash(strippedSystem)
    const toolsHash = computeHash(strippedTools)
    // 对包含 cache_control 的完整 system 数组做哈希 —— 这能捕获
    // scope 翻转（global↔org/none）和 TTL 翻转（1h↔5m），这些是
    // 剥离哈希看不到的（因为文本内容完全相同）。
    const cacheControlHash = computeHash(
      system.map(b => ('cache_control' in b ? b.cache_control : null)),
    )
    const toolNames = toolSchemas.map(t => ('name' in t ? t.name : 'unknown'))
    // 仅当聚合哈希变化时才计算 per-tool 哈希 —— 常见情况
    // （工具未变）可跳过 N 次额外的 jsonStringify 调用。
    const computeToolHashes = () =>
      computePerToolHashes(strippedTools, toolNames)
    const systemCharCount = getSystemCharCount(system)
    const isFastMode = fastMode ?? false
    const sortedBetas = [...betas].sort()
    const effortStr = effortValue === undefined ? '' : String(effortValue)
    const extraBodyHash =
      extraBodyParams === undefined ? 0 : computeHash(extraBodyParams)

    const prev = previousStateBySource.get(key)

    if (!prev) {
      // 当 map 达到容量上限时，淘汰最旧的条目
      while (previousStateBySource.size >= MAX_TRACKED_SOURCES) {
        const oldest = previousStateBySource.keys().next().value
        if (oldest !== undefined) previousStateBySource.delete(oldest)
      }

      previousStateBySource.set(key, {
        systemHash,
        toolsHash,
        cacheControlHash,
        toolNames,
        systemCharCount,
        model,
        fastMode: isFastMode,
        globalCacheStrategy,
        betas: sortedBetas,
        autoModeActive,
        isUsingOverage,
        cachedMCEnabled,
        effortValue: effortStr,
        extraBodyHash,
        callCount: 1,
        pendingChanges: null,
        prevCacheReadTokens: null,
        cacheDeletionsPending: false,
        buildDiffableContent: buildDiffableContent(system, toolSchemas, model),
        perToolHashes: computeToolHashes(),
      })
      return
    }

    prev.callCount++

    const systemPromptChanged = systemHash !== prev.systemHash
    const toolSchemasChanged = toolsHash !== prev.toolsHash
    const modelChanged = model !== prev.model
    const fastModeChanged = isFastMode !== prev.fastMode
    const cacheControlChanged = cacheControlHash !== prev.cacheControlHash
    const globalCacheStrategyChanged =
      globalCacheStrategy !== prev.globalCacheStrategy
    const betasChanged =
      sortedBetas.length !== prev.betas.length ||
      sortedBetas.some((b, i) => b !== prev.betas[i])
    const autoModeChanged = autoModeActive !== prev.autoModeActive
    const overageChanged = isUsingOverage !== prev.isUsingOverage
    const cachedMCChanged = cachedMCEnabled !== prev.cachedMCEnabled
    const effortChanged = effortStr !== prev.effortValue
    const extraBodyChanged = extraBodyHash !== prev.extraBodyHash

    if (
      systemPromptChanged ||
      toolSchemasChanged ||
      modelChanged ||
      fastModeChanged ||
      cacheControlChanged ||
      globalCacheStrategyChanged ||
      betasChanged ||
      autoModeChanged ||
      overageChanged ||
      cachedMCChanged ||
      effortChanged ||
      extraBodyChanged
    ) {
      const prevToolSet = new Set(prev.toolNames)
      const newToolSet = new Set(toolNames)
      const prevBetaSet = new Set(prev.betas)
      const newBetaSet = new Set(sortedBetas)
      const addedTools = toolNames.filter(n => !prevToolSet.has(n))
      const removedTools = prev.toolNames.filter(n => !newToolSet.has(n))
      const changedToolSchemas: string[] = []
      if (toolSchemasChanged) {
        const newHashes = computeToolHashes()
        for (const name of toolNames) {
          if (!prevToolSet.has(name)) continue
          if (newHashes[name] !== prev.perToolHashes[name]) {
            changedToolSchemas.push(name)
          }
        }
        prev.perToolHashes = newHashes
      }
      prev.pendingChanges = {
        systemPromptChanged,
        toolSchemasChanged,
        modelChanged,
        fastModeChanged,
        cacheControlChanged,
        globalCacheStrategyChanged,
        betasChanged,
        autoModeChanged,
        overageChanged,
        cachedMCChanged,
        effortChanged,
        extraBodyChanged,
        addedToolCount: addedTools.length,
        removedToolCount: removedTools.length,
        addedTools,
        removedTools,
        changedToolSchemas,
        systemCharDelta: systemCharCount - prev.systemCharCount,
        previousModel: prev.model,
        newModel: model,
        prevGlobalCacheStrategy: prev.globalCacheStrategy,
        newGlobalCacheStrategy: globalCacheStrategy,
        addedBetas: sortedBetas.filter(b => !prevBetaSet.has(b)),
        removedBetas: prev.betas.filter(b => !newBetaSet.has(b)),
        prevEffortValue: prev.effortValue,
        newEffortValue: effortStr,
        prevDiffableContent: prev.buildDiffableContent,
      }
    } else {
      prev.pendingChanges = null
    }

    prev.systemHash = systemHash
    prev.toolsHash = toolsHash
    prev.cacheControlHash = cacheControlHash
    prev.toolNames = toolNames
    prev.systemCharCount = systemCharCount
    prev.model = model
    prev.fastMode = isFastMode
    prev.globalCacheStrategy = globalCacheStrategy
    prev.betas = sortedBetas
    prev.autoModeActive = autoModeActive
    prev.isUsingOverage = isUsingOverage
    prev.cachedMCEnabled = cachedMCEnabled
    prev.effortValue = effortStr
    prev.extraBodyHash = extraBodyHash
    prev.buildDiffableContent = buildDiffableContent(system, toolSchemas, model)
  } catch (e: unknown) {
    logError(e)
  }
}

/**
 * 阶段 2（调用后）：检查 API 响应中的 cache token，判断是否真的发生了
 * cache break。若有，使用阶段 1 的待处理变化来解释原因。
 */
export async function checkResponseForCacheBreak(
  querySource: QuerySource,
  cacheReadTokens: number,
  cacheCreationTokens: number,
  messages: Message[],
  agentId?: AgentId,
  requestId?: string | null,
): Promise<void> {
  try {
    const key = getTrackingKey(querySource, agentId)
    if (!key) return

    const state = previousStateBySource.get(key)
    if (!state) return

    // 跳过排除的模型（例如 haiku 的缓存行为不同）
    if (isExcludedModel(state.model)) return

    const prevCacheRead = state.prevCacheReadTokens
    state.prevCacheReadTokens = cacheReadTokens

    // 通过在 messages 数组中查找最近一条 assistant 消息的时间戳
    // （当前响应之前）来计算距上次调用的时间，用于 TTL 检测
    const lastAssistantMessage = messages.findLast(m => m.type === 'assistant')
    const timeSinceLastAssistantMsg = lastAssistantMessage
      ? Date.now() -
        new Date(lastAssistantMessage.timestamp as string | number).getTime()
      : null

    // 跳过第一次调用 —— 没有可比较的上一次值
    if (prevCacheRead === null) return

    const changes = state.pendingChanges

    // 通过 cached microcompact 进行的 cache 删除是有意缩小缓存前缀的。
    // cache read token 的下降是预期行为 —— 重置基线，避免下次调用误报。
    if (state.cacheDeletionsPending) {
      state.cacheDeletionsPending = false
      logForDebugging(
        `[PROMPT CACHE] cache deletion applied, cache read: ${prevCacheRead} → ${cacheReadTokens} (expected drop)`,
      )
      // 不标记为 break —— 剩余的状态仍然有效
      state.pendingChanges = null
      return
    }

    // 检测 cache break：cache read 相比上次下降 >5%，且绝对下降量超过最小阈值。
    const tokenDrop = prevCacheRead - cacheReadTokens
    if (
      cacheReadTokens >= prevCacheRead * 0.95 ||
      tokenDrop < MIN_CACHE_MISS_TOKENS
    ) {
      state.pendingChanges = null
      return
    }

    // 从待处理的变化构建解释（若有）
    const parts: string[] = []
    if (changes) {
      if (changes.modelChanged) {
        parts.push(
          `model changed (${changes.previousModel} → ${changes.newModel})`,
        )
      }
      if (changes.systemPromptChanged) {
        const charDelta = changes.systemCharDelta
        const charInfo =
          charDelta === 0
            ? ''
            : charDelta > 0
              ? ` (+${charDelta} chars)`
              : ` (${charDelta} chars)`
        parts.push(`system prompt changed${charInfo}`)
      }
      if (changes.toolSchemasChanged) {
        const toolDiff =
          changes.addedToolCount > 0 || changes.removedToolCount > 0
            ? ` (+${changes.addedToolCount}/-${changes.removedToolCount} tools)`
            : ' (tool prompt/schema changed, same tool set)'
        parts.push(`tools changed${toolDiff}`)
      }
      if (changes.fastModeChanged) {
        parts.push('fast mode toggled')
      }
      if (changes.globalCacheStrategyChanged) {
        parts.push(
          `global cache strategy changed (${changes.prevGlobalCacheStrategy || 'none'} → ${changes.newGlobalCacheStrategy || 'none'})`,
        )
      }
      if (
        changes.cacheControlChanged &&
        !changes.globalCacheStrategyChanged &&
        !changes.systemPromptChanged
      ) {
        // 仅在没有其他原因解释时才作为独立原因上报 ——
        // 否则 scope/TTL 翻转是结果，不是根因。
        parts.push('cache_control changed (scope or TTL)')
      }
      if (changes.betasChanged) {
        const added = changes.addedBetas.length
          ? `+${changes.addedBetas.join(',')}`
          : ''
        const removed = changes.removedBetas.length
          ? `-${changes.removedBetas.join(',')}`
          : ''
        const diff = [added, removed].filter(Boolean).join(' ')
        parts.push(`betas changed${diff ? ` (${diff})` : ''}`)
      }
      if (changes.autoModeChanged) {
        parts.push('auto mode toggled')
      }
      if (changes.overageChanged) {
        parts.push('overage state changed (TTL latched, no flip)')
      }
      if (changes.cachedMCChanged) {
        parts.push('cached microcompact toggled')
      }
      if (changes.effortChanged) {
        parts.push(
          `effort changed (${changes.prevEffortValue || 'default'} → ${changes.newEffortValue || 'default'})`,
        )
      }
      if (changes.extraBodyChanged) {
        parts.push('extra body params changed')
      }
    }

    // 检查时间间隔是否提示 TTL 过期
    const lastAssistantMsgOver5minAgo =
      timeSinceLastAssistantMsg !== null &&
      timeSinceLastAssistantMsg > CACHE_TTL_5MIN_MS
    const lastAssistantMsgOver1hAgo =
      timeSinceLastAssistantMsg !== null &&
      timeSinceLastAssistantMsg > CACHE_TTL_1HOUR_MS

    // PR #19823 后的 BQ 分析（bq-queries/prompt-caching/cache_break_pr19823_analysis.sql）：
    // 当所有客户端 flag 都为 false 且间隔在 TTL 之内时，约 90% 的 break
    // 都是服务端路由/驱逐或计费/推理不一致导致。按此标记，
    // 而不是暗示是 CC 的 bug。
    let reason: string
    if (parts.length > 0) {
      reason = parts.join(', ')
    } else if (lastAssistantMsgOver1hAgo) {
      reason = 'possible 1h TTL expiry (prompt unchanged)'
    } else if (lastAssistantMsgOver5minAgo) {
      reason = 'possible 5min TTL expiry (prompt unchanged)'
    } else if (timeSinceLastAssistantMsg !== null) {
      reason = 'likely server-side (prompt unchanged, <5min gap)'
    } else {
      reason = 'unknown cause'
    }

    logEvent('tengu_prompt_cache_break', {
      systemPromptChanged: changes?.systemPromptChanged ?? false,
      toolSchemasChanged: changes?.toolSchemasChanged ?? false,
      modelChanged: changes?.modelChanged ?? false,
      fastModeChanged: changes?.fastModeChanged ?? false,
      cacheControlChanged: changes?.cacheControlChanged ?? false,
      globalCacheStrategyChanged: changes?.globalCacheStrategyChanged ?? false,
      betasChanged: changes?.betasChanged ?? false,
      autoModeChanged: changes?.autoModeChanged ?? false,
      overageChanged: changes?.overageChanged ?? false,
      cachedMCChanged: changes?.cachedMCChanged ?? false,
      effortChanged: changes?.effortChanged ?? false,
      extraBodyChanged: changes?.extraBodyChanged ?? false,
      addedToolCount: changes?.addedToolCount ?? 0,
      removedToolCount: changes?.removedToolCount ?? 0,
      systemCharDelta: changes?.systemCharDelta ?? 0,
      // Tool 名做了脱敏：内置名是固定的词汇表，
      // MCP 工具折叠为 'mcp'（由用户配置，可能泄露路径）。
      addedTools: (changes?.addedTools ?? [])
        .map(sanitizeToolName)
        .join(
          ',',
        ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      removedTools: (changes?.removedTools ?? [])
        .map(sanitizeToolName)
        .join(
          ',',
        ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      changedToolSchemas: (changes?.changedToolSchemas ?? [])
        .map(sanitizeToolName)
        .join(
          ',',
        ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      // Beta header 名和 cache 策略是固定的类枚举值，
      // 不是代码或文件路径。requestId 是服务端生成的不透明 ID。
      addedBetas: (changes?.addedBetas ?? []).join(
        ',',
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      removedBetas: (changes?.removedBetas ?? []).join(
        ',',
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      prevGlobalCacheStrategy: (changes?.prevGlobalCacheStrategy ??
        '') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      newGlobalCacheStrategy: (changes?.newGlobalCacheStrategy ??
        '') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      callNumber: state.callCount,
      prevCacheReadTokens: prevCacheRead,
      cacheReadTokens,
      cacheCreationTokens,
      timeSinceLastAssistantMsg: timeSinceLastAssistantMsg ?? -1,
      lastAssistantMsgOver5minAgo,
      lastAssistantMsgOver1hAgo,
      requestId: (requestId ??
        '') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })

    // 为 ant 通过 --debug 写入 diff 文件。路径包含在 summary 日志中，
    // 方便 ant 查找（DevBar UI 已移除 —— 事件数据可靠地流向 BQ 用于分析）。
    let diffPath: string | undefined
    if (changes?.prevDiffableContent) {
      diffPath = await writeCacheBreakDiff(
        changes.prevDiffableContent,
        state.buildDiffableContent,
      )
    }

    const diffSuffix = diffPath ? `, diff: ${diffPath}` : ''
    const summary = `[PROMPT CACHE BREAK] ${reason} [source=${querySource}, call #${state.callCount}, cache read: ${prevCacheRead} → ${cacheReadTokens}, creation: ${cacheCreationTokens}${diffSuffix}]`

    logForDebugging(summary, { level: 'warn' })

    state.pendingChanges = null
  } catch (e: unknown) {
    logError(e)
  }
}

/**
 * 当 cached microcompact 发送 cache_edits 删除时调用。
 * 下一次 API 响应的 cache read token 会降低 —— 这是预期行为，
 * 不是 cache break。
 */
export function notifyCacheDeletion(
  querySource: QuerySource,
  agentId?: AgentId,
): void {
  const key = getTrackingKey(querySource, agentId)
  const state = key ? previousStateBySource.get(key) : undefined
  if (state) {
    state.cacheDeletionsPending = true
  }
}

/**
 * 在 compaction 之后调用以重置 cache read 基线。
 * Compaction 会合理地减少消息数量，因此下次调用时 cache read token
 * 自然会下降 —— 这不是 break。
 */
export function notifyCompaction(
  querySource: QuerySource,
  agentId?: AgentId,
): void {
  const key = getTrackingKey(querySource, agentId)
  const state = key ? previousStateBySource.get(key) : undefined
  if (state) {
    state.prevCacheReadTokens = null
  }
}

export function cleanupAgentTracking(agentId: AgentId): void {
  previousStateBySource.delete(agentId)
}

export function resetPromptCacheBreakDetection(): void {
  previousStateBySource.clear()
}

async function writeCacheBreakDiff(
  prevContent: string,
  newContent: string,
): Promise<string | undefined> {
  try {
    const diffPath = getCacheBreakDiffPath()
    await mkdir(getClaudeTempDir(), { recursive: true })
    const patch = createPatch(
      'prompt-state',
      prevContent,
      newContent,
      'before',
      'after',
    )
    await writeFile(diffPath, patch)
    return diffPath
  } catch {
    return undefined
  }
}
