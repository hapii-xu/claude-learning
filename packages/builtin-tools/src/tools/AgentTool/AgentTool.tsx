import { feature } from 'bun:bundle';
import * as React from 'react';
import { buildTool, type ToolDef, toolMatchesName } from 'src/Tool.js';
import type { AssistantMessage, Message as MessageType, NormalizedUserMessage } from 'src/types/message.js';
import { getQuerySourceForAgent } from 'src/utils/promptCategory.js';
import { z } from 'zod/v4';
import { clearInvokedSkillsForAgent, getSdkAgentProgressSummariesEnabled } from 'src/bootstrap/state.js';
import { enhanceSystemPromptWithEnvDetails, getSystemPrompt } from 'src/constants/prompts.js';
import { isCoordinatorMode } from 'src/coordinator/coordinatorMode.js';
import { startAgentSummarization } from 'src/services/AgentSummary/agentSummary.js';
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js';
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js';
import { clearDumpState } from 'src/services/api/dumpPrompts.js';
import {
  completeAgentTask as completeAsyncAgent,
  createActivityDescriptionResolver,
  createProgressTracker,
  enqueueAgentNotification,
  failAgentTask as failAsyncAgent,
  getProgressUpdate,
  getTokenCountFromTracker,
  isLocalAgentTask,
  killAsyncAgent,
  registerAgentForeground,
  registerAsyncAgent,
  unregisterAgentForeground,
  updateAgentProgress as updateAsyncAgentProgress,
  updateProgressFromMessage,
} from 'src/tasks/LocalAgentTask/LocalAgentTask.js';
import {
  checkRemoteAgentEligibility,
  formatPreconditionError,
  getRemoteTaskSessionUrl,
  registerRemoteAgentTask,
  type BackgroundRemoteSessionPrecondition,
} from 'src/tasks/RemoteAgentTask/RemoteAgentTask.js';
import { assembleToolPool } from 'src/tools.js';
import { filterParentToolsForFork } from 'src/utils/agentToolFilter.js';
import { asAgentId } from 'src/types/ids.js';
import { runWithAgentContext, type SubagentContext } from 'src/utils/agentContext.js';
import { isAgentSwarmsEnabled } from 'src/utils/agentSwarmsEnabled.js';
import { getCwd, runWithCwdOverride } from 'src/utils/cwd.js';
import { logForDebugging } from 'src/utils/debug.js';
import { isEnvTruthy } from 'src/utils/envUtils.js';
import { AbortError, errorMessage, toError } from 'src/utils/errors.js';
import type { CacheSafeParams } from 'src/utils/forkedAgent.js';
import { lazySchema } from 'src/utils/lazySchema.js';
import { createUserMessage, extractTextContent, isSyntheticMessage, normalizeMessages } from 'src/utils/messages.js';
import { getAgentModel } from 'src/utils/model/agent.js';
import { permissionModeSchema } from 'src/utils/permissions/PermissionMode.js';
import type { PermissionResult } from 'src/utils/permissions/PermissionResult.js';
import { filterDeniedAgents, getDenyRuleForAgent } from 'src/utils/permissions/permissions.js';
import { enqueueSdkEvent } from 'src/utils/sdkEventQueue.js';
import { writeAgentMetadata } from 'src/utils/sessionStorage.js';
import { sleep } from 'src/utils/sleep.js';
import { buildEffectiveSystemPrompt } from 'src/utils/systemPrompt.js';
import { asSystemPrompt } from 'src/utils/systemPromptType.js';
import { getTaskOutputPath } from 'src/utils/task/diskOutput.js';
import { getParentSessionId, isTeammate } from 'src/utils/teammate.js';
import { isInProcessTeammate } from 'src/utils/teammateContext.js';
import { teleportToRemote } from 'src/utils/teleport.js';
import { getAssistantMessageContentLength } from 'src/utils/tokens.js';
import { createAgentId } from 'src/utils/uuid.js';
import { createAgentWorktree, hasWorktreeChanges, removeAgentWorktree } from 'src/utils/worktree.js';
import { BASH_TOOL_NAME } from '../BashTool/toolName.js';
import { BackgroundHint } from '../BashTool/UI.js';
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js';
import { spawnTeammate } from '../shared/spawnMultiAgent.js';
import { setAgentColor } from './agentColorManager.js';
import {
  agentToolResultSchema,
  classifyHandoffIfNeeded,
  emitTaskProgress,
  extractPartialResult,
  finalizeAgentTool,
  getLastToolUseName,
  runAsyncAgentLifecycle,
} from './agentToolUtils.js';
import { GENERAL_PURPOSE_AGENT } from './built-in/generalPurposeAgent.js';
import { AGENT_TOOL_NAME, LEGACY_AGENT_TOOL_NAME, ONE_SHOT_BUILTIN_AGENT_TYPES } from './constants.js';
import {
  buildForkedMessages,
  buildWorktreeNotice,
  FORK_AGENT,
  isForkSubagentEnabled,
  isInForkChild,
} from './forkSubagent.js';
import type { AgentDefinition } from './loadAgentsDir.js';
import { filterAgentsByMcpRequirements, hasRequiredMcpServers, isBuiltInAgent } from './loadAgentsDir.js';
import { getPrompt } from './prompt.js';
import { runAgent } from './runAgent.js';
import {
  renderGroupedAgentToolUse,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolUseRejectedMessage,
  renderToolUseTag,
  userFacingName,
  userFacingNameBackgroundColor,
} from './UI.js';

/* eslint-disable @typescript-eslint/no-require-imports */
const proactiveModule =
  feature('PROACTIVE') || feature('KAIROS')
    ? (require('src/proactive/index.js') as typeof import('src/proactive/index.js'))
    : null;
/* eslint-enable @typescript-eslint/no-require-imports */

// 进度显示常量（用于显示后台提示）
const PROGRESS_THRESHOLD_MS = 2000; // 2 秒后显示后台提示

// 在模块加载时检查是否禁用后台任务
const isBackgroundTasksDisabled =
  // eslint-disable-next-line custom-rules/no-process-env-top-level -- Intentional: schema must be defined at module load
  isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS);

// 在此毫秒数后自动将代理任务转为后台（0 = 禁用）
// 通过环境变量或 GrowthBook 门控启用（延迟检查，因为 GB 在模块加载时可能未就绪）
function getAutoBackgroundMs(): number {
  if (
    isEnvTruthy(process.env.CLAUDE_AUTO_BACKGROUND_TASKS) ||
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_auto_background_agents', false)
  ) {
    return 120_000;
  }
  return 0;
}

// 多代理类型常量在门控块内内联定义以启用死代码消除

// 不带多代理参数的基础输入模式
const baseInputSchema = lazySchema(() =>
  z.object({
    description: z.string().describe('A short (3-5 word) description of the task'),
    prompt: z.string().describe('The task for the agent to perform'),
    subagent_type: z.string().optional().describe('The type of specialized agent to use for this task'),
    model: z
      .enum(['sonnet', 'opus', 'haiku'])
      .optional()
      .describe(
        "Optional model override for this agent. Takes precedence over the agent definition's model frontmatter. If omitted, uses the agent definition's model, or inherits from the parent.",
      ),
    run_in_background: z
      .boolean()
      .optional()
      .describe('Set to true to run this agent in the background. You will be notified when it completes.'),
  }),
);

// 完整模式，结合基础 + 多代理参数 + 隔离
const fullInputSchema = lazySchema(() => {
  // 多代理参数
  const multiAgentInputSchema = z.object({
    name: z
      .string()
      .optional()
      .describe('Name for the spawned agent. Makes it addressable via SendMessage({to: name}) while running.'),
    team_name: z.string().optional().describe('Team name for spawning. Uses current team context if omitted.'),
    mode: permissionModeSchema()
      .optional()
      .describe('Permission mode for spawned teammate (e.g., "plan" to require plan approval).'),
  });

  return baseInputSchema()
    .merge(multiAgentInputSchema)
    .extend({
      isolation: (process.env.USER_TYPE === 'ant' ? z.enum(['worktree', 'remote']) : z.enum(['worktree']))
        .optional()
        .describe(
          process.env.USER_TYPE === 'ant'
            ? 'Isolation mode. "worktree" creates a temporary git worktree so the agent works on an isolated copy of the repo. "remote" launches the agent in a remote CCR environment (always runs in background).'
            : 'Isolation mode. "worktree" creates a temporary git worktree so the agent works on an isolated copy of the repo.',
        ),
      cwd: z
        .string()
        .optional()
        .describe(
          'Absolute path to run the agent in. Overrides the working directory for all filesystem and shell operations within this agent. Mutually exclusive with isolation: "worktree".',
        ),
    });
});

// 当底层功能关闭时，从模式中剥离可选字段，以便
// 模型永远看不到它们。通过 .omit() 完成而不是在 .extend() 内部
// 条件展开，因为展开-三元运算会破坏 Zod 的类型推断
// （字段类型折叠为 `unknown`）。三元返回产生联合
// 类型，但 call() 通过下方的显式 AgentToolInput 类型解构
// 该类型始终包含所有可选字段。
export const inputSchema = lazySchema(() => {
  const schema = feature('KAIROS') ? fullInputSchema() : fullInputSchema().omit({ cwd: true });

  // 此处的 GrowthBook-in-lazySchema 是可接受的（不像 subagent_type，
  // 它在 906da6c723 中被移除）：通过 _CACHED_MAY_BE_STALE 磁盘读取，
  // 分歧窗口是每次门控翻转一个会话，最坏情况要么是
  // "模式显示无操作参数"（门控在会话中途翻转为开：参数被
  // forceAsync 忽略）或"模式隐藏本可以工作的参数"（门控
  // 在会话中途翻转为关：一切仍然通过记忆化的
  // forceAsync 异步运行）。没有 Zod 拒绝，没有崩溃 — 不像 required→optional。
  return isBackgroundTasksDisabled || isForkSubagentEnabled() ? schema.omit({ run_in_background: true }) : schema;
});
type InputSchema = ReturnType<typeof inputSchema>;

// 显式类型拓宽模式推断以始终包含所有可选
// 字段，即使 .omit() 为门控剥离它们（cwd、run_in_background）。
// subagent_type 是可选的；当 fork 门控关闭时，call() 将其默认为 general-purpose，
// 或当门控开启时路由到 fork 路径。
type AgentToolInput = z.infer<ReturnType<typeof baseInputSchema>> & {
  name?: string;
  team_name?: string;
  mode?: z.infer<ReturnType<typeof permissionModeSchema>>;
  isolation?: 'worktree' | 'remote';
  cwd?: string;
};

// 输出模式 - 多代理生成的模式在运行时动态添加（当启用时）
export const outputSchema = lazySchema(() => {
  const syncOutputSchema = agentToolResultSchema().extend({
    status: z.literal('completed'),
    prompt: z.string(),
  });

  const asyncOutputSchema = z.object({
    status: z.literal('async_launched'),
    agentId: z.string().describe('The ID of the async agent'),
    description: z.string().describe('The description of the task'),
    prompt: z.string().describe('The prompt for the agent'),
    outputFile: z.string().describe('Path to the output file for checking agent progress'),
    canReadOutputFile: z
      .boolean()
      .optional()
      .describe('Whether the calling agent has Read/Bash tools to check progress'),
  });

  return z.union([syncOutputSchema, asyncOutputSchema]);
});
type OutputSchema = ReturnType<typeof outputSchema>;
type Output = z.input<OutputSchema>;

// 队友生成结果的私有类型 - 为死代码消除从导出模式中排除
// 'teammate_spawned' 状态字符串仅在 ENABLE_AGENT_SWARMS 为真时包含
type TeammateSpawnedOutput = {
  status: 'teammate_spawned';
  prompt: string;
  teammate_id: string;
  agent_id: string;
  agent_type?: string;
  model?: string;
  name: string;
  color?: string;
  tmux_session_name: string;
  tmux_window_name: string;
  tmux_pane_id: string;
  team_name?: string;
  is_splitpane?: boolean;
  plan_mode_required?: boolean;
};

// 组合输出类型，包括公共和内部类型
// 注意：TeammateSpawnedOutput 类型没问题 - TypeScript 类型在编译时被擦除
// 远程启动结果的私有类型 — 为死代码消除目的像 TeammateSpawnedOutput 一样
// 从导出模式中排除。导出是为了让 UI.tsx 进行适当的
// 判别联合缩小而不是临时转换。
export type RemoteLaunchedOutput = {
  status: 'remote_launched';
  taskId: string;
  sessionUrl: string;
  description: string;
  prompt: string;
  outputFile: string;
};

type InternalOutput = Output | TeammateSpawnedOutput | RemoteLaunchedOutput;

import type { AgentToolProgress, ShellProgress } from 'src/types/tools.js';
// AgentTool 转发其自身的进度事件和来自子代理的 shell 进度
// 事件，以便 SDK 在 bash/powershell 运行期间接收 tool_progress 更新。
export type Progress = AgentToolProgress | ShellProgress;

export const AgentTool = buildTool({
  async prompt({ agents, tools, getToolPermissionContext, allowedAgentTypes }) {
    const toolPermissionContext = await getToolPermissionContext();

    // 获取有可用工具的 MCP 服务器
    const mcpServersWithTools: string[] = [];
    for (const tool of tools) {
      if (tool.name?.startsWith('mcp__')) {
        const parts = tool.name.split('__');
        const serverName = parts[1];
        if (serverName && !mcpServersWithTools.includes(serverName)) {
          mcpServersWithTools.push(serverName);
        }
      }
    }

    // 过滤代理：首先按 MCP 要求，然后按权限规则
    const agentsWithMcpRequirementsMet = filterAgentsByMcpRequirements(agents, mcpServersWithTools);
    const filteredAgents = filterDeniedAgents(agentsWithMcpRequirementsMet, toolPermissionContext, AGENT_TOOL_NAME);

    // 使用内联环境变量检查而不是 coordinatorModule 以避免
    // 测试模块加载期间的循环依赖问题。
    const isCoordinator = feature('COORDINATOR_MODE') ? isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE) : false;
    return await getPrompt(filteredAgents, isCoordinator, allowedAgentTypes);
  },
  name: AGENT_TOOL_NAME,
  searchHint: 'delegate work to a subagent',
  aliases: [LEGACY_AGENT_TOOL_NAME],
  maxResultSizeChars: 100_000,
  async description() {
    return 'Launch a new agent';
  },
  get inputSchema(): InputSchema {
    return inputSchema();
  },
  get outputSchema(): OutputSchema {
    return outputSchema();
  },
  async call(
    {
      prompt,
      subagent_type,
      description,
      model: modelParam,
      run_in_background,
      name,
      team_name,
      mode: spawnMode,
      isolation,
      cwd,
    }: AgentToolInput,
    toolUseContext,
    canUseTool,
    assistantMessage,
    onProgress?,
  ) {
    const startTime = Date.now();
    logForDebugging(
      `[Agent] call() 开始 subagent_type=${subagent_type ?? '（未指定）'} run_in_background=${run_in_background ?? false}`,
      { level: 'info' },
    );
    const model = isCoordinatorMode() ? undefined : modelParam;

    // 获取应用状态以获取权限模式和代理过滤
    const appState = toolUseContext.getAppState();
    const permissionMode = appState.toolPermissionContext.mode;
    // 进程内队友获得一个空操作的 setAppState；setAppStateForTasks
    // 到达根存储以便任务注册/进度/终止保持可见。
    const rootSetAppState = toolUseContext.setAppStateForTasks ?? toolUseContext.setAppState;

    // 检查用户是否尝试在没有访问权限的情况下使用代理团队
    if (team_name && !isAgentSwarmsEnabled()) {
      throw new Error('Agent Teams is not yet available on your plan.');
    }

    // 队友（进程内或 tmux）传递 `name` 会触发下方的 spawnTeammate()，
    // 但 TeamFile.members 是一个带有 leadAgentId 的平面数组 — 嵌套的
    // 队友会出现在名单中没有来源并混淆领导。
    const teamName = resolveTeamName({ team_name }, appState);
    if (isTeammate() && teamName && name) {
      throw new Error(
        'Teammates cannot spawn other teammates — the team roster is flat. To spawn a subagent instead, omit the `name` parameter.',
      );
    }
    // 进程内队友不能生成后台代理（它们的生命周期绑定到
    // 领导的进程）。Tmux 队友是独立的进程，可以管理自己的后台代理。
    if (isInProcessTeammate() && teamName && run_in_background === true) {
      throw new Error(
        'In-process teammates cannot spawn background agents. Use run_in_background=false for synchronous subagents.',
      );
    }

    // 检查这是否是一个多代理生成请求
    // 当 team_name 被设置（来自参数或上下文）且提供了 name 时触发生成
    if (teamName && name) {
      // 在生成之前设置代理定义颜色以用于分组的 UI 显示
      const agentDef = subagent_type
        ? toolUseContext.options.agentDefinitions.activeAgents.find(a => a.agentType === subagent_type)
        : undefined;
      if (agentDef?.color) {
        setAgentColor(subagent_type!, agentDef.color);
      }
      const result = await spawnTeammate(
        {
          name,
          prompt,
          description,
          team_name: teamName,
          use_splitpane: true,
          plan_mode_required: spawnMode === 'plan',
          model: model ?? agentDef?.model,
          agent_type: subagent_type,
          invokingRequestId: assistantMessage?.requestId as string | undefined,
        },
        toolUseContext,
      );

      // 类型断言使用 TeammateSpawnedOutput（在上方定义）而不是 any。
      // 此类型从导出的 outputSchema 中排除以进行死代码消除。
      // 通过 unknown 转换，因为 TeammateSpawnedOutput 故意
      // 不是导出的 Output 联合的一部分（出于死代码消除目的）。
      const spawnResult: TeammateSpawnedOutput = {
        status: 'teammate_spawned' as const,
        prompt,
        ...result.data,
      };
      return { data: spawnResult } as unknown as { data: Output };
    }

    // Fork 子代理实验路由：
    // - 设置了 subagent_type：使用它（显式优先）
    // - 省略 subagent_type，门控开启：fork 路径（undefined）
    // - 省略 subagent_type，门控关闭：默认 general-purpose
    const effectiveType = subagent_type ?? (isForkSubagentEnabled() ? undefined : GENERAL_PURPOSE_AGENT.agentType);
    const isForkPath = effectiveType === undefined;
    logForDebugging(`[Agent] 路由决策 isForkPath=${isForkPath} effectiveType=${effectiveType ?? 'undefined'}`, {
      level: 'info',
    });

    let selectedAgent: AgentDefinition;
    if (isForkPath) {
      // 递归 fork 守卫：fork 子代理在其工具池中保留 Agent 工具
      // 以获得缓存相同的工具定义，所以在调用时拒绝 fork 尝试。
      // 主要检查是 querySource（抗压缩 — 在生成时设置在
      // context.options 上，在自动压缩的消息重写后仍然存在）。
      // 消息扫描后备捕获 querySource 未被传递的任何路径。
      if (
        toolUseContext.options.querySource === `agent:builtin:${FORK_AGENT.agentType}` ||
        isInForkChild(toolUseContext.messages)
      ) {
        throw new Error('Fork is not available inside a forked worker. Complete your task directly using your tools.');
      }
      selectedAgent = FORK_AGENT;
    } else {
      // 过滤代理以排除通过 Agent(AgentName) 语法被拒绝的那些
      const allAgents = toolUseContext.options.agentDefinitions.activeAgents;
      const { allowedAgentTypes } = toolUseContext.options.agentDefinitions;
      const agents = filterDeniedAgents(
        // 当设置了 allowedAgentTypes 时（来自 Agent(x,y) 工具规范），限制为这些类型
        allowedAgentTypes ? allAgents.filter(a => allowedAgentTypes.includes(a.agentType)) : allAgents,
        appState.toolPermissionContext,
        AGENT_TOOL_NAME,
      );

      const found = agents.find(agent => agent.agentType === effectiveType);
      if (!found) {
        // 检查代理是否存在但被权限规则拒绝
        const agentExistsButDenied = allAgents.find(agent => agent.agentType === effectiveType);
        if (agentExistsButDenied) {
          const denyRule = getDenyRuleForAgent(appState.toolPermissionContext, AGENT_TOOL_NAME, effectiveType);
          throw new Error(
            `Agent type '${effectiveType}' has been denied by permission rule '${AGENT_TOOL_NAME}(${effectiveType})' from ${denyRule?.source ?? 'settings'}.`,
          );
        }
        throw new Error(
          `Agent type '${effectiveType}' not found. Available agents: ${agents.map(a => a.agentType).join(', ')}`,
        );
      }
      selectedAgent = found;
    }

    // 与上方的 run_in_background 守卫相同的生命周期约束，但适用于
    // 通过 `background: true` 强制后台的代理定义。在此处检查
    // 因为 selectedAgent 直到现在才被解析。
    if (isInProcessTeammate() && teamName && selectedAgent.background === true) {
      throw new Error(
        `In-process teammates cannot spawn background agents. Agent '${selectedAgent.agentType}' has background: true in its definition.`,
      );
    }

    // 捕获以进行类型收窄 — `let selectedAgent` 阻止 TS 在
    // 上方 if-else 赋值中收窄属性类型。
    const requiredMcpServers = selectedAgent.requiredMcpServers;

    // 检查所需的 MCP 服务器是否有可用工具
    // 已连接但未认证的服务器不会有任何工具
    if (requiredMcpServers?.length) {
      // 如果任何所需的服务器仍在等待（连接中），在检查工具可用性之前等待它们。
      // 这避免了在 MCP 服务器完成连接之前调用代理的竞争条件。
      const hasPendingRequiredServers = appState.mcp.clients.some(
        c =>
          c.type === 'pending' &&
          requiredMcpServers.some(pattern => c.name.toLowerCase().includes(pattern.toLowerCase())),
      );

      let currentAppState = appState;
      if (hasPendingRequiredServers) {
        const MAX_WAIT_MS = 30_000;
        const POLL_INTERVAL_MS = 500;
        const deadline = Date.now() + MAX_WAIT_MS;

        while (Date.now() < deadline) {
          await sleep(POLL_INTERVAL_MS);
          currentAppState = toolUseContext.getAppState();

          // 提前退出：如果任何所需的服务器已经失败，没必要
          // 等待其他待处理的服务器 — 无论如何检查都会失败。
          const hasFailedRequiredServer = currentAppState.mcp.clients.some(
            c =>
              c.type === 'failed' &&
              requiredMcpServers.some(pattern => c.name.toLowerCase().includes(pattern.toLowerCase())),
          );
          if (hasFailedRequiredServer) break;

          const stillPending = currentAppState.mcp.clients.some(
            c =>
              c.type === 'pending' &&
              requiredMcpServers.some(pattern => c.name.toLowerCase().includes(pattern.toLowerCase())),
          );
          if (!stillPending) break;
        }
      }

      // 获取实际有工具的服务器（意味着它们已连接且已认证）
      const serversWithTools: string[] = [];
      for (const tool of currentAppState.mcp.tools) {
        if (tool.name?.startsWith('mcp__')) {
          // 从工具名称中提取服务器名称（格式：mcp__serverName__toolName）
          const parts = tool.name.split('__');
          const serverName = parts[1];
          if (serverName && !serversWithTools.includes(serverName)) {
            serversWithTools.push(serverName);
          }
        }
      }

      if (!hasRequiredMcpServers(selectedAgent, serversWithTools)) {
        const missing = requiredMcpServers.filter(
          pattern => !serversWithTools.some(server => server.toLowerCase().includes(pattern.toLowerCase())),
        );
        throw new Error(
          `Agent '${selectedAgent.agentType}' requires MCP servers matching: ${missing.join(', ')}. ` +
            `MCP servers with tools: ${serversWithTools.length > 0 ? serversWithTools.join(', ') : 'none'}. ` +
            `Use /mcp to configure and authenticate the required MCP servers.`,
        );
      }
    }

    // 如果有预定义的颜色，为此代理初始化颜色
    if (selectedAgent.color) {
      setAgentColor(selectedAgent.agentType, selectedAgent.color);
    }

    // 解析代理参数以进行记录（这些已经在 runAgent 中解析）
    const resolvedAgentModel = getAgentModel(
      selectedAgent.model,
      toolUseContext.options.mainLoopModel,
      isForkPath ? undefined : model,
      permissionMode,
    );

    logEvent('tengu_agent_tool_selected', {
      agent_type: selectedAgent.agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      model: resolvedAgentModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      source: selectedAgent.source as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      color: selectedAgent.color as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      is_built_in_agent: isBuiltInAgent(selectedAgent),
      is_resume: false,
      is_async: (run_in_background === true || selectedAgent.background === true) && !isBackgroundTasksDisabled,
      is_fork: isForkPath,
    });

    // 解析有效的隔离模式（显式参数覆盖代理定义）
    const effectiveIsolation = isolation ?? selectedAgent.isolation;

    // 远程隔离：委托给 CCR。仅限 ant 的门控 — 守卫启用
    // 整个块的死代码消除用于外部构建。
    if (process.env.USER_TYPE === 'ant' && effectiveIsolation === 'remote') {
      const eligibility = await checkRemoteAgentEligibility();
      if (!eligibility.eligible) {
        const reasons = (eligibility as { eligible: false; errors: BackgroundRemoteSessionPrecondition[] }).errors
          .map(formatPreconditionError)
          .join('\n');
        throw new Error(`Cannot launch remote agent:\n${reasons}`);
      }

      let bundleFailHint: string | undefined;
      const session = await teleportToRemote({
        initialMessage: prompt,
        description,
        signal: toolUseContext.abortController.signal,
        onBundleFail: msg => {
          bundleFailHint = msg;
        },
      });
      if (!session) {
        throw new Error(bundleFailHint ?? 'Failed to create remote session');
      }

      const { taskId, sessionId } = registerRemoteAgentTask({
        remoteTaskType: 'remote-agent',
        session: { id: session.id, title: session.title || description },
        command: prompt,
        context: toolUseContext,
        toolUseId: toolUseContext.toolUseId,
      });

      logEvent('tengu_agent_tool_remote_launched', {
        agent_type: selectedAgent.agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });

      const remoteResult: RemoteLaunchedOutput = {
        status: 'remote_launched',
        taskId,
        sessionUrl: getRemoteTaskSessionUrl(sessionId),
        description,
        prompt,
        outputFile: getTaskOutputPath(taskId),
      };
      return { data: remoteResult } as unknown as { data: Output };
    }
    // 系统提示 + 提示消息：根据 fork 路径分支。
    //
    // Fork 路径：子代理继承父代理的系统提示（而不是 FORK_AGENT 的）
    // 以获得缓存相同的 API 请求前缀。提示消息通过
    // buildForkedMessages() 构建，它克隆父代理的完整助手消息
    // （所有 tool_use 块）+ 占位符 tool_results + 每个子代理的指令。
    //
    // 普通路径：使用环境详细信息构建所选代理自己的系统提示，
    // 并为提示使用简单的用户消息。
    let enhancedSystemPrompt: string[] | undefined;
    let forkParentSystemPrompt: ReturnType<typeof buildEffectiveSystemPrompt> | undefined;
    let promptMessages: MessageType[];

    if (isForkPath) {
      if (toolUseContext.renderedSystemPrompt) {
        forkParentSystemPrompt = toolUseContext.renderedSystemPrompt;
      } else {
        // 后备：重新计算。如果在父代理轮次开始和 fork 生成之间
        // GrowthBook 状态发生变化，可能与父代理缓存的字节不同。
        const mainThreadAgentDefinition = appState.agent
          ? appState.agentDefinitions.activeAgents.find(a => a.agentType === appState.agent)
          : undefined;
        const additionalWorkingDirectories = Array.from(
          appState.toolPermissionContext.additionalWorkingDirectories.keys(),
        );
        const defaultSystemPrompt = await getSystemPrompt(
          toolUseContext.options.tools,
          toolUseContext.options.mainLoopModel,
          additionalWorkingDirectories,
          toolUseContext.options.mcpClients,
        );
        forkParentSystemPrompt = buildEffectiveSystemPrompt({
          mainThreadAgentDefinition,
          toolUseContext,
          customSystemPrompt: toolUseContext.options.customSystemPrompt,
          defaultSystemPrompt,
          appendSystemPrompt: toolUseContext.options.appendSystemPrompt,
        });
      }
      promptMessages = buildForkedMessages(prompt, assistantMessage);
    } else {
      try {
        const additionalWorkingDirectories = Array.from(
          appState.toolPermissionContext.additionalWorkingDirectories.keys(),
        );

        // 所有代理都有 getSystemPrompt - 向所有代理传递 toolUseContext
        const agentPrompt = selectedAgent.getSystemPrompt({ toolUseContext });

        // 记录子代理的代理内存加载事件
        if (selectedAgent.memory) {
          logEvent('tengu_agent_memory_loaded', {
            ...(process.env.USER_TYPE === 'ant' && {
              agent_type: selectedAgent.agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            }),
            scope: selectedAgent.memory as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            source: 'subagent' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          });
        }

        // 应用环境详细信息增强
        enhancedSystemPrompt = await enhanceSystemPromptWithEnvDetails(
          [agentPrompt],
          resolvedAgentModel,
          additionalWorkingDirectories,
        );
      } catch (error) {
        logForDebugging(`Failed to get system prompt for agent ${selectedAgent.agentType}: ${errorMessage(error)}`);
      }
      promptMessages = [createUserMessage({ content: prompt })];
    }

    const metadata = {
      prompt,
      resolvedAgentModel,
      isBuiltInAgent: isBuiltInAgent(selectedAgent),
      startTime,
      agentType: selectedAgent.agentType,
      isAsync: (run_in_background === true || selectedAgent.background === true) && !isBackgroundTasksDisabled,
    };

    // 使用内联环境变量检查而不是 coordinatorModule 以避免
    // 测试模块加载期间的循环依赖问题。
    const isCoordinator = feature('COORDINATOR_MODE') ? isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE) : false;

    // Fork 子代理实验：强制所有生成异步以获得统一的
    // <task-notification> 交互模型（不仅仅是 fork 生成 — 是所有）。
    const forceAsync = isForkSubagentEnabled();

    // 助手模式：强制所有代理异步。同步子代理会保持
    // 主循环的轮次打开直到它们完成 — 守护进程的 inputQueue
    // 会积压，并且生成时第一个逾期的 cron 追赶会变成 N 个
    // 串行的子代理轮次阻塞所有用户输入。与
    // executeForkedSlashCommand 的即发即弃路径相同的门控；那里的
    // <task-notification> 重入由下方的 else 分支处理
    // （registerAsyncAgentTask + notifyOnCompletion）。
    const assistantForceAsync = feature('KAIROS') ? appState.kairosEnabled : false;

    const shouldRunAsync =
      (run_in_background === true ||
        selectedAgent.background === true ||
        isCoordinator ||
        forceAsync ||
        assistantForceAsync ||
        (proactiveModule?.isProactiveActive() ?? false)) &&
      !isBackgroundTasksDisabled;
    // 独立于父代理组装工作代理的工具池。
    // 工作代理始终使用它们自己的权限模式从 assembleToolPool 获取工具，
    // 因此它们不会受到父代理工具限制的影响。在此处计算
    // 以便 runAgent 不需要从 tools.ts 导入（这会创建循环依赖）。
    const workerPermissionContext = {
      ...appState.toolPermissionContext,
      mode: selectedAgent.permissionMode ?? 'acceptEdits',
    };
    const workerTools = assembleToolPool(workerPermissionContext, appState.mcp.tools);

    // 提前创建稳定的代理 ID，以便可用于 worktree slug
    const earlyAgentId = createAgentId();

    // 如果请求，设置 worktree 隔离
    let worktreeInfo: {
      worktreePath: string;
      worktreeBranch?: string;
      headCommit?: string;
      gitRoot?: string;
      hookBased?: boolean;
    } | null = null;

    if (effectiveIsolation === 'worktree') {
      const slug = `agent-${earlyAgentId.slice(0, 8)}`;
      worktreeInfo = await createAgentWorktree(slug);
    }

    // Fork + worktree：注入通知告诉子代理转换路径
    // 并重新读取可能过时的文件。在 fork 指令之后追加
    // 以便它显示为子代理看到的最新指导。
    if (isForkPath && worktreeInfo) {
      promptMessages.push(
        createUserMessage({
          content: buildWorktreeNotice(getCwd(), worktreeInfo.worktreePath),
        }),
      );
    }

    const runAgentParams: Parameters<typeof runAgent>[0] = {
      agentDefinition: selectedAgent,
      promptMessages,
      toolUseContext,
      canUseTool,
      isAsync: shouldRunAsync,
      querySource:
        toolUseContext.options.querySource ??
        getQuerySourceForAgent(selectedAgent.agentType, isBuiltInAgent(selectedAgent)),
      model: isForkPath ? undefined : model,
      // Fork 路径：传递父代理的系统提示和父代理的确切工具
      // 数组（缓存相同的前缀）。workerTools 在 permissionMode 'bubble'
      // 下重建，这与父代理的模式不同，所以它的工具定义序列化
      // 在第一个不同的工具处偏离并打破缓存。useExactTools 还继承
      // 父代理的 thinkingConfig 和 isNonInteractiveSession（参见 runAgent.ts）。
      //
      // 普通路径：当 cwd 覆盖生效时（worktree 隔离
      // 或显式 cwd），跳过预构建的系统提示，以便 runAgent 的
      // buildAgentSystemPrompt() 在 wrapWithCwd 内部运行，其中 getCwd()
      // 返回覆盖路径。
      override: isForkPath
        ? { systemPrompt: forkParentSystemPrompt }
        : enhancedSystemPrompt && !worktreeInfo && !cwd
          ? { systemPrompt: asSystemPrompt(enhancedSystemPrompt) }
          : undefined,
      availableTools: isForkPath ? filterParentToolsForFork(toolUseContext.options.tools) : workerTools,
      // 当 fork-subagent 路径需要完整上下文时传递父代理对话。
      // useExactTools 继承 thinkingConfig（runAgent.ts:624）。
      forkContextMessages: isForkPath ? toolUseContext.messages : undefined,
      ...(isForkPath && { useExactTools: true }),
      worktreePath: worktreeInfo?.worktreePath,
      description,
    };

    // 辅助函数：用 cwd 覆盖包装执行：显式 cwd 参数（KAIROS）
    // 优先于 worktree 隔离路径。
    const cwdOverridePath = cwd ?? worktreeInfo?.worktreePath;
    const wrapWithCwd = <T,>(fn: () => T): T => (cwdOverridePath ? runWithCwdOverride(cwdOverridePath, fn) : fn());

    // 辅助函数：在代理完成后清理 worktree
    const cleanupWorktreeIfNeeded = async (): Promise<{
      worktreePath?: string;
      worktreeBranch?: string;
    }> => {
      if (!worktreeInfo) return {};
      const { worktreePath, worktreeBranch, headCommit, gitRoot, hookBased } = worktreeInfo;
      // 置空以使其幂等 — 防止在清理和 try 结束之间的代码
      // 抛出到 catch 时双重调用
      worktreeInfo = null;
      if (hookBased) {
        // 基于 hook 的 worktree 始终保留，因为我们无法检测 VCS 更改
        logForDebugging(`Hook-based agent worktree kept at: ${worktreePath}`);
        return { worktreePath };
      }
      if (headCommit) {
        const changed = await hasWorktreeChanges(worktreePath, headCommit);
        if (!changed) {
          await removeAgentWorktree(worktreePath, worktreeBranch, gitRoot);
          // 从元数据中清除 worktreePath，以便恢复不会尝试使用
          // 已删除的目录。即发即弃以匹配 runAgent 的
          // writeAgentMetadata 处理。
          void writeAgentMetadata(asAgentId(earlyAgentId), {
            agentType: selectedAgent.agentType,
            description,
          }).catch(_err => logForDebugging(`Failed to clear worktree metadata: ${_err}`));
          return {};
        }
      }
      logForDebugging(`Agent worktree has changes, keeping: ${worktreePath}`);
      return { worktreePath, worktreeBranch };
    };

    if (shouldRunAsync) {
      const asyncAgentId = earlyAgentId;
      const agentBackgroundTask = registerAsyncAgent({
        agentId: asyncAgentId,
        description,
        prompt,
        selectedAgent,
        setAppState: rootSetAppState,
        // 不要链接到父代理的中止控制器 — 后台代理应该在
        // 用户按 ESC 取消主线程时继续运行。
        // 它们通过 chat:killAgents 显式终止。
        toolUseId: toolUseContext.toolUseId,
      });

      // 注册 name → agentId 用于 SendMessage 路由。在 registerAsyncAgent 之后
      // 这样如果生成失败我们不会留下过时的条目。同步代理跳过 —
      // 协调器被阻止，所以 SendMessage 路由不适用。
      if (name) {
        rootSetAppState(prev => {
          const next = new Map(prev.agentNameRegistry);
          next.set(name, asAgentId(asyncAgentId));
          return { ...prev, agentNameRegistry: next };
        });
      }

      // 将异步代理执行包装在代理上下文中以进行分析归因
      const asyncAgentContext: SubagentContext = {
        agentId: asyncAgentId,
        // 对于来自队友的子代理：使用团队领导的会话
        // 对于来自主 REPL 的子代理：undefined（无父会话）
        parentSessionId: getParentSessionId(),
        agentType: 'subagent' as const,
        subagentName: selectedAgent.agentType,
        isBuiltIn: isBuiltInAgent(selectedAgent),
        invokingRequestId: assistantMessage?.requestId as string | undefined,
        invocationKind: 'spawn' as const,
        invocationEmitted: false,
      };

      // 工作负载传播：handlePromptSubmit 将整个轮次包装在
      // runWithWorkload (AsyncLocalStorage) 中。ALS 上下文在
      // 调用时被捕获 — 当这个 `void` 触发时 — 并在每个 await
      // 内部继续存在。不需要捕获/恢复；分离的闭包自动看到
      // 父轮次的工作负载，与其 finally 隔离。
      void runWithAgentContext(asyncAgentContext, () =>
        wrapWithCwd(() =>
          runAsyncAgentLifecycle({
            taskId: agentBackgroundTask.agentId,
            abortController: agentBackgroundTask.abortController!,
            makeStream: onCacheSafeParams =>
              runAgent({
                ...runAgentParams,
                override: {
                  ...runAgentParams.override,
                  agentId: asAgentId(agentBackgroundTask.agentId),
                  abortController: agentBackgroundTask.abortController!,
                },
                onCacheSafeParams,
              }),
            metadata,
            description,
            toolUseContext,
            rootSetAppState,
            agentIdForCleanup: asyncAgentId,
            enableSummarization: isCoordinator || isForkSubagentEnabled() || getSdkAgentProgressSummariesEnabled(),
            getWorktreeResult: cleanupWorktreeIfNeeded,
          }),
        ),
      );

      const canReadOutputFile = toolUseContext.options.tools.some(
        t => toolMatchesName(t, FILE_READ_TOOL_NAME) || toolMatchesName(t, BASH_TOOL_NAME),
      );
      return {
        data: {
          isAsync: true as const,
          status: 'async_launched' as const,
          agentId: agentBackgroundTask.agentId,
          description: description,
          prompt: prompt,
          outputFile: getTaskOutputPath(agentBackgroundTask.agentId),
          canReadOutputFile,
        },
      };
    } else {
      // 为同步代理创建显式的 agentId
      const syncAgentId = asAgentId(earlyAgentId);

      // 为同步执行设置代理上下文（用于分析归因）
      const syncAgentContext: SubagentContext = {
        agentId: syncAgentId,
        // 对于来自队友的子代理：使用团队领导的会话
        // 对于来自主 REPL 的子代理：undefined（无父会话）
        parentSessionId: getParentSessionId(),
        agentType: 'subagent' as const,
        subagentName: selectedAgent.agentType,
        isBuiltIn: isBuiltInAgent(selectedAgent),
        invokingRequestId: assistantMessage?.requestId as string | undefined,
        invocationKind: 'spawn' as const,
        invocationEmitted: false,
      };

      // 将整个同步代理执行包装在上下文中以进行分析归因
      // 并可选地包装在 worktree cwd 覆盖中以进行文件系统隔离
      return runWithAgentContext(syncAgentContext, () =>
        wrapWithCwd(async () => {
          const agentMessages: MessageType[] = [];
          const agentStartTime = Date.now();
          const syncTracker = createProgressTracker();
          const syncResolveActivity = createActivityDescriptionResolver(toolUseContext.options.tools);

          // 产生初始进度消息以携带元数据（提示）
          if (promptMessages.length > 0) {
            const normalizedPromptMessages = normalizeMessages(promptMessages);
            const normalizedFirstMessage = normalizedPromptMessages.find(
              (m): m is NormalizedUserMessage => m.type === 'user',
            );
            if (normalizedFirstMessage && normalizedFirstMessage.type === 'user' && onProgress) {
              onProgress({
                toolUseID: `agent_${assistantMessage.message.id}`,
                data: {
                  message: normalizedFirstMessage,
                  type: 'agent_progress',
                  prompt,
                  agentId: syncAgentId,
                },
              });
            }
          }

          // 立即注册为前台任务，以便随时可以转为后台
          // 如果禁用后台任务则跳过注册
          let foregroundTaskId: string | undefined;
          // 在循环外部一次性创建后台竞争 promise — 否则
          // 每次迭代都会向同一个待处理的 promise 添加新的 .then() 反应，
          // 在代理的生命周期内累积回调。
          let backgroundPromise: Promise<{ type: 'background' }> | undefined;
          let cancelAutoBackground: (() => void) | undefined;
          if (!isBackgroundTasksDisabled) {
            const registration = registerAgentForeground({
              agentId: syncAgentId,
              description,
              prompt,
              selectedAgent,
              setAppState: rootSetAppState,
              toolUseId: toolUseContext.toolUseId,
              autoBackgroundMs: getAutoBackgroundMs() || undefined,
            });
            foregroundTaskId = registration.taskId;
            backgroundPromise = registration.backgroundSignal.then(() => ({
              type: 'background' as const,
            }));
            cancelAutoBackground = registration.cancelAutoBackground;
          }

          // 跟踪是否已显示后台提示 UI
          let backgroundHintShown = false;
          // 跟踪代理是否已转为后台（清理由后台化的 finally 处理）
          let wasBackgrounded = false;
          // 每个作用域的 stop 函数 — 不与后台化闭包共享。
          // 幂等的：startAgentSummarization 的 stop() 检查 `stopped` 标志。
          let stopForegroundSummarization: (() => void) | undefined;
          // const 捕获用于回调内部的健全类型收窄
          const summaryTaskId = foregroundTaskId;

          // 获取代理的异步迭代器
          const agentIterator = runAgent({
            ...runAgentParams,
            override: {
              ...runAgentParams.override,
              agentId: syncAgentId,
            },
            onCacheSafeParams:
              summaryTaskId && getSdkAgentProgressSummariesEnabled()
                ? (params: CacheSafeParams) => {
                    const { stop } = startAgentSummarization(summaryTaskId, syncAgentId, params, rootSetAppState);
                    stopForegroundSummarization = stop;
                  }
                : undefined,
          })[Symbol.asyncIterator]();

          // 跟踪迭代期间是否发生错误
          let syncAgentError: Error | undefined;
          let wasAborted = false;
          let worktreeResult: {
            worktreePath?: string;
            worktreeBranch?: string;
          } = {};

          try {
            while (true) {
              const elapsed = Date.now() - agentStartTime;

              // 在阈值后显示后台提示（但任务已注册）
              // 如果禁用后台任务则跳过
              if (
                !isBackgroundTasksDisabled &&
                !backgroundHintShown &&
                elapsed >= PROGRESS_THRESHOLD_MS &&
                toolUseContext.setToolJSX
              ) {
                backgroundHintShown = true;
                toolUseContext.setToolJSX({
                  jsx: <BackgroundHint />,
                  shouldHidePromptInput: false,
                  shouldContinueAnimation: true,
                  showSpinner: true,
                });
              }

              // 下一个消息和后台信号之间的竞争
              // 如果禁用后台任务，直接等待下一个消息
              const nextMessagePromise = agentIterator.next();
              const raceResult = backgroundPromise
                ? await Promise.race([
                    nextMessagePromise.then(r => ({
                      type: 'message' as const,
                      result: r,
                    })),
                    backgroundPromise,
                  ])
                : {
                    type: 'message' as const,
                    result: await nextMessagePromise,
                  };

              // 检查是否通过 backgroundAll() 转为后台
              // 如果 raceResult.type 为 'background'，则保证 foregroundTaskId 已定义
              // 因为 backgroundPromise 仅在 foregroundTaskId 已定义时才定义
              if (raceResult.type === 'background' && foregroundTaskId) {
                const appState = toolUseContext.getAppState();
                const task = appState.tasks[foregroundTaskId];
                if (isLocalAgentTask(task) && task.isBackgrounded) {
                  // 捕获 taskId 以在异步回调中使用
                  const backgroundedTaskId = foregroundTaskId;
                  wasBackgrounded = true;
                  // 停止前台摘要；后台闭包
                  // 下方拥有自己独立的 stop 函数。
                  stopForegroundSummarization?.();

                  // 工作负载：通过 ALS 在 `void` 调用时继承，
                  // 与上方的从头开始异步路径相同。
                  // 在后台继续代理并返回异步结果
                  void runWithAgentContext(syncAgentContext, async () => {
                    let stopBackgroundedSummarization: (() => void) | undefined;
                    try {
                      // 清理前台迭代器以便其 finally 块运行
                      // （释放 MCP 连接、会话钩子、提示缓存跟踪等。）
                      // 超时可防止如果 MCP 服务器清理挂起时阻塞。
                      // .catch() 防止如果超时赢得竞争时未处理的拒绝。
                      await Promise.race([agentIterator.return(undefined).catch(() => {}), sleep(1000)]);
                      // 从现有消息初始化进度跟踪
                      const tracker = createProgressTracker();
                      const resolveActivity2 = createActivityDescriptionResolver(toolUseContext.options.tools);
                      for (const existingMsg of agentMessages) {
                        updateProgressFromMessage(tracker, existingMsg, resolveActivity2, toolUseContext.options.tools);
                      }
                      for await (const msg of runAgent({
                        ...runAgentParams,
                        isAsync: true, // 代理现在在后台运行
                        override: {
                          ...runAgentParams.override,
                          agentId: asAgentId(backgroundedTaskId),
                          abortController: task.abortController,
                        },
                        onCacheSafeParams: getSdkAgentProgressSummariesEnabled()
                          ? (params: CacheSafeParams) => {
                              const { stop } = startAgentSummarization(
                                backgroundedTaskId,
                                asAgentId(backgroundedTaskId),
                                params,
                                rootSetAppState,
                              );
                              stopBackgroundedSummarization = stop;
                            }
                          : undefined,
                      })) {
                        agentMessages.push(msg);

                        // 跟踪后台代理的进度
                        updateProgressFromMessage(tracker, msg, resolveActivity2, toolUseContext.options.tools);
                        updateAsyncAgentProgress(backgroundedTaskId, getProgressUpdate(tracker), rootSetAppState);

                        const lastToolName = getLastToolUseName(msg);
                        if (lastToolName) {
                          emitTaskProgress(
                            tracker,
                            backgroundedTaskId,
                            toolUseContext.toolUseId,
                            description,
                            startTime,
                            lastToolName,
                          );
                        }
                      }
                      const agentResult = finalizeAgentTool(agentMessages, backgroundedTaskId, metadata);

                      // 首先标记任务已完成，以便 TaskOutput(block=true)
                      // 立即解除阻塞。classifyHandoffIfNeeded 和
                      // cleanupWorktreeIfNeeded 可能会挂起 — 它们不能阻止
                      // 状态转换 (gh-20236)。
                      completeAsyncAgent(agentResult, rootSetAppState);

                      // 从代理结果内容中提取文本用于通知
                      let finalMessage = extractTextContent(agentResult.content, '\n');

                      if (feature('TRANSCRIPT_CLASSIFIER')) {
                        const backgroundedAppState = toolUseContext.getAppState();
                        const handoffWarning = await classifyHandoffIfNeeded({
                          agentMessages,
                          tools: toolUseContext.options.tools,
                          toolPermissionContext: backgroundedAppState.toolPermissionContext,
                          abortSignal: task.abortController!.signal,
                          subagentType: selectedAgent.agentType,
                          totalToolUseCount: agentResult.totalToolUseCount,
                        });
                        if (handoffWarning) {
                          finalMessage = `${handoffWarning}\n\n${finalMessage}`;
                        }
                      }

                      // 在通知之前清理 worktree，以便我们可以包含它
                      const worktreeResult = await cleanupWorktreeIfNeeded();

                      enqueueAgentNotification({
                        taskId: backgroundedTaskId,
                        description,
                        status: 'completed',
                        setAppState: rootSetAppState,
                        finalMessage,
                        usage: {
                          totalTokens: getTokenCountFromTracker(tracker),
                          toolUses: agentResult.totalToolUseCount,
                          durationMs: agentResult.totalDurationMs,
                        },
                        toolUseId: toolUseContext.toolUseId,
                        ...worktreeResult,
                      });
                    } catch (error) {
                      if (error instanceof AbortError) {
                        // 在 worktree 清理之前转换状态，以便
                        // 即使 git 挂起 TaskOutput 也能解除阻塞 (gh-20236)。
                        killAsyncAgent(backgroundedTaskId, rootSetAppState);
                        logEvent('tengu_agent_tool_terminated', {
                          agent_type: metadata.agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                          model:
                            metadata.resolvedAgentModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                          duration_ms: Date.now() - metadata.startTime,
                          is_async: true,
                          is_built_in_agent: metadata.isBuiltInAgent,
                          reason:
                            'user_cancel_background' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                        });
                        const worktreeResult = await cleanupWorktreeIfNeeded();
                        const partialResult = extractPartialResult(agentMessages);
                        enqueueAgentNotification({
                          taskId: backgroundedTaskId,
                          description,
                          status: 'killed',
                          setAppState: rootSetAppState,
                          toolUseId: toolUseContext.toolUseId,
                          finalMessage: partialResult,
                          ...worktreeResult,
                        });
                        return;
                      }
                      const errMsg = errorMessage(error);
                      failAsyncAgent(backgroundedTaskId, errMsg, rootSetAppState);
                      const worktreeResult = await cleanupWorktreeIfNeeded();
                      enqueueAgentNotification({
                        taskId: backgroundedTaskId,
                        description,
                        status: 'failed',
                        error: errMsg,
                        setAppState: rootSetAppState,
                        toolUseId: toolUseContext.toolUseId,
                        ...worktreeResult,
                      });
                    } finally {
                      stopBackgroundedSummarization?.();
                      clearInvokedSkillsForAgent(syncAgentId);
                      clearDumpState(syncAgentId);
                      // 注意：worktree 清理在 try 和 catch 路径中的
                      // enqueueAgentNotification 之前完成，以便我们可以包含 worktree 信息
                    }
                  });

                  // 立即返回 async_launched 结果
                  const canReadOutputFile = toolUseContext.options.tools.some(
                    t => toolMatchesName(t, FILE_READ_TOOL_NAME) || toolMatchesName(t, BASH_TOOL_NAME),
                  );
                  return {
                    data: {
                      isAsync: true as const,
                      status: 'async_launched' as const,
                      agentId: backgroundedTaskId,
                      description: description,
                      prompt: prompt,
                      outputFile: getTaskOutputPath(backgroundedTaskId),
                      canReadOutputFile,
                    },
                  };
                }
              }

              // 处理来自竞争结果的消息
              if (raceResult.type !== 'message') {
                // 这不应该发生 - 后台情况已在上方处理
                continue;
              }
              const { result } = raceResult;
              if (result.done) break;
              const message = result.value as MessageType;

              agentMessages.push(message);

              // 为 VS Code 子代理面板发出 task_progress
              updateProgressFromMessage(syncTracker, message, syncResolveActivity, toolUseContext.options.tools);
              if (foregroundTaskId) {
                const lastToolName = getLastToolUseName(message);
                if (lastToolName) {
                  emitTaskProgress(
                    syncTracker,
                    foregroundTaskId,
                    toolUseContext.toolUseId,
                    description,
                    agentStartTime,
                    lastToolName,
                  );
                  // 当启用 SDK 摘要时，保持 AppState task.progress 同步，
                  // 以便 updateAgentSummary 读取正确的令牌/工具计数
                  // 而不是零。
                  if (getSdkAgentProgressSummariesEnabled()) {
                    updateAsyncAgentProgress(foregroundTaskId, getProgressUpdate(syncTracker), rootSetAppState);
                  }
                }
              }

              // 将来自子代理的 bash_progress 事件转发给父代理，以便 SDK
              // 接收 tool_progress 事件，就像它对主代理所做的那样。
              if (
                message.type === 'progress' &&
                ((message.data as { type: string })?.type === 'bash_progress' ||
                  (message.data as { type: string })?.type === 'powershell_progress') &&
                onProgress
              ) {
                onProgress({
                  toolUseID: message.toolUseID as string,
                  data: message.data,
                });
              }

              if (message.type !== 'assistant' && message.type !== 'user') {
                continue;
              }

              // 为助手消息增加 spinner 中的令牌计数
              // 子代理流事件在 runAgent.ts 中被过滤掉，所以我们需要
              // 在此处从完成的消息中计数令牌
              if (message.type === 'assistant') {
                const contentLength = getAssistantMessageContentLength(message as AssistantMessage);
                if (contentLength > 0) {
                  toolUseContext.setResponseLength(len => len + contentLength);
                }
              }

              const normalizedNew = normalizeMessages([message]);
              for (const m of normalizedNew) {
                for (const content of (m.message?.content ?? []) as readonly { readonly type: string }[]) {
                  if (content.type !== 'tool_use' && content.type !== 'tool_result') {
                    continue;
                  }

                  // 转发进度更新
                  if (onProgress) {
                    onProgress({
                      toolUseID: `agent_${assistantMessage.message.id}`,
                      data: {
                        message: m,
                        type: 'agent_progress',
                        // 提示仅在第一个进度消息时需要（UI.tsx:624
                        // 读取 progressMessages[0]）。在此处省略以避免重复。
                        prompt: '',
                        agentId: syncAgentId,
                      },
                    });
                  }
                }
              }
            }
          } catch (error) {
            // 处理来自同步代理循环的错误
            // AbortError 应被重新抛出以进行适当的中断处理
            if (error instanceof AbortError) {
              wasAborted = true;
              logEvent('tengu_agent_tool_terminated', {
                agent_type: metadata.agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                model: metadata.resolvedAgentModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                duration_ms: Date.now() - metadata.startTime,
                is_async: false,
                is_built_in_agent: metadata.isBuiltInAgent,
                reason: 'user_cancel_sync' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              });
              throw error;
            }

            // 记录错误以便调试
            logForDebugging(`Sync agent error: ${errorMessage(error)}`, {
              level: 'error',
            });

            // 存储错误以便在清理后处理
            syncAgentError = toError(error);
          } finally {
            // 清除后台提示 UI
            if (toolUseContext.setToolJSX) {
              toolUseContext.setToolJSX(null);
            }

            // 停止前台摘要。幂等的 — 如果在后台转换时已停止，
            // 这是一个空操作。后台闭包拥有单独的 stop 函数
            // （stopBackgroundedSummarization）。
            stopForegroundSummarization?.();

            // 如果代理完成而没有转为后台，取消注册前台任务
            if (foregroundTaskId) {
              unregisterAgentForeground(foregroundTaskId, rootSetAppState);
              // 通知 SDK 消费者（例如 VS Code 子代理面板）此前台代理已完成。
              // 通过 drainSdkEvents() — 不触发 print.ts XML task_notification
              // 解析器或 LLM 循环。
              if (!wasBackgrounded) {
                const progress = getProgressUpdate(syncTracker);
                enqueueSdkEvent({
                  type: 'system',
                  subtype: 'task_notification',
                  task_id: foregroundTaskId,
                  tool_use_id: toolUseContext.toolUseId,
                  status: syncAgentError ? 'failed' : wasAborted ? 'stopped' : 'completed',
                  output_file: '',
                  summary: description,
                  usage: {
                    total_tokens: progress.tokenCount,
                    tool_uses: progress.toolUseCount,
                    duration_ms: Date.now() - agentStartTime,
                  },
                });
              }
            }

            // 清理作用域技能，以便它们不会在全局映射中累积
            clearInvokedSkillsForAgent(syncAgentId);

            // 清除此代理的 dumpState 条目以防止无限增长
            // 如果已转为后台则跳过 — 后台代理的 finally 处理清理
            if (!wasBackgrounded) {
              clearDumpState(syncAgentId);
            }

            // 如果代理在自动后台定时器触发之前完成，取消它
            cancelAutoBackground?.();

            // 如果适用，清理 worktree（在 finally 中以处理中止/错误路径）
            // 如果已转为后台则跳过 — 后台继续在其中运行
            if (!wasBackgrounded) {
              worktreeResult = await cleanupWorktreeIfNeeded();
            }
          }

          // 重新抛出中止错误
          // TODO: 找到一种更清晰的表达方式
          const lastMessage = agentMessages.findLast(_ => _.type !== 'system' && _.type !== 'progress');
          if (lastMessage && isSyntheticMessage(lastMessage)) {
            logEvent('tengu_agent_tool_terminated', {
              agent_type: metadata.agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              model: metadata.resolvedAgentModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              duration_ms: Date.now() - metadata.startTime,
              is_async: false,
              is_built_in_agent: metadata.isBuiltInAgent,
              reason: 'user_cancel_sync' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            });
            throw new AbortError();
          }

          // 如果在迭代期间发生错误，尝试返回一个结果，其中
          // 包含我们拥有的任何消息。如果我们没有助手消息，
          // 重新抛出错误以便工具框架正确处理。
          if (syncAgentError) {
            // 检查是否有任何助手消息可以返回
            const hasAssistantMessages = agentMessages.some(msg => msg.type === 'assistant');

            if (!hasAssistantMessages) {
              // 没有收集到消息，重新抛出错误
              throw syncAgentError;
            }

            // 我们有一些消息，尝试完成并返回它们
            // 这允许父代理即使在错误后也能看到部分进度
            logForDebugging(`Sync agent recovering from error with ${agentMessages.length} messages`);
          }

          const agentResult = finalizeAgentTool(agentMessages, syncAgentId, metadata);

          if (feature('TRANSCRIPT_CLASSIFIER')) {
            const currentAppState = toolUseContext.getAppState();
            const handoffWarning = await classifyHandoffIfNeeded({
              agentMessages,
              tools: toolUseContext.options.tools,
              toolPermissionContext: currentAppState.toolPermissionContext,
              abortSignal: toolUseContext.abortController.signal,
              subagentType: selectedAgent.agentType,
              totalToolUseCount: agentResult.totalToolUseCount,
            });
            if (handoffWarning) {
              agentResult.content = [{ type: 'text' as const, text: handoffWarning }, ...agentResult.content];
            }
          }

          return {
            data: {
              status: 'completed' as const,
              prompt,
              ...agentResult,
              ...worktreeResult,
            },
          };
        }),
      );
    }
  },
  isReadOnly() {
    return true; // 将权限检查委托给其底层工具
  },
  toAutoClassifierInput(input) {
    const i = input as AgentToolInput;
    const tags = [i.subagent_type, i.mode ? `mode=${i.mode}` : undefined].filter((t): t is string => t !== undefined);
    const prefix = tags.length > 0 ? `(${tags.join(', ')}): ` : ': ';
    return `${prefix}${i.prompt}`;
  },
  isConcurrencySafe() {
    return true;
  },
  userFacingName,
  userFacingNameBackgroundColor,
  getActivityDescription(input) {
    return input?.description ?? 'Running task';
  },
  async checkPermissions(input, context): Promise<PermissionResult> {
    const appState = context.getAppState();

    // 仅在自动模式下通过自动模式分类器路由
    // 在所有其他模式下，自动批准子代理生成
    // 注意：process.env.USER_TYPE === 'ant' 守卫为外部构建启用死代码消除
    if (process.env.USER_TYPE === 'ant' && appState.toolPermissionContext.mode === 'auto') {
      logForDebugging(`[Agent] checkPermissions 自动模式，透传给分类器`, { level: 'info' });
      return {
        behavior: 'passthrough',
        message: 'Agent tool requires permission to spawn sub-agents.',
      };
    }

    return { behavior: 'allow', updatedInput: input };
  },
  mapToolResultToToolResultBlockParam(data, toolUseID) {
    // 多代理生成结果
    const internalData = data as InternalOutput;
    if (
      typeof internalData === 'object' &&
      internalData !== null &&
      'status' in internalData &&
      internalData.status === 'teammate_spawned'
    ) {
      const spawnData = internalData as TeammateSpawnedOutput;
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: [
          {
            type: 'text',
            text: `Spawned successfully.
agent_id: ${spawnData.teammate_id}
name: ${spawnData.name}
team_name: ${spawnData.team_name}
The agent is now running and will receive instructions via mailbox.`,
          },
        ],
      };
    }
    if ('status' in internalData && internalData.status === 'remote_launched') {
      const r = internalData;
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: [
          {
            type: 'text',
            text: `Remote agent launched in CCR.\ntaskId: ${r.taskId}\nsession_url: ${r.sessionUrl}\noutput_file: ${r.outputFile}\nThe agent is running remotely. You will be notified automatically when it completes.\nBriefly tell the user what you launched and end your response.`,
          },
        ],
      };
    }
    if (data.status === 'async_launched') {
      const prefix = `Async agent launched successfully.\nagentId: ${data.agentId} (internal ID - do not mention to user. Use SendMessage with to: '${data.agentId}' to continue this agent.)\nThe agent is working in the background. You will be notified automatically when it completes.`;
      const instructions = data.canReadOutputFile
        ? `Do not duplicate this agent's work — avoid working with the same files or topics it is using. Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.\noutput_file: ${data.outputFile}\nIf asked, you can check progress before completion by using ${FILE_READ_TOOL_NAME} or ${BASH_TOOL_NAME} tail on the output file.`
        : `Briefly tell the user what you launched and end your response. Do not generate any other text — agent results will arrive in a subsequent message.`;
      const text = `${prefix}\n${instructions}`;
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: [
          {
            type: 'text',
            text,
          },
        ],
      };
    }
    if (data.status === 'completed') {
      const worktreeData = data as Record<string, unknown>;
      const worktreeInfoText = worktreeData.worktreePath
        ? `\nworktreePath: ${worktreeData.worktreePath}\nworktreeBranch: ${worktreeData.worktreeBranch}`
        : '';
      // 如果子代理完成时没有内容，tool_result 就只是下面的
      // agentId/usage 附加信息 — 一个仅包含元数据的块在提示末尾。
      // 一些模型会将其解读为"无需执行任何操作"并立即结束其回合。
      // 明确说明这一点，以便父代理有内容可以响应。
      const contentOrMarker =
        data.content.length > 0
          ? data.content
          : [
              {
                type: 'text' as const,
                text: '(Subagent completed but returned no output.)',
              },
            ];
      // 一次性内置代理（Explore、Plan）永远不会通过 SendMessage 继续
      // — agentId 提示和 <usage> 块是无效的负载（约 135 字符 ×
      // 每周 3400 万次 Explore 运行 ≈ 每周 1-2 Gtok）。遥测不会解析这个
      // 块（它在 finalizeAgentTool 中使用 logEvent），所以丢弃是安全的。
      // agentType 是可选的以兼容恢复 — 缺失表示显示附加信息。
      if (data.agentType && ONE_SHOT_BUILTIN_AGENT_TYPES.has(data.agentType) && !worktreeInfoText) {
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: contentOrMarker,
        };
      }
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: [
          ...contentOrMarker,
          {
            type: 'text',
            text: `agentId: ${data.agentId} (use SendMessage with to: '${data.agentId}' to continue this agent)${worktreeInfoText}
<usage>total_tokens: ${data.totalTokens}
tool_uses: ${data.totalToolUseCount}
duration_ms: ${data.totalDurationMs}</usage>`,
          },
        ],
      };
    }
    data satisfies never;
    throw new Error(`Unexpected agent tool result status: ${(data as { status: string }).status}`);
  },
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseTag,
  renderToolUseProgressMessage,
  renderToolUseRejectedMessage,
  renderToolUseErrorMessage,
  renderGroupedToolUse: renderGroupedAgentToolUse,
} satisfies ToolDef<InputSchema, Output, Progress>);

function resolveTeamName(
  input: { team_name?: string },
  appState: { teamContext?: { teamName: string } },
): string | undefined {
  if (!isAgentSwarmsEnabled()) return undefined;
  return input.team_name || appState.teamContext?.teamName;
}
