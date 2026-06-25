import React from 'react';
import { Box, Dialog, Link, Text } from '@anthropic/ink';
import { Select } from './CustomSelect/index.js';

type Props = {
  onDone: () => void;
};

export function CostThresholdDialog({ onDone }: Props): React.ReactNode {
  return (
    <Dialog title="本次会话您已在 Anthropic API 上消费了 $5。" onCancel={onDone}>
      <Box flexDirection="column">
        <Text>了解更多关于如何监控消费的方法：</Text>
        <Link url="https://code.claude.com/docs/en/costs" />
      </Box>
      <Select
        options={[
          {
            value: 'ok',
            label: '知道了，谢谢！',
          },
        ]}
        onChange={onDone}
      />
    </Dialog>
  );
}
