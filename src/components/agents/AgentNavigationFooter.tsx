import * as React from 'react';
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js';
import { Box, Text } from '@anthropic/ink';

type Props = {
  instructions?: string;
};

export function AgentNavigationFooter({
  instructions = '按 ↑↓ 导航 · Enter 选择 · Esc 返回',
}: Props): React.ReactNode {
  const exitState = useExitOnCtrlCDWithKeybindings();

  return (
    <Box marginLeft={2}>
      <Text dimColor>{exitState.pending ? `再次按 ${exitState.keyName} 退出` : instructions}</Text>
    </Box>
  );
}
