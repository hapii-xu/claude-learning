import type Anthropic from '@anthropic-ai/sdk'
import type {
  BetaTool,
  BetaToolUnion,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { createHash } from 'crypto'
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from 'src/constants/prompts.js'
import { getSystemContext, getUserContext } from 'src/context.js'
import { isAnalyticsDisabled } from 'src/services/analytics/config.js'
import {
  checkStatsigFeatureGate_CACHED_MAY_BE_STALE,
  getFeatureValue_CACHED_MAY_BE_STALE,
} from 'src/services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { prefetchAllMcpResources } from 'src/services/mcp/client.js'
import type { ScopedMcpServerConfig } from 'src/services/mcp/types.js'
import { BashTool } from '@claude-code-best/builtin-tools/tools/BashTool/BashTool.js'
import { FileEditTool } from '@claude-code-best/builtin-tools/tools/FileEditTool/FileEditTool.js'
import {
  normalizeFileEditInput,
  stripTrailingWhitespace,
} from '@claude-code-best/builtin-tools/tools/FileEditTool/utils.js'
import { FileWriteTool } from '@claude-code-best/builtin-tools/tools/FileWriteTool/FileWriteTool.js'
import { getTools } from 'src/tools.js'
import type { AgentId } from 'src/types/ids.js'
import type { z } from 'zod/v4'
import { CLI_SYSPROMPT_PREFIXES } from '../constants/system.js'
import { roughTokenCountEstimation } from '../services/tokenEstimation.js'
import type { Tool, ToolPermissionContext, Tools } from '../Tool.js'
import { AGENT_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/AgentTool/constants.js'
import type { AgentDefinition } from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import { EXIT_PLAN_MODE_V2_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/ExitPlanModeTool/constants.js'
import { TASK_OUTPUT_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/TaskOutputTool/constants.js'
import type { Message } from '../types/message.js'
import { isAgentSwarmsEnabled } from './agentSwarmsEnabled.js'
import {
  modelSupportsStructuredOutputs,
  shouldUseGlobalCacheScope,
} from './betas.js'
import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import { isEnvTruthy } from './envUtils.js'
import { createUserMessage } from './messages.js'
import {
  getAPIProvider,
  isFirstPartyAnthropicBaseUrl,
} from './model/providers.js'
import {
  getFileReadIgnorePatterns,
  normalizePatternsToPath,
} from './permissions/filesystem.js'
import {
  getPlan,
  getPlanFilePath,
  persistFileSnapshotIfRemote,
} from './plans.js'
import { getPlatform } from './platform.js'
import { countFilesRoundedRg } from './ripgrep.js'
import { jsonStringify } from './slowOperations.js'
import type { SystemPrompt } from './systemPromptType.js'
import { getToolSchemaCache } from './toolSchemaCache.js'
import { windowsPathToPosixPath } from './windowsPaths.js'
import { zodToJsonSchema } from './zodToJsonSchema.js'

// 带有严格模式和 defer_loading 支持的扩展 BetaTool 类型
type BetaToolWithExtras = BetaTool & {
  strict?: boolean
  defer_loading?: boolean
  cache_control?: {
    type: 'ephemeral'
    scope?: 'global' | 'org'
    ttl?: '5m' | '1h'
  }
  eager_input_streaming?: boolean
}

export type CacheScope = 'global' | 'org'
export type SystemPromptBlock = {
  text: string
  cacheScope: CacheScope | null
}

// 当群组未启用时从工具模式中过滤的字段
const SWARM_FIELDS_BY_TOOL: Record<string, string[]> = {
  [EXIT_PLAN_MODE_V2_TOOL_NAME]: ['launchSwarm', 'teammateCount'],
  [AGENT_TOOL_NAME]: ['name', 'team_name', 'mode'],
}

/**
 * 从工具的输入模式中过滤群组相关字段。
 * 当 isAgentSwarmsEnabled() 返回 false 时在运行时调用。
 */
function filterSwarmFieldsFromSchema(
  toolName: string,
  schema: Anthropic.Tool.InputSchema,
): Anthropic.Tool.InputSchema {
  const fieldsToRemove = SWARM_FIELDS_BY_TOOL[toolName]
  if (!fieldsToRemove || fieldsToRemove.length === 0) {
    return schema
  }

  // 克隆模式以避免修改原始模式
  const filtered = { ...schema }
  const props = filtered.properties
  if (props && typeof props === 'object') {
    const filteredProps = { ...(props as Record<string, unknown>) }
    for (const field of fieldsToRemove) {
      delete filteredProps[field]
    }
    filtered.properties = filteredProps
  }

  return filtered
}

export async function toolToAPISchema(
  tool: Tool,
  options: {
    getToolPermissionContext: () => Promise<ToolPermissionContext>
    tools: Tools
    agents: AgentDefinition[]
    allowedAgentTypes?: string[]
    model?: string
    /** 当为 true 时，为此工具标记 defer_loading 以进行工具搜索 */
    deferLoading?: boolean
    cacheControl?: {
      type: 'ephemeral'
      scope?: 'global' | 'org'
      ttl?: '5m' | '1h'
    }
  },
): Promise<BetaToolUnion> {
  // 会话稳定的基础模式：name、description、input_schema、strict、
  // eager_input_streaming。这些在每个会话中计算一次并缓存，
  // 以防止会话中 GrowthBook 翻转（tengu_tool_pear、tengu_fgts）或
  // tool.prompt() 漂移导致序列化的工具数组字节不断变化。
  // 理由参见 toolSchemaCache.ts。
  //
  // 缓存键在存在时包含 inputJSONSchema。StructuredOutput 实例
  // 共享名称 'StructuredOutput'，但每个工作流调用携带不同的模式
  // —— 仅名称键控返回过时的模式（5.4% → 51% 错误率，参见
  // PR#25424）。MCP 工具也设置 inputJSONSchema，但每个都有稳定的模式，
  // 因此包含它可以保持其 GB 翻转缓存稳定性。
  const cacheKey =
    'inputJSONSchema' in tool && tool.inputJSONSchema
      ? `${tool.name}:${jsonStringify(tool.inputJSONSchema)}`
      : tool.name
  const cache = getToolSchemaCache()
  let base = cache.get(cacheKey)
  if (!base) {
    const strictToolsEnabled =
      checkStatsigFeatureGate_CACHED_MAY_BE_STALE('tengu_tool_pear')
    // 如果提供了工具的 JSON 模式则直接使用，否则转换 Zod 模式
    let input_schema = (
      'inputJSONSchema' in tool && tool.inputJSONSchema
        ? tool.inputJSONSchema
        : zodToJsonSchema(tool.inputSchema)
    ) as Anthropic.Tool.InputSchema

    // 当群组未启用时过滤掉群组相关字段
    // 这确保外部非 EAP 用户不会在模式中看到群组功能
    if (!isAgentSwarmsEnabled()) {
      input_schema = filterSwarmFieldsFromSchema(tool.name, input_schema)
    }

    base = {
      name: tool.name,
      description: await tool.prompt({
        getToolPermissionContext: options.getToolPermissionContext,
        tools: options.tools,
        agents: options.agents,
        allowedAgentTypes: options.allowedAgentTypes,
      }),
      input_schema,
    }

    // 仅在以下条件满足时添加 strict：
    // 1. 功能标志已启用
    // 2. 工具具有 strict: true
    // 3. 提供了模型且支持它（目前并非所有模型都支持）
    //    （如果未提供模型，假设我们不能使用严格工具）
    if (
      strictToolsEnabled &&
      tool.strict === true &&
      options.model &&
      modelSupportsStructuredOutputs(options.model)
    ) {
      base.strict = true
    }

    // 通过每个工具 API 字段启用细粒度工具流式传输。
    // 没有 FGTS 时，API 会在发送 input_json_delta 事件前缓冲整个工具输入参数，
    // 导致大型工具输入时挂起多分钟。限制为直接 api.anthropic.com：
    // 代理（LiteLLM 等）和 Bedrock/Vertex 与 Claude 4.5 会以 400 拒绝此字段。
    // 参见 GH#32742、PR #21729。
    if (
      getAPIProvider() === 'firstParty' &&
      isFirstPartyAnthropicBaseUrl() &&
      (getFeatureValue_CACHED_MAY_BE_STALE('tengu_fgts', false) ||
        isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING))
    ) {
      base.eager_input_streaming = true
    }

    cache.set(cacheKey, base)
  }

  // 每个请求的覆盖层：defer_loading 和 cache_control 因调用而异
  // （工具搜索每轮延迟不同的工具；缓存标记移动）。
  // 显式字段复制避免修改缓存的基础，并规避
  // BetaTool.cache_control 的 `| null` 与我们更窄类型的冲突。
  const schema: BetaToolWithExtras = {
    name: base.name,
    description: base.description,
    input_schema: base.input_schema,
    ...(base.strict && { strict: true }),
    ...(base.eager_input_streaming && { eager_input_streaming: true }),
  }

  // 如果请求则添加 defer_loading（用于工具搜索功能）
  if (options.deferLoading) {
    schema.defer_loading = true
  }

  if (options.cacheControl) {
    schema.cache_control = options.cacheControl
  }

  // CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS 是 beta API 形态的终止开关。
  // 从工具模式中剥离 defer_loading 和其他 beta 字段。
  // cache_control 在白名单中：基础 {type: 'ephemeral'} 形态是
  // 标准提示缓存（Bedrock/Vertex 支持）；beta 子字段
  // （scope、ttl）已在上游由 shouldIncludeFirstPartyOnlyBetas 门控，
  // 该函数独立遵守此终止开关。
  // github.com/anthropics/claude-code/issues/20031
  if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS)) {
    const allowed = new Set([
      'name',
      'description',
      'input_schema',
      'cache_control',
    ])
    const stripped = Object.keys(schema).filter(k => !allowed.has(k))
    if (stripped.length > 0) {
      logStripOnce(stripped)
      return {
        name: schema.name,
        description: schema.description,
        input_schema: schema.input_schema,
        ...(schema.cache_control && { cache_control: schema.cache_control }),
      }
    }
  }

  // 注意：我们转换为 BetaTool，但额外字段在运行时仍然存在
  // 并将在 API 请求中序列化，即使它们不在 SDK 的
  // BetaTool 类型定义中。这是 beta 功能的有意设计。
  return schema as BetaTool
}

let loggedStrip = false
function logStripOnce(stripped: string[]): void {
  if (loggedStrip) return
  loggedStrip = true
  logForDebugging(
    `[betas] Stripped from tool schemas: [${stripped.join(', ')}] (CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1)`,
  )
}

/**
 * 记录关于第一个块的统计信息以分析前缀匹配配置
 * （参见 https://console.statsig.com/4aF3Ewatb6xPVpCwxb5nA3/dynamic_configs/claude_cli_system_prompt_prefixes）
 */
export function logAPIPrefix(systemPrompt: SystemPrompt): void {
  const [firstSyspromptBlock] = splitSysPromptPrefix(systemPrompt)
  const firstSystemPrompt = firstSyspromptBlock?.text
  logEvent('tengu_sysprompt_block', {
    snippet: firstSystemPrompt?.slice(
      0,
      20,
    ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    length: firstSystemPrompt?.length ?? 0,
    hash: (firstSystemPrompt
      ? createHash('sha256').update(firstSystemPrompt).digest('hex')
      : '') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
}

/**
 * 按内容类型拆分系统提示块以进行 API 匹配和缓存控制。
 * 参见 https://console.statsig.com/4aF3Ewatb6xPVpCwxb5nA3/dynamic_configs/claude_cli_system_prompt_prefixes
 *
 * 行为取决于功能标志和选项：
 *
 * 1. 存在 MCP 工具（skipGlobalCacheForSystemPrompt=true）：
 *    返回最多 3 个块，具有组织级缓存（系统提示无全局缓存）：
 *    - 归因头部（cacheScope=null）
 *    - 系统提示前缀（cacheScope='org'）
 *    - 其他所有内容的连接（cacheScope='org'）
 *
 * 2. 具有边界标记的全局缓存模式（仅 1P，找到边界）：
 *    返回最多 4 个块：
 *    - 归因头部（cacheScope=null）
 *    - 系统提示前缀（cacheScope=null）
 *    - 边界前的静态内容（cacheScope='global'）
 *    - 边界后的动态内容（cacheScope=null）
 *
 * 3. 默认模式（3P 提供商，或边界缺失）：
 *    返回最多 3 个块，具有组织级缓存：
 *    - 归因头部（cacheScope=null）
 *    - 系统提示前缀（cacheScope='org'）
 *    - 其他所有内容的连接（cacheScope='org'）
 */
export function splitSysPromptPrefix(
  systemPrompt: SystemPrompt,
  options?: { skipGlobalCacheForSystemPrompt?: boolean },
): SystemPromptBlock[] {
  const useGlobalCacheFeature = shouldUseGlobalCacheScope()
  logForDebugging(
    `[Hapii][Cache] splitSysPromptPrefix: useGlobalCacheFeature=${useGlobalCacheFeature} skipGlobalCacheForSystemPrompt=${options?.skipGlobalCacheForSystemPrompt ?? false} promptBlockCount=${systemPrompt.length}`,
  )

  if (useGlobalCacheFeature && options?.skipGlobalCacheForSystemPrompt) {
    logEvent('tengu_sysprompt_using_tool_based_cache', {
      promptBlockCount: systemPrompt.length,
    })
    logForDebugging(
      `[Hapii][Cache] splitSysPromptPrefix: MODE=tool_based_cache (no global scope for system prompt)`,
    )

    // 过滤出边界标记，返回没有全局作用域的块
    let attributionHeader: string | undefined
    let systemPromptPrefix: string | undefined
    const rest: string[] = []

    for (const prompt of systemPrompt) {
      if (!prompt) continue
      if (prompt === SYSTEM_PROMPT_DYNAMIC_BOUNDARY) continue // 跳过边界
      if (prompt.startsWith('x-anthropic-billing-header')) {
        attributionHeader = prompt
      } else if (CLI_SYSPROMPT_PREFIXES.has(prompt)) {
        systemPromptPrefix = prompt
      } else {
        rest.push(prompt)
      }
    }

    const result: SystemPromptBlock[] = []
    if (attributionHeader) {
      result.push({ text: attributionHeader, cacheScope: null })
    }
    if (systemPromptPrefix) {
      result.push({ text: systemPromptPrefix, cacheScope: 'org' })
    }
    const restJoined = rest.join('\n\n')
    if (restJoined) {
      result.push({ text: restJoined, cacheScope: 'org' })
    }

    logForDebugging(
      `[Hapii][Cache] splitSysPromptPrefix: result blocks=${result.length} scopes=[${result.map(b => b.cacheScope ?? 'null').join(', ')}]`,
    )
    return result
  }

  if (useGlobalCacheFeature) {
    const boundaryIndex = systemPrompt.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
    logForDebugging(
      `[Hapii][Cache] splitSysPromptPrefix: checking for DYNAMIC_BOUNDARY at index=${boundaryIndex}`,
    )

    if (boundaryIndex !== -1) {
      let attributionHeader: string | undefined
      let systemPromptPrefix: string | undefined
      const staticBlocks: string[] = []
      const dynamicBlocks: string[] = []

      for (let i = 0; i < systemPrompt.length; i++) {
        const block = systemPrompt[i]
        if (!block || block === SYSTEM_PROMPT_DYNAMIC_BOUNDARY) continue

        if (block.startsWith('x-anthropic-billing-header')) {
          attributionHeader = block
        } else if (CLI_SYSPROMPT_PREFIXES.has(block)) {
          systemPromptPrefix = block
        } else if (i < boundaryIndex) {
          staticBlocks.push(block)
        } else {
          dynamicBlocks.push(block)
        }
      }

      const result: SystemPromptBlock[] = []
      if (attributionHeader)
        result.push({ text: attributionHeader, cacheScope: null })
      if (systemPromptPrefix)
        result.push({ text: systemPromptPrefix, cacheScope: null })
      const staticJoined = staticBlocks.join('\n\n')
      if (staticJoined)
        result.push({ text: staticJoined, cacheScope: 'global' })
      const dynamicJoined = dynamicBlocks.join('\n\n')
      if (dynamicJoined) result.push({ text: dynamicJoined, cacheScope: null })

      logForDebugging(
        `[Hapii][Cache] splitSysPromptPrefix: MODE=global_cache with boundary`,
      )
      logForDebugging(
        `[Hapii][Cache] splitSysPromptPrefix: staticBlock chars=${staticJoined.length} estTokens=~${Math.round(staticJoined.length / 4)}`,
      )
      logForDebugging(
        `[Hapii][Cache] splitSysPromptPrefix: dynamicBlock chars=${dynamicJoined.length} estTokens=~${Math.round(dynamicJoined.length / 4)}`,
      )
      logForDebugging(
        `[Hapii][Cache] splitSysPromptPrefix: result blocks=${result.length} scopes=[${result.map(b => b.cacheScope ?? 'null').join(', ')}]`,
      )

      logEvent('tengu_sysprompt_boundary_found', {
        blockCount: result.length,
        staticBlockLength: staticJoined.length,
        dynamicBlockLength: dynamicJoined.length,
      })

      return result
    } else {
      logEvent('tengu_sysprompt_missing_boundary_marker', {
        promptBlockCount: systemPrompt.length,
      })
      logForDebugging(
        `[Hapii][Cache] splitSysPromptPrefix: DYNAMIC_BOUNDARY not found, falling back to org cache`,
      )
    }
  }

  // Default mode: org-level cache
  logForDebugging(
    `[Hapii][Cache] splitSysPromptPrefix: MODE=org_cache (default/fallback)`,
  )
  let attributionHeader: string | undefined
  let systemPromptPrefix: string | undefined
  const rest: string[] = []

  for (const block of systemPrompt) {
    if (!block) continue

    if (block.startsWith('x-anthropic-billing-header')) {
      attributionHeader = block
    } else if (CLI_SYSPROMPT_PREFIXES.has(block)) {
      systemPromptPrefix = block
    } else {
      rest.push(block)
    }
  }

  const result: SystemPromptBlock[] = []
  if (attributionHeader)
    result.push({ text: attributionHeader, cacheScope: null })
  if (systemPromptPrefix)
    result.push({ text: systemPromptPrefix, cacheScope: 'org' })
  const restJoined = rest.join('\n\n')
  if (restJoined) result.push({ text: restJoined, cacheScope: 'org' })

  logForDebugging(
    `[Hapii][Cache] splitSysPromptPrefix: result blocks=${result.length} scopes=[${result.map(b => b.cacheScope ?? 'null').join(', ')}] totalChars=${restJoined.length}`,
  )
  return result
}

export function appendSystemContext(
  systemPrompt: SystemPrompt,
  context: { [k: string]: string },
): string[] {
  return [
    ...systemPrompt,
    Object.entries(context)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n'),
  ].filter(Boolean)
}

export function prependUserContext(
  messages: Message[],
  context: { [k: string]: string },
): Message[] {
  if (process.env.NODE_ENV === 'test') {
    return messages
  }

  if (Object.entries(context).length === 0) {
    return messages
  }

  // 将 claudeMd 提取为专用的高权重用户消息，这样它就不会
  // 被埋在通用的 <system-reminder> 中，带有"可能相关也可能不相关"
  // 的免责声明，否则会削弱其指令权重。
  const { claudeMd, ...rest } = context
  const result: Message[] = []

  if (claudeMd) {
    result.push(
      createUserMessage({
        content: `<project-instructions>\n${claudeMd}\n</project-instructions>\n`,
        isMeta: true,
      }),
    )
  }

  const restEntries = Object.entries(rest)
  if (restEntries.length > 0) {
    result.push(
      createUserMessage({
        content: `<system-reminder>\nAs you answer the user's questions, you can use the following context:\n${restEntries
          .map(([key, value]) => `# ${key}\n${value}`)
          .join('\n')}

      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n</system-reminder>\n`,
        isMeta: true,
      }),
    )
  }

  return [...result, ...messages]
}

/**
 * 记录关于上下文和系统提示大小的指标
 */
export async function logContextMetrics(
  mcpConfigs: Record<string, ScopedMcpServerConfig>,
  toolPermissionContext: ToolPermissionContext,
): Promise<void> {
  // 如果禁用日志记录则提前返回
  if (isAnalyticsDisabled()) {
    return
  }
  const [{ tools: mcpTools }, tools, userContext, systemContext] =
    await Promise.all([
      prefetchAllMcpResources(mcpConfigs),
      getTools(toolPermissionContext),
      getUserContext(),
      getSystemContext(),
    ])
  // 提取各个上下文大小并计算总计
  const gitStatusSize = systemContext.gitStatus?.length ?? 0
  const claudeMdSize = userContext.claudeMd?.length ?? 0

  // 计算总上下文大小
  const totalContextSize = gitStatusSize + claudeMdSize

  // 使用 ripgrep 获取文件计数（四舍五入到最接近的 10 的幂以保护隐私）
  const currentDir = getCwd()
  const ignorePatternsByRoot = getFileReadIgnorePatterns(toolPermissionContext)
  const normalizedIgnorePatterns = normalizePatternsToPath(
    ignorePatternsByRoot,
    currentDir,
  )
  const fileCount = await countFilesRoundedRg(
    currentDir,
    AbortSignal.timeout(1000),
    normalizedIgnorePatterns,
  )

  // 计算工具指标
  let mcpToolsCount = 0
  let mcpServersCount = 0
  let mcpToolsTokens = 0
  let nonMcpToolsCount = 0
  let nonMcpToolsTokens = 0

  const nonMcpTools = tools.filter(tool => !tool.isMcp)
  mcpToolsCount = mcpTools.length
  nonMcpToolsCount = nonMcpTools.length

  // 从 MCP 工具名称中提取唯一的服务器名称（格式：mcp__servername__toolname）
  const serverNames = new Set<string>()
  for (const tool of mcpTools) {
    const parts = tool.name.split('__')
    if (parts.length >= 3 && parts[1]) {
      serverNames.add(parts[1])
    }
  }
  mcpServersCount = serverNames.size

  // 在本地估算工具 tokens 以用于分析（避免每个会话 N 次 API 调用）
  // 当可用时使用 inputJSONSchema（纯 JSON Schema），否则转换 Zod 模式
  for (const tool of mcpTools) {
    const schema =
      'inputJSONSchema' in tool && tool.inputJSONSchema
        ? tool.inputJSONSchema
        : zodToJsonSchema(tool.inputSchema)
    mcpToolsTokens += roughTokenCountEstimation(jsonStringify(schema))
  }
  for (const tool of nonMcpTools) {
    const schema =
      'inputJSONSchema' in tool && tool.inputJSONSchema
        ? tool.inputJSONSchema
        : zodToJsonSchema(tool.inputSchema)
    nonMcpToolsTokens += roughTokenCountEstimation(jsonStringify(schema))
  }

  logEvent('tengu_context_size', {
    git_status_size: gitStatusSize,
    claude_md_size: claudeMdSize,
    total_context_size: totalContextSize,
    project_file_count_rounded: fileCount,
    mcp_tools_count: mcpToolsCount,
    mcp_servers_count: mcpServersCount,
    mcp_tools_tokens: mcpToolsTokens,
    non_mcp_tools_count: nonMcpToolsCount,
    non_mcp_tools_tokens: nonMcpToolsTokens,
  })
}

// TODO: 将此泛化到所有工具
export function normalizeToolInput<T extends Tool>(
  tool: T,
  input: z.infer<T['inputSchema']>,
  agentId?: AgentId,
): z.infer<T['inputSchema']> {
  switch (tool.name) {
    case EXIT_PLAN_MODE_V2_TOOL_NAME: {
      // 始终为 ExitPlanModeV2 注入计划内容和文件路径，以便 hooks/SDK 获取计划。
      // V2 工具从文件而不是输入中读取计划，但 hooks/SDK
      const plan = getPlan(agentId)
      const planFilePath = getPlanFilePath(agentId)
      // 为 CCR 会话持久化文件快照，以便计划在 pod 回收中存活
      void persistFileSnapshotIfRemote()
      return plan !== null ? { ...input, plan, planFilePath } : input
    }
    case BashTool.name: {
      // 在上游已验证，不会抛出
      const parsed = BashTool.inputSchema.parse(input)
      const { command, timeout, description } = parsed
      const cwd = getCwd()
      let normalizedCommand = command.replace(`cd ${cwd} && `, '')
      if (getPlatform() === 'windows') {
        normalizedCommand = normalizedCommand.replace(
          `cd ${windowsPathToPosixPath(cwd)} && `,
          '',
        )
      }

      // 将 \\; 替换为 \;（find -exec 命令常用）
      normalizedCommand = normalizedCommand.replace(/\\\\;/g, '\\;')

      // 仅回显字符串的命令的日志记录。这有助于我们了解 Claude 通过 bash 对话的频率
      if (/^echo\s+["']?[^|&;><]*["']?$/i.test(normalizedCommand.trim())) {
        logEvent('tengu_bash_tool_simple_echo', {})
      }

      // 检查 run_in_background（如果设置了 CLAUDE_CODE_DISABLE_BACKGROUND_TASKS，模式中可能不存在）
      const run_in_background =
        'run_in_background' in parsed ? parsed.run_in_background : undefined

      // 安全性：转换是安全的，因为输入已通过上面的 .parse() 验证。
      // TypeScript 无法基于 switch(tool.name) 缩小泛型 T 的范围，因此它
      // 不知道返回类型是否匹配 T['inputSchema']。这是泛型的
      // TS 基本限制，没有重大重构就无法绕过。
      return {
        command: normalizedCommand,
        description,
        ...(timeout !== undefined && { timeout }),
        ...(description !== undefined && { description }),
        ...(run_in_background !== undefined && { run_in_background }),
        ...('dangerouslyDisableSandbox' in parsed &&
          parsed.dangerouslyDisableSandbox !== undefined && {
            dangerouslyDisableSandbox: parsed.dangerouslyDisableSandbox,
          }),
      } as z.infer<T['inputSchema']>
    }
    case FileEditTool.name: {
      // 在上游已验证，不会抛出
      const parsedInput = FileEditTool.inputSchema.parse(input)

      // 这是 Claude 看不到的 token 的解决方法
      const { file_path, edits } = normalizeFileEditInput({
        file_path: parsedInput.file_path,
        edits: [
          {
            old_string: parsedInput.old_string,
            new_string: parsedInput.new_string,
            replace_all: parsedInput.replace_all,
          },
        ],
      })

      // 安全性：参见上方 BashTool 分支的注释
      return {
        replace_all: edits[0]!.replace_all,
        file_path,
        old_string: edits[0]!.old_string,
        new_string: edits[0]!.new_string,
      } as z.infer<T['inputSchema']>
    }
    case FileWriteTool.name: {
      // 在上游已验证，不会抛出
      const parsedInput = FileWriteTool.inputSchema.parse(input)

      // Markdown 使用两个尾随空格作为硬换行 —— 不要去除。
      const isMarkdown = /\.(md|mdx)$/i.test(parsedInput.file_path)

      // 安全性：参见上方 BashTool 分支的注释
      return {
        file_path: parsedInput.file_path,
        content: isMarkdown
          ? parsedInput.content
          : stripTrailingWhitespace(parsedInput.content),
      } as z.infer<T['inputSchema']>
    }
    case TASK_OUTPUT_TOOL_NAME: {
      // 规范化来自 AgentOutputTool/BashOutputTool 的旧参数名
      const legacyInput = input as Record<string, unknown>
      const taskId =
        legacyInput.task_id ?? legacyInput.agentId ?? legacyInput.bash_id
      const timeout =
        legacyInput.timeout ??
        (typeof legacyInput.wait_up_to === 'number'
          ? legacyInput.wait_up_to * 1000
          : undefined)
      // 安全性：参见上方 BashTool 分支的注释
      return {
        task_id: taskId ?? '',
        block: legacyInput.block ?? true,
        timeout: timeout ?? 30000,
      } as z.infer<T['inputSchema']>
    }
    default:
      return input
  }
}

// 去除 normalizeToolInput 添加的字段，然后再发送到 API
//（例如，ExitPlanModeV2 的 plan 字段，其输入 schema 为空对象）
export function normalizeToolInputForAPI<T extends Tool>(
  tool: T,
  input: z.infer<T['inputSchema']>,
): z.infer<T['inputSchema']> {
  switch (tool.name) {
    case EXIT_PLAN_MODE_V2_TOOL_NAME: {
      // 发送到 API 前去除注入的字段（schema 期望空对象）
      if (
        input &&
        typeof input === 'object' &&
        ('plan' in input || 'planFilePath' in input)
      ) {
        const { plan, planFilePath, ...rest } = input as Record<string, unknown>
        return rest as z.infer<T['inputSchema']>
      }
      return input
    }
    case FileEditTool.name: {
      // 从旧会话中去除合成的 old_string/new_string/replace_all
      // 这些会话是从 PR #20357 之前的转录恢复的，当时
      // normalizeToolInput 会合成这些字段。需要确保旧的
      // --resume 转录不会将整个文件副本发送到 API。
      // 新会话不需要此处理（合成已移至发送时）。
      if (input && typeof input === 'object' && 'edits' in input) {
        const { old_string, new_string, replace_all, ...rest } =
          input as Record<string, unknown>
        return rest as z.infer<T['inputSchema']>
      }
      return input
    }
    default:
      return input
  }
}
