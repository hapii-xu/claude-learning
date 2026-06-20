/**
 * InProcessTeammateTask —— 管理进程内 teammate 的生命周期
 *
 * 此组件为进程内 teammate 实现了 Task 接口。
 * 与 LocalAgentTask（后台 agent）不同，进程内 teammate：
 * 1. 在同一个 Node.js 进程中运行，通过 AsyncLocalStorage 进行隔离
 * 2. 拥有团队感知的身份（agentName@teamName）
 * 3. 支持 plan mode 审批流程
 * 4. 可以处于 idle（等待任务）或 active（正在处理）状态
 */

import { isTerminalTaskStatus, type SetAppState, type Task, type TaskStateBase } from '../../Task.js';
import type { Message, MessageOrigin } from '../../types/message.js';
import { logForDebugging } from '../../utils/debug.js';
import { createUserMessage } from '../../utils/messages.js';
import { killInProcessTeammate } from '../../utils/swarm/spawnInProcess.js';
import { updateTaskState } from '../../utils/task/framework.js';
import type { InProcessTeammateTaskState, PendingTeammateUserMessage } from './types.js';
import { appendCappedMessage, isInProcessTeammateTask } from './types.js';

/**
 * InProcessTeammateTask —— 负责进程内 teammate 的执行。
 */
export const InProcessTeammateTask: Task = {
  name: 'InProcessTeammateTask',
  type: 'in_process_teammate',
  async kill(taskId, setAppState) {
    killInProcessTeammate(taskId, setAppState);
  },
};

/**
 * 请求关闭某个 teammate。
 */
export function requestTeammateShutdown(taskId: string, setAppState: SetAppState): void {
  updateTaskState<InProcessTeammateTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running' || task.shutdownRequested) {
      return task;
    }

    return {
      ...task,
      shutdownRequested: true,
    };
  });
}

/**
 * 在某个 teammate 的对话历史中追加消息。
 * 用于在 zoomed view 中展示该 teammate 的对话。
 */
export function appendTeammateMessage(taskId: string, message: Message, setAppState: SetAppState): void {
  updateTaskState<InProcessTeammateTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') {
      return task;
    }

    return {
      ...task,
      messages: appendCappedMessage(task.messages, message),
    };
  });
}

/**
 * 将一条用户消息注入到 teammate 的待处理队列中。
 * 用于在查看某个 teammate 的对话时向其发送输入的消息。
 * 同时会把消息加入 task.messages，使其立即出现在对话记录中。
 */
export function injectUserMessageToTeammate(
  taskId: string,
  message: string,
  options:
    | {
        autonomyRunId?: string;
        autonomyRootDir?: string;
        origin?: MessageOrigin;
      }
    | undefined,
  setAppState: SetAppState,
): boolean {
  let injected = false;
  updateTaskState<InProcessTeammateTaskState>(taskId, setAppState, task => {
    // teammate 处于 running 或 idle（等待输入）时都允许注入消息
    // 只有在 terminal 状态下才会拒绝
    if (isTerminalTaskStatus(task.status)) {
      logForDebugging(`Dropping message for teammate task ${taskId}: task status is "${task.status}"`);
      return task;
    }

    injected = true;

    const pendingMessage: PendingTeammateUserMessage = { message };
    if (options?.autonomyRunId !== undefined) {
      pendingMessage.autonomyRunId = options.autonomyRunId;
    }
    if (options?.autonomyRootDir !== undefined) {
      pendingMessage.autonomyRootDir = options.autonomyRootDir;
    }
    if (options?.origin !== undefined) {
      pendingMessage.origin = options.origin;
    }

    const userMessageArgs: Parameters<typeof createUserMessage>[0] = {
      content: message,
    };
    if (options?.origin !== undefined) {
      userMessageArgs.origin = options.origin;
    }

    return {
      ...task,
      pendingUserMessages: [...task.pendingUserMessages, pendingMessage],
      messages: appendCappedMessage(task.messages, createUserMessage(userMessageArgs)),
    };
  });
  return injected;
}

/**
 * 根据 AppState 中的 agent ID 查找 teammate 任务。
 * 如果同一个 agentId 对应多个任务，优先返回 running 的任务，
 * 而不是 killed/completed 的。
 * 未找到时返回 undefined。
 */
export function findTeammateTaskByAgentId(
  agentId: string,
  tasks: Record<string, TaskStateBase>,
): InProcessTeammateTaskState | undefined {
  let fallback: InProcessTeammateTaskState | undefined;
  for (const task of Object.values(tasks)) {
    if (isInProcessTeammateTask(task) && task.identity.agentId === agentId) {
      // 优先返回 running 的任务，因为 AppState 中可能同时存在旧的
      // killed 任务与新的、使用相同 agentId 的 running 任务
      if (task.status === 'running') {
        return task;
      }
      // 保留第一个匹配项作为兜底，以防没有 running 任务
      if (!fallback) {
        fallback = task;
      }
    }
  }
  return fallback;
}

/**
 * 从 AppState 中获取所有进程内 teammate 任务。
 */
export function getAllInProcessTeammateTasks(tasks: Record<string, TaskStateBase>): InProcessTeammateTaskState[] {
  return Object.values(tasks).filter(isInProcessTeammateTask);
}

/**
 * 获取所有 running 的进程内 teammate，按 agentName 字母序排序。
 * TeammateSpinnerTree 展示、PromptInput 底部选择器、useBackgroundTaskNavigation
 * 三处共用 —— selectedIPAgentIndex 会映射到这个数组，因此三处对排序必须保持一致。
 */
export function getRunningTeammatesSorted(tasks: Record<string, TaskStateBase>): InProcessTeammateTaskState[] {
  return getAllInProcessTeammateTasks(tasks)
    .filter(t => t.status === 'running')
    .sort((a, b) => a.identity.agentName.localeCompare(b.identity.agentName));
}
