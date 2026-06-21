import figures from 'figures';
import * as React from 'react';
import { useMemo, useState } from 'react';
import { useTerminalSize } from 'src/hooks/useTerminalSize.js';
import { stringWidth } from '@anthropic/ink';
import { useAppState, useSetAppState } from 'src/state/AppState.js';
import { enterTeammateView, exitTeammateView } from 'src/state/teammateViewHelpers.js';
import { isPanelAgentTask } from 'src/tasks/LocalAgentTask/LocalAgentTask.js';
import { getPillLabel, pillNeedsCta } from 'src/tasks/pillLabel.js';
import { type BackgroundTaskState, isBackgroundTask, type TaskState } from 'src/tasks/types.js';
import { calculateHorizontalScrollWindow } from 'src/utils/horizontalScroll.js';
import { Box, Text } from '@anthropic/ink';
import {
  AGENT_COLOR_TO_THEME_COLOR,
  AGENT_COLORS,
  type AgentColorName,
} from '@claude-code-best/builtin-tools/tools/AgentTool/agentColorManager.js';
import type { Theme } from '../../utils/theme.js';
import { KeyboardShortcutHint } from '@anthropic/ink';
import { shouldHideTasksFooter } from './taskStatusUtils.js';

type Props = {
  tasksSelected: boolean;
  isViewingTeammate?: boolean;
  teammateFooterIndex?: number;
  isLeaderIdle?: boolean;
  onOpenDialog?: (taskId?: string) => void;
};

export function BackgroundTaskStatus({
  tasksSelected,
  isViewingTeammate,
  teammateFooterIndex = 0,
  isLeaderIdle = false,
  onOpenDialog,
}: Props): React.ReactNode {
  const setAppState = useSetAppState();
  const { columns } = useTerminalSize();
  const tasks = useAppState(s => s.tasks);
  const viewingAgentTaskId = useAppState(s => s.viewingAgentTaskId);

  const runningTasks = useMemo(
    () =>
      (Object.values(tasks ?? {}) as TaskState[]).filter(
        t => isBackgroundTask(t) && !(process.env.USER_TYPE === 'ant' && isPanelAgentTask(t)),
      ),
    [tasks],
  );

  // 检查是否所有 task 都是 in-process teammate（team 模式）
  // 在 spinner-tree 模式下，不显示 teammate pill（teammate 出现在 spinner tree 中）
  const expandedView = useAppState(s => s.expandedView);
  const showSpinnerTree = expandedView === 'teammates';
  const allTeammates =
    !showSpinnerTree && runningTasks.length > 0 && runningTasks.every(t => t.type === 'in_process_teammate');

  // 在顶层 memoize teammate 相关计算（遵循 hooks 规则）
  const teammateEntries = useMemo(
    () =>
      runningTasks
        .filter((t): t is BackgroundTaskState & { type: 'in_process_teammate' } => t.type === 'in_process_teammate')
        .sort((a, b) => a.identity.agentName.localeCompare(b.identity.agentName)),
    [runningTasks],
  );

  // 构建包含所有 pill 及其活动状态的数组
  // 每个 pill 为 "@{name}"，分隔符为 " "（1 字符）
  // 把空闲 agent 排到末尾，但仅在非选择模式下执行
  // 以避免用户在列表中方向键导航时重排
  // "main" 无论空闲与否始终排在最前
  const allPills = useMemo(() => {
    const mainPill = {
      name: 'main',
      color: undefined as keyof Theme | undefined,
      isIdle: isLeaderIdle,
      taskId: undefined as string | undefined,
    };

    const teammatePills = teammateEntries.map(t => ({
      name: t.identity.agentName,
      color: getAgentThemeColor(t.identity.color),
      isIdle: t.isIdle,
      taskId: t.id,
    }));

    // 仅在非选择时排序 teammate，以避免导航过程中重排
    if (!tasksSelected) {
      teammatePills.sort((a, b) => {
        // 活跃 agent 优先，空闲 agent 靠后
        if (a.isIdle !== b.isIdle) return a.isIdle ? 1 : -1;
        return 0; // 在每组内保持原顺序
      });
    }

    // main 始终在前，然后是已排序的 teammate
    const pills = [mainPill, ...teammatePills];

    // 排序后再加上 idx
    return pills.map((pill, i) => ({ ...pill, idx: i }));
  }, [teammateEntries, isLeaderIdle, tasksSelected]);

  // 计算 pill 宽度（包含分隔符空格，第一个除外）
  const pillWidths = useMemo(
    () =>
      allPills.map((pill, i) => {
        const pillText = `@${pill.name}`;
        // 第一个 pill 没有前导空格，其他 pill 有 1 个空格作为分隔符
        return stringWidth(pillText) + (i > 0 ? 1 : 0);
      }),
    [allPills],
  );

  if (allTeammates || (!showSpinnerTree && isViewingTeammate)) {
    const selectedIdx = tasksSelected ? teammateFooterIndex : -1;
    // 当前前台 agent 是哪一个（加粗显示）
    const viewedIdx = viewingAgentTaskId ? teammateEntries.findIndex(t => t.id === viewingAgentTaskId) + 1 : 0; // 0 = main/leader

    // 计算 pill 可用宽度
    // 预留空间：箭头、提示、最小内边距
    // 在 team 模式下 pill 单独占一行渲染
    const ARROW_WIDTH = 2; // 箭头字符 + 空格
    const HINT_WIDTH = 20; // shift+↓ 展开
    const PADDING = 4; // 最小安全余量
    const availableWidth = Math.max(20, columns - HINT_WIDTH - PADDING);

    // 计算 pill 的可见窗口
    const { startIndex, endIndex, showLeftArrow, showRightArrow } = calculateHorizontalScrollWindow(
      pillWidths,
      availableWidth,
      ARROW_WIDTH,
      selectedIdx >= 0 ? selectedIdx : 0,
    );

    const visiblePills = allPills.slice(startIndex, endIndex);

    return (
      <>
        {showLeftArrow && <Text dimColor>{figures.arrowLeft} </Text>}
        {visiblePills.map((pill, i) => {
          // 第一个可见 pill 没有前导分隔符
          // （若存在左箭头，已提供间距）
          const needsSeparator = i > 0;
          return (
            <React.Fragment key={pill.name}>
              {needsSeparator && <Text> </Text>}
              <AgentPill
                name={pill.name}
                color={pill.color}
                isSelected={selectedIdx === pill.idx}
                isViewed={viewedIdx === pill.idx}
                isIdle={pill.isIdle}
                onClick={() =>
                  pill.taskId ? enterTeammateView(pill.taskId, setAppState) : exitTeammateView(setAppState)
                }
              />
            </React.Fragment>
          );
        })}
        {showRightArrow && <Text dimColor> {figures.arrowRight}</Text>}
        <Text dimColor>
          {' · '}
          <KeyboardShortcutHint shortcut="shift + ↓" action="expand" />
        </Text>
      </>
    );
  }

  // 在 spinner-tree 模式下，不显示任何 teammate 的 footer 状态
  // （它们出现在上方的 spinner tree 中）
  if (shouldHideTasksFooter(tasks ?? {}, showSpinnerTree)) {
    return null;
  }

  if (runningTasks.length === 0) {
    return null;
  }

  return (
    <>
      <SummaryPill selected={tasksSelected} onClick={onOpenDialog}>
        {getPillLabel(runningTasks)}
      </SummaryPill>
      {pillNeedsCta(runningTasks) && <Text dimColor> · {figures.arrowDown} to view</Text>}
    </>
  );
}

type AgentPillProps = {
  name: string;
  color?: keyof Theme;
  isSelected: boolean;
  isViewed: boolean;
  isIdle: boolean;
  onClick?: () => void;
};

function AgentPill({ name, color, isSelected, isViewed, isIdle, onClick }: AgentPillProps): React.ReactNode {
  const [hover, setHover] = useState(false);
  // hover 复刻键盘选中的外观，让交互可预期。
  const highlighted = isSelected || hover;

  let label: React.ReactNode;
  if (highlighted) {
    label = color ? (
      <Text backgroundColor={color} color="inverseText" bold={isViewed}>
        @{name}
      </Text>
    ) : (
      <Text color="background" inverse bold={isViewed}>
        @{name}
      </Text>
    );
  } else if (isIdle) {
    label = (
      <Text dimColor bold={isViewed}>
        @{name}
      </Text>
    );
  } else if (isViewed) {
    label = (
      <Text color={color} bold>
        @{name}
      </Text>
    );
  } else {
    label = (
      <Text color={color} dimColor={!color}>
        @{name}
      </Text>
    );
  }

  if (!onClick) return label;
  return (
    <Box onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      {label}
    </Box>
  );
}

function SummaryPill({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}): React.ReactNode {
  const [hover, setHover] = useState(false);
  const label = (
    <Text color="background" inverse={selected || hover}>
      {children}
    </Text>
  );
  if (!onClick) return label;
  return (
    <Box onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      {label}
    </Box>
  );
}

function getAgentThemeColor(colorName: string | undefined): keyof Theme | undefined {
  if (!colorName) return undefined;
  if (AGENT_COLORS.includes(colorName as AgentColorName)) {
    return AGENT_COLOR_TO_THEME_COLOR[colorName as AgentColorName];
  }
  return undefined;
}
