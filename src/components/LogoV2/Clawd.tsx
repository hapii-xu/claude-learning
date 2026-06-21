import * as React from 'react';
import { Box, Text } from '@anthropic/ink';
import { env } from '../../utils/env.js';

export type ClawdPose =
  | 'default'
  | 'arms-up' // 双臂上举（跳跃时使用）
  | 'look-left' // 双瞳向左偏移
  | 'look-right'; // 双瞳向右偏移

type Props = {
  pose?: ClawdPose;
};

// 标准终端的 pose 片段。每一行被切成多段，这样我们可以只变化
// 发生改变的部分（眼睛、手臂），而让 body/bg 区段保持稳定。
// 所有 pose 最终都是 9 列宽。
//
// arms-up：第 2 行的手臂形状（▝▜ / ▛▘）移到第 1 行，作为其
// 下重上轻的镜像（▗▟ / ▙▖）— 同样的剪影，上移一行。
//
// look-* 使用上象限的眼部字符（▙/▟），这样双眼都从
// 默认状态（▛/▜，下瞳孔）变化 — 否则只有一只眼睛看起来在动。
type Segments = {
  /** 第 1 行左侧（无背景）：可选上举手臂 + 侧边 */
  r1L: string;
  /** 第 1 行眼睛（带背景）：左眼、额头、右眼 */
  r1E: string;
  /** 第 1 行右侧（无背景）：侧边 + 可选上举手臂 */
  r1R: string;
  /** 第 2 行左侧（无背景）：手臂 + 身体曲线 */
  r2L: string;
  /** 第 2 行右侧（无背景）：身体曲线 + 手臂 */
  r2R: string;
};

const POSES: Record<ClawdPose, Segments> = {
  default: { r1L: ' ▐', r1E: '▛███▜', r1R: '▌', r2L: '▝▜', r2R: '▛▘' },
  'look-left': { r1L: ' ▐', r1E: '▟███▟', r1R: '▌', r2L: '▝▜', r2R: '▛▘' },
  'look-right': { r1L: ' ▐', r1E: '▙███▙', r1R: '▌', r2L: '▝▜', r2R: '▛▘' },
  'arms-up': { r1L: '▗▟', r1E: '▛███▜', r1R: '▙▖', r2L: ' ▜', r2R: '▛ ' },
};

// Apple Terminal 使用背景填充技巧（见下文），所以只有眼部 pose 有意义。
// 手臂 pose 回退到 default。
const APPLE_EYES: Record<ClawdPose, string> = {
  default: ' ▗   ▖ ',
  'look-left': ' ▘   ▘ ',
  'look-right': ' ▝   ▝ ',
  'arms-up': ' ▗   ▖ ',
};

export function Clawd({ pose = 'default' }: Props = {}): React.ReactNode {
  if (env.terminal === 'Apple_Terminal') {
    return <AppleTerminalClawd pose={pose} />;
  }
  const p = POSES[pose];
  return (
    <Box flexDirection="column">
      <Text>
        <Text color="clawd_body">{p.r1L}</Text>
        <Text color="clawd_body" backgroundColor="clawd_background">
          {p.r1E}
        </Text>
        <Text color="clawd_body">{p.r1R}</Text>
      </Text>
      <Text>
        <Text color="clawd_body">{p.r2L}</Text>
        <Text color="clawd_body" backgroundColor="clawd_background">
          █████
        </Text>
        <Text color="clawd_body">{p.r2R}</Text>
      </Text>
      <Text color="clawd_body">
        {'  '}▘▘ ▝▝{'  '}
      </Text>
    </Box>
  );
}

function AppleTerminalClawd({ pose }: { pose: ClawdPose }): React.ReactNode {
  // Apple Terminal 默认会在字符之间渲染垂直空白。
  // 它不会在背景色之间渲染垂直空白，
  // 所以我们用背景色来绘制主体形状。
  return (
    <Box flexDirection="column" alignItems="center">
      <Text>
        <Text color="clawd_body">▗</Text>
        <Text color="clawd_background" backgroundColor="clawd_body">
          {APPLE_EYES[pose]}
        </Text>
        <Text color="clawd_body">▖</Text>
      </Text>
      <Text backgroundColor="clawd_body">{' '.repeat(7)}</Text>
      <Text color="clawd_body">▘▘ ▝▝</Text>
    </Box>
  );
}
