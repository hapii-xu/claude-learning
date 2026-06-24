import * as React from 'react';
import { Box, Text } from '@anthropic/ink';
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js';

export function CompactBoundaryMessage(): React.ReactNode {
  const historyShortcut = useShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o');

  return (
    <Box marginY={1}>
      <Text dimColor>✻ 对话已压缩（{historyShortcut} 查看历史记录）</Text>
    </Box>
  );
}
