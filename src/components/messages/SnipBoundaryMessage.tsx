/**
 * SnipBoundaryMessage — 显示对话被剪切位置的视觉分隔符。
 */
import * as React from 'react';
import { Box, Text } from '@anthropic/ink';
import type { Message } from '../../types/message.js';

type Props = {
  message: Message;
};

export function SnipBoundaryMessage({ message }: Props): React.ReactNode {
  const content =
    typeof (message as Record<string, unknown>).content === 'string'
      ? ((message as Record<string, unknown>).content as string)
      : '[已剪切] 此处之前的对话历史已被剪切。';

  return (
    <Box marginTop={1} marginBottom={1}>
      <Text dimColor>── {content} ──</Text>
    </Box>
  );
}
