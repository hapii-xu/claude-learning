import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import * as React from 'react';
import { CHANNEL_ARROW } from '../../constants/figures.js';
import { CHANNEL_TAG } from '../../constants/xml.js';
import { Box, Text } from '@anthropic/ink';
import { truncateToWidth } from '../../utils/format.js';

type Props = {
  addMargin: boolean;
  param: TextBlockParam;
};

// <channel source="..." user="..." chat_id="...">content</channel>
// source 总是第一个（wrapChannelMessage 写入它），user 是可选的。
const CHANNEL_RE = new RegExp(`<${CHANNEL_TAG}\\s+source="([^"]+)"([^>]*)>\\n?([\\s\\S]*?)\\n?</${CHANNEL_TAG}>`);
const USER_ATTR_RE = /\buser="([^"]+)"/;

// Plugin 提供的服务器通过 addPluginScopeToServers 获得类似
// plugin:slack-channel:slack 的名称 —— 只显示叶子部分。匹配
// isServerInChannels 中的 suffix-match 逻辑。
function displayServerName(name: string): string {
  const i = name.lastIndexOf(':');
  return i === -1 ? name : name.slice(i + 1);
}

const TRUNCATE_AT = 60;

export function UserChannelMessage({ addMargin, param: { text } }: Props): React.ReactNode {
  const m = CHANNEL_RE.exec(text);
  if (!m) return null;
  const [, source, attrs, content] = m;
  const user = USER_ATTR_RE.exec(attrs ?? '')?.[1];
  const body = (content ?? '').trim().replace(/\s+/g, ' ');
  const truncated = truncateToWidth(body, TRUNCATE_AT);
  return (
    <Box marginTop={addMargin ? 1 : 0}>
      <Text>
        <Text color="suggestion">{CHANNEL_ARROW}</Text>{' '}
        <Text dimColor>
          {displayServerName(source ?? '')}
          {user ? ` \u00b7 ${user}` : ''}:
        </Text>{' '}
        {truncated}
      </Text>
    </Box>
  );
}
