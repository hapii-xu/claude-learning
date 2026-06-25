import figures from 'figures';
import React, { useMemo } from 'react';
import type { DiffFile } from '../../hooks/useDiffData.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { Box, Text } from '@anthropic/ink';
import { truncateStartToWidth } from '../../utils/format.js';
import { plural } from '../../utils/stringUtils.js';

const MAX_VISIBLE_FILES = 5;

type Props = {
  files: DiffFile[];
  selectedIndex: number;
};

export function DiffFileList({ files, selectedIndex }: Props): React.ReactNode {
  const { columns } = useTerminalSize();

  // 计算滚动窗口 — 必须在 early return 之前，以遵守 hooks 规则
  const { startIndex, endIndex } = useMemo(() => {
    if (files.length === 0 || files.length <= MAX_VISIBLE_FILES) {
      return { startIndex: 0, endIndex: files.length };
    }

    // 让选中项大致保持在中间
    let start = Math.max(0, selectedIndex - Math.floor(MAX_VISIBLE_FILES / 2));
    let end = start + MAX_VISIBLE_FILES;

    // 到达末尾时调整
    if (end > files.length) {
      end = files.length;
      start = Math.max(0, end - MAX_VISIBLE_FILES);
    }

    return { startIndex: start, endIndex: end };
  }, [files.length, selectedIndex]);

  if (files.length === 0) {
    return <Text dimColor>没有已更改的文件</Text>;
  }

  const visibleFiles = files.slice(startIndex, endIndex);
  const hasMoreAbove = startIndex > 0;
  const hasMoreBelow = endIndex < files.length;
  const needsPagination = files.length > MAX_VISIBLE_FILES;

  const statsWidth = 16;
  const pointerWidth = 3;
  const maxPathWidth = Math.max(20, columns - statsWidth - pointerWidth - 4);

  return (
    <Box flexDirection="column">
      {needsPagination && <Text dimColor>{hasMoreAbove ? ` ↑ 还有 ${startIndex} 个文件` : ' '}</Text>}
      {visibleFiles.map((file, index) => (
        <FileItem
          key={file.path}
          file={file}
          isSelected={startIndex + index === selectedIndex}
          maxPathWidth={maxPathWidth}
        />
      ))}
      {needsPagination && <Text dimColor>{hasMoreBelow ? ` ↓ 还有 ${files.length - endIndex} 个文件` : ' '}</Text>}
    </Box>
  );
}

function FileItem({
  file,
  isSelected,
  maxPathWidth,
}: {
  file: DiffFile;
  isSelected: boolean;
  maxPathWidth: number;
}): React.ReactNode {
  const displayPath = truncateStartToWidth(file.path, maxPathWidth);

  const pointer = isSelected ? figures.pointer + ' ' : '  ';
  const line = `${pointer}${displayPath}`;

  return (
    <Box flexDirection="row">
      <Text bold={isSelected} color={isSelected ? 'background' : undefined} inverse={isSelected}>
        {line}
      </Text>
      <Box flexGrow={1} />
      <FileStats file={file} isSelected={isSelected} />
    </Box>
  );
}

function FileStats({ file, isSelected }: { file: DiffFile; isSelected: boolean }): React.ReactNode {
  if (file.isUntracked) {
    return (
      <Text dimColor={!isSelected} italic>
        未跟踪
      </Text>
    );
  }
  if (file.isBinary) {
    return (
      <Text dimColor={!isSelected} italic>
        二进制文件
      </Text>
    );
  }
  if (file.isLargeFile) {
    return (
      <Text dimColor={!isSelected} italic>
        大文件已修改
      </Text>
    );
  }
  // 普通或截断的文件 - 显示行数统计
  return (
    <Text>
      {file.linesAdded > 0 && (
        <Text color="diffAddedWord" bold={isSelected}>
          +{file.linesAdded}
        </Text>
      )}
      {file.linesAdded > 0 && file.linesRemoved > 0 && ' '}
      {file.linesRemoved > 0 && (
        <Text color="diffRemovedWord" bold={isSelected}>
          -{file.linesRemoved}
        </Text>
      )}
      {file.isTruncated && <Text dimColor={!isSelected}> (已截断)</Text>}
    </Text>
  );
}
