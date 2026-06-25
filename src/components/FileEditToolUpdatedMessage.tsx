import type { StructuredPatchHunk } from 'diff';
import * as React from 'react';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { Box, Text } from '@anthropic/ink';
import { count } from '../utils/array.js';
import { MessageResponse } from './MessageResponse.js';
import { StructuredDiffList } from './StructuredDiffList.js';

type Props = {
  filePath: string;
  structuredPatch: StructuredPatchHunk[];
  firstLine: string | null;
  fileContent?: string;
  style?: 'condensed';
  verbose: boolean;
  previewHint?: string;
};

export function FileEditToolUpdatedMessage({
  filePath,
  structuredPatch,
  firstLine,
  fileContent,
  style,
  verbose,
  previewHint,
}: Props): React.ReactNode {
  const { columns } = useTerminalSize();
  const numAdditions = structuredPatch.reduce((acc, hunk) => acc + count(hunk.lines, _ => _.startsWith('+')), 0);
  const numRemovals = structuredPatch.reduce((acc, hunk) => acc + count(hunk.lines, _ => _.startsWith('-')), 0);

  const text = (
    <Text>
      {numAdditions > 0 ? (
        <>
          新增 <Text bold>{numAdditions}</Text> 行
        </>
      ) : null}
      {numAdditions > 0 && numRemovals > 0 ? '，' : null}
      {numRemovals > 0 ? (
        <>
          删除 <Text bold>{numRemovals}</Text> 行
        </>
      ) : null}
    </Text>
  );

  // Plan 文件：反转 condensed 行为
  // - 普通模式：仅显示提示（用户可输入 /plan 查看完整内容）
  // - Condensed 模式（subagent 视图）：显示 diff
  if (previewHint) {
    if (style !== 'condensed' && !verbose) {
      return (
        <MessageResponse>
          <Text dimColor>{previewHint}</Text>
        </MessageResponse>
      );
    }
  } else if (style === 'condensed' && !verbose) {
    return text;
  }

  return (
    <MessageResponse>
      <Box flexDirection="column">
        <Text>{text}</Text>
        <StructuredDiffList
          hunks={structuredPatch}
          dim={false}
          width={columns - 12}
          filePath={filePath}
          firstLine={firstLine}
          fileContent={fileContent}
        />
      </Box>
    </MessageResponse>
  );
}
