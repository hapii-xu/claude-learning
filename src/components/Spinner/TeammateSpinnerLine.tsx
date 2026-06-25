import figures from 'figures';
import sample from 'lodash-es/sample.js';
import * as React from 'react';
import { useRef, useState } from 'react';
import { getSpinnerVerbs } from '../../constants/spinnerVerbs.js';
import { TURN_COMPLETION_VERBS } from '../../constants/turnCompletionVerbs.js';
import { useElapsedTime } from '../../hooks/useElapsedTime.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { Box, Text, stringWidth } from '@anthropic/ink';
import { toInkColor } from '../../utils/ink.js';
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js';
import { summarizeRecentActivities } from '../../utils/collapseReadSearch.js';
import { formatDuration, formatNumber, truncateToWidth } from '../../utils/format.js';

import { TEAMMATE_SELECT_HINT } from './teammateSelectHint.js';

type Props = {
  teammate: InProcessTeammateTaskState;
  isLast: boolean;
  isSelected?: boolean;
  isForegrounded?: boolean;
  allIdle?: boolean;
  showPreview?: boolean;
};

/**
 * 从 teammate 的对话中提取最后 3 行内容。
 * 显示任意消息类型（user 或 assistant）的近期活动。
 */
function getMessagePreview(messages: InProcessTeammateTaskState['messages']): string[] {
  if (!messages?.length) return [];

  const allLines: string[] = [];
  const maxLineLength = 80;

  // 从近期消息中收集行（从最新开始）
  for (let i = messages.length - 1; i >= 0 && allLines.length < 3; i--) {
    const msg = messages[i];
    // 只处理有内容的消息（user/assistant 消息）
    if (!msg || (msg.type !== 'user' && msg.type !== 'assistant') || !msg.message?.content?.length) {
      continue;
    }
    const content = msg.message.content;

    for (const block of content) {
      if (allLines.length >= 3) break;
      if (!block || typeof block !== 'object') continue;

      if ('type' in block && block.type === 'tool_use' && 'name' in block) {
        // 尝试从工具输入中展示有意义的信息
        const input = 'input' in block ? (block.input as Record<string, unknown>) : null;
        let toolLine = `使用 ${block.name}…`;
        if (input) {
          // 查找常见的描述性字段
          const desc =
            (input.description as string | undefined) ||
            (input.prompt as string | undefined) ||
            (input.command as string | undefined) ||
            (input.query as string | undefined) ||
            (input.pattern as string | undefined);
          if (desc) {
            toolLine = desc.split('\n')[0] ?? toolLine;
          }
        }
        allLines.push(truncateToWidth(toolLine, maxLineLength));
      } else if ('type' in block && block.type === 'text' && 'text' in block) {
        const textLines = (block.text as string).split('\n').filter(l => l.trim());
        // 从文本末尾取（最近几行）
        for (let j = textLines.length - 1; j >= 0 && allLines.length < 3; j--) {
          const line = textLines[j];
          if (!line) continue;
          allLines.push(truncateToWidth(line, maxLineLength));
        }
      }
    }
  }

  // 反转，让 3 行中最旧的排在前面（阅读顺序）
  return allLines.reverse();
}

export function TeammateSpinnerLine({
  teammate,
  isLast,
  isSelected,
  isForegrounded,
  allIdle,
  showPreview,
}: Props): React.ReactNode {
  const [randomVerb] = useState(() => teammate.spinnerVerb ?? sample(getSpinnerVerbs()));
  const [pastTenseVerb] = useState(() => teammate.pastTenseVerb ?? sample(TURN_COMPLETION_VERBS));
  const isHighlighted = isSelected || isForegrounded;
  const treeChar = isHighlighted ? (isLast ? '╘═' : '╞═') : isLast ? '└─' : '├─';
  const nameColor = toInkColor(teammate.identity.color);
  const { columns } = useTerminalSize();

  // 跟踪 teammate 进入空闲的时间点（用于显示 "Idle for X..."）
  const idleStartRef = useRef<number | null>(null);
  // 进入全部空闲状态时冻结已耗时
  const frozenDurationRef = useRef<string | null>(null);

  // 跟踪空闲开始时间
  if (teammate.isIdle && idleStartRef.current === null) {
    idleStartRef.current = Date.now();
  } else if (!teammate.isIdle) {
    idleStartRef.current = null;
  }

  // 离开全部空闲状态时重置冻结的已耗时
  if (!allIdle && frozenDurationRef.current !== null) {
    frozenDurationRef.current = null;
  }

  // 获取已空闲时长（空闲了多久）— 用于显示 "Idle for X..."
  const idleElapsedTime = useElapsedTime(idleStartRef.current ?? Date.now(), teammate.isIdle && !allIdle);

  // 第一次检测到全部空闲时冻结已耗时
  // 过去式展示使用 teammate 的实际工作时间（自任务开始起）
  if (allIdle && frozenDurationRef.current === null) {
    frozenDurationRef.current = formatDuration(
      Math.max(0, Date.now() - teammate.startTime - (teammate.totalPausedMs ?? 0)),
    );
  }

  // 全部空闲时使用冻结的工作时长，否则使用空闲已耗时
  const displayTime = allIdle
    ? (frozenDurationRef.current ??
      (() => {
        throw new Error(`空闲 teammate 缺少 frozenDurationRef: ${teammate.identity.agentName}`);
      })())
    : idleElapsedTime;

  // 布局：paddingLeft(3) + 指针(1) + 空格(1) + treeChar(2) + 空格(1) = 8 个固定字符
  // 然后可选地：@name + ": " 或仅 ": "
  // 然后：活动文本 + 可选附加（统计、提示）
  const basePrefix = 8;
  const fullAgentName = `@${teammate.identity.agentName}`;
  const fullNameWidth = stringWidth(fullAgentName);

  // 从 progress 中获取统计
  const toolUseCount = teammate.progress?.toolUseCount ?? 0;
  const tokenCount = teammate.progress?.tokenCount ?? 0;
  // 统计文案中的 "tool uses" / "tokens" 保留英文术语
  const statsText = ` · ${toolUseCount} tool ${toolUseCount === 1 ? 'use' : 'uses'} · ${formatNumber(tokenCount)} tokens`;
  const statsWidth = stringWidth(statsText);
  const selectHintText = ` · ${TEAMMATE_SELECT_HINT}`;
  const selectHintWidth = stringWidth(selectHintText);
  const viewHintText = ' · 回车查看';
  const viewHintWidth = stringWidth(viewHintText);

  // 渐进式响应布局：
  // 宽（80+）：完整名字 + 活动 + 统计 + 提示
  // 中（60-80）：完整名字 + 活动
  // 窄（<60）：隐藏名字，仅显示活动
  const minActivityWidth = 25;

  // 在窄终端（< 60 列）或空间不足时隐藏名字
  const spaceWithFullName = columns - basePrefix - fullNameWidth - 2;
  const showName = columns >= 60 && spaceWithFullName >= minActivityWidth;
  const nameWidth = showName ? fullNameWidth + 2 : 0; // +2 用于显示名字时的 ": "
  const availableForActivity = columns - basePrefix - nameWidth;

  // 渐进式隐藏：查看提示 → 选择提示 → 统计
  // 统计始终可见（未选中时为 dim）；提示仅在高亮/选中时显示
  const showViewHint =
    isSelected && !isForegrounded && availableForActivity > viewHintWidth + statsWidth + minActivityWidth + 5;
  const showSelectHint =
    isHighlighted &&
    availableForActivity > selectHintWidth + (showViewHint ? viewHintWidth : 0) + statsWidth + minActivityWidth + 5;
  const showStats = availableForActivity > statsWidth + minActivityWidth + 5;

  // 活动文本占用剩余空间
  const extrasCost =
    (showStats ? statsWidth : 0) + (showSelectHint ? selectHintWidth : 0) + (showViewHint ? viewHintWidth : 0);
  const activityMaxWidth = Math.max(minActivityWidth, availableForActivity - extrasCost - 1);

  // 为活跃的 teammate 格式化活动文本，汇总搜索/读取操作
  const activityText = (() => {
    const activities = teammate.progress?.recentActivities;
    if (activities && activities.length > 0) {
      const summary = summarizeRecentActivities(activities);
      if (summary) return truncateToWidth(summary, activityMaxWidth);
    }
    const desc = teammate.progress?.lastActivity?.activityDescription;
    if (desc) return truncateToWidth(desc, activityMaxWidth);
    return randomVerb;
  })();

  // 状态渲染逻辑
  const renderStatus = (): React.ReactNode => {
    if (teammate.shutdownRequested) {
      return <Text dimColor>[停止中]</Text>;
    }
    if (teammate.awaitingPlanApproval) {
      return <Text color="warning">[等待批准]</Text>;
    }
    if (teammate.isIdle) {
      if (allIdle) {
        return (
          <Text dimColor>
            {pastTenseVerb} for {displayTime}
          </Text>
        );
      }
      return <Text dimColor>空闲 {idleElapsedTime}</Text>;
    }
    // 活跃 — 显示 spinner 字形 + 活动描述（仅在未高亮时；
    // 高亮时，上方的主 spinner 已经显示了动词）
    if (isHighlighted) {
      return null;
    }
    return <Text dimColor>{activityText?.endsWith('…') ? activityText : `${activityText}…`}</Text>;
  };

  // 如果启用则获取预览行
  const previewLines = showPreview ? getMessagePreview(teammate.messages) : [];

  // 预览行的树形延续字符
  const previewTreeChar = isLast ? '   ' : '│  ';

  return (
    <Box flexDirection="column">
      <Box paddingLeft={3}>
        {/* 选择指示：选中时为指针，否则为空格 */}
        <Text color={isSelected ? 'suggestion' : undefined} bold={isSelected}>
          {isSelected ? figures.pointer : ' '}
        </Text>
        <Text dimColor={!isSelected}>{treeChar} </Text>
        {/* Agent 名字：在非常窄的屏幕上隐藏 */}
        {showName && <Text color={isSelected ? 'suggestion' : nameColor}>@{teammate.identity.agentName}</Text>}
        {showName && <Text dimColor={!isSelected}>: </Text>}
        {renderStatus()}
        {/* 统计：仅在选中且终端足够宽时显示 */}
        {showStats && (
          <Text dimColor>
            {' '}
            · {toolUseCount} tool {toolUseCount === 1 ? 'use' : 'uses'} · {formatNumber(tokenCount)} tokens
          </Text>
        )}
        {/* 提示：高亮时显示选择提示，选中但未前台时显示查看提示 */}
        {showSelectHint && <Text dimColor> · {TEAMMATE_SELECT_HINT}</Text>}
        {showViewHint && <Text dimColor> · 回车查看</Text>}
      </Box>
      {/* 预览行 */}
      {previewLines.map((line, idx) => (
        <Box key={idx} paddingLeft={3}>
          <Text dimColor> </Text>
          <Text dimColor>{previewTreeChar} </Text>
          <Text dimColor>{line}</Text>
        </Box>
      ))}
    </Box>
  );
}
