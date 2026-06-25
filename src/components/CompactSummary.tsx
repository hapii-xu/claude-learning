import * as React from 'react';
import { BLACK_CIRCLE } from '../constants/figures.js';
import { Box, Text } from '@anthropic/ink';
import type { Screen } from '../screens/REPL.js';
import type { NormalizedUserMessage } from '../types/message.js';
import { getUserMessageText } from '../utils/messages.js';
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js';
import { MessageResponse } from './MessageResponse.js';

type Props = {
  message: NormalizedUserMessage;
  screen: Screen;
};

export function CompactSummary({ message, screen }: Props): React.ReactNode {
  const isTranscriptMode = screen === 'transcript';
  const textContent = getUserMessageText(message) || '';
  const metadata = message.summarizeMetadata as
    | {
        messagesSummarized?: number;
        direction?: string;
        userContext?: string;
      }
    | undefined;

  // \u5e26\u5143\u6570\u636e\u7684"\u4ece\u6b64\u5904\u603b\u7ed3"
  if (metadata) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="row">
          <Box minWidth={2}>
            <Text color="text">{BLACK_CIRCLE}</Text>
          </Box>
          <Box flexDirection="column">
            <Text bold>\u5df2\u603b\u7ed3\u7684\u5bf9\u8bdd</Text>
            {!isTranscriptMode && (
              <MessageResponse>
                <Box flexDirection="column">
                  <Text dimColor>
                    \u5df2\u603b\u7ed3 {metadata.messagesSummarized} \u6761\u6d88\u606f{' '}
                    {metadata.direction === 'up_to' ? '\u622a\u81f3\u6b64\u5904' : '\u4ece\u6b64\u5904\u5f00\u59cb'}
                  </Text>
                  {metadata.userContext && (
                    <Text dimColor>
                      \u4e0a\u4e0b\u6587\uff1a{'\u201c'}
                      {metadata.userContext}
                      {'\u201d'}
                    </Text>
                  )}
                  <Text dimColor>
                    <ConfigurableShortcutHint
                      action="app:toggleTranscript"
                      context="Global"
                      fallback="ctrl+o"
                      description="\u5c55\u5f00\u5386\u53f2"
                      parens
                    />
                  </Text>
                </Box>
              </MessageResponse>
            )}
            {isTranscriptMode && (
              <MessageResponse>
                <Text>{textContent}</Text>
              </MessageResponse>
            )}
          </Box>
        </Box>
      </Box>
    );
  }

  // 默认紧凑摘要（自动压缩）
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Box minWidth={2}>
          <Text color="text">{BLACK_CIRCLE}</Text>
        </Box>
        <Box flexDirection="column">
          <Text bold>
            对话已总结以释放上下文
            {!isTranscriptMode && (
              <Text dimColor>
                {' '}
                <ConfigurableShortcutHint
                  action="app:toggleTranscript"
                  context="Global"
                  fallback="ctrl+o"
                  description="查看摘要"
                  parens
                />
              </Text>
            )}
          </Text>
        </Box>
      </Box>
      {isTranscriptMode && (
        <MessageResponse>
          <Text>{textContent}</Text>
        </MessageResponse>
      )}
    </Box>
  );
}
