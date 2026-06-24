/**
 * UserCrossSessionMessage — 渲染通过 UDS_INBOX（SendMessage 工具）
 * 从另一个 Claude 会话接收的消息。
 */
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import * as React from 'react';
import { Box, Text } from '@anthropic/ink';
import { extractTag } from '../../utils/messages.js';

type Props = {
  addMargin: boolean;
  param: TextBlockParam;
};

export function UserCrossSessionMessage({ param, addMargin }: Props): React.ReactNode {
  const text = param.text;
  const extracted = extractTag(text, 'cross-session-message');
  if (!extracted) {
    return null;
  }

  const fromMatch = text.match(/from="([^"]*)"/);
  const from = fromMatch?.[1] ?? '另一个会话';

  return (
    <Box flexDirection="row" marginTop={addMargin ? 1 : 0}>
      <Text dimColor>[{from}] </Text>
      <Text>{extracted}</Text>
    </Box>
  );
}
