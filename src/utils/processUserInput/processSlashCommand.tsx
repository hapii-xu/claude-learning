import { feature } from 'bun:bundle';
import type { ContentBlockParam, TextBlockParam } from '@anthropic-ai/sdk/resources';
import { randomUUID } from 'crypto';
import { setPromptId } from 'src/bootstrap/state.js';
import {
  builtInCommandNames,
  type Command,
  type CommandBase,
  findCommand,
  getCommand,
  getCommandName,
  hasCommand,
  type PromptCommand,
} from 'src/commands.js';
import { NO_CONTENT_MESSAGE } from 'src/constants/messages.js';
import type { SetToolJSXFn, ToolUseContext } from 'src/Tool.js';
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  NormalizedUserMessage,
  ProgressMessage,
  UserMessage,
} from 'src/types/message.js';
import type { QueuedCommand } from 'src/types/textInputTypes.js';
import { addInvokedSkill, getSessionId } from '../../bootstrap/state.js';
import { COMMAND_MESSAGE_TAG, COMMAND_NAME_TAG } from '../../constants/xml.js';
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js';
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
  logEvent,
} from '../../services/analytics/index.js';
import { getDumpPromptsPath } from '../../services/api/dumpPrompts.js';
import { buildPostCompactMessages } from '../../services/compact/compact.js';
import { resetMicrocompactState } from '../../services/compact/microCompact.js';
import type { Progress as AgentProgress } from '@claude-code-best/builtin-tools/tools/AgentTool/AgentTool.js';
import { runAgent } from '@claude-code-best/builtin-tools/tools/AgentTool/runAgent.js';
import { renderToolUseProgressMessage } from '@claude-code-best/builtin-tools/tools/AgentTool/UI.js';
import type { CommandResultDisplay } from '../../types/command.js';
import { createAbortController } from '../abortController.js';
import { getAgentContext } from '../agentContext.js';
import { createAttachmentMessage, getAttachmentMessages } from '../attachments.js';
import { logForDebugging } from '../debug.js';
import { isEnvTruthy } from '../envUtils.js';
import { AbortError, MalformedCommandError } from '../errors.js';
import { getDisplayPath } from '../file.js';
import { extractResultText, prepareForkedCommandContext } from '../forkedAgent.js';
import { getFsImplementation } from '../fsOperations.js';
import { isFullscreenEnvEnabled } from '../fullscreen.js';
import { toArray } from '../generators.js';
import { registerSkillHooks } from '../hooks/registerSkillHooks.js';
import { logError } from '../log.js';
import { enqueue, enqueuePendingNotification } from '../messageQueueManager.js';
import {
  createCommandInputMessage,
  createSyntheticUserCaveatMessage,
  createSystemMessage,
  createUserInterruptionMessage,
  createUserMessage,
  formatCommandInputTags,
  isCompactBoundaryMessage,
  isSystemLocalCommandMessage,
  normalizeMessages,
  prepareUserContent,
} from '../messages.js';
import type { ModelAlias } from '../model/aliases.js';
import { parseToolListFromCLI } from '../permissions/permissionSetup.js';
import { hasPermissionsToUseTool } from '../permissions/permissions.js';
import { isOfficialMarketplaceName, parsePluginIdentifier } from '../plugins/pluginIdentifier.js';
import { isRestrictedToPluginOnly, isSourceAdminTrusted } from '../settings/pluginOnlyPolicy.js';
import { parseSlashCommand } from '../slashCommandParsing.js';
import { sleep } from '../sleep.js';
import { recordSkillUsage } from '../suggestions/skillUsageTracking.js';
import { logOTelEvent, redactIfDisabled } from '../telemetry/events.js';
import { buildPluginCommandTelemetryFields } from '../telemetry/pluginTelemetry.js';
import { getAssistantMessageContentLength } from '../tokens.js';
import { createAgentId } from '../uuid.js';
import { finalizeAutonomyRunCompleted, finalizeAutonomyRunFailed } from '../autonomyRuns.js';
import { getWorkload } from '../workloadContext.js';
import type { ProcessUserInputBaseResult, ProcessUserInputContext } from './processUserInput.js';

type SlashCommandResult = ProcessUserInputBaseResult & {
  command: Command;
};

// 启动后台 fork 子代理前等待 MCP 服务器就绪的轮询间隔与截止时间。
// MCP 服务器通常在启动后 1-3 秒内连接；10 秒余量可覆盖慢速 SSE 握手。
const MCP_SETTLE_POLL_MS = 200;
const MCP_SETTLE_TIMEOUT_MS = 10_000;

function isTestRuntime(): boolean {
  return process.env.NODE_ENV === 'test';
}

function assertBackgroundForkedSlashCommandTestOverrideAllowed(): void {
  if (!isTestRuntime()) {
    throw new Error(
      'ToolUseContext.options.allowBackgroundForkedSlashCommands is test-only and cannot be enabled outside NODE_ENV=test.',
    );
  }
}

/**
 * Executes a slash command with context: fork in a sub-agent.
 */
async function executeForkedSlashCommand(
  command: CommandBase & PromptCommand,
  args: string,
  context: ProcessUserInputContext,
  precedingInputBlocks: ContentBlockParam[],
  setToolJSX: SetToolJSXFn,
  canUseTool: CanUseToolFn,
  autonomy?: QueuedCommand['autonomy'],
): Promise<SlashCommandResult> {
  const agentId = createAgentId();

  const pluginMarketplace = command.pluginInfo
    ? parsePluginIdentifier(command.pluginInfo.repository).marketplace
    : undefined;
  logEvent('tengu_slash_command_forked', {
    command_name: command.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    invocation_trigger: 'user-slash' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    ...(command.pluginInfo && {
      _PROTO_plugin_name: command.pluginInfo.pluginManifest.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      ...(pluginMarketplace && {
        _PROTO_marketplace_name: pluginMarketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      }),
      ...buildPluginCommandTelemetryFields(command.pluginInfo),
    }),
  });

  const { skillContent, modifiedGetAppState, baseAgent, promptMessages } = await prepareForkedCommandContext(
    command,
    args,
    context,
  );

  // 将 skill 的 effort 合并到 agent 定义中，以便 runAgent 应用它
  const agentDefinition = command.effort !== undefined ? { ...baseAgent, effort: command.effort } : baseAgent;

  logForDebugging(`Executing forked slash command /${command.name} with agent ${agentDefinition.agentType}`);

  // Assistant 模式：即发即忘。在后台启动子代理并立即返回，
  // 完成后将结果作为 isMeta prompt 重新入队。
  // 否则，启动时 N 个计划任务 = N 个串行（子代理 + 主代理轮次）
  // 周期阻塞用户输入。采用此方式后，N 个子代理并行运行，
  // 结果在完成时逐步流入队列。
  //
  // 以 kairosEnabled（而非 CLAUDE_CODE_BRIEF）为门控，因为闭环
  // 依赖 assistant 模式的不变量：scheduled_tasks.json 存在、
  // 主代理知道通过 SendUserMessage 传递结果、且 isMeta prompt 被隐藏。
  // 在 assistant 模式之外，context:fork 命令是用户调用的 skill
  // （/commit 等），应使用进度 UI 同步运行。
  const appState = await context.getAppState();
  const allowBackgroundForkedSlashCommands = context.options.allowBackgroundForkedSlashCommands === true;
  if (allowBackgroundForkedSlashCommands) {
    assertBackgroundForkedSlashCommandTestOverrideAllowed();
  }
  let canRunBackgroundForkedSlashCommand = false;
  if (appState.kairosEnabled) {
    if (feature('KAIROS')) {
      canRunBackgroundForkedSlashCommand = true;
    } else if (allowBackgroundForkedSlashCommands) {
      canRunBackgroundForkedSlashCommand = true;
    }
  }
  if (canRunBackgroundForkedSlashCommand) {
    // 独立的 abortController —— 后台子代理在主线程 ESC 时继续存活
    // （与 AgentTool 的异步路径策略相同）。它们由 cron 驱动；
    // 若中途被终止，只会在下一个调度时重新触发。
    const bgAbortController = createAbortController();
    const commandName = getCommandName(command);

    // 工作负载：handlePromptSubmit 将整个轮次包裹在 runWithWorkload
    // （AsyncLocalStorage）中。ALS 上下文在此 `void` 触发时捕获，
    // 并在内部每个 await 中存活 —— 与父级的延续隔离。
    // 分离的闭包中的 runAgent 调用自动看到 cron 标签。
    // 我们在此捕获值仅用于下方重新入队的结果 prompt：
    // 第二个轮次在全新的 handlePromptSubmit → 全新的 runWithWorkload
    // 边界（即使对 `undefined` 也总会建立新上下文）中运行 →
    // 因此需要自己的 QueuedCommand.workload 标签以保留归因。
    const spawnTimeWorkload = getWorkload();

    // 以隐藏 prompt 形式重新入队。isMeta：从队列预览 + 占位符 + transcript 中隐藏。
    // skipSlashCommands：若结果文本恰好以 '/' 开头则防止重新解析。
    // 当被消费时，这会触发一个主代理轮次，由其查看结果并决定是否
    // SendUserMessage。传播 workload 使第二个轮次也被标记。
    const enqueueResult = (value: string): void =>
      enqueuePendingNotification({
        value,
        mode: 'prompt',
        priority: 'later',
        isMeta: true,
        skipSlashCommands: true,
        workload: spawnTimeWorkload,
      });
    const finalizeDeferredAutonomyRunCompleted = async (): Promise<void> => {
      if (!autonomy?.runId) {
        return;
      }
      const nextCommands = await finalizeAutonomyRunCompleted({
        runId: autonomy.runId,
        rootDir: autonomy.rootDir,
        priority: 'later',
        workload: spawnTimeWorkload,
      });
      for (const nextCommand of nextCommands) {
        enqueue(nextCommand);
      }
    };
    const finalizeDeferredAutonomyRunFailed = async (error: unknown): Promise<void> => {
      if (!autonomy?.runId) {
        return;
      }
      await finalizeAutonomyRunFailed({
        runId: autonomy.runId,
        rootDir: autonomy.rootDir,
        error: error instanceof Error ? error.message : String(error),
      });
    };

    void (async () => {
      // 等待 MCP 服务器就绪。计划任务在启动时触发，全部 N 个在 ~1ms 内
      // 消费（因为我们立即返回），在 MCP 连接之前就捕获了
      // context.options.tools。同步路径意外避免了这点 —— 任务串行化，
      // 所以任务 N 的消费发生在任务 N-1 的 30 秒运行之后，
      // 此时 MCP 已就绪。轮询直到没有 'pending' 状态的客户端，然后刷新。
      const deadline = Date.now() + MCP_SETTLE_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const s = context.getAppState();
        if (!s.mcp.clients.some(c => c.type === 'pending')) break;
        await sleep(MCP_SETTLE_POLL_MS);
      }
      const freshTools = context.options.refreshTools?.() ?? context.options.tools;

      const agentMessages: Message[] = [];
      for await (const message of runAgent({
        agentDefinition,
        promptMessages,
        toolUseContext: {
          ...context,
          getAppState: modifiedGetAppState,
          abortController: bgAbortController,
        },
        canUseTool,
        isAsync: true,
        querySource: 'agent:custom',
        model: command.model as ModelAlias | undefined,
        availableTools: freshTools,
        override: { agentId },
      })) {
        agentMessages.push(message);
      }
      const resultText = extractResultText(agentMessages, 'Command completed');
      logForDebugging(`Background forked command /${commandName} completed (agent ${agentId})`);
      // 在结束自治运行之前先入队工作器的结果，这样
      // <scheduled-task-result> 通知会先于终结器在同一优先级入队的
      // 任何后续自治命令被观察到。没有这个顺序保证，两者都落在
      // `priority: 'later'`，下一步自治可能在主线程看到此工作器输出之前运行。
      enqueueResult(`<scheduled-task-result command="/${commandName}">\n${resultText}\n</scheduled-task-result>`);
      // slash 命令本身成功了；终结调用的错误不能作为矛盾的
      // <scheduled-task-result status="failed"> 通过下方外层 catch 暴露。
      // 在此记录并停止。
      try {
        await finalizeDeferredAutonomyRunCompleted();
      } catch (finalizeError) {
        logError(finalizeError);
      }
    })().catch(async err => {
      logError(err);
      enqueueResult(
        `<scheduled-task-result command="/${commandName}" status="failed">\n${err instanceof Error ? err.message : String(err)}\n</scheduled-task-result>`,
      );
      await finalizeDeferredAutonomyRunFailed(err);
    });

    // 无需渲染、无需查询 —— 后台运行器自行按计划重新入队。
    return {
      messages: [],
      shouldQuery: false,
      command,
      deferAutonomyCompletion: Boolean(autonomy?.runId),
    };
  }

  // 从 fork 代理收集消息
  const agentMessages: Message[] = [];

  // 为代理进度 UI 构建进度消息
  const progressMessages: ProgressMessage<AgentProgress>[] = [];
  const parentToolUseID = `forked-command-${command.name}`;
  let toolUseCounter = 0;

  // 将代理消息转换为进度消息的辅助函数
  const createProgressMessage = (message: AssistantMessage | NormalizedUserMessage): ProgressMessage<AgentProgress> => {
    toolUseCounter++;
    return {
      type: 'progress',
      data: {
        message,
        type: 'agent_progress',
        prompt: skillContent,
        agentId,
      },
      parentToolUseID,
      toolUseID: `${parentToolUseID}-${toolUseCounter}`,
      timestamp: new Date().toISOString(),
      uuid: randomUUID(),
    };
  };

  // 使用代理进度 UI 更新进度显示的辅助函数
  const updateProgress = (): void => {
    setToolJSX({
      jsx: renderToolUseProgressMessage(progressMessages, {
        tools: context.options.tools,
        verbose: false,
      }),
      shouldHidePromptInput: false,
      shouldContinueAnimation: true,
      showSpinner: true,
    });
  };

  // 显示初始 "初始化中…" 状态
  updateProgress();

  // 运行子代理
  try {
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
    })) {
      agentMessages.push(message);
      const normalizedNew = normalizeMessages([message]);

      // 为 assistant 消息（包含 tool use）添加进度消息
      if (message.type === 'assistant') {
        // 在 spinner 中递增 assistant 消息的 token 计数
        const contentLength = getAssistantMessageContentLength(message as AssistantMessage);
        if (contentLength > 0) {
          context.setResponseLength(len => len + contentLength);
        }

        const normalizedMsg = normalizedNew[0];
        if (normalizedMsg && normalizedMsg.type === 'assistant') {
          progressMessages.push(createProgressMessage(message as AssistantMessage));
          updateProgress();
        }
      }

      // 为 user 消息（包含 tool results）添加进度消息
      if (message.type === 'user') {
        const normalizedMsg = normalizedNew[0];
        if (normalizedMsg && normalizedMsg.type === 'user') {
          progressMessages.push(createProgressMessage(normalizedMsg as AssistantMessage));
          updateProgress();
        }
      }
    }
  } finally {
    // 清除进度显示
    setToolJSX(null);
  }

  let resultText = extractResultText(agentMessages, 'Command completed');

  logForDebugging(`Forked slash command /${command.name} completed with agent ${agentId}`);

  // 为 ant 用户前置调试日志，使其出现在命令输出内部
  if (process.env.USER_TYPE === 'ant') {
    resultText = `[ANT-ONLY] API calls: ${getDisplayPath(getDumpPromptsPath(agentId))}\n${resultText}`;
  }

  // 将结果作为 user 消息返回（模拟代理的输出）
  const messages: UserMessage[] = [
    createUserMessage({
      content: prepareUserContent({
        inputString: `/${getCommandName(command)} ${args}`.trim(),
        precedingInputBlocks,
      }),
    }),
    createUserMessage({
      content: `<local-command-stdout>\n${resultText}\n</local-command-stdout>`,
    }),
  ];

  return {
    messages,
    shouldQuery: false,
    command,
    resultText,
  };
}

/**
 * 判断字符串是否看起来像有效的命令名。
 * 有效命令名仅包含字母、数字、冒号、连字符和下划线。
 *
 * @param commandName - 待检查的潜在命令名
 * @returns 若看起来像命令名返回 true，若包含非命令字符返回 false
 */
export function looksLikeCommand(commandName: string): boolean {
  // 命令名仅允许包含 [a-zA-Z0-9:_-]
  // 若包含其他字符，可能是文件路径或其他输入
  return !/[^a-zA-Z0-9:\-_]/.test(commandName);
}

export async function processSlashCommand(
  inputString: string,
  precedingInputBlocks: ContentBlockParam[],
  imageContentBlocks: ContentBlockParam[],
  attachmentMessages: AttachmentMessage[],
  context: ProcessUserInputContext,
  setToolJSX: SetToolJSXFn,
  uuid?: string,
  isAlreadyProcessing?: boolean,
  canUseTool?: CanUseToolFn,
  autonomy?: QueuedCommand['autonomy'],
): Promise<ProcessUserInputBaseResult> {
  const parsed = parseSlashCommand(inputString);
  if (!parsed) {
    logEvent('tengu_input_slash_missing', {});
    const errorMessage = 'Commands are in the form `/command [args]`';
    return {
      messages: [
        createSyntheticUserCaveatMessage(),
        ...attachmentMessages,
        createUserMessage({
          content: prepareUserContent({
            inputString: errorMessage,
            precedingInputBlocks,
          }),
        }),
      ],
      shouldQuery: false,
      resultText: errorMessage,
    };
  }

  const { commandName, args: parsedArgs, isMcp } = parsed;

  const sanitizedCommandName = isMcp ? 'mcp' : !builtInCommandNames().has(commandName) ? 'custom' : commandName;

  // 处理之前先检查是否为真实命令
  if (!hasCommand(commandName, context.options.commands)) {
    // 检查这看起来像命令名还是文件路径或其他输入
    // 同时检查是否为实际存在的文件路径
    let isFilePath = false;
    try {
      await getFsImplementation().stat(`/${commandName}`);
      isFilePath = true;
    } catch {
      // 不是文件路径 —— 视为命令名
    }
    if (looksLikeCommand(commandName) && !isFilePath) {
      logEvent('tengu_input_slash_invalid', {
        input: commandName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });

      const unknownMessage = `Unknown skill: ${commandName}`;
      return {
        messages: [
          createSyntheticUserCaveatMessage(),
          ...attachmentMessages,
          createUserMessage({
            content: prepareUserContent({
              inputString: unknownMessage,
              precedingInputBlocks,
            }),
          }),
          // gh-32591: preserve args so the user can copy/resubmit without
          // retyping. System warning is UI-only (filtered before API).
          ...(parsedArgs ? [createSystemMessage(`Args from unknown skill: ${parsedArgs}`, 'warning')] : []),
        ],
        shouldQuery: false,
        resultText: unknownMessage,
      };
    }

    const promptId = randomUUID();
    setPromptId(promptId);
    logEvent('tengu_input_prompt', {});
    // Log user prompt event for OTLP
    void logOTelEvent('user_prompt', {
      prompt_length: String(inputString.length),
      prompt: redactIfDisabled(inputString),
      'prompt.id': promptId,
    });
    return {
      messages: [
        createUserMessage({
          content: prepareUserContent({ inputString, precedingInputBlocks }),
          uuid: uuid,
        }),
        ...attachmentMessages,
      ],
      shouldQuery: true,
    };
  }

  // Track slash command usage for feature discovery

  const {
    messages: newMessages,
    shouldQuery: messageShouldQuery,
    allowedTools,
    model,
    effort,
    command: returnedCommand,
    resultText,
    nextInput,
    submitNextInput,
    deferAutonomyCompletion,
  } = await getMessagesForSlashCommand(
    commandName,
    parsedArgs,
    setToolJSX,
    context,
    precedingInputBlocks,
    imageContentBlocks,
    isAlreadyProcessing,
    canUseTool,
    uuid,
    autonomy,
  );

  // Local slash commands that skip messages
  if (newMessages.length === 0) {
    const eventData: Record<string, boolean | number | undefined> = {
      input: sanitizedCommandName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    };

    // Add plugin metadata if this is a plugin command
    if (returnedCommand.type === 'prompt' && returnedCommand.pluginInfo) {
      const { pluginManifest, repository } = returnedCommand.pluginInfo;
      const { marketplace } = parsePluginIdentifier(repository);
      const isOfficial = isOfficialMarketplaceName(marketplace);
      // _PROTO_* routes to PII-tagged plugin_name/marketplace_name BQ columns
      // (unredacted, all users); plugin_name/plugin_repository stay in
      // additional_metadata as redacted variants for general-access dashboards.
      eventData._PROTO_plugin_name = pluginManifest.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED;
      if (marketplace) {
        eventData._PROTO_marketplace_name = marketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED;
      }
      eventData.plugin_repository = (
        isOfficial ? repository : 'third-party'
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS;
      eventData.plugin_name = (
        isOfficial ? pluginManifest.name : 'third-party'
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS;
      if (isOfficial && pluginManifest.version) {
        eventData.plugin_version = pluginManifest.version as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS;
      }
      Object.assign(eventData, buildPluginCommandTelemetryFields(returnedCommand.pluginInfo));
    }

    logEvent('tengu_input_command', {
      ...eventData,
      invocation_trigger: 'user-slash' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...(process.env.USER_TYPE === 'ant' && {
        skill_name: commandName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        ...(returnedCommand.type === 'prompt' && {
          skill_source: returnedCommand.source as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }),
        ...(returnedCommand.loadedFrom && {
          skill_loaded_from: returnedCommand.loadedFrom as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }),
        ...(returnedCommand.kind && {
          skill_kind: returnedCommand.kind as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }),
      }),
    });
    return {
      messages: [],
      shouldQuery: false,

      model,
      nextInput,
      submitNextInput,
      deferAutonomyCompletion,
    };
  }

  // For invalid commands, preserve both the user message and error
  if (
    newMessages.length === 2 &&
    newMessages[1]!.type === 'user' &&
    typeof newMessages[1]!.message.content === 'string' &&
    newMessages[1]!.message.content.startsWith('Unknown command:')
  ) {
    // Don't log as invalid if it looks like a common file path
    const looksLikeFilePath =
      inputString.startsWith('/var') || inputString.startsWith('/tmp') || inputString.startsWith('/private');

    if (!looksLikeFilePath) {
      logEvent('tengu_input_slash_invalid', {
        input: commandName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
    }

    return {
      messages: [createSyntheticUserCaveatMessage(), ...newMessages],
      shouldQuery: messageShouldQuery,
      allowedTools,

      model,
    };
  }

  // A valid command
  const eventData: Record<string, boolean | number | undefined> = {
    input: sanitizedCommandName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  };

  // Add plugin metadata if this is a plugin command
  if (returnedCommand.type === 'prompt' && returnedCommand.pluginInfo) {
    const { pluginManifest, repository } = returnedCommand.pluginInfo;
    const { marketplace } = parsePluginIdentifier(repository);
    const isOfficial = isOfficialMarketplaceName(marketplace);
    eventData._PROTO_plugin_name = pluginManifest.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED;
    if (marketplace) {
      eventData._PROTO_marketplace_name = marketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED;
    }
    eventData.plugin_repository = (
      isOfficial ? repository : 'third-party'
    ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS;
    eventData.plugin_name = (
      isOfficial ? pluginManifest.name : 'third-party'
    ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS;
    if (isOfficial && pluginManifest.version) {
      eventData.plugin_version = pluginManifest.version as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS;
    }
    Object.assign(eventData, buildPluginCommandTelemetryFields(returnedCommand.pluginInfo));
  }

  logEvent('tengu_input_command', {
    ...eventData,
    invocation_trigger: 'user-slash' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    ...(process.env.USER_TYPE === 'ant' && {
      skill_name: commandName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...(returnedCommand.type === 'prompt' && {
        skill_source: returnedCommand.source as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
      ...(returnedCommand.loadedFrom && {
        skill_loaded_from: returnedCommand.loadedFrom as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
      ...(returnedCommand.kind && {
        skill_kind: returnedCommand.kind as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
    }),
  });

  // Check if this is a compact result which handle their own synthetic caveat message ordering
  const isCompactResult = newMessages.length > 0 && newMessages[0] && isCompactBoundaryMessage(newMessages[0]);

  return {
    messages:
      messageShouldQuery || newMessages.every(isSystemLocalCommandMessage) || isCompactResult
        ? newMessages
        : [createSyntheticUserCaveatMessage(), ...newMessages],
    shouldQuery: messageShouldQuery,
    allowedTools,
    model,
    effort,
    resultText,
    nextInput,
    submitNextInput,
    deferAutonomyCompletion,
  };
}

async function getMessagesForSlashCommand(
  commandName: string,
  args: string,
  setToolJSX: SetToolJSXFn,
  context: ProcessUserInputContext,
  precedingInputBlocks: ContentBlockParam[],
  imageContentBlocks: ContentBlockParam[],
  _isAlreadyProcessing?: boolean,
  canUseTool?: CanUseToolFn,
  uuid?: string,
  autonomy?: QueuedCommand['autonomy'],
): Promise<SlashCommandResult> {
  const command = getCommand(commandName, context.options.commands);

  // Track skill usage for ranking (only for prompt commands that are user-invocable)
  if (command.type === 'prompt' && command.userInvocable !== false) {
    recordSkillUsage(commandName);
  }

  // Check if the command is user-invocable
  // Skills with userInvocable === false can only be invoked by the model via SkillTool
  if (command.userInvocable === false) {
    return {
      messages: [
        createUserMessage({
          content: prepareUserContent({
            inputString: `/${commandName}`,
            precedingInputBlocks,
          }),
        }),
        createUserMessage({
          content: `This skill can only be invoked by Claude, not directly by users. Ask Claude to use the "${commandName}" skill for you.`,
        }),
      ],
      shouldQuery: false,
      command,
    };
  }

  try {
    switch (command.type) {
      case 'local-jsx': {
        return new Promise<SlashCommandResult>(resolve => {
          let doneWasCalled = false;
          const onDone = (
            result?: string,
            options?: {
              display?: CommandResultDisplay;
              shouldQuery?: boolean;
              metaMessages?: string[];
              nextInput?: string;
              submitNextInput?: boolean;
              displayArgs?: string;
            },
          ) => {
            doneWasCalled = true;
            // If display is 'skip', don't add any messages to the conversation
            if (options?.display === 'skip') {
              void resolve({
                messages: [],
                shouldQuery: false,
                command,
                nextInput: options?.nextInput,
                submitNextInput: options?.submitNextInput,
              });
              return;
            }

            // Meta messages are model-visible but hidden from the user
            const metaMessages = (options?.metaMessages ?? []).map((content: string) =>
              createUserMessage({ content, isMeta: true }),
            );

            // In fullscreen the command just showed as a centered modal
            // pane — the transient notification is enough feedback. The
            // "❯ /config" + "⎿ dismissed" transcript entries are
            // type:system subtype:local_command (user-visible but NOT sent
            // to the model), so skipping them doesn't affect model context.
            // Outside fullscreen keep them so scrollback shows what ran.
            // Only skip "<Name> dismissed" modal-close notifications —
            // commands that early-exit before showing a modal (/ultraplan
            // usage, /rename, /proactive) use display:system for actual
            // output that must reach the transcript.
            const skipTranscript =
              isFullscreenEnvEnabled() && typeof result === 'string' && result.endsWith(' dismissed');

            const breadcrumbArgs = options?.displayArgs ?? args;

            void resolve({
              messages:
                options?.display === 'system'
                  ? skipTranscript
                    ? metaMessages
                    : [
                        createCommandInputMessage(formatCommandInput(command, breadcrumbArgs)),
                        createCommandInputMessage(`<local-command-stdout>${result}</local-command-stdout>`),
                        ...metaMessages,
                      ]
                  : [
                      createUserMessage({
                        content: prepareUserContent({
                          inputString: formatCommandInput(command, breadcrumbArgs),
                          precedingInputBlocks,
                        }),
                      }),
                      result
                        ? createUserMessage({
                            content: `<local-command-stdout>${result}</local-command-stdout>`,
                          })
                        : createUserMessage({
                            content: `<local-command-stdout>${NO_CONTENT_MESSAGE}</local-command-stdout>`,
                          }),
                      ...metaMessages,
                    ],
              shouldQuery: options?.shouldQuery ?? false,
              command,
              nextInput: options?.nextInput,
              submitNextInput: options?.submitNextInput,
            });
          };

          void command
            .load()
            .then(mod => mod.call(onDone, { ...context, canUseTool }, args))
            .then(jsx => {
              if (jsx == null) return;
              if (context.options.isNonInteractiveSession) {
                void resolve({
                  messages: [],
                  shouldQuery: false,
                  command,
                });
                return;
              }
              // Guard: if onDone fired during mod.call() (early-exit path
              // that calls onDone then returns JSX), skip setToolJSX. This
              // chain is fire-and-forget — the outer Promise resolves when
              // onDone is called, so executeUserInput may have already run
              // its setToolJSX({clearLocalJSX: true}) before we get here.
              // Setting isLocalJSXCommand after clear leaves it stuck true,
              // blocking useQueueProcessor and TextInput focus.
              if (doneWasCalled) return;
              setToolJSX({
                jsx,
                shouldHidePromptInput: true,
                showSpinner: false,
                isLocalJSXCommand: true,
                isImmediate: command.immediate === true,
              });
            })
            .catch(e => {
              // If load()/call() throws and onDone never fired, the outer
              // Promise hangs forever, leaving queryGuard stuck in
              // 'dispatching' and deadlocking the queue processor.
              logError(e);
              if (doneWasCalled) return;
              doneWasCalled = true;
              setToolJSX({
                jsx: null,
                shouldHidePromptInput: false,
                clearLocalJSX: true,
              });
              void resolve({ messages: [], shouldQuery: false, command });
            });
        });
      }
      case 'local': {
        const displayArgs = command.isSensitive && args.trim() ? '***' : args;
        const userMessage = createUserMessage({
          content: prepareUserContent({
            inputString: formatCommandInput(command, displayArgs),
            precedingInputBlocks,
          }),
        });

        try {
          const syntheticCaveatMessage = createSyntheticUserCaveatMessage();
          const mod = await command.load();
          const result = await mod.call(args, context);

          if (result.type === 'skip') {
            return {
              messages: [],
              shouldQuery: false,
              command,
            };
          }

          // Use discriminated union to handle different result types
          if (result.type === 'compact') {
            // Append slash command messages to messagesToKeep so that
            // attachments and hookResults come after user messages
            const slashCommandMessages = [
              syntheticCaveatMessage,
              userMessage,
              ...(result.displayText
                ? [
                    createUserMessage({
                      content: `<local-command-stdout>${result.displayText}</local-command-stdout>`,
                      // --resume looks at latest timestamp message to determine which message to resume from
                      // This is a perf optimization to avoid having to recaculcate the leaf node every time
                      // Since we're creating a bunch of synthetic messages for compact, it's important to set
                      // the timestamp of the last message to be slightly after the current time
                      // This is mostly important for sdk / -p mode
                      timestamp: new Date(Date.now() + 100).toISOString(),
                    }),
                  ]
                : []),
            ];
            const compactionResultWithSlashMessages = {
              ...result.compactionResult,
              messagesToKeep: [...(result.compactionResult.messagesToKeep ?? []), ...slashCommandMessages],
            };
            // Reset microcompact state since full compact replaces all
            // messages — old tool IDs are no longer relevant. Budget state
            // (on toolUseContext) needs no reset: stale entries are inert
            // (UUIDs never repeat, so they're never looked up).
            resetMicrocompactState();
            return {
              messages: buildPostCompactMessages(compactionResultWithSlashMessages) as AssistantMessage[],
              shouldQuery: false,
              command,
            };
          }

          // Text result — use system message so it doesn't render as a user bubble
          return {
            messages: [
              userMessage,
              createCommandInputMessage(`<local-command-stdout>${result.value}</local-command-stdout>`),
            ],
            shouldQuery: false,
            command,
            resultText: result.value,
          };
        } catch (e) {
          logError(e);
          return {
            messages: [
              userMessage,
              createCommandInputMessage(`<local-command-stderr>${String(e)}</local-command-stderr>`),
            ],
            shouldQuery: false,
            command,
          };
        }
      }
      case 'prompt': {
        try {
          // Check if command should run as forked sub-agent
          if (command.context === 'fork') {
            return await executeForkedSlashCommand(
              command,
              args,
              context,
              precedingInputBlocks,
              setToolJSX,
              canUseTool ?? hasPermissionsToUseTool,
              autonomy,
            );
          }

          return await getMessagesForPromptSlashCommand(
            command,
            args,
            context,
            precedingInputBlocks,
            imageContentBlocks,
            uuid,
          );
        } catch (e) {
          // Handle abort errors specially to show proper "Interrupted" message
          if (e instanceof AbortError) {
            return {
              messages: [
                createUserMessage({
                  content: prepareUserContent({
                    inputString: formatCommandInput(command, args),
                    precedingInputBlocks,
                  }),
                }),
                createUserInterruptionMessage({ toolUse: false }),
              ],
              shouldQuery: false,
              command,
            };
          }
          return {
            messages: [
              createUserMessage({
                content: prepareUserContent({
                  inputString: formatCommandInput(command, args),
                  precedingInputBlocks,
                }),
              }),
              createUserMessage({
                content: `<local-command-stderr>${String(e)}</local-command-stderr>`,
              }),
            ],
            shouldQuery: false,
            command,
          };
        }
      }
    }
  } catch (e) {
    if (e instanceof MalformedCommandError) {
      return {
        messages: [
          createUserMessage({
            content: prepareUserContent({
              inputString: e.message,
              precedingInputBlocks,
            }),
          }),
        ],
        shouldQuery: false,
        command,
      };
    }
    throw e;
  }
}

function formatCommandInput(command: CommandBase, args: string): string {
  return formatCommandInputTags(getCommandName(command), args);
}

/**
 * Formats the metadata for a skill loading message.
 * Used by the Skill tool and for subagent skill preloading.
 */
export function formatSkillLoadingMetadata(skillName: string, _progressMessage: string = 'loading'): string {
  // Use skill name only - UserCommandMessage renders as "Skill(name)"
  return [
    `<${COMMAND_MESSAGE_TAG}>${skillName}</${COMMAND_MESSAGE_TAG}>`,
    `<${COMMAND_NAME_TAG}>${skillName}</${COMMAND_NAME_TAG}>`,
    `<skill-format>true</skill-format>`,
  ].join('\n');
}

/**
 * Formats the metadata for a slash command loading message.
 */
function formatSlashCommandLoadingMetadata(commandName: string, args?: string): string {
  return [
    `<${COMMAND_MESSAGE_TAG}>${commandName}</${COMMAND_MESSAGE_TAG}>`,
    `<${COMMAND_NAME_TAG}>/${commandName}</${COMMAND_NAME_TAG}>`,
    args ? `<command-args>${args}</command-args>` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Formats the loading metadata for a command (skill or slash command).
 * User-invocable skills use slash command format (/name), while model-only
 * skills use the skill format ("The X skill is running").
 */
function formatCommandLoadingMetadata(command: CommandBase & PromptCommand, args?: string): string {
  // Use command.name (the qualified name including plugin prefix, e.g.
  // "product-management:feature-spec") instead of userFacingName() which may
  // strip the plugin prefix via displayName fallback.
  // User-invocable skills should show as /command-name like regular slash commands
  if (command.userInvocable !== false) {
    return formatSlashCommandLoadingMetadata(command.name, args);
  }
  // Model-only skills (userInvocable: false) show as "The X skill is running"
  if (command.loadedFrom === 'skills' || command.loadedFrom === 'plugin' || command.loadedFrom === 'mcp') {
    return formatSkillLoadingMetadata(command.name, command.progressMessage);
  }
  return formatSlashCommandLoadingMetadata(command.name, args);
}

export async function processPromptSlashCommand(
  commandName: string,
  args: string,
  commands: Command[],
  context: ToolUseContext,
  imageContentBlocks: ContentBlockParam[] = [],
): Promise<SlashCommandResult> {
  const command = findCommand(commandName, commands);
  if (!command) {
    throw new MalformedCommandError(`Unknown command: ${commandName}`);
  }
  if (command.type !== 'prompt') {
    throw new Error(
      `Unexpected ${command.type} command. Expected 'prompt' command. Use /${commandName} directly in the main conversation.`,
    );
  }
  return getMessagesForPromptSlashCommand(command, args, context, [], imageContentBlocks);
}

async function getMessagesForPromptSlashCommand(
  command: CommandBase & PromptCommand,
  args: string,
  context: ToolUseContext,
  precedingInputBlocks: ContentBlockParam[] = [],
  imageContentBlocks: ContentBlockParam[] = [],
  uuid?: string,
): Promise<SlashCommandResult> {
  // In coordinator mode (main thread only), skip loading the full skill content
  // and permissions. The coordinator only has Agent + TaskStop tools, so the
  // skill content and allowedTools are useless. Instead, send a brief summary
  // telling the coordinator how to delegate this skill to a worker.
  //
  // Workers run in-process and inherit CLAUDE_CODE_COORDINATOR_MODE from the
  // parent env, so we also check !context.agentId: agentId is only set for
  // subagents, letting workers fall through to getPromptForCommand and receive
  // the real skill content when they invoke the Skill tool.
  if (feature('COORDINATOR_MODE') && isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE) && !context.agentId) {
    const metadata = formatCommandLoadingMetadata(command, args);
    const parts: string[] = [`Skill "/${command.name}" is available for workers.`];
    if (command.description) {
      parts.push(`Description: ${command.description}`);
    }
    if (command.whenToUse) {
      parts.push(`When to use: ${command.whenToUse}`);
    }
    const skillAllowedTools = command.allowedTools ?? [];
    if (skillAllowedTools.length > 0) {
      parts.push(`This skill grants workers additional tool permissions: ${skillAllowedTools.join(', ')}`);
    }
    parts.push(
      `\nInstruct a worker to use this skill by including "Use the /${command.name} skill" in your Agent prompt. The worker has access to the Skill tool and will receive the skill's content and permissions when it invokes it.`,
    );
    const summaryContent: ContentBlockParam[] = [{ type: 'text', text: parts.join('\n') }];
    return {
      messages: [
        createUserMessage({ content: metadata, uuid }),
        createUserMessage({ content: summaryContent, isMeta: true }),
      ],
      shouldQuery: true,
      model: command.model,
      effort: command.effort,
      command,
    };
  }

  const result = await command.getPromptForCommand(args, context);

  // Register skill hooks if defined. Under ["hooks"]-only (skills not locked),
  // user skills still load and reach this point — block hook REGISTRATION here
  // where source is known. Mirrors the agent frontmatter gate in runAgent.ts.
  const hooksAllowedForThisSkill = !isRestrictedToPluginOnly('hooks') || isSourceAdminTrusted(command.source);
  if (command.hooks && hooksAllowedForThisSkill) {
    const sessionId = getSessionId();
    registerSkillHooks(
      context.setAppState,
      sessionId,
      command.hooks,
      command.name,
      command.type === 'prompt' ? command.skillRoot : undefined,
    );
  }

  // Record skill invocation for compaction preservation, scoped by agent context.
  // Skills are tagged with their agentId so only skills belonging to the current
  // agent are restored during compaction (preventing cross-agent leaks).
  const skillPath = command.source ? `${command.source}:${command.name}` : command.name;
  const skillContent = result
    .filter((b): b is TextBlockParam => b.type === 'text')
    .map(b => b.text)
    .join('\n\n');
  addInvokedSkill(command.name, skillPath, skillContent, getAgentContext()?.agentId ?? null);

  const metadata = formatCommandLoadingMetadata(command, args);

  const additionalAllowedTools = parseToolListFromCLI(command.allowedTools ?? []);

  // Create content for the main message, including any pasted images
  const mainMessageContent: ContentBlockParam[] =
    imageContentBlocks.length > 0 || precedingInputBlocks.length > 0
      ? [...imageContentBlocks, ...precedingInputBlocks, ...result]
      : result;

  // Extract attachments from command arguments (@-mentions, MCP resources,
  // agent mentions in SKILL.md). skipSkillDiscovery prevents the SKILL.md
  // content itself from triggering discovery — it's meta-content, not user
  // intent, and a large SKILL.md (e.g. 110KB) would fire chunked AKI queries
  // adding seconds of latency to every skill invocation.
  const attachmentMessages = await toArray(
    getAttachmentMessages(
      result
        .filter((block): block is TextBlockParam => block.type === 'text')
        .map(block => block.text)
        .join(' '),
      context,
      null,
      [], // queuedCommands - handled by query.ts for mid-turn attachments
      context.messages,
      'repl_main_thread',
      { skipSkillDiscovery: true },
    ),
  );

  const messages = [
    createUserMessage({
      content: metadata,
      uuid,
    }),
    createUserMessage({
      content: mainMessageContent,
      isMeta: true,
    }),
    ...attachmentMessages,
    createAttachmentMessage({
      type: 'command_permissions',
      allowedTools: additionalAllowedTools,
      model: command.model,
    }),
  ];

  return {
    messages,
    shouldQuery: true,
    allowedTools: additionalAllowedTools,
    model: command.model,
    effort: command.effort,
    command,
  };
}
