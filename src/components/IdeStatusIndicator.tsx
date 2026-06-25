import { basename } from 'path';
import * as React from 'react';
import { useIdeConnectionStatus } from '../hooks/useIdeConnectionStatus.js';
import type { IDESelection } from '../hooks/useIdeSelection.js';
import { Text } from '@anthropic/ink';
import type { MCPServerConnection } from '../services/mcp/types.js';

type IdeStatusIndicatorProps = {
  ideSelection: IDESelection | undefined;
  mcpClients?: MCPServerConnection[];
};

export function IdeStatusIndicator({ ideSelection, mcpClients }: IdeStatusIndicatorProps): React.ReactNode {
  const { status: ideStatus } = useIdeConnectionStatus(mcpClients);

  // 检查是否应显示 IDE 选中内容指示器
  const shouldShowIdeSelection =
    ideStatus === 'connected' && (ideSelection?.filePath || (ideSelection?.text && ideSelection.lineCount > 0));

  if (ideStatus === null || !shouldShowIdeSelection || !ideSelection) {
    return null;
  }

  if (ideSelection.text && ideSelection.lineCount > 0) {
    return (
      <Text color="ide" key="selection-indicator" wrap="truncate">
        ⧉ 已选中 {ideSelection.lineCount} 行
      </Text>
    );
  }

  if (ideSelection.filePath) {
    return (
      <Text color="ide" key="selection-indicator" wrap="truncate">
        ⧉ 位于 {basename(ideSelection.filePath)}
      </Text>
    );
  }
}
