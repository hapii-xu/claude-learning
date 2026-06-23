import * as React from 'react';
import { Box, Text } from '@anthropic/ink';
import type { ToolProgressData } from 'src/Tool.js';
import type { ProgressMessage } from 'src/types/message.js';
import type { ThemeName } from 'src/utils/theme.js';
import type { Output } from './ExitWorktreeTool.js';

export function renderToolUseMessage(): React.ReactNode {
  return '退出 worktree…';
}

export function renderToolResultMessage(
  output: Output,
  _progressMessagesForMessage: ProgressMessage<ToolProgressData>[],
  _options: { theme: ThemeName },
): React.ReactNode {
  const actionLabel = output.action === 'keep' ? '已保留 worktree' : '已删除 worktree';
  return (
    <Box flexDirection="column">
      <Text>
        {actionLabel}
        {output.worktreeBranch ? (
          <>
            {' '}
            （分支 <Text bold>{output.worktreeBranch}</Text>）
          </>
        ) : null}
      </Text>
      <Text dimColor>已返回到 {output.originalCwd}</Text>
    </Box>
  );
}
