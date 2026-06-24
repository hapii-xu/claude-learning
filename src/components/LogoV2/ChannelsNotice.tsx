// 在 LogoV2.tsx 中通过 feature('KAIROS') || feature('KAIROS_CHANNELS')
// 条件 require()。此处没有 feature() 守卫 — 当两个 flag 都为 false 时，
// 整个文件通过 require 模式被 tree-shake（见 docs/feature-gating.md）。
// 不要从无守卫的代码中静态 import 此模块。

import * as React from 'react';
import { useState } from 'react';
import { type ChannelEntry, getAllowedChannels, getHasDevChannels } from '../../bootstrap/state.js';
import { getBuiltinPlugins } from '../../plugins/builtinPlugins.js';
import { Box, Text } from '@anthropic/ink';
import { getMcpConfigsByScope } from '../../services/mcp/config.js';
import { loadInstalledPluginsV2 } from '../../utils/plugins/installedPluginsManager.js';

export function ChannelsNotice(): React.ReactNode {
  // 在挂载时快照所有读取。此通知在 logo 之后立即进入 scrollback；
  // 之后任何重新渲染都会强制完全终端重置。
  const [{ channels, list, unmatched }] = useState(() => {
    const ch = getAllowedChannels();
    if (ch.length === 0)
      return {
        channels: ch,
        list: '',
        unmatched: [] as Unmatched[],
      };
    const l = ch.map(formatEntry).join(', ');
    return {
      channels: ch,
      list: l,
      unmatched: findUnmatched(ch),
    };
  });
  if (channels.length === 0) return null;

  // 当两个 flag 都传入时，列表会混合条目，单个 flag 名称对其中一半会是错的。
  // entry.dev 区分来源。
  const hasNonDev = channels.some(c => !c.dev);
  const flag =
    getHasDevChannels() && hasNonDev
      ? 'Channels'
      : getHasDevChannels()
        ? '--dangerously-load-development-channels'
        : '--channels';

  // "Listening for" 而非 "active" — 此刻我们只知道 allowlist 已设置。
  // 服务器连接、capability 声明，以及该名称是否匹配到已配置的 MCP 服务器，
  // 这些都仍然未知。
  return (
    <Box paddingLeft={2} flexDirection="column">
      <Text color="error">正在监听来自以下来源的频道消息：{list}</Text>
      <Text dimColor>
        实验性功能 · 入站消息将被推送到此会话，存在提示词注入风险。不带 {flag} 重启 Claude Code 可禁用。
      </Text>
      {unmatched.map(u => (
        <Text key={`${formatEntry(u.entry)}:${u.why}`} color="warning">
          {formatEntry(u.entry)} · {u.why}
        </Text>
      ))}
    </Box>
  );
}

function formatEntry(c: ChannelEntry): string {
  return c.kind === 'plugin' ? `plugin:${c.name}@${c.marketplace}` : `server:${c.name}`;
}

type Unmatched = { entry: ChannelEntry; why: string };

type FindUnmatchedDeps = {
  configuredServerNames?: ReadonlySet<string>;
  installedPluginIds?: ReadonlySet<string>;
};

export function findUnmatched(entries: readonly ChannelEntry[], deps?: FindUnmatchedDeps): Unmatched[] {
  // Server 类型：预先从所有 scope 构建一个 Set。getMcpConfigsByScope
  // 没有缓存（project scope 会遍历目录树）；getMcpConfigByName 会对
  // 每个条目重复该遍历。
  const configured =
    deps?.configuredServerNames ??
    (() => {
      const scopes = ['enterprise', 'user', 'project', 'local'] as const;
      const names = new Set<string>();
      for (const scope of scopes) {
        for (const name of Object.keys(getMcpConfigsByScope(scope).servers)) {
          names.add(name);
        }
      }
      return names;
    })();

  // Plugin 类型的已安装检查：installed_plugins.json 的键是
  // `name@marketplace`。loadInstalledPluginsV2 已缓存。
  const installedPluginIds =
    deps?.installedPluginIds ??
    (() => {
      const ids = new Set(Object.keys(loadInstalledPluginsV2().plugins));
      const builtinPlugins = getBuiltinPlugins();
      for (const plugin of [...builtinPlugins.enabled, ...builtinPlugins.disabled]) {
        ids.add(plugin.source);
      }
      return ids;
    })();

  const out: Unmatched[] = [];
  for (const entry of entries) {
    if (entry.kind === 'server') {
      if (!configured.has(entry.name)) {
        out.push({ entry, why: '未找到同名 MCP 服务器配置' });
      }
      continue;
    }
    if (!installedPluginIds.has(`${entry.name}@${entry.marketplace}`)) {
      out.push({ entry, why: '插件未安装' });
    }
  }
  return out;
}
