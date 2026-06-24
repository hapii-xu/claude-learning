import type { ThinkingBlock, ThinkingBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { CtrlOToExpand } from '../CtrlOToExpand.js';
import { Markdown } from '../Markdown.js';

type Props = {
  // 接受完整的 ThinkingBlock/ThinkingBlockParam 或仅包含 type 和 thinking 的最小结构
  param: ThinkingBlock | ThinkingBlockParam | { type: 'thinking'; thinking: string };
  addMargin: boolean;
  isTranscriptMode: boolean;
  verbose: boolean;
  /** 当为 true 时，完全隐藏此 thinking block（用于 transcript 模式中的过往 thinking） */
  hideInTranscript?: boolean;
};

export function AssistantThinkingMessage({
  param: { thinking },
  addMargin = false,
  isTranscriptMode,
  verbose,
  hideInTranscript = false,
}: Props): React.ReactNode {
  if (!thinking) {
    return null;
  }

  if (hideInTranscript) {
    return null;
  }

  const shouldShowFullThinking = isTranscriptMode || verbose;
  const label = '∴ 思考中';

  if (!shouldShowFullThinking) {
    return (
      <Box marginTop={addMargin ? 1 : 0}>
        <Text dimColor italic>
          {label} <CtrlOToExpand />
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1} marginTop={addMargin ? 1 : 0} width="100%">
      <Text dimColor italic>
        {label}…
      </Text>
      <Box paddingLeft={2}>
        <Markdown dimColor>{thinking}</Markdown>
      </Box>
    </Box>
  );
}
