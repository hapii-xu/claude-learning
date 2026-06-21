import React from 'react';
import { Box, Text, useAnimationFrame } from '@anthropic/ink';
import type { Theme } from '@anthropic/ink';
import type { AgentProgress } from '../progress/store.js';
import { agentMetaText, agentVisual } from './status.js';

const SPINNER_FRAMES = ['·', '✢', '✱', '✶', '✻', '✽'];
const FRAME_MS = 120;
const LABEL_MAX = 18;

/**
 * 将 label 截断到至多 max 个字符。保留结尾的 `#number` 后缀（audit workflow 的
 * `verify:${dim}#${findingIdx}` 格式）—— 这样同一维度下多个 finding 的 verify agent label
 * 仍能区分（前缀用 `…` 省略）。没有后缀时，从右侧截断（旧行为）。
 * 导出供单元测试覆盖。
 */
export function truncateLabel(raw: string, max: number): string {
  if (raw.length <= max) return raw;
  const m = raw.match(/#\d+$/);
  if (!m) return raw.slice(0, max);
  const suffix = m[0]; // 含 # 符号
  const prefix = raw.slice(0, raw.length - suffix.length);
  const available = max - suffix.length - 1; // -1 留给 …
  return `${prefix.slice(0, available)}…${suffix}`;
}

/**
 * 右侧 agent 列表（已按选中的 phase 过滤）。
 * 选中行：只有当该列聚焦（focused=true）时才绘制 selectionBg 背景（保留 fg，不变色）；
 * 焦点不在本列时不绘制背景色，避免"假聚焦"。
 * 运行中 agent 的状态标记由 useAnimationFrame 驱动（spinner 动画，共享时钟、全局同步）；
 * 右侧 `model · Nk tok · N tool` 由 agent_progress / agent_done 实时刷新。
 */
export function AgentList({
  agents,
  selectedIndex,
  focused,
}: {
  agents: AgentProgress[];
  selectedIndex: number;
  focused: boolean;
}): React.ReactNode {
  // 顶层订阅一次 animation frame：所有运行中 agent 共享同一帧（同步动画，避免每行一个 hook）。
  const [ref, time] = useAnimationFrame(FRAME_MS);
  const frame = SPINNER_FRAMES[Math.floor(time / FRAME_MS) % SPINNER_FRAMES.length];

  if (agents.length === 0) {
    return <Text color="subtle">(no agents in this phase)</Text>;
  }
  return (
    <Box ref={ref} flexDirection="column">
      {agents.map((a, i) => {
        const v = agentVisual(a);
        const selected = i === selectedIndex;
        const highlighted = selected && focused;
        const running = a.status === 'running';
        const mark = running ? frame : v.mark;
        const label = truncateLabel(a.label ?? `agent-${a.id}`, LABEL_MAX);
        return (
          <Box key={a.id} backgroundColor={highlighted ? 'selectionBg' : undefined} justifyContent="space-between">
            <Box>
              <Text color={v.color as keyof Theme}>{mark}</Text>
              <Text> {label}</Text>
            </Box>
            <Text color="subtle">{agentMetaText(a)}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
