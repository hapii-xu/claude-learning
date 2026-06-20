import type { BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs';
import { getSdkAgentProgressSummariesEnabled } from '../../bootstrap/state.js';
import {
  OUTPUT_FILE_TAG,
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
  TOOL_USE_ID_TAG,
  WORKTREE_BRANCH_TAG,
  WORKTREE_PATH_TAG,
  WORKTREE_TAG,
} from '../../constants/xml.js';
import { abortSpeculation } from '../../services/PromptSuggestion/speculation.js';
import type { AppState } from '../../state/AppState.js';
import type { SetAppState, Task, TaskStateBase } from '../../Task.js';
import { createTaskStateBase } from '../../Task.js';
import type { Tools } from '../../Tool.js';
import { findToolByName } from '../../Tool.js';
import type { AgentToolResult } from '@claude-code-best/builtin-tools/tools/AgentTool/agentToolUtils.js';
import type { AgentDefinition } from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js';
import { SYNTHETIC_OUTPUT_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/SyntheticOutputTool/SyntheticOutputTool.js';
import { asAgentId } from '../../types/ids.js';
import type { Message } from '../../types/message.js';
import { createAbortController, createChildAbortController } from '../../utils/abortController.js';
import { registerCleanup } from '../../utils/cleanupRegistry.js';
import { getSearchExtraToolsOrReadInfo } from '../../utils/collapseReadSearch.js';
import { enqueuePendingNotification } from '../../utils/messageQueueManager.js';
import { getAgentTranscriptPath } from '../../utils/sessionStorage.js';
import { evictTaskOutput, getTaskOutputPath, initTaskOutputAsSymlink } from '../../utils/task/diskOutput.js';
import { PANEL_GRACE_MS, registerTask, updateTaskState } from '../../utils/task/framework.js';
import { emitTaskProgress } from '../../utils/task/sdkProgress.js';
import type { TaskState } from '../types.js';

export type ToolActivity = {
  toolName: string;
  input: Record<string, unknown>;
  /** 由工具预先计算的 activity 描述，例如 "Reading src/foo.ts" */
  activityDescription?: string;
  /** 预计算字段：如果是搜索操作（Grep、Glob 等）则为 true */
  isSearch?: boolean;
  /** 预计算字段：如果是读取操作（Read、cat 等）则为 true */
  isRead?: boolean;
};

export type AgentProgress = {
  toolUseCount: number;
  tokenCount: number;
  lastActivity?: ToolActivity;
  recentActivities?: ToolActivity[];
  summary?: string;
};

const MAX_RECENT_ACTIVITIES = 5;

export type ProgressTracker = {
  toolUseCount: number;
  // 分别跟踪 input 和 output，避免重复计数。
  // Claude API 中的 input_tokens 每轮是累计的（包含此前所有上下文），
  // 因此我们保留最新值；output_tokens 是每轮独立计算的，因此累加。
  latestInputTokens: number;
  cumulativeOutputTokens: number;
  recentActivities: ToolActivity[];
};

export function createProgressTracker(): ProgressTracker {
  return {
    toolUseCount: 0,
    latestInputTokens: 0,
    cumulativeOutputTokens: 0,
    recentActivities: [],
  };
}

export function getTokenCountFromTracker(tracker: ProgressTracker): number {
  return tracker.latestInputTokens + tracker.cumulativeOutputTokens;
}

/**
 * 解析器函数：根据工具名和输入返回可读的 activity 描述。
 * 用于在记录时通过 Tool.getActivityDescription() 预先计算描述。
 */
export type ActivityDescriptionResolver = (toolName: string, input: Record<string, unknown>) => string | undefined;

export function updateProgressFromMessage(
  tracker: ProgressTracker,
  message: Message,
  resolveActivityDescription?: ActivityDescriptionResolver,
  tools?: Tools,
): void {
  if (message.type !== 'assistant') {
    return;
  }
  const usage = message.message!.usage as BetaUsage | undefined;
  if (!usage) {
    return;
  }
  // 保留最新的 input（API 中是累计值），output 则累加
  tracker.latestInputTokens =
    (usage.input_tokens as number) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  tracker.cumulativeOutputTokens += usage.output_tokens as number;
  for (const content of (message.message!.content ?? []) as Array<{ type: string; name?: string; input?: unknown }>) {
    if (content.type === 'tool_use') {
      tracker.toolUseCount++;
      // 预览中排除 StructuredOutput —— 它是内部工具
      if (content.name !== SYNTHETIC_OUTPUT_TOOL_NAME) {
        const input = content.input as Record<string, unknown>;
        const classification = tools ? getSearchExtraToolsOrReadInfo(content.name!, input, tools) : undefined;
        tracker.recentActivities.push({
          toolName: content.name!,
          input,
          activityDescription: resolveActivityDescription?.(content.name!, input),
          isSearch: classification?.isSearch,
          isRead: classification?.isRead,
        });
      }
    }
  }
  while (tracker.recentActivities.length > MAX_RECENT_ACTIVITIES) {
    tracker.recentActivities.shift();
  }
}

export function getProgressUpdate(tracker: ProgressTracker): AgentProgress {
  return {
    toolUseCount: tracker.toolUseCount,
    tokenCount: getTokenCountFromTracker(tracker),
    lastActivity:
      tracker.recentActivities.length > 0 ? tracker.recentActivities[tracker.recentActivities.length - 1] : undefined,
    recentActivities: [...tracker.recentActivities],
  };
}

/**
 * 根据工具列表构造一个 ActivityDescriptionResolver。
 * 通过名称查找工具，若存在则调用 getActivityDescription。
 */
export function createActivityDescriptionResolver(tools: Tools): ActivityDescriptionResolver {
  return (toolName, input) => {
    const tool = findToolByName(tools, toolName);
    return tool?.getActivityDescription?.(input) ?? undefined;
  };
}

export type LocalAgentTaskState = TaskStateBase & {
  type: 'local_agent';
  agentId: string;
  prompt: string;
  selectedAgent?: AgentDefinition;
  agentType: string;
  model?: string;
  abortController?: AbortController;
  unregisterCleanup?: () => void;
  error?: string;
  result?: AgentToolResult;
  progress?: AgentProgress;
  retrieved: boolean;
  messages?: Message[];
  // 跟踪上次上报的数据，用于计算增量
  lastReportedToolCount: number;
  lastReportedTokenCount: number;
  // 任务是否已被后台化（false = 前台运行中，true = 已后台化）
  isBackgrounded: boolean;
  // 在一轮执行中通过 SendMessage 排队进入的消息，会在工具轮次边界处排空
  pendingMessages: string[];
  // UI 正在“持有”此任务：会阻止驱逐、启用流式追加、触发磁盘引导。
  // 由 enterTeammateView 设置。与 viewingAgentTaskId（表示“我在看什么”）
  // 是分开的 —— retain 表示“我在持有的是什么”。
  retain: boolean;
  // 引导流程已经读取 sidechain JSONL 并按 UUID 合并进 messages。
  // 每个 retain 周期只触发一次；之后的流式内容在此基础上追加。
  diskLoaded: boolean;
  // 面板可见性的截止时间。undefined = 无截止（running 或 retained 状态）；
  // timestamp = 到点后隐藏并可被 GC。在 terminal 状态转换和取消选中时设置，
  // retain 时清除。
  evictAfter?: number;
};

export function isLocalAgentTask(task: unknown): task is LocalAgentTaskState {
  return typeof task === 'object' && task !== null && 'type' in task && task.type === 'local_agent';
}

/**
 * 由 CoordinatorTaskPanel 管理的 local_agent 任务（非 main-session）。
 * 对 ants 而言，这些任务在面板中渲染，而不是在 background-task pill 中。
 * 所有 pill/panel 过滤都必须以此谓词为准 —— 如果判断条件变了，只需在此处修改。
 */
export function isPanelAgentTask(t: unknown): t is LocalAgentTaskState {
  return isLocalAgentTask(t) && t.agentType !== 'main-session';
}

export function queuePendingMessage(
  taskId: string,
  msg: string,
  setAppState: (f: (prev: AppState) => AppState) => void,
): void {
  updateTaskState<LocalAgentTaskState>(taskId, setAppState, task => ({
    ...task,
    pendingMessages: [...task.pendingMessages, msg],
  }));
}

/**
 * 向 task.messages 追加一条消息，使其立即出现在查看中的对话记录里。
 * 由调用方构造 Message（借此打破 messages.ts 的循环依赖）。
 * queuePendingMessage 和 resumeAgentBackground 负责把 prompt 路由到
 * agent 的 API 输入，但不会改变显示。
 */
export function appendMessageToLocalAgent(
  taskId: string,
  message: Message,
  setAppState: (f: (prev: AppState) => AppState) => void,
): void {
  updateTaskState<LocalAgentTaskState>(taskId, setAppState, task => ({
    ...task,
    messages: [...(task.messages ?? []), message],
  }));
}

export function drainPendingMessages(
  taskId: string,
  getAppState: () => AppState,
  setAppState: (f: (prev: AppState) => AppState) => void,
): string[] {
  const task = getAppState().tasks[taskId];
  if (!isLocalAgentTask(task) || task.pendingMessages.length === 0) {
    return [];
  }
  const drained = task.pendingMessages;
  updateTaskState<LocalAgentTaskState>(taskId, setAppState, t => ({
    ...t,
    pendingMessages: [],
  }));
  return drained;
}

/**
 * 将一条 agent 通知入队到消息队列。
 */
export function enqueueAgentNotification({
  taskId,
  description,
  status,
  error,
  setAppState,
  finalMessage,
  usage,
  toolUseId,
  worktreePath,
  worktreeBranch,
}: {
  taskId: string;
  description: string;
  status: 'completed' | 'failed' | 'killed';
  error?: string;
  setAppState: SetAppState;
  finalMessage?: string;
  usage?: {
    totalTokens: number;
    toolUses: number;
    durationMs: number;
  };
  toolUseId?: string;
  worktreePath?: string;
  worktreeBranch?: string;
}): void {
  // 原子地检查并设置 notified 标志，防止重复通知。
  // 如果任务已经被标记为 notified（例如被 TaskStopTool 设置过），则跳过
  // 入队，避免向模型发送冗余消息。
  let shouldEnqueue = false;
  updateTaskState<LocalAgentTaskState>(taskId, setAppState, task => {
    if (task.notified) {
      return task;
    }
    shouldEnqueue = true;
    return {
      ...task,
      notified: true,
    };
  });

  if (!shouldEnqueue) {
    return;
  }

  // 中止任何活跃的 speculation —— 后台任务状态已变化，speculation 的
  // 结果可能引用过期的任务输出。prompt 建议文本会保留；
  // 仅丢弃预先计算的响应。
  abortSpeculation(setAppState);

  const summary =
    status === 'completed'
      ? `Agent "${description}" completed`
      : status === 'failed'
        ? `Agent "${description}" failed: ${error || 'Unknown error'}`
        : `Agent "${description}" was stopped`;

  const outputPath = getTaskOutputPath(taskId);
  const toolUseIdLine = toolUseId ? `\n<${TOOL_USE_ID_TAG}>${toolUseId}</${TOOL_USE_ID_TAG}>` : '';
  const resultSection = finalMessage ? `\n<result>${finalMessage}</result>` : '';
  const usageSection = usage
    ? `\n<usage><total_tokens>${usage.totalTokens}</total_tokens><tool_uses>${usage.toolUses}</tool_uses><duration_ms>${usage.durationMs}</duration_ms></usage>`
    : '';
  const worktreeSection = worktreePath
    ? `\n<${WORKTREE_TAG}><${WORKTREE_PATH_TAG}>${worktreePath}</${WORKTREE_PATH_TAG}>${worktreeBranch ? `<${WORKTREE_BRANCH_TAG}>${worktreeBranch}</${WORKTREE_BRANCH_TAG}>` : ''}</${WORKTREE_TAG}>`
    : '';

  const message = `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${taskId}</${TASK_ID_TAG}>${toolUseIdLine}
<${OUTPUT_FILE_TAG}>${outputPath}</${OUTPUT_FILE_TAG}>
<${STATUS_TAG}>${status}</${STATUS_TAG}>
<${SUMMARY_TAG}>${summary}</${SUMMARY_TAG}>${resultSection}${usageSection}${worktreeSection}
</${TASK_NOTIFICATION_TAG}>`;

  enqueuePendingNotification({ value: message, mode: 'task-notification' });
}

/**
 * LocalAgentTask —— 处理后台 agent 执行。
 *
 * 用统一的 Task 接口替代 src/tools/AgentTool/asyncAgentUtils.ts 中的
 * AsyncAgent 实现。
 */
export const LocalAgentTask: Task = {
  name: 'LocalAgentTask',
  type: 'local_agent',

  async kill(taskId, setAppState) {
    killAsyncAgent(taskId, setAppState);
  },
};

/**
 * 终止一个 agent 任务。如果已被 kill 或 completed 则为 no-op。
 */
export function killAsyncAgent(taskId: string, setAppState: SetAppState): void {
  let killed = false;
  updateTaskState<LocalAgentTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') {
      return task;
    }
    killed = true;
    task.abortController?.abort();
    task.unregisterCleanup?.();
    return {
      ...task,
      status: 'killed',
      endTime: Date.now(),
      evictAfter: task.retain ? undefined : Date.now() + PANEL_GRACE_MS,
      abortController: undefined,
      unregisterCleanup: undefined,
      selectedAgent: undefined,
    };
  });
  if (killed) {
    void evictTaskOutput(taskId);
  }
}

/**
 * 终止所有 running 的 agent 任务。
 * 由 coordinator 模式下的 ESC 取消操作调用，用于停止所有子 agent。
 */
export function killAllRunningAgentTasks(tasks: Record<string, TaskState>, setAppState: SetAppState): void {
  for (const [taskId, task] of Object.entries(tasks)) {
    if (task.type === 'local_agent' && task.status === 'running') {
      killAsyncAgent(taskId, setAppState);
    }
  }
}

/**
 * 将任务标记为已通知，但不入队通知。
 * 由 chat:killAgents 批量终止时调用：当只发送一条汇总消息时，
 * 用于抑制每个 agent 各自的异步通知。
 */
export function markAgentsNotified(taskId: string, setAppState: SetAppState): void {
  updateTaskState<LocalAgentTaskState>(taskId, setAppState, task => {
    if (task.notified) {
      return task;
    }
    return {
      ...task,
      notified: true,
    };
  });
}

/**
 * 更新 agent 任务的进度。
 * 保留已有的 summary 字段，避免来自 assistant 消息的进度更新
 * 覆盖后台摘要的结果。
 */
export function updateAgentProgress(taskId: string, progress: AgentProgress, setAppState: SetAppState): void {
  updateTaskState<LocalAgentTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') {
      return task;
    }

    const existingSummary = task.progress?.summary;
    return {
      ...task,
      progress: existingSummary ? { ...progress, summary: existingSummary } : progress,
    };
  });
}

/**
 * 更新 agent 任务的后台摘要。
 * 由周期性摘要服务调用，用于保存 1-2 句的进度摘要。
 */
export function updateAgentSummary(taskId: string, summary: string, setAppState: SetAppState): void {
  let captured: {
    tokenCount: number;
    toolUseCount: number;
    startTime: number;
    toolUseId: string | undefined;
  } | null = null;

  updateTaskState<LocalAgentTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') {
      return task;
    }

    captured = {
      tokenCount: task.progress?.tokenCount ?? 0,
      toolUseCount: task.progress?.toolUseCount ?? 0,
      startTime: task.startTime,
      toolUseId: task.toolUseId,
    };

    return {
      ...task,
      progress: {
        ...task.progress,
        toolUseCount: task.progress?.toolUseCount ?? 0,
        tokenCount: task.progress?.tokenCount ?? 0,
        summary,
      },
    };
  });

  // 向 SDK 消费者（如 VS Code subagent 面板）发送 summary。在 TUI 下为 no-op。
  // 通过 SDK 选项进行门控，避免未启用该选项的 coordinator 模式会话
  // 把 summary 事件泄漏给没有显式开启的消费者。
  if (captured && getSdkAgentProgressSummariesEnabled()) {
    const { tokenCount, toolUseCount, startTime, toolUseId } = captured;
    emitTaskProgress({
      taskId,
      toolUseId,
      description: summary,
      startTime,
      totalTokens: tokenCount,
      toolUses: toolUseCount,
      summary,
    });
  }
}

/**
 * 以结果完成一个 agent 任务。
 */
export function completeAgentTask(result: AgentToolResult, setAppState: SetAppState): void {
  const taskId = result.agentId;
  updateTaskState<LocalAgentTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') {
      return task;
    }

    task.unregisterCleanup?.();

    return {
      ...task,
      status: 'completed',
      result,
      endTime: Date.now(),
      evictAfter: task.retain ? undefined : Date.now() + PANEL_GRACE_MS,
      abortController: undefined,
      unregisterCleanup: undefined,
      selectedAgent: undefined,
    };
  });
  void evictTaskOutput(taskId);
  // 注意：通知由 AgentTool 通过 enqueueAgentNotification 发送
}

/**
 * 以错误使一个 agent 任务失败。
 */
export function failAgentTask(taskId: string, error: string, setAppState: SetAppState): void {
  updateTaskState<LocalAgentTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') {
      return task;
    }

    task.unregisterCleanup?.();

    return {
      ...task,
      status: 'failed',
      error,
      endTime: Date.now(),
      evictAfter: task.retain ? undefined : Date.now() + PANEL_GRACE_MS,
      abortController: undefined,
      unregisterCleanup: undefined,
      selectedAgent: undefined,
    };
  });
  void evictTaskOutput(taskId);
  // 注意：通知由 AgentTool 通过 enqueueAgentNotification 发送
}

/**
 * 注册一个 agent 任务。
 * 由 AgentTool 调用，用于创建新的后台 agent。
 *
 * @param parentAbortController - 可选的父级 abort controller。若提供，
 *   agent 的 abort controller 会成为子 controller，当父级 abort 时自动 abort。
 *   这样可以保证子 agent 在父级（例如进程内 teammate）abort 时一并被中止。
 */
export function registerAsyncAgent({
  agentId,
  description,
  prompt,
  selectedAgent,
  setAppState,
  parentAbortController,
  toolUseId,
}: {
  agentId: string;
  description: string;
  prompt: string;
  selectedAgent: AgentDefinition;
  setAppState: SetAppState;
  parentAbortController?: AbortController;
  toolUseId?: string;
}): LocalAgentTaskState {
  void initTaskOutputAsSymlink(agentId, getAgentTranscriptPath(asAgentId(agentId)));

  // 创建 abort controller —— 如果提供了父级，则创建随父级自动 abort 的子 controller
  const abortController = parentAbortController
    ? createChildAbortController(parentAbortController)
    : createAbortController();

  const taskState: LocalAgentTaskState = {
    ...createTaskStateBase(agentId, 'local_agent', description, toolUseId),
    type: 'local_agent',
    status: 'running',
    agentId,
    prompt,
    selectedAgent,
    agentType: selectedAgent.agentType ?? 'general-purpose',
    abortController,
    retrieved: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    isBackgrounded: true, // registerAsyncAgent 立即后台化
    pendingMessages: [],
    retain: false,
    diskLoaded: false,
  };

  // 注册 cleanup 处理器
  const unregisterCleanup = registerCleanup(async () => {
    killAsyncAgent(agentId, setAppState);
  });

  taskState.unregisterCleanup = unregisterCleanup;

  // 在 AppState 中注册任务
  registerTask(taskState, setAppState);

  return taskState;
}

// taskId -> resolve 函数的映射，用于后台化信号
// 当调用 backgroundAgentTask 时，会 resolve 对应的 promise
const backgroundSignalResolvers = new Map<string, () => void>();

/**
 * 注册一个稍后可能被后台化的前台 agent 任务。
 * 当某个 agent 运行时间足够长、足以展示 BackgroundHint 时调用。
 * @returns 包含 taskId 和 backgroundSignal promise 的对象
 */
export function registerAgentForeground({
  agentId,
  description,
  prompt,
  selectedAgent,
  setAppState,
  autoBackgroundMs,
  toolUseId,
}: {
  agentId: string;
  description: string;
  prompt: string;
  selectedAgent: AgentDefinition;
  setAppState: SetAppState;
  autoBackgroundMs?: number;
  toolUseId?: string;
}): {
  taskId: string;
  backgroundSignal: Promise<void>;
  cancelAutoBackground?: () => void;
} {
  void initTaskOutputAsSymlink(agentId, getAgentTranscriptPath(asAgentId(agentId)));

  const abortController = createAbortController();

  const unregisterCleanup = registerCleanup(async () => {
    killAsyncAgent(agentId, setAppState);
  });

  const taskState: LocalAgentTaskState = {
    ...createTaskStateBase(agentId, 'local_agent', description, toolUseId),
    type: 'local_agent',
    status: 'running',
    agentId,
    prompt,
    selectedAgent,
    agentType: selectedAgent.agentType ?? 'general-purpose',
    abortController,
    unregisterCleanup,
    retrieved: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    isBackgrounded: false, // 尚未后台化 —— 在前台运行
    pendingMessages: [],
    retain: false,
    diskLoaded: false,
  };

  // 创建后台化信号 promise
  let resolveBackgroundSignal: () => void;
  const backgroundSignal = new Promise<void>(resolve => {
    resolveBackgroundSignal = resolve;
  });
  backgroundSignalResolvers.set(agentId, resolveBackgroundSignal!);

  registerTask(taskState, setAppState);

  // 如果配置了超时，则在超时后自动后台化
  let cancelAutoBackground: (() => void) | undefined;
  if (autoBackgroundMs !== undefined && autoBackgroundMs > 0) {
    const timer = setTimeout(
      (setAppState, agentId) => {
        // 将任务标记为后台化，并 resolve 信号
        setAppState(prev => {
          const prevTask = prev.tasks[agentId];
          if (!isLocalAgentTask(prevTask) || prevTask.isBackgrounded) {
            return prev;
          }
          return {
            ...prev,
            tasks: {
              ...prev.tasks,
              [agentId]: { ...prevTask, isBackgrounded: true },
            },
          };
        });
        const resolver = backgroundSignalResolvers.get(agentId);
        if (resolver) {
          resolver();
          backgroundSignalResolvers.delete(agentId);
        }
      },
      autoBackgroundMs,
      setAppState,
      agentId,
    );
    cancelAutoBackground = () => clearTimeout(timer);
  }

  return { taskId: agentId, backgroundSignal, cancelAutoBackground };
}

/**
 * 将指定的前台 agent 任务后台化。
 * @returns 成功后台化返回 true，否则返回 false
 */
export function backgroundAgentTask(taskId: string, getAppState: () => AppState, setAppState: SetAppState): boolean {
  const state = getAppState();
  const task = state.tasks[taskId];
  if (!isLocalAgentTask(task) || task.isBackgrounded) {
    return false;
  }

  // 更新状态，标记为已后台化
  setAppState(prev => {
    const prevTask = prev.tasks[taskId];
    if (!isLocalAgentTask(prevTask)) {
      return prev;
    }
    return {
      ...prev,
      tasks: {
        ...prev.tasks,
        [taskId]: { ...prevTask, isBackgrounded: true },
      },
    };
  });

  // resolve 后台化信号以中断 agent 循环
  const resolver = backgroundSignalResolvers.get(taskId);
  if (resolver) {
    resolver();
    backgroundSignalResolvers.delete(taskId);
  }

  return true;
}

/**
 * 在 agent 未被后台化就完成时，注销相应的前台 agent 任务。
 */
export function unregisterAgentForeground(taskId: string, setAppState: SetAppState): void {
  // 清理后台化信号 resolver
  backgroundSignalResolvers.delete(taskId);

  let cleanupFn: (() => void) | undefined;

  setAppState(prev => {
    const task = prev.tasks[taskId];
    // 仅当是前台任务（未后台化）时才移除
    if (!isLocalAgentTask(task) || task.isBackgrounded) {
      return prev;
    }

    // 捕获 cleanup 函数，以便在 updater 之外调用
    cleanupFn = task.unregisterCleanup;

    const { [taskId]: removed, ...rest } = prev.tasks;
    return { ...prev, tasks: rest };
  });

  // 在状态 updater 之外调用 cleanup（避免在 updater 中产生副作用）
  cleanupFn?.();
}
