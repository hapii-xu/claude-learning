import { homedir } from 'os';
import { relative } from 'path';
import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { getCwd } from '../../utils/cwd.js';

export function getRelativeMemoryPath(path: string): string {
  const homeDir = homedir();
  const cwd = getCwd();

  // 计算相对路径
  const relativeToHome = path.startsWith(homeDir) ? '~' + path.slice(homeDir.length) : null;

  const relativeToCwd = path.startsWith(cwd) ? './' + relative(cwd, path) : null;

  // 返回较短的路径，若都不适用则返回绝对路径
  if (relativeToHome && relativeToCwd) {
    return relativeToHome.length <= relativeToCwd.length ? relativeToHome : relativeToCwd;
  }

  return relativeToHome || relativeToCwd || path;
}

export function MemoryUpdateNotification({ memoryPath }: { memoryPath: string }): React.ReactNode {
  const displayPath = getRelativeMemoryPath(memoryPath);

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text color="text">Memory updated in {displayPath} · /memory to edit</Text>
    </Box>
  );
}
