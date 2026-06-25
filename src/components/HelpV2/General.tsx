import * as React from 'react';
import { Box, Text } from '@anthropic/ink';
import { PromptInputHelpMenu } from '../PromptInput/PromptInputHelpMenu.js';

export function General(): React.ReactNode {
  return (
    <Box flexDirection="column" paddingY={1} gap={1}>
      <Box flexDirection="column" gap={1}>
        <Text bold>入门指引</Text>
        <Box flexDirection="column">
          <Text>
            <Text bold>1. </Text>
            <Text>提出问题或描述任务 — Claude 会探索你的代码并给出回应。</Text>
          </Text>
          <Text>
            <Text bold>2. </Text>
            <Text>当 Claude 要编辑文件或运行命令时，你需要逐一审核并批准每个操作。</Text>
          </Text>
          <Text>
            <Text bold>3. </Text>
            <Text>输入 </Text>
            <Text bold>/commit</Text>
            <Text> 提交变更，输入 </Text>
            <Text bold>/help</Text>
            <Text> 查看命令，或按 </Text>
            <Text bold>?</Text>
            <Text> 查看快捷键。</Text>
          </Text>
        </Box>
      </Box>
      <Box flexDirection="column">
        <Box>
          <Text bold>快捷键</Text>
        </Box>
        <PromptInputHelpMenu gap={2} fixedWidth={true} />
      </Box>
    </Box>
  );
}
