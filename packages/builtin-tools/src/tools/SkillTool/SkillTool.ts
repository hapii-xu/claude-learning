import { feature } from 'bun:bundle'
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import uniqBy from 'lodash-es/uniqBy.js'
import { dirname } from 'path'
import { getProjectRoot } from 'src/bootstrap/state.js'
import {
  builtInCommandNames,
  findCommand,
  getCommands,
  type PromptCommand,
} from 'src/commands.js'
import type {
  Tool,
  ToolCallProgress,
  ToolResult,
  ToolUseContext,
  ValidationResult,
} from 'src/Tool.js'
import { buildTool, type ToolDef } from 'src/Tool.js'
import type { Command } from 'src/types/command.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  SystemMessage,
  UserMessage,
} from 'src/types/message.js'
import { logForDebugging } from 'src/utils/debug.js'
import type { PermissionDecision } from 'src/utils/permissions/PermissionResult.js'
import { getRuleByContentsForTool } from 'src/utils/permissions/permissions.js'
import {
  isOfficialMarketplaceName,
  parsePluginIdentifier,
} from 'src/utils/plugins/pluginIdentifier.js'
import { buildPluginCommandTelemetryFields } from 'src/utils/telemetry/pluginTelemetry.js'
import { z } from 'zod/v4'
import {
  addInvokedSkill,
  clearInvokedSkillsForAgent,
  getSessionId,
} from 'src/bootstrap/state.js'
import { COMMAND_MESSAGE_TAG } from 'src/constants/xml.js'
import type { CanUseToolFn } from 'src/hooks/useCanUseTool.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
  logEvent,
} from 'src/services/analytics/index.js'
import { getAgentContext } from 'src/utils/agentContext.js'
import { errorMessage } from 'src/utils/errors.js'
import {
  extractResultText,
  prepareForkedCommandContext,
} from 'src/utils/forkedAgent.js'
import { parseFrontmatter } from 'src/utils/frontmatterParser.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { createUserMessage, normalizeMessages } from 'src/utils/messages.js'
import type { ModelAlias } from 'src/utils/model/aliases.js'
import { resolveSkillModelOverride } from 'src/utils/model/model.js'
import { recordSkillUsage } from 'src/utils/suggestions/skillUsageTracking.js'
import { createAgentId } from 'src/utils/uuid.js'
import { runAgent } from '../AgentTool/runAgent.js'
import {
  getToolUseIDFromParentMessage,
  tagMessagesWithToolUseID,
} from '../utils.js'
import { SKILL_TOOL_NAME } from './constants.js'
import { getPrompt } from './prompt.js'
import {
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolUseRejectedMessage,
} from './UI.js'

/**
 * 获取所有命令，包括来自 AppState 的 MCP skill/prompt。
 * SkillTool 需要这个，因为 getCommands() 只返回本地/内置的 skill。
 */
async function getAllCommands(context: ToolUseContext): Promise<Command[]> {
  // 只包含 MCP skill（loadedFrom === 'mcp'），不包含普通 MCP prompt。
  // 在此过滤之前，如果模型猜出了 mcp__server__prompt 名称，它可以通过
  // SkillTool 调用 MCP prompt —— 这些 prompt 不可被发现，但在技术上是可达的。
  const mcpSkills = context
    .getAppState()
    .mcp.commands.filter(
      cmd => cmd.type === 'prompt' && cmd.loadedFrom === 'mcp',
    )
  if (mcpSkills.length === 0) return getCommands(getProjectRoot())
  const localCommands = await getCommands(getProjectRoot())
  return uniqBy([...localCommands, ...mcpSkills], 'name')
}

// 从集中类型定义重新导出 Progress，以打破 import 循环
export type { SkillToolProgress as Progress } from 'src/types/tools.js'

import type { SkillToolProgress as Progress } from 'src/types/tools.js'

// 远程 skill 模块的条件 require —— 这里的静态 import 会引入
// akiBackend.ts（通过 remoteSkillLoader → akiBackend），后者包含模块级的
// memoize()/lazySchema() 常量，这些常量作为有副作用的初始化器在 tree-shaking
// 后仍会保留。所有使用都在 feature('EXPERIMENTAL_SKILL_SEARCH') 守卫内，
// 因此 remoteSkillModules 在每个调用点都非空。
/* eslint-disable @typescript-eslint/no-require-imports */
const remoteSkillModules = feature('EXPERIMENTAL_SKILL_SEARCH')
  ? {
      ...(require('src/services/skillSearch/remoteSkillState.js') as typeof import('src/services/skillSearch/remoteSkillState.js')),
      ...(require('src/services/skillSearch/remoteSkillLoader.js') as typeof import('src/services/skillSearch/remoteSkillLoader.js')),
      ...(require('src/services/skillSearch/telemetry.js') as typeof import('src/services/skillSearch/telemetry.js')),
      ...(require('src/services/skillSearch/featureCheck.js') as typeof import('src/services/skillSearch/featureCheck.js')),
    }
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * 在 fork 的子 agent 上下文中执行 skill。
 * 这会在一个拥有独立 token 预算的隔离 agent 中运行 skill prompt。
 */
async function executeForkedSkill(
  command: Command & { type: 'prompt' },
  commandName: string,
  args: string | undefined,
  context: ToolUseContext,
  canUseTool: CanUseToolFn,
  parentMessage: AssistantMessage,
  onProgress?: ToolCallProgress<Progress>,
): Promise<ToolResult<Output>> {
  const startTime = Date.now()
  const agentId = createAgentId()
  const isBuiltIn = builtInCommandNames().has(commandName)
  const isOfficialSkill = isOfficialMarketplaceSkill(command)
  const isBundled = command.source === 'bundled'
  const forkedSanitizedName =
    isBuiltIn || isBundled || isOfficialSkill ? commandName : 'custom'

  const wasDiscoveredField =
    feature('EXPERIMENTAL_SKILL_SEARCH') &&
    remoteSkillModules!.isSkillSearchEnabled()
      ? {
          was_discovered:
            context.discoveredSkillNames?.has(commandName) ?? false,
        }
      : {}
  const pluginMarketplace = command.pluginInfo
    ? parsePluginIdentifier(command.pluginInfo.repository).marketplace
    : undefined
  const queryDepth = context.queryTracking?.depth ?? 0
  const parentAgentId = getAgentContext()?.agentId
  logEvent('tengu_skill_tool_invocation', {
    command_name:
      forkedSanitizedName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    // _PROTO_skill_name 路由到特权 skill_name BQ 列
    // （未脱敏，所有用户）；command_name 保留在 additional_metadata 中，
    // 作为供通用访问仪表盘使用的脱敏变体。
    _PROTO_skill_name:
      commandName as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
    execution_context:
      'fork' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    invocation_trigger: (queryDepth > 0
      ? 'nested-skill'
      : 'claude-proactive') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    query_depth: queryDepth,
    ...(parentAgentId && {
      parent_agent_id:
        parentAgentId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    }),
    ...wasDiscoveredField,
    ...(process.env.USER_TYPE === 'ant' && {
      skill_name:
        commandName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      skill_source:
        command.source as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...(command.loadedFrom && {
        skill_loaded_from:
          command.loadedFrom as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
      ...(command.kind && {
        skill_kind:
          command.kind as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
    }),
    ...(command.pluginInfo && {
      // _PROTO_* 路由到打上 PII 标签的 plugin_name/marketplace_name BQ 列
      // （未脱敏，所有用户）；plugin_name/plugin_repository 保留在
      // additional_metadata 中作为脱敏变体。
      _PROTO_plugin_name: command.pluginInfo.pluginManifest
        .name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      ...(pluginMarketplace && {
        _PROTO_marketplace_name:
          pluginMarketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      }),
      plugin_name: (isOfficialSkill
        ? command.pluginInfo.pluginManifest.name
        : 'third-party') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      plugin_repository: (isOfficialSkill
        ? command.pluginInfo.repository
        : 'third-party') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...buildPluginCommandTelemetryFields(command.pluginInfo),
    }),
  })

  const { modifiedGetAppState, baseAgent, promptMessages, skillContent } =
    await prepareForkedCommandContext(command, args || '', context)

  // 将 skill 的 effort 合并到 agent 定义中，以便 runAgent 应用它
  const agentDefinition =
    command.effort !== undefined
      ? { ...baseAgent, effort: command.effort }
      : baseAgent

  // 从 fork 的 agent 收集消息
  const agentMessages: Message[] = []

  logForDebugging(
    `SkillTool executing forked skill ${commandName} with agent ${agentDefinition.agentType}`,
  )

  try {
    // 运行子 agent
    for await (const message of runAgent({
      agentDefinition,
      promptMessages,
      toolUseContext: {
        ...context,
        getAppState: modifiedGetAppState,
      },
      canUseTool,
      isAsync: false,
      querySource: 'agent:custom',
      model: command.model as ModelAlias | undefined,
      availableTools: context.options.tools,
      override: { agentId },
    })) {
      agentMessages.push(message)

      // 为工具调用上报进度（与 AgentTool 一致）
      if (
        (message.type === 'assistant' || message.type === 'user') &&
        onProgress
      ) {
        const normalizedNew = normalizeMessages([message])
        for (const m of normalizedNew) {
          const contentArray = m.message?.content
          const hasToolContent =
            Array.isArray(contentArray) &&
            contentArray.some(
              (c: { type: string }) =>
                c.type === 'tool_use' || c.type === 'tool_result',
            )
          if (hasToolContent) {
            onProgress({
              toolUseID: `skill_${parentMessage.message.id}`,
              data: {
                message: m,
                type: 'skill_progress',
                prompt: skillContent,
                agentId,
              },
            })
          }
        }
      }
    }

    const resultText = extractResultText(
      agentMessages,
      'Skill execution completed',
    )
    // 提取结果后释放消息内存
    agentMessages.length = 0

    const durationMs = Date.now() - startTime
    logForDebugging(
      `SkillTool forked skill ${commandName} completed in ${durationMs}ms`,
    )

    return {
      data: {
        success: true,
        commandName,
        status: 'forked',
        agentId,
        result: resultText,
      },
    }
  } finally {
    // 从 invokedSkills 状态中释放 skill 内容
    clearInvokedSkillsForAgent(agentId)
  }
}

export const inputSchema = lazySchema(() =>
  z.object({
    skill: z
      .string()
      .describe('skill 的名称。例如："commit"、"review-pr" 或 "pdf"'),
    args: z.string().optional().describe('传给 skill 的可选参数'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export const outputSchema = lazySchema(() => {
  // 内联 skill 的输出 schema（默认）
  const inlineOutputSchema = z.object({
    success: z.boolean().describe('该 skill 是否有效'),
    commandName: z.string().describe('skill 的名称'),
    allowedTools: z
      .array(z.string())
      .optional()
      .describe('该 skill 允许使用的工具'),
    model: z.string().optional().describe('如果指定了，则为模型覆盖项'),
    status: z.literal('inline').optional().describe('执行状态'),
  })

  // fork skill 的输出 schema
  const forkedOutputSchema = z.object({
    success: z.boolean().describe('该 skill 是否成功完成'),
    commandName: z.string().describe('skill 的名称'),
    status: z.literal('forked').describe('执行状态'),
    agentId: z
      .string()
      .describe('执行该 skill 的子 agent ID'),
    result: z.string().describe('fork skill 执行的结果'),
  })

  return z.union([inlineOutputSchema, forkedOutputSchema])
})
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.input<OutputSchema>

export const SkillTool: Tool<InputSchema, Output, Progress> = buildTool({
  name: SKILL_TOOL_NAME,
  searchHint: 'invoke a slash-command skill',
  maxResultSizeChars: 100_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },

  description: async ({ skill }) => `执行 skill：${skill}`,

  prompt: async () => getPrompt(getProjectRoot()),

  // 一次只应运行一个 skill/命令，因为该工具会把命令展开为完整的 prompt，
  // Claude 必须先处理它才能继续。
  // Skill-coach 需要 skill 名称，以避免当 X 实际上已被调用时给出错误的
  // "你本可以使用 skill X" 建议。Backseat 对展开后的 prompt 产生的下游
  // 工具调用进行分类，而不是对这个包装器，因此仅凭名称就已足够 —— 它
  // 只是记录该 skill 已被触发。
  toAutoClassifierInput: ({ skill }) => skill ?? '',

  async validateInput({ skill }, context): Promise<ValidationResult> {
    // skill 只是 skill 名称，没有参数
    const trimmed = skill.trim()
    if (!trimmed) {
      return {
        result: false,
        message: `无效的 skill 格式：${skill}`,
        errorCode: 1,
      }
    }

    // 如果存在前导斜杠则去除（为了兼容性）
    const hasLeadingSlash = trimmed.startsWith('/')
    if (hasLeadingSlash) {
      logEvent('tengu_skill_tool_slash_prefix', {})
    }
    const normalizedCommandName = hasLeadingSlash
      ? trimmed.substring(1)
      : trimmed

    // 远程 canonical skill 处理（仅限 ant 的实验性功能）。在本地命令查找
    // 之前拦截 `_canonical_<slug>` 名称，因为远程 skill 不在本地命令注册表中。
    if (
      feature('EXPERIMENTAL_SKILL_SEARCH') &&
      process.env.USER_TYPE === 'ant'
    ) {
      const slug = remoteSkillModules!.stripCanonicalPrefix(
        normalizedCommandName,
      )
      if (slug !== null) {
        const meta = remoteSkillModules!.getDiscoveredRemoteSkill(slug)
        if (!meta) {
          return {
            result: false,
            message: `远程 skill ${slug} 在本次会话中未被发现。请先使用 DiscoverSkills 发现远程 skill。`,
            errorCode: 6,
          }
        }
        // 已发现的远程 skill —— 有效。加载发生在 call() 中。
        return { result: true }
      }
    }

    // 获取可用命令（包括 MCP skill）
    const commands = await getAllCommands(context)

    // 检查命令是否存在
    const foundCommand = findCommand(normalizedCommandName, commands)
    if (!foundCommand) {
      return {
        result: false,
        message: `未知的 skill：${normalizedCommandName}`,
        errorCode: 2,
      }
    }

    // 检查命令是否禁用了模型调用
    if (foundCommand.disableModelInvocation) {
      return {
        result: false,
        message: `Skill ${normalizedCommandName} 由于 disable-model-invocation，不能通过 ${SKILL_TOOL_NAME} 工具使用`,
        errorCode: 4,
      }
    }

    // 检查命令是否是 prompt 类型的命令
    if (foundCommand.type !== 'prompt') {
      return {
        result: false,
        message: `Skill ${normalizedCommandName} 不是 prompt 类型的 skill`,
        errorCode: 5,
      }
    }

    return { result: true }
  },

  async checkPermissions(
    { skill, args },
    context,
  ): Promise<PermissionDecision> {
    // skill 只是 skill 名称，没有参数
    const trimmed = skill.trim()

    // 如果存在前导斜杠则去除（为了兼容性）
    const commandName = trimmed.startsWith('/') ? trimmed.substring(1) : trimmed

    const appState = context.getAppState()
    const permissionContext = appState.toolPermissionContext

    // 查找命令对象，作为元数据传递
    const commands = await getAllCommands(context)
    const commandObj = findCommand(commandName, commands)

    // 检查规则是否匹配该 skill 的辅助函数
    // 通过剥离前导斜杠对两个输入做归一化，保证匹配一致
    const ruleMatches = (ruleContent: string): boolean => {
      // 通过剥离前导斜杠归一化规则内容
      const normalizedRule = ruleContent.startsWith('/')
        ? ruleContent.substring(1)
        : ruleContent

      // 检查精确匹配（使用归一化后的 commandName）
      if (normalizedRule === commandName) {
        return true
      }
      // 检查前缀匹配（例如 "review:*" 匹配 "review-pr 123"）
      if (normalizedRule.endsWith(':*')) {
        const prefix = normalizedRule.slice(0, -2) // 去除 ':*'
        return commandName.startsWith(prefix)
      }
      return false
    }

    // 检查 deny 规则
    const denyRules = getRuleByContentsForTool(
      permissionContext,
      SkillTool as Tool,
      'deny',
    )
    for (const [ruleContent, rule] of denyRules.entries()) {
      if (ruleMatches(ruleContent)) {
        return {
          behavior: 'deny',
          message: `skill 执行已被权限规则阻止`,
          decisionReason: {
            type: 'rule',
            rule,
          },
        }
      }
    }

    // 远程 canonical skill 是仅限 ant 的实验性功能 —— 自动授权。
    // 放在 deny 循环之后，以便用户配置的 Skill(_canonical_:*) deny 规则
    // 仍会被尊重（与下方 safe-properties 自动允许的模式一致）。
    // skill 内容本身是 canonical/精选的，并非用户自创。
    if (
      feature('EXPERIMENTAL_SKILL_SEARCH') &&
      process.env.USER_TYPE === 'ant'
    ) {
      const slug = remoteSkillModules!.stripCanonicalPrefix(commandName)
      if (slug !== null) {
        return {
          behavior: 'allow',
          updatedInput: { skill, args },
          decisionReason: undefined,
        }
      }
    }

    // 检查 allow 规则
    const allowRules = getRuleByContentsForTool(
      permissionContext,
      SkillTool as Tool,
      'allow',
    )
    for (const [ruleContent, rule] of allowRules.entries()) {
      if (ruleMatches(ruleContent)) {
        return {
          behavior: 'allow',
          updatedInput: { skill, args },
          decisionReason: {
            type: 'rule',
            rule,
          },
        }
      }
    }

    // 自动允许只使用安全属性的 skill。
    // 这是一个允许列表：如果 skill 有任何不在此集合中且具有实质值的属性，
    // 就需要权限。这确保未来新增的属性在显式审查并加入此处之前，
    // 默认都需要权限。
    if (
      commandObj?.type === 'prompt' &&
      skillHasOnlySafeProperties(commandObj)
    ) {
      return {
        behavior: 'allow',
        updatedInput: { skill, args },
        decisionReason: undefined,
      }
    }

    // 为精确 skill 和前缀准备建议
    // 使用归一化后的 commandName（无前导斜杠）以保持规则一致
    const suggestions = [
      // 精确 skill 建议
      {
        type: 'addRules' as const,
        rules: [
          {
            toolName: SKILL_TOOL_NAME,
            ruleContent: commandName,
          },
        ],
        behavior: 'allow' as const,
        destination: 'localSettings' as const,
      },
      // 前缀建议，允许任意参数
      {
        type: 'addRules' as const,
        rules: [
          {
            toolName: SKILL_TOOL_NAME,
            ruleContent: `${commandName}:*`,
          },
        ],
        behavior: 'allow' as const,
        destination: 'localSettings' as const,
      },
    ]

    // 默认行为：向用户请求权限
    return {
      behavior: 'ask',
      message: `执行 skill：${commandName}`,
      decisionReason: undefined,
      suggestions,
      updatedInput: { skill, args },
      metadata: commandObj ? { command: commandObj } : undefined,
    }
  },

  async call(
    { skill, args },
    context,
    canUseTool,
    parentMessage,
    onProgress?,
  ): Promise<ToolResult<Output>> {
    logForDebugging(`[Hapii] SkillTool.call 执行 skill=${skill}`, {
      level: 'info',
    })
    // 到这一步，validateInput 已确认：
    // - skill 格式有效
    // - skill 存在
    // - skill 可加载
    // - skill 未设置 disableModelInvocation
    // - skill 是 prompt 类型的 skill

    // skill 只是名称，附带可选参数
    const trimmed = skill.trim()

    // 如果存在前导斜杠则去除（为了兼容性）
    const commandName = trimmed.startsWith('/') ? trimmed.substring(1) : trimmed

    // 远程 canonical skill 执行（仅限 ant 的实验性功能）。在本地命令查找
    // 之前拦截 `_canonical_<slug>` —— 从 AKI/GCS 加载 SKILL.md（带本地
    // 缓存），将内容直接作为 user 消息注入。
    // 远程 skill 是声明式 markdown，因此无需 slash-command 展开
    // （无需 !command 替换，无需 $ARGUMENTS 插值）。
    if (
      feature('EXPERIMENTAL_SKILL_SEARCH') &&
      process.env.USER_TYPE === 'ant'
    ) {
      const slug = remoteSkillModules!.stripCanonicalPrefix(commandName)
      if (slug !== null) {
        return executeRemoteSkill(slug, commandName, parentMessage, context)
      }
    }

    const commands = await getAllCommands(context)
    const command = findCommand(commandName, commands)

    // 跟踪 skill 使用情况以用于排序
    recordSkillUsage(commandName)

    // 检查 skill 是否应作为 fork 的子 agent 运行
    if (command?.type === 'prompt' && command.context === 'fork') {
      return executeForkedSkill(
        command,
        commandName,
        args,
        context,
        canUseTool,
        parentMessage,
        onProgress,
      )
    }

    // 使用可选参数处理 skill
    const { processPromptSlashCommand } = await import(
      'src/utils/processUserInput/processSlashCommand.js'
    )
    const processedCommand = await processPromptSlashCommand(
      commandName,
      args || '', // 如果提供了参数则传入
      commands,
      context,
    )

    if (!processedCommand.shouldQuery) {
      throw new Error('命令处理失败')
    }

    // 从命令中提取元数据
    const allowedTools = processedCommand.allowedTools || []
    const model = processedCommand.model
    const effort = command?.type === 'prompt' ? command.effort : undefined

    const isBuiltIn = builtInCommandNames().has(commandName)
    const isBundled = command?.type === 'prompt' && command.source === 'bundled'
    const isOfficialSkill =
      command?.type === 'prompt' && isOfficialMarketplaceSkill(command)
    const sanitizedCommandName =
      isBuiltIn || isBundled || isOfficialSkill ? commandName : 'custom'

    const wasDiscoveredField =
      feature('EXPERIMENTAL_SKILL_SEARCH') &&
      remoteSkillModules!.isSkillSearchEnabled()
        ? {
            was_discovered:
              context.discoveredSkillNames?.has(commandName) ?? false,
          }
        : {}
    const pluginMarketplace =
      command?.type === 'prompt' && command.pluginInfo
        ? parsePluginIdentifier(command.pluginInfo.repository).marketplace
        : undefined
    const queryDepth = context.queryTracking?.depth ?? 0
    const parentAgentId = getAgentContext()?.agentId
    logEvent('tengu_skill_tool_invocation', {
      command_name:
        sanitizedCommandName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      // _PROTO_skill_name 路由到特权 skill_name BQ 列
      // （未脱敏，所有用户）；command_name 保留在 additional_metadata 中，
      // 作为供通用访问仪表盘使用的脱敏变体。
      _PROTO_skill_name:
        commandName as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      execution_context:
        'inline' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      invocation_trigger: (queryDepth > 0
        ? 'nested-skill'
        : 'claude-proactive') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      query_depth: queryDepth,
      ...(parentAgentId && {
        parent_agent_id:
          parentAgentId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
      ...wasDiscoveredField,
      ...(process.env.USER_TYPE === 'ant' && {
        skill_name:
          commandName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        ...(command?.type === 'prompt' && {
          skill_source:
            command.source as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }),
        ...(command?.loadedFrom && {
          skill_loaded_from:
            command.loadedFrom as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }),
        ...(command?.kind && {
          skill_kind:
            command.kind as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }),
      }),
      ...(command?.type === 'prompt' &&
        command.pluginInfo && {
          _PROTO_plugin_name: command.pluginInfo.pluginManifest
            .name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
          ...(pluginMarketplace && {
            _PROTO_marketplace_name:
              pluginMarketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
          }),
          plugin_name: (isOfficialSkill
            ? command.pluginInfo.pluginManifest.name
            : 'third-party') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          plugin_repository: (isOfficialSkill
            ? command.pluginInfo.repository
            : 'third-party') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          ...buildPluginCommandTelemetryFields(command.pluginInfo),
        }),
    })

    // 从父消息获取 tool use ID，用于关联 newMessages
    const toolUseID = getToolUseIDFromParentMessage(
      parentMessage,
      SKILL_TOOL_NAME,
    )

    // 为 user 消息打上 sourceToolUseID 标记，使其在该工具解析完成前保持 transient
    const newMessages = tagMessagesWithToolUseID(
      processedCommand.messages.filter(
        (m): m is UserMessage | AttachmentMessage | SystemMessage => {
          if (m.type === 'progress') {
            return false
          }
          // 过滤掉 command-message，因为 SkillTool 负责显示
          if (m.type === 'user' && 'message' in m) {
            const content = m.message.content
            if (
              typeof content === 'string' &&
              content.includes(`<${COMMAND_MESSAGE_TAG}>`)
            ) {
              return false
            }
          }
          return true
        },
      ),
      toolUseID,
    )

    logForDebugging(
      `SkillTool returning ${newMessages.length} newMessages for skill ${commandName}`,
    )

    // 注意：addInvokedSkill 和 registerSkillHooks 已在
    // processPromptSlashCommand 内部（经由 getMessagesForPromptSlashCommand）
    // 调用，因此在这里再次调用会导致 hooks 重复注册并冗余重建 skillContent。

    // 返回成功结果，附带 newMessages 和 contextModifier
    return {
      data: {
        success: true,
        commandName,
        allowedTools: allowedTools.length > 0 ? allowedTools : undefined,
        model,
      },
      newMessages,
      contextModifier(ctx) {
        let modifiedContext = ctx

        // 如果指定了，则更新允许的工具
        if (allowedTools.length > 0) {
          // 捕获当前的 getAppState 以正确地链式应用修改
          const previousGetAppState = modifiedContext.getAppState
          modifiedContext = {
            ...modifiedContext,
            getAppState() {
              // 使用先前的 getAppState，而不是闭包中的 context.getAppState，
              // 以正确地链式应用上下文修改
              const appState = previousGetAppState()
              return {
                ...appState,
                toolPermissionContext: {
                  ...appState.toolPermissionContext,
                  alwaysAllowRules: {
                    ...appState.toolPermissionContext.alwaysAllowRules,
                    command: [
                      ...new Set([
                        ...(appState.toolPermissionContext.alwaysAllowRules
                          .command || []),
                        ...allowedTools,
                      ]),
                    ],
                  },
                },
              }
            },
          }
        }

        // 保留 [1m] 后缀 —— 否则在 opus[1m] 会话中，一个带有 `model: opus` 的
        // skill 会把有效窗口降到 200K 并触发 autocompact。
        if (model) {
          modifiedContext = {
            ...modifiedContext,
            options: {
              ...modifiedContext.options,
              mainLoopModel: resolveSkillModelOverride(
                model,
                ctx.options.mainLoopModel,
              ),
            },
          }
        }

        // 如果 skill 指定了 effort，则覆盖 effort 级别
        if (effort !== undefined) {
          const previousGetAppState = modifiedContext.getAppState
          modifiedContext = {
            ...modifiedContext,
            getAppState() {
              const appState = previousGetAppState()
              return {
                ...appState,
                effortValue: effort,
              }
            },
          }
        }

        return modifiedContext
      },
    }
  },

  mapToolResultToToolResultBlockParam(
    result: Output,
    toolUseID: string,
  ): ToolResultBlockParam {
    // 处理 fork skill 的结果
    if ('status' in result && result.status === 'forked') {
      return {
        type: 'tool_result' as const,
        tool_use_id: toolUseID,
        content: `Skill "${result.commandName}" 已完成（fork 执行）。\n\n结果：\n${result.result}`,
      }
    }

    // 内联 skill 的结果（默认）
    return {
      type: 'tool_result' as const,
      tool_use_id: toolUseID,
      content: `正在启动 skill：${result.commandName}`,
    }
  },

  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolUseRejectedMessage,
  renderToolUseErrorMessage,
} satisfies ToolDef<InputSchema, Output, Progress>)

// 安全、无需权限的 PromptCommand 属性键允许列表。
// 如果 skill 有任何不在此集合中且具有实质值的属性，就需要权限。
// 这确保未来新增到 PromptCommand 的属性在显式审查并加入此处之前，
// 默认都需要权限。
const SAFE_SKILL_PROPERTIES = new Set([
  // PromptCommand 属性
  'type',
  'progressMessage',
  'contentLength',
  'argNames',
  'model',
  'effort',
  'source',
  'pluginInfo',
  'disableNonInteractive',
  'skillRoot',
  'context',
  'agent',
  'getPromptForCommand',
  'frontmatterKeys',
  // CommandBase 属性
  'name',
  'description',
  'hasUserSpecifiedDescription',
  'isEnabled',
  'isHidden',
  'aliases',
  'isMcp',
  'argumentHint',
  'whenToUse',
  'paths',
  'version',
  'disableModelInvocation',
  'userInvocable',
  'loadedFrom',
  'immediate',
  'userFacingName',
])

function skillHasOnlySafeProperties(command: Command): boolean {
  for (const key of Object.keys(command)) {
    if (SAFE_SKILL_PROPERTIES.has(key)) {
      continue
    }
    // 属性不在安全允许列表中 —— 检查它是否有实质值
    const value = (command as Record<string, unknown>)[key]
    if (value === undefined || value === null) {
      continue
    }
    if (Array.isArray(value) && value.length === 0) {
      continue
    }
    if (
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0
    ) {
      continue
    }
    return false
  }
  return true
}

function isOfficialMarketplaceSkill(command: PromptCommand): boolean {
  if (command.source !== 'plugin' || !command.pluginInfo?.repository) {
    return false
  }
  return isOfficialMarketplaceName(
    parsePluginIdentifier(command.pluginInfo.repository).marketplace,
  )
}

/**
 * 提取用于遥测的 URL scheme。对于无法识别的 scheme 默认返回 'gs'，
 * 因为 AKI 后端是唯一的生产路径，且 loader 在到达遥测之前就会对
 * 未知 scheme 抛错。
 */
function extractUrlScheme(url: string): 'gs' | 'http' | 'https' | 's3' {
  if (url.startsWith('gs://')) return 'gs'
  if (url.startsWith('https://')) return 'https'
  if (url.startsWith('http://')) return 'http'
  if (url.startsWith('s3://')) return 's3'
  return 'gs'
}

/**
 * 加载远程 canonical skill，并将其 SKILL.md 内容注入会话。
 * 与本地 skill（经由 processPromptSlashCommand 进行
 * !command / $ARGUMENTS 展开）不同，远程 skill 是声明式 markdown ——
 * 我们直接把内容包装在 user 消息里。
 *
 * 该 skill 还会通过 addInvokedSkill 注册，以便在 compaction 后仍能保留
 * （与本地 skill 相同）。
 *
 * 仅在 call() 中 feature('EXPERIMENTAL_SKILL_SEARCH') 守卫内被调用 ——
 * 此处 remoteSkillModules 非空。
 */
async function executeRemoteSkill(
  slug: string,
  commandName: string,
  parentMessage: AssistantMessage,
  context: ToolUseContext,
): Promise<ToolResult<Output>> {
  const { getDiscoveredRemoteSkill, loadRemoteSkill, logRemoteSkillLoaded } =
    remoteSkillModules!

  // validateInput 已确认此 slug 在会话状态中，但我们在这里重新获取以拿到 URL。
  // 如果不知何故丢失（例如会话中途状态被清空），则以明确的错误失败，而不是崩溃。
  const meta = getDiscoveredRemoteSkill(slug)
  if (!meta) {
    throw new Error(
      `Remote skill ${slug} was not discovered in this session. Use DiscoverSkills to find remote skills first.`,
    )
  }

  const urlScheme = extractUrlScheme(meta.url)
  let loadResult
  try {
    loadResult = await loadRemoteSkill(slug, meta.url)
  } catch (e) {
    const msg = errorMessage(e)
    logRemoteSkillLoaded({
      slug,
      cacheHit: false,
      latencyMs: 0,
      urlScheme,
      error: msg,
    })
    throw new Error(`加载远程 skill ${slug} 失败：${msg}`)
  }

  const {
    cacheHit,
    latencyMs,
    skillPath,
    content,
    fileCount,
    totalBytes,
    fetchMethod,
  } = loadResult

  logRemoteSkillLoaded({
    slug,
    cacheHit,
    latencyMs,
    urlScheme,
    fileCount,
    totalBytes,
    fetchMethod,
  })

  // 远程 skill 总是由模型发现（从不在静态 skill_listing 中），
  // 因此 was_discovered 永远为 true。is_remote 让 BQ 查询无需通过 skill 名称
  // 前缀 join 即可区分远程和本地调用。
  const queryDepth = context.queryTracking?.depth ?? 0
  const parentAgentId = getAgentContext()?.agentId
  logEvent('tengu_skill_tool_invocation', {
    command_name:
      'remote_skill' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    // _PROTO_skill_name 路由到特权 skill_name BQ 列
    // （未脱敏，所有用户）；command_name 保留在 additional_metadata 中作为脱敏变体。
    _PROTO_skill_name:
      commandName as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
    execution_context:
      'remote' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    invocation_trigger: (queryDepth > 0
      ? 'nested-skill'
      : 'claude-proactive') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    query_depth: queryDepth,
    ...(parentAgentId && {
      parent_agent_id:
        parentAgentId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    }),
    was_discovered: true,
    is_remote: true,
    remote_cache_hit: cacheHit,
    remote_load_latency_ms: latencyMs,
    ...(process.env.USER_TYPE === 'ant' && {
      skill_name:
        commandName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      remote_slug:
        slug as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    }),
  })

  recordSkillUsage(commandName)

  logForDebugging(
    `SkillTool loaded remote skill ${slug} (cacheHit=${cacheHit}, ${latencyMs}ms, ${content.length} chars)`,
  )

  // 在前插 header 之前剥离 YAML frontmatter（---\nname: x\n---）
  // （与 loadSkillsDir.ts:333 保持一致）。如果没有 frontmatter，
  // parseFrontmatter 会原样返回原始内容。
  const { content: bodyContent } = parseFrontmatter(content, skillPath)

  // 注入基目录 header 并替换 ${CLAUDE_SKILL_DIR}/${CLAUDE_SESSION_ID}
  // （与 loadSkillsDir.ts 保持一致），以便模型能够将相对引用（例如
  // ./schemas/foo.json）相对于缓存目录进行解析。
  const skillDir = dirname(skillPath)
  const normalizedDir =
    process.platform === 'win32' ? skillDir.replace(/\\/g, '/') : skillDir
  let finalContent = `Base directory for this skill: ${normalizedDir}\n\n${bodyContent}`
  finalContent = finalContent.replace(/\$\{CLAUDE_SKILL_DIR\}/g, normalizedDir)
  finalContent = finalContent.replace(
    /\$\{CLAUDE_SESSION_ID\}/g,
    getSessionId(),
  )

  // 注册到 compaction 保留状态。使用缓存的文件路径，以便 compaction 后的
  // 恢复逻辑知道内容来源。必须使用 finalContent（而不是原始 content），
  // 这样基目录 header 和 ${CLAUDE_SKILL_DIR} 替换才能在 compaction 后保留 ——
  // 与本地 skill 通过 processSlashCommand 存储已转换内容的做法一致。
  addInvokedSkill(
    commandName,
    skillPath,
    finalContent,
    getAgentContext()?.agentId ?? null,
  )

  // 直接注入 —— 将 SKILL.md 内容包装为一条 meta user 消息。与
  // processPromptSlashCommand 为简单 skill 产生的结构一致。
  const toolUseID = getToolUseIDFromParentMessage(
    parentMessage,
    SKILL_TOOL_NAME,
  )
  return {
    data: { success: true, commandName, status: 'inline' },
    newMessages: tagMessagesWithToolUseID(
      [createUserMessage({ content: finalContent, isMeta: true })],
      toolUseID,
    ),
  }
}
