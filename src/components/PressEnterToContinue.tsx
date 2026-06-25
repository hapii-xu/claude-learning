import * as React from 'react';
import { Text } from '@anthropic/ink';

export function PressEnterToContinue(): React.ReactNode {
  return (
    <Text color="permission">
      按 <Text bold>Enter</Text> 继续…
    </Text>
  );
}
