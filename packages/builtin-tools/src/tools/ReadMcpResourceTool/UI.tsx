import * as React from 'react';
import type { z } from 'zod/v4';
import { MessageResponse } from 'src/components/MessageResponse.js';
import { OutputLine } from 'src/components/shell/OutputLine.js';
import { Box, Text } from '@anthropic/ink';
import type { ToolProgressData } from 'src/Tool.js';
import type { ProgressMessage } from 'src/types/message.js';
import { jsonStringify } from 'src/utils/slowOperations.js';
import type { inputSchema, Output } from './ReadMcpResourceTool.js';

export function renderToolUseMessage(input: Partial<z.infer<ReturnType<typeof inputSchema>>>): React.ReactNode {
  if (!input.uri || !input.server) {
    return null;
  }
  return `从服务器 "${input.server}" 读取资源 "${input.uri}"`;
}

export function userFacingName(): string {
  return 'readMcpResource';
}

export function renderToolResultMessage(
  output: Output,
  _progressMessagesForMessage: ProgressMessage<ToolProgressData>[],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  if (!output || !output.contents || output.contents.length === 0) {
    return (
      <Box justifyContent="space-between" overflowX="hidden" width="100%">
        <MessageResponse height={1}>
          <Text dimColor>(无内容)</Text>
        </MessageResponse>
      </Box>
    );
  }

  // 格式化为 JSON 以提升可读性
  // eslint-disable-next-line no-restricted-syntax -- 面向用户的 UI，而非 tool_result
  const formattedOutput = jsonStringify(output, null, 2);

  return <OutputLine content={formattedOutput} verbose={verbose} />;
}
