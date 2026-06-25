/**
 * CoordinatorTaskPanel — 可操控的后台 agent 列表。
 *
 * 只要存在 local_agent 任务，就在 prompt 输入框下方渲染。
 * 可见性由 evictAfter 决定：undefined（运行中/保留）始终可见；
 * 时间戳则在过期前可见。Enter 查看/操控，x 清除。
 */

import figures from 'figures';
import * as React from 'react';
import { BLACK_CIRCLE, PAUSE_ICON, PLAY_ICON } from '../constants/figures.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { Box, Text, stringWidth, wrapText } from '@anthropic/ink';
import { type AppState, useAppState, useSetAppState } from '../state/AppState.js';
import { enterTeammateView, exitTeammateView } from '../state/teammateViewHelpers.js';
import { isPanelAgentTask, type LocalAgentTaskState } from '../tasks/LocalAgentTask/LocalAgentTask.js';
import { formatDuration, formatNumber } from '../utils/format.js';
import { evictTerminalTask } from '../utils/task/framework.js';
import { isTerminalStatus } from './tasks/taskStatusUtils.js';

/**
 * 当前哪些面板管理的任务有可见行。
 * 存在于 AppState.tasks 中即视为可见 —— CoordinatorTaskPanel 的 1 秒
 * tick 会清除超过 evictAfter 截止时间的任务。evictAfter !== 0 的检查
 * 用于处理立即清除（x 键），同时避免让过滤器依赖时间。被面板渲染、
 * useCoordinatorTaskCount 和索引解析器共享，确保计算不会漂移。
 */
export function getVisibleAgentTasks(tasks: AppState['tasks']): LocalAgentTaskState[] {
  return Object.values(tasks)
    .filter((t): t is LocalAgentTaskState => isPanelAgentTask(t) && t.evictAfter !== 0)
    .sort((a, b) => a.startTime - b.startTime);
}

export function CoordinatorTaskPanel(): React.ReactNode {
  const tasks = useAppState(s => s.tasks);
  const viewingAgentTaskId = useAppState(s => s.viewingAgentTaskId);
  const agentNameRegistry = useAppState(s => s.agentNameRegistry);
  const coordinatorTaskIndex = useAppState(s => s.coordinatorTaskIndex);
  const tasksSelected = useAppState(s => s.footerSelection === 'tasks');
  const selectedIndex = tasksSelected ? coordinatorTaskIndex : undefined;
  const setAppState = useSetAppState();

  const visibleTasks = getVisibleAgentTasks(tasks);
  const hasTasks = Object.values(tasks).some(isPanelAgentTask);

  // 1 秒 tick：为已用时间重新渲染，并清除超过截止时间的任务。
  // 清除操作会从 prev.tasks 中删除，使 useCoordinatorTaskCount
  // （及其他消费者）无需自己的 tick 即可看到更新后的计数。
  const tasksRef = React.useRef(tasks);
  tasksRef.current = tasks;
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    if (!hasTasks) return;
    const interval = setInterval(
      (tasksRef, setAppState, setTick) => {
        const now = Date.now();
        for (const t of Object.values(tasksRef.current)) {
          if (isPanelAgentTask(t) && (t.evictAfter ?? Infinity) <= now) {
            evictTerminalTask(t.id, setAppState);
          }
        }
        setTick((prev: number) => prev + 1);
      },
      1000,
      tasksRef,
      setAppState,
      setTick,
    );
    return () => clearInterval(interval);
  }, [hasTasks, setAppState]);
  const nameByAgentId = React.useMemo(() => {
    const inv = new Map<string, string>();
    for (const [n, id] of agentNameRegistry) inv.set(id, n);
    return inv;
  }, [agentNameRegistry]);

  if (visibleTasks.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <MainLine
        isSelected={selectedIndex === 0}
        isViewed={viewingAgentTaskId === undefined}
        onClick={() => exitTeammateView(setAppState)}
      />
      {visibleTasks.map((task, i) => (
        <AgentLine
          key={task.id}
          task={task}
          name={nameByAgentId.get(task.id)}
          isSelected={selectedIndex === i + 1}
          isViewed={viewingAgentTaskId === task.id}
          onClick={() => enterTeammateView(task.id, setAppState)}
        />
      ))}
    </Box>
  );
}

/**
 * 返回可见的 coordinator 任务数量（用于选中范围边界）。
 * 面板的 1 秒 tick 会从 prev.tasks 中清除过期任务，所以此计数
 * 无需自己的 tick 即可保持准确。
 */
export function useCoordinatorTaskCount(): number {
  const tasks = useAppState(s => s.tasks);
  return React.useMemo(() => {
    if ((process.env.USER_TYPE as string) !== 'ant') return 0;
    const count = getVisibleAgentTasks(tasks).length;
    return count > 0 ? count + 1 : 0;
  }, [tasks]);
}

function MainLine({
  isSelected,
  isViewed,
  onClick,
}: {
  isSelected?: boolean;
  isViewed?: boolean;
  onClick: () => void;
}): React.ReactNode {
  const [hover, setHover] = React.useState(false);
  const prefix = isSelected || hover ? figures.pointer + ' ' : '  ';
  const bullet = isViewed ? BLACK_CIRCLE : figures.circle;
  return (
    <Box onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <Text dimColor={!isSelected && !isViewed && !hover} bold={isViewed}>
        {prefix}
        {bullet} main
      </Text>
    </Box>
  );
}

type AgentLineProps = {
  task: LocalAgentTaskState;
  name?: string;
  isSelected?: boolean;
  isViewed?: boolean;
  onClick?: () => void;
};

function AgentLine({ task, name, isSelected, isViewed, onClick }: AgentLineProps): React.ReactNode {
  const { columns } = useTerminalSize();
  const [hover, setHover] = React.useState(false);
  const isRunning = !isTerminalStatus(task.status);
  const pausedMs = task.totalPausedMs ?? 0;
  const elapsedMs = Math.max(
    0,
    isRunning ? Date.now() - task.startTime - pausedMs : (task.endTime ?? task.startTime) - task.startTime - pausedMs,
  );

  const elapsed = formatDuration(elapsedMs);
  const tokenCount = task.progress?.tokenCount;

  // 根据活动状态派生方向箭头，逻辑与 Spinner 相同
  const lastActivity = task.progress?.lastActivity;
  const arrow = lastActivity ? figures.arrowDown : figures.arrowUp;

  const tokenText = tokenCount !== undefined && tokenCount > 0 ? ` · ${arrow} ${formatNumber(tokenCount)} tokens` : '';

  const queuedCount = task.pendingMessages.length;
  const queuedText = queuedCount > 0 ? ` · ${queuedCount} 个排队中` : '';

  // 优先级：AI 摘要 > 静态描述（不含工具调用活动的噪音）
  const displayDescription = task.progress?.summary || task.description;

  const highlighted = isSelected || hover;
  const prefix = highlighted ? figures.pointer + ' ' : '  ';
  const bullet = isViewed ? BLACK_CIRCLE : figures.circle;
  const dim = !highlighted && !isViewed;

  const sep = isRunning ? PLAY_ICON : PAUSE_ICON;
  // name 是操控句柄 —— 不参与截断且不调暗，
  // 即便该行处于非活跃状态也保持可读。按约定应简短
  // （Agent 工具 prompt 要求"一两个单词，小写"）。
  const namePart = name ? `${name}: ` : '';
  const hintPart = isSelected && !isViewed ? ` · x 键${isRunning ? '停止' : '清除'}` : '';
  const suffixPart = ` ${sep} ${elapsed}${tokenText}${queuedText}${hintPart}`;
  const availableForDesc =
    columns - stringWidth(prefix) - stringWidth(`${bullet} `) - stringWidth(namePart) - stringWidth(suffixPart);
  const truncated = wrapText(displayDescription, Math.max(0, availableForDesc), 'truncate-end');

  const line = (
    <Text dimColor={dim} bold={isViewed}>
      {prefix}
      {bullet}{' '}
      {name && (
        <>
          <Text dimColor={false} bold>
            {name}
          </Text>
          {': '}
        </>
      )}
      {truncated} {sep} {elapsed}
      {tokenText}
      {queuedCount > 0 && <Text color="warning">{queuedText}</Text>}
      {hintPart && <Text dimColor>{hintPart}</Text>}
    </Text>
  );

  if (!onClick) return line;
  return (
    <Box onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      {line}
    </Box>
  );
}
