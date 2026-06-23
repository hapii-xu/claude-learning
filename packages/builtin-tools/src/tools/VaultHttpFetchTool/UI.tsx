import * as React from 'react';
import { Text } from '@anthropic/ink';
import { MessageResponse } from 'src/components/MessageResponse.js';
import { OutputLine } from 'src/components/shell/OutputLine.js';
import type { ToolProgressData } from 'src/Tool.js';
import type { ProgressMessage } from 'src/types/message.js';
import { jsonStringify } from 'src/utils/slowOperations.js';
import type { Output } from './VaultHttpFetchTool.js';

// H6 修复：第二个 `options` 参数与 Tool 接口契约一致。
export function renderToolUseMessage(
  input: Partial<{
    method?: string;
    url?: string;
    vault_auth_key?: string;
  }>,
  _options: {
    theme?: unknown;
    verbose?: boolean;
    commands?: unknown;
  } = {},
): React.ReactNode {
  void _options;
  const method = input.method ?? 'GET';
  const key = input.vault_auth_key ?? '?';
  const url = input.url ?? '';
  // 显示 key 名称（本身已被要求为非密钥）；不涉及密钥值。
  return `${method} ${url} (vault: ${key})`;
}

export function renderToolResultMessage(
  output: Output,
  _progressMessagesForMessage: ProgressMessage<ToolProgressData>[],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  if (output.error) {
    return (
      <MessageResponse height={1}>
        <Text color="error">VaultHttpFetch: {output.error}</Text>
      </MessageResponse>
    );
  }
  // body 在到达此处之前已 scrub 掉所有密钥形式；可安全展示。
  // eslint-disable-next-line no-restricted-syntax -- 面向人类的 UI，不是 tool_result
  const formatted = jsonStringify(output, null, 2);
  return <OutputLine content={formatted} verbose={verbose} />;
}
