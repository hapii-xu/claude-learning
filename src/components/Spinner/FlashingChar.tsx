import * as React from 'react';
import { Text, useTheme } from '@anthropic/ink';
import { getTheme, type Theme } from '../../utils/theme.js';
import { interpolateColor, parseRGB, toRGBColor } from './utils.js';

type Props = {
  char: string;
  flashOpacity: number;
  messageColor: keyof Theme;
  shimmerColor: keyof Theme;
};

export function FlashingChar({ char, flashOpacity, messageColor, shimmerColor }: Props): React.ReactNode {
  const [themeName] = useTheme();
  const theme = getTheme(themeName);

  const baseColorStr = theme[messageColor];
  const shimmerColorStr = theme[shimmerColor];

  const baseRGB = baseColorStr ? parseRGB(baseColorStr) : null;
  const shimmerRGB = shimmerColorStr ? parseRGB(shimmerColorStr) : null;

  if (baseRGB && shimmerRGB) {
    // 颜色之间的平滑插值
    const interpolated = interpolateColor(baseRGB, shimmerRGB, flashOpacity);
    return <Text color={toRGBColor(interpolated)}>{char}</Text>;
  }

  // ANSI 主题的后备方案：二值切换
  const shouldUseShimmer = flashOpacity > 0.5;
  return <Text color={shouldUseShimmer ? shimmerColor : messageColor}>{char}</Text>;
}
