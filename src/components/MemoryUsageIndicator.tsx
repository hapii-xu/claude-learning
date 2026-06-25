import * as React from 'react';
import { useMemoryUsage } from '../hooks/useMemoryUsage.js';
import { Box, Text } from '@anthropic/ink';
import { formatFileSize } from '../utils/format.js';

export function MemoryUsageIndicator(): React.ReactNode {
  // 仅 Ant 内部使用：/heapdump 链接是内部调试辅助。在 hook 之前进行判断意味着
  // 在外部构建中永远不会设置 10 秒轮询间隔。
  // USER_TYPE 是构建时常量，因此下面的 hook 调用要么总是执行，
  // 要么在编译时被消除——运行时永远不会是条件性的。
  if (process.env.USER_TYPE !== 'ant') {
    return null;
  }

  // eslint-disable-next-line react-hooks/rules-of-hooks
  const memoryUsage = useMemoryUsage();

  if (!memoryUsage) {
    return null;
  }

  const { heapUsed, status } = memoryUsage;

  // 仅在内存使用量为高或临界时显示指示器
  if (status === 'normal') {
    return null;
  }

  const formattedSize = formatFileSize(heapUsed);
  const color = status === 'critical' ? 'error' : 'warning';

  return (
    <Box>
      <Text color={color} wrap="truncate">
        内存使用量较高（{formattedSize}）· /heapdump
      </Text>
    </Box>
  );
}
