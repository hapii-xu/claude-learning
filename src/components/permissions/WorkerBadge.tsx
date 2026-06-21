import * as React from 'react';
import { BLACK_CIRCLE } from '../../constants/figures.js';
import { Box, Text } from '@anthropic/ink';
import { toInkColor } from '../../utils/ink.js';

export type WorkerBadgeProps = {
  name: string;
  color: string;
};

/**
 * 渲染带颜色的 worker 名称徽章，用于权限提示。
 * 用于指示哪个 swarm worker 正在请求权限。
 */
export function WorkerBadge({ name, color }: WorkerBadgeProps): React.ReactNode {
  const inkColor = toInkColor(color);
  return (
    <Box flexDirection="row" gap={1}>
      <Text color={inkColor}>
        {BLACK_CIRCLE} <Text bold>@{name}</Text>
      </Text>
    </Box>
  );
}
