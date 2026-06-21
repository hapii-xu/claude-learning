import * as React from 'react';
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js';
import type { buildMessageLookups } from 'src/utils/messages.js';
import { Box, Text } from '@anthropic/ink';
import { MessageResponse } from '../MessageResponse.js';

type Props = {
  hookEvent: HookEvent;
  lookups: ReturnType<typeof buildMessageLookups>;
  toolUseID: string;
  verbose: boolean;
  isTranscriptMode?: boolean;
};

export function HookProgressMessage({ hookEvent, lookups, toolUseID, isTranscriptMode }: Props): React.ReactNode {
  const inProgressHookCount = lookups.inProgressHookCounts.get(toolUseID)?.get(hookEvent) ?? 0;
  const resolvedHookCount = lookups.resolvedHookCounts.get(toolUseID)?.get(hookEvent) ?? 0;
  if (inProgressHookCount === 0) {
    return null;
  }

  if (hookEvent === 'PreToolUse' || hookEvent === 'PostToolUse') {
    // 在 transcript 模式下，显示静态摘要，因为消息从不重新渲染
    // （所以瞬态的 "Running..." 会卡住）。
    if (isTranscriptMode) {
      return (
        <MessageResponse>
          <Box flexDirection="row">
            <Text dimColor>{inProgressHookCount} </Text>
            <Text dimColor bold>
              {hookEvent}
            </Text>
            <Text dimColor>{inProgressHookCount === 1 ? ' hook' : ' hooks'} ran</Text>
          </Box>
        </MessageResponse>
      );
    }
    // 在 transcript 模式之外，隐藏 —— completion 信息通过
    // async_hook_response attachments 显示。
    return null;
  }

  if (resolvedHookCount === inProgressHookCount) {
    return null;
  }

  return (
    <MessageResponse>
      <Box flexDirection="row">
        <Text dimColor>Running </Text>
        <Text dimColor bold>
          {hookEvent}
        </Text>
        <Text dimColor>{inProgressHookCount === 1 ? ' hook…' : ' hooks…'}</Text>
      </Box>
    </MessageResponse>
  );
}
