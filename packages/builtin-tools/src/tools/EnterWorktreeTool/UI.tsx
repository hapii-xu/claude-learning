import * as React from 'react';
import { Box, Text } from '@anthropic/ink';
import type { ToolProgressData } from 'src/Tool.js';
import type { ProgressMessage } from 'src/types/message.js';
import type { ThemeName } from 'src/utils/theme.js';
import type { Output } from './EnterWorktreeTool.js';

export function renderToolUseMessage(): React.ReactNode {
  return '正在创建 worktree…';
}

export function renderToolResultMessage(
  output: Output,
  _progressMessagesForMessage: ProgressMessage<ToolProgressData>[],
  _options: { theme: ThemeName },
): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Text>
        已切换到分支 <Text bold>{output.worktreeBranch}</Text> 上的 worktree
      </Text>
      <Text dimColor>{output.worktreePath}</Text>
    </Box>
  );
}
