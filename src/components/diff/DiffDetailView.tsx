import type { StructuredPatchHunk } from 'diff';
import { resolve } from 'path';
import React, { useMemo } from 'react';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { Box, Text } from '@anthropic/ink';
import { getCwd } from '../../utils/cwd.js';
import { readFileSafe } from '../../utils/file.js';
import { Divider } from '@anthropic/ink';
import { StructuredDiff } from '../StructuredDiff.js';

type Props = {
  filePath: string;
  hunks: StructuredPatchHunk[];
  isLargeFile?: boolean;
  isBinary?: boolean;
  isTruncated?: boolean;
  isUntracked?: boolean;
};

/**
 * 显示单个文件的 diff 内容。
 * 使用 StructuredDiff 进行词级 diff 和语法高亮。
 * 不滚动 — 渲染所有行（因解析限制最多 400 行）。
 */
export function DiffDetailView({
  filePath,
  hunks,
  isLargeFile,
  isBinary,
  isTruncated,
  isUntracked,
}: Props): React.ReactNode {
  const { columns } = useTerminalSize();

  // 读取文件内容以进行语法检测和多行结构处理。
  // 仅在此组件渲染时（详情视图模式）计算。
  const { firstLine, fileContent } = useMemo(() => {
    if (!filePath) {
      return { firstLine: null, fileContent: undefined };
    }
    const fullPath = resolve(getCwd(), filePath);
    const content = readFileSafe(fullPath);
    return {
      firstLine: content?.split('\n')[0] ?? null,
      fileContent: content ?? undefined,
    };
  }, [filePath]);

  // 处理未跟踪文件
  if (isUntracked) {
    return (
      <Box flexDirection="column" width="100%">
        <Box>
          <Text bold>{filePath}</Text>
          <Text dimColor> (未跟踪)</Text>
        </Box>
        <Divider padding={4} />
        <Box flexDirection="column">
          <Text dimColor italic>
            新文件尚未暂存。
          </Text>
          <Text dimColor italic>
            运行 `git add {filePath}` 查看行数统计。
          </Text>
        </Box>
      </Box>
    );
  }

  // 处理二进制文件
  if (isBinary) {
    return (
      <Box flexDirection="column" width="100%">
        <Box>
          <Text bold>{filePath}</Text>
        </Box>
        <Divider padding={4} />
        <Box flexDirection="column">
          <Text dimColor italic>
            二进制文件 - 无法显示 diff
          </Text>
        </Box>
      </Box>
    );
  }

  // 处理大文件
  if (isLargeFile) {
    return (
      <Box flexDirection="column" width="100%">
        <Box>
          <Text bold>{filePath}</Text>
        </Box>
        <Divider padding={4} />
        <Box flexDirection="column">
          <Text dimColor italic>
            大文件 - diff 超过 1 MB 限制
          </Text>
        </Box>
      </Box>
    );
  }

  const outerPaddingX = 1;
  const outerBorderWidth = 1;

  return (
    <Box flexDirection="column" width="100%">
      <Box>
        <Text bold>{filePath}</Text>
        {isTruncated && <Text dimColor> (已截断)</Text>}
      </Box>

      <Divider padding={4} />
      <Box flexDirection="column">
        {hunks.length === 0 ? (
          <Text dimColor>无 diff 内容</Text>
        ) : (
          hunks.map((hunk, index) => (
            <StructuredDiff
              key={index}
              patch={hunk}
              filePath={filePath}
              firstLine={firstLine}
              fileContent={fileContent}
              dim={false}
              width={columns - 2 * outerPaddingX - 2 * outerBorderWidth}
            />
          ))
        )}
      </Box>

      {isTruncated && (
        <Text dimColor italic>
          … diff 已截断（超过 400 行限制）
        </Text>
      )}
    </Box>
  );
}
