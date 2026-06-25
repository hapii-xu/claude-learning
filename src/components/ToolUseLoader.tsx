import React from 'react';
import { BLACK_CIRCLE } from '../constants/figures.js';

import { Box, Text } from '@anthropic/ink';
import { useBlink } from '../hooks/useBlink.js';

type Props = {
  isError: boolean;
  isUnresolved: boolean;
  shouldAnimate: boolean;
};

export function ToolUseLoader({ isError, isUnresolved, shouldAnimate }: Props): React.ReactNode {
  const [ref, isBlinking] = useBlink(shouldAnimate);

  const color = isUnresolved ? undefined : isError ? 'error' : 'success';

  // 警告：此处以及 AssistantToolUseMessage 中的代码对那些本应只是
  // 平凡重构的改动非常敏感。一个 `<dim>x</dim>` 后面紧跟着
  // `<bold>y</bold>` 标签会错误地把 `y` 渲染为 dim！这是因为
  // `</dim>` 和 `</bold>` 都由 \x1b[22m 重置（出于历史原因），
  // chalk 无法区分它们。如果弄错了，你会看到工具名连同这个加载指示器
  // 一起闪烁，观感很差。
  // https://github.com/chalk/chalk/issues/290
  return (
    <Box ref={ref} minWidth={2}>
      <Text color={color} dimColor={isUnresolved}>
        {!shouldAnimate || isBlinking || isError || !isUnresolved ? BLACK_CIRCLE : ' '}
      </Text>
    </Box>
  );
}
