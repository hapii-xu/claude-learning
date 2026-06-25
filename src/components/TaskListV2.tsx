import figures from 'figures';
import * as React from 'react';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { Box, Text, stringWidth } from '@anthropic/ink';
import { useAppState } from '../state/AppState.js';
import { isInProcessTeammateTask } from '../tasks/InProcessTeammateTask/types.js';
import {
  AGENT_COLOR_TO_THEME_COLOR,
  type AgentColorName,
} from '@claude-code-best/builtin-tools/tools/AgentTool/agentColorManager.js';
import { isAgentSwarmsEnabled } from '../utils/agentSwarmsEnabled.js';
import { count } from '../utils/array.js';
import { summarizeRecentActivities } from '../utils/collapseReadSearch.js';
import { truncateToWidth } from '../utils/format.js';
import { isTodoV2Enabled, type Task } from '../utils/tasks.js';
import type { Theme } from '../utils/theme.js';
import ThemedText from './design-system/ThemedText.js';

type Props = {
  tasks: Task[];
  isStandalone?: boolean;
};

const RECENT_COMPLETED_TTL_MS = 30_000;

function byIdAsc(a: Task, b: Task): number {
  const aNum = parseInt(a.id, 10);
  const bNum = parseInt(b.id, 10);
  if (!isNaN(aNum) && !isNaN(bNum)) {
    return aNum - bNum;
  }
  return a.id.localeCompare(b.id);
}

export function TaskListV2({ tasks, isStandalone = false }: Props): React.ReactNode {
  const teamContext = useAppState(s => s.teamContext);
  const appStateTasks = useAppState(s => s.tasks);
  const [, forceUpdate] = React.useState(0);
  const { rows, columns } = useTerminalSize();

  // 跟踪每个任务最后一次被观察到变为 completed 的时间
  const completionTimestampsRef = React.useRef(new Map<string, number>());
  const previousCompletedIdsRef = React.useRef<Set<string> | null>(null);
  if (previousCompletedIdsRef.current === null) {
    previousCompletedIdsRef.current = new Set(tasks.filter(t => t.status === 'completed').map(t => t.id));
  }
  const maxDisplay = rows <= 10 ? 0 : Math.min(10, Math.max(3, rows - 14));

  // 更新 completion timestamps：当任务变为 completed 时重置
  const currentCompletedIds = new Set(tasks.filter(t => t.status === 'completed').map(t => t.id));
  const now = Date.now();
  for (const id of currentCompletedIds) {
    if (!previousCompletedIdsRef.current.has(id)) {
      completionTimestampsRef.current.set(id, now);
    }
  }
  for (const id of completionTimestampsRef.current.keys()) {
    if (!currentCompletedIds.has(id)) {
      completionTimestampsRef.current.delete(id);
    }
  }
  previousCompletedIdsRef.current = currentCompletedIds;

  // 在下一次最近的 completion 过期时调度重新渲染。
  // 依赖 `tasks`，这样 timer 只在任务列表变化时重置，
  // 而不是在每次渲染时都重置（这会造成不必要的开销）。
  React.useEffect(() => {
    if (completionTimestampsRef.current.size === 0) {
      return;
    }
    const currentNow = Date.now();
    let earliestExpiry = Infinity;
    for (const ts of completionTimestampsRef.current.values()) {
      const expiry = ts + RECENT_COMPLETED_TTL_MS;
      if (expiry > currentNow && expiry < earliestExpiry) {
        earliestExpiry = expiry;
      }
    }
    if (earliestExpiry === Infinity) {
      return;
    }
    const timer = setTimeout(
      forceUpdate => forceUpdate((n: number) => n + 1),
      earliestExpiry - currentNow,
      forceUpdate,
    );
    return () => clearTimeout(timer);
  }, [tasks]);

  if (!isTodoV2Enabled()) {
    return null;
  }

  if (tasks.length === 0) {
    return null;
  }

  // 构建 teammate name -> theme color 的映射
  const teammateColors: Record<string, keyof Theme> = {};
  if (isAgentSwarmsEnabled() && teamContext?.teammates) {
    for (const teammate of Object.values(teamContext.teammates)) {
      if (teammate.color) {
        const themeColor = AGENT_COLOR_TO_THEME_COLOR[teammate.color as AgentColorName];
        if (themeColor) {
          teammateColors[teammate.name] = themeColor;
        }
      }
    }
  }

  // 构建 teammate name -> 当前活动描述的映射
  // 同时映射 agentName（"researcher"）和 agentId（"researcher@team"），这样
  // 无论 model 使用哪种格式，task owner 都能匹配上。
  // 将连续的 search/read tool 调用合并为紧凑的摘要。
  // 同时跟踪哪些 teammates 仍在运行（未关闭）。
  const teammateActivity: Record<string, string> = {};
  const activeTeammates = new Set<string>();
  if (isAgentSwarmsEnabled()) {
    for (const bgTask of Object.values(appStateTasks)) {
      if (isInProcessTeammateTask(bgTask) && bgTask.status === 'running') {
        activeTeammates.add(bgTask.identity.agentName);
        activeTeammates.add(bgTask.identity.agentId);
        const activities = bgTask.progress?.recentActivities;
        const desc =
          (activities && summarizeRecentActivities(activities)) ?? bgTask.progress?.lastActivity?.activityDescription;
        if (desc) {
          teammateActivity[bgTask.identity.agentName] = desc;
          teammateActivity[bgTask.identity.agentId] = desc;
        }
      }
    }
  }

  // 获取用于显示的任务计数
  const completedCount = count(tasks, t => t.status === 'completed');
  const pendingCount = count(tasks, t => t.status === 'pending');
  const inProgressCount = tasks.length - completedCount - pendingCount;
  // 未完成的任务（open 或 in_progress）会阻塞依赖它们的任务
  const unresolvedTaskIds = new Set(tasks.filter(t => t.status !== 'completed').map(t => t.id));

  // 检查是否需要截断
  const needsTruncation = tasks.length > maxDisplay;

  let visibleTasks: Task[];
  let hiddenTasks: Task[];

  if (needsTruncation) {
    // 优先级：最近完成的（30 秒内）、进行中、待处理、更早完成的
    const recentCompleted: Task[] = [];
    const olderCompleted: Task[] = [];
    for (const task of tasks.filter(t => t.status === 'completed')) {
      const ts = completionTimestampsRef.current.get(task.id);
      if (ts && now - ts < RECENT_COMPLETED_TTL_MS) {
        recentCompleted.push(task);
      } else {
        olderCompleted.push(task);
      }
    }
    recentCompleted.sort(byIdAsc);
    olderCompleted.sort(byIdAsc);
    const inProgress = tasks.filter(t => t.status === 'in_progress').sort(byIdAsc);
    const pending = tasks
      .filter(t => t.status === 'pending')
      .sort((a, b) => {
        const aBlocked = a.blockedBy.some(id => unresolvedTaskIds.has(id));
        const bBlocked = b.blockedBy.some(id => unresolvedTaskIds.has(id));
        if (aBlocked !== bBlocked) {
          return aBlocked ? 1 : -1;
        }
        return byIdAsc(a, b);
      });

    const prioritized = [...recentCompleted, ...inProgress, ...pending, ...olderCompleted];
    visibleTasks = prioritized.slice(0, maxDisplay);
    hiddenTasks = prioritized.slice(maxDisplay);
  } else {
    // 不需要截断 —— 按 ID 排序以获得稳定的顺序
    visibleTasks = [...tasks].sort(byIdAsc);
    hiddenTasks = [];
  }

  let hiddenSummary = '';
  if (hiddenTasks.length > 0) {
    const parts: string[] = [];
    const hiddenPending = count(hiddenTasks, t => t.status === 'pending');
    const hiddenInProgress = count(hiddenTasks, t => t.status === 'in_progress');
    const hiddenCompleted = count(hiddenTasks, t => t.status === 'completed');
    if (hiddenInProgress > 0) {
      parts.push(`${hiddenInProgress} 个进行中`);
    }
    if (hiddenPending > 0) {
      parts.push(`${hiddenPending} 个待处理`);
    }
    if (hiddenCompleted > 0) {
      parts.push(`${hiddenCompleted} 个已完成`);
    }
    hiddenSummary = ` … +${parts.join(', ')}`;
  }

  const content = (
    <>
      {visibleTasks.map(task => (
        <TaskItem
          key={task.id}
          task={task}
          ownerColor={task.owner ? teammateColors[task.owner] : undefined}
          openBlockers={task.blockedBy.filter(id => unresolvedTaskIds.has(id))}
          activity={task.owner ? teammateActivity[task.owner] : undefined}
          ownerActive={task.owner ? activeTeammates.has(task.owner) : false}
          columns={columns}
        />
      ))}
      {maxDisplay > 0 && hiddenSummary && <Text dimColor>{hiddenSummary}</Text>}
    </>
  );

  if (isStandalone) {
    return (
      <Box flexDirection="column" marginTop={1} marginLeft={2}>
        <Box>
          <Text dimColor>
            <Text bold>{tasks.length}</Text>
            {' 个任务（'}
            <Text bold>{completedCount}</Text>
            {' 已完成，'}
            {inProgressCount > 0 && (
              <>
                <Text bold>{inProgressCount}</Text>
                {' 进行中，'}
              </>
            )}
            <Text bold>{pendingCount}</Text>
            {' 待处理）'}
          </Text>
        </Box>
        {content}
      </Box>
    );
  }

  return <Box flexDirection="column">{content}</Box>;
}

type TaskItemProps = {
  task: Task;
  ownerColor?: keyof Theme;
  openBlockers: string[];
  activity?: string;
  ownerActive: boolean;
  columns: number;
};

function getTaskIcon(status: Task['status']): {
  icon: string;
  color: keyof Theme | undefined;
} {
  switch (status) {
    case 'completed':
      return { icon: figures.tick, color: 'success' };
    case 'in_progress':
      return { icon: figures.squareSmallFilled, color: 'claude' };
    case 'pending':
      return { icon: figures.squareSmall, color: undefined };
  }
}

function TaskItem({ task, ownerColor, openBlockers, activity, ownerActive, columns }: TaskItemProps): React.ReactNode {
  const isCompleted = task.status === 'completed';
  const isInProgress = task.status === 'in_progress';
  const isBlocked = openBlockers.length > 0;

  const { icon, color } = getTaskIcon(task.status);

  const showActivity = isInProgress && !isBlocked && activity;

  // 响应式布局：在窄屏幕上隐藏 owner（<60 列）
  // 根据可用空间截断 subject
  const showOwner = columns >= 60 && task.owner && ownerActive;
  const ownerWidth = showOwner ? stringWidth(` (@${task.owner})`) : 0;
  // 计算：icon(2) + 缩进（嵌套在 spinner 下约 8）+ owner + 余量
  // 使用 columns - 15 作为嵌套布局的保守估计
  const maxSubjectWidth = Math.max(15, columns - 15 - ownerWidth);
  const displaySubject = truncateToWidth(task.subject, maxSubjectWidth);

  // 在窄屏幕上截断 activity
  const maxActivityWidth = Math.max(15, columns - 15);
  const displayActivity = activity ? truncateToWidth(activity, maxActivityWidth) : undefined;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={color}>{icon} </Text>
        <Text bold={isInProgress} strikethrough={isCompleted} dimColor={isCompleted || isBlocked}>
          {displaySubject}
        </Text>
        {showOwner && (
          <Text dimColor>
            {' ('}
            {ownerColor ? <ThemedText color={ownerColor}>@{task.owner}</ThemedText> : `@${task.owner}`}
            {')'}
          </Text>
        )}
        {isBlocked && (
          <Text dimColor>
            {' '}
            {figures.pointerSmall} 被以下任务阻塞：{' '}
            {[...openBlockers]
              .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
              .map(id => `#${id}`)
              .join(', ')}
          </Text>
        )}
      </Box>
      {showActivity && displayActivity && (
        <Box>
          <Text dimColor>
            {'  '}
            {displayActivity}
            {figures.ellipsis}
          </Text>
        </Box>
      )}
    </Box>
  );
}
