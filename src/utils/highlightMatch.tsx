import * as React from 'react';
import { Text } from '@anthropic/ink';

/**
 * 对 `text` 中每次出现的 `query` 进行反色高亮（大小写不敏感）。
 * 被搜索对话框用于在结果行和预览面板中
 * 显示查询匹配的位置。
 */
export function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const queryLower = query.toLowerCase();
  const textLower = text.toLowerCase();
  const parts: React.ReactNode[] = [];
  let offset = 0;
  let idx = textLower.indexOf(queryLower, offset);
  if (idx === -1) return text;
  while (idx !== -1) {
    if (idx > offset) parts.push(text.slice(offset, idx));
    parts.push(
      <Text key={idx} inverse>
        {text.slice(idx, idx + query.length)}
      </Text>,
    );
    offset = idx + query.length;
    idx = textLower.indexOf(queryLower, offset);
  }
  if (offset < text.length) parts.push(text.slice(offset));
  return <>{parts}</>;
}
