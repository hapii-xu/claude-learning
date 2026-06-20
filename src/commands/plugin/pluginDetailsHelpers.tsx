/**
 * 插件详情视图的共享辅助函数和类型
 *
 * 被 DiscoverPlugins 和 BrowseMarketplace 组件共同使用。
 */

import * as React from 'react';
import { ConfigurableShortcutHint } from '../../components/ConfigurableShortcutHint.js';
import { Box, Byline, Text } from '@anthropic/ink';
import type { PluginMarketplaceEntry } from '../../utils/plugins/schemas.js';

/**
 * 表示一个可从市场安装的插件
 */
export type InstallablePlugin = {
  entry: PluginMarketplaceEntry;
  marketplaceName: string;
  pluginId: string;
  isInstalled: boolean;
};

/**
 * 插件详情视图的菜单选项
 */
export type PluginDetailsMenuOption = {
  label: string;
  action: string;
};

/**
 * 从插件的源中提取 GitHub 仓库信息
 */
export function extractGitHubRepo(plugin: InstallablePlugin): string | null {
  const isGitHub =
    plugin.entry.source &&
    typeof plugin.entry.source === 'object' &&
    'source' in plugin.entry.source &&
    plugin.entry.source.source === 'github';

  if (isGitHub && typeof plugin.entry.source === 'object' && 'repo' in plugin.entry.source) {
    return plugin.entry.source.repo;
  }

  return null;
}

/**
 * 为插件详情视图构造菜单选项（含按作用域的安装选项）
 */
export function buildPluginDetailsMenuOptions(
  hasHomepage: string | undefined,
  githubRepo: string | null,
): PluginDetailsMenuOption[] {
  const options: PluginDetailsMenuOption[] = [
    { label: 'Install for you (user scope)', action: 'install-user' },
    {
      label: 'Install for all collaborators on this repository (project scope)',
      action: 'install-project',
    },
    {
      label: 'Install for you, in this repo only (local scope)',
      action: 'install-local',
    },
  ];
  if (hasHomepage) {
    options.push({ label: 'Open homepage', action: 'homepage' });
  }
  if (githubRepo) {
    options.push({ label: 'View on GitHub', action: 'github' });
  }
  options.push({ label: 'Back to plugin list', action: 'back' });
  return options;
}

/**
 * 插件选择界面的快捷键提示组件
 */
export function PluginSelectionKeyHint({ hasSelection }: { hasSelection: boolean }): React.ReactNode {
  return (
    <Box marginTop={1}>
      <Text dimColor italic>
        <Byline>
          {hasSelection && (
            <ConfigurableShortcutHint
              action="plugin:install"
              context="Plugin"
              fallback="i"
              description="install"
              bold
            />
          )}
          <ConfigurableShortcutHint action="plugin:toggle" context="Plugin" fallback="Space" description="toggle" />
          <ConfigurableShortcutHint action="select:accept" context="Select" fallback="Enter" description="details" />
          <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="back" />
        </Byline>
      </Text>
    </Box>
  );
}
