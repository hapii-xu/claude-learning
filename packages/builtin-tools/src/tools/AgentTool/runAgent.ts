import { feature } from 'bun:bundle'
import type { UUID } from 'crypto'
import { randomUUID } from 'crypto'
import uniqBy from 'lodash-es/uniqBy.js'
import { logForDebugging } from 'src/utils/debug.js'
import { getProjectRoot, getSessionId } from 'src/bootstrap/state.js'
import { getCommand, getSkillToolCommands, hasCommand } from 'src/commands.js'
import {
  DEFAULT_AGENT_PROMPT,
  enhanceSystemPromptWithEnvDetails,
} from 'src/constants/prompts.js'
import type { QuerySource } from 'src/constants/querySource.js'
import { getSystemContext, getUserContext } from 'src/context.js'
import type { CanUseToolFn } from 'src/hooks/useCanUseTool.js'
import { query } from 'src/query.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import { getDumpPromptsPath } from 'src/services/api/dumpPrompts.js'
import { cleanupAgentTracking } from 'src/services/api/promptCacheBreakDetection.js'
import {
  connectToServer,
  fetchToolsForClient,
} from 'src/services/mcp/client.js'
import { getMcpConfigByName } from 'src/services/mcp/config.js'
import type {
  MCPServerConnection,
  ScopedMcpServerConfig,
} from 'src/services/mcp/types.js'
import type { Tool, Tools, ToolUseContext } from 'src/Tool.js'
import { killShellTasksForAgent } from 'src/tasks/LocalShellTask/killShellTasks.js'
import type { Command } from 'src/types/command.js'
import type { AgentId } from 'src/types/ids.js'
import type {
  AssistantMessage,
  Message,
  ProgressMessage,
  RequestStartEvent,
  StreamEvent,
  SystemCompactBoundaryMessage,
  TombstoneMessage,
  ToolUseSummaryMessage,
  UserMessage,
} from 'src/types/message.js'
import { createAttachmentMessage } from 'src/utils/attachments.js'
import { AbortError } from 'src/utils/errors.js'
import { getDisplayPath } from 'src/utils/file.js'
import {
  cloneFileStateCache,
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
} from 'src/utils/fileStateCache.js'
import {
  type CacheSafeParams,
  createSubagentContext,
} from 'src/utils/forkedAgent.js'
import { registerFrontmatterHooks } from 'src/utils/hooks/registerFrontmatterHooks.js'
import { clearSessionHooks } from 'src/utils/hooks/sessionHooks.js'
import { executeSubagentStartHooks } from 'src/utils/hooks.js'
import { createUserMessage } from 'src/utils/messages.js'
import { getAgentModel } from 'src/utils/model/agent.js'
import { getAPIProvider } from 'src/utils/model/providers.js'
import {
  createSubagentTrace,
  endTrace,
  isLangfuseEnabled,
} from 'src/services/langfuse/index.js'
import type { ModelAlias } from 'src/utils/model/aliases.js'
import {
  clearAgentTranscriptSubdir,
  recordSidechainTranscript,
  setAgentTranscriptSubdir,
  writeAgentMetadata,
} from 'src/utils/sessionStorage.js'
import {
  isRestrictedToPluginOnly,
  isSourceAdminTrusted,
} from 'src/utils/settings/pluginOnlyPolicy.js'
import {
  asSystemPrompt,
  type SystemPrompt,
} from 'src/utils/systemPromptType.js'
import {
  isPerfettoTracingEnabled,
  registerAgent as registerPerfettoAgent,
  unregisterAgent as unregisterPerfettoAgent,
} from 'src/utils/telemetry/perfettoTracing.js'
import type { ContentReplacementState } from 'src/utils/toolResultStorage.js'
import { createAgentId } from 'src/utils/uuid.js'
import { resolveAgentTools } from './agentToolUtils.js'
import { filterIncompleteToolCalls } from './filterIncompleteToolCalls.js'
import { type AgentDefinition, isBuiltInAgent } from './loadAgentsDir.js'

export { filterIncompleteToolCalls } from './filterIncompleteToolCalls.js'

/**
 * 初始化代理特定的 MCP 服务器
 * 代理可以在其前言中定义自己的 MCP 服务器，这些服务器是
 * 父代理 MCP 客户端的补充。这些服务器在代理启动时连接，
 * 在代理完成时清理。
 *
 * @param agentDefinition 代理定义，可能包含 mcpServers
 * @param parentClients 从父上下文继承的 MCP 客户端
 * @returns 合并后的客户端（父代理 + 代理特定）、代理 MCP 工具和清理函数
 */
async function initializeAgentMcpServers(
  agentDefinition: AgentDefinition,
  parentClients: MCPServerConnection[],
): Promise<{
  clients: MCPServerConnection[]
  tools: Tools
  cleanup: () => Promise<void>
}> {
  // 如果没有定义代理特定的服务器，直接返回父客户端
  if (!agentDefinition.mcpServers?.length) {
    return {
      clients: parentClients,
      tools: [],
      cleanup: async () => {},
    }
  }

  // 当 MCP 被锁定为仅限插件时，仅为 USER-CONTROLLED 代理跳过前言 MCP 服务器。
  // Plugin、内置和 policySettings 代理是管理员信任的 — 它们的前言 MCP
  // 是管理员批准的表面的一部分。阻止它们（如最初的削减所做）会破坏
  // 合法需要 MCP 的插件代理，这与"插件提供始终加载"相矛盾。
  const agentIsAdminTrusted = isSourceAdminTrusted(agentDefinition.source)
  if (isRestrictedToPluginOnly('mcp') && !agentIsAdminTrusted) {
    logForDebugging(
      `[Agent: ${agentDefinition.agentType}] Skipping MCP servers: strictPluginOnlyCustomization locks MCP to plugin-only (agent source: ${agentDefinition.source})`,
    )
    return {
      clients: parentClients,
      tools: [],
      cleanup: async () => {},
    }
  }

  const agentClients: MCPServerConnection[] = []
  // 跟踪哪些客户端是新创建的（内联定义）与从父代理共享的
  // 只有新创建的客户端应该在代理完成时被清理
  const newlyCreatedClients: MCPServerConnection[] = []
  const agentTools: Tool[] = []

  for (const spec of agentDefinition.mcpServers) {
    let config: ScopedMcpServerConfig | null = null
    let name: string
    let isNewlyCreated = false

    if (typeof spec === 'string') {
      // 按名称引用 - 在现有的 MCP 配置中查找
      // 这使用记忆化的 connectToServer，所以我们可能会得到一个共享客户端
      name = spec
      config = getMcpConfigByName(spec)
      if (!config) {
        logForDebugging(
          `[Agent: ${agentDefinition.agentType}] MCP server not found: ${spec}`,
          { level: 'warn' },
        )
        continue
      }
    } else {
      // 内联定义为 { [name]: config }
      // 这些是代理特定的服务器，应该被清理
      const entries = Object.entries(spec)
      if (entries.length !== 1) {
        logForDebugging(
          `[Agent: ${agentDefinition.agentType}] Invalid MCP server spec: expected exactly one key`,
          { level: 'warn' },
        )
        continue
      }
      const [serverName, serverConfig] = entries[0]!
      name = serverName
      config = {
        ...serverConfig,
        scope: 'dynamic' as const,
      } as ScopedMcpServerConfig
      isNewlyCreated = true
    }

    // 连接到服务器
    const client = await connectToServer(name, config)
    agentClients.push(client)
    if (isNewlyCreated) {
      newlyCreatedClients.push(client)
    }

    // 如果已连接，获取工具
    if (client.type === 'connected') {
      const tools = await fetchToolsForClient(client)
      agentTools.push(...tools)
      logForDebugging(
        `[Agent: ${agentDefinition.agentType}] Connected to MCP server '${name}' with ${tools.length} tools`,
      )
    } else {
      logForDebugging(
        `[Agent: ${agentDefinition.agentType}] Failed to connect to MCP server '${name}': ${client.type}`,
        { level: 'warn' },
      )
    }
  }

  // 为代理特定的服务器创建清理函数
  // 只清理新创建的客户端（内联定义），不清理共享/引用的
  // 共享客户端（通过字符串名称引用）是记忆化的，被父上下文使用
  const cleanup = async () => {
    for (const client of newlyCreatedClients) {
      if (client.type === 'connected') {
        try {
          await client.cleanup()
        } catch (error) {
          logForDebugging(
            `[Agent: ${agentDefinition.agentType}] Error cleaning up MCP server '${client.name}': ${error}`,
            { level: 'warn' },
          )
        }
      }
    }
  }

  // 返回合并的客户端（父代理 + 代理特定）和代理工具
  return {
    clients: [...parentClients, ...agentClients],
    tools: agentTools,
    cleanup,
  }
}

type QueryMessage =
  | StreamEvent
  | RequestStartEvent
  | Message
  | ToolUseSummaryMessage
  | TombstoneMessage

/**
 * 类型守卫，用于检查来自 query() 的消息是否是可记录的 Message 类型。
 * 匹配我们想要记录的类型：assistant、user、progress 或 system compact_boundary。
 */
function isRecordableMessage(
  msg: QueryMessage,
): msg is
  | AssistantMessage
  | UserMessage
  | ProgressMessage
  | SystemCompactBoundaryMessage {
  return (
    msg.type === 'assistant' ||
    msg.type === 'user' ||
    msg.type === 'progress' ||
    (msg.type === 'system' &&
      'subtype' in msg &&
      msg.subtype === 'compact_boundary')
  )
}

export async function* runAgent({
  agentDefinition,
  promptMessages,
  toolUseContext,
  canUseTool,
  isAsync,
  canShowPermissionPrompts,
  forkContextMessages,
  querySource,
  override,
  model,
  maxTurns,
  preserveToolUseResults,
  availableTools,
  allowedTools,
  onCacheSafeParams,
  contentReplacementState,
  useExactTools,
  worktreePath,
  description,
  transcriptSubdir,
  onQueryProgress,
}: {
  agentDefinition: AgentDefinition
  promptMessages: Message[]
  toolUseContext: ToolUseContext
  canUseTool: CanUseToolFn
  isAsync: boolean
  /** 此代理是否可以显示权限提示。默认为 !isAsync。
   * 对于在进程中运行但共享终端的异步队友，设置为 true。 */
  canShowPermissionPrompts?: boolean
  forkContextMessages?: Message[]
  querySource: QuerySource
  override?: {
    userContext?: { [k: string]: string }
    systemContext?: { [k: string]: string }
    systemPrompt?: SystemPrompt
    abortController?: AbortController
    agentId?: AgentId
  }
  model?: ModelAlias
  maxTurns?: number
  /** 为具有可查看转录的子代理保留消息上的 toolUseResult */
  preserveToolUseResults?: boolean
  /** 为工作代理预先计算的工具池。由调用者（AgentTool.tsx）计算，
   * 以避免 runAgent 和 tools.ts 之间的循环依赖。
   * 始终包含使用工作代理自己的权限模式组装的完整工具池，
   * 独立于父代理的工具限制。 */
  availableTools: Tools
  /** 要添加到代理会话允许规则的工具权限规则。
   * 提供时，替换所有允许规则，使代理只拥有明确列出的权限
   * （父代理的批准不会泄漏）。 */
  allowedTools?: string[]
  /** 在构造代理的系统提示、上下文和工具后，使用 CacheSafeParams 调用的可选回调。
   * 后台摘要使用此回调来分叉代理的对话以进行定期进度摘要。 */
  onCacheSafeParams?: (params: CacheSafeParams) => void
  /** 从恢复的侧链转录重建的替换状态，以便相同的工具结果被
   * 重新替换（提示缓存稳定性）。省略时，createSubagentContext 克隆父代理的状态。 */
  contentReplacementState?: ContentReplacementState
  /** 为 true 时，直接使用 availableTools 而不通过 resolveAgentTools() 过滤。
   * 同时继承父代理的 thinkingConfig 和 isNonInteractiveSession 而不是覆盖它们。
   * 由 fork 子代理路径使用，以生成字节相同的 API 请求前缀以获得提示缓存命中。 */
  useExactTools?: boolean
  /** 如果代理使用 isolation: "worktree" 生成，则为 worktree 路径。
   * 持久化到元数据以便恢复时可以恢复正确的 cwd。 */
  worktreePath?: string
  /** 来自 AgentTool 输入的原始任务描述。持久化到元数据以便恢复的代理的
   * 通知可以显示原始描述。 */
  description?: string
  /** subagents/ 下的可选子目录，用于将此代理的转录与相关的分组
   * （例如，工作流子代理的 workflows/<runId>）。 */
  transcriptSubdir?: string
  /** 在 query() 产生的每条消息上触发的可选回调 — 包括 runAgent
   * 通常会丢弃的 stream_event delta。用于在长时间的单块流（例如思考）中
   * 检测活跃性，此时超过 60 秒没有 assistant 消息产生。 */
  onQueryProgress?: () => void
}): AsyncGenerator<Message, void> {
  logForDebugging(
    `[Hapii] AgentTool.runAgent 开始 type=${agentDefinition.agentType} promptMsgs=${promptMessages.length} isAsync=${isAsync}`,
    { level: 'info' },
  )
  // 跟踪子代理的使用情况以进行功能发现

  const appState = toolUseContext.getAppState()
  const permissionMode = appState.toolPermissionContext.mode
  // 始终共享到根 AppState 存储的通道。当*父代理*本身是异步代理
  // （嵌套异步→异步）时，toolUseContext.setAppState 是空操作，
  // 所以会话范围写入（hooks、bash 任务）必须通过此通道。
  const rootSetAppState =
    toolUseContext.setAppStateForTasks ?? toolUseContext.setAppState

  const resolvedAgentModel = getAgentModel(
    agentDefinition.model,
    toolUseContext.options.mainLoopModel,
    model,
    permissionMode,
  )

  const agentId = override?.agentId ? override.agentId : createAgentId()

  // 如果请求，将此代理的转录路由到分组子目录
  // （例如，工作流子代理写入 subagents/workflows/<runId>/）。
  if (transcriptSubdir) {
    setAgentTranscriptSubdir(agentId, transcriptSubdir)
  }

  // 在 Perfetto 跟踪中注册代理以进行层次结构可视化
  if (isPerfettoTracingEnabled()) {
    const parentId = toolUseContext.agentId ?? getSessionId()
    registerPerfettoAgent(agentId, agentDefinition.agentType, parentId)
  }

  // 记录子代理的 API 调用路径（仅限 ant）
  if (process.env.USER_TYPE === 'ant') {
    logForDebugging(
      `[Subagent ${agentDefinition.agentType}] API calls: ${getDisplayPath(getDumpPromptsPath(agentId))}`,
    )
  }

  // 处理消息分叉以共享上下文
  // 从父消息中过滤掉不完整的工具调用以避免 API 错误
  const contextMessages: Message[] = forkContextMessages
    ? filterIncompleteToolCalls(forkContextMessages)
    : []
  const initialMessages: Message[] = [...contextMessages, ...promptMessages]

  const agentReadFileState =
    forkContextMessages !== undefined
      ? cloneFileStateCache(toolUseContext.readFileState)
      : createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE)

  const [baseUserContext, baseSystemContext] = await Promise.all([
    override?.userContext ?? getUserContext(),
    override?.systemContext ?? getSystemContext(),
  ])

  // 只读代理（Explore、Plan）不会根据 CLAUDE.md 中的
  // 提交/PR/lint 规则执行操作 — 主代理有完整上下文并解释它们的输出。
  // 在此处删除 claudeMd 可以每周节省约 5-15 Gtok（超过 3400 万次 Explore 生成）。
  // 调用者的显式 override.userContext 保持不变。
  // Kill-switch 默认为 true；设置 tengu_slim_subagent_claudemd=false 可以恢复。
  const shouldOmitClaudeMd =
    agentDefinition.omitClaudeMd &&
    !override?.userContext &&
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_slim_subagent_claudemd', true)
  const { claudeMd: _omittedClaudeMd, ...userContextNoClaudeMd } =
    baseUserContext
  const resolvedUserContext = shouldOmitClaudeMd
    ? userContextNoClaudeMd
    : baseUserContext

  // Explore/Plan 是只读搜索代理 — 父会话启动时的
  // gitStatus（最多 40KB，明确标记为过时）是无效负载。如果它们
  // 需要 git 信息，它们会自己运行 `git status` 并获取新鲜数据。
  // 每周在全舰队范围内节省约 1-3 Gtok。
  const { gitStatus: _omittedGitStatus, ...systemContextNoGit } =
    baseSystemContext
  const resolvedSystemContext =
    agentDefinition.agentType === 'Explore' ||
    agentDefinition.agentType === 'Plan'
      ? systemContextNoGit
      : baseSystemContext

  // 如果代理定义了权限模式，则覆盖权限模式
  // 但是，如果父代理处于 bypassPermissions 或 acceptEdits 模式，则不要覆盖 — 那些应该始终优先
  // 对于异步代理，还要设置 shouldAvoidPermissionPrompts，因为它们无法显示 UI
  const agentPermissionMode = agentDefinition.permissionMode
  const agentGetAppState = () => {
    const state = toolUseContext.getAppState()
    let toolPermissionContext = state.toolPermissionContext

    // 如果代理定义了权限模式，则覆盖权限模式（除非父代理是 bypassPermissions、acceptEdits 或 auto）
    if (
      agentPermissionMode &&
      state.toolPermissionContext.mode !== 'bypassPermissions' &&
      state.toolPermissionContext.mode !== 'acceptEdits' &&
      !(
        feature('TRANSCRIPT_CLASSIFIER') &&
        state.toolPermissionContext.mode === 'auto'
      )
    ) {
      toolPermissionContext = {
        ...toolPermissionContext,
        mode: agentPermissionMode,
      }
    }

    // 为无法显示 UI 的代理设置标志以自动拒绝提示
    // 使用显式提供的 canShowPermissionPrompts，否则：
    //   - bubble 模式：始终显示提示（冒泡到父终端）
    //   - 默认：!isAsync（同步代理显示提示，异步代理不显示）
    const shouldAvoidPrompts =
      canShowPermissionPrompts !== undefined
        ? !canShowPermissionPrompts
        : agentPermissionMode === 'bubble'
          ? false
          : isAsync
    if (shouldAvoidPrompts) {
      toolPermissionContext = {
        ...toolPermissionContext,
        shouldAvoidPermissionPrompts: true,
      }
    }

    // 对于可以显示提示的后台代理，在显示权限对话框之前
    // 等待自动检查（分类器、权限钩子）。
    // 由于这些是后台代理，等待是可以的 — 用户应该
    // 只在自动检查无法解决权限时才被中断。
    // 这适用于 bubble 模式（始终）和显式 canShowPermissionPrompts。
    if (isAsync && !shouldAvoidPrompts) {
      toolPermissionContext = {
        ...toolPermissionContext,
        awaitAutomatedChecksBeforeDialog: true,
      }
    }

    // 范围工具权限：当提供 allowedTools 时，将它们用作会话规则。
    // 重要：保留 cliArg 规则（来自 SDK 的 --allowedTools），因为这些是
    // SDK 使用者的显式权限，应该应用于所有代理。
    // 只清除父代理的会话级规则以防止意外泄漏。
    if (allowedTools !== undefined) {
      toolPermissionContext = {
        ...toolPermissionContext,
        alwaysAllowRules: {
          // 保留来自 --allowedTools 的 SDK 级权限
          cliArg: state.toolPermissionContext.alwaysAllowRules.cliArg,
          // 使用提供的 allowedTools 作为会话级权限
          session: [...allowedTools],
        },
      }
    }

    // 如果代理定义了努力级别，则覆盖努力级别
    const effortValue =
      agentDefinition.effort !== undefined
        ? agentDefinition.effort
        : state.effortValue

    if (
      toolPermissionContext === state.toolPermissionContext &&
      effortValue === state.effortValue
    ) {
      return state
    }
    return {
      ...state,
      toolPermissionContext,
      effortValue,
    }
  }

  const resolvedTools = useExactTools
    ? availableTools
    : resolveAgentTools(agentDefinition, availableTools, isAsync).resolvedTools

  const additionalWorkingDirectories = Array.from(
    appState.toolPermissionContext.additionalWorkingDirectories.keys(),
  )

  const agentSystemPrompt = override?.systemPrompt
    ? override.systemPrompt
    : asSystemPrompt(
        await getAgentSystemPrompt(
          agentDefinition,
          toolUseContext,
          resolvedAgentModel,
          additionalWorkingDirectories,
          resolvedTools,
        ),
      )

  // 确定 abortController：
  // - 覆盖优先
  // - 异步代理获得新的未链接控制器（独立运行）
  // - 同步代理共享父代理的控制器
  const agentAbortController = override?.abortController
    ? override.abortController
    : isAsync
      ? new AbortController()
      : toolUseContext.abortController

  // 执行 SubagentStart 钩子并收集额外的上下文
  const additionalContexts: string[] = []
  for await (const hookResult of executeSubagentStartHooks(
    agentId,
    agentDefinition.agentType,
    agentAbortController.signal,
  )) {
    if (
      hookResult.additionalContexts &&
      hookResult.additionalContexts.length > 0
    ) {
      additionalContexts.push(...hookResult.additionalContexts)
    }
  }

  // 将 SubagentStart 钩子上下文作为用户消息添加（与 SessionStart/UserPromptSubmit 一致）
  if (additionalContexts.length > 0) {
    const contextMessage = createAttachmentMessage({
      type: 'hook_additional_context',
      content: additionalContexts,
      hookName: 'SubagentStart',
      toolUseID: randomUUID(),
      hookEvent: 'SubagentStart',
    })
    initialMessages.push(contextMessage)
  }

  // 注册代理的前言钩子（限定在代理生命周期内）
  // 传递 isAgent=true 以将 Stop 钩子转换为 SubagentStop（因为子代理触发 SubagentStop）
  // 相同的管理员信任门控用于前言钩子：仅在 ["hooks"] 下
  // （skills/agents 未被锁定），用户代理仍然加载 — 阻止它们的
  // 前言钩子注册在这里，其中源是已知的，而不是
  // 在执行时全面阻止所有会话钩子（这也会杀死插件代理的钩子）。
  const hooksAllowedForThisAgent =
    !isRestrictedToPluginOnly('hooks') ||
    isSourceAdminTrusted(agentDefinition.source)
  if (agentDefinition.hooks && hooksAllowedForThisAgent) {
    registerFrontmatterHooks(
      rootSetAppState,
      agentId,
      agentDefinition.hooks,
      `agent '${agentDefinition.agentType}'`,
      true, // isAgent - converts Stop to SubagentStop
    )
  }

  // 从代理前言预加载技能
  const skillsToPreload = agentDefinition.skills ?? []
  if (skillsToPreload.length > 0) {
    const allSkills = await getSkillToolCommands(getProjectRoot())

    // 过滤有效技能并警告缺失的技能
    const validSkills: Array<{
      skillName: string
      skill: (typeof allSkills)[0] & { type: 'prompt' }
    }> = []

    for (const skillName of skillsToPreload) {
      // 解析技能名称，尝试多种策略：
      // 1. 精确匹配（hasCommand 检查 name、userFacingName、aliases）
      // 2. 使用代理的插件前缀的完全限定名（例如，"my-skill" → "plugin:my-skill"）
      // 3. 对插件命名空间技能的 ":skillName" 后缀匹配
      const resolvedName = resolveSkillName(
        skillName,
        allSkills,
        agentDefinition,
      )
      if (!resolvedName) {
        logForDebugging(
          `[Agent: ${agentDefinition.agentType}] Warning: Skill '${skillName}' specified in frontmatter was not found`,
          { level: 'warn' },
        )
        continue
      }

      const skill = getCommand(resolvedName, allSkills)
      if (skill.type !== 'prompt') {
        logForDebugging(
          `[Agent: ${agentDefinition.agentType}] Warning: Skill '${skillName}' is not a prompt-based skill`,
          { level: 'warn' },
        )
        continue
      }
      validSkills.push({ skillName, skill })
    }

    // 并发加载所有技能内容并添加到初始消息
    const { formatSkillLoadingMetadata } = await import(
      'src/utils/processUserInput/processSlashCommand.js'
    )
    const loaded = await Promise.all(
      validSkills.map(async ({ skillName, skill }) => ({
        skillName,
        skill,
        content: await skill.getPromptForCommand('', toolUseContext),
      })),
    )
    for (const { skillName, skill, content } of loaded) {
      logForDebugging(
        `[Agent: ${agentDefinition.agentType}] Preloaded skill '${skillName}'`,
      )

      // 添加 command-message 元数据以便 UI 显示正在加载哪个技能
      const metadata = formatSkillLoadingMetadata(
        skillName,
        skill.progressMessage,
      )

      initialMessages.push(
        createUserMessage({
          content: [{ type: 'text', text: metadata }, ...content],
          isMeta: true,
        }),
      )
    }
  }

  // 初始化代理特定的 MCP 服务器（添加到父代理的服务器）
  logForDebugging(
    `[Hapii] AgentTool.initMcp 开始 type=${agentDefinition.agentType}`,
    { level: 'info' },
  )
  const {
    clients: mergedMcpClients,
    tools: agentMcpTools,
    cleanup: mcpCleanup,
  } = await initializeAgentMcpServers(
    agentDefinition,
    toolUseContext.options.mcpClients,
  )

  // 将代理 MCP 工具与解析的代理工具合并，按名称去重。
  // resolvedTools 已经去重（参见 resolveAgentTools），所以当没有代理特定的 MCP 工具时，
  // 跳过 spread + uniqBy 的开销。
  const allTools =
    agentMcpTools.length > 0
      ? uniqBy([...resolvedTools, ...agentMcpTools], 'name')
      : resolvedTools

  // 构建代理特定的选项
  const agentOptions: ToolUseContext['options'] = {
    isNonInteractiveSession: useExactTools
      ? toolUseContext.options.isNonInteractiveSession
      : isAsync
        ? true
        : (toolUseContext.options.isNonInteractiveSession ?? false),
    appendSystemPrompt: toolUseContext.options.appendSystemPrompt,
    tools: allTools,
    commands: [],
    debug: toolUseContext.options.debug,
    verbose: toolUseContext.options.verbose,
    mainLoopModel: resolvedAgentModel,
    // 对于 fork 子进程（useExactTools），继承思考配置以匹配
    // 父代理的 API 请求前缀以获得提示缓存命中。对于常规
    // 子代理，禁用思考以控制输出 token 成本。
    thinkingConfig: useExactTools
      ? toolUseContext.options.thinkingConfig
      : { type: 'disabled' as const },
    mcpClients: mergedMcpClients,
    mcpResources: toolUseContext.options.mcpResources,
    agentDefinitions: toolUseContext.options.agentDefinitions,
    // Fork 子进程（useExactTools 路径）需要在 context.options 上有 querySource
    // 以便在 AgentTool.tsx call() 中的递归 fork 守卫检查 — 它检查
    // options.querySource === 'agent:builtin:fork'。这在 autocompact 后仍然有效
    // （它重写消息，而不是 context.options）。没有这个，守卫
    // 读取 undefined 并且只有消息扫描后备触发 — 而
    // autocompact 通过替换 fork-boilerplate 消息来破坏它。
    ...(useExactTools && { querySource }),
  }

  // 使用共享助手创建子代理上下文
  // - 同步代理与父代理共享 setAppState、setResponseLength、abortController
  // - 异步代理完全隔离（但具有显式未链接的 abortController）
  const agentToolUseContext = createSubagentContext(toolUseContext, {
    options: agentOptions,
    agentId,
    agentType: agentDefinition.agentType,
    messages: initialMessages,
    readFileState: agentReadFileState,
    abortController: agentAbortController,
    getAppState: agentGetAppState,
    // 同步代理与父代理共享这些回调
    shareSetAppState: !isAsync,
    shareSetResponseLength: true, // Both sync and async contribute to response metrics
    criticalSystemReminder_EXPERIMENTAL:
      agentDefinition.criticalSystemReminder_EXPERIMENTAL,
    contentReplacementState,
  })

  // 为具有可查看转录的子代理保留工具使用结果（进程内队友）
  if (preserveToolUseResults) {
    agentToolUseContext.preserveToolUseResults = true
  }

  // 为后台摘要公开缓存安全参数（提示缓存共享）
  if (onCacheSafeParams) {
    onCacheSafeParams({
      systemPrompt: agentSystemPrompt,
      userContext: resolvedUserContext,
      systemContext: resolvedSystemContext,
      toolUseContext: agentToolUseContext,
      forkContextMessages: initialMessages,
    })
  }

  // 在查询循环开始前记录初始消息，以及 agentType
  // 以便在省略 subagent_type 时恢复可以正确路由。两次写入
  // 都是即发即弃 — 持久化失败不应阻止代理。
  void recordSidechainTranscript(initialMessages, agentId).catch(_err =>
    logForDebugging(`Failed to record sidechain transcript: ${_err}`),
  )
  void writeAgentMetadata(agentId, {
    agentType: agentDefinition.agentType,
    ...(worktreePath && { worktreePath }),
    ...(description && { description }),
  }).catch(_err => logForDebugging(`Failed to write agent metadata: ${_err}`))

  // 跟踪最后记录的消息 UUID 以保持父链连续性
  let lastRecordedUuid: UUID | null = initialMessages.at(-1)?.uuid ?? null

  // 创建 Langfuse 子代理跟踪（如果未配置则为空操作）。
  // 子代理跟踪与父代理共享相同的 sessionId，因此 Langfuse
  // 将它们分组在同一个 Session 视图下。
  const subTrace = isLangfuseEnabled()
    ? createSubagentTrace({
        sessionId: getSessionId(),
        agentType: agentDefinition.agentType,
        agentId,
        model: resolvedAgentModel,
        provider: getAPIProvider(),
        input: initialMessages,
      })
    : null

  // 将子代理跟踪附加到 toolUseContext 以便 query() 重用
  if (subTrace) {
    agentToolUseContext.langfuseTrace = subTrace
  }

  try {
    for await (const message of query({
      messages: initialMessages,
      systemPrompt: agentSystemPrompt,
      userContext: resolvedUserContext,
      systemContext: resolvedSystemContext,
      canUseTool,
      toolUseContext: agentToolUseContext,
      querySource,
      maxTurns: maxTurns ?? agentDefinition.maxTurns,
    })) {
      onQueryProgress?.()
      // 将子代理 API 请求开始转发到父代理的指标显示
      // 以便在子代理执行期间更新 TTFT/OTPS。
      if (
        message.type === 'stream_event' &&
        (message as any).event.type === 'message_start' &&
        (message as any).ttftMs != null
      ) {
        toolUseContext.pushApiMetricsEntry?.((message as any).ttftMs)
        continue
      }

      // 产生 attachment 消息（例如，structured_output）而不记录它们
      if (message.type === 'attachment') {
        // 处理来自 query.ts 的最大轮次达到信号
        if ((message as any).attachment.type === 'max_turns_reached') {
          logForDebugging(
            `[Agent
: $
{
  agentDefinition.agentType
}
] Reached max turns limit ($
{
  (message as any).attachment.maxTurns
}
)`,
          )
          break
        }
        yield message as Message
        continue
      }

      if (isRecordableMessage(message)) {
        // 只记录新消息，具有正确的父消息（每条消息 O(1)）
        await recordSidechainTranscript(
          [message],
          agentId,
          lastRecordedUuid,
        ).catch(err =>
          logForDebugging(`Failed to record sidechain transcript: ${err}`),
        )
        if (message.type !== 'progress') {
          lastRecordedUuid = message.uuid
        }
        yield message
      }
    }

    if (agentAbortController.signal.aborted) {
      throw new AbortError()
    }

    // 运行回调（如果提供）（只有内置代理有回调）
    if (isBuiltInAgent(agentDefinition) && agentDefinition.callback) {
      agentDefinition.callback()
    }
  } finally {
    // 结束 Langfuse 子代理跟踪（如果未配置则为空操作）
    endTrace(subTrace)
    // 清理代理特定的 MCP 服务器（在正常完成、中止或错误时运行）
    await mcpCleanup()
    // 清理代理的会话钩子
    if (agentDefinition.hooks) {
      clearSessionHooks(rootSetAppState, agentId)
    }
    // 清除此代理的提示缓存跟踪状态
    if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
      cleanupAgentTracking(agentId)
    }
    // 释放克隆的文件状态缓存内存
    agentToolUseContext.readFileState.clear()
    // 释放克隆的 fork 上下文消息
    initialMessages.length = 0
    // 释放 perfetto 代理注册表条目
    unregisterPerfettoAgent(agentId)
    // 释放转录子目录映射
    clearAgentTranscriptSubdir(agentId)
    // 释放此代理的 todos 条目。没有这个，每个调用过 TodoWrite 的
    // 子代理都会在 AppState.todos 中留下一个键（即使所有项目完成后，
    // 值是 [] 但键仍然存在）。鲸鱼会话会生成数百个代理；每个孤立的
    // 键都是一个小泄漏，会累积。
    rootSetAppState(prev => {
      if (!(agentId in prev.todos)) return prev
      const { [agentId]: _removed, ...todos } = prev.todos
      return { ...prev, todos }
    })
    // 终止此代理生成的任何后台 bash 任务。没有这个，一个
    // `run_in_background` shell 循环（例如，测试 fixture fake-logs.sh）会在
    // 主会话最终退出后以 PPID=1 僵尸进程的形式存活。
    killShellTasksForAgent(agentId, toolUseContext.getAppState, rootSetAppState)
    /* eslint-disable @typescript-eslint/no-require-imports */
    if (feature('MONITOR_TOOL')) {
      const mcpMod =
        require('src/tasks/MonitorMcpTask/MonitorMcpTask.js') as typeof import('src/tasks/MonitorMcpTask/MonitorMcpTask.js')
      mcpMod.killMonitorMcpTasksForAgent(
        agentId,
        toolUseContext.getAppState,
        rootSetAppState,
      )
    }
    /* eslint-enable @typescript-eslint/no-require-imports */
  }
}

async function getAgentSystemPrompt(
  agentDefinition: AgentDefinition,
  toolUseContext: Pick<ToolUseContext, 'options'>,
  resolvedAgentModel: string,
  additionalWorkingDirectories: string[],
  resolvedTools: readonly Tool[],
): Promise<string[]> {
  const enabledToolNames = new Set(resolvedTools.map(t => t.name))
  try {
    const agentPrompt = agentDefinition.getSystemPrompt({ toolUseContext })
    const prompts = [agentPrompt]

    return await enhanceSystemPromptWithEnvDetails(
      prompts,
      resolvedAgentModel,
      additionalWorkingDirectories,
      enabledToolNames,
    )
  } catch (_error) {
    return enhanceSystemPromptWithEnvDetails(
      [DEFAULT_AGENT_PROMPT],
      resolvedAgentModel,
      additionalWorkingDirectories,
      enabledToolNames,
    )
  }
}

/**
 * 将代理前言中的技能名称解析为注册的命令名称。
 *
 * 插件技能使用命名空间名称注册（例如，"my-plugin:my-skill"）
 * 但代理使用裸名称引用它们（例如，"my-skill"）。此函数
 * 尝试多种解析策略：
 *
 * 1. 通过 hasCommand 精确匹配（name、userFacingName、aliases）
 * 2. 使用代理的插件名称作为前缀（例如，"my-skill" → "my-plugin:my-skill"）
 * 3. 后缀匹配 — 查找名称以 ":skillName" 结尾的任何命令
 */
function resolveSkillName(
  skillName: string,
  allSkills: Command[],
  agentDefinition: AgentDefinition,
): string | null {
  // 1. 直接匹配
  if (hasCommand(skillName, allSkills)) {
    return skillName
  }

  // 2. 尝试使用代理的插件名称作为前缀
  // 插件代理的 agentType 类似于 "pluginName:agentName"
  const pluginPrefix = agentDefinition.agentType.split(':')[0]
  if (pluginPrefix) {
    const qualifiedName = `${pluginPrefix}:${skillName}`
    if (hasCommand(qualifiedName, allSkills)) {
      return qualifiedName
    }
  }

  // 3. 后缀匹配 — 查找名称以 ":skillName" 结尾的技能
  const suffix = `:${skillName}`
  const match = allSkills.find(cmd => cmd.name.endsWith(suffix))
  if (match) {
    return match.name
  }

  return null
}
