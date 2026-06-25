import React from 'react';
import { Link, Text } from '@anthropic/ink';

export function MCPServerDialogCopy(): React.ReactNode {
  return (
    <Text>
      MCP 服务器可能会执行代码或访问系统资源。所有工具调用都需要审批。可在{' '}
      <Link url="https://code.claude.com/docs/en/mcp">MCP 文档</Link> 中了解更多信息。
    </Text>
  );
}
