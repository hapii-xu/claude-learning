import React from 'react';
import { Box, Text, useAnimationFrame } from '@anthropic/ink';
import type { Theme } from '@anthropic/ink';
import type { AgentProgress } from '../progress/store.js';
import { PHASE_COLOR, PHASE_MARK, type PhaseStatus } from './status.js';
import { ALL_PHASE, type MergedPhase } from './selectors.js';

const SPINNER_FRAMES = ['·', '✢', '✱', '✶', '✻', '✽'];
const FRAME_MS = 120;

type PhaseRow = {
  title: string;
  status?: PhaseStatus;
  done: number;
  total: number;
};

/**
 * 左侧 phase 侧栏：第一行是 All（聚合 done/total），其后是合并后的 phases（包括待执行 ○）。
 * 选中行：只有当本列聚焦（focused=true）时才绘制 selectionBg 背景（保留 fg，不变色）+ 一个 `>` 标记；
 * 焦点不在本列时不绘制背景色，避免"假聚焦"。运行中 phase 的状态标记由 useAnimationFrame 驱动 spinner 动画。
 * 样式与参考图一致：`> ✓ Scan  3/3`。
 */
export function PhaseSidebar({
  phases,
  agents,
  selectedIndex,
  focused,
}: {
  phases: MergedPhase[];
  agents: AgentProgress[];
  selectedIndex: number;
  focused: boolean;
}): React.ReactNode {
  const [ref, time] = useAnimationFrame(FRAME_MS);
  const frame = SPINNER_FRAMES[Math.floor(time / FRAME_MS) % SPINNER_FRAMES.length];
  const totalAgents = agents.length;
  const doneAgents = agents.filter(a => a.status === 'done').length;
  const rows: PhaseRow[] = [{ title: ALL_PHASE, done: doneAgents, total: totalAgents }, ...phases];

  return (
    <Box ref={ref} flexDirection="column">
      {rows.map((row, i) => {
        const selected = i === selectedIndex;
        const highlighted = selected && focused;
        const running = row.status === 'running';
        const mark = running ? frame : row.status ? PHASE_MARK[row.status] : ' ';
        const color = (row.status ? PHASE_COLOR[row.status] : 'subtle') as keyof Theme;
        return (
          <Box key={row.title} backgroundColor={highlighted ? 'selectionBg' : undefined} justifyContent="space-between">
            <Box>
              <Text color={selected ? 'claude' : undefined}>{highlighted ? '>' : ' '}</Text>
              <Text> </Text>
              <Text color={color}>{mark}</Text>
              <Text> {row.title}</Text>
            </Box>
            <Text color="subtle">
              {row.done}/{row.total}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
