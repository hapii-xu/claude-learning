import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { formatTokens } from '../utils/format.js';
import { Select } from './CustomSelect/index.js';
import { Dialog } from '@anthropic/ink';

type IdleReturnAction = 'continue' | 'clear' | 'dismiss' | 'never';

type Props = {
  idleMinutes: number;
  totalInputTokens: number;
  onDone: (action: IdleReturnAction) => void;
};

export function IdleReturnDialog({ idleMinutes, totalInputTokens, onDone }: Props): React.ReactNode {
  const formattedIdle = formatIdleDuration(idleMinutes);
  const formattedTokens = formatTokens(totalInputTokens);

  return (
    <Dialog
      title={`你已离开 ${formattedIdle}，当前对话已使用 ${formattedTokens} tokens。`}
      onCancel={() => onDone('dismiss')}
    >
      <Box flexDirection="column">
        <Text>如果这是一个新任务，清除上下文可以节省用量并提高速度。</Text>
      </Box>
      <Select
        options={[
          {
            value: 'continue' as const,
            label: '继续当前对话',
          },
          {
            value: 'clear' as const,
            label: '作为新对话发送消息',
          },
          {
            value: 'never' as const,
            label: '不再询问',
          },
        ]}
        onChange={(value: IdleReturnAction) => onDone(value)}
      />
    </Dialog>
  );
}

function formatIdleDuration(minutes: number): string {
  if (minutes < 1) {
    return '< 1m';
  }
  if (minutes < 60) {
    return `${Math.floor(minutes)}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = Math.floor(minutes % 60);
  if (remainingMinutes === 0) {
    return `${hours}h`;
  }
  return `${hours}h ${remainingMinutes}m`;
}
