import React from 'react';
import { Text } from '@anthropic/ink';
import type { CollapsedReadSearchGroup } from '../../types/message.js';

/**
 * 普通函数（非 React 组件），防止 React Compiler 将
 * teamMemory* 属性访问提升做 memoization。
 * 仅在 feature('TEAMMEM') 为 true 时加载此模块。
 */
export function checkHasTeamMemOps(message: CollapsedReadSearchGroup): boolean {
  return (
    (message.teamMemorySearchCount ?? 0) > 0 ||
    (message.teamMemoryReadCount ?? 0) > 0 ||
    (message.teamMemoryWriteCount ?? 0) > 0
  );
}

/**
 * 为折叠的读取/搜索 UI 渲染团队记忆计数部分。
 * 仅在 feature('TEAMMEM') 为 true 时加载，外部构建会被 DCE 完全移除。
 */
export function TeamMemCountParts({
  message,
  isActiveGroup,
  hasPrecedingParts,
}: {
  message: CollapsedReadSearchGroup;
  isActiveGroup: boolean | undefined;
  hasPrecedingParts: boolean;
}): React.ReactNode {
  const tmReadCount = message.teamMemoryReadCount ?? 0;
  const tmSearchCount = message.teamMemorySearchCount ?? 0;
  const tmWriteCount = message.teamMemoryWriteCount ?? 0;

  if (tmReadCount === 0 && tmSearchCount === 0 && tmWriteCount === 0) {
    return null;
  }

  const nodes: React.ReactNode[] = [];
  let count = hasPrecedingParts ? 1 : 0;

  if (tmReadCount > 0) {
    const verb = isActiveGroup ? (count === 0 ? '正在回忆' : '正在回忆') : count === 0 ? '已回忆' : '已回忆';
    if (count > 0) {
      nodes.push(<Text key="comma-tmr">, </Text>);
    }
    nodes.push(
      <Text key="team-mem-read">
        {verb} <Text bold>{tmReadCount}</Text> 条团队记忆
      </Text>,
    );
    count++;
  }

  if (tmSearchCount > 0) {
    const verb = isActiveGroup ? (count === 0 ? '正在搜索' : '正在搜索') : count === 0 ? '已搜索' : '已搜索';
    if (count > 0) {
      nodes.push(<Text key="comma-tms">, </Text>);
    }
    nodes.push(<Text key="team-mem-search">{`${verb}团队记忆`}</Text>);
    count++;
  }

  if (tmWriteCount > 0) {
    const verb = isActiveGroup ? (count === 0 ? '正在写入' : '正在写入') : count === 0 ? '已写入' : '已写入';
    if (count > 0) {
      nodes.push(<Text key="comma-tmw">, </Text>);
    }
    nodes.push(
      <Text key="team-mem-write">
        {verb} <Text bold>{tmWriteCount}</Text> 条团队记忆
      </Text>,
    );
  }

  return <>{nodes}</>;
}
