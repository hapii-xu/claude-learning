/**
 * 跨不同 task 类型显示任务状态的共享工具函数。
 */

import figures from 'figures';
import type { TaskStatus } from 'src/Task.js';
import type { InProcessTeammateTaskState } from 'src/tasks/InProcessTeammateTask/types.js';
import { isPanelAgentTask } from 'src/tasks/LocalAgentTask/LocalAgentTask.js';
import { isBackgroundTask, type TaskState } from 'src/tasks/types.js';
import type { DeepImmutable } from 'src/types/utils.js';
import { summarizeRecentActivities } from 'src/utils/collapseReadSearch.js';

/**
 * 如果给定 task 状态表示终态（已结束），则返回 true。
 */
export function isTerminalStatus(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed';
}

/**
 * 根据 status 和 state flag 返回任务对应的图标。
 */
export function getTaskStatusIcon(
  status: TaskStatus,
  options?: {
    isIdle?: boolean;
    awaitingApproval?: boolean;
    hasError?: boolean;
    shutdownRequested?: boolean;
  },
): string {
  const { isIdle, awaitingApproval, hasError, shutdownRequested } = options ?? {};

  if (hasError) return figures.cross;
  if (awaitingApproval) return figures.questionMarkPrefix;
  if (shutdownRequested) return figures.warning;

  if (status === 'running') {
    if (isIdle) return figures.ellipsis;
    return figures.play;
  }
  if (status === 'completed') return figures.tick;
  if (status === 'failed' || status === 'killed') return figures.cross;
  return figures.bullet;
}

/**
 * 根据 status 和 state flag 返回任务对应的语义颜色。
 */
export function getTaskStatusColor(
  status: TaskStatus,
  options?: {
    isIdle?: boolean;
    awaitingApproval?: boolean;
    hasError?: boolean;
    shutdownRequested?: boolean;
  },
): 'success' | 'error' | 'warning' | 'background' {
  const { isIdle, awaitingApproval, hasError, shutdownRequested } = options ?? {};

  if (hasError) return 'error';
  if (awaitingApproval) return 'warning';
  if (shutdownRequested) return 'warning';
  if (isIdle) return 'background';

  if (status === 'completed') return 'success';
  if (status === 'failed') return 'error';
  if (status === 'killed') return 'warning';
  return 'background';
}

/**
 * 为 in-process teammate 派生一个人类可读的活动字符串，
 * 处理 shutdown/approval/idle 状态，并按以下顺序回退：
 * 近期活动摘要 → 上一条活动描述 → 'working'。
 */
export function describeTeammateActivity(t: DeepImmutable<InProcessTeammateTaskState>): string {
  if (t.shutdownRequested) return 'stopping';
  if (t.awaitingPlanApproval) return 'awaiting approval';
  if (t.isIdle) return 'idle';
  return (
    (t.progress?.recentActivities && summarizeRecentActivities(t.progress.recentActivities)) ??
    t.progress?.lastActivity?.activityDescription ??
    'working'
  );
}

/**
 * 当 BackgroundTaskStatus 不会渲染任何内容时返回 true：spinner tree 处于激活状态
 * 且每个可见的后台 task 都是 in-process teammate（teammate 显示在 spinner tree 中）。
 *
 * 使用与 BackgroundTaskStatus 相同的 task 过滤：`isBackgroundTask()`
 * 加上对 ant 的 panel 托管 agent task 的排除（那些由
 * CoordinatorTaskPanel 展示）。
 */
export function shouldHideTasksFooter(tasks: { [taskId: string]: TaskState }, showSpinnerTree: boolean): boolean {
  if (!showSpinnerTree) return false;
  let hasVisibleTask = false;
  for (const t of Object.values(tasks) as TaskState[]) {
    if (!isBackgroundTask(t) || (process.env.USER_TYPE === 'ant' && isPanelAgentTask(t))) {
      continue;
    }
    hasVisibleTask = true;
    if (t.type !== 'in_process_teammate') return false;
  }
  return hasVisibleTask;
}
