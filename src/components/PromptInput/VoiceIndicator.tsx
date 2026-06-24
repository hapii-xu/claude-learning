import { feature } from 'bun:bundle';
import * as React from 'react';
import { useSettings } from '../../hooks/useSettings.js';
import { Box, Text, useAnimationFrame } from '@anthropic/ink';
import { interpolateColor, toRGBColor } from '../Spinner/utils.js';

type Props = {
  voiceState: 'idle' | 'recording' | 'processing';
};

// 处理中闪烁颜色：从暗灰色渐变到浅灰色（与 ThinkingShimmerText 匹配）
const PROCESSING_DIM = { r: 153, g: 153, b: 153 };
const PROCESSING_BRIGHT = { r: 185, g: 185, b: 185 };

const PULSE_PERIOD_S = 2; // 所有脉冲动画的周期为 2 秒

export function VoiceIndicator(props: Props): React.ReactNode {
  if (!feature('VOICE_MODE')) return null;
  return <VoiceIndicatorImpl {...props} />;
}

function VoiceIndicatorImpl({ voiceState }: Props): React.ReactNode {
  switch (voiceState) {
    case 'recording':
      return <Text dimColor>正在聆听…</Text>;
    case 'processing':
      return <ProcessingShimmer />;
    case 'idle':
      return null;
  }
}

// 静态 —— 热身窗口（第 2 次空格到激活之间约 120ms）
// 太短，1 秒周期的闪烁效果来不及呈现，而 50ms 动画
// 定时器与每 30-80ms 到达的自动重复空格并发执行，
// 在本已繁忙的窗口中叠加了额外的重渲染。
export function VoiceWarmupHint(): React.ReactNode {
  if (!feature('VOICE_MODE')) return null;
  return <Text dimColor>请继续按住…</Text>;
}

function ProcessingShimmer(): React.ReactNode {
  const settings = useSettings();
  const reducedMotion = settings.prefersReducedMotion ?? false;
  const [ref, time] = useAnimationFrame(reducedMotion ? null : 50);

  if (reducedMotion) {
    return <Text color="warning">语音：处理中…</Text>;
  }

  const elapsedSec = time / 1000;
  const opacity = (Math.sin((elapsedSec * Math.PI * 2) / PULSE_PERIOD_S) + 1) / 2;
  const color = toRGBColor(interpolateColor(PROCESSING_DIM, PROCESSING_BRIGHT, opacity));

  return (
    <Box ref={ref}>
      <Text color={color}>语音：处理中…</Text>
    </Box>
  );
}
