import type { ToolUseBlock } from '@anthropic-ai/sdk/resources';
import { getRemoteSessionUrl } from '../../constants/product.js';
import {
  OUTPUT_FILE_TAG,
  REMOTE_REVIEW_PROGRESS_TAG,
  REMOTE_REVIEW_TAG,
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
  TASK_TYPE_TAG,
  TOOL_USE_ID_TAG,
  ULTRAPLAN_TAG,
} from '../../constants/xml.js';
import type { SDKAssistantMessage, SDKMessage } from '../../entrypoints/agentSdkTypes.js';
import type { MessageContent } from '../../types/message.js';
import type { SetAppState, Task, TaskContext, TaskStateBase } from '../../Task.js';
import { createTaskStateBase, generateTaskId } from '../../Task.js';
import { TodoWriteTool } from '@claude-code-best/builtin-tools/tools/TodoWriteTool/TodoWriteTool.js';
import {
  type BackgroundRemoteSessionPrecondition,
  checkBackgroundRemoteSessionEligibility,
} from '../../utils/background/remote/remoteSession.js';
export type { BackgroundRemoteSessionPrecondition };
import { logForDebugging } from '../../utils/debug.js';
import { logError } from '../../utils/log.js';
import { enqueuePendingNotification } from '../../utils/messageQueueManager.js';
import { extractTag, extractTextContent } from '../../utils/messages.js';
import { emitTaskTerminatedSdk } from '../../utils/sdkEventQueue.js';
import {
  deleteRemoteAgentMetadata,
  listRemoteAgentMetadata,
  type RemoteAgentMetadata,
  writeRemoteAgentMetadata,
} from '../../utils/sessionStorage.js';
import { jsonStringify } from '../../utils/slowOperations.js';
import { appendTaskOutput, evictTaskOutput, getTaskOutputPath, initTaskOutput } from '../../utils/task/diskOutput.js';
import { registerTask, updateTaskState } from '../../utils/task/framework.js';
import { fetchSession } from '../../utils/teleport/api.js';
import { archiveRemoteSession, pollRemoteSessionEvents } from '../../utils/teleport.js';
import type { TodoList } from '../../utils/todo/types.js';
import type { UltraplanPhase } from '../../utils/ultraplan/ccrSession.js';

export type RemoteAgentTaskState = TaskStateBase & {
  type: 'remote_agent';
  remoteTaskType: RemoteTaskType;
  /** 任务特定的元数据（PR 编号、仓库等）。 */
  remoteTaskMetadata?: RemoteTaskMetadata;
  sessionId: string; // 用于 API 调用的原始 session ID
  command: string;
  title: string;
  todoList: TodoList;
  log: SDKMessage[];
  /**
   * 长时运行的 agent：在第一次 `result` 之后不会被标记为完成。
   */
  isLongRunning?: boolean;
  /**
   * 本地轮询器开始观察此任务的时间（在 spawn 时或在 restore 时）。
   * review 超时从这里开始计时，避免 restore 一个 >30 分钟前 spawn 的任务
   * 时立刻触发超时。
   */
  pollStartedAt: number;
  /** 当此任务由 teleport 过来的 /ultrareview 命令创建时为 true。 */
  isRemoteReview?: boolean;
  /** 从 orchestrator 的 <remote-review-progress> 心跳回显中解析得到。 */
  reviewProgress?: {
    stage?: 'finding' | 'verifying' | 'synthesizing';
    bugsFound: number;
    bugsVerified: number;
    bugsRefuted: number;
  };
  isUltraplan?: boolean;
  /**
   * 由扫描器推导出的 pill 状态。undefined = 运行中；`needs_input` 表示
   * 远程提出了澄清问题并处于空闲；`plan_ready` 表示 ExitPlanMode
   * 正在等待浏览器审批。会呈现在 pill 徽章和详情对话框状态行上。
   */
  ultraplanPhase?: Exclude<UltraplanPhase, 'running'>;
};

const REMOTE_TASK_TYPES = ['remote-agent', 'ultraplan', 'ultrareview', 'autofix-pr', 'background-pr'] as const;
export type RemoteTaskType = (typeof REMOTE_TASK_TYPES)[number];

function isRemoteTaskType(v: string | undefined): v is RemoteTaskType {
  return (REMOTE_TASK_TYPES as readonly string[]).includes(v ?? '');
}

export type AutofixPrRemoteTaskMetadata = {
  owner: string;
  repo: string;
  prNumber: number;
  /**
   * 在 /autofix-pr 启动时捕获的 PR head commit SHA。completionChecker
   * 会将其与实时 head 比较以检测 agent 是否推送了新 commit。
   * 可选 —— 因为启动时 gh CLI 可能不可用，此时 checker 会退化为
   * 仅在 terminal 状态下判定完成。
   * 通过 session sidecar 在 --resume 之间保留。
   */
  initialHeadSha?: string;
};

export type RemoteTaskMetadata = AutofixPrRemoteTaskMetadata;

/**
 * 每次轮询会对 remoteTaskType 匹配的任务调用一次。返回非空字符串表示完成任务
 * （该字符串会作为通知文本），返回 null 表示继续轮询。
 * 会访问外部 API 的 checker 应当自行限流。
 */
export type RemoteTaskCompletionChecker = (
  remoteTaskMetadata: RemoteTaskMetadata | undefined,
) => Promise<string | null>;

const completionCheckers = new Map<RemoteTaskType, RemoteTaskCompletionChecker>();

/**
 * 为某种远程任务类型注册完成 checker。每次轮询都会调用；
 * 通过 sidecar 中的 remoteTaskType + remoteTaskMetadata 在 --resume 之间保留。
 */
export function registerCompletionChecker(remoteTaskType: RemoteTaskType, checker: RemoteTaskCompletionChecker): void {
  completionCheckers.set(remoteTaskType, checker);
}

/**
 * 在任务转换到 terminal 状态且通知入队之后调用。
 * 命令模块用它来释放单例锁、清理缓存状态，或执行框架无法感知的其他清理。
 * hook 必须同步、尽力而为 —— 错误只记录日志，不会向上抛出。
 */
export type RemoteTaskCompletionHook = (taskId: string, remoteTaskMetadata: RemoteTaskMetadata | undefined) => void;

const completionHooks = new Map<RemoteTaskType, RemoteTaskCompletionHook>();

/**
 * 检查已完成远程任务积累的日志，返回一个 XML 片段，内联注入到
 * 完成时的 task-notification 中。返回 null 表示回退到框架的通用「任务完成」
 * 通知（仅给出文件路径指针）。用于这样的命令模块：其远程 agent 会发出
 * 本地模型应当直接阅读的结构化结果标签。
 */
export type RemoteTaskContentExtractor = (log: SDKMessage[]) => string | null;

const contentExtractors = new Map<RemoteTaskType, RemoteTaskContentExtractor>();

/**
 * 为某种远程任务类型注册 content extractor。每个任务在通用的完成分支
 * （archived、completionChecker、result 驱动）中只会被调用一次。
 * isRemoteReview 任务走自己的专属路径，完全跳过 extractor。
 * 错误会向上抛给框架，框架记录日志并回退到通用通知。
 */
export function registerContentExtractor(remoteTaskType: RemoteTaskType, extractor: RemoteTaskContentExtractor): void {
  contentExtractors.set(remoteTaskType, extractor);
}

function tryExtractRichContent(task: RemoteAgentTaskState, log: SDKMessage[]): string | null {
  const extractor = contentExtractors.get(task.remoteTaskType);
  if (!extractor) return null;
  try {
    return extractor(log);
  } catch (e) {
    logError(e);
    return null;
  }
}

/**
 * 为某种远程任务类型注册完成 hook。在任务到达 terminal 状态后调用一次，
 * 适用于框架的任意完成分支（archived session、completionChecker、
 * stableIdle、result）。用它来释放命令模块的状态（例如单例锁），
 * 而不必让框架反向 import 命令包。
 */
export function registerCompletionHook(remoteTaskType: RemoteTaskType, hook: RemoteTaskCompletionHook): void {
  completionHooks.set(remoteTaskType, hook);
}

function runCompletionHook(taskId: string, task: RemoteAgentTaskState): void {
  const hook = completionHooks.get(task.remoteTaskType);
  if (!hook) return;
  try {
    hook(taskId, task.remoteTaskMetadata);
  } catch (e) {
    logError(e);
  }
}

/**
 * 将一个 remote-agent 元数据条目持久化到 session sidecar。
 * Fire-and-forget —— 持久化失败不应阻塞任务注册。
 */
async function persistRemoteAgentMetadata(meta: RemoteAgentMetadata): Promise<void> {
  try {
    await writeRemoteAgentMetadata(meta.taskId, meta);
  } catch (e) {
    logForDebugging(`persistRemoteAgentMetadata failed: ${String(e)}`);
  }
}

/**
 * 从 session sidecar 中移除一个 remote-agent 元数据条目。
 * 在任务完成/终止时调用，确保恢复的会话不会让已经完成的任务复活。
 */
async function removeRemoteAgentMetadata(taskId: string): Promise<void> {
  try {
    await deleteRemoteAgentMetadata(taskId);
  } catch (e) {
    logForDebugging(`removeRemoteAgentMetadata failed: ${String(e)}`);
  }
}

// 前置条件错误结果
export type RemoteAgentPreconditionResult =
  | {
      eligible: true;
    }
  | {
      eligible: false;
      errors: BackgroundRemoteSessionPrecondition[];
    };

/**
 * 检查是否具备创建远程 agent 会话的条件。
 */
export async function checkRemoteAgentEligibility({
  skipBundle = false,
}: {
  skipBundle?: boolean;
} = {}): Promise<RemoteAgentPreconditionResult> {
  const errors = await checkBackgroundRemoteSessionEligibility({ skipBundle });
  if (errors.length > 0) {
    return { eligible: false, errors };
  }
  return { eligible: true };
}

/**
 * 对前置条件错误进行格式化，便于展示。
 */
export function formatPreconditionError(error: BackgroundRemoteSessionPrecondition): string {
  switch (error.type) {
    case 'not_logged_in':
      return 'Please run /login and sign in with your Claude.ai account (not Console).';
    case 'no_remote_environment':
      return 'No cloud environment available. Set one up at https://claude.ai/code/onboarding?magic=env-setup';
    case 'not_in_git_repo':
      return 'Background tasks require a git repository. Initialize git or run from a git repository.';
    case 'no_git_remote':
      return 'Background tasks require a GitHub remote. Add one with `git remote add origin REPO_URL`.';
    case 'github_app_not_installed':
      return 'The Claude GitHub app must be installed on this repository first.\nhttps://github.com/apps/claude/installations/new';
    case 'policy_blocked':
      return "Remote sessions are disabled by your organization's policy. Contact your organization admin to enable them.";
  }
}

/**
 * 将一条远程任务通知入队到消息队列。
 */
function enqueueRemoteNotification(
  taskId: string,
  title: string,
  status: 'completed' | 'failed' | 'killed',
  setAppState: SetAppState,
  toolUseId?: string,
): void {
  // 原子地检查并设置 notified 标志，防止重复通知。
  if (!markTaskNotified(taskId, setAppState)) return;

  const statusText = status === 'completed' ? 'completed successfully' : status === 'failed' ? 'failed' : 'was stopped';

  const toolUseIdLine = toolUseId ? `\n<${TOOL_USE_ID_TAG}>${toolUseId}</${TOOL_USE_ID_TAG}>` : '';

  const outputPath = getTaskOutputPath(taskId);
  const message = `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${taskId}</${TASK_ID_TAG}>${toolUseIdLine}
<${TASK_TYPE_TAG}>remote_agent</${TASK_TYPE_TAG}>
<${OUTPUT_FILE_TAG}>${outputPath}</${OUTPUT_FILE_TAG}>
<${STATUS_TAG}>${status}</${STATUS_TAG}>
<${SUMMARY_TAG}>Remote task "${title}" ${statusText}</${SUMMARY_TAG}>
</${TASK_NOTIFICATION_TAG}>`;

  enqueuePendingNotification({ value: message, mode: 'task-notification' });
}

/**
 * 与 enqueueRemoteNotification 相同，但内联注入一段结构化 XML 片段
 * （由已注册的 RemoteTaskContentExtractor 返回），让本地模型直接读到
 * 远程 agent 的结果，而无需再去跟随文件路径指针。mode 依旧是
 * 'task-notification' —— 外层 XML 不变，只是 body 不同。
 */
function enqueueRichRemoteNotification(
  taskId: string,
  title: string,
  status: 'completed' | 'failed' | 'killed',
  richContent: string,
  setAppState: SetAppState,
  toolUseId?: string,
): void {
  if (!markTaskNotified(taskId, setAppState)) return;

  const statusText = status === 'completed' ? 'completed successfully' : status === 'failed' ? 'failed' : 'was stopped';
  const toolUseIdLine = toolUseId ? `\n<${TOOL_USE_ID_TAG}>${toolUseId}</${TOOL_USE_ID_TAG}>` : '';
  const outputPath = getTaskOutputPath(taskId);

  const message = `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${taskId}</${TASK_ID_TAG}>${toolUseIdLine}
<${TASK_TYPE_TAG}>remote_agent</${TASK_TYPE_TAG}>
<${OUTPUT_FILE_TAG}>${outputPath}</${OUTPUT_FILE_TAG}>
<${STATUS_TAG}>${status}</${STATUS_TAG}>
<${SUMMARY_TAG}>Remote task "${title}" ${statusText}</${SUMMARY_TAG}>
</${TASK_NOTIFICATION_TAG}>
The remote agent produced the following structured outcome. Summarize the key changes for the user:

${richContent}`;

  enqueuePendingNotification({ value: message, mode: 'task-notification' });
}

/**
 * 原子地将任务标记为已通知。如果本次调用翻转了标志，返回 true
 * （调用方应当入队通知）；如果已经被通知过，返回 false（调用方应当跳过）。
 */
function markTaskNotified(taskId: string, setAppState: SetAppState): boolean {
  let shouldEnqueue = false;
  updateTaskState(taskId, setAppState, task => {
    if (task.notified) {
      return task;
    }
    shouldEnqueue = true;
    return { ...task, notified: true };
  });
  return shouldEnqueue;
}

/**
 * 从远程会话日志中提取 plan 内容。
 * 在所有 assistant 消息中搜索 <ultraplan>...</ultraplan> 标签。
 */
export function extractPlanFromLog(log: SDKMessage[]): string | null {
  // 倒序遍历 assistant 消息以查找 <ultraplan> 内容
  for (let i = log.length - 1; i >= 0; i--) {
    const msg = log[i] as SDKAssistantMessage;
    if (msg?.type !== 'assistant') continue;
    const content = msg.message?.content as MessageContent | undefined;
    if (!content) continue;
    const fullText = extractTextContent(
      typeof content === 'string' ? [{ type: 'text' as const, text: content }] : content,
      '\n',
    );
    const plan = extractTag(fullText, ULTRAPLAN_TAG);
    if (plan?.trim()) return plan.trim();
  }
  return null;
}

/**
 * 入队一条 ultraplan 专用的失败通知。与 enqueueRemoteNotification 不同，
 * 此通知不会指示模型去读取原始输出文件（那是一份 JSONL dump，
 * 对 plan 提取毫无用处）。
 */
export function enqueueUltraplanFailureNotification(
  taskId: string,
  sessionId: string,
  reason: string,
  setAppState: SetAppState,
): void {
  if (!markTaskNotified(taskId, setAppState)) return;

  const sessionUrl = getRemoteTaskSessionUrl(sessionId);
  const message = `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${taskId}</${TASK_ID_TAG}>
<${TASK_TYPE_TAG}>remote_agent</${TASK_TYPE_TAG}>
<${STATUS_TAG}>failed</${STATUS_TAG}>
<${SUMMARY_TAG}>Ultraplan failed: ${reason}</${SUMMARY_TAG}>
</${TASK_NOTIFICATION_TAG}>
The remote Ultraplan session did not produce a plan (${reason}). Inspect the session at ${sessionUrl} and tell the user to retry locally with plan mode.`;

  enqueuePendingNotification({ value: message, mode: 'task-notification' });
}

/**
 * 从远程会话日志中提取 review 内容。
 *
 * 两种生产者，两种事件形态：
 * - bughunter 模式：run_hunt.sh 是一个 SessionStart hook；它的 echo 落地为
 *   {type:'system', subtype:'hook_progress', stdout:'...'}。Claude 完全不
 *   参与对话，因此没有任何 assistant 消息。
 * - prompt 模式：由真实的 assistant 一轮把 review 包在标签里。
 *
 * 先扫 hook_progress，因为 bughunter 是计划中的生产路径，
 * prompt 模式是开发/兜底方案。两种情况都按最新优先 —— 标签在运行
 * 结束时只出现一次，所以倒序遍历可以短路返回。
 */
function extractReviewFromLog(log: SDKMessage[]): string | null {
  for (let i = log.length - 1; i >= 0; i--) {
    const msg = log[i];
    // hook 退出前的最后一次 echo 可能落在最后一条 hook_progress 中，
    // 也可能落在终止的 hook_response 中（取决于缓冲）；
    // 两者都是扁平的 stdout。
    if (msg?.type === 'system' && (msg.subtype === 'hook_progress' || msg.subtype === 'hook_response')) {
      const tagged = extractTag(msg.stdout as string, REMOTE_REVIEW_TAG);
      if (tagged?.trim()) return tagged.trim();
    }
  }

  for (let i = log.length - 1; i >= 0; i--) {
    const msg = log[i];
    if (msg?.type !== 'assistant') continue;
    const content = (msg as SDKAssistantMessage).message?.content as MessageContent | undefined;
    if (!content) continue;
    const fullText = extractTextContent(
      typeof content === 'string' ? [{ type: 'text' as const, text: content }] : content,
      '\n',
    );
    const tagged = extractTag(fullText, REMOTE_REVIEW_TAG);
    if (tagged?.trim()) return tagged.trim();
  }

  // hook stdout 拼接的兜底：单次 echo 应当落在一个事件中，但
  // 大型 JSON 负载在管道缓冲区写满时可能跨两次刷新。上面的逐消息扫描
  // 会漏掉跨事件被切开的标签。
  const hookStdout = log
    .filter(msg => msg.type === 'system' && (msg.subtype === 'hook_progress' || msg.subtype === 'hook_response'))
    .map(msg => msg.stdout as string)
    .join('');
  const hookTagged = extractTag(hookStdout, REMOTE_REVIEW_TAG);
  if (hookTagged?.trim()) return hookTagged.trim();

  // 兜底：按时间顺序拼接所有 assistant 文本。
  const allText = log
    .filter((msg): msg is SDKAssistantMessage => msg.type === 'assistant')
    .map(msg => {
      const content = msg.message?.content as MessageContent | undefined;
      if (!content) return '';
      return extractTextContent(
        typeof content === 'string' ? [{ type: 'text' as const, text: content }] : content,
        '\n',
      );
    })
    .join('\n')
    .trim();

  return allText || null;
}

/**
 * extractReviewFromLog 的「仅标签」变体，用于增量扫描。
 *
 * 只有在找到显式 <remote-review> 标签时才返回非 null。
 * 与 extractReviewFromLog 不同，此函数不会回退到拼接的 assistant 文本。
 * 这一点对增量扫描至关重要：在 prompt 模式下，早期未带标签的
 * assistant 消息（例如 "I'm analyzing the diff..."）会触发回退，
 * 提前设置 cachedReviewContent，在真正的带标签输出到达之前就
 * 完成了 review。
 */
function extractReviewTagFromLog(log: SDKMessage[]): string | null {
  // hook_progress / hook_response 的逐消息扫描（bughunter 路径）
  for (let i = log.length - 1; i >= 0; i--) {
    const msg = log[i];
    if (msg?.type === 'system' && (msg.subtype === 'hook_progress' || msg.subtype === 'hook_response')) {
      const tagged = extractTag(msg.stdout as string, REMOTE_REVIEW_TAG);
      if (tagged?.trim()) return tagged.trim();
    }
  }

  // assistant 文本的逐消息扫描（prompt 模式）
  for (let i = log.length - 1; i >= 0; i--) {
    const msg = log[i];
    if (msg?.type !== 'assistant') continue;
    const content = (msg as SDKAssistantMessage).message?.content as MessageContent | undefined;
    if (!content) continue;
    const fullText = extractTextContent(
      typeof content === 'string' ? [{ type: 'text' as const, text: content }] : content,
      '\n',
    );
    const tagged = extractTag(fullText, REMOTE_REVIEW_TAG);
    if (tagged?.trim()) return tagged.trim();
  }

  // 针对被切分标签的 hook stdout 拼接兜底
  const hookStdout = log
    .filter(msg => msg.type === 'system' && (msg.subtype === 'hook_progress' || msg.subtype === 'hook_response'))
    .map(msg => msg.stdout as string)
    .join('');
  const hookTagged = extractTag(hookStdout, REMOTE_REVIEW_TAG);
  if (hookTagged?.trim()) return hookTagged.trim();

  return null;
}

/**
 * 入队一条 remote-review 完成通知。把 review 文本直接注入到消息队列，
 * 让本地模型在下一轮就能收到 —— 无需文件中转，也不改变模式。
 * 会话保持存活，claude.ai URL 因此成为用户可随时回看的持久记录；
 * 清理由 TTL 负责。
 */
function enqueueRemoteReviewNotification(taskId: string, reviewContent: string, setAppState: SetAppState): void {
  if (!markTaskNotified(taskId, setAppState)) return;

  const message = `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${taskId}</${TASK_ID_TAG}>
<${TASK_TYPE_TAG}>remote_agent</${TASK_TYPE_TAG}>
<${STATUS_TAG}>completed</${STATUS_TAG}>
<${SUMMARY_TAG}>Remote review completed</${SUMMARY_TAG}>
</${TASK_NOTIFICATION_TAG}>
The remote review produced the following findings:

${reviewContent}`;

  enqueuePendingNotification({ value: message, mode: 'task-notification' });
}

/**
 * 入队一条 remote-review 失败通知。
 */
function enqueueRemoteReviewFailureNotification(taskId: string, reason: string, setAppState: SetAppState): void {
  if (!markTaskNotified(taskId, setAppState)) return;

  const message = `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${taskId}</${TASK_ID_TAG}>
<${TASK_TYPE_TAG}>remote_agent</${TASK_TYPE_TAG}>
<${STATUS_TAG}>failed</${STATUS_TAG}>
<${SUMMARY_TAG}>Remote review failed: ${reason}</${SUMMARY_TAG}>
</${TASK_NOTIFICATION_TAG}>
Remote review did not produce output (${reason}). Tell the user to retry /ultrareview, or use /review for a local review instead.`;

  enqueuePendingNotification({ value: message, mode: 'task-notification' });
}

/**
 * 从 SDK 消息中提取 todo 列表（找到最后一次 TodoWrite 工具调用）。
 */
function extractTodoListFromLog(log: SDKMessage[]): TodoList {
  const todoListMessage = log.findLast(
    (msg): msg is SDKAssistantMessage =>
      msg.type === 'assistant' &&
      Array.isArray((msg as SDKAssistantMessage).message?.content) &&
      (((msg as SDKAssistantMessage).message?.content ?? []) as Array<{ type: string; name?: string }>).some(
        block => block.type === 'tool_use' && block.name === TodoWriteTool.name,
      ),
  );
  if (!todoListMessage) {
    return [];
  }

  const contentBlocks = (todoListMessage.message?.content ?? []) as Array<{
    type: string;
    name?: string;
    input?: unknown;
  }>;
  const input = contentBlocks.find(
    (block): block is ToolUseBlock => block.type === 'tool_use' && block.name === TodoWriteTool.name,
  )?.input;
  if (!input) {
    return [];
  }

  const parsedInput = TodoWriteTool.inputSchema.safeParse(input);
  if (!parsedInput.success) {
    return [];
  }

  return parsedInput.data.todos;
}

/**
 * 在统一任务框架中注册一个远程 agent 任务。
 * 封装了任务 ID 生成、输出初始化、状态创建、注册以及轮询。
 * 调用方仍需自行处理自定义的预注册逻辑（git 对话框、对话记录上传、teleport 选项等）。
 */
export function registerRemoteAgentTask(options: {
  remoteTaskType: RemoteTaskType;
  session: { id: string; title: string };
  command: string;
  context: TaskContext;
  toolUseId?: string;
  isRemoteReview?: boolean;
  isUltraplan?: boolean;
  isLongRunning?: boolean;
  remoteTaskMetadata?: RemoteTaskMetadata;
}): {
  taskId: string;
  sessionId: string;
  cleanup: () => void;
} {
  const {
    remoteTaskType,
    session,
    command,
    context,
    toolUseId,
    isRemoteReview,
    isUltraplan,
    isLongRunning,
    remoteTaskMetadata,
  } = options;
  const taskId = generateTaskId('remote_agent');

  // 在注册任务之前先创建输出文件。
  // RemoteAgentTask 使用 appendTaskOutput()（不是 TaskOutput），因此
  // 在任何输出到来之前文件必须存在，以便读取方使用。
  void initTaskOutput(taskId);

  const taskState: RemoteAgentTaskState = {
    ...createTaskStateBase(taskId, 'remote_agent', session.title, toolUseId),
    type: 'remote_agent',
    remoteTaskType,
    status: 'running',
    sessionId: session.id,
    command,
    title: session.title,
    todoList: [],
    log: [],
    isRemoteReview,
    isUltraplan,
    isLongRunning,
    pollStartedAt: Date.now(),
    remoteTaskMetadata,
  };

  registerTask(taskState, context.setAppState);

  // 把身份信息持久化到 session sidecar，这样 --resume 才能重新连上仍在
  // 运行的远程会话。状态不会被存储 —— 它会在 restore 时从 CCR 现拉。
  void persistRemoteAgentMetadata({
    taskId,
    remoteTaskType,
    sessionId: session.id,
    title: session.title,
    command,
    spawnedAt: Date.now(),
    toolUseId,
    isUltraplan,
    isRemoteReview,
    isLongRunning,
    remoteTaskMetadata,
  });

  // Ultraplan 的生命周期由 ultraplan.tsx 中的 startDetachedPoll 负责。通用的
  // 轮询仍然会运行，以便填充 session.log 用于详情视图的进度计数；
  // 下面的 result 查找守卫可以避免过早完成。
  // TODO(#23985)：把 ExitPlanModeScanner 合并到这个轮询器中，删除 startDetachedPoll。
  const stopPolling = startRemoteSessionPolling(taskId, context);

  return {
    taskId,
    sessionId: session.id,
    cleanup: stopPolling,
  };
}

/**
 * 在 --resume 时从 session sidecar 还原 remote-agent 任务。
 *
 * 扫描 remote-agents/，为每一个任务拉取最新的 CCR 状态，把
 * RemoteAgentTaskState 重建成 AppState.tasks，并重启仍在运行的会话的轮询。
 * 已 archived 或 404 的会话会删除对应的 sidecar 文件。
 * 必须在 switchSession() 之后执行，这样 getSessionId() 才会指向
 * 被 resume 的会话的 sidecar 目录。
 */
export async function restoreRemoteAgentTasks(context: TaskContext): Promise<void> {
  try {
    await restoreRemoteAgentTasksImpl(context);
  } catch (e) {
    logForDebugging(`restoreRemoteAgentTasks failed: ${String(e)}`);
  }
}

async function restoreRemoteAgentTasksImpl(context: TaskContext): Promise<void> {
  const persisted = await listRemoteAgentMetadata();
  if (persisted.length === 0) return;

  for (const meta of persisted) {
    let remoteStatus: string;
    try {
      const session = await fetchSession(meta.sessionId);
      remoteStatus = session.session_status;
    } catch (e) {
      // 只有 404 才表示 CCR 会话真的没了。鉴权错误（401 或缺少
      // OAuth token）可以通过 /login 恢复 —— 远程会话仍在运行。
      // fetchSession 对所有 4xx 都抛出普通 Error（validateStatus 把 <500
      // 视为成功），所以 isTransientNetworkError 无法区分；
      // 这里通过匹配 404 消息来判别。
      if (e instanceof Error && e.message.startsWith('Session not found:')) {
        logForDebugging(`restoreRemoteAgentTasks: dropping ${meta.taskId} (404: ${String(e)})`);
        void removeRemoteAgentMetadata(meta.taskId);
      } else {
        logForDebugging(`restoreRemoteAgentTasks: skipping ${meta.taskId} (recoverable: ${String(e)})`);
      }
      continue;
    }

    if (remoteStatus === 'archived') {
      // 会话在本地客户端离线期间已结束。不要让它复活。
      void removeRemoteAgentMetadata(meta.taskId);
      continue;
    }

    const taskState: RemoteAgentTaskState = {
      ...createTaskStateBase(meta.taskId, 'remote_agent', meta.title, meta.toolUseId),
      type: 'remote_agent',
      remoteTaskType: isRemoteTaskType(meta.remoteTaskType) ? meta.remoteTaskType : 'remote-agent',
      status: 'running',
      sessionId: meta.sessionId,
      command: meta.command,
      title: meta.title,
      todoList: [],
      log: [],
      isRemoteReview: meta.isRemoteReview,
      isUltraplan: meta.isUltraplan,
      isLongRunning: meta.isLongRunning,
      startTime: meta.spawnedAt,
      pollStartedAt: Date.now(),
      remoteTaskMetadata: meta.remoteTaskMetadata as RemoteTaskMetadata | undefined,
    };

    registerTask(taskState, context.setAppState);
    void initTaskOutput(meta.taskId);
    startRemoteSessionPolling(meta.taskId, context);
  }
}

/**
 * 开始轮询远程会话的更新。
 * 返回一个 cleanup 函数用于停止轮询。
 */
function startRemoteSessionPolling(taskId: string, context: TaskContext): () => void {
  let isRunning = true;
  const POLL_INTERVAL_MS = 1000;
  const REMOTE_REVIEW_TIMEOUT_MS = 30 * 60 * 1000;
  // 远程会话在工具轮次之间会切换到 'idle'。100+ 次快速轮次下，
  // 1 秒一次的轮询一定会捕获到运行过程中暂时的 idle。需要连续 N 次
  // 稳定 idle（日志没有增长）才相信它真的 idle 了。
  const STABLE_IDLE_POLLS = 5;
  let consecutiveIdlePolls = 0;
  let lastEventId: string | null = null;
  let accumulatedLog: SDKMessage[] = [];
  // 跨 tick 缓存，避免重复扫描完整日志。标签只在运行结束时出现一次；
  // 只扫描增量（response.newEvents）的复杂度是 O(new)。
  let cachedReviewContent: string | null = null;

  const poll = async (): Promise<void> => {
    if (!isRunning) return;

    try {
      const appState = context.getAppState();
      const task = appState.tasks?.[taskId] as RemoteAgentTaskState | undefined;
      if (!task || task.status !== 'running') {
        // 任务被外部（TaskStopTool）终止，或者已经处于 terminal 状态。
        // 会话保持存活，使 claude.ai URL 仍然有效 —— run_hunt.sh 的
        // post_stage() 调用在那里以 assistant 事件落地，用户关闭终端后
        // 可能还想回看。清理由 TTL 负责。
        return;
      }

      const response = await pollRemoteSessionEvents(task.sessionId, lastEventId);
      lastEventId = response.lastEventId;
      const logGrew = response.newEvents.length > 0;
      if (logGrew) {
        accumulatedLog = [...accumulatedLog, ...response.newEvents];
        const deltaText = response.newEvents
          .map(msg => {
            if (msg.type === 'assistant') {
              const content = (msg as SDKAssistantMessage).message?.content;
              if (!content || typeof content === 'string') return '';
              return (content as Array<{ type: string; text?: string }>)
                .filter(block => block.type === 'text')
                .map(block => ('text' in block ? block.text : ''))
                .join('\n');
            }
            return jsonStringify(msg);
          })
          .join('\n');
        if (deltaText) {
          appendTaskOutput(taskId, deltaText + '\n');
        }
      }

      if (response.sessionStatus === 'archived') {
        updateTaskState<RemoteAgentTaskState>(taskId, context.setAppState, t =>
          t.status === 'running' ? { ...t, status: 'completed', endTime: Date.now() } : t,
        );
        const richContent = tryExtractRichContent(task, accumulatedLog);
        if (richContent) {
          enqueueRichRemoteNotification(
            taskId,
            task.title,
            'completed',
            richContent,
            context.setAppState,
            task.toolUseId,
          );
        } else {
          enqueueRemoteNotification(taskId, task.title, 'completed', context.setAppState, task.toolUseId);
        }
        void evictTaskOutput(taskId);
        void removeRemoteAgentMetadata(taskId);
        runCompletionHook(taskId, task);
        return;
      }

      const checker = completionCheckers.get(task.remoteTaskType);
      if (checker) {
        const completionResult = await checker(task.remoteTaskMetadata);
        if (completionResult !== null) {
          updateTaskState<RemoteAgentTaskState>(taskId, context.setAppState, t =>
            t.status === 'running' ? { ...t, status: 'completed', endTime: Date.now() } : t,
          );
          const richContent = tryExtractRichContent(task, accumulatedLog);
          if (richContent) {
            enqueueRichRemoteNotification(
              taskId,
              completionResult,
              'completed',
              richContent,
              context.setAppState,
              task.toolUseId,
            );
          } else {
            enqueueRemoteNotification(taskId, completionResult, 'completed', context.setAppState, task.toolUseId);
          }
          void evictTaskOutput(taskId);
          void removeRemoteAgentMetadata(taskId);
          runCompletionHook(taskId, task);
          return;
        }
      }

      // Ultraplan：result(success) 在每轮 CCR 之后都会触发，因此不能用于
      // 判定完成 —— 完成判定由 startDetachedPoll 通过 ExitPlanMode 扫描负责。
      // 长时运行的 monitor（autofix-pr）在每个通知周期都会发 result，
      // 因此同样跳过。
      const result =
        task.isUltraplan || task.isLongRunning ? undefined : accumulatedLog.findLast(msg => msg.type === 'result');

      // 对 remote-review：hook_progress stdout 中的 <remote-review> 是
      // bughunter 路径的完成信号。只扫描增量以保持 O(new)；
      // 标签在运行结束时只出现一次，跨 tick 不会漏掉。
      // 对失败信号：idle 需要去抖 —— 远程会话在每轮工具调用之间会短暂
      // 翻到 'idle'，单次 idle 观察并不能说明什么。要求连续
      // STABLE_IDLE_POLLS 次 idle 且日志无增长才认为是真的 idle。
      if (task.isRemoteReview && logGrew && cachedReviewContent === null) {
        cachedReviewContent = extractReviewTagFromLog(response.newEvents);
      }
      // 从 orchestrator 的心跳回显中解析实时进度计数。
      // hook_progress stdout 是累计的（从 hook 开始以来的每一次 echo），
      // 因此每个事件都包含所有进度标签。取最后一次出现 ——
      // extractTag 会返回第一个匹配，那就总是最早的值（0/0）。
      let newProgress: RemoteAgentTaskState['reviewProgress'];
      if (task.isRemoteReview && logGrew) {
        const open = `<${REMOTE_REVIEW_PROGRESS_TAG}>`;
        const close = `</${REMOTE_REVIEW_PROGRESS_TAG}>`;
        for (const ev of response.newEvents) {
          if (ev.type === 'system' && (ev.subtype === 'hook_progress' || ev.subtype === 'hook_response')) {
            const s = ev.stdout as string;
            const closeAt = s.lastIndexOf(close);
            const openAt = closeAt === -1 ? -1 : s.lastIndexOf(open, closeAt);
            if (openAt !== -1 && closeAt > openAt) {
              try {
                const p = JSON.parse(s.slice(openAt + open.length, closeAt)) as {
                  stage?: 'finding' | 'verifying' | 'synthesizing';
                  bugs_found?: number;
                  bugs_verified?: number;
                  bugs_refuted?: number;
                };
                newProgress = {
                  stage: p.stage,
                  bugsFound: p.bugs_found ?? 0,
                  bugsVerified: p.bugs_verified ?? 0,
                  bugsRefuted: p.bugs_refuted ?? 0,
                };
              } catch {
                // 忽略格式错误的进度
              }
            }
          }
        }
      }
      // 只有对 remote-review 才把 hook 事件算作输出 —— bughunter 的
      // SessionStart hook 不会产生任何 assistant 轮次，没有这一条
      // stableIdle 就永远无法进入。
      const hasAnyOutput = accumulatedLog.some(
        msg =>
          msg.type === 'assistant' ||
          (task.isRemoteReview &&
            msg.type === 'system' &&
            (msg.subtype === 'hook_progress' || msg.subtype === 'hook_response')),
      );
      if (response.sessionStatus === 'idle' && !logGrew && hasAnyOutput) {
        consecutiveIdlePolls++;
      } else {
        consecutiveIdlePolls = 0;
      }
      const stableIdle = consecutiveIdlePolls >= STABLE_IDLE_POLLS;
      // stableIdle 是 prompt 模式的完成信号（Claude 停止写入 → 会话 idle → 完成）。
      // 在 bughunter 模式下，SessionStart hook 运行期间会话一直处于「idle」；
      // 之前的守卫用 hasAssistantEvents 作为 prompt 模式的代理判断，
      // 但 post_stage() 现在在 bughunter 模式下也会写 assistant 事件，
      // 于是在两次心跳之间这个判断会误触发。是否存在 SessionStart hook 事件
      // 才是真正的判别条件 —— bughunter 模式总是有一个（run_hunt.sh），
      // prompt 模式从不出现 —— 而且它在 kickoff post_stage 之前就到达，
      // 没有竞态。当 hook 正在运行时，只有 <remote-review> 标签或
      // 30 分钟超时能让任务完成。
      // 通过 hook_event 过滤可以避免在 prompt 模式下（理论上的）非 SessionStart
      // hook 阻塞 stableIdle —— code_review 容器只注册 SessionStart，
      // 但 30 分钟挂起的失败模式还是值得防御一下。
      const hasSessionStartHook = accumulatedLog.some(
        m =>
          m.type === 'system' &&
          (m.subtype === 'hook_started' || m.subtype === 'hook_progress' || m.subtype === 'hook_response') &&
          (m as { hook_event?: string }).hook_event === 'SessionStart',
      );
      const hasAssistantEvents = accumulatedLog.some(m => m.type === 'assistant');
      const sessionDone =
        task.isRemoteReview &&
        (cachedReviewContent !== null || (!hasSessionStartHook && stableIdle && hasAssistantEvents));
      const reviewTimedOut = task.isRemoteReview && Date.now() - task.pollStartedAt > REMOTE_REVIEW_TIMEOUT_MS;
      const newStatus = result
        ? result.subtype === 'success'
          ? ('completed' as const)
          : ('failed' as const)
        : sessionDone || reviewTimedOut
          ? ('completed' as const)
          : accumulatedLog.length > 0
            ? ('running' as const)
            : ('starting' as const);

      // 更新任务状态。对 terminal 状态做守卫 —— 如果 stopTask 在
      // pollRemoteSessionEvents 飞行期间发生竞态（status 被设为 'killed'，
      // notified 被设为 true），直接返回，不覆盖状态，也不继续触发副作用
      // （通知、权限模式切换）。
      let raceTerminated = false;
      updateTaskState<RemoteAgentTaskState>(taskId, context.setAppState, prevTask => {
        if (prevTask.status !== 'running') {
          raceTerminated = true;
          return prevTask;
        }
        // 日志没有增长且状态未变化 → 没什么可上报的。返回同一个 ref，
        // 让 updateTaskState 跳过 spread，避免 18 个 s.tasks 订阅者
        // （REPL、Spinner、PromptInput……）发生重渲染。
        // newProgress 只会通过日志增长到来（心跳回显是 hook_progress
        // 事件），因此 !logGrew 已经涵盖了「无需更新」的场景。
        const statusUnchanged = newStatus === 'running' || newStatus === 'starting';
        if (!logGrew && statusUnchanged) {
          return prevTask;
        }
        return {
          ...prevTask,
          status: newStatus === 'starting' ? 'running' : newStatus,
          log: accumulatedLog,
          // 只有当日志增长时才重新扫描 TodoWrite —— 日志只追加，
          // 不增长就意味着没有新的 tool_use 块。避免在 idle 时每秒都
          // 执行 findLast + some + find + safeParse。
          todoList: logGrew ? extractTodoListFromLog(accumulatedLog) : prevTask.todoList,
          reviewProgress: newProgress ?? prevTask.reviewProgress,
          endTime: result || sessionDone || reviewTimedOut ? Date.now() : undefined,
        };
      });
      if (raceTerminated) return;

      // 任务完成或超时时发送通知
      if (result || sessionDone || reviewTimedOut) {
        const finalStatus = result && result.subtype !== 'success' ? 'failed' : 'completed';

        // 对 remote-review 任务：把 review 文本直接注入到消息队列。
        // 不改模式、不走文件中转 —— 本地模型只是在下一轮看到 review
        // 作为 task-notification 出现。会话保持存活 —— run_hunt.sh 的
        // post_stage() 已经把格式化后的发现写为 assistant 事件，因此
        // claude.ai URL 依旧是用户可回看的持久记录。清理由 TTL 负责。
        if (task.isRemoteReview) {
          // cachedReviewContent 在增量扫描中命中了标签。全量日志扫描
          // 负责处理 stableIdle 路径：标签可能在较早的 tick 到达，而那时
          // 增量扫描尚未启用（例如 resume 之后第一次轮询）。
          const reviewContent = cachedReviewContent ?? extractReviewFromLog(accumulatedLog);
          if (reviewContent && finalStatus === 'completed') {
            enqueueRemoteReviewNotification(taskId, reviewContent, context.setAppState);
            void evictTaskOutput(taskId);
            void removeRemoteAgentMetadata(taskId);
            runCompletionHook(taskId, task);
            return; // 停止轮询
          }

          // 没有输出或远程报错 —— 标记为 failed，并附上 review 专属的错误信息。
          updateTaskState(taskId, context.setAppState, t => ({
            ...t,
            status: 'failed',
          }));
          const reason =
            result && result.subtype !== 'success'
              ? 'remote session returned an error'
              : reviewTimedOut && !sessionDone
                ? 'remote session exceeded 30 minutes'
                : 'no review output — orchestrator may have exited early';
          enqueueRemoteReviewFailureNotification(taskId, reason, context.setAppState);
          void evictTaskOutput(taskId);
          void removeRemoteAgentMetadata(taskId);
          runCompletionHook(taskId, task);
          return; // 停止轮询
        }

        // 此路径上的 finalStatus 只会是 'completed' 或 'failed' ——
        // kill 走另一条代码路径（RemoteAgentTask.kill），不会走到这里。
        const richContent = tryExtractRichContent(task, accumulatedLog);
        if (richContent) {
          enqueueRichRemoteNotification(
            taskId,
            task.title,
            finalStatus,
            richContent,
            context.setAppState,
            task.toolUseId,
          );
        } else {
          enqueueRemoteNotification(taskId, task.title, finalStatus, context.setAppState, task.toolUseId);
        }
        void evictTaskOutput(taskId);
        void removeRemoteAgentMetadata(taskId);
        runCompletionHook(taskId, task);
        return; // 停止轮询
      }
    } catch (error) {
      logError(error);
      // 重置：避免一次 API 错误让原本不连续的 idle 计数累加。
      consecutiveIdlePolls = 0;

      // 即使 API 调用失败也要检查 review 超时 —— 否则持续的 API 错误
      // 会跳过超时检查，永远轮询下去。
      try {
        const appState = context.getAppState();
        const task = appState.tasks?.[taskId] as RemoteAgentTaskState | undefined;
        if (
          task?.isRemoteReview &&
          task.status === 'running' &&
          Date.now() - task.pollStartedAt > REMOTE_REVIEW_TIMEOUT_MS
        ) {
          updateTaskState(taskId, context.setAppState, t => ({
            ...t,
            status: 'failed',
            endTime: Date.now(),
          }));
          enqueueRemoteReviewFailureNotification(taskId, 'remote session exceeded 30 minutes', context.setAppState);
          void evictTaskOutput(taskId);
          void removeRemoteAgentMetadata(taskId);
          return; // 停止轮询
        }
      } catch {
        // 尽力而为 —— 如果 getAppState 失败，就继续轮询
      }
    }

    // 继续轮询
    if (isRunning) {
      setTimeout(poll, POLL_INTERVAL_MS);
    }
  };

  // 启动轮询
  void poll();

  // 返回 cleanup 函数
  return () => {
    isRunning = false;
  };
}

/**
 * RemoteAgentTask —— 处理远程 Claude.ai 会话的执行。
 *
 * 替代原本的 BackgroundRemoteSession 实现，这些实现位于：
 * - src/utils/background/remote/remoteSession.ts
 * - src/components/tasks/BackgroundTaskStatus.tsx（轮询逻辑）
 */
export const RemoteAgentTask: Task = {
  name: 'RemoteAgentTask',
  type: 'remote_agent',
  async kill(taskId, setAppState) {
    let toolUseId: string | undefined;
    let description: string | undefined;
    let sessionId: string | undefined;
    let killed = false;
    updateTaskState<RemoteAgentTaskState>(taskId, setAppState, task => {
      if (task.status !== 'running') {
        return task;
      }
      toolUseId = task.toolUseId;
      description = task.description;
      sessionId = task.sessionId;
      killed = true;
      return {
        ...task,
        status: 'killed',
        notified: true,
        endTime: Date.now(),
      };
    });

    // 为 SDK 消费者关闭 task_started 这一对儿事件的收尾。轮询循环在
    // status!=='running' 时提前返回，不会发通知。
    if (killed) {
      emitTaskTerminatedSdk(taskId, 'stopped', {
        toolUseId,
        summary: description,
      });
      // 归档远程会话，停止占用云资源。
      if (sessionId) {
        void archiveRemoteSession(sessionId).catch(e =>
          logForDebugging(`RemoteAgentTask archive failed: ${String(e)}`),
        );
      }
    }

    void evictTaskOutput(taskId);
    void removeRemoteAgentMetadata(taskId);
    logForDebugging(`RemoteAgentTask ${taskId} killed, archiving session ${sessionId ?? 'unknown'}`);
  },
};

/**
 * 获取远程任务的会话 URL。
 */
export function getRemoteTaskSessionUrl(sessionId: string): string {
  return getRemoteSessionUrl(sessionId, process.env.SESSION_INGRESS_URL);
}
