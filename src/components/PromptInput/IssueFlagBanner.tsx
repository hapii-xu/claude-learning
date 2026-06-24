import * as React from 'react';
import { FLAG_ICON } from '../../constants/figures.js';
import { Box, Text } from '@anthropic/ink';

/**
 * 仅限 ANT 内部：在对话记录中展示的横幅，提示用户通过 /issue 上报问题。
 * 当对话中检测到摩擦时出现。
 */
export function IssueFlagBanner(): React.ReactNode {
  if (process.env.USER_TYPE !== 'ant') {
    return null;
  }

  return (
    <Box flexDirection="row" marginTop={1} width="100%">
      <Box minWidth={2}>
        <Text color="warning">{FLAG_ICON}</Text>
      </Box>
      <Text>
        <Text dimColor>[ANT-ONLY] </Text>
        <Text color="warning" bold>
          Claude 有异常？
        </Text>
        <Text dimColor> 使用 /issue 上报问题</Text>
      </Text>
    </Box>
  );
}
