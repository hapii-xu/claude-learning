import { feature } from 'bun:bundle'
import type { Anthropic } from '@anthropic-ai/sdk'
import {
  getSystemPrompt,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
} from 'src/constants/prompts.js'
import { microcompactMessages } from 'src/services/compact/microCompact.js'
import { getSdkBetas } from '../bootstrap/state.js'
import { getCommandName } from '../commands.js'
import { getSystemContext } from '../context.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import {
  AUTOCOMPACT_BUFFER_TOKENS,
  getEffectiveContextWindowSize,
  isAutoCompactEnabled,
  MANUAL_COMPACT_BUFFER_TOKENS,
} from '../services/compact/autoCompact.js'
import {
  countMessagesTokensWithAPI,
  countTokensViaHaikuFallback,
  roughTokenCountEstimation,
} from '../services/tokenEstimation.js'
import { estimateSkillFrontmatterTokens } from '../skills/loadSkillsDir.js'
import {
  findToolByName,
  type Tool,
  type ToolPermissionContext,
  type Tools,
  type ToolUseContext,
  toolMatchesName,
} from '../Tool.js'
import type {
  AgentDefinition,
  AgentDefinitionsResult,
} from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import { SKILL_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/SkillTool/constants.js'
import {
  getLimitedSkillToolCommands,
  getSkillToolInfo as getSlashCommandInfo,
} from '@claude-code-best/builtin-tools/tools/SkillTool/prompt.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  NormalizedAssistantMessage,
  NormalizedUserMessage,
  UserMessage,
} from '../types/message.js'
import { toolToAPISchema } from './api.js'
import { filterInjectedMemoryFiles, getMemoryFiles } from './claudemd.js'
import { getContextWindowForModel } from './context.js'
import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import { isEnvTruthy } from './envUtils.js'
import { errorMessage, toError } from './errors.js'
import { logError } from './log.js'
import { normalizeMessagesForAPI } from './messages.js'
import { getRuntimeMainLoopModel } from './model/model.js'
import type { SettingSource } from './settings/constants.js'
import { jsonStringify } from './slowOperations.js'
import { buildEffectiveSystemPrompt } from './systemPrompt.js'
import type { Theme } from './theme.js'
import { getCurrentUsage } from './tokens.js'

const RESERVED_CATEGORY_NAME = 'Autocompact buffer'
const MANUAL_COMPACT_BUFFER_NAME = 'Compact buffer'

/**
 * 当存在工具时 API 添加的固定 token 开销。
 * 当存在工具时，API 会在每次 API 调用时添加一个工具提示前言（约 500 tokens）。
 * 当我们通过 token 计数 API 单独计算工具时，每次调用都包含此开销，
 * 导致 N 个工具的 N × 开销而不是 1 × 开销。
 * 我们从每个工具的计数中减去此开销以显示准确的工具内容大小。
 */
export const TOOL_TOKEN_COUNT_OVERHEAD = 500

async function countTokensWithFallback(
  messages: Anthropic.Beta.Messages.BetaMessageParam[],
  tools: Anthropic.Beta.Messages.BetaToolUnion[],
): Promise<number | null> {
  try {
    const result = await countMessagesTokensWithAPI(messages, tools)
    if (result !== null) {
      return result
    }
    logForDebugging(
      `countTokensWithFallback: API returned null, trying haiku fallback (${tools.length} tools)`,
    )
  } catch (err) {
    logForDebugging(`countTokensWithFallback: API failed: ${errorMessage(err)}`)
    logError(err)
  }

  try {
    const fallbackResult = await countTokensViaHaikuFallback(messages, tools)
    if (fallbackResult === null) {
      logForDebugging(
        `countTokensWithFallback: haiku fallback also returned null (${tools.length} tools)`,
      )
    }
    return fallbackResult
  } catch (err) {
    logForDebugging(
      `countTokensWithFallback: haiku fallback failed: ${errorMessage(err)}`,
    )
    logError(err)
    return null
  }
}

interface ContextCategory {
  name: string
  tokens: number
  color: keyof Theme
  /** 当为 true 时，这些 tokens 是延迟的，不计入上下文使用 */
  isDeferred?: boolean
}

interface GridSquare {
  color: keyof Theme
  isFilled: boolean
  categoryName: string
  tokens: number
  percentage: number
  squareFullness: number // 0-1 表示单个方格的填充程度
}

interface MemoryFile {
  path: string
  type: string
  tokens: number
}

interface McpTool {
  name: string
  serverName: string
  tokens: number
  isLoaded?: boolean
}

export interface DeferredBuiltinTool {
  name: string
  tokens: number
  isLoaded: boolean
}

export interface SystemToolDetail {
  name: string
  tokens: number
}

export interface SystemPromptSectionDetail {
  name: string
  tokens: number
}

interface Agent {
  agentType: string
  source: SettingSource | 'built-in' | 'plugin'
  tokens: number
}

interface SlashCommandInfo {
  readonly totalCommands: number
  readonly includedCommands: number
  readonly tokens: number
}

/** 上下文显示的单个技能详情 */
interface SkillFrontmatter {
  name: string
  source: SettingSource | 'plugin'
  tokens: number
}

/**
 * 关于包含在上下文窗口中的技能的信息。
 */
interface SkillInfo {
  /** 可用技能总数 */
  readonly totalSkills: number
  /** token 预算内包含的技能数量 */
  readonly includedSkills: number
  /** 技能消耗的总 tokens */
  readonly tokens: number
  /** 单个技能详情 */
  readonly skillFrontmatter: SkillFrontmatter[]
}

export interface ContextData {
  readonly categories: ContextCategory[]
  readonly totalTokens: number
  readonly maxTokens: number
  readonly rawMaxTokens: number
  readonly percentage: number
  readonly gridRows: GridSquare[][]
  readonly model: string
  readonly memoryFiles: MemoryFile[]
  readonly mcpTools: McpTool[]
  /** Ant 专属：延迟内置工具的每个工具细分 */
  readonly deferredBuiltinTools?: DeferredBuiltinTool[]
  /** Ant 专属：始终加载的内置工具的每个工具细分 */
  readonly systemTools?: SystemToolDetail[]
  /** Ant 专属：系统提示的每个部分细分 */
  readonly systemPromptSections?: SystemPromptSectionDetail[]
  readonly agents: Agent[]
  readonly slashCommands?: SlashCommandInfo
  /** 技能统计 */
  readonly skills?: SkillInfo
  readonly autoCompactThreshold?: number
  readonly isAutoCompactEnabled: boolean
  messageBreakdown?: {
    toolCallTokens: number
    toolResultTokens: number
    attachmentTokens: number
    assistantMessageTokens: number
    userMessageTokens: number
    toolCallsByType: Array<{
      name: string
      callTokens: number
      resultTokens: number
    }>
    attachmentsByType: Array<{ name: string; tokens: number }>
  }
  /** Actual token usage from last API response (if available) */
  readonly apiUsage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  } | null
  /** Cache hit rate percentage (0-100), undefined if no data */
  readonly cacheHitRate?: number
  /** Cache warning threshold percentage */
  readonly cacheThreshold?: number
}

export async function countToolDefinitionTokens(
  tools: Tools,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  agentInfo: AgentDefinitionsResult | null,
  model?: string,
): Promise<number> {
  const toolSchemas = await Promise.all(
    tools.map(tool =>
      toolToAPISchema(tool, {
        getToolPermissionContext,
        tools,
        agents: agentInfo?.activeAgents ?? [],
        model,
      }),
    ),
  )
  const result = await countTokensWithFallback([], toolSchemas)
  if (result === null || result === 0) {
    const toolNames = tools.map(t => t.name).join(', ')
    logForDebugging(
      `countToolDefinitionTokens returned ${result} for ${tools.length} tools: ${toolNames.slice(0, 100)}${toolNames.length > 100 ? '...' : ''}`,
    )
  }
  return result ?? 0
}

/** 从系统提示部分的内容中提取人类可读的名称 */
function extractSectionName(content: string): string {
  // 尝试查找第一个 markdown 标题
  const headingMatch = content.match(/^#+\s+(.+)$/m)
  if (headingMatch) {
    return headingMatch[1]!.trim()
  }
  // 回退到第一个非空行的截断预览
  const firstLine = content.split('\n').find(l => l.trim().length > 0) ?? ''
  return firstLine.length > 40 ? firstLine.slice(0, 40) + '…' : firstLine
}

async function countSystemTokens(
  effectiveSystemPrompt: readonly string[],
): Promise<{
  systemPromptTokens: number
  systemPromptSections: SystemPromptSectionDetail[]
}> {
  // 获取始终包含的系统上下文（gitStatus 等）
  const systemContext = await getSystemContext()

  // 构建命名条目：系统提示部分 + 系统上下文值
  // 跳过空字符串和全局缓存边界标记
  const namedEntries: Array<{ name: string; content: string }> = [
    ...effectiveSystemPrompt
      .filter(
        content =>
          content.length > 0 && content !== SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
      )
      .map(content => ({ name: extractSectionName(content), content })),
    ...Object.entries(systemContext)
      .filter(([, content]) => (content as string).length > 0)
      .map(([name, content]) => ({ name, content: content as string })),
  ]

  if (namedEntries.length < 1) {
    return { systemPromptTokens: 0, systemPromptSections: [] }
  }

  const systemTokenCounts = await Promise.all(
    namedEntries.map(({ content }) =>
      countTokensWithFallback([{ role: 'user', content }], []),
    ),
  )

  const systemPromptSections: SystemPromptSectionDetail[] = namedEntries.map(
    (entry, i) => ({
      name: entry.name,
      tokens: systemTokenCounts[i] || 0,
    }),
  )

  const systemPromptTokens = systemTokenCounts.reduce(
    (sum: number, tokens) => sum + (tokens || 0),
    0,
  )

  return { systemPromptTokens, systemPromptSections }
}

async function countMemoryFileTokens(): Promise<{
  memoryFileDetails: MemoryFile[]
  claudeMdTokens: number
}> {
  // 简单模式禁用 CLAUDE.md 加载，因此不报告它们的 tokens
  if (isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
    return { memoryFileDetails: [], claudeMdTokens: 0 }
  }

  const memoryFilesData = filterInjectedMemoryFiles(await getMemoryFiles())
  const memoryFileDetails: MemoryFile[] = []
  let claudeMdTokens = 0

  if (memoryFilesData.length < 1) {
    return {
      memoryFileDetails: [],
      claudeMdTokens: 0,
    }
  }

  const claudeMdTokenCounts = await Promise.all(
    memoryFilesData.map(async file => {
      const tokens = await countTokensWithFallback(
        [{ role: 'user', content: file.content }],
        [],
      )

      return { file, tokens: tokens || 0 }
    }),
  )

  for (const { file, tokens } of claudeMdTokenCounts) {
    claudeMdTokens += tokens
    memoryFileDetails.push({
      path: file.path,
      type: file.type,
      tokens,
    })
  }

  return { claudeMdTokens, memoryFileDetails }
}

async function countBuiltInToolTokens(
  tools: Tools,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  agentInfo: AgentDefinitionsResult | null,
  model?: string,
  messages?: Message[],
): Promise<{
  builtInToolTokens: number
  deferredBuiltinDetails: DeferredBuiltinTool[]
  deferredBuiltinTokens: number
  systemToolDetails: SystemToolDetail[]
}> {
  const builtInTools = tools.filter(tool => !tool.isMcp)
  if (builtInTools.length < 1) {
    return {
      builtInToolTokens: 0,
      deferredBuiltinDetails: [],
      deferredBuiltinTokens: 0,
      systemToolDetails: [],
    }
  }

  // 检查工具搜索是否启用
  const { isSearchExtraToolsEnabled } = await import('./searchExtraTools.js')
  const { isDeferredTool } = await import(
    '@claude-code-best/builtin-tools/tools/SearchExtraToolsTool/prompt.js'
  )
  const isDeferred = await isSearchExtraToolsEnabled(
    model ?? '',
    tools,
    getToolPermissionContext,
    agentInfo?.activeAgents ?? [],
    'analyzeBuiltIn',
  )

  // 使用动态 isDeferredTool 检查分离始终加载和延迟的内置工具
  const alwaysLoadedTools = builtInTools.filter(t => !isDeferredTool(t))
  const deferredBuiltinTools = builtInTools.filter(t => isDeferredTool(t))

  // 计算始终加载的工具
  const alwaysLoadedTokens =
    alwaysLoadedTools.length > 0
      ? await countToolDefinitionTokens(
          alwaysLoadedTools,
          getToolPermissionContext,
          agentInfo,
          model,
        )
      : 0

  // 为始终加载的工具构建每个工具的细分（Ant 专属，基于
  // 粗略模式大小估计的比例分割批量计数）。排除
  // SkillTool，因为其 tokens 显示在单独的技能类别中。
  let systemToolDetails: SystemToolDetail[] = []
  if (process.env.USER_TYPE === 'ant') {
    const toolsForBreakdown = alwaysLoadedTools.filter(
      t => !toolMatchesName(t, SKILL_TOOL_NAME),
    )
    if (toolsForBreakdown.length > 0) {
      const estimates = toolsForBreakdown.map(t =>
        roughTokenCountEstimation(jsonStringify(t.inputSchema ?? {})),
      )
      const estimateTotal = estimates.reduce((s, e) => s + e, 0) || 1
      const distributable = Math.max(
        0,
        alwaysLoadedTokens - TOOL_TOKEN_COUNT_OVERHEAD,
      )
      systemToolDetails = toolsForBreakdown
        .map((t, i) => ({
          name: t.name,
          tokens: Math.round((estimates[i]! / estimateTotal) * distributable),
        }))
        .sort((a, b) => b.tokens - a.tokens)
    }
  }

  // 单独计算延迟的内置工具以获取详情
  const deferredBuiltinDetails: DeferredBuiltinTool[] = []
  let loadedDeferredTokens = 0
  let totalDeferredTokens = 0

  if (deferredBuiltinTools.length > 0 && isDeferred) {
    // 查找消息中已使用的延迟工具
    const loadedToolNames = new Set<string>()
    if (messages) {
      const deferredToolNameSet = new Set(deferredBuiltinTools.map(t => t.name))
      for (const msg of messages) {
        if (msg.type === 'assistant' && Array.isArray(msg.message!.content)) {
          for (const block of msg.message!.content) {
            if (
              typeof block !== 'string' &&
              'type' in block &&
              block.type === 'tool_use' &&
              'name' in block &&
              typeof block.name === 'string' &&
              deferredToolNameSet.has(block.name)
            ) {
              loadedToolNames.add(block.name)
            }
          }
        }
      }
    }

    // 计算每个延迟工具
    const tokensByTool = await Promise.all(
      deferredBuiltinTools.map(t =>
        countToolDefinitionTokens(
          [t],
          getToolPermissionContext,
          agentInfo,
          model,
        ),
      ),
    )

    for (const [i, tool] of deferredBuiltinTools.entries()) {
      const tokens = Math.max(
        0,
        (tokensByTool[i] || 0) - TOOL_TOKEN_COUNT_OVERHEAD,
      )
      const isLoaded = loadedToolNames.has(tool.name)
      deferredBuiltinDetails.push({
        name: tool.name,
        tokens,
        isLoaded,
      })
      totalDeferredTokens += tokens
      if (isLoaded) {
        loadedDeferredTokens += tokens
      }
    }
  } else if (deferredBuiltinTools.length > 0) {
    // 工具搜索未启用 - 将延迟工具计为常规工具
    const deferredTokens = await countToolDefinitionTokens(
      deferredBuiltinTools,
      getToolPermissionContext,
      agentInfo,
      model,
    )
    return {
      builtInToolTokens: alwaysLoadedTokens + deferredTokens,
      deferredBuiltinDetails: [],
      deferredBuiltinTokens: 0,
      systemToolDetails,
    }
  }

  return {
    // 延迟时，只计算始终加载的工具 + 任何已加载的延迟工具
    builtInToolTokens: alwaysLoadedTokens + loadedDeferredTokens,
    deferredBuiltinDetails,
    deferredBuiltinTokens: totalDeferredTokens - loadedDeferredTokens,
    systemToolDetails,
  }
}

function findSkillTool(tools: Tools): Tool | undefined {
  return findToolByName(tools, SKILL_TOOL_NAME)
}

async function countSlashCommandTokens(
  tools: Tools,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  agentInfo: AgentDefinitionsResult | null,
): Promise<{
  slashCommandTokens: number
  commandInfo: { totalCommands: number; includedCommands: number }
}> {
  const info = await getSlashCommandInfo(getCwd())

  const slashCommandTool = findSkillTool(tools)
  if (!slashCommandTool) {
    return {
      slashCommandTokens: 0,
      commandInfo: { totalCommands: 0, includedCommands: 0 },
    }
  }

  const slashCommandTokens = await countToolDefinitionTokens(
    [slashCommandTool],
    getToolPermissionContext,
    agentInfo,
  )

  return {
    slashCommandTokens,
    commandInfo: {
      totalCommands: info.totalCommands,
      includedCommands: info.includedCommands,
    },
  }
}

async function countSkillTokens(
  tools: Tools,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  agentInfo: AgentDefinitionsResult | null,
): Promise<{
  skillTokens: number
  skillInfo: {
    totalSkills: number
    includedSkills: number
    skillFrontmatter: SkillFrontmatter[]
  }
}> {
  try {
    const skills = await getLimitedSkillToolCommands(getCwd())

    const slashCommandTool = findSkillTool(tools)
    if (!slashCommandTool) {
      return {
        skillTokens: 0,
        skillInfo: { totalSkills: 0, includedSkills: 0, skillFrontmatter: [] },
      }
    }

    // 注意：这会计算整个 SlashCommandTool（包括命令和技能）。
    // 这与 countSlashCommandTokens() 计算的工具相同，但我们在此单独跟踪
    // 以用于显示目的。这些 tokens 不应添加到上下文类别
    // 以避免重复计算。
    const skillTokens = await countToolDefinitionTokens(
      [slashCommandTool],
      getToolPermissionContext,
      agentInfo,
    )

    // 基于仅前言计算每个技能的 token 估计
    // （name、description、whenToUse），因为完整内容只在调用时加载
    const skillFrontmatter: SkillFrontmatter[] = skills.map(skill => ({
      name: getCommandName(skill),
      source: (skill.type === 'prompt' ? skill.source : 'plugin') as
        | SettingSource
        | 'plugin',
      tokens: estimateSkillFrontmatterTokens(skill),
    }))

    return {
      skillTokens,
      skillInfo: {
        totalSkills: skills.length,
        includedSkills: skills.length,
        skillFrontmatter,
      },
    }
  } catch (error) {
    logError(toError(error))

    // 返回零值而不是使整个上下文分析失败
    return {
      skillTokens: 0,
      skillInfo: { totalSkills: 0, includedSkills: 0, skillFrontmatter: [] },
    }
  }
}

export async function countMcpToolTokens(
  tools: Tools,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  agentInfo: AgentDefinitionsResult | null,
  model: string,
  messages?: Message[],
): Promise<{
  mcpToolTokens: number
  mcpToolDetails: McpTool[]
  deferredToolTokens: number
  loadedMcpToolNames: Set<string>
}> {
  const mcpTools = tools.filter(tool => tool.isMcp)
  const mcpToolDetails: McpTool[] = []
  // 对所有 MCP 工具进行一次批量 API 调用（而不是 N 次单独调用）
  const totalTokensRaw = await countToolDefinitionTokens(
    mcpTools,
    getToolPermissionContext,
    agentInfo,
    model,
  )
  // 减去单次开销，因为我们进行了一次批量调用
  const totalTokens = Math.max(
    0,
    (totalTokensRaw || 0) - TOOL_TOKEN_COUNT_OVERHEAD,
  )

  // 使用本地估计估算每个工具的比例以用于显示。
  // 包括 name + description + input schema 以匹配 toolToAPISchema
  // 发送的内容 —— 否则具有相似模式但不同描述的工具
  // 会获得相同的计数（MCP 工具共享相同的基础 Zod inputSchema）。
  const estimates = await Promise.all(
    mcpTools.map(async t =>
      roughTokenCountEstimation(
        jsonStringify({
          name: t.name,
          description: await t.prompt({
            getToolPermissionContext,
            tools,
            agents: agentInfo?.activeAgents ?? [],
          }),
          input_schema: t.inputJSONSchema ?? {},
        }),
      ),
    ),
  )
  const estimateTotal = estimates.reduce((s, e) => s + e, 0) || 1
  const mcpToolTokensByTool = estimates.map(e =>
    Math.round((e / estimateTotal) * totalTokens),
  )

  // 检查工具搜索是否启用 - 如果启用，MCP 工具是延迟的
  // isSearchExtraToolsEnabled 在内部处理 TstAuto 模式的阈值计算
  const { isSearchExtraToolsEnabled } = await import('./searchExtraTools.js')
  const { isDeferredTool } = await import(
    '@claude-code-best/builtin-tools/tools/SearchExtraToolsTool/prompt.js'
  )

  const isDeferred = await isSearchExtraToolsEnabled(
    model,
    tools,
    getToolPermissionContext,
    agentInfo?.activeAgents ?? [],
    'analyzeMcp',
  )

  // 查找消息中已使用的 MCP 工具（通过 SearchExtraToolsTool 加载）
  const loadedMcpToolNames = new Set<string>()
  if (isDeferred && messages) {
    const mcpToolNameSet = new Set(mcpTools.map(t => t.name))
    for (const msg of messages) {
      if (msg.type === 'assistant' && Array.isArray(msg.message!.content)) {
        for (const block of msg.message!.content) {
          if (
            typeof block !== 'string' &&
            'type' in block &&
            block.type === 'tool_use' &&
            'name' in block &&
            typeof block.name === 'string' &&
            mcpToolNameSet.has(block.name)
          ) {
            loadedMcpToolNames.add(block.name)
          }
        }
      }
    }
  }

  // 使用 isLoaded 标志构建工具详情
  for (const [i, tool] of mcpTools.entries()) {
    mcpToolDetails.push({
      name: tool.name,
      serverName: tool.name.split('__')[1] || 'unknown',
      tokens: mcpToolTokensByTool[i]!,
      isLoaded: loadedMcpToolNames.has(tool.name) || !isDeferredTool(tool),
    })
  }

  // 计算已加载与延迟的 tokens
  let loadedTokens = 0
  let deferredTokens = 0
  for (const detail of mcpToolDetails) {
    if (detail.isLoaded) {
      loadedTokens += detail.tokens
    } else if (isDeferred) {
      deferredTokens += detail.tokens
    }
  }

  return {
    // 延迟但某些工具已加载时，计算已加载的 tokens
    mcpToolTokens: isDeferred ? loadedTokens : totalTokens,
    mcpToolDetails,
    // 单独跟踪延迟的 tokens 以用于显示
    deferredToolTokens: deferredTokens,
    loadedMcpToolNames,
  }
}

async function countCustomAgentTokens(agentDefinitions: {
  activeAgents: AgentDefinition[]
}): Promise<{
  agentTokens: number
  agentDetails: Agent[]
}> {
  const customAgents = agentDefinitions.activeAgents.filter(
    a => a.source !== 'built-in',
  )
  const agentDetails: Agent[] = []
  let agentTokens = 0

  const tokenCounts = await Promise.all(
    customAgents.map(agent =>
      countTokensWithFallback(
        [
          {
            role: 'user',
            content: [agent.agentType, agent.whenToUse].join(' '),
          },
        ],
        [],
      ),
    ),
  )

  for (const [i, agent] of customAgents.entries()) {
    const tokens = tokenCounts[i] || 0
    agentTokens += tokens || 0
    agentDetails.push({
      agentType: agent.agentType,
      source: agent.source,
      tokens: tokens || 0,
    })
  }
  return { agentTokens, agentDetails }
}

type MessageBreakdown = {
  totalTokens: number
  toolCallTokens: number
  toolResultTokens: number
  attachmentTokens: number
  assistantMessageTokens: number
  userMessageTokens: number
  toolCallsByType: Map<string, number>
  toolResultsByType: Map<string, number>
  attachmentsByType: Map<string, number>
}

function processAssistantMessage(
  msg: AssistantMessage | NormalizedAssistantMessage,
  breakdown: MessageBreakdown,
): void {
  // 单独处理每个内容块
  const contentBlocks = Array.isArray(msg.message!.content)
    ? msg.message!.content
    : []
  for (const block of contentBlocks) {
    const blockStr = jsonStringify(block)
    const blockTokens = roughTokenCountEstimation(blockStr)

    if (
      typeof block !== 'string' &&
      'type' in block &&
      block.type === 'tool_use'
    ) {
      breakdown.toolCallTokens += blockTokens
      const toolName = ('name' in block ? block.name : undefined) || 'unknown'
      breakdown.toolCallsByType.set(
        toolName,
        (breakdown.toolCallsByType.get(toolName) || 0) + blockTokens,
      )
    } else {
      // 文本块或其他非工具内容
      breakdown.assistantMessageTokens += blockTokens
    }
  }
}

function processUserMessage(
  msg: UserMessage | NormalizedUserMessage,
  breakdown: MessageBreakdown,
  toolUseIdToName: Map<string, string>,
): void {
  // 处理字符串和数组内容
  if (typeof msg.message!.content === 'string') {
    // 简单的字符串内容
    const tokens = roughTokenCountEstimation(msg.message!.content)
    breakdown.userMessageTokens += tokens
    return
  }

  // 单独处理每个内容块
  for (const block of msg.message!.content ?? []) {
    const blockStr = jsonStringify(block)
    const blockTokens = roughTokenCountEstimation(blockStr)

    if ('type' in block && block.type === 'tool_result') {
      const toolUseId = 'tool_use_id' in block ? block.tool_use_id : undefined
      const toolName =
        (toolUseId ? toolUseIdToName.get(toolUseId) : undefined) || 'unknown'
      breakdown.toolResultsByType.set(
        toolName,
        (breakdown.toolResultsByType.get(toolName) || 0) + blockTokens,
      )
    } else {
      // 文本块或其他非工具内容
      breakdown.userMessageTokens += blockTokens
    }
  }
}

function processAttachment(
  msg: AttachmentMessage,
  breakdown: MessageBreakdown,
): void {
  const contentStr = jsonStringify(msg.attachment)
  const tokens = roughTokenCountEstimation(contentStr)
  breakdown.attachmentTokens += tokens
  const attachType = msg.attachment.type || 'unknown'
  breakdown.attachmentsByType.set(
    attachType,
    (breakdown.attachmentsByType.get(attachType) || 0) + tokens,
  )
}

async function approximateMessageTokens(
  messages: Message[],
): Promise<MessageBreakdown> {
  const microcompactResult = await microcompactMessages(messages)

  // 初始化跟踪
  const breakdown: MessageBreakdown = {
    totalTokens: 0,
    toolCallTokens: 0,
    toolResultTokens: 0,
    attachmentTokens: 0,
    assistantMessageTokens: 0,
    userMessageTokens: 0,
    toolCallsByType: new Map<string, number>(),
    toolResultsByType: new Map<string, number>(),
    attachmentsByType: new Map<string, number>(),
  }

  // 构建 tool_use_id 到 tool_name 的映射以便查找
  const toolUseIdToName = new Map<string, string>()
  for (const msg of microcompactResult.messages) {
    if (msg.type === 'assistant' && Array.isArray(msg.message!.content)) {
      for (const block of msg.message!.content) {
        if (
          typeof block !== 'string' &&
          'type' in block &&
          block.type === 'tool_use'
        ) {
          const toolUseId = 'id' in block ? (block.id as string) : undefined
          const toolName =
            (('name' in block ? block.name : undefined) as
              | string
              | undefined) || 'unknown'
          if (toolUseId) {
            toolUseIdToName.set(toolUseId, toolName)
          }
        }
      }
    }
  }

  // 处理每条消息以获取详细细分
  for (const msg of microcompactResult.messages) {
    if (msg.type === 'assistant') {
      processAssistantMessage(msg as AssistantMessage, breakdown)
    } else if (msg.type === 'user') {
      processUserMessage(msg as UserMessage, breakdown, toolUseIdToName)
    } else if (msg.type === 'attachment') {
      processAttachment(msg as AttachmentMessage, breakdown)
    }
  }

  // 使用 API 计算总 tokens 以提高准确性
  const approximateMessageTokens = await countTokensWithFallback(
    normalizeMessagesForAPI(microcompactResult.messages).map(_ => {
      if (_.type === 'assistant') {
        return {
          // 重要：去除 id 等字段 —— 如果存在，计数 API 会报错
          role: 'assistant' as const,
          content: _.message.content,
        }
      }
      return _.message
    }) as Anthropic.Beta.Messages.BetaMessageParam[],
    [],
  )

  breakdown.totalTokens = approximateMessageTokens ?? 0
  return breakdown
}

export async function analyzeContextUsage(
  messages: Message[],
  model: string,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  tools: Tools,
  agentDefinitions: AgentDefinitionsResult,
  terminalWidth?: number,
  toolUseContext?: Pick<ToolUseContext, 'options'>,
  mainThreadAgentDefinition?: AgentDefinition,
  /** microcompact 之前的原始消息，用于提取 API 使用量 */
  originalMessages?: Message[],
): Promise<ContextData> {
  const runtimeModel = getRuntimeMainLoopModel({
    permissionMode: (await getToolPermissionContext()).mode,
    mainLoopModel: model,
  })
  // 获取上下文窗口大小
  const contextWindow = getContextWindowForModel(runtimeModel, getSdkBetas())

  // 使用共享工具函数构建有效的系统提示
  const defaultSystemPrompt = await getSystemPrompt(tools, runtimeModel)
  const effectiveSystemPrompt = buildEffectiveSystemPrompt({
    mainThreadAgentDefinition,
    toolUseContext: toolUseContext ?? {
      options: {} as ToolUseContext['options'],
    },
    customSystemPrompt: toolUseContext?.options.customSystemPrompt,
    defaultSystemPrompt,
    appendSystemPrompt: toolUseContext?.options.appendSystemPrompt,
  })

  // 不应因技能而失败的关键操作
  const [
    { systemPromptTokens, systemPromptSections },
    { claudeMdTokens, memoryFileDetails },
    {
      builtInToolTokens,
      deferredBuiltinDetails,
      deferredBuiltinTokens,
      systemToolDetails,
    },
    { mcpToolTokens, mcpToolDetails, deferredToolTokens },
    { agentTokens, agentDetails },
    { slashCommandTokens, commandInfo },
    messageBreakdown,
  ] = await Promise.all([
    countSystemTokens(effectiveSystemPrompt),
    countMemoryFileTokens(),
    countBuiltInToolTokens(
      tools,
      getToolPermissionContext,
      agentDefinitions,
      runtimeModel,
      messages,
    ),
    countMcpToolTokens(
      tools,
      getToolPermissionContext,
      agentDefinitions,
      runtimeModel,
      messages,
    ),
    countCustomAgentTokens(agentDefinitions),
    countSlashCommandTokens(tools, getToolPermissionContext, agentDefinitions),
    approximateMessageTokens(messages),
  ])

  // 单独计算技能，具有错误隔离
  const skillResult = await countSkillTokens(
    tools,
    getToolPermissionContext,
    agentDefinitions,
  )
  const skillInfo = skillResult.skillInfo
  // 使用单个技能 token 估计的总和（与详情中显示的匹配）
  // 而不是包含工具模式开销的 skillResult.skillTokens
  const skillFrontmatterTokens = skillInfo.skillFrontmatter.reduce(
    (sum, skill) => sum + skill.tokens,
    0,
  )

  const messageTokens = messageBreakdown.totalTokens

  // 检查自动压缩是否启用并计算阈值
  const isAutoCompact = isAutoCompactEnabled()
  const autoCompactThreshold = isAutoCompact
    ? getEffectiveContextWindowSize(model) - AUTOCOMPACT_BUFFER_TOKENS
    : undefined

  // 创建类别
  const cats: ContextCategory[] = []

  // 系统提示始终首先显示（固定开销）
  if (systemPromptTokens > 0) {
    cats.push({
      name: 'System prompt',
      tokens: systemPromptTokens,
      color: 'promptBorder',
    })
  }

  // 内置工具紧跟系统提示（技能在下方单独显示）
  // Ant 用户通过 systemToolDetails 获得每个工具的细分
  const systemToolsTokens = builtInToolTokens - skillFrontmatterTokens
  if (systemToolsTokens > 0) {
    cats.push({
      name:
        process.env.USER_TYPE === 'ant'
          ? '[ANT-ONLY] System tools'
          : 'System tools',
      tokens: systemToolsTokens,
      color: 'inactive',
    })
  }

  // MCP 工具在系统工具之后
  if (mcpToolTokens > 0) {
    cats.push({
      name: 'MCP tools',
      tokens: mcpToolTokens,
      color: 'cyan_FOR_SUBAGENTS_ONLY',
    })
  }

  // 显示延迟的 MCP 工具（当工具搜索启用时）
  // 这些不计入上下文使用，但我们显示它们以提高可见性
  if (deferredToolTokens > 0) {
    cats.push({
      name: 'MCP tools (deferred)',
      tokens: deferredToolTokens,
      color: 'inactive',
      isDeferred: true,
    })
  }

  // 显示延迟的内置工具（当工具搜索启用时）
  if (deferredBuiltinTokens > 0) {
    cats.push({
      name: 'System tools (deferred)',
      tokens: deferredBuiltinTokens,
      color: 'inactive',
      isDeferred: true,
    })
  }

  // 自定义 agent 在 MCP 工具之后
  if (agentTokens > 0) {
    cats.push({
      name: 'Custom agents',
      tokens: agentTokens,
      color: 'permission',
    })
  }

  // 内存文件在自定义 agent 之后
  if (claudeMdTokens > 0) {
    cats.push({
      name: 'Memory files',
      tokens: claudeMdTokens,
      color: 'claude',
    })
  }

  // 技能在内存文件之后
  if (skillFrontmatterTokens > 0) {
    cats.push({
      name: 'Skills',
      tokens: skillFrontmatterTokens,
      color: 'warning',
    })
  }

  if (messageTokens !== null && messageTokens > 0) {
    cats.push({
      name: 'Messages',
      tokens: messageTokens,
      color: 'purple_FOR_SUBAGENTS_ONLY',
    })
  }

  // 计算实际内容使用量（在添加保留缓冲区之前）
  // 从使用量计算中排除延迟类别
  const actualUsage = cats.reduce(
    (sum, cat) => sum + (cat.isDeferred ? 0 : cat.tokens),
    0,
  )

  // 消息后的保留空间（不计入向用户显示的 actualUsage）。
  // 在仅反应模式（cobalt_raccoon）下，主动自动压缩永远不会
  // 触发，保留缓冲区是假的 —— 完全跳过它，让 Free
  // 空间填充网格。feature() 守卫将标志字符串排除在
  // 外部构建之外。context-collapse（marble_origami）也是如此 —— collapse
  // 拥有阈值阶梯，自动压缩在
  // shouldAutoCompact 中被抑制，因此此处显示的 33k 缓冲区也是假的。
  let reservedTokens = 0
  let skipReservedBuffer = false
  if (feature('REACTIVE_COMPACT')) {
    if (getFeatureValue_CACHED_MAY_BE_STALE('tengu_cobalt_raccoon', false)) {
      skipReservedBuffer = true
    }
  }
  if (feature('CONTEXT_COLLAPSE')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { isContextCollapseEnabled } =
      require('../services/contextCollapse/index.js') as typeof import('../services/contextCollapse/index.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    if (isContextCollapseEnabled()) {
      skipReservedBuffer = true
    }
  }
  if (skipReservedBuffer) {
    // 没有缓冲区类别被推送 —— 反应式压缩是透明的，
    // 不需要在网格中显示保留。
  } else if (isAutoCompact && autoCompactThreshold !== undefined) {
    // 自动压缩缓冲区（来自有效上下文）
    reservedTokens = contextWindow - autoCompactThreshold
    cats.push({
      name: RESERVED_CATEGORY_NAME,
      tokens: reservedTokens,
      color: 'inactive',
    })
  } else if (!isAutoCompact) {
    // 紧凑缓冲区保留（来自实际上下文限制的 3k）
    reservedTokens = MANUAL_COMPACT_BUFFER_TOKENS
    cats.push({
      name: MANUAL_COMPACT_BUFFER_NAME,
      tokens: reservedTokens,
      color: 'inactive',
    })
  }

  // 计算空闲空间（减去实际使用量和保留缓冲区）
  const freeTokens = Math.max(0, contextWindow - actualUsage - reservedTokens)

  cats.push({
    name: 'Free space',
    tokens: freeTokens,
    color: 'promptBorder',
  })

  // 显示的总计（除空闲空间外的所有内容）
  const totalIncludingReserved = actualUsage

  // 从原始消息中提取 API 使用量（如果提供）以匹配状态行
  // 这与状态行使用相同的事实来源以保持一致
  const apiUsage = getCurrentUsage(originalMessages ?? messages)

  // 当 API 使用量可用时，使用它以匹配状态行计算
  // 状态行使用：input_tokens + cache_creation_input_tokens + cache_read_input_tokens
  const totalFromAPI = apiUsage
    ? apiUsage.input_tokens +
      apiUsage.cache_creation_input_tokens +
      apiUsage.cache_read_input_tokens
    : null

  // 如果可用则使用 API 总计，否则回退到估计总计
  const finalTotalTokens = totalFromAPI ?? totalIncludingReserved

  // 基于模型上下文窗口和终端宽度预计算网格
  // 对于窄屏幕（< 80 列），200k 模型使用 5x5，1M+ 模型使用 5x10
  // 对于普通屏幕，200k 模型使用 10x10，1M+ 模型使用 20x10
  const isNarrowScreen = terminalWidth && terminalWidth < 80
  const GRID_WIDTH =
    contextWindow >= 1000000
      ? isNarrowScreen
        ? 5
        : 20
      : isNarrowScreen
        ? 5
        : 10
  const GRID_HEIGHT = contextWindow >= 1000000 ? 10 : isNarrowScreen ? 5 : 10
  const TOTAL_SQUARES = GRID_WIDTH * GRID_HEIGHT

  // 过滤掉延迟类别 - 它们不占用实际上下文空间
  // （例如，工具搜索启用时的 MCP 工具）
  const nonDeferredCats = cats.filter(cat => !cat.isDeferred)

  // 计算每个类别的方格数（使用 rawEffectiveMax 进行可视化以显示完整上下文）
  const categorySquares = nonDeferredCats.map(cat => ({
    ...cat,
    squares:
      cat.name === 'Free space'
        ? Math.round((cat.tokens / contextWindow) * TOTAL_SQUARES)
        : Math.max(1, Math.round((cat.tokens / contextWindow) * TOTAL_SQUARES)),
    percentageOfTotal: Math.round((cat.tokens / contextWindow) * 100),
  }))

  // 为类别创建网格方格的辅助函数
  function createCategorySquares(
    category: (typeof categorySquares)[0],
  ): GridSquare[] {
    const squares: GridSquare[] = []
    const exactSquares = (category.tokens / contextWindow) * TOTAL_SQUARES
    const wholeSquares = Math.floor(exactSquares)
    const fractionalPart = exactSquares - wholeSquares

    for (let i = 0; i < category.squares; i++) {
      // 确定填充度：完整方格为 1.0，部分方格为小数部分
      let squareFullness = 1.0
      if (i === wholeSquares && fractionalPart > 0) {
        // 这是部分方格
        squareFullness = fractionalPart
      }

      squares.push({
        color: category.color,
        isFilled: true,
        categoryName: category.name,
        tokens: category.tokens,
        percentage: category.percentageOfTotal,
        squareFullness,
      })
    }

    return squares
  }

  // 将网格构建为具有完整元数据的方格数组
  const gridSquares: GridSquare[] = []

  // 为末尾放置分离保留类别（自动压缩或手动紧凑缓冲区）
  const reservedCategory = categorySquares.find(
    cat =>
      cat.name === RESERVED_CATEGORY_NAME ||
      cat.name === MANUAL_COMPACT_BUFFER_NAME,
  )
  const nonReservedCategories = categorySquares.filter(
    cat =>
      cat.name !== RESERVED_CATEGORY_NAME &&
      cat.name !== MANUAL_COMPACT_BUFFER_NAME &&
      cat.name !== 'Free space',
  )

  // 首先添加所有非保留、非空闲空间的方格
  for (const cat of nonReservedCategories) {
    const squares = createCategorySquares(cat)
    for (const square of squares) {
      if (gridSquares.length < TOTAL_SQUARES) {
        gridSquares.push(square)
      }
    }
  }

  // 计算保留需要多少方格
  const reservedSquareCount = reservedCategory ? reservedCategory.squares : 0

  // 用空闲空间填充，为末尾的保留留出空间
  const freeSpaceCat = cats.find(c => c.name === 'Free space')
  const freeSpaceTarget = TOTAL_SQUARES - reservedSquareCount

  while (gridSquares.length < freeSpaceTarget) {
    gridSquares.push({
      color: 'promptBorder',
      isFilled: true,
      categoryName: 'Free space',
      tokens: freeSpaceCat?.tokens || 0,
      percentage: freeSpaceCat
        ? Math.round((freeSpaceCat.tokens / contextWindow) * 100)
        : 0,
      squareFullness: 1.0, // 空闲空间始终为"满"
    })
  }

  // 在末尾添加保留方格
  if (reservedCategory) {
    const squares = createCategorySquares(reservedCategory)
    for (const square of squares) {
      if (gridSquares.length < TOTAL_SQUARES) {
        gridSquares.push(square)
      }
    }
  }

  // 转换为行以进行渲染
  const gridRows: GridSquare[][] = []
  for (let i = 0; i < GRID_HEIGHT; i++) {
    gridRows.push(gridSquares.slice(i * GRID_WIDTH, (i + 1) * GRID_WIDTH))
  }

  // 格式化消息细分（用于所有用户的上下文建议）
  // 合并工具调用和结果，然后获取前 5 名
  const toolsMap = new Map<
    string,
    { callTokens: number; resultTokens: number }
  >()

  // 添加调用 tokens
  for (const [name, tokens] of messageBreakdown.toolCallsByType.entries()) {
    const existing = toolsMap.get(name) || { callTokens: 0, resultTokens: 0 }
    toolsMap.set(name, { ...existing, callTokens: tokens })
  }

  // 添加结果 tokens
  for (const [name, tokens] of messageBreakdown.toolResultsByType.entries()) {
    const existing = toolsMap.get(name) || { callTokens: 0, resultTokens: 0 }
    toolsMap.set(name, { ...existing, resultTokens: tokens })
  }

  // 转换为数组并按总 tokens（调用 + 结果）排序
  const toolsByTypeArray = Array.from(toolsMap.entries())
    .map(([name, { callTokens, resultTokens }]) => ({
      name,
      callTokens,
      resultTokens,
    }))
    .sort(
      (a, b) => b.callTokens + b.resultTokens - (a.callTokens + a.resultTokens),
    )

  const attachmentsByTypeArray = Array.from(
    messageBreakdown.attachmentsByType.entries(),
  )
    .map(([name, tokens]) => ({ name, tokens }))
    .sort((a, b) => b.tokens - a.tokens)

  const formattedMessageBreakdown = {
    toolCallTokens: messageBreakdown.toolCallTokens,
    toolResultTokens: messageBreakdown.toolResultTokens,
    attachmentTokens: messageBreakdown.attachmentTokens,
    assistantMessageTokens: messageBreakdown.assistantMessageTokens,
    userMessageTokens: messageBreakdown.userMessageTokens,
    toolCallsByType: toolsByTypeArray,
    attachmentsByType: attachmentsByTypeArray,
  }

  return {
    categories: cats,
    totalTokens: finalTotalTokens,
    maxTokens: contextWindow,
    rawMaxTokens: contextWindow,
    percentage: Math.round((finalTotalTokens / contextWindow) * 100),
    gridRows,
    model: runtimeModel,
    memoryFiles: memoryFileDetails,
    mcpTools: mcpToolDetails,
    deferredBuiltinTools:
      process.env.USER_TYPE === 'ant' ? deferredBuiltinDetails : undefined,
    systemTools:
      process.env.USER_TYPE === 'ant' ? systemToolDetails : undefined,
    systemPromptSections:
      process.env.USER_TYPE === 'ant' ? systemPromptSections : undefined,
    agents: agentDetails,
    slashCommands:
      slashCommandTokens > 0
        ? {
            totalCommands: commandInfo.totalCommands,
            includedCommands: commandInfo.includedCommands,
            tokens: slashCommandTokens,
          }
        : undefined,
    skills:
      skillFrontmatterTokens > 0
        ? {
            totalSkills: skillInfo.totalSkills,
            includedSkills: skillInfo.includedSkills,
            tokens: skillFrontmatterTokens,
            skillFrontmatter: skillInfo.skillFrontmatter,
          }
        : undefined,
    autoCompactThreshold,
    isAutoCompactEnabled: isAutoCompact,
    messageBreakdown: formattedMessageBreakdown,
    apiUsage,
    ...(() => {
      if (!apiUsage) return {}
      const { calculateCacheHitRate, getCacheThreshold } =
        require('./cacheWarning.js') as typeof import('./cacheWarning.js')
      const hitRate = calculateCacheHitRate(apiUsage)
      if (hitRate === null) return {}
      return { cacheHitRate: hitRate, cacheThreshold: getCacheThreshold() }
    })(),
  }
}
