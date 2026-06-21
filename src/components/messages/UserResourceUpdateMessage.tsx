import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import * as React from 'react';
import { REFRESH_ARROW } from '../../constants/figures.js';
import { Box, Text } from '@anthropic/ink';

type Props = {
  addMargin: boolean;
  param: TextBlockParam;
};

type ParsedUpdate = {
  kind: 'resource' | 'polling';
  server: string;
  /** resource 更新的 URI，polling 更新的 tool name */
  target: string;
  reason?: string;
};

// 从 XML 格式解析 resource 和 polling 更新
function parseUpdates(text: string): ParsedUpdate[] {
  const updates: ParsedUpdate[] = [];

  // 匹配 <mcp-resource-update server="..." uri="...">
  const resourceRegex =
    /<mcp-resource-update\s+server="([^"]+)"\s+uri="([^"]+)"[^>]*>(?:[\s\S]*?<reason>([^<]+)<\/reason>)?/g;
  let match;
  while ((match = resourceRegex.exec(text)) !== null) {
    updates.push({
      kind: 'resource',
      server: match[1] ?? '',
      target: match[2] ?? '',
      reason: match[3],
    });
  }

  // 匹配 <mcp-polling-update type="tool" server="..." tool="...">
  const pollingRegex =
    /<mcp-polling-update\s+type="([^"]+)"\s+server="([^"]+)"\s+tool="([^"]+)"[^>]*>(?:[\s\S]*?<reason>([^<]+)<\/reason>)?/g;
  while ((match = pollingRegex.exec(text)) !== null) {
    updates.push({
      kind: 'polling',
      server: match[2] ?? '',
      target: match[3] ?? '',
      reason: match[4],
    });
  }

  return updates;
}

// 格式化 URI 以供显示 - 仅显示有意义的部分
function formatUri(uri: string): string {
  // 对于 file:// URI，仅显示文件名
  if (uri.startsWith('file://')) {
    const path = uri.slice(7);
    const parts = path.split('/');
    return parts[parts.length - 1] || path;
  }
  // 对于其他 URI，显示完整内容但截断
  if (uri.length > 40) {
    return uri.slice(0, 39) + '\u2026';
  }
  return uri;
}

export function UserResourceUpdateMessage({ addMargin, param: { text } }: Props): React.ReactNode {
  const updates = parseUpdates(text);
  if (updates.length === 0) return null;

  return (
    <Box flexDirection="column" marginTop={addMargin ? 1 : 0}>
      {updates.map((update, i) => (
        <Box key={i}>
          <Text>
            <Text color="success">{REFRESH_ARROW}</Text> <Text dimColor>{update.server}:</Text>{' '}
            <Text color="suggestion">{update.kind === 'resource' ? formatUri(update.target) : update.target}</Text>
            {update.reason && <Text dimColor> · {update.reason}</Text>}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
