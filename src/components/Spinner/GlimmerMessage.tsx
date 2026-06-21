import * as React from 'react';
import { Text, stringWidth, useTheme } from '@anthropic/ink';
import { getGraphemeSegmenter } from '../../utils/intl.js';
import { getTheme, type Theme } from '../../utils/theme.js';
import type { SpinnerMode } from './types.js';
import { interpolateColor, parseRGB, toRGBColor } from './utils.js';

type Props = {
  message: string;
  mode: SpinnerMode;
  messageColor: keyof Theme;
  glimmerIndex: number;
  flashOpacity: number;
  shimmerColor: keyof Theme;
  stalledIntensity?: number;
};

const ERROR_RED = { r: 171, g: 43, b: 63 };

export function GlimmerMessage({
  message,
  mode,
  messageColor,
  glimmerIndex,
  flashOpacity,
  shimmerColor,
  stalledIntensity = 0,
}: Props): React.ReactNode {
  const [themeName] = useTheme();
  const theme = getTheme(themeName);

  // 此组件以 20fps 重新渲染（glimmerIndex 每 50ms 变化一次），
  // 但 message 在一轮对话内稳定。对每条消息预计算一次字形分段 + 宽度，
  // 而非每帧计算。实测在微光路径上减少了 81%。
  const { segments, messageWidth } = React.useMemo(() => {
    const segs: { segment: string; width: number }[] = [];
    for (const { segment } of getGraphemeSegmenter().segment(message)) {
      segs.push({ segment, width: stringWidth(segment) });
    }
    return { segments: segs, messageWidth: stringWidth(message) };
  }, [message]);

  if (!message) return null;

  // 停滞时，显示平滑过渡到红色的文本
  if (stalledIntensity > 0) {
    const baseColorStr = theme[messageColor];
    const baseRGB = baseColorStr ? parseRGB(baseColorStr) : null;

    if (baseRGB) {
      const interpolated = interpolateColor(baseRGB, ERROR_RED, stalledIntensity);
      const color = toRGBColor(interpolated);
      return (
        <>
          <Text color={color}>{message}</Text>
          <Text color={color}> </Text>
        </>
      );
    }

    // ANSI 主题的后备方案：完全停滞前使用 messageColor，之后使用 error
    const color = stalledIntensity > 0.5 ? 'error' : messageColor;
    return (
      <>
        <Text color={color}>{message}</Text>
        <Text color={color}> </Text>
      </>
    );
  }

  // tool-use 模式：所有字符以相同透明度闪烁，因此渲染为
  // 单个 <Text> 而非 N 个独立的 FlashingChar 组件。
  if (mode === 'tool-use') {
    const baseColorStr = theme[messageColor];
    const shimmerColorStr = theme[shimmerColor];
    const baseRGB = baseColorStr ? parseRGB(baseColorStr) : null;
    const shimmerRGB = shimmerColorStr ? parseRGB(shimmerColorStr) : null;

    if (baseRGB && shimmerRGB) {
      const interpolated = interpolateColor(baseRGB, shimmerRGB, flashOpacity);
      return (
        <>
          <Text color={toRGBColor(interpolated)}>{message}</Text>
          <Text color={messageColor}> </Text>
        </>
      );
    }

    const color = flashOpacity > 0.5 ? shimmerColor : messageColor;
    return (
      <>
        <Text color={color}>{message}</Text>
        <Text color={messageColor}> </Text>
      </>
    );
  }

  // 微光模式：只有 glimmerIndex ±1 范围内的字符需要微光
  // 颜色。当微光在屏幕外时，渲染为单个 <Text>。
  const shimmerStart = glimmerIndex - 1;
  const shimmerEnd = glimmerIndex + 1;

  if (shimmerStart >= messageWidth || shimmerEnd < 0) {
    return (
      <>
        <Text color={messageColor}>{message}</Text>
        <Text color={messageColor}> </Text>
      </>
    );
  }

  // 按视觉列位置最多切成 3 段
  const clampedStart = Math.max(0, shimmerStart);
  let colPos = 0;
  let before = '';
  let shim = '';
  let after = '';
  for (const { segment, width } of segments) {
    if (colPos + width <= clampedStart) {
      before += segment;
    } else if (colPos > shimmerEnd) {
      after += segment;
    } else {
      shim += segment;
    }
    colPos += width;
  }

  return (
    <>
      {before && <Text color={messageColor}>{before}</Text>}
      <Text color={shimmerColor}>{shim}</Text>
      {after && <Text color={messageColor}>{after}</Text>}
      <Text color={messageColor}> </Text>
    </>
  );
}
