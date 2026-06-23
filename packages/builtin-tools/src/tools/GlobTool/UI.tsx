import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import React from 'react';
import { MessageResponse } from 'src/components/MessageResponse.js';
import { extractTag } from 'src/utils/messages.js';
import { FallbackToolUseErrorMessage } from 'src/components/FallbackToolUseErrorMessage.js';
import { TOOL_SUMMARY_MAX_LENGTH } from 'src/constants/toolLimits.js';
import { Text } from '@anthropic/ink';
import { FILE_NOT_FOUND_CWD_NOTE, getDisplayPath } from 'src/utils/file.js';
import { truncate } from 'src/utils/format.js';
import { GrepTool } from '../GrepTool/GrepTool.js';

export function userFacingName(): string {
  return '搜索';
}

export function renderToolUseMessage(
  { pattern, path }: Partial<{ pattern: string; path: string }>,
  { verbose }: { verbose: boolean },
): React.ReactNode {
  if (!pattern) {
    return null;
  }
  if (!path) {
    return `模式："${pattern}"`;
  }
  return `模式："${pattern}"，路径："${verbose ? path : getDisplayPath(path)}"`;
}

export function renderToolUseErrorMessage(
  result: ToolResultBlockParam['content'],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  if (!verbose && typeof result === 'string' && extractTag(result, 'tool_use_error')) {
    const errorMessage = extractTag(result, 'tool_use_error');
    if (errorMessage?.includes(FILE_NOT_FOUND_CWD_NOTE)) {
      return (
        <MessageResponse>
          <Text color="error">未找到文件</Text>
        </MessageResponse>
      );
    }
    return (
      <MessageResponse>
        <Text color="error">搜索文件时出错</Text>
      </MessageResponse>
    );
  }
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />;
}

// 注意：GlobTool 复用 GrepTool 的 renderToolResultMessage
export const renderToolResultMessage = GrepTool.renderToolResultMessage;

export function getToolUseSummary(input: Partial<{ pattern: string; path: string }> | undefined): string | null {
  if (!input?.pattern) {
    return null;
  }
  return truncate(input.pattern, TOOL_SUMMARY_MAX_LENGTH);
}
