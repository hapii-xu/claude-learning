import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { TEARDROP_ASTERISK } from '../../constants/figures.js';
import { Box, Text, useAnimationFrame } from '@anthropic/ink';
import { getInitialSettings } from '../../utils/settings/settings.js';
import { hueToRgb, toRGBColor } from '../Spinner/utils.js';

const SWEEP_DURATION_MS = 1500;
const SWEEP_COUNT = 2;
const TOTAL_ANIMATION_MS = SWEEP_DURATION_MS * SWEEP_COUNT;
const SETTLED_GREY = toRGBColor({ r: 153, g: 153, b: 153 });

export function AnimatedAsterisk({ char = TEARDROP_ASTERISK }: { char?: string }): React.ReactNode {
  // 挂载时只读一次 prefersReducedMotion — 没有 useSettings() 订阅，
  // 否则会在任何设置变化时重新渲染。
  const [reducedMotion] = useState(() => getInitialSettings().prefersReducedMotion ?? false);
  const [done, setDone] = useState(reducedMotion);
  // useAnimationFrame 的时钟是共享的 — 捕获我们自己的起始偏移，这样
  // 无论何时挂载，扫光都始终从 hue 0 开始。
  const startTimeRef = useRef<number | null>(null);
  // 接入 ref，以便 useAnimationFrame 的视口暂停生效：如果用户在
  // 扫光完成前提交了消息，当时钟此行进入 scrollback 时时钟会自动停止
  // （防止闪烁）。
  const [ref, time] = useAnimationFrame(done ? null : 50);

  useEffect(() => {
    if (done) return;
    const t = setTimeout(setDone, TOTAL_ANIMATION_MS, true);
    return () => clearTimeout(t);
  }, [done]);

  if (done) {
    return (
      <Box ref={ref}>
        <Text color={SETTLED_GREY}>{char}</Text>
      </Box>
    );
  }

  if (startTimeRef.current === null) {
    startTimeRef.current = time;
  }
  const elapsed = time - startTimeRef.current;
  const hue = ((elapsed / SWEEP_DURATION_MS) * 360) % 360;

  return (
    <Box ref={ref}>
      <Text color={toRGBColor(hueToRgb(hue))}>{char}</Text>
    </Box>
  );
}
