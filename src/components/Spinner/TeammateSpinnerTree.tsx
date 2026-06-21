import figures from 'figures';
import * as React from 'react';
import { Box, Text, type TextProps } from '@anthropic/ink';
import { useAppState } from '../../state/AppState.js';
import { getRunningTeammatesSorted } from '../../tasks/InProcessTeammateTask/InProcessTeammateTask.js';
import { formatNumber } from '../../utils/format.js';
import { TeammateSpinnerLine } from './TeammateSpinnerLine.js';
import { TEAMMATE_SELECT_HINT } from './teammateSelectHint.js';

type Props = {
  selectedIndex?: number;
  isInSelectionMode?: boolean;
  allIdle?: boolean;
  /** Leader 的活动动词（当 leader 正在处理时） */
  leaderVerb?: string;
  /** Leader 的 token 数（当 leader 正在处理时） */
  leaderTokenCount?: number;
  /** Leader 的空闲状态文本（当 leader 空闲时，例如 "✻ Idle for 3s"） */
  leaderIdleText?: string;
};

export function TeammateSpinnerTree({
  selectedIndex,
  isInSelectionMode,
  allIdle,
  leaderVerb,
  leaderTokenCount,
  leaderIdleText,
}: Props): React.ReactNode {
  const tasks = useAppState(s => s.tasks);
  const viewingAgentTaskId = useAppState(s => s.viewingAgentTaskId);
  const showTeammateMessagePreview = useAppState(s => s.showTeammateMessagePreview);

  const teammateTasks = getRunningTeammatesSorted(tasks);

  // 没有运行中的 teammate 时不渲染
  if (teammateTasks.length === 0) {
    return null;
  }

  // Leader 高亮遵循与 teammate 相同的模式：
  // isHighlighted = isForegrounded || isSelected
  const isLeaderForegrounded = viewingAgentTaskId === undefined;
  const isLeaderSelected = isInSelectionMode && selectedIndex === -1;
  const isLeaderHighlighted = isLeaderForegrounded || isLeaderSelected;
  const leaderColor: TextProps['color'] = 'cyan_FOR_SUBAGENTS_ONLY';

  // "hide" 行是否被选中？（在选择模式下 index === teammateCount）
  const isHideSelected = isInSelectionMode === true && selectedIndex === teammateTasks.length;

  return (
    <Box flexDirection="column" marginTop={1}>
      {/* Leader 行 — 始终可见，使用 ┌─ 包围树形结构 */}
      {
        <Box paddingLeft={3}>
          <Text color={isLeaderSelected ? 'suggestion' : undefined} bold={isLeaderHighlighted}>
            {isLeaderSelected ? figures.pointer : ' '}
          </Text>
          <Text dimColor={!isLeaderHighlighted} bold={isLeaderHighlighted}>
            {isLeaderHighlighted ? '╒═' : '┌─'}{' '}
          </Text>
          <Text bold={isLeaderHighlighted} color={isLeaderSelected ? 'suggestion' : leaderColor}>
            team-lead
          </Text>
          {/* 后台且活跃时：显示 spinner + 动词 */}
          {!isLeaderForegrounded && leaderVerb && <Text dimColor>: {leaderVerb}…</Text>}
          {/* 后台且空闲时：显示空闲文本 */}
          {!isLeaderForegrounded && !leaderVerb && leaderIdleText && <Text dimColor>: {leaderIdleText}</Text>}
          {/* 统计（tokens）— 与 teammate 相同的 dimColor 逻辑 */}
          {leaderTokenCount !== undefined && leaderTokenCount > 0 && (
            <Text dimColor={!isLeaderHighlighted}> · {formatNumber(leaderTokenCount)} tokens</Text>
          )}
          {/* 提示 — 高亮时显示选择提示，选中但未前台时显示查看提示 */}
          {isLeaderHighlighted && <Text dimColor> · {TEAMMATE_SELECT_HINT}</Text>}
          {isLeaderSelected && !isLeaderForegrounded && <Text dimColor> · enter to view</Text>}
        </Box>
      }
      {teammateTasks.map((teammate, index) => (
        <TeammateSpinnerLine
          key={teammate.id}
          teammate={teammate}
          isLast={!isInSelectionMode && index === teammateTasks.length - 1}
          isSelected={isInSelectionMode && selectedIndex === index}
          isForegrounded={viewingAgentTaskId === teammate.id}
          allIdle={allIdle}
          showPreview={showTeammateMessagePreview}
        />
      ))}
      {/* Hide 行 — 仅在选择模式下可见 */}
      {isInSelectionMode && <HideRow isSelected={isHideSelected} />}
    </Box>
  );
}

function HideRow({ isSelected }: { isSelected: boolean }): React.ReactNode {
  return (
    <Box paddingLeft={3}>
      <Text color={isSelected ? 'suggestion' : undefined} bold={isSelected}>
        {isSelected ? figures.pointer : ' '}
      </Text>
      <Text dimColor={!isSelected} bold={isSelected}>
        {isSelected ? '╘═' : '└─'}{' '}
      </Text>
      <Text dimColor={!isSelected} bold={isSelected}>
        hide
      </Text>
      {isSelected && <Text dimColor> · enter to collapse</Text>}
    </Box>
  );
}
