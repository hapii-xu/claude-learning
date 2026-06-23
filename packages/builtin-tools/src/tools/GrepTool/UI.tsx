import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import React from 'react';
import { CtrlOToExpand } from 'src/components/CtrlOToExpand.js';
import { FallbackToolUseErrorMessage } from 'src/components/FallbackToolUseErrorMessage.js';
import { MessageResponse } from 'src/components/MessageResponse.js';
import { TOOL_SUMMARY_MAX_LENGTH } from 'src/constants/toolLimits.js';
import { Box, Text } from '@anthropic/ink';
import type { ToolProgressData } from 'src/Tool.js';
import type { ProgressMessage } from 'src/types/message.js';
import { FILE_NOT_FOUND_CWD_NOTE, getDisplayPath } from 'src/utils/file.js';
import { truncate } from 'src/utils/format.js';
import { extractTag } from 'src/utils/messages.js';

// 可复用的搜索结果摘要组件
function SearchResultSummary({
  count,
  countLabel,
  secondaryCount,
  secondaryLabel,
  content,
  verbose,
}: {
  count: number;
  countLabel: string;
  secondaryCount?: number;
  secondaryLabel?: string;
  content?: string;
  verbose: boolean;
}): React.ReactNode {
  const primaryText = (
    <Text>
      找到 <Text bold>{count} </Text>
      {count === 0 || count > 1 ? countLabel : countLabel.slice(0, -1)}
    </Text>
  );

  const secondaryText =
    secondaryCount !== undefined && secondaryLabel ? (
      <Text>
        {' '}
        跨 <Text bold>{secondaryCount} </Text>
        {secondaryCount === 0 || secondaryCount > 1 ? secondaryLabel : secondaryLabel.slice(0, -1)}
      </Text>
    ) : null;

  if (verbose) {
    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text>
            <Text dimColor>&nbsp;&nbsp;⎿ &nbsp;</Text>
            {primaryText}
            {secondaryText}
          </Text>
        </Box>
        <Box marginLeft={5}>
          <Text>{content}</Text>
        </Box>
      </Box>
    );
  }

  return (
    <MessageResponse height={1}>
      <Text>
        {primaryText}
        {secondaryText} {count > 0 && <CtrlOToExpand />}
      </Text>
    </MessageResponse>
  );
}

type Output = {
  mode?: 'content' | 'files_with_matches' | 'count';
  numFiles: number;
  filenames: string[];
  content?: string;
  numLines?: number; // 用于 content 模式
  numMatches?: number; // 用于 count 模式
};

export function renderToolUseMessage(
  { pattern, path }: Partial<{ pattern: string; path?: string }>,
  { verbose }: { verbose: boolean },
): React.ReactNode {
  if (!pattern) {
    return null;
  }
  const parts = [`模式："${pattern}"`];

  if (path) {
    parts.push(`路径："${verbose ? path : getDisplayPath(path)}"`);
  }

  return parts.join(', ');
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

export function renderToolResultMessage(
  { mode = 'files_with_matches', filenames, numFiles, content, numLines, numMatches }: Output,
  _progressMessagesForMessage: ProgressMessage<ToolProgressData>[],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  if (mode === 'content') {
    return <SearchResultSummary count={numLines ?? 0} countLabel="行" content={content} verbose={verbose} />;
  }

  if (mode === 'count') {
    return (
      <SearchResultSummary
        count={numMatches ?? 0}
        countLabel="处匹配"
        secondaryCount={numFiles}
        secondaryLabel="个文件"
        content={content}
        verbose={verbose}
      />
    );
  }

  // files_with_matches 模式
  const fileListContent = filenames.map(filename => filename).join('\n');
  return <SearchResultSummary count={numFiles} countLabel="个文件" content={fileListContent} verbose={verbose} />;
}

export function getToolUseSummary(
  input:
    | Partial<{
        pattern: string;
        path?: string;
        glob?: string;
        type?: string;
        output_mode?: 'content' | 'files_with_matches' | 'count';
        head_limit?: number;
      }>
    | undefined,
): string | null {
  if (!input?.pattern) {
    return null;
  }
  return truncate(input.pattern, TOOL_SUMMARY_MAX_LENGTH);
}
