import React from 'react';
import stripAnsi from 'strip-ansi';
import { Box, Text } from '@anthropic/ink';
import { formatFileSize } from '../../utils/format.js';
import { MessageResponse } from '../MessageResponse.js';
import { OffscreenFreeze } from '../OffscreenFreeze.js';
import { ShellTimeDisplay } from './ShellTimeDisplay.js';

type Props = {
  output: string;
  fullOutput: string;
  elapsedTimeSeconds?: number;
  totalLines?: number;
  totalBytes?: number;
  timeoutMs?: number;
  taskId?: string;
  verbose: boolean;
};

export function ShellProgressMessage({
  output,
  fullOutput,
  elapsedTimeSeconds,
  totalLines,
  totalBytes,
  timeoutMs,
  verbose,
}: Props): React.ReactNode {
  const strippedFullOutput = stripAnsi(fullOutput.trim());
  const strippedOutput = stripAnsi(output.trim());
  const lines = strippedOutput.split('\n').filter(line => line);
  const displayLines = verbose ? strippedFullOutput : lines.slice(-5).join('\n');

  // OffscreenFreeze：BashTool 每秒产生一次进度（elapsedTimeSeconds）。
  // 如果此行滚动到 scrollback 中，每一次 tick 都会强制完整终端重置。
  // 一个前台 `sleep 600` 在 29 行终端、4000 行历史的场景下，
  // 10 分钟内产生了 507 次重置（go/ccshare/maxk-20260226-190348）。
  if (!lines.length) {
    return (
      <MessageResponse>
        <OffscreenFreeze>
          <Text dimColor>Running… </Text>
          <ShellTimeDisplay elapsedTimeSeconds={elapsedTimeSeconds} timeoutMs={timeoutMs} />
        </OffscreenFreeze>
      </MessageResponse>
    );
  }

  // 未截断："+2 lines"（总数超过显示的 5 行）
  // 截断："~2000 lines"（从尾部样本外推估计）
  const extraLines = totalLines ? Math.max(0, totalLines - 5) : 0;
  let lineStatus = '';
  if (!verbose && totalBytes && totalLines) {
    lineStatus = `~${totalLines} lines`;
  } else if (!verbose && extraLines > 0) {
    lineStatus = `+${extraLines} lines`;
  }

  return (
    <MessageResponse>
      <OffscreenFreeze>
        <Box flexDirection="column">
          <Box height={verbose ? undefined : Math.min(5, lines.length)} flexDirection="column" overflow="hidden">
            <Text dimColor>{displayLines}</Text>
          </Box>
          <Box flexDirection="row" gap={1}>
            {lineStatus ? <Text dimColor>{lineStatus}</Text> : null}
            <ShellTimeDisplay elapsedTimeSeconds={elapsedTimeSeconds} timeoutMs={timeoutMs} />
            {totalBytes ? <Text dimColor>{formatFileSize(totalBytes)}</Text> : null}
          </Box>
        </Box>
      </OffscreenFreeze>
    </MessageResponse>
  );
}
