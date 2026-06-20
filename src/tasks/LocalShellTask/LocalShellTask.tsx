import { feature } from 'bun:bundle';
import { stat } from 'fs/promises';
import {
  OUTPUT_FILE_TAG,
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
  TOOL_USE_ID_TAG,
} from '../../constants/xml.js';
import { abortSpeculation } from '../../services/PromptSuggestion/speculation.js';
import type { AppState } from '../../state/AppState.js';
import type { LocalShellSpawnInput, SetAppState, Task, TaskContext, TaskHandle } from '../../Task.js';
import { createTaskStateBase } from '../../Task.js';
import type { AgentId } from '../../types/ids.js';
import { registerCleanup } from '../../utils/cleanupRegistry.js';
import { tailFile } from '../../utils/fsOperations.js';
import { logError } from '../../utils/log.js';
import { enqueuePendingNotification } from '../../utils/messageQueueManager.js';
import type { ShellCommand } from '../../utils/ShellCommand.js';
import { evictTaskOutput, getTaskOutputPath } from '../../utils/task/diskOutput.js';
import { registerTask, updateTaskState } from '../../utils/task/framework.js';
import { escapeXml } from '../../utils/xml.js';
import { backgroundAgentTask, isLocalAgentTask } from '../LocalAgentTask/LocalAgentTask.js';
import { isMainSessionTask } from '../LocalMainSessionTask.js';
import { type BashTaskKind, isLocalShellTask, type LocalShellTaskState } from './guards.js';
import { killTask } from './killShellTasks.js';

/** 前缀，用于让 UI 折叠变换识别 LocalShellTask 摘要。 */
export const BACKGROUND_BASH_SUMMARY_PREFIX = 'Background command ';

const STALL_CHECK_INTERVAL_MS = 5_000;
const STALL_THRESHOLD_MS = 45_000;
const STALL_TAIL_BYTES = 1024;

// 一些「最后一行」模式，用来判断命令是否因等待键盘输入而阻塞。
// 用于门控 stall 通知 —— 对于仅仅执行缓慢的命令（git log -S、长构建）
// 保持静默，只有当末尾看起来像模型可以采取行动的交互式提示时才通知。
// 参见 CC-1175。
const PROMPT_PATTERNS = [
  /\(y\/n\)/i, // (Y/n)、(y/N)
  /\[y\/n\]/i, // [Y/n]、[y/N]
  /\(yes\/no\)/i,
  /\b(?:Do you|Would you|Shall I|Are you sure|Ready to)\b.*\? *$/i, // 直接提问句
  /Press (any key|Enter)/i,
  /Continue\?/i,
  /Overwrite\?/i,
];

export function looksLikePrompt(tail: string): boolean {
  const lastLine = tail.trimEnd().split('\n').pop() ?? '';
  return PROMPT_PATTERNS.some(p => p.test(lastLine));
}

// peekForStdinData（utils/process.ts）的输出端对应实现：当输出停止增长
// 且末尾看起来像交互式提示时，触发一次性通知。
function startStallWatchdog(
  taskId: string,
  description: string,
  kind: BashTaskKind | undefined,
  toolUseId?: string,
  agentId?: AgentId,
): () => void {
  if (kind === 'monitor') return () => {};
  const outputPath = getTaskOutputPath(taskId);
  let lastSize = 0;
  let lastGrowth = Date.now();
  let cancelled = false;

  const timer = setInterval(() => {
    void stat(outputPath).then(
      s => {
        if (s.size > lastSize) {
          lastSize = s.size;
          lastGrowth = Date.now();
          return;
        }
        if (Date.now() - lastGrowth < STALL_THRESHOLD_MS) return;
        void tailFile(outputPath, STALL_TAIL_BYTES).then(
          ({ content }) => {
            if (cancelled) return;
            if (!looksLikePrompt(content)) {
              // 不是提示 —— 继续观察。重置时间，让下一次检查仍距现在
              // 45 秒，而不是每个 tick 都重新读取末尾。
              lastGrowth = Date.now();
              return;
            }
            // 在跨越异步边界产生可见副作用之前先 latch，确保重叠 tick 的回调
            // 能看到 cancelled=true 并退出。
            cancelled = true;
            clearInterval(timer);
            const toolUseIdLine = toolUseId ? `\n<${TOOL_USE_ID_TAG}>${toolUseId}</${TOOL_USE_ID_TAG}>` : '';
            const summary = `${BACKGROUND_BASH_SUMMARY_PREFIX}"${description}" appears to be waiting for interactive input`;
            // 不带 <status> 标签 —— print.ts 会把 <status> 当作终止信号，
            // 若是未知值就会落到 'completed'，错误地为 SDK 消费者关闭任务。
            // 不带 status 的通知会被 SDK 发射器跳过（视为进度 ping）。
            const message = `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${taskId}</${TASK_ID_TAG}>${toolUseIdLine}
<${OUTPUT_FILE_TAG}>${outputPath}</${OUTPUT_FILE_TAG}>
<${SUMMARY_TAG}>${escapeXml(summary)}</${SUMMARY_TAG}>
</${TASK_NOTIFICATION_TAG}>
Last output:
${content.trimEnd()}

The command is likely blocked on an interactive prompt. Kill this task and re-run with piped input (e.g., \`echo y | command\`) or a non-interactive flag if one exists.`;
            enqueuePendingNotification({
              value: message,
              mode: 'task-notification',
              priority: 'next',
              agentId,
            });
          },
          () => {},
        );
      },
      () => {}, // 文件可能还不存在
    );
  }, STALL_CHECK_INTERVAL_MS);
  timer.unref();

  return () => {
    cancelled = true;
    clearInterval(timer);
  };
}

function enqueueShellNotification(
  taskId: string,
  description: string,
  status: 'completed' | 'failed' | 'killed',
  exitCode: number | undefined,
  setAppState: SetAppState,
  toolUseId?: string,
  kind: BashTaskKind = 'bash',
  agentId?: AgentId,
): void {
  // 原子地检查并设置 notified 标志，防止重复通知。
  // 如果任务已经被标记为 notified（例如被 TaskStopTool 设置过），则跳过
  // 入队，避免向模型发送冗余消息。
  let shouldEnqueue = false;
  updateTaskState(taskId, setAppState, task => {
    if (task.notified) {
      return task;
    }
    shouldEnqueue = true;
    return { ...task, notified: true };
  });

  if (!shouldEnqueue) {
    return;
  }

  // 中止任何活跃的 speculation —— 后台任务状态已变化，speculation 的
  // 结果可能引用过期的任务输出。prompt 建议文本会保留；
  // 仅丢弃预先计算的响应。
  abortSpeculation(setAppState);

  let summary: string;
  if (feature('MONITOR_TOOL') && kind === 'monitor') {
    // Monitor 是纯流式的（#22764 之后）—— 脚本退出只意味着
    // 流结束，而不是「条件达成」。与 bash 前缀区别开来，避免 Monitor
    // 完成时被折叠进「N background commands completed」中。
    switch (status) {
      case 'completed':
        summary = `Monitor "${description}" stream ended`;
        break;
      case 'failed':
        summary = `Monitor "${description}" script failed${exitCode !== undefined ? ` (exit ${exitCode})` : ''}`;
        break;
      case 'killed':
        summary = `Monitor "${description}" stopped`;
        break;
    }
  } else {
    switch (status) {
      case 'completed':
        summary = `${BACKGROUND_BASH_SUMMARY_PREFIX}"${description}" completed${exitCode !== undefined ? ` (exit code ${exitCode})` : ''}`;
        break;
      case 'failed':
        summary = `${BACKGROUND_BASH_SUMMARY_PREFIX}"${description}" failed${exitCode !== undefined ? ` with exit code ${exitCode}` : ''}`;
        break;
      case 'killed':
        summary = `${BACKGROUND_BASH_SUMMARY_PREFIX}"${description}" was stopped`;
        break;
    }
  }

  const outputPath = getTaskOutputPath(taskId);
  const toolUseIdLine = toolUseId ? `\n<${TOOL_USE_ID_TAG}>${toolUseId}</${TOOL_USE_ID_TAG}>` : '';
  const message = `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${taskId}</${TASK_ID_TAG}>${toolUseIdLine}
<${OUTPUT_FILE_TAG}>${outputPath}</${OUTPUT_FILE_TAG}>
<${STATUS_TAG}>${status}</${STATUS_TAG}>
<${SUMMARY_TAG}>${escapeXml(summary)}</${SUMMARY_TAG}>
</${TASK_NOTIFICATION_TAG}>`;

  enqueuePendingNotification({
    value: message,
    mode: 'task-notification',
    priority: feature('MONITOR_TOOL') ? 'next' : 'later',
    agentId,
  });
}

export const LocalShellTask: Task = {
  name: 'LocalShellTask',
  type: 'local_bash',
  async kill(taskId, setAppState) {
    killTask(taskId, setAppState);
  },
};

export async function spawnShellTask(
  input: LocalShellSpawnInput & { shellCommand: ShellCommand },
  context: TaskContext,
): Promise<TaskHandle> {
  const { command, description, shellCommand, toolUseId, agentId, kind } = input;
  const { setAppState } = context;

  // TaskOutput 才是数据的真正持有者 —— 使用它的 taskId 以保证磁盘写入一致
  const { taskOutput } = shellCommand;
  const taskId = taskOutput.taskId;

  const unregisterCleanup = registerCleanup(async () => {
    killTask(taskId, setAppState);
  });

  const taskState: LocalShellTaskState = {
    ...createTaskStateBase(taskId, 'local_bash', description, toolUseId),
    type: 'local_bash',
    status: 'running',
    command,
    completionStatusSentInAttachment: false,
    shellCommand,
    unregisterCleanup,
    lastReportedTotalLines: 0,
    isBackgrounded: true,
    agentId,
    kind,
  };

  registerTask(taskState, setAppState);

  // 数据通过 TaskOutput 自动流转 —— 不需要 stream 监听。
  // 只需切换到后台化状态，进程就会继续运行。
  shellCommand.background(taskId);

  const cancelStallWatchdog = startStallWatchdog(taskId, description, kind, toolUseId, agentId);

  void shellCommand.result.then(async result => {
    cancelStallWatchdog();
    await flushAndCleanup(shellCommand);
    let wasKilled = false;

    updateTaskState<LocalShellTaskState>(taskId, setAppState, task => {
      if (task.status === 'killed') {
        wasKilled = true;
        return task;
      }

      return {
        ...task,
        status: result.code === 0 ? 'completed' : 'failed',
        result: { code: result.code, interrupted: result.interrupted },
        shellCommand: null,
        unregisterCleanup: undefined,
        endTime: Date.now(),
      };
    });

    enqueueShellNotification(
      taskId,
      description,
      wasKilled ? 'killed' : result.code === 0 ? 'completed' : 'failed',
      result.code,
      setAppState,
      toolUseId,
      kind,
      agentId,
    );

    void evictTaskOutput(taskId);
  });

  return {
    taskId,
    cleanup: () => {
      unregisterCleanup();
    },
  };
}

/**
 * 注册一个稍后可能被后台化的前台任务。
 * 当某个 bash 命令运行时间足够长、足以展示 BackgroundHint 时调用。
 * @returns 已注册任务的 taskId
 */
export function registerForeground(
  input: LocalShellSpawnInput & { shellCommand: ShellCommand },
  setAppState: SetAppState,
  toolUseId?: string,
): string {
  const { command, description, shellCommand, agentId } = input;

  const taskId = shellCommand.taskOutput.taskId;

  const unregisterCleanup = registerCleanup(async () => {
    killTask(taskId, setAppState);
  });

  const taskState: LocalShellTaskState = {
    ...createTaskStateBase(taskId, 'local_bash', description, toolUseId),
    type: 'local_bash',
    status: 'running',
    command,
    completionStatusSentInAttachment: false,
    shellCommand,
    unregisterCleanup,
    lastReportedTotalLines: 0,
    isBackgrounded: false, // 尚未后台化 —— 前台运行中
    agentId,
  };

  registerTask(taskState, setAppState);
  return taskId;
}

/**
 * 将指定前台任务后台化。
 * @returns 成功后台化返回 true，否则返回 false
 */
function backgroundTask(taskId: string, getAppState: () => AppState, setAppState: SetAppState): boolean {
  // 步骤 1：从当前状态取出任务和 shell 命令
  const state = getAppState();
  const task = state.tasks[taskId];
  if (!isLocalShellTask(task) || task.isBackgrounded || !task.shellCommand) {
    return false;
  }

  const shellCommand = task.shellCommand;
  const description = task.description;
  const { toolUseId, kind, agentId } = task;

  // 切换到后台化 —— TaskOutput 会自动继续接收数据
  if (!shellCommand.background(taskId)) {
    return false;
  }

  setAppState(prev => {
    const prevTask = prev.tasks[taskId];
    if (!isLocalShellTask(prevTask) || prevTask.isBackgrounded) {
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

  const cancelStallWatchdog = startStallWatchdog(taskId, description, kind, toolUseId, agentId);

  // 设置结果处理器
  void shellCommand.result.then(async result => {
    cancelStallWatchdog();
    await flushAndCleanup(shellCommand);
    let wasKilled = false;
    let cleanupFn: (() => void) | undefined;

    updateTaskState<LocalShellTaskState>(taskId, setAppState, t => {
      if (t.status === 'killed') {
        wasKilled = true;
        return t;
      }

      // 捕获 cleanup 函数，以便在 updater 之外调用
      cleanupFn = t.unregisterCleanup;

      return {
        ...t,
        status: result.code === 0 ? 'completed' : 'failed',
        result: { code: result.code, interrupted: result.interrupted },
        shellCommand: null,
        unregisterCleanup: undefined,
        endTime: Date.now(),
      };
    });

    // 在状态 updater 之外调用 cleanup（避免在 updater 中产生副作用）
    cleanupFn?.();

    if (wasKilled) {
      enqueueShellNotification(taskId, description, 'killed', result.code, setAppState, toolUseId, kind, agentId);
    } else {
      const finalStatus = result.code === 0 ? 'completed' : 'failed';
      enqueueShellNotification(taskId, description, finalStatus, result.code, setAppState, toolUseId, kind, agentId);
    }

    void evictTaskOutput(taskId);
  });

  return true;
}

/**
 * 将所有前台任务（bash 命令和 agent）后台化。
 * 当用户按 Ctrl+B 后台化所有运行中的任务时调用。
 */
/**
 * 检查是否有任何前台任务（bash 或 agent）可以被后台化。
 * 用于判断 Ctrl+B 应当后台化现有任务，还是后台化整个会话。
 */
export function hasForegroundTasks(state: AppState): boolean {
  return Object.values(state.tasks).some(task => {
    if (isLocalShellTask(task) && !task.isBackgrounded && task.shellCommand) {
      return true;
    }
    // 排除 main session 任务 —— 它们显示在主视图中，而不是作为前台任务
    if (isLocalAgentTask(task) && !task.isBackgrounded && !isMainSessionTask(task)) {
      return true;
    }
    return false;
  });
}

export function backgroundAll(getAppState: () => AppState, setAppState: SetAppState): void {
  const state = getAppState();

  // 后台化所有前台的 bash 任务
  const foregroundBashTaskIds = Object.keys(state.tasks).filter(id => {
    const task = state.tasks[id];
    return isLocalShellTask(task) && !task.isBackgrounded && task.shellCommand;
  });
  for (const taskId of foregroundBashTaskIds) {
    backgroundTask(taskId, getAppState, setAppState);
  }

  // 后台化所有前台的 agent 任务
  const foregroundAgentTaskIds = Object.keys(state.tasks).filter(id => {
    const task = state.tasks[id];
    return isLocalAgentTask(task) && !task.isBackgrounded;
  });
  for (const taskId of foregroundAgentTaskIds) {
    backgroundAgentTask(taskId, getAppState, setAppState);
  }
}

/**
 * 将已注册的前台任务原地后台化。
 * 与 spawn() 不同，它不会重新注册任务 —— 而是在已存在的注册项上翻转
 * isBackgrounded，并设置完成处理器。
 * 当自动后台化定时器在 registerForeground() 已经注册了任务之后触发时使用
 * （避免产生重复的 task_started SDK 事件和泄漏的 cleanup 回调）。
 */
export function backgroundExistingForegroundTask(
  taskId: string,
  shellCommand: ShellCommand,
  description: string,
  setAppState: SetAppState,
  toolUseId?: string,
): boolean {
  if (!shellCommand.background(taskId)) {
    return false;
  }

  let agentId: AgentId | undefined;
  setAppState(prev => {
    const prevTask = prev.tasks[taskId];
    if (!isLocalShellTask(prevTask) || prevTask.isBackgrounded) {
      return prev;
    }
    agentId = prevTask.agentId;
    return {
      ...prev,
      tasks: {
        ...prev.tasks,
        [taskId]: { ...prevTask, isBackgrounded: true },
      },
    };
  });

  const cancelStallWatchdog = startStallWatchdog(taskId, description, undefined, toolUseId, agentId);

  // 设置结果处理器（与 backgroundTask 的处理器对应）
  void shellCommand.result.then(async result => {
    cancelStallWatchdog();
    await flushAndCleanup(shellCommand);
    let wasKilled = false;
    let cleanupFn: (() => void) | undefined;

    updateTaskState<LocalShellTaskState>(taskId, setAppState, t => {
      if (t.status === 'killed') {
        wasKilled = true;
        return t;
      }
      cleanupFn = t.unregisterCleanup;
      return {
        ...t,
        status: result.code === 0 ? 'completed' : 'failed',
        result: { code: result.code, interrupted: result.interrupted },
        shellCommand: null,
        unregisterCleanup: undefined,
        endTime: Date.now(),
      };
    });

    cleanupFn?.();

    const finalStatus = wasKilled ? 'killed' : result.code === 0 ? 'completed' : 'failed';
    enqueueShellNotification(taskId, description, finalStatus, result.code, setAppState, toolUseId, undefined, agentId);

    void evictTaskOutput(taskId);
  });

  return true;
}

/**
 * 将任务标记为已通知，以抑制待处理的 enqueueShellNotification。
 * 用于后台化与完成发生竞态的场景 —— 工具结果中已经包含了完整输出，
 * 此时 <task_notification> 就是冗余的。
 */
export function markTaskNotified(taskId: string, setAppState: SetAppState): void {
  updateTaskState(taskId, setAppState, t => (t.notified ? t : { ...t, notified: true }));
}

/**
 * 当命令在未被后台化的情况下完成时，注销相应的前台任务。
 */
export function unregisterForeground(taskId: string, setAppState: SetAppState): void {
  let cleanupFn: (() => void) | undefined;

  setAppState(prev => {
    const task = prev.tasks[taskId];
    // 仅当是前台任务（未后台化）时才移除
    if (!isLocalShellTask(task) || task.isBackgrounded) {
      return prev;
    }

    // 捕获 cleanup 函数，以便在 updater 之外调用
    cleanupFn = task.unregisterCleanup;

    const { [taskId]: removed, ...rest } = prev.tasks;
    return { ...prev, tasks: rest };
  });

  // 在 state updater 之外调用 cleanup（避免在 updater 中产生副作用）
  cleanupFn?.();
}

async function flushAndCleanup(shellCommand: ShellCommand): Promise<void> {
  try {
    await shellCommand.taskOutput.flush();
    shellCommand.cleanup();
  } catch (error) {
    logError(error);
  }
}
