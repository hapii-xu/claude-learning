import type { StructuredPatchHunk } from 'diff';
import { relative } from 'path';
import * as React from 'react';
import { useTerminalSize } from 'src/hooks/useTerminalSize.js';
import { getCwd } from 'src/utils/cwd.js';
import { Box, Text } from '@anthropic/ink';
import { HighlightedCode } from './HighlightedCode.js';
import { MessageResponse } from './MessageResponse.js';
import { StructuredDiffList } from './StructuredDiffList.js';

const MAX_LINES_TO_RENDER = 10;

type Props = {
  file_path: string;
  operation: 'write' | 'update';
  // 对于更新 —— 显示 diff
  patch?: StructuredPatchHunk[];
  firstLine: string | null;
  fileContent?: string;
  // 对于新文件创建 —— 显示内容预览
  content?: string;
  style?: 'condensed';
  verbose: boolean;
};

export function FileEditToolUseRejectedMessage({
  file_path,
  operation,
  patch,
  firstLine,
  fileContent,
  content,
  style,
  verbose,
}: Props): React.ReactNode {
  const { columns } = useTerminalSize();
  const text = (
    <Box flexDirection="row">
      <Text color="subtle">用户拒绝了 {operation} 操作 </Text>
      <Text bold color="subtle">
        {verbose ? file_path : relative(getCwd(), file_path)}
      </Text>
    </Box>
  );

  // condensed 样式下仅显示文本
  if (style === 'condensed' && !verbose) {
    return <MessageResponse>{text}</MessageResponse>;
  }

  // 对于新文件创建，显示内容预览（调暗）
  if (operation === 'write' && content !== undefined) {
    const lines = content.split('\n');
    const numLines = lines.length;
    const plusLines = numLines - MAX_LINES_TO_RENDER;
    const truncatedContent = verbose ? content : lines.slice(0, MAX_LINES_TO_RENDER).join('\n');

    return (
      <MessageResponse>
        <Box flexDirection="column">
          {text}
          <HighlightedCode code={truncatedContent || '（无内容）'} filePath={file_path} width={columns - 12} dim />
          {!verbose && plusLines > 0 && <Text dimColor>… +{plusLines} 行</Text>}
        </Box>
      </MessageResponse>
    );
  }

  // 对于更新，显示 diff
  if (!patch || patch.length === 0) {
    return <MessageResponse>{text}</MessageResponse>;
  }

  return (
    <MessageResponse>
      <Box flexDirection="column">
        {text}
        <StructuredDiffList
          hunks={patch}
          dim
          width={columns - 12}
          filePath={file_path}
          firstLine={firstLine}
          fileContent={fileContent}
        />
      </Box>
    </MessageResponse>
  );
}
