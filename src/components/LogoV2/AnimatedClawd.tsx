import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { Box } from '@anthropic/ink';
import { getInitialSettings } from '../../utils/settings/settings.js';
import { Clawd, type ClawdPose } from './Clawd.js';

type Frame = { pose: ClawdPose; offset: number };

/** 保持某个 pose n 帧（每帧 60ms）。 */
function hold(pose: ClawdPose, offset: number, frames: number): Frame[] {
  return Array.from({ length: frames }, () => ({ pose, offset }));
}

// offset 语义：固定高度为 3 的容器中的 marginTop。0 = 正常，
// 1 = 蹲下。容器高度保持 3，所以布局永不抖动；蹲下时
// （offset=1）Clawd 的脚部行会下沉到容器下方并被裁剪 —
// 读起来像"钻到画框下方"，然后弹回来。

// 点击动画：蹲下，然后双臂上举弹起。重复两次。
const JUMP_WAVE: readonly Frame[] = [
  ...hold('default', 1, 2), // 蹲下
  ...hold('arms-up', 0, 3), // 弹起！
  ...hold('default', 0, 1),
  ...hold('default', 1, 2), // 再次蹲下
  ...hold('arms-up', 0, 3), // 弹起！
  ...hold('default', 0, 1),
];

// 点击动画：向右看，然后向左看，再回到中间。
const LOOK_AROUND: readonly Frame[] = [
  ...hold('look-right', 0, 5),
  ...hold('look-left', 0, 5),
  ...hold('default', 0, 1),
];

const CLICK_ANIMATIONS: readonly (readonly Frame[])[] = [JUMP_WAVE, LOOK_AROUND];

const IDLE: Frame = { pose: 'default', offset: 0 };
const FRAME_MS = 60;
const incrementFrame = (i: number) => i + 1;
const CLAWD_HEIGHT = 3;

/**
 * 带有点击触发动画的 Clawd（蹲下-双臂上举跳跃，或四处张望）。
 * 容器高度固定为 CLAWD_HEIGHT — 与纯 `<Clawd />` 占地相同 —
 * 所以周围布局永不抖动。蹲下时仅脚部行被裁剪（见上方注释）。
 * 点击仅在启用了鼠标追踪时（即在 `<AlternateScreen>` / 全屏内）才会触发；
 * 其他场景下其渲染和行为与普通 `<Clawd />` 完全一致。
 */
export function AnimatedClawd(): React.ReactNode {
  const { pose, bounceOffset, onClick } = useClawdAnimation();
  return (
    <Box height={CLAWD_HEIGHT} flexDirection="column" onClick={onClick}>
      <Box marginTop={bounceOffset} flexShrink={0}>
        <Clawd pose={pose} />
      </Box>
    </Box>
  );
}

function useClawdAnimation(): {
  pose: ClawdPose;
  bounceOffset: number;
  onClick: () => void;
} {
  // 挂载时只读一次 — 没有 useSettings() 订阅，否则会在任何设置变化时重新渲染。
  const [reducedMotion] = useState(() => getInitialSettings().prefersReducedMotion ?? false);
  const [frameIndex, setFrameIndex] = useState(-1);
  const sequenceRef = useRef<readonly Frame[]>(JUMP_WAVE);

  const onClick = () => {
    if (reducedMotion || frameIndex !== -1) return;
    sequenceRef.current = CLICK_ANIMATIONS[Math.floor(Math.random() * CLICK_ANIMATIONS.length)]!;
    setFrameIndex(0);
  };

  useEffect(() => {
    if (frameIndex === -1) return;
    if (frameIndex >= sequenceRef.current.length) {
      setFrameIndex(-1);
      return;
    }
    const timer = setTimeout(setFrameIndex, FRAME_MS, incrementFrame);
    return () => clearTimeout(timer);
  }, [frameIndex]);

  const seq = sequenceRef.current;
  const current = frameIndex >= 0 && frameIndex < seq.length ? seq[frameIndex]! : IDLE;
  return { pose: current.pose, bounceOffset: current.offset, onClick };
}
