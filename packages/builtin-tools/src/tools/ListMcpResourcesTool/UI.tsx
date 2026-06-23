import * as React from 'react';
import { MessageResponse } from 'src/components/MessageResponse.js';
import { OutputLine } from 'src/components/shell/OutputLine.js';
import { Text } from '@anthropic/ink';
import type { ToolProgressData } from 'src/Tool.js';
import type { ProgressMessage } from 'src/types/message.js';
import { jsonStringify } from 'src/utils/slowOperations.js';
import type { Output } from './ListMcpResourcesTool.js';

export function renderToolUseMessage(input: Partial<{ server?: string }>): React.ReactNode {
  return input.server ? `列出服务器 "${input.server}" 的 MCP 资源` : `列出所有 MCP 资源`;
}

export function renderToolResultMessage(
  output: Output,
  _progressMessagesForMessage: ProgressMessage<ToolProgressData>[],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  if (!output || output.length === 0) {
    return (
      <MessageResponse height={1}>
        <Text dimColor>（未找到资源）</Text>
      </MessageResponse>
    );
  }

  // eslint-disable-next-line no-restricted-syntax -- 面向人类的 UI，非 tool_result
  const formattedOutput = jsonStringify(output, null, 2);

  return <OutputLine content={formattedOutput} verbose={verbose} />;
}
