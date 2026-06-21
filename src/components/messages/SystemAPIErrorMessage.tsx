import * as React from 'react';
import { useState } from 'react';
import { Box, Text } from '@anthropic/ink';
import { formatAPIError } from '@ant/model-provider';
import type { SystemAPIErrorMessage } from 'src/types/message.js';
import { useInterval } from 'usehooks-ts';
import { CtrlOToExpand } from '../CtrlOToExpand.js';
import { MessageResponse } from '../MessageResponse.js';

const MAX_API_ERROR_CHARS = 1000;

type Props = {
  message: SystemAPIErrorMessage;
  verbose: boolean;
};

export function SystemAPIErrorMessage({
  message: { retryAttempt, error, retryInMs, maxRetries },
  verbose,
}: Props): React.ReactNode {
  const _retryAttempt = retryAttempt as number;
  const _retryInMs = retryInMs as number;
  const _maxRetries = maxRetries as number;
  const _error = error as Parameters<typeof formatAPIError>[0];
  // 在外部构建的早期重试中隐藏以避免噪音。在 useInterval 之前计算，
  // 这样我们永远不会注册一个仅驱动 null 渲染的 timer。
  const hidden = process.env.USER_TYPE === 'external' && _retryAttempt < 4;

  const [countdownMs, setCountdownMs] = useState(0);
  const done = countdownMs >= _retryInMs;
  useInterval(() => setCountdownMs(ms => ms + 1000), hidden || done ? null : 1000);

  if (hidden) {
    return null;
  }

  const retryInSecondsLive = Math.max(0, Math.round((_retryInMs - countdownMs) / 1000));

  const formatted = formatAPIError(_error);
  const truncated = !verbose && formatted.length > MAX_API_ERROR_CHARS;

  return (
    <MessageResponse>
      <Box flexDirection="column">
        <Text color="error">{truncated ? formatted.slice(0, MAX_API_ERROR_CHARS) + '…' : formatted}</Text>
        {truncated && <CtrlOToExpand />}
        <Text dimColor>
          Retrying in {retryInSecondsLive} {retryInSecondsLive === 1 ? 'second' : 'seconds'}… (attempt {_retryAttempt}/
          {_maxRetries})
          {process.env.API_TIMEOUT_MS ? ` · API_TIMEOUT_MS=${process.env.API_TIMEOUT_MS}ms, try increasing it` : ''}
        </Text>
      </Box>
    </MessageResponse>
  );
}
