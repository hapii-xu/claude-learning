import * as React from 'react';
import { Text } from '@anthropic/ink';

export function InterruptedByUser(): React.ReactNode {
  return (
    <>
      <Text dimColor>已中断 </Text>
      {process.env.USER_TYPE === 'ant' ? (
        <Text dimColor>· [ANT-ONLY] /issue 报告模型问题</Text>
      ) : (
        <Text dimColor>· 您希望 Claude 改做什么？</Text>
      )}
    </>
  );
}
